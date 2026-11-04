import assert from "node:assert/strict";
import { test } from "node:test";
import {
  networkKind,
  nmcliError,
  parseAddedUuid,
  parseIpv4,
  parseNetworks,
  parseProfileSsids,
  parseRadio,
  parseWifiDevice,
  parseWifiProfiles,
  passwdFileLine,
  passwordProblem,
  signalBars,
  splitTerse,
} from "../src/main/wifi.ts";

// Real output from nmcli 1.46 on Ubuntu 24.04, trimmed.
const WIFI_LIST = [
  " :97:WPA2:Speedy_Virallens",
  " :94:WPA2:BHIVE Wifi-Zone",
  " :94:WPA2:BHIVE HODs",
  "*:80:WPA2:Speedy_Virallens",
  " :70:WPA2:DIRECT-D2-EPSON-DEF890",
  " :64:WPA1 WPA2:Airtel_Valamm.Ai",
  " :62:WPA2:BHIVE High-Speed",
  " :57:WPA2:BHIVE High-Speed",
  " :45:WPA2:Keka Wifi-Zone",
  " :30::",
  "",
].join("\n");

const DEVICE_STATUS = [
  "wlp0s20f3:wifi:connected:Speedy_Virallens",
  "br-26c376f5aca3:bridge:connected (externally):br-26c376f5aca3",
  "docker0:bridge:connected (externally):docker0",
  "lo:loopback:connected (externally):lo",
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:",
  "enp0s31f6:ethernet:unavailable:",
  "",
].join("\n");

const CONNECTIONS = [
  "Speedy_Virallens:f18771c2-ab38-488f-b996-92162541936b:802-11-wireless:1793764328",
  "br-26c376f5aca3:0e90e3b8-f2aa-4f84-93f2-e8ec0b0dc071:bridge:1793343470",
  "301_5G:10b6481f-f75e-45d2-93da-bda6648216b1:802-11-wireless:1792592134",
  "BHIVE High-Speed:c20d9340-aa62-47a1-a276-03bf6600ab90:802-11-wireless:0",
  "Not an iPhone:ed16d3d0-256a-4c5a-b704-0af67ea1e531:802-11-wireless:1792388389",
  "Wired connection 1:be363cd4-33c4-3a42-bb0d-23c944f2a486:802-3-ethernet:0",
  "",
].join("\n");

const PROFILE_SSIDS = [
  "connection.uuid:ed16d3d0-256a-4c5a-b704-0af67ea1e531",
  "802-11-wireless.ssid:Not an iPhone",
  "",
  "connection.uuid:c20d9340-aa62-47a1-a276-03bf6600ab90",
  "802-11-wireless.ssid:BHIVE High-Speed",
  "",
].join("\n");

test("terse lines split on unescaped colons", () => {
  assert.deepEqual(splitTerse(" :Speedy:EC\\:FC\\:C6\\:39\\:9D\\:03:97"), [" ", "Speedy", "EC:FC:C6:39:9D:03", "97"]);
  assert.deepEqual(splitTerse("*:80:WPA2:Cafe\\:Guest"), ["*", "80", "WPA2", "Cafe:Guest"]);
  assert.deepEqual(splitTerse("a\\\\b:c"), ["a\\b", "c"]);
  assert.deepEqual(splitTerse("p2p-dev:wifi-p2p:disconnected:"), ["p2p-dev", "wifi-p2p", "disconnected", ""]);
});

test("networks are deduped by SSID, the one in use first, then by signal", () => {
  const networks = parseNetworks(WIFI_LIST);
  assert.deepEqual(
    networks.map((n) => n.ssid),
    ["Speedy_Virallens", "BHIVE HODs", "BHIVE Wifi-Zone", "DIRECT-D2-EPSON-DEF890", "Airtel_Valamm.Ai", "BHIVE High-Speed", "Keka Wifi-Zone"],
  );
  // The access point in use, not the strongest one with the same name.
  assert.deepEqual(networks[0], { ssid: "Speedy_Virallens", signal: 80, security: "WPA2", inUse: true });
  assert.equal(networks.find((n) => n.ssid === "BHIVE High-Speed")?.signal, 62);
  assert.equal(networks.find((n) => n.ssid === "Airtel_Valamm.Ai")?.security, "WPA1 WPA2");
});

