# Beam

A Raycast-style launcher for Ubuntu (GNOME): a dark glass command bar for apps, files, clipboard history, snippets, window management and more.

Built with Electron, React and TypeScript.

## Install

```bash
npm ci
npm run dist
sudo apt install ./release/beam_0.1.0_amd64.deb
```

Log out and back in once after the first install so GNOME loads the window-management helper.

## Shortcuts

| Keys | Action |
|---|---|
| `Super+Space` | Open / close Beam |
| `Super+V` | Clipboard history |
| `Ctrl+Super+←` / `→` | Left / right half |
| `Ctrl+Super+↑` | Maximize |
| `Ctrl+Super+↓` | Reasonable size |
| `Ctrl+Super+C` | Center |
| `Ctrl+Super+Backspace` | Restore |
| `Ctrl+K` | Actions for the selected item |
| `Esc` | Go back one step; closes Beam from the home screen |

Any command can get its own hotkey or alias from its action panel (`Ctrl+K`). Shortcuts are registered as GNOME custom keybindings.

## Features

- **Apps** from `.desktop` files, with system icons
- **Files**: indexed search of the folders in `fileSearchRoots`
- **Clipboard history**: text and images, with password and token filtering
- **Snippets** with placeholders (`{clipboard}`, `{date}`, ...)
- **Quicklinks** to URLs with `{query}`
- **Emoji picker**
- **Calculator and unit conversion** (mathjs)
- **Script commands** in Raycast's `@raycast.*` format, in `~/.config/beam/scripts`
- **Window management**: 24 layouts (halves, quarters, thirds, displays...) via a bundled GNOME Shell extension (`gnome-extension/`)
- **Web search fallbacks**

Config lives in `~/.config/beam/config.json`.

## Development

```bash
npm run dev        # Vite + Electron with reload
npm test           # unit tests
npm run typecheck
```

Electron needs `--no-sandbox` in dev on Ubuntu 24.04 because of AppArmor's user-namespace restriction. The installed .deb adds an AppArmor profile instead (`packaging/after-install.sh`).

On Wayland, apps can't type into other windows, so pasting from Beam copies to the clipboard instead.

## Layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: search, providers, hotkeys, IPC |
| `src/main/providers/` | Apps, files, clipboard, snippets, quicklinks, emoji, calculator, scripts, windows |
| `src/renderer/` | React UI |
| `src/shared/` | Types shared by both |
| `gnome-extension/` | GNOME Shell helper for window management (D-Bus) |
| `packaging/` | .deb install and remove scripts |
