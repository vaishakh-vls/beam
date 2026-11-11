// Chromium and V8 settings that keep Beam light. main.ts imports this first,
// so it runs before anything else in the main process.
import v8 from "node:v8";
import { app } from "electron";

// Favour memory over speed. Beam's JavaScript is light and it sits in the
// background all day: this saves about 20 MB with searches no slower.
const JS_FLAGS = "--optimize-for-size";
v8.setFlagsFromString(JS_FLAGS);
app.commandLine.appendSwitch("js-flags", JS_FLAGS);

// Run Chromium's network service inside the main process rather than as a
// process of its own: one process and about 12 MB fewer. Beam's own requests
// go through Node; the service only loads images shown in the window.
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
