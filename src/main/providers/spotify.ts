import fs from "node:fs";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import {
  METADATA_FORMAT,
  classifyPlayerError,
  formatProgress,
  loopLabel,
  nextLoop,
  parseLoop,
  parseMetadata,
  parsePosition,
  parseShuffle,
  parseStatus,
  parseVolume,
  spotifySearchUri,
  spotifyWebSearchUrl,
  trackKey,
  type LoopStatus,
  type PlaybackStatus,
  type Track,
} from "../spotify";
import { copyText, launchDetached, notify, openUrl, runCapture } from "../system";
import type { RunResult } from "../../shared/types";

const INSTALL_HINT = "Spotify controls need playerctl. Install it with: sudo apt install playerctl";
/** How long Spotify gets to start and register with MPRIS before a command gives up. */
const START_TIMEOUT_MS = 20_000;

interface PlayerState {
  /** "missing" when playerctl is not installed. */
  running: boolean | "missing";
  status: PlaybackStatus | null;
  track: Track | null;
  position: number | null;
  volume: number | null;
  shuffle: boolean | null;
  loop: LoopStatus | null;
}

async function player(...args: string[]): Promise<{ ok: boolean; out: string; error: "missing" | "not-running" | "other" | null; stderr: string }> {
  const { code, stdout, stderr } = await runCapture("playerctl", ["-p", "spotify", ...args], { timeoutMs: 3000 });
  return { ok: code === 0, out: stdout, error: code === 0 ? null : classifyPlayerError(stderr), stderr: stderr.trim() };
}

async function readTrack(): Promise<Track | null> {
  const result = await player("metadata", "--format", METADATA_FORMAT);
  return result.ok ? parseMetadata(result.out) : null;
}

async function readState(): Promise<PlayerState> {
  const status = await player("status");
  if (!status.ok) {
    return {
      running: status.error === "missing" ? "missing" : false,
      status: null,
      track: null,
      position: null,
      volume: null,
      shuffle: null,
      loop: null,
    };
  }
  const [track, position, volume, shuffle, loop] = await Promise.all([
    readTrack(),
    player("position"),
    player("volume"),
    player("shuffle"),
    player("loop"),
  ]);
  return {
    running: true,
    status: parseStatus(status.out),
    track,
    position: position.ok ? parsePosition(position.out) : null,
    volume: volume.ok ? parseVolume(volume.out) : null,
    shuffle: shuffle.ok ? parseShuffle(shuffle.out) : null,
    loop: loop.ok ? parseLoop(loop.out) : null,
  };
}

function spotifyBinary(): string {
  // The snap's launcher is not always on PATH for apps started from the desktop.
  return fs.existsSync("/snap/bin/spotify") ? "/snap/bin/spotify" : "spotify";
}

function openSpotify(): void {
  launchDetached(spotifyBinary());
}

async function isRunning(): Promise<boolean> {
  return (await player("status")).ok;
}

/** Starts Spotify and resolves once it answers over MPRIS, or false after the timeout. */
async function startSpotify(): Promise<boolean> {
  openSpotify();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await isRunning()) return true;
  }
  return false;
}

/** Next and Previous take a moment to reach MPRIS; wait for the track to change. */
async function waitForNewTrack(before: string): Promise<Track | null> {
  let track: Track | null = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(150);
    track = await readTrack();
    if (track && trackKey(track) !== before) return track;
  }
  return track;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(track: Track): string {
  return [track.artist, track.album].filter(Boolean).join(" · ");
}

function failure(stderr: string, error: "missing" | "not-running" | "other" | null): string {
  if (error === "missing") return INSTALL_HINT;
  if (error === "not-running") return "Spotify is not running";
  return `Spotify did not respond${stderr ? `: ${stderr}` : ""}`;
}

/** Runs a playback command, starting Spotify first when it is closed. Never blocks on the start. */
async function playbackCommand(args: string[], announce: boolean, hide: () => void): Promise<RunResult> {
  const status = await player("status");
  if (status.error === "not-running") {
    notify("Starting Spotify…");
    void runAfterStart(args);
    return HIDE;
  }
  if (!status.ok) return { type: "error", message: failure(status.stderr, status.error) };
  const previous = announce ? trackKey(await readTrack()) : "";
  const result = await player(...args);
  if (!result.ok) return { type: "error", message: failure(result.stderr, result.error) };
  if (announce) {
    // Close Beam now; the notification follows when Spotify has switched tracks.
    hide();
    await announceTrack(previous);
  }
  return HIDE;
}

async function runAfterStart(args: string[]): Promise<void> {
  if (!(await startSpotify())) {
    notify("Spotify did not start", "Open it from the app grid and try again.");
    return;
  }
  // MPRIS comes up a moment before the last session's track is loaded.
  await sleep(1500);
  const toggle = args[0] === "play-pause";
  const previous = toggle ? "" : trackKey(await readTrack());
  // A fresh start is paused on the last track: play it rather than toggling.
  await player(...(toggle ? ["play"] : args));
  await announceTrack(previous);
}