test("escaped SSIDs and open networks", () => {
  const networks = parseNetworks(" :50::Free Wi-Fi\n :40:--:Lobby\n*:70:WPA3:Cafe\\:Guest\n");
  assert.deepEqual(networks, [
    { ssid: "Cafe:Guest", signal: 70, security: "WPA3", inUse: true },
    { ssid: "Free Wi-Fi", signal: 50, security: "", inUse: false },
    { ssid: "Lobby", signal: 40, security: "", inUse: false },
  ]);
});

test("Wi-Fi device, radio and address", () => {
  assert.deepEqual(parseWifiDevice(DEVICE_STATUS), { name: "wlp0s20f3", state: "connected", connection: "Speedy_Virallens" });
  assert.equal(parseWifiDevice("enp0s31f6:ethernet:unavailable:\n"), null);
  assert.deepEqual(parseRadio("enabled:enabled\n"), { hardware: true, enabled: true });
  assert.deepEqual(parseRadio("enabled:disabled\n"), { hardware: true, enabled: false });
  assert.equal(parseIpv4("IP4.ADDRESS[1]:10.60.0.70/24\n"), "10.60.0.70");
  assert.equal(parseIpv4(""), null);
});

test("saved Wi-Fi profiles, newest first, and their SSIDs", () => {
  const profiles = parseWifiProfiles(CONNECTIONS);
  assert.deepEqual(
    profiles.map((p) => p.name),
    ["Speedy_Virallens", "301_5G", "Not an iPhone", "BHIVE High-Speed"],
  );
  assert.equal(profiles[0].uuid, "f18771c2-ab38-488f-b996-92162541936b");
  const ssids = parseProfileSsids(PROFILE_SSIDS);
  assert.equal(ssids.get("ed16d3d0-256a-4c5a-b704-0af67ea1e531"), "Not an iPhone");
  assert.equal(ssids.get("c20d9340-aa62-47a1-a276-03bf6600ab90"), "BHIVE High-Speed");
  assert.equal(parseProfileSsids("connection.uuid:x\n802-11-wireless.ssid:a:b\n").get("x"), "a:b");
});

test("how each kind of network is joined", () => {
  assert.equal(networkKind(""), "open");
  assert.equal(networkKind("OWE"), "open");
  assert.equal(networkKind("WPA2"), "wpa-psk");
  assert.equal(networkKind("WPA1 WPA2"), "wpa-psk");
  assert.equal(networkKind("WPA2 WPA3"), "wpa-psk");
  assert.equal(networkKind("WPA3"), "sae");
  assert.equal(networkKind("WPA2 802.1X"), "unsupported");
  assert.equal(networkKind("WEP"), "unsupported");
});

test("password checks", () => {
  assert.equal(passwordProblem("hunter22", "wpa-psk"), null);
  assert.equal(passwordProblem("f".repeat(64), "wpa-psk"), null);
  assert.match(passwordProblem("short", "wpa-psk") ?? "", /8 to 63/);
  assert.match(passwordProblem("", "sae") ?? "", /Enter/);
  assert.equal(passwordProblem("short", "sae"), null);
});

test("passwd-file lines keep backslashes and edge spaces", () => {
  assert.equal(passwdFileLine("secret12345"), "802-11-wireless-security.psk:secret12345\n");
  assert.equal(passwdFileLine("a:b#c=d"), "802-11-wireless-security.psk:a:b#c=d\n");
  assert.equal(passwdFileLine("back\\slash"), "802-11-wireless-security.psk:back\\\\slash\n");
  assert.equal(passwdFileLine("  two sides "), "802-11-wireless-security.psk:\\040\\040two sides\\040\n");
});

test("added profile UUID, signal bars and nmcli errors", () => {
  assert.equal(
    parseAddedUuid("Connection 'Cafe' (1f6f2c1e-6d8e-4a43-9f2e-2b6a8c5d7e10) successfully added.\n"),
    "1f6f2c1e-6d8e-4a43-9f2e-2b6a8c5d7e10",
  );
  assert.equal(signalBars(97), "▂▄▆█");
  assert.equal(signalBars(62), "▂▄▆_");
  assert.equal(signalBars(0), "____");
  assert.equal(
    nmcliError(
      "Error: Connection activation failed: Secrets were required, but not provided\nHint: use 'journalctl -xe NM_CONNECTION=x + NM_DEVICE=wlp0s20f3' to get more details.\n",
    ),
    "Secrets were required, but not provided",
  );
  assert.equal(nmcliError("Error: 00000000 - no such connection profile.\n"), "00000000 - no such connection profile.");
});
