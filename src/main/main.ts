import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, net, protocol, screen, Tray } from "electron";
import { parseRunArg } from "./cli";
import { config, loadConfig } from "./config";
import { launcherBounds } from "./displays";
import { submitForm } from "./forms";
import { ICON_SCHEME, iconFileFromUrl } from "./icons";
import { syncKeybinds } from "./keybinds";
import { launchApp, loadApps } from "./providers/apps";
import { loadPanels } from "./providers/settings";
import { stopCaffeinate } from "./providers/caffeinate";
import { stopConversions } from "./providers/convert";
import { startClipboardWatcher } from "./providers/clipboard";
import { startFanGuard } from "./providers/fans";
import { refreshRates } from "./providers/currency";
import { rebuildFileIndex, startFileIndexer } from "./providers/files";
import { runQuicklink } from "./providers/quicklinks";
import { runScriptByName } from "./providers/scripts";
import { runSnippet } from "./providers/snippets";
import { startBrowserBridge, stopBrowserBridge } from "./providers/tabs";
import { refreshTheme, startThemes } from "./providers/themes";
import { announceFirstRun, firstRunView } from "./providers/welcome";
import { applyWindowAction, ensureWindowExtension, pointerPosition } from "./providers/windows";
import { launchableEntries, runAction, search, type SearchContext } from "./search";
import { closeSocket, listenForRefs, socketPath } from "./socket";
import { notify } from "./system";
import { recordUse } from "./usage";
import { setWindowOpener } from "./window";
import type { RunResult, ShowPayload, View } from "../shared/types";

const WIDTH = 760;
const HEIGHT = 480;
const isDev = !app.isPackaged;
/** Dev-only: keep the window open on blur and leave GNOME shortcuts alone. */
const testMode = isDev && Boolean(process.env.BEAM_TEST_MODE);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

protocol.registerSchemesAsPrivileged([
  { scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** The command GNOME hotkeys run to reach this instance: the socket client when packaged. */
function launcherCommand(): string[] {
  if (isDev) return [process.execPath, app.getAppPath()];
  const client = path.join(process.resourcesPath, "beam-run");
  return socketPath() && fs.existsSync(client) ? [client] : [process.execPath];
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "Beam",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (isDev && process.env.BEAM_DEV_URL) void window.loadURL(process.env.BEAM_DEV_URL);
  else void window.loadFile(path.join(__dirname, "../renderer/index.html"));

  window.on("blur", () => {
    if (!testMode && !window.webContents.isDevToolsOpened()) window.hide();
  });
  return window;
}

async function showWindow(payload: ShowPayload): Promise<void> {
  if (!win) return;
  // The first time the window opens, the tour stands in for the empty search.
  if (payload.view === "root" && !payload.result) payload = { view: firstRunView() ?? "root" };
  // Open on the display under the pointer; GNOME Shell knows where it is.
  const pointer = screen.getAllDisplays().length > 1 ? await pointerPosition() : null;
  if (!win) return;
  const { workArea } = screen.getDisplayNearestPoint(pointer ?? screen.getCursorScreenPoint());
  win.setBounds(launcherBounds(workArea, WIDTH, HEIGHT));
  refreshTheme();
  win.webContents.send("beam:show", payload);
  win.show();
  win.focus();
}

function hideWindow(): void {
  win?.hide();
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) hideWindow();
  else showWindow({ view: "root" });
}

function handleResult(result: RunResult | null, ref: string): void {
  if (!result) {
    notify("Beam", `Command not found: ${ref}`);
    return;
  }
  if (result.type === "view") showWindow({ view: result.view });
  else if (result.type === "form" || result.type === "output" || result.type === "error" || result.type === "search") {
    showWindow({ view: "root", result });
  }
}

/** Runs a command by its ref, from a hotkey or `beam --run <ref>`. */
async function runRef(ref: string): Promise<void> {
  if (ref === "toggle") return toggleWindow();
  const [kind, ...rest] = ref.split(":");
  const id = rest.join(":");
  if (kind === "view") return showWindow({ view: id as View });
  recordUse(ref);
  switch (kind) {
    case "app":
      if (!launchApp(id)) notify("Beam", `App not found: ${id}`);
      return;
    case "window":
      // Hotkeys fire while the target window is still focused.
      return applyWindowAction(id);
    case "snippet":
      if (!runSnippet(id, hideWindow)) notify("Beam", `Snippet not found: ${id}`);
      return;
    case "quicklink":
      return handleResult(runQuicklink(id), ref);
    case "script":
      return handleResult((await runScriptByName(id)) ?? null, ref);
    case "cmd": {
      const entry = launchableEntries(context).find((e) => e.ref === ref);
      return handleResult(entry ? await entry.actions[0].run() : null, ref);
    }
    default:
      notify("Beam", `Unknown command: ${ref}`);
  }
}

async function registerHotkeys(): Promise<void> {
  if (testMode) return;
  const { warnings } = await syncKeybinds(launcherCommand(), (ref) => void runRef(ref));
  for (const warning of warnings) console.warn(`beam: ${warning}`);
}

const context: SearchContext = {
  hide: hideWindow,
  reload: () => {
    loadConfig();
    loadApps(true);
    loadPanels(true);
    void rebuildFileIndex();
    void registerHotkeys();
  },
  hotkeysChanged: () => void registerHotkeys(),
};

function createTray(): void {
  if (!config().trayIcon) return;
  const iconPath = path.join(__dirname, "../../assets/tray.png");
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(iconPath);
  tray.setToolTip("Beam");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Beam", click: () => showWindow({ view: "root" }) },
      { label: "Clipboard History", click: () => showWindow({ view: "clipboard" }) },
      { label: "Search Snippets", click: () => showWindow({ view: "snippets" }) },
      { type: "separator" },
      { label: "Reload", click: () => context.reload() },
      { label: "Quit Beam", click: () => app.quit() },
    ]),
  );
}

