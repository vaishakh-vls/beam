import { contextBridge, ipcRenderer } from "electron";
import type { BeamApi, ShowPayload } from "../shared/types";

const api: BeamApi = {
  search: (query, view) => ipcRenderer.invoke("beam:search", query, view),
  run: (itemId, actionId) => ipcRenderer.invoke("beam:run", itemId, actionId),
  submitForm: (formId, values) => ipcRenderer.invoke("beam:submit-form", formId, values),
  hide: () => ipcRenderer.send("beam:hide"),
  onShow: (callback) => {
    ipcRenderer.on("beam:show", (_event, payload: ShowPayload) => callback(payload));
  },
};

contextBridge.exposeInMainWorld("beam", api);
