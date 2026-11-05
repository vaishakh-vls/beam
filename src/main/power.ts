// Reads battery and power-profile state for the Power Management view and formats it. Pure.

/** `/sys/class/power_supply/<name>/uevent` as key/value pairs, without the POWER_SUPPLY_ prefix. */
export function parseUevent(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(?:POWER_SUPPLY_)?([A-Z0-9_]+)=(.*)$/);
    if (match) props[match[1]] = match[2].trim();
  }
  return props;
}

export interface Battery {
  name: string;
  /** The kernel's status: "Charging", "Discharging", "Not charging", "Full" or "Unknown". */
  status: string;
  percent: number;
  /** Watt-hours. */
  energyNow: number | null;
  energyFull: number | null;
  energyDesign: number | null;
  /** Watts flowing in or out; the kernel reports it unsigned. */
  powerW: number | null;
  cycles: number | null;
  technology: string;
  vendor: string;
  model: string;
  /** Charge thresholds in percent, where the firmware supports them (ThinkPads do). */
  startThreshold: number | null;
  endThreshold: number | null;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Builds a battery from its uevent. Some batteries report charge (µAh) and
 * current (µA) instead of energy (µWh) and power (µW); those are converted
 * with the voltage so every battery reads in Wh and W.
 */
export function batteryFromUevent(props: Record<string, string>, thresholds: { start: string | null; end: string | null } = { start: null, end: null }): Battery {
  const volts = (num(props.VOLTAGE_NOW) ?? 0) / 1e6;
  const designVolts = (num(props.VOLTAGE_MIN_DESIGN) ?? 0) / 1e6 || volts;
  const wh = (energy: string | undefined, charge: string | undefined, v: number): number | null => {
    const e = num(energy);
    if (e !== null) return e / 1e6;
    const c = num(charge);
    return c !== null && v > 0 ? (c / 1e6) * v : null;
  };
  const energyNow = wh(props.ENERGY_NOW, props.CHARGE_NOW, volts);
  const energyFull = wh(props.ENERGY_FULL, props.CHARGE_FULL, designVolts);
  const energyDesign = wh(props.ENERGY_FULL_DESIGN, props.CHARGE_FULL_DESIGN, designVolts);
  const powerRaw = num(props.POWER_NOW);
  const currentRaw = num(props.CURRENT_NOW);
  const powerW = powerRaw !== null
    ? Math.abs(powerRaw) / 1e6
    : currentRaw !== null && volts > 0
      ? (Math.abs(currentRaw) / 1e6) * volts
      : null;
  const fromEnergy = energyNow !== null && energyFull ? (energyNow / energyFull) * 100 : 0;
  return {
    name: props.NAME ?? "BAT0",
    status: props.STATUS ?? "Unknown",
    percent: num(props.CAPACITY) ?? Math.round(fromEnergy),
    energyNow,
    energyFull,
    energyDesign,
    powerW,
    cycles: num(props.CYCLE_COUNT) || null,
    technology: props.TECHNOLOGY ?? "",
    vendor: props.MANUFACTURER ?? "",
    model: props.MODEL_NAME ?? "",
    startThreshold: num(thresholds.start ?? undefined),
    endThreshold: num(thresholds.end ?? undefined),
  };
}

/** USB-C Power Delivery sources report the negotiated voltage and current; their product is the adapter's wattage. */
export function adapterWatts(props: Record<string, string>): number | null {
  if (props.ONLINE !== "1") return null;
  const volts = num(props.VOLTAGE_NOW);
  const amps = num(props.CURRENT_NOW) || num(props.CURRENT_MAX);
  if (!volts || !amps) return null;
  return Math.round((volts / 1e6) * (amps / 1e6));
}

/** Below this the reading is noise, e.g. while the battery idles at its charge limit. */
const MIN_RATE_W = 0.5;

/**
 * Minutes until empty while discharging, or until the charge limit (not 100%)
 * while charging. Null when the battery is idle or the rate is unknown.
 */
export function minutesRemaining(battery: Battery): number | null {
  const { energyNow, energyFull, powerW, status } = battery;
  if (energyNow === null || !powerW || powerW < MIN_RATE_W) return null;
  if (status === "Discharging") return Math.round((energyNow / powerW) * 60);
  if (status === "Charging" && energyFull) {
    const target = energyFull * ((battery.endThreshold ?? 100) / 100);
    return target > energyNow ? Math.round(((target - energyNow) / powerW) * 60) : null;
  }
  return null;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Capacity left compared with when new, in percent; may exceed 100 for a fresh battery. */
export function healthPercent(battery: Battery): number | null {
  if (!battery.energyFull || !battery.energyDesign) return null;
  return Math.round((battery.energyFull / battery.energyDesign) * 100);
}

export function healthLabel(percent: number): string {
  if (percent >= 80) return "Good";
  if (percent >= 60) return "Fair";
  return "Worn: consider a replacement";
}

/** True while a charge limit below 100% is set. */
export function hasChargeLimit(battery: Battery): boolean {
  return battery.endThreshold !== null && battery.endThreshold > 0 && battery.endThreshold < 100;
}

/** One line for the battery's state, explaining "Not charging" when the charge limit causes it. */
export function stateText(battery: Battery, onAc: boolean): string {
  const remaining = minutesRemaining(battery);
  switch (battery.status) {
    case "Charging":
      return remaining !== null
        ? `Charging · ${formatMinutes(remaining)} until ${hasChargeLimit(battery) ? `${battery.endThreshold}%` : "full"}`
        : "Charging";
    case "Discharging":
      return remaining !== null ? `On battery · ${formatMinutes(remaining)} left` : "On battery";
    case "Full":
      return "Fully charged";
    case "Not charging":
      if (hasChargeLimit(battery) && battery.percent >= (battery.startThreshold ?? 0)) {
        return `Plugged in · held at ${battery.endThreshold}% by the charge limit`;
      }
      return onAc ? "Plugged in · not charging" : "Not charging";
    default:
      return onAc ? "Plugged in" : battery.status;
  }
}

export interface ChargePreset {
  id: string;
  title: string;
  hint: string;
  start: number;
  end: number;
}

/**
 * Lenovo and battery makers recommend keeping lithium batteries away from
 * 100% when the laptop is mostly plugged in. 0/100 is the firmware default.
 */
export const CHARGE_PRESETS: ChargePreset[] = [
  { id: "full", title: "Full Charge (100%)", hint: "Most runtime; the firmware default", start: 0, end: 100 },
  { id: "balanced", title: "Stop at 80%", hint: "Resume below 75%; recommended for daily use", start: 75, end: 80 },
  { id: "plugged-in", title: "Stop at 60%", hint: "Resume below 55%; longest life when always plugged in", start: 55, end: 60 },
];

/** Bounds shared with packaging/beam-power, which checks them again as root. */
export const MIN_END_THRESHOLD = 40;

/** Why a start/end pair can't be set, or null when it can. */
export function thresholdProblem(start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "Use whole percentages.";
  if (end < MIN_END_THRESHOLD || end > 100) return `Stop charging at ${MIN_END_THRESHOLD}–100%.`;
  if (start < 0 || start > 99) return "Start charging at 0–99%.";
  if (start >= end) return "The start must be below the stop level.";
  return null;
}

export function presetFor(battery: Battery): ChargePreset | null {
  const end = battery.endThreshold === 0 ? 100 : battery.endThreshold;
  return CHARGE_PRESETS.find((p) => p.end === end && p.start === battery.startThreshold) ?? null;
}

export interface PowerProfiles {
  active: string | null;
  profiles: string[];
  /** Why performance is held back, e.g. "lap-detected"; null when it isn't. */
  degraded: string | null;
}

/** `powerprofilesctl list`: the active profile is starred, settings are indented below each. */
export function parsePowerProfiles(text: string): PowerProfiles {
  const result: PowerProfiles = { active: null, profiles: [], degraded: null };
  for (const line of text.split("\n")) {
    const profile = line.match(/^([* ]) ?([a-z-]+):\s*$/);
    if (profile) {
      result.profiles.push(profile[2]);
      if (profile[1] === "*") result.active = profile[2];
      continue;
    }
    const degraded = line.match(/^\s+Degraded:\s*yes\s*(?:\((.+)\))?/);
    if (degraded) result.degraded = degraded[1]?.trim() || "yes";
  }
  return result;
}

const PROFILE_INFO: Record<string, { title: string; hint: string }> = {
  performance: { title: "Performance", hint: "Fastest; more heat, fan noise and battery use" },
  balanced: { title: "Balanced", hint: "Standard performance and power use" },
  "power-saver": { title: "Power Saver", hint: "Slower; longer battery life and a quieter fan" },
};

export function profileTitle(profile: string): string {
  return PROFILE_INFO[profile]?.title ?? profile;
}

export function profileHint(profile: string): string {
  return PROFILE_INFO[profile]?.hint ?? "";
}

export function degradedText(reason: string): string {
  if (reason === "lap-detected") return "Held back: the laptop is on a lap";
  if (reason === "high-operating-temperature") return "Held back: the laptop is too hot";
  return `Held back: ${reason}`;
}

/** logind's CanHibernate/CanSuspend answer, as printed by `busctl call`: `s "yes"`. */
export function parseCanAnswer(text: string): boolean {
  return /"(yes|challenge)"/.test(text);
}

const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = Object.fromEntries([
  ...["h", "hr", "hrs", "hour", "hours"].map((u) => [u, 3_600_000]),
  ...["m", "min", "mins", "minute", "minutes"].map((u) => [u, 60_000]),
  ...["s", "sec", "secs", "second", "seconds"].map((u) => [u, 1000]),
]);

/**
 * When a "Sleep in…" or "Shut Down in…" timer should fire, in ms from now.
 * Accepts minutes ("30"), units ("45m", "1h", "1.5h", "1h 30m") or a clock
 * time ("23:15", "at 7:05"), which means its next occurrence.
 */
export function parseDelay(text: string, now: Date = new Date()): number | null {
  const t = text.trim().toLowerCase().replace(/^in\s+/, "");
  if (!t) return null;
  const clock = t.match(/^(?:at\s+)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || m > 59) return null;
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime() - now.getTime();
  }
  let ms = 0;
  // "1h30" reads as an hour and a half.
  const hoursMinutes = t.match(/^(\d+)\s*h\s*(\d{1,2})$/);
  if (/^\d+(\.\d+)?$/.test(t)) {
    ms = Number(t) * 60_000;
  } else if (hoursMinutes) {
    ms = Number(hoursMinutes[1]) * 3_600_000 + Number(hoursMinutes[2]) * 60_000;
  } else {
    // Everything typed must be part of a duration, so "1h abc" is rejected.
    if (t.replace(/(\d+(?:\.\d+)?)\s*([a-z]+)/g, "").replace(/\band\b|,/g, "").trim()) return null;
    const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)];
    if (!parts.length) return null;
    for (const [, value, unit] of parts) {
      if (!Object.hasOwn(UNIT_MS, unit)) return null;
      const factor = UNIT_MS[unit];
      ms += Number(value) * factor;
    }
  }
  ms = Math.round(ms);
  return ms >= 1000 && ms <= MAX_DELAY_MS ? ms : null;
}

