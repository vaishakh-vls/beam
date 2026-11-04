// The math behind the speed test: ping statistics, throughput and chunk sizing.

/** Cumulative bytes moved by `t` ms after a phase started. */
export interface Sample {
  t: number;
  bytes: number;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mean difference between consecutive pings, as most speed tests report it. */
export function jitter(values: number[]): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < values.length; i++) total += Math.abs(values[i] - values[i - 1]);
  return total / (values.length - 1);
}

export function mbps(bytes: number, ms: number): number {
  return ms > 0 ? (bytes * 8) / ms / 1000 : 0;
}

/**
 * Server processing time from a Server-Timing header, e.g.
 * "cfSpeedEdge;dur=3, cfSpeedWorker;dur=17, cfL4;desc=…" gives 20. A ping is
 * the request's round trip minus this.
 */
export function serverTimeMs(header: string | null): number {
  if (!header) return 0;
  let total = 0;
  for (const match of header.matchAll(/(?:^|[;,\s])dur=([\d.]+)/g)) total += Number(match[1]) || 0;
  return total;
}

/** Rate over the last `windowMs`, for the live reading while a phase runs. */
export function recentMbps(samples: Sample[], windowMs: number): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const sample of samples) {
    if (sample.t > last.t - windowMs) break;
    first = sample;
  }
  return mbps(last.bytes - first.bytes, last.t - first.t);
}

/**
 * The phase's result: the rate after the connection has ramped up. The
 * first second (or 30% of a short phase) is TCP slow start and is skipped.
 */
export function steadyMbps(samples: Sample[], warmupMs = 1000): number {
  if (!samples.length) return 0;
  const last = samples[samples.length - 1];
  const warmup = Math.min(warmupMs, last.t * 0.3);
  let base: Sample = { t: 0, bytes: 0 };
  for (const sample of samples) {
    if (sample.t > warmup) break;
    base = sample;
  }
  if (last.t - base.t < 200 || last.bytes <= base.bytes) return mbps(last.bytes, last.t);
  return mbps(last.bytes - base.bytes, last.t - base.t);
}

/**
 * Size for a stream's next request, aiming at `targetMs` per request at the
 * rate the last one achieved: small on slow links, large on fast ones so
 * per-request overhead does not drag the result down.
 */
export function nextChunkBytes(lastBytes: number, lastMs: number, targetMs: number, min: number, max: number): number {
  const scaled = lastMs > 0 ? (lastBytes * targetMs) / lastMs : max;
  // Grow at most fourfold per step; one fast reply is not proof of a fast link.
  const bounded = Math.min(scaled, lastBytes * 4);
  return Math.round(Math.min(max, Math.max(min, bounded)));
}

export function formatMbps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 Mbps";
  if (value >= 100) return `${Math.round(value)} Mbps`;
  if (value >= 10) return `${value.toFixed(1)} Mbps`;
  return `${value.toFixed(2)} Mbps`;
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}

export interface SpeedResults {
  downMbps?: number;
  upMbps?: number;
  pingMs?: number;
  jitterMs?: number;
}

/** One line for the clipboard: "Download 245 Mbps · Upload 80 Mbps · Ping 12 ms · Jitter 2.1 ms". */
export function resultsLine(results: SpeedResults): string {
  const parts: string[] = [];
  if (results.downMbps !== undefined) parts.push(`Download ${formatMbps(results.downMbps)}`);
  if (results.upMbps !== undefined) parts.push(`Upload ${formatMbps(results.upMbps)}`);
  if (results.pingMs !== undefined) parts.push(`Ping ${formatMs(results.pingMs)}`);
  if (results.jitterMs !== undefined) parts.push(`Jitter ${formatMs(results.jitterMs)}`);
  return parts.join(" · ");
}
