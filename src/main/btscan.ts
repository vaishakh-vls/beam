import { runCapture } from "./system";

/**
 * Asks BlueZ to look for devices for a while. BlueZ stops when the caller that
 * asked goes away, so this stays for the whole scan. Not `bluetoothctl
 * --timeout N scan on`: with many devices around, bluetoothctl now and then
 * crashes as it exits, and Ubuntu then shows a crash report.
 */
const SCRIPT = `
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SYSTEM)
objects = bus.call_sync("org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", None, None, 0, 5000, None).unpack()[0]
adapter = sorted(path for path, interfaces in objects.items() if "org.bluez.Adapter1" in interfaces)[0]
def call(method, args=None):
    bus.call_sync("org.bluez", adapter, "org.bluez.Adapter1", method, args, None, 0, 5000, None)
call("SetDiscoveryFilter", GLib.Variant("(a{sv})", ({"Transport": GLib.Variant("s", sys.argv[2])},)))
call("StartDiscovery")
loop = GLib.MainLoop()
GLib.timeout_add_seconds(int(sys.argv[1]), loop.quit)
loop.run()
call("StopDiscovery")
`;

/** Scans for `seconds`; "le" hears only low-energy broadcasts (AirPods), "auto" finds everything. True if the scan ran. */
export async function bluetoothScan(seconds: number, transport: "auto" | "le"): Promise<boolean> {
  const { code } = await runCapture("python3", ["-I", "-c", SCRIPT, String(seconds), transport], { timeoutMs: (seconds + 8) * 1000 });
  return code === 0;
}
