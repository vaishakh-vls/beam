import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adapterWatts,
  batteryFromUevent,
  batteryReport,
  describeDelay,
  formatMinutes,
  hasChargeLimit,
  healthLabel,
  healthPercent,
  minutesRemaining,
  parseCanAnswer,
  parseDelay,
  parsePowerProfiles,
  parseUevent,
  presetFor,
  stateText,
  thresholdProblem,
} from "../src/main/power.ts";

// Real files from a ThinkPad P14s on Ubuntu 24.04 (kernel 6.17), plugged into a 100 W USB-C charger.
const BAT0 = [
  "DEVTYPE=power_supply",
  "POWER_SUPPLY_NAME=BAT0",
  "POWER_SUPPLY_TYPE=Battery",
  "POWER_SUPPLY_STATUS=Not charging",
  "POWER_SUPPLY_PRESENT=1",
  "POWER_SUPPLY_TECHNOLOGY=Li-poly",
  "POWER_SUPPLY_CYCLE_COUNT=9",
  "POWER_SUPPLY_VOLTAGE_MIN_DESIGN=11310000",
  "POWER_SUPPLY_VOLTAGE_NOW=12993000",
  "POWER_SUPPLY_POWER_NOW=0",
  "POWER_SUPPLY_ENERGY_FULL_DESIGN=57000000",
  "POWER_SUPPLY_ENERGY_FULL=58040000",
  "POWER_SUPPLY_ENERGY_NOW=56430000",
  "POWER_SUPPLY_CAPACITY=97",
  "POWER_SUPPLY_CAPACITY_LEVEL=Normal",
  "POWER_SUPPLY_TYPE=Battery",
  "POWER_SUPPLY_MODEL_NAME=5B11M90119",
  "POWER_SUPPLY_MANUFACTURER=Sunwoda",
  "POWER_SUPPLY_SERIAL_NUMBER= 5673",
  "",
].join("\n");

const USB_C = [
  "DEVTYPE=power_supply",
  "POWER_SUPPLY_NAME=ucsi-source-psy-USBC000:002",
  "POWER_SUPPLY_TYPE=USB",
  "POWER_SUPPLY_CHARGE_TYPE=Standard",
  "POWER_SUPPLY_ONLINE=1",
  "POWER_SUPPLY_VOLTAGE_MAX=13400000",
  "POWER_SUPPLY_VOLTAGE_MIN=5000000",
  "POWER_SUPPLY_VOLTAGE_NOW=20000000",
  "POWER_SUPPLY_CURRENT_MAX=5720000",
  "POWER_SUPPLY_CURRENT_NOW=5000000",
  "POWER_SUPPLY_TYPE=USB",
  "POWER_SUPPLY_USB_TYPE=C [PD] PD_PPS",
  "POWER_SUPPLY_SCOPE=System",
  "",
].join("\n");

// `powerprofilesctl list` from power-profiles-daemon 0.21.
const PROFILES = [
  "* performance:",
  "    CpuDriver:\tintel_pstate",
  "    PlatformDriver:\tplatform_profile",
  "    Degraded:   no",
  "",
  "  balanced:",
  "    CpuDriver:\tintel_pstate",
  "    PlatformDriver:\tplatform_profile",
  "",
  "  power-saver:",
  "    CpuDriver:\tintel_pstate",
  "    PlatformDriver:\tplatform_profile",
  "",
].join("\n");

const thresholds = { start: "0", end: "100" };

test("parseUevent strips the prefix and keeps values", () => {
  const props = parseUevent(BAT0);
  assert.equal(props.NAME, "BAT0");
  assert.equal(props.STATUS, "Not charging");
  assert.equal(props.SERIAL_NUMBER, "5673");
  assert.equal(props.DEVTYPE, "power_supply");
});

test("batteryFromUevent reads energy in Wh, power in W and the thresholds", () => {
  const battery = batteryFromUevent(parseUevent(BAT0), thresholds);
  assert.equal(battery.percent, 97);
  assert.equal(battery.energyNow, 56.43);
  assert.equal(battery.energyFull, 58.04);
  assert.equal(battery.energyDesign, 57);
  assert.equal(battery.powerW, 0);
  assert.equal(battery.cycles, 9);
  assert.equal(battery.startThreshold, 0);
  assert.equal(battery.endThreshold, 100);
  assert.equal(battery.vendor, "Sunwoda");
});

