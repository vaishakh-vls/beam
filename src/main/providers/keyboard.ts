import { HIDE, type Entry, type Section, type ViewProvider } from "../entry";
import { LOCK_CHOICES, MAX_LOCK_SECONDS, lockFailure, lockLabel, parseLockReply, parseLockSeconds } from "../keyboard";
import { isGnome, notify, runCapture } from "../system";

const BUS_NAME = "org.virallens.BeamWindows";
const OBJECT_PATH = "/org/virallens/BeamWindows";

/**
 * Asks Beam's GNOME extension to lock the keyboard. Only the shell can
 * swallow shell shortcuts on Wayland; the extension shows its own overlay
 * with a countdown and an Unlock button.
 */
async function lockKeyboard(seconds: number): Promise<void> {
  if (!isGnome()) {
    notify("Clean Keyboard needs GNOME", "It works through Beam's GNOME Shell extension.");
    return;
  }
  const { code, stdout, stderr } = await runCapture(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      BUS_NAME,
      "--object-path",
      OBJECT_PATH,
      "--method",
      `${BUS_NAME}.LockKeyboard`,
      String(seconds),
    ],
    { timeoutMs: 5000 },
  );
  if (code !== 0) {
    if (lockFailure(stderr) === "needs-login") {
      notify(
        "Log out and back in once to finish installing Clean Keyboard",
        "Beam updated its GNOME helper. GNOME loads the new version at the next login.",
      );
    } else {
      notify("Clean Keyboard failed", stderr.trim().slice(0, 200));
    }
    return;
  }
  const reply = parseLockReply(stdout);
  if (reply && !reply.ok) notify("Clean Keyboard", reply.message);
}

function lockEntry(id: string, seconds: number, hide: () => void, subtitle?: string): Entry {
  return {
    id: `clean-keyboard:${id}`,
    title: lockLabel(seconds),
    subtitle,
    icon: "⌨️",
    actions: [
      {
        id: "lock",
        title: "Lock Keyboard",
        shortcut: "↵",
        run: () => {
          hide();
          // Let Beam's window close before the shell takes the keyboard.
          setTimeout(() => void lockKeyboard(seconds), 150);
          return HIDE;
        },
      },
    ],
  };
}

export function keyboardCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:clean-keyboard",
      ref: "cmd:clean-keyboard",
      title: "Clean Keyboard",
      subtitle: "System",
      icon: "🧽",
      accessory: "Command",
      keywords: ["lock keyboard", "wipe", "disable keyboard", "keyboard cleaner"],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: () => ({ type: "view", view: "clean-keyboard" }) }],
    },
  ];
}

export const keyboardView: ViewProvider = {
  info: {
    title: "Clean Keyboard",
    placeholder: "Lock the keyboard for… (or type seconds, e.g. 45)",
    preview: false,
    grid: false,
  },
  sections(query, hide) {
    const q = query.trim();
    const sections: Section[] = [];
    const typed = q ? parseLockSeconds(q) : null;
    if (typed !== null) {
      const seconds = Math.min(typed, MAX_LOCK_SECONDS);
      const note = typed > MAX_LOCK_SECONDS ? "Custom · at most 5 minutes" : "Custom";
      sections.push({ title: "Custom", entries: [lockEntry("custom", seconds, hide, note)] });
      return sections;
    }
    const choices = LOCK_CHOICES.map((c) => lockEntry(String(c.seconds), c.seconds, hide)).filter(
      (entry) => !q || entry.title.toLowerCase().includes(q.toLowerCase()),
    );
    sections.push({ title: "Lock the keyboard for", entries: choices });
    return sections;
  },
};
