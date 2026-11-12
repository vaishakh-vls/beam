// Puts the clipboard events from Beam's GNOME helper in order. The helper
// sends each one on its own connection to Beam's socket, so two sent close
// together (as when GNOME turns extensions off and on again) can arrive the
// wrong way round, and a late "stopped" would leave Beam polling for the rest
// of the session. Since helper version 8 each event carries the helper's
// monotonic clock ("watching:1234567"), and one older than the last is
// dropped. No Electron here, so it can be tested.

export interface ClipboardEvent {
  event: string;
  /** The helper's monotonic time in microseconds, or null from an older helper or Beam itself. */
  at: number | null;
}

export function parseClipboardEvent(id: string): ClipboardEvent {
  const [event, at] = id.split(":");
  const time = Number(at);
  return { event, at: at !== undefined && at !== "" && Number.isFinite(time) ? time : null };
}

export class ClipboardEventOrder {
  private last = -1;

  /** Whether a timed event has come from the helper, so it is known to be keeping Beam informed. */
  get heardFromHelper(): boolean {
    return this.last >= 0;
  }

  /**
   * Whether to act on an event. An untimed one (an older helper, or Beam's own
   * check at startup) counts only until the helper has sent a timed one.
   */
  accept({ at }: ClipboardEvent): boolean {
    if (at === null) return this.last < 0;
    if (at < this.last) return false;
    this.last = at;
    return true;
  }
}
