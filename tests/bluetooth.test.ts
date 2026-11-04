import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bluetoothError,
  bluetoothFailed,
  deviceType,
  hasRealName,
  parseAirplane,
  parseController,
  parseDeviceInfo,
  parseDeviceList,
  sortDevices,
} from "../src/main/bluetooth.ts";

// Real output from bluetoothctl 5.72 on Ubuntu 24.04, trimmed.
const SHOW = `Controller 9C:97:1B:E3:79:1F (public)
\tManufacturer: 0x0002 (2)
\tVersion: 0x0d (13)
\tName: vaishakh-ThinkPad-P14s-Gen-6
\tAlias: vaishakh-ThinkPad-P14s-Gen-6
\tClass: 0x006c010c (7078156)
\tPowered: yes
\tDiscoverable: no
\tDiscoverableTimeout: 0x000000b4 (180)
\tPairable: no
\tUUID: A/V Remote Control        (0000110e-0000-1000-8000-00805f9b34fb)
\tUUID: Handsfree Audio Gateway   (0000111f-0000-1000-8000-00805f9b34fb)
\tModalias: usb:v1D6Bp0246d0548
\tDiscovering: no
\tRoles: central
\tRoles: peripheral
Advertising Features:
\tActiveInstances: 0x00 (0)
\tSupportedInstances: 0x0c (12)
`;

// Real output from gsd-rfkill on GNOME 46.
const RFKILL =
  "({'AirplaneMode': <false>, 'HardwareAirplaneMode': <false>, 'HasAirplaneMode': <true>, 'ShouldShowAirplaneMode': <true>, " +
  "'BluetoothAirplaneMode': <false>, 'BluetoothHardwareAirplaneMode': <false>, 'BluetoothHasAirplaneMode': <true>, " +
  "'WwanAirplaneMode': <false>, 'WwanHardwareAirplaneMode': <false>, 'WwanHasAirplaneMode': <false>},)\n";

// No devices are paired on the machine these tests were written on, so the
// device output follows BlueZ 5.72's format.
const HEADSET = `Device 88:C9:E8:12:34:56 (public)
\tName: WH-1000XM4
\tAlias: WH-1000XM4
\tClass: 0x00240404 (2360324)
\tIcon: audio-headset
\tPaired: yes
\tBonded: yes
\tTrusted: yes
\tBlocked: no
\tConnected: yes
\tWakeAllowed: no
\tLegacyPairing: no
\tUUID: Vendor specific           (00000000-deca-fade-deca-deafdecacaff)
\tUUID: Headset                   (00001108-0000-1000-8000-00805f9b34fb)
\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)
\tModalias: usb:v054Cp0D58d0451
\tBattery Percentage: 0x46 (70)
`;

const SPEAKER = `Device 5C:E9:1E:11:22:33 (public)
\tName: JBL Flip 5
\tAlias: Kitchen Speaker
\tClass: 0x00240414 (2360340)
\tIcon: audio-card
\tPaired: no
\tBonded: no
\tTrusted: no
\tBlocked: no
\tConnected: no
\tLegacyPairing: no
\tRSSI: 0xffffffb5 (-75)
\tManufacturerData.Key: 0x0057 (87)
\tManufacturerData.Value:
  01 02 03 04                                      ....
`;

test("controller state", () => {
  assert.deepEqual(parseController(SHOW), { present: true, powered: true, discovering: false });
  assert.deepEqual(parseController(SHOW.replace("Powered: yes", "Powered: no")), {
    present: true,
    powered: false,
    discovering: false,
  });
  assert.deepEqual(parseController("No default controller available\n"), { present: false, powered: false, discovering: false });
});

test("GNOME's Bluetooth switch", () => {
  assert.deepEqual(parseAirplane(RFKILL), { blocked: false, hardware: false });
  assert.deepEqual(parseAirplane(RFKILL.replace("'BluetoothAirplaneMode': <false>", "'BluetoothAirplaneMode': <true>")), {
    blocked: true,
    hardware: false,
  });
  assert.deepEqual(parseAirplane(""), { blocked: null, hardware: null });
});

test("device lists", () => {
  const list = parseDeviceList(
    "Device 88:C9:E8:12:34:56 WH-1000XM4\nDevice 4C:87:5D:01:02:03 4C-87-5D-01-02-03\nDevice e4:7f:b2:aa:bb:cc MX Master 3\n",
  );
  assert.deepEqual(list, [
    { address: "88:C9:E8:12:34:56", name: "WH-1000XM4" },
    { address: "4C:87:5D:01:02:03", name: "4C-87-5D-01-02-03" },
    { address: "E4:7F:B2:AA:BB:CC", name: "MX Master 3" },
  ]);
  assert.deepEqual(parseDeviceList("\x1b[0;93m[CHG]\x1b[0m Controller 9C:97:1B:E3:79:1F Discovering: yes\n"), []);
  assert.equal(hasRealName("4C-87-5D-01-02-03", "4C:87:5D:01:02:03"), false);
  assert.equal(hasRealName("", "4C:87:5D:01:02:03"), false);
  assert.equal(hasRealName("MX Master 3", "E4:7F:B2:AA:BB:CC"), true);
});

test("device info", () => {
  assert.deepEqual(parseDeviceInfo(HEADSET), {
    address: "88:C9:E8:12:34:56",
    name: "WH-1000XM4",
    icon: "audio-headset",
    paired: true,
    trusted: true,
    connected: true,
    battery: 70,
  });
  const speaker = parseDeviceInfo(SPEAKER);
  assert.equal(speaker?.name, "Kitchen Speaker");
  assert.equal(speaker?.paired, false);
  assert.equal(speaker?.battery, null);
  assert.equal(parseDeviceInfo("Device 00:11:22:33:44:55 not available\n"), null);
  assert.equal(parseDeviceInfo("Missing device address argument\n"), null);
});

test("device types and order", () => {
  assert.deepEqual(deviceType("audio-headset"), { emoji: "🎧", label: "Headphones" });
  assert.deepEqual(deviceType("audio-headphones"), { emoji: "🎧", label: "Headphones" });
  assert.deepEqual(deviceType("audio-card"), { emoji: "🔊", label: "Audio" });
  assert.deepEqual(deviceType("input-mouse"), { emoji: "🖱️", label: "Mouse" });
  assert.deepEqual(deviceType("input-keyboard"), { emoji: "⌨️", label: "Keyboard" });
  assert.deepEqual(deviceType(""), { emoji: "🔹", label: "Device" });
  const devices = [parseDeviceInfo(SPEAKER)!, parseDeviceInfo(HEADSET)!];
  assert.deepEqual(sortDevices(devices).map((d) => d.name), ["WH-1000XM4", "Kitchen Speaker"]);
});

test("bluetoothctl failures", () => {
  assert.equal(bluetoothFailed(0, "Attempting to connect to 88:C9:E8:12:34:56\nConnection successful\n"), false);
  assert.equal(bluetoothFailed(1, "Device 00:11:22:33:44:55 not available\n"), true);
  assert.equal(bluetoothFailed(0, "Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n"), true);
  assert.match(bluetoothError("Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n"), /didn't respond/);
  assert.match(bluetoothError("Failed to pair: org.bluez.Error.AuthenticationFailed\n"), /Bluetooth Settings/);
  assert.match(bluetoothError("Device 00:11:22:33:44:55 not available\n"), /out of range/);
  assert.match(bluetoothError("Failed to set power on: org.bluez.Error.Blocked\n"), /off/);
  assert.equal(bluetoothError("Failed to remove device: org.bluez.Error.DoesNotExist\n"), "org.bluez.Error.DoesNotExist");
});
