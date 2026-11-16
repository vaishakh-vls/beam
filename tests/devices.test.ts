import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeProximity, earbudsLevels, gigabytes, nearness, parseConnected, parseEarbuds, parseIdeviceInfo, parseUdids, phoneFrom, phoneProblem } from "../src/main/devices.ts";

const hex = (text: string) => text.match(/../g)!.map((byte) => Number.parseInt(byte, 16));
const PAD = "00".repeat(16);

test("decodes an AirPods Pro broadcast with one earbud asleep", () => {
  // Heard on 2026-11-16: the left earbud at 90%, the right and the case not reporting.
  const buds = decodeProximity(hex(`0719010e2022f98f000005${PAD}`));
  assert.deepEqual(buds, { model: "AirPods Pro", single: false, left: 90, right: null, case: null, chargingLeft: false, chargingRight: false, chargingCase: false });
});

test("the sending earbud decides which half is left", () => {
  // Status 0x00: flipped, so the high half (7) is the left earbud. Flags 0b0110: left and case charging.
  const buds = decodeProximity(hex(`0719010f20007864${PAD}`))!;
  assert.equal(buds.model, "AirPods (2nd generation)");
  assert.deepEqual([buds.left, buds.right, buds.case], [70, 80, 40]);
  assert.deepEqual([buds.chargingLeft, buds.chargingRight, buds.chargingCase], [true, false, true]);
  assert.equal(earbudsLevels({ ...buds, address: "", rssi: -50 }), "Left 70% ⚡  ·  Right 80%  ·  Case 40% ⚡");
});

test("headphones have one battery", () => {
  const max = decodeProximity(hex(`0719010a2000059003${PAD}`))!;
  assert.equal(max.model, "AirPods Max");
  assert.equal(max.left, 50);
  assert.equal(earbudsLevels({ ...max, address: "", rssi: -50 }), "Battery 50%");
});

test("other Apple broadcasts and unknown models", () => {
  assert.equal(decodeProximity(hex("1005031c8a2b3c")), null);
  // "Find My" pairing mode shares the type but not the length.
  assert.equal(decodeProximity(hex("0711062589ca3c8eb2ee95a52d464bb5de1736")), null);
  assert.equal(decodeProximity(hex(`071901ff2022a9b5${PAD}`))!.model, "AirPods or Beats");
});

// gdbus output from BlueZ 5.72, trimmed: two AirPods, an iPhone's own broadcast, and one not heard in this scan.
const OBJECTS = `({objectpath '/org/bluez': {'org.bluez.AgentManager1': @a{sv} {}}, '/org/bluez/hci0': {'org.bluez.Adapter1': {'Address': <'9C:97:1B:E3:79:1F'>, 'Powered': <true>}}, '/org/bluez/hci0/dev_5A_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'5A:11:22:33:44:55'>, 'AddressType': <'random'>, 'Alias': <'5A-11-22-33-44-55'>, 'RSSI': <int16 -75>, 'ManufacturerData': <{uint16 76: <[byte 0x07, 0x19, 0x01, 0x0a, 0x20, 0x00, 0x05, 0x90, 0x03, 0x10, 0x08, 0xf2]>}>}}, '/org/bluez/hci0/dev_6B_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'6b:11:22:33:44:55'>, 'RSSI': <int16 -52>, 'ManufacturerData': <{uint16 76: <[byte 0x07, 0x19, 0x01, 0x0e, 0x20, 0x22, 0xf9, 0x8f, 0x00, 0x00, 0x05]>}>}}, '/org/bluez/hci0/dev_7C_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'7C:11:22:33:44:55'>, 'RSSI': <int16 -40>, 'ManufacturerData': <{uint16 76: <[byte 0x10, 0x05, 0x03, 0x1c, 0x8a, 0x2b, 0x3c]>}>}}, '/org/bluez/hci0/dev_8D_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'8D:11:22:33:44:55'>, 'ManufacturerData': <{uint16 76: <[byte 0x07, 0x19, 0x01, 0x0e, 0x20, 0x22, 0xf9, 0x8f, 0x00, 0x00, 0x05]>}>}}},)`;