test("batteryFromUevent converts charge/current batteries with the voltage", () => {
  const battery = batteryFromUevent(
    parseUevent(
      [
        "POWER_SUPPLY_NAME=BAT1",
        "POWER_SUPPLY_STATUS=Discharging",
        "POWER_SUPPLY_VOLTAGE_MIN_DESIGN=7600000",
        "POWER_SUPPLY_VOLTAGE_NOW=8000000",
        "POWER_SUPPLY_CURRENT_NOW=1000000",
        "POWER_SUPPLY_CHARGE_FULL_DESIGN=5000000",
        "POWER_SUPPLY_CHARGE_FULL=4000000",
        "POWER_SUPPLY_CHARGE_NOW=2000000",
        "POWER_SUPPLY_CYCLE_COUNT=0",
      ].join("\n"),
    ),
  );
  assert.equal(battery.powerW, 8);
  assert.equal(battery.energyNow, 16);
  assert.equal(battery.energyFull, 30.4);
  assert.equal(battery.energyDesign, 38);
  assert.equal(battery.percent, 53);
  // Unknown cycles read 0 on many batteries.
  assert.equal(battery.cycles, null);
  assert.equal(battery.endThreshold, null);
});

test("adapterWatts multiplies the USB-C PD contract, and ignores offline ports", () => {
  assert.equal(adapterWatts(parseUevent(USB_C)), 100);
  assert.equal(adapterWatts(parseUevent(USB_C.replace("ONLINE=1", "ONLINE=0"))), null);
  assert.equal(adapterWatts({ ONLINE: "1" }), null);
});

test("minutesRemaining counts down to empty, or up to the charge limit", () => {
  const base = batteryFromUevent(parseUevent(BAT0), thresholds);
  assert.equal(minutesRemaining(base), null);
  assert.equal(minutesRemaining({ ...base, status: "Discharging", powerW: 10 }), 339);
  // 58.04 Wh × 80% = 46.43 Wh target; 40 → 46.43 at 20 W is 19 min.
  assert.equal(minutesRemaining({ ...base, status: "Charging", energyNow: 40, powerW: 20, endThreshold: 80 }), 19);
  assert.equal(minutesRemaining({ ...base, status: "Charging", energyNow: 50, powerW: 20, endThreshold: 80 }), null);
  assert.equal(minutesRemaining({ ...base, status: "Discharging", powerW: 0.2 }), null);
});

test("formatMinutes", () => {
  assert.equal(formatMinutes(0), "1 min");
  assert.equal(formatMinutes(45), "45 min");
  assert.equal(formatMinutes(60), "1 h");
  assert.equal(formatMinutes(339), "5 h 39 min");
});

test("health compares full capacity with design capacity", () => {
  const battery = batteryFromUevent(parseUevent(BAT0), thresholds);
  assert.equal(healthPercent(battery), 102);
  assert.equal(healthPercent({ ...battery, energyDesign: null }), null);
  assert.equal(healthLabel(102), "Good");
  assert.equal(healthLabel(70), "Fair");
  assert.match(healthLabel(50), /Worn/);
});

test("stateText explains why a plugged-in battery isn't charging", () => {
  const battery = batteryFromUevent(parseUevent(BAT0), thresholds);
  assert.equal(stateText(battery, true), "Plugged in · not charging");
  const limited = { ...battery, percent: 80, startThreshold: 75, endThreshold: 80 };
  assert.equal(hasChargeLimit(limited), true);
  assert.equal(stateText(limited, true), "Plugged in · held at 80% by the charge limit");
  assert.equal(stateText({ ...battery, status: "Discharging", powerW: 10 }, false), "On battery · 5 h 39 min left");
  assert.equal(stateText({ ...limited, status: "Charging", percent: 60, energyNow: 40, powerW: 20 }, true), "Charging · 19 min until 80%");
  assert.equal(stateText({ ...battery, status: "Full" }, true), "Fully charged");
});

test("thresholdProblem matches the root helper's rules", () => {
  assert.equal(thresholdProblem(75, 80), null);
  assert.equal(thresholdProblem(0, 100), null);
  assert.equal(thresholdProblem(55, 60), null);
  assert.match(thresholdProblem(80, 80)!, /below/);
  assert.match(thresholdProblem(10, 30)!, /40–100/);
  assert.match(thresholdProblem(75, 101)!, /40–100/);
  assert.match(thresholdProblem(-1, 80)!, /0–99/);
  assert.match(thresholdProblem(Number("7a"), 80)!, /whole/);
  assert.match(thresholdProblem(75.5, 80)!, /whole/);
});