async function announceTrack(previous: string): Promise<void> {
  const track = await waitForNewTrack(previous);
  if (track) notify(track.title, describe(track));
}

export function spotifyCommands(hide: () => void): Entry[] {
  const command = (name: string, title: string, icon: string, keywords: string[], run: EntryAction["run"]): Entry => ({
    id: `cmd:${name}`,
    ref: `cmd:${name}`,
    title,
    subtitle: "Spotify",
    icon,
    accessory: "Command",
    keywords,
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run }],
  });
  const openView = (): RunResult => ({ type: "view", view: "media" });
  return [
    command("spotify-now-playing", "Spotify Now Playing", "🎵", ["music", "song", "track", "player", "media", "current"], openView),
    command("spotify-play-pause", "Spotify Play/Pause", "⏯️", ["music", "play", "pause", "resume", "toggle", "media"], () =>
      playbackCommand(["play-pause"], false, hide),
    ),
    command("spotify-next", "Spotify Next Track", "⏭️", ["music", "skip", "song", "forward", "media"], () =>
      playbackCommand(["next"], true, hide),
    ),
    command("spotify-previous", "Spotify Previous Track", "⏮️", ["music", "back", "song", "rewind", "media"], () =>
      playbackCommand(["previous"], true, hide),
    ),
    command("spotify-search", "Search Spotify", "🎧", ["music", "song", "artist", "album", "playlist", "podcast"], openView),
  ];
}

// Whether spotify: links open the desktop app; checked once per session.
let schemeHandler: Promise<boolean> | null = null;

function hasSchemeHandler(): Promise<boolean> {
  schemeHandler ??= runCapture("xdg-mime", ["query", "default", "x-scheme-handler/spotify"], { timeoutMs: 3000 }).then(
    ({ code, stdout }) => code === 0 && stdout.trim().length > 0,
  );
  return schemeHandler;
}

function searchEntry(query: string): Entry {
  const q = query.trim();
  return {
    id: "media:search",
    title: `Search Spotify for “${q}”`,
    subtitle: "Spotify",
    icon: "🔍",
    actions: [
      {
        id: "search",
        title: "Search in Spotify",
        shortcut: "↵",
        run: async () => {
          if (await hasSchemeHandler()) launchDetached("xdg-open", [spotifySearchUri(q)]);
          else openUrl(spotifyWebSearchUrl(q));
          return HIDE;
        },
      },
      {
        id: "search-web",
        title: "Search on Spotify Web",
        shortcut: "Ctrl+↵",
        run: () => {
          openUrl(spotifyWebSearchUrl(q));
          return HIDE;
        },
      },
    ],
  };
}

/** A control item: `run` acts on Spotify and returns the toast text. */
function control(
  id: string,
  title: string,
  icon: string,
  accessory: string | undefined,
  keywords: string[],
  run: () => Promise<string>,
): Entry {
  return {
    id: `media:${id}`,
    title,
    icon,
    accessory,
    keywords,
    actions: [
      {
        id: "run",
        title,
        shortcut: "↵",
        run: async () => {
          try {
            return { type: "stay", toast: await run() };
          } catch (error) {
            return { type: "error", message: (error as Error).message };
          }
        },
      },
    ],
  };
}

async function must(...args: string[]): Promise<string> {
  const result = await player(...args);
  if (!result.ok) throw new Error(failure(result.stderr, result.error));
  return result.out;
}

function controlEntries(state: PlayerState): Entry[] {
  const playing = state.status === "Playing";
  const skip = (direction: "next" | "previous") => async () => {
    const before = trackKey(await readTrack());
    await must(direction);
    const track = await waitForNewTrack(before);
    return track ? `Now playing ${track.title}` : direction === "next" ? "Skipped" : "Went back";
  };
  const volume = (change: string) => async () => {
    await must("volume", change);
    const level = parseVolume(await must("volume"));
    return level === null ? "Volume changed" : `Volume ${level}%`;
  };
  const level = state.volume === null ? undefined : `${state.volume}%`;
  return [
    control("play-pause", playing ? "Pause" : "Play", playing ? "⏸️" : "▶️", undefined, ["play", "pause", "resume", "stop"], async () => {
      await must("play-pause");
      return playing ? "Paused" : "Playing";
    }),
    control("next", "Next Track", "⏭️", undefined, ["skip", "forward"], skip("next")),
    control("previous", "Previous Track", "⏮️", undefined, ["back", "rewind"], skip("previous")),
    control("shuffle", "Shuffle", "🔀", state.shuffle === null ? undefined : state.shuffle ? "On" : "Off", ["random"], async () => {
      await must("shuffle", "Toggle");
      const now = parseShuffle(await must("shuffle"));
      return now === null ? "Shuffle toggled" : now ? "Shuffle on" : "Shuffle off";
    }),
    control("repeat", "Repeat", state.loop === "Track" ? "🔂" : "🔁", state.loop ? loopLabel(state.loop) : undefined, ["loop"], async () => {
      const next = nextLoop(state.loop);
      await must("loop", next);
      return next === "None" ? "Repeat off" : `Repeat ${next.toLowerCase()}`;
    }),
    control("volume-up", "Volume Up", "🔊", level, ["louder", "sound"], volume("0.1+")),
    control("volume-down", "Volume Down", "🔉", level, ["quieter", "softer", "sound"], volume("0.1-")),
  ];
}

