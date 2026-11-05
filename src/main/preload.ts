import { contextBridge, ipcRenderer } from "electron";
import type { BeamApi, ShowPayload } from "../shared/types";
import type { AppliedTheme, BeamThemeApi } from "./themes";

/**
 * A launch that opens the window straight away can send its show before React
 * has mounted and subscribed. It waits here, so the first screen isn't lost.
 */
let showListener: ((payload: ShowPayload) => void) | null = null;
let pendingShow: ShowPayload | null = null;
ipcRenderer.on("beam:show", (_event, payload: ShowPayload) => {
  if (showListener) showListener(payload);
  else pendingShow = payload;
});

const api: BeamApi = {
  search: (query, view) => ipcRenderer.invoke("beam:search", query, view),
  run: (itemId, actionId) => ipcRenderer.invoke("beam:run", itemId, actionId),
  submitForm: (formId, values) => ipcRenderer.invoke("beam:submit-form", formId, values),
  hide: () => ipcRenderer.send("beam:hide"),
  onShow: (callback) => {
    showListener = callback;
    if (pendingShow) callback(pendingShow);
    pendingShow = null;
  },
};

contextBridge.exposeInMainWorld("beam", api);

/** Window colors, applied by src/renderer/theme.ts; separate from BeamApi, which lives in shared/types. */
const themeApi: BeamThemeApi = {
  current: () => ipcRenderer.invoke("beam:get-theme"),
  onChange: (callback) => {
    ipcRenderer.on("beam:theme", (_event, theme: AppliedTheme) => callback(theme));
  },
};

contextBridge.exposeInMainWorld("beamTheme", themeApi);
