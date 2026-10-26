import type React from "react";

/** "Ctrl+Shift+C" style string for a keyboard event, or null for bare modifiers. */
export function comboFromEvent(event: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = event.key;
  if (["Control", "Shift", "Alt", "Meta", "Super", "OS"].includes(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(keyName(event));
  return parts.join("+");
}

function keyName(event: KeyboardEvent | React.KeyboardEvent): string {
  const { key, code } = event;
  if (key === " ") return "Space";
  if (key === "Enter") return "↵";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Display form for action shortcuts, e.g. "Ctrl+Shift+C" -> ["Ctrl", "⇧", "C"]. */
export function shortcutParts(shortcut: string): string[] {
  return shortcut.split("+").map((part) => (part === "Shift" ? "⇧" : part));
}

/** Hotkey recorder output; uses names the main process understands. */
export function hotkeyFromEvent(event: React.KeyboardEvent): string | null {
  const combo = comboFromEvent(event);
  if (!combo) return null;
  const parts = combo.split("+").map((p) => (p === "↵" ? "Enter" : p));
  if (parts.length < 2) return null;
  return parts.join("+");
}