function nowPlayingEntry(state: PlayerState): Entry {
  const track = state.track;
  const progress = formatProgress(state.position, track?.length);
  const status = state.status ?? "Stopped";
  const extras = [
    state.shuffle === null ? "" : `Shuffle ${state.shuffle ? "on" : "off"}`,
    state.loop === null ? "" : `Repeat ${loopLabel(state.loop).toLowerCase()}`,
    state.volume === null ? "" : `Volume ${state.volume}%`,
  ].filter(Boolean);
  const actions: EntryAction[] = [
    {
      id: "play-pause",
      title: state.status === "Playing" ? "Pause" : "Play",
      shortcut: "↵",
      run: async () => {
        const result = await player("play-pause");
        if (!result.ok) return { type: "error", message: failure(result.stderr, result.error) };
        return { type: "stay", toast: state.status === "Playing" ? "Paused" : "Playing" };
      },
    },
    {
      id: "open",
      title: "Open Spotify",
      shortcut: "Ctrl+↵",
      run: () => {
        openSpotify();
        return HIDE;
      },
    },
  ];
  if (track) {
    actions.push({
      id: "copy-title",
      title: "Copy Title and Artist",
      shortcut: "Ctrl+Shift+C",
      run: () => {
        copyText([track.title, track.artist].filter(Boolean).join(" – "));
        return { type: "stay", toast: "Copied title and artist" };
      },
    });
  }
  if (track?.url) {
    const url = track.url;
    actions.push({
      id: "copy-link",
      title: "Copy Song Link",
      shortcut: "Ctrl+Shift+L",
      run: () => {
        copyText(url);
        return { type: "stay", toast: "Song link copied" };
      },
    });
  }
  return {
    id: "media:now-playing",
    title: track?.title ?? "Nothing Playing",
    subtitle: track ? describe(track) : "Pick something to play in Spotify",
    icon: track?.artUrl ?? (state.status === "Playing" ? "🎵" : "⏸️"),
    accessory: [status, progress].filter(Boolean).join("  ·  "),
    previewImage: track?.artUrl,
    preview: track
      ? [track.title, track.artist, track.album]
          .filter(Boolean)
          .concat("", [status, progress].filter(Boolean).join("  "), extras.join(" · "))
          .join("\n")
          .trim()
      : `${status}\n\nNothing is loaded in Spotify.`,
    actions,
  };
}

function offlineEntries(missing: boolean): Entry[] {
  if (missing) {
    return [
      {
        id: "media:install",
        title: "Install playerctl to Control Spotify",
        subtitle: "sudo apt install playerctl",
        icon: "⚠️",
        preview: `${INSTALL_HINT}\n\nBeam talks to Spotify through MPRIS using playerctl.`,
        actions: [
          {
            id: "copy",
            title: "Copy Install Command",
            shortcut: "↵",
            run: () => {
              copyText("sudo apt install playerctl");
              return { type: "stay", toast: "Install command copied" };
            },
          },
          {
            id: "open",
            title: "Open Spotify",
            shortcut: "Ctrl+↵",
            run: () => {
              openSpotify();
              return HIDE;
            },
          },
        ],
      },
    ];
  }
  return [
    {
      id: "media:open",
      title: "Open Spotify",
      subtitle: "Spotify is not running",
      icon: "🎵",
      preview: "Spotify is not running.\n\nOpen it to see what's playing and control playback here.",
      actions: [
        {
          id: "open",
          title: "Open Spotify",
          shortcut: "↵",
          run: () => {
            openSpotify();
            // The view refreshes every second, so controls appear once Spotify is up.
            return { type: "stay", toast: "Starting Spotify…" };
          },
        },
      ],
    },
  ];
}

/** Typing "skip" or "vol" narrows the controls; anything else falls through to search. */
function matches(query: string, entry: Entry): boolean {
  const q = query.trim().toLowerCase();
  return [entry.title, ...(entry.keywords ?? [])].some((text) => text.toLowerCase().includes(q));
}

export const spotifyView: ViewProvider = {
  info: {
    title: "Spotify",
    placeholder: "Search Spotify or control playback…",
    preview: true,
    grid: false,
    refreshMs: 1000,
  },
  async sections(query) {
    const q = query.trim();
    const state = await readState();
    const sections: Section[] = [];
    if (state.running !== true) {
      sections.push({ title: "Spotify", entries: offlineEntries(state.running === "missing") });
    } else {
      if (!q) sections.push({ title: "Now Playing", entries: [nowPlayingEntry(state)] });
      const controls = controlEntries(state).filter((entry) => !q || matches(q, entry));
      sections.push({ title: "Controls", entries: controls });
    }
    if (q) sections.push({ title: "Search", entries: [searchEntry(q)] });
    return sections;
  },
};
