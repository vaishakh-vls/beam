// Where Beam's window opens: on the display under the pointer. No Electron
// here, so it can be tested.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Reads gdbus's reply to the helper's Pointer method, "(1234, 567)"; null if it isn't one. */
export function parsePointerReply(stdout: string): Point | null {
  const match = stdout.match(/^\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*$/);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

/** Beam's window in a work area: centred across, a fifth of the way down. */
export function launcherBounds(workArea: Rect, width: number, height: number): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.2),
    width,
    height,
  };
}
