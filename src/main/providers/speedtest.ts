import { HIDE, type Entry, type EntryAction, type ViewProvider } from "../entry";
import {
  formatMbps,
  formatMs,
  jitter,
  median,
  nextChunkBytes,
  recentMbps,
  resultsLine,
  serverTimeMs,
  steadyMbps,
  type Sample,
} from "../speedtest";
import { copyText } from "../system";
import type { RunResult } from "../../shared/types";

const BASE = "https://speed.cloudflare.com";
const PINGS = 10;
const PHASE_MS = 7000;
const STREAMS = 4;
const SAMPLE_MS = 100;
const MB = 1_000_000;
/**
 * Data caps per run so a fast link does not burn gigabytes. A 200 Mbps link
 * fills the whole 7 s; faster links end early, after the ramp-up is over.
 */
const DOWNLOAD_CAP = 200 * MB;
const UPLOAD_CAP = 75 * MB;
const DOWNLOAD_CHUNK = { first: 1 * MB, min: 256_000, max: 25 * MB, targetMs: 1000 };
// Uploads are only counted when a request completes, so they stay shorter.
const UPLOAD_CHUNK = { first: 256_000, min: 64_000, max: 16 * MB, targetMs: 500 };

type Phase = "idle" | "ping" | "download" | "upload" | "done" | "error" | "stopped";

interface TestState {
  phase: Phase;
  pings: number[];
  pingMs?: number;
  jitterMs?: number;
  downMbps?: number;
  upMbps?: number;
  /** Cloudflare data center, e.g. "Chennai (MAA)". */
  server?: string;
  /** The user's network, e.g. "ACT-Vjw · Bengaluru". */
  network?: string;
  error?: string;
  finishedAt?: number;
}

let state: TestState = { phase: "idle", pings: [] };
let controller: AbortController | null = null;

function isRunning(): boolean {
  return state.phase === "ping" || state.phase === "download" || state.phase === "upload";
}

function startTest(): void {
  controller?.abort();
  const run = new AbortController();
  const test: TestState = { phase: "ping", pings: [] };
  controller = run;
  state = test;
  runTest(test, run.signal)
    .catch((error: unknown) => {
      if (run.signal.aborted) return;
      test.phase = "error";
      test.error = describeError(error);
    })
    .finally(() => {
      test.finishedAt = Date.now();
      if (controller === run) controller = null;
    });
}

function stopTest(): void {
  if (!isRunning()) return;
  state.phase = "stopped";
  controller?.abort();
  controller = null;
}

async function runTest(test: TestState, signal: AbortSignal): Promise<void> {
  void loadServer(test, signal);
  await measurePing(test, signal);
  test.phase = "download";
  test.downMbps = await measureDownload(test, signal);
  test.phase = "upload";
  test.upMbps = await measureUpload(test, signal);
  test.phase = "done";
}

function within(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** Data center and network from /meta, which only answers the speed test page's requests. */
async function loadServer(test: TestState, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch(`${BASE}/meta`, { headers: { Referer: `${BASE}/` }, signal: within(signal, 8000) });
    const meta = (await response.json()) as {
      asOrganization?: string;
      city?: string;
      colo?: { iata?: string; city?: string };
    };
    if (meta.colo?.iata) test.server = meta.colo.city ? `${meta.colo.city} (${meta.colo.iata})` : meta.colo.iata;
    const network = [meta.asOrganization, meta.city].filter(Boolean).join(" · ");
    if (network) test.network = network;
  } catch {
    // The data center code from the ping replies is shown instead.
  }
}

/** Round trips of empty downloads, minus the time Cloudflare spent on them. */
async function measurePing(test: TestState, signal: AbortSignal): Promise<void> {
  // The first request opens the connection (TCP and TLS) and is not counted.
  for (let i = 0; i <= PINGS; i++) {
    const started = performance.now();
    const response = await fetch(`${BASE}/__down?bytes=0`, { signal: within(signal, 5000) });
    const elapsed = performance.now() - started;
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`speed.cloudflare.com answered ${response.status}`);
    if (i === 0) {
      const colo = response.headers.get("colo");
      if (colo && !test.server) test.server = colo;
      continue;
    }
    test.pings.push(Math.max(0, elapsed - serverTimeMs(response.headers.get("server-timing"))));
    test.pingMs = median(test.pings);
    test.jitterMs = jitter(test.pings);
  }
}

