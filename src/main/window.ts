// Lets providers bring Beam's window back, e.g. after a native file chooser
// closes. main.ts owns the window and registers how to show it.

import type { ShowPayload } from "../shared/types";

let opener: ((payload: ShowPayload) => void) | null = null;

export function setWindowOpener(open: (payload: ShowPayload) => void): void {
  opener = open;
}

/** Shows Beam on the given view; does nothing before the window exists. */
export function showBeam(payload: ShowPayload): void {
  opener?.(payload);
}
