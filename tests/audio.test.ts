import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseLevel,
  parseVolume,
  parseVolumeCommand,
  parseWpctlStatus,
  percent,
  splitName,
  volumeIcon,
} from "../src/main/audio.ts";

// Real `wpctl status` from WirePlumber 0.4.17 on Ubuntu 24.04, with the client list trimmed.
// Trailing spaces matter: wpctl pads names and leaves "│  " on blank tree lines.
const STATUS = `PipeWire 'pipewire-0' [1.0.5, vaishakh@vaishakh-ThinkPad-P14s-Gen-6, cookie:416682180]
 └─ Clients:
        32. pipewire                            [1.0.5, vaishakh@vaishakh-ThinkPad-P14s-Gen-6, pid:380737]
        76. gnome-shell                         [1.0.5, vaishakh@vaishakh-ThinkPad-P14s-Gen-6, pid:381108]

Audio
 ├─ Devices:
 │      50. sof-hda-dsp                         [alsa]
 │  
 ├─ Sinks:
 │      55. sof-hda-dsp HDMI / DisplayPort 3 Output [vol: 1.00]
 │      56. sof-hda-dsp HDMI / DisplayPort 2 Output [vol: 1.00]
 │      57. sof-hda-dsp HDMI / DisplayPort 1 Output [vol: 1.00]
 │  *   58. sof-hda-dsp Speaker + Headphones    [vol: 0.00 MUTED]
 │  
 ├─ Sink endpoints:
 │  
 ├─ Sources:
 │      59. sof-hda-dsp Headphones Stereo Microphone [vol: 1.00]
 │  *   60. sof-hda-dsp Digital Microphone      [vol: 0.90]
 │  
 ├─ Source endpoints:
 │  
 └─ Streams:

Video
 ├─ Devices:
 │      43. Integrated RGB Camera               [v4l2]
 │      44. Integrated RGB Camera               [v4l2]
 │      45. Integrated RGB Camera               [v4l2]
 │      46. Integrated RGB Camera               [v4l2]
 │  
 ├─ Sinks:
 │  
 ├─ Sink endpoints:
 │  
 ├─ Sources:
 │  *   51. Integrated RGB Camera (V4L2)       
 │      53. Integrated RGB Camera (V4L2)       
 │  
 ├─ Source endpoints:
 │  
 └─ Streams:

Settings
 └─ Default Configured Node Names:
`;

// The same tree while Bluetooth headphones play: sinks named after the
// device, and streams nested under the Streams heading.
const PLAYING = `Audio
 ├─ Devices:
 │      50. sof-hda-dsp                         [alsa]
 │      91. WH-1000XM4                          [bluez5]
 │  
 ├─ Sinks:
 │      58. sof-hda-dsp Speaker + Headphones    [vol: 0.40]
 │  *   92. WH-1000XM4                          [vol: 0.45]
 │  
 ├─ Sink endpoints:
 │  
 ├─ Sources:
 │  *   60. sof-hda-dsp Digital Microphone      [vol: 0.90 MUTED]
 │  
 ├─ Source endpoints:
 │  
 └─ Streams:
        86. Google Chrome                                               
             87. output_FL       > WH-1000XM4:playback_FL	[active]
             88. output_FR       > WH-1000XM4:playback_FR	[active]

Video
`;

test("sinks and sources from the real wpctl status", () => {
  const status = parseWpctlStatus(STATUS);
  assert.deepEqual(status.devices, ["sof-hda-dsp"]);
  assert.deepEqual(status.sinks, [
    { id: 55, name: "sof-hda-dsp HDMI / DisplayPort 3 Output", isDefault: false, volume: 1, muted: false },
    { id: 56, name: "sof-hda-dsp HDMI / DisplayPort 2 Output", isDefault: false, volume: 1, muted: false },
    { id: 57, name: "sof-hda-dsp HDMI / DisplayPort 1 Output", isDefault: false, volume: 1, muted: false },
    { id: 58, name: "sof-hda-dsp Speaker + Headphones", isDefault: true, volume: 0, muted: true },
  ]);
  assert.deepEqual(status.sources, [
    { id: 59, name: "sof-hda-dsp Headphones Stereo Microphone", isDefault: false, volume: 1, muted: false },
    { id: 60, name: "sof-hda-dsp Digital Microphone", isDefault: true, volume: 0.9, muted: false },
  ]);
});

test("Bluetooth sinks and streams", () => {
  const status = parseWpctlStatus(PLAYING);
  assert.deepEqual(status.devices, ["sof-hda-dsp", "WH-1000XM4"]);
  assert.deepEqual(
    status.sinks.map((s) => [s.id, s.name, s.isDefault, s.volume]),
    [
      [58, "sof-hda-dsp Speaker + Headphones", false, 0.4],
      [92, "WH-1000XM4", true, 0.45],
    ],
  );
  assert.equal(status.sources[0].muted, true);
  assert.equal(status.sinks.length + status.sources.length, 3);
  assert.deepEqual(parseWpctlStatus(""), { devices: [], sinks: [], sources: [] });
});

test("get-volume", () => {
  // Real output for the muted default sink and the default source.
  assert.deepEqual(parseVolume("Volume: 0.00 [MUTED]\n"), { volume: 0, muted: true });
  assert.deepEqual(parseVolume("Volume: 0.90\n"), { volume: 0.9, muted: false });
  assert.equal(parseVolume("Object '@DEFAULT_AUDIO_SINK@' not found\n"), null);
  assert.equal(percent(0.45), 45);
  assert.equal(percent(0.57), 57);
});

test("typed levels in the Audio view", () => {
  assert.equal(parseLevel("40"), 40);
  assert.equal(parseLevel("40%"), 40);
  assert.equal(parseLevel(" 0 "), 0);
  assert.equal(parseLevel("100 %"), 100);
  assert.equal(parseLevel("150"), null);
  assert.equal(parseLevel("speaker"), null);
  assert.equal(parseLevel("4o"), null);
});

test("volume queries in root search", () => {
  assert.equal(parseVolumeCommand("volume 40"), 40);
  assert.equal(parseVolumeCommand("vol 40%"), 40);
  assert.equal(parseVolumeCommand("Volume 0"), 0);
  assert.equal(parseVolumeCommand("set volume to 75"), 75);
  assert.equal(parseVolumeCommand("volume"), null);
  assert.equal(parseVolumeCommand("volume up"), null);
  assert.equal(parseVolumeCommand("volume 101"), null);
  assert.equal(parseVolumeCommand("volumes 40"), null);
  assert.equal(parseVolumeCommand("40"), null);
});

test("names without the card prefix, and icons", () => {
  const devices = ["sof-hda-dsp", "WH-1000XM4"];
  assert.deepEqual(splitName("sof-hda-dsp Speaker + Headphones", devices), { title: "Speaker + Headphones", device: "sof-hda-dsp" });
  assert.deepEqual(splitName("WH-1000XM4", devices), { title: "WH-1000XM4", device: "" });
  assert.deepEqual(splitName("Some Other Sink", devices), { title: "Some Other Sink", device: "" });
  assert.equal(volumeIcon(0, false), "🔇");
  assert.equal(volumeIcon(80, true), "🔇");
  assert.equal(volumeIcon(20, false), "🔈");
  assert.equal(volumeIcon(50, false), "🔉");
  assert.equal(volumeIcon(100, false), "🔊");
});