test("finds the earbuds heard in the scan, nearest first", () => {
  const buds = parseEarbuds(OBJECTS);
  assert.deepEqual(buds.map((b) => [b.address, b.model, b.rssi]), [
    ["6B:11:22:33:44:55", "AirPods Pro", -52],
    ["5A:11:22:33:44:55", "AirPods Max", -75],
  ]);
  assert.deepEqual(parseEarbuds("()"), []);
});

test("nearness from signal strength", () => {
  assert.equal(nearness(-50), "Next to you");
  assert.equal(nearness(-65), "Nearby");
  assert.equal(nearness(-78), "Farther away");
});

test("reads idevice_id and ideviceinfo", () => {
  assert.deepEqual(parseUdids("00008110-000A1D2E3C44801E\n\nERROR: Unable to retrieve device list!\n"), ["00008110-000A1D2E3C44801E"]);
  const info = parseIdeviceInfo("DeviceClass: iPhone\nDeviceName: Sam's iPhone\nProductType: iPhone15,2\nProductVersion: 18.1\n");
  const battery = parseIdeviceInfo("BatteryCurrentCapacity: 76\nBatteryIsCharging: true\nExternalConnected: true\n");
  const disk = parseIdeviceInfo("TotalDataAvailable: 51234567890\nTotalDataCapacity: 127989493760\n");
  assert.deepEqual(phoneFrom("u1", info, battery, disk), {
    udid: "u1",
    name: "Sam's iPhone",
    kind: "iPhone",
    version: "18.1",
    battery: 76,
    charging: true,
    free: 51234567890,
    capacity: 127989493760,
  });
  const bare = phoneFrom("u2", { ProductType: "iPad13,1" }, {}, {});
  assert.deepEqual([bare.name, bare.kind, bare.battery, bare.free], ["iPad", "iPad", null, null]);
  assert.equal(gigabytes(51234567890), "51.2 GB");
  assert.equal(gigabytes(127989493760), "128 GB");
});

test("says what to do when the phone will not answer", () => {
  assert.match(phoneProblem("ERROR: Could not connect to lockdownd: Password protected (-17)"), /Unlock/);
  assert.match(phoneProblem("ERROR: Could not connect to lockdownd: Pairing dialog response pending (-19)"), /Tap Trust/);
  assert.match(phoneProblem("ERROR: Could not connect to lockdownd: Invalid HostID (-21)"), /pair/);
  assert.match(phoneProblem("something else"), /plug it in again/);
});

test("lists the devices connected to the laptop, with battery where reported", () => {
  const objects = `({'/org/bluez/hci0': {'org.bluez.Adapter1': {'Powered': <true>}}, '/org/bluez/hci0/dev_AA_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'AA:11:22:33:44:55'>, 'Name': <'MX Master 3S'>, 'Alias': <"Sam's Mouse">, 'Icon': <'input-mouse'>, 'Paired': <true>, 'Connected': <true>}, 'org.bluez.Battery1': {'Percentage': <byte 0x50>, 'Source': <'HID'>}}, '/org/bluez/hci0/dev_AA_11_22_33_44_55/service000a': {'org.bluez.GattService1': {'Primary': <true>}}, '/org/bluez/hci0/dev_BB_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'BB:11:22:33:44:55'>, 'Alias': <'Keys'>, 'Icon': <'input-keyboard'>, 'Connected': <true>}}, '/org/bluez/hci0/dev_CC_11_22_33_44_55': {'org.bluez.Device1': {'Address': <'CC:11:22:33:44:55'>, 'Alias': <'Old Speaker'>, 'Connected': <false>}}},)`;
  assert.deepEqual(parseConnected(objects), [
    { address: "BB:11:22:33:44:55", name: "Keys", icon: "input-keyboard", battery: null },
    { address: "AA:11:22:33:44:55", name: "Sam's Mouse", icon: "input-mouse", battery: 80 },
  ]);
  assert.deepEqual(parseConnected(OBJECTS), []);
});
