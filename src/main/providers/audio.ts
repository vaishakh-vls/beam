import {
  parseLevel,
  parseVolume,
  parseVolumeCommand,
  parseWpctlStatus,
  percent,
  splitName,
  volumeIcon,
  type AudioNode,
} from "../audio";
import type { Entry, Section, ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { runCapture } from "../system";
import type { RunResult } from "../../shared/types";

const QUERY_MS = 5000;
const SINK = "@DEFAULT_AUDIO_SINK@";
const SOURCE = "@DEFAULT_AUDIO_SOURCE@";
const LEVELS = [0, 10, 25, 50, 75, 100];

type Kind = "output" | "input";

function wpctl(args: string[]) {
  return runCapture("wpctl", args, { timeoutMs: QUERY_MS });
}

function failure(what: string, stderr: string): RunResult {
  const reason = stderr.trim().split("\n")[0] || "wpctl failed";
  return { type: "error", message: `Could not ${what}: ${reason}` };
}

/** `-l 1.0` caps the volume at 100%, which wpctl otherwise lets go past. */
async function setVolume(level: number): Promise<RunResult> {
  const { code, stderr } = await wpctl(["set-volume", "-l", "1.0", SINK, `${level}%`]);
  if (code !== 0) return failure("set the volume", stderr);
  // Choosing a level means wanting to hear it, as with GNOME's slider.
  if (level > 0) await wpctl(["set-mute", SINK, "0"]);
  return { type: "stay", toast: `Volume set to ${level}%` };
}

async function stepVolume(up: boolean): Promise<RunResult> {
  const { code, stderr } = await wpctl(["set-volume", "-l", "1.0", SINK, up ? "10%+" : "10%-"]);
  if (code !== 0) return failure("change the volume", stderr);
  if (up) await wpctl(["set-mute", SINK, "0"]);
  const now = parseVolume((await wpctl(["get-volume", SINK])).stdout);
  return { type: "stay", toast: now ? `Volume ${percent(now.volume)}%` : "Volume changed" };
}

async function setMute(target: string, mute: boolean, label: string): Promise<RunResult> {
  const { code, stderr } = await wpctl(["set-mute", target, mute ? "1" : "0"]);
  if (code !== 0) return failure(`${mute ? "mute" : "unmute"} the ${label.toLowerCase()}`, stderr);
  return { type: "stay", toast: `${label} ${mute ? "muted" : "unmuted"}` };
}

async function setDefault(node: AudioNode, title: string, kind: Kind): Promise<RunResult> {
  if (node.isDefault) return { type: "stay", toast: `${title} is already the ${kind}` };
  const { code, stderr } = await wpctl(["set-default", String(node.id)]);
  if (code !== 0) return failure(`switch the ${kind}`, stderr);
  return { type: "stay", toast: `${kind === "output" ? "Output" : "Input"} switched to ${title}` };
}

function setVolumeEntry(id: string, level: number, accessory?: string): Entry {
  const title = `Set Volume to ${level}%`;
  return {
    id,
    title,
    subtitle: "Sound output",
    icon: volumeIcon(level, false),
    accessory,
    keywords: ["level", "volume"],
    actions: [{ id: "set", title, shortcut: "↵", run: () => setVolume(level) }],
  };
}

/** Root search: "volume 40", "vol 40%" and "volume 0" become a Set Volume entry. */
export function volumeEntry(query: string): Entry | null {
  const level = parseVolumeCommand(query);
  return level === null ? null : setVolumeEntry("volume", level, "Volume");
}

function nodeEntry(node: AudioNode, kind: Kind, devices: string[]): Entry {
  const { title, device } = splitName(node.name, devices);
  const level = node.volume === null ? "" : node.muted ? "Muted" : `${percent(node.volume)}%`;
  const action = kind === "output" ? "Use for Sound Output" : "Use for Sound Input";
  return {
    id: `audio:${kind === "output" ? "sink" : "source"}:${node.id}`,
    title,
    subtitle: [device, level].filter(Boolean).join("  ·  "),
    icon: node.isDefault ? "✅" : kind === "output" ? "🔈" : "🎙️",
    accessory: node.isDefault ? "Default" : undefined,
    keywords: [node.name, kind, ...(kind === "input" ? ["microphone", "mic"] : [])],
    actions: [{ id: "default", title: action, shortcut: "↵", run: () => setDefault(node, title, kind) }],
  };
}

function outputEntries(volume: number, muted: boolean, sinkName: string): Entry[] {
  return [
    {
      id: "audio:volume",
      title: `Volume ${volume}%`,
      subtitle: sinkName,
      icon: volumeIcon(volume, muted),
      accessory: muted ? "Muted" : undefined,
      keywords: ["output", "level", "louder", "quieter", "up", "down"],
      actions: [
        { id: "up", title: "Turn Volume Up", shortcut: "↵", run: () => stepVolume(true) },
        { id: "down", title: "Turn Volume Down", shortcut: "Ctrl+↵", run: () => stepVolume(false) },
      ],
    },
    {
      id: "audio:mute",
      title: muted ? "Unmute" : "Mute",
      subtitle: muted ? "Sound is muted" : "Sound is on",
      icon: muted ? "🔊" : "🔇",
      keywords: ["mute", "unmute", "silence", "sound"],
      actions: [{ id: "toggle", title: muted ? "Unmute" : "Mute", shortcut: "↵", run: () => setMute(SINK, !muted, "Sound") }],
    },
    ...LEVELS.map((level) => setVolumeEntry(`audio:level:${level}`, level, level === volume ? "Current" : undefined)),
  ];
}

function microphoneEntry(volume: number, muted: boolean, sourceName: string): Entry {
  const title = muted ? "Unmute Microphone" : "Mute Microphone";
  return {
    id: "audio:mic-mute",
    title,
    subtitle: [`Input volume ${volume}%`, sourceName].filter(Boolean).join("  ·  "),
    icon: muted ? "🎙️" : "🔇",
    accessory: muted ? "Muted" : undefined,
    keywords: ["mic", "microphone", "mute", "unmute", "input"],
    actions: [{ id: "toggle", title, shortcut: "↵", run: () => setMute(SOURCE, !muted, "Microphone") }],
  };
}

export function audioCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:audio-devices",
      ref: "cmd:audio-devices",
      title: "Audio Devices",
      subtitle: "Audio",
      icon: "🎧",
      accessory: "Command",
      keywords: ["sound", "output", "speaker", "headphones", "microphone", "volume", "input", "mic"],
      actions: [{ id: "run", title: "Open Audio Devices", shortcut: "↵", run: () => ({ type: "view", view: "audio" }) }],
    },
  ];
}