/** "in 1 h 30 min (at 23:45)" for a timer `ms` from `now`. */
export function describeDelay(ms: number, now: Date = new Date()): string {
  const at = new Date(now.getTime() + ms);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const minutes = Math.round(ms / 60_000);
  const span = minutes >= 1 ? formatMinutes(minutes) : `${Math.round(ms / 1000)} s`;
  return `in ${span} (at ${time})`;
}

/** The Battery Status report: one fact per line. */
export function batteryReport(battery: Battery, onAc: boolean, adapterW: number | null): string {
  const health = healthPercent(battery);
  const fmt = (wh: number | null) => (wh === null ? "—" : `${wh.toFixed(1)} Wh`);
  const lines = [
    `${battery.percent}%  ·  ${stateText(battery, onAc)}`,
    "",
    `Power draw     ${battery.powerW && battery.powerW >= MIN_RATE_W ? `${battery.powerW.toFixed(1)} W` : "—"}`,
    `Energy         ${fmt(battery.energyNow)} of ${fmt(battery.energyFull)}`,
    `Health         ${health === null ? "—" : `${health}% of design capacity (${fmt(battery.energyDesign)}) · ${healthLabel(health)}`}`,
    `Cycles         ${battery.cycles ?? "—"}`,
    `Charge limit   ${battery.endThreshold === null ? "Not supported" : hasChargeLimit(battery) ? `Stop at ${battery.endThreshold}%, resume below ${battery.startThreshold ?? 0}%` : "Off (charges to 100%)"}`,
    `Adapter        ${onAc ? (adapterW ? `Connected · ${adapterW} W` : "Connected") : "Not connected"}`,
    `Battery        ${[battery.vendor, battery.model, battery.technology].filter(Boolean).join(" · ") || battery.name}`,
  ];
  return lines.join("\n");
}

/** A battery gauge for the Battery Status screen, as an SVG data URL. */
export function batteryGaugeSvg(percent: number, charging: boolean, colors: { fill: string; frame: string; text: string }): string {
  const level = Math.max(0, Math.min(100, percent));
  const fill = level <= 15 && !charging ? "#ff6b6b" : colors.fill;
  const inner = Math.round((level / 100) * 176);
  const bolt = charging
    ? `<path d="M104 18 L88 50 H100 L94 74 L114 40 H102 L108 18 Z" fill="${colors.text}" opacity="0.9"/>`
    : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="92" viewBox="0 0 220 92">` +
    `<rect x="3" y="3" width="192" height="86" rx="14" fill="none" stroke="${colors.frame}" stroke-width="4"/>` +
    `<rect x="199" y="30" width="12" height="32" rx="4" fill="${colors.frame}"/>` +
    `<rect x="11" y="11" width="${inner}" height="70" rx="8" fill="${fill}"/>` +
    bolt +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
