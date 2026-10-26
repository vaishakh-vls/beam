import { shortcutParts } from "../keys";

export function Kbd({ shortcut }: { shortcut?: string }) {
  if (!shortcut) return null;
  return (
    <span className="kbd-group">
      {shortcutParts(shortcut).map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}