test("presetFor recognises the firmware default and Beam's presets", () => {
  const battery = batteryFromUevent(parseUevent(BAT0), thresholds);
  assert.equal(presetFor(battery)?.id, "full");
  assert.equal(presetFor({ ...battery, startThreshold: 75, endThreshold: 80 })?.id, "balanced");
  assert.equal(presetFor({ ...battery, startThreshold: 70, endThreshold: 80 }), null);
});

test("parsePowerProfiles finds the starred profile", () => {
  assert.deepEqual(parsePowerProfiles(PROFILES), {
    active: "performance",
    profiles: ["performance", "balanced", "power-saver"],
    degraded: null,
  });
  const degraded = PROFILES.replace("Degraded:   no", "Degraded:   yes (lap-detected)").replace("* performance", "  performance").replace("  balanced:", "* balanced:");
  assert.deepEqual(parsePowerProfiles(degraded), {
    active: "balanced",
    profiles: ["performance", "balanced", "power-saver"],
    degraded: "lap-detected",
  });
  assert.deepEqual(parsePowerProfiles(""), { active: null, profiles: [], degraded: null });
});

test("parseCanAnswer reads busctl's logind answer", () => {
  assert.equal(parseCanAnswer('s "no"\n'), false);
  assert.equal(parseCanAnswer('s "yes"\n'), true);
  assert.equal(parseCanAnswer('s "challenge"\n'), true);
  assert.equal(parseCanAnswer(""), false);
});

test("parseDelay accepts minutes, units and clock times", () => {
  const now = new Date(2026, 10, 4, 22, 30, 0);
  assert.equal(parseDelay("30", now), 30 * 60_000);
  assert.equal(parseDelay("45m", now), 45 * 60_000);
  assert.equal(parseDelay("in 45 min", now), 45 * 60_000);
  assert.equal(parseDelay("1h", now), 3_600_000);
  assert.equal(parseDelay("1.5h", now), 90 * 60_000);
  assert.equal(parseDelay("1h30m", now), 90 * 60_000);
  assert.equal(parseDelay("1h 30m", now), 90 * 60_000);
  assert.equal(parseDelay("1h30", now), 90 * 60_000);
  assert.equal(parseDelay("2 hours and 5 minutes", now), 125 * 60_000);
  assert.equal(parseDelay("90s", now), 90_000);
  assert.equal(parseDelay("23:15", now), 45 * 60_000);
  assert.equal(parseDelay("at 7:05", now), (8 * 60 + 35) * 60_000);
  // A time that already passed today means tomorrow.
  assert.equal(parseDelay("22:30", now), 24 * 3_600_000);
});

test("parseDelay rejects anything else", () => {
  const now = new Date(2026, 10, 4, 22, 30, 0);
  for (const text of ["", "soon", "1h abc", "25:00", "12:60", "0", "0m", "25h", "5 parsecs", "5 constructor", "-5m"]) {
    assert.equal(parseDelay(text, now), null, text);
  }
});

test("describeDelay shows the span and the clock time", () => {
  const now = new Date(2026, 10, 4, 22, 30, 0);
  assert.equal(describeDelay(45 * 60_000, now), "in 45 min (at 23:15)");
  assert.equal(describeDelay(90 * 60_000, now), "in 1 h 30 min (at 00:00)");
  assert.equal(describeDelay(20_000, now), "in 20 s (at 22:30)");
});

test("batteryReport lists every fact", () => {
  const battery = batteryFromUevent(parseUevent(BAT0), thresholds);
  const report = batteryReport(battery, true, 100);
  assert.match(report, /^97%  ·  Plugged in · not charging/);
  assert.match(report, /Health +102% of design capacity \(57\.0 Wh\) · Good/);
  assert.match(report, /Cycles +9/);
  assert.match(report, /Charge limit +Off \(charges to 100%\)/);
  assert.match(report, /Adapter +Connected · 100 W/);
  assert.match(batteryReport({ ...battery, startThreshold: 75, endThreshold: 80 }, false, null), /Stop at 80%, resume below 75%/);
  assert.match(batteryReport({ ...battery, endThreshold: null }, false, null), /Charge limit +Not supported/);
});