export const audioView: ViewProvider = {
  info: { title: "Audio", placeholder: "Search devices, or type a volume such as 40…", preview: false, grid: false, refreshMs: 2000 },
  async sections(query: string): Promise<Section[]> {
    const [status, sink, source] = await Promise.all([wpctl(["status"]), wpctl(["get-volume", SINK]), wpctl(["get-volume", SOURCE])]);
    if (status.code !== 0) {
      return [
        {
          title: "Audio",
          entries: [{ id: "audio:error", title: "Could Not Read Audio Devices", subtitle: status.stderr.trim(), icon: "⚠️", actions: [] }],
        },
      ];
    }
    const audio = parseWpctlStatus(status.stdout);
    const output = parseVolume(sink.stdout);
    const input = parseVolume(source.stdout);
    const nameOf = (nodes: AudioNode[]) => {
      const node = nodes.find((n) => n.isDefault);
      return node ? splitName(node.name, audio.devices).title : "";
    };

    const q = query.trim();
    const typed = parseLevel(q);
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;
    const volume = output ? outputEntries(percent(output.volume), output.muted, nameOf(audio.sinks)) : [];
    return [
      {
        title: "Volume",
        entries: [
          ...(typed === null ? [] : [setVolumeEntry("audio:set", typed)]),
          ...volume.filter((entry) => matches(entry) && entry.id !== `audio:level:${typed}`),
        ],
      },
      { title: "Output Devices", entries: audio.sinks.map((node) => nodeEntry(node, "output", audio.devices)).filter(matches) },
      { title: "Microphone", entries: input ? [microphoneEntry(percent(input.volume), input.muted, nameOf(audio.sources))].filter(matches) : [] },
      { title: "Input Devices", entries: audio.sources.map((node) => nodeEntry(node, "input", audio.devices)).filter(matches) },
    ];
  },
};