/** Starts Beam at login so hotkeys respond instantly (packaged builds only). */
function ensureAutostart(): void {
  if (isDev) return;
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
  const file = path.join(dir, "beam.desktop");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Beam",
      "Comment=Start Beam in the background",
      `Exec="${process.execPath}" --hidden`,
      "Icon=beam",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
}

function registerIpc(): void {
  ipcMain.handle("beam:search", (_event, query: string, view: View) => search(query, view, context));
  ipcMain.handle("beam:run", (_event, itemId: string, actionId: string, args?: Record<string, string>) =>
    runAction(itemId, actionId, args),
  );
  ipcMain.handle("beam:submit-form", (_event, formId: string, values: Record<string, string>) =>
    submitForm(formId, values),
  );
  ipcMain.on("beam:hide", () => hideWindow());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const ref = parseRunArg(argv);
    if (ref) void runRef(ref);
    else if (!argv.includes("--hidden")) showWindow({ view: "root" });
  });

  app.whenReady().then(async () => {
    listenForRefs((ref) => void runRef(ref));
    protocol.handle(ICON_SCHEME, (request) => {
      const file = iconFileFromUrl(request.url);
      if (!file) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    loadConfig();
    registerIpc();
    win = createWindow();
    startThemes(() => win);
    setWindowOpener(showWindow);
    const loaded = new Promise<void>((resolve) => win!.webContents.once("did-finish-load", () => resolve()));
    createTray();
    ensureAutostart();
    startClipboardWatcher();
    startFileIndexer();
    void refreshRates();
    startFanGuard();
    startBrowserBridge();
    loadApps();
    await registerHotkeys();
    if (!testMode) void ensureWindowExtension();

    const ref = parseRunArg(process.argv);
    await loaded;
    if (ref) void runRef(ref);
    else if (!process.argv.includes("--hidden")) showWindow({ view: "root" });
    else announceFirstRun();
  });

  app.on("will-quit", () => {
    closeSocket();
    stopCaffeinate();
    stopConversions();
    stopBrowserBridge();
  });

  // Beam lives in the background; closing the window must not quit it.
  app.on("window-all-closed", () => undefined);
}
