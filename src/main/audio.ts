// Parses WirePlumber's wpctl output for the Audio view and reads volume queries ("volume 40").

export interface AudioNode {
  id: number;
  name: string;
  isDefault: boolean;
  /** 1.0 is 100%. Null when wpctl shows no volume. */
  volume: number | null;
  muted: boolean;
}

export interface AudioStatus {
  /** Sound cards and Bluetooth devices; their names prefix the names of their sinks and sources. */
  devices: string[];
  sinks: AudioNode[];
  sources: AudioNode[];
}

/**
 * `wpctl status` draws a tree. Only the Audio section's Devices, Sinks and
 * Sources are read; "*" marks the default and the volume ends the line as
 * "[vol: 0.45]" or "[vol: 0.45 MUTED]".
 */
export function parseWpctlStatus(text: string): AudioStatus {
  const status: AudioStatus = { devices: [], sinks: [], sources: [] };
  let section = "";
  let group = "";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\S/.test(line)) {
      section = line;
      group = "";
      continue;
    }
    if (section !== "Audio") continue;
    const heading = /^[\s│]*[├└]─\s*(.+?):$/.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    const item = /^[\s│]*(\*)?\s*(\d+)\.\s+(.*)$/.exec(line);
    if (!item) continue;
    const [, star, id, rest] = item;
    if (group === "Devices") {
      status.devices.push(rest.replace(/\s*\[[^\]]*\]$/, "").trim());
    } else if (group === "Sinks" || group === "Sources") {
      const volume = /^(.*?)\s*\[vol:\s*([\d.]+)(\s+MUTED)?\]$/.exec(rest);
      (group === "Sinks" ? status.sinks : status.sources).push({
        id: Number(id),
        name: (volume ? volume[1] : rest).trim(),
        isDefault: star === "*",
        volume: volume ? Number(volume[2]) : null,
        muted: Boolean(volume?.[3]),
      });
    }
  }
  return status;
}

/** `wpctl get-volume <id>`: "Volume: 0.45" or "Volume: 0.00 [MUTED]". */
export function parseVolume(text: string): { volume: number; muted: boolean } | null {
  const match = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/.exec(text);
  return match ? { volume: Number(match[1]), muted: Boolean(match[2]) } : null;
}

export function percent(volume: number): number {
  return Math.round(volume * 100);
}

function toLevel(digits: string): number | null {
  const value = Number(digits);
  return value <= 100 ? value : null;
}

/** A number typed in the Audio view: "40" or "40%". */
export function parseLevel(query: string): number | null {
  const match = /^(\d{1,3})\s*%?$/.exec(query.trim());
  return match ? toLevel(match[1]) : null;
}

/** Root search: "volume 40", "vol 40%", "set volume to 40". */
export function parseVolumeCommand(query: string): number | null {
  const match = /^(?:set\s+)?vol(?:ume)?(?:\s+to)?\s+(\d{1,3})\s*%?$/i.exec(query.trim());
  return match ? toLevel(match[1]) : null;
}

/**
 * "sof-hda-dsp Speaker + Headphones" -> "Speaker + Headphones" on the
 * sof-hda-dsp card. Bluetooth sinks are named after the device and stay as they are.
 */
export function splitName(name: string, devices: string[]): { title: string; device: string } {
  const device = [...devices]
    .sort((a, b) => b.length - a.length)
    .find((d) => d && name.startsWith(`${d} `) && name.length > d.length + 1);
  return device ? { title: name.slice(device.length + 1).trim(), device } : { title: name, device: "" };
}

export function volumeIcon(level: number, muted: boolean): string {
  if (muted || level === 0) return "🔇";
  if (level < 34) return "🔈";
  if (level < 67) return "🔉";
  return "🔊";
}