/**
 * Runs `STREAMS` parallel request loops for `PHASE_MS` or until the data cap,
 * sampling the byte count every 100 ms. Returns the steady rate.
 */
async function measureThroughput(
  signal: AbortSignal,
  onRate: (mbps: number) => void,
  stream: (phase: AbortSignal, elapsed: () => number, reserve: (bytes: number) => number, count: (bytes: number) => void) => Promise<void>,
  cap: number,
  abortAtDeadline: boolean,
): Promise<number> {
  const phase = new AbortController();
  const stopPhase = () => phase.abort();
  signal.addEventListener("abort", stopPhase, { once: true });
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const samples: Sample[] = [];
  let moved = 0;
  let reserved = 0;
  /** Where the result ends: the last completed request, or the deadline. */
  let end: Sample = { t: 0, bytes: 0 };
  let deadlineHit = false;
  let failure: unknown = null;

  const sampler = setInterval(() => {
    const sample = { t: elapsed(), bytes: moved };
    samples.push(sample);
    onRate(recentMbps(samples, 2000));
    if (abortAtDeadline && sample.t >= PHASE_MS) {
      deadlineHit = true;
      end = sample;
      phase.abort();
    }
  }, SAMPLE_MS);
  // Uploads finish their requests after the deadline, but not forever.
  const hardStop = setTimeout(stopPhase, PHASE_MS + 5000);

  const reserve = (bytes: number) => {
    const granted = Math.max(0, Math.min(bytes, cap - reserved));
    reserved += granted;
    return granted;
  };
  const count = (bytes: number) => {
    if (deadlineHit) return;
    moved += bytes;
    end = { t: elapsed(), bytes: moved };
  };
  const guarded = async () => {
    try {
      await stream(phase.signal, elapsed, reserve, count);
    } catch (error) {
      if (!phase.signal.aborted) {
        failure ??= error;
        phase.abort();
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: STREAMS }, guarded));
  } finally {
    clearInterval(sampler);
    clearTimeout(hardStop);
    signal.removeEventListener("abort", stopPhase);
  }
  if (signal.aborted) throw new Error("stopped");
  if (failure) throw failure;
  // End the samples where the last bytes arrived, not where the loops noticed.
  return steadyMbps([...samples.filter((s) => s.t < end.t), end]);
}

function measureDownload(test: TestState, signal: AbortSignal): Promise<number> {
  return measureThroughput(
    signal,
    (rate) => (test.downMbps = rate),
    async (phase, _elapsed, reserve, count) => {
      let size = DOWNLOAD_CHUNK.first;
      while (!phase.aborted) {
        const bytes = reserve(size);
        if (!bytes) return;
        const started = performance.now();
        const response = await fetch(`${BASE}/__down?bytes=${bytes}`, { signal: phase });
        if (!response.ok || !response.body) throw new Error(`speed.cloudflare.com answered ${response.status}`);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count(value.byteLength);
        }
        size = nextChunkBytes(bytes, performance.now() - started, DOWNLOAD_CHUNK.targetMs, DOWNLOAD_CHUNK.min, DOWNLOAD_CHUNK.max);
      }
    },
    DOWNLOAD_CAP,
    true,
  );
}

function measureUpload(test: TestState, signal: AbortSignal): Promise<number> {
  // Zeros are fine: nothing on the way compresses request bodies.
  const payload = new Uint8Array(UPLOAD_CHUNK.max);
  return measureThroughput(
    signal,
    (rate) => (test.upMbps = rate),
    async (phase, elapsed, reserve, count) => {
      let size = UPLOAD_CHUNK.first;
      while (!phase.aborted && elapsed() < PHASE_MS) {
        const bytes = reserve(size);
        if (bytes < UPLOAD_CHUNK.min) return;
        const started = performance.now();
        const response = await fetch(`${BASE}/__up`, { method: "POST", body: payload.subarray(0, bytes), signal: phase });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`speed.cloudflare.com answered ${response.status}`);
        count(bytes);
        size = nextChunkBytes(bytes, performance.now() - started, UPLOAD_CHUNK.targetMs, UPLOAD_CHUNK.min, UPLOAD_CHUNK.max);
      }
    },
    UPLOAD_CAP,
    false,
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Cloudflare did not answer in time";
    const code = (error.cause as { code?: string } | undefined)?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "No internet connection";
    if (code) return `Could not reach speed.cloudflare.com (${code})`;
    return error.message;
  }
  return String(error);
}

function copyResults(): RunResult {
  const line = resultsLine(state);
  if (!line) return { type: "error", message: "No results yet" };
  copyText(line);
  return HIDE;
}

function rowActions(): EntryAction[] {
  const running = isRunning();
  const actions: EntryAction[] = [
    {
      id: "run-again",
      title: running ? "Restart Test" : "Run Again",
      shortcut: "↵",
      run: () => {
        startTest();
        return { type: "stay", toast: "Speed test started" };
      },
    },
    { id: "copy", title: "Copy Results", shortcut: "Ctrl+↵", run: copyResults },
  ];
  if (running) {
    actions.push({
      id: "stop",
      title: "Stop Test",
      shortcut: "Ctrl+.",
      danger: true,
      run: () => {
        stopTest();
        return { type: "stay", toast: "Speed test stopped" };
      },
    });
  }
  return actions;
}

function statusRow(): { title: string; icon: string } {
  switch (state.phase) {
    case "ping":
      return { title: "Measuring ping…", icon: "⏳" };
    case "download":
      return { title: "Testing download…", icon: "⏳" };
    case "upload":
      return { title: "Testing upload…", icon: "⏳" };
    case "done":
      return { title: "Done", icon: "✅" };
    case "stopped":
      return { title: "Stopped", icon: "⏹️" };
    case "error":
      return { title: state.error ?? "The test failed", icon: "⚠️" };
    default:
      return { title: "Not run yet", icon: "⏳" };
  }
}

function value(text: string | undefined, active: boolean): string {
  return text ?? (active ? "Measuring…" : "–");
}

export function speedtestCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:speedtest",
      ref: "cmd:speedtest",
      title: "Speed Test",
      subtitle: "Network",
      icon: "🚀",
      accessory: isRunning() ? "Running…" : "Command",
      keywords: ["internet speed", "speedtest", "bandwidth", "download", "upload", "ping", "network", "wifi"],
      actions: [
        {
          id: "run",
          title: "Run Command",
          shortcut: "↵",
          run: () => {
            if (!isRunning()) startTest();
            return { type: "view", view: "speedtest" };
          },
        },
      ],
    },
  ];
}

export const speedtestView: ViewProvider = {
  info: {
    title: "Speed Test",
    placeholder: "Internet speed, measured with Cloudflare",
    preview: false,
    grid: false,
    refreshMs: 500,
  },
  sections() {
    // Opened directly (e.g. from a view: hotkey) with nothing to show yet.
    if (state.phase === "idle") startTest();
    const actions = rowActions();
    const status = statusRow();
    const finished = state.finishedAt && !isRunning()
      ? new Date(state.finishedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : undefined;
    const phase = state.phase;
    const pingDetail = state.jitterMs !== undefined ? `Jitter ${formatMs(state.jitterMs)}` : undefined;
    const rows: Entry[] = [
      {
        id: "speedtest:status",
        title: status.title,
        subtitle: finished ? `Finished at ${finished}` : undefined,
        icon: status.icon,
        accessory: "Status",
        actions,
      },
      {
        id: "speedtest:ping",
        title: "Ping",
        subtitle: pingDetail,
        icon: "⏱️",
        accessory: value(state.pingMs !== undefined ? formatMs(state.pingMs) : undefined, phase === "ping"),
        actions,
      },
      {
        id: "speedtest:download",
        title: "Download",
        subtitle: phase === "download" ? "Testing…" : undefined,
        icon: "⬇️",
        accessory: value(state.downMbps !== undefined ? formatMbps(state.downMbps) : undefined, phase === "download"),
        actions,
      },
      {
        id: "speedtest:upload",
        title: "Upload",
        subtitle: phase === "upload" ? "Testing…" : undefined,
        icon: "⬆️",
        accessory: value(state.upMbps !== undefined ? formatMbps(state.upMbps) : undefined, phase === "upload"),
        actions,
      },
      {
        id: "speedtest:server",
        title: "Server",
        subtitle: state.network,
        icon: "🌐",
        accessory: state.server ? `Cloudflare ${state.server}` : "–",
        actions,
      },
    ];
    return [{ title: "Speed Test", entries: rows }];
  },
};
