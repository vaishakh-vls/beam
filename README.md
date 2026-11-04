# Beam

A Raycast-style launcher for Ubuntu (GNOME): a dark glass command bar for apps, files, clipboard history, snippets, window management and more.

Built with Electron, React and TypeScript.

## Install

```bash
npm ci
npm run dist
sudo apt install ./release/beam_0.1.0_amd64.deb
```

Log out and back in once after installing so GNOME loads Beam's GNOME Shell helper, which does window management and Clean Keyboard. GNOME on Wayland loads new or updated extension code only at login, so log out again after an upgrade that updates the helper.

## Shortcuts

| Keys | Action |
|---|---|
| `Super+Space` | Open / close Beam |
| `Super+V` | Clipboard history |
| `Ctrl+Super+←` / `→` | Left / right half |
| `Ctrl+Super+Enter` | Maximize |
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
- **Currency conversion**: `10 usd`, `$10 to eur`, `2 lakh inr in usd`. Daily rates from open.er-api.com. Converts to `"currency"` in the config, or with `"auto"` to your region's currency (from the time zone).
- **Script commands** in Raycast's `@raycast.*` format, in `~/.config/beam/scripts`
- **Window management**: 24 layouts (halves, quarters, thirds, displays...) via a bundled GNOME Shell extension (`gnome-extension/`)
- **Processes**: list running processes by CPU or memory, and quit or force-kill them
- **Fan Control** (ThinkPad): fan speed and temperatures, and fan levels from Auto to Full Speed
- **Spotify**: now playing, playback controls and search, via playerctl
- **Google Chrome**: search bookmarks and history, and open new or incognito windows
- **GIF search**: search GIPHY and copy a GIF's URL or Markdown
- **Wi-Fi**: connect to, disconnect from and forget networks, and turn Wi-Fi on or off
- **Bluetooth**: connect, pair and remove devices, and turn Bluetooth on or off
- **Audio**: volume, mute, and output and input devices. `volume 40` in the main search sets the volume.
- **Color picker**: pick a color anywhere on screen, copy it as HEX, RGB, HSL or OKLCH, and keep a history. Typing `#ff8800` or `rgb(255, 136, 0)` in the main search converts it.
- **Caffeinate**: keep the laptop awake until stopped, or for a set time
- **Speed test**: ping, jitter, download and upload, measured against Cloudflare
- **Clean Keyboard**: lock the keyboard for up to 5 minutes so you can wipe it
- **Web search fallbacks**

Config lives in `~/.config/beam/config.json`.

## Commands

Type a command's name, or a keyword such as `kill` or `bt`. Keys below act on the selected item; `Ctrl+K` lists all of its actions.

### Processes

**Search Processes** (also `kill`, `task manager`, `htop`) lists processes by CPU use, refreshed every 1.5 s, with a details pane. Filter by name, command line or PID.

- Keys: `Enter` Quit Process (SIGTERM), `Ctrl+Enter` Force Kill (SIGKILL), `Ctrl+Shift+Enter` quit all your processes with that name, `Ctrl+Shift+C` copy PID, `Ctrl+M` sort by memory or CPU. Copy Command Line is in `Ctrl+K`.
- Before ending a session-critical process such as `gnome-shell`, `systemd`, `Xwayland` or `dbus-daemon` (or Beam itself), Beam asks you to type its name.
- Processes owned by root or another user are ended through `pkexec`, which asks for the admin password.

### Fan Control

ThinkPads only: it works through the `thinkpad_acpi` driver. **Fan Control** shows fan RPM, the CPU temperature (and SSD and Wi-Fi where available) and the fan levels; `Enter` sets the selected level. **Set Fan to Auto** and **Set Fan to Full Speed** work straight from the main search.

- One-time setup: open Fan Control and choose **Turn On Fan Control**. It asks for the admin password, writes `/etc/modprobe.d/beam-thinkpad-fan.conf` and reloads `thinkpad_acpi` (if the driver is busy, the setting applies at the next restart). After that, changing levels needs no password, through the polkit policy `com.virallens.beam.fan.policy`. This covers the installed .deb only; under `npm run dev` each change asks.
- Levels: Auto, 1–7 and Full Speed. Level 0 (off) is deliberately not offered.
- A guard sets the fan back to Auto, with a notification, if the CPU reaches 90 °C on a manual level below 7.
- Uninstalling Beam removes the modprobe file; upgrades keep it.

### Spotify

Commands: **Spotify Now Playing**, **Spotify Play/Pause**, **Spotify Next Track**, **Spotify Previous Track**, **Search Spotify**. Play/Pause, Next and Previous act without opening a view and start Spotify if it's closed; Next and Previous show the new track in a notification.

Now Playing and Search Spotify open the Spotify view: the current track with cover art and progress, then Play/Pause, Next, Previous, Shuffle, Repeat, Volume Up and Volume Down. Typing filters the controls (`skip`, `vol`) and adds a search item.

- Current track: `Enter` play/pause, `Ctrl+Enter` open Spotify, `Ctrl+Shift+C` copy title and artist, `Ctrl+Shift+L` copy song link.
- Search item: `Enter` search in the Spotify app (the web player if no app handles `spotify:` links), `Ctrl+Enter` search on Spotify Web.
- Uses `playerctl` (MPRIS), now a dependency of the .deb.

### Google Chrome

Commands: **Search Chrome**, **New Chrome Window**, **New Incognito Window**. Search Chrome shows recent history and bookmarks from the profile Chrome used last; type to search both.

- Keys: `Enter` open in Chrome, `Ctrl+Enter` open in an incognito window, `Ctrl+Shift+C` copy URL, `Ctrl+Shift+M` copy as Markdown link.
- History and bookmarks are read locally only, from `~/.config/google-chrome`. Chrome locks its history file, so Beam queries a private copy in `$XDG_RUNTIME_DIR/beam` and deletes it when Beam quits.

### GIF search

**Search GIFs** shows trending GIFs from GIPHY; type to search.

- Keys: `Enter` copy GIF URL, `Ctrl+Enter` copy as Markdown, `Ctrl+O` open in browser, `Ctrl+Shift+C` copy page link.
- One-time setup: it needs a free GIPHY API key, which the view prompts for (**Add GIPHY API Key**; **Get a Free API Key** opens developers.giphy.com). It's stored in `~/.config/beam/config.json` as `giphyApiKey`.
- Free keys allow about 100 requests an hour, so Beam searches only when typing pauses and caches results for the session.

### Wi-Fi

Commands: **Wi-Fi** (the network list, via `nmcli`) and **Toggle Wi-Fi**.

- Network: `Enter` Connect, `Ctrl+Enter` copy name, `Ctrl+Shift+S` rescan, `Ctrl+D` Forget Network (saved networks).
- Connected network: `Enter` copy IP address, `Ctrl+Enter` Disconnect, `Ctrl+Shift+C` copy name.
- Saved and open networks connect directly. A new WPA/WPA2 or WPA3 network asks for the password and saves it with the network, as GNOME Settings does. WEP and enterprise (802.1X) networks open GNOME Settings instead.
- The password never appears on the command line: it reaches `nmcli` through a temporary file (mode 0600, in `$XDG_RUNTIME_DIR`) that is deleted straight after.
- Turn Wi-Fi On/Off, Rescan Networks and Open Wi-Fi Settings are below the list.

### Bluetooth

Commands: **Bluetooth** (My Devices and New Devices, with battery levels where reported) and **Toggle Bluetooth**. Uses `bluetoothctl`; on and off go through GNOME's own switch, so Quick Settings agrees with Beam.

- Paired device: `Enter` Connect or Disconnect, `Ctrl+Enter` Open Bluetooth Settings, `Ctrl+Shift+S` scan for new devices, `Ctrl+D` Remove Device.
- New device: `Enter` Pair & Connect (it's also trusted, so it reconnects by itself), `Ctrl+Enter` Open Bluetooth Settings.
- **Scan for New Devices** scans for 8 seconds; put the device in pairing mode first. Devices that need a PIN or code pair in GNOME Settings.

### Audio

**Audio Devices** shows the output volume, Mute, preset levels from 0 to 100%, output devices, microphone mute and input devices. Uses WirePlumber's `wpctl`; the volume is capped at 100%.

- Volume: `Enter` up 10%, `Ctrl+Enter` down 10%. Type a number such as `40` in the view to set that level.
- Device: `Enter` Use for Sound Output (or Input).
- In the main search, `volume 40` (also `vol 40%`, `set volume to 40`) sets the volume directly.

### Color picker

Commands: **Pick Color** and **Color History**. Pick Color hides Beam and opens the desktop's color picker (xdg-desktop-portal): click anywhere on screen, or press `Esc` to cancel. The color is copied as HEX, saved to the history (last 50, in `~/.config/beam/colors.json`) and shown in a notification.

- In the main search, typing a hex color with `#` (`#ff8800`, `#f80`), `rgb(…)` or `hsl(…)` shows it converted.
- Color: `Enter` copy HEX, `Ctrl+Enter` copy RGB (the other way round for a typed hex), `Ctrl+H` copy HSL, `Ctrl+O` copy OKLCH, `Ctrl+S` save a typed color to the history.
- Color History: type a color to convert it or to filter the list; `Ctrl+D` deletes a color, `Ctrl+Shift+D` clears the history.

### Caffeinate

Keeps the laptop awake with an idle and suspend inhibitor (`gnome-session-inhibit`), released when you stop it or quit Beam. While it's on, the commands show the time left.

- **Caffeinate**: on until stopped; when already on, it turns it off.
- **Caffeinate For…**: 15 minutes to 8 hours, or type a duration such as `45m`, `1.5h` or `2h30m` (a bare number is minutes), up to 24 hours. Picking one while on changes the timer.
- **Decaffeinate**: off.

### Speed test

**Speed Test** starts at once and shows ping, jitter, download and upload, measured against speed.cloudflare.com, with the Cloudflare data center and your network. Each throughput phase runs about 7 s and is capped at about 200 MB down and 75 MB up.

- Keys: `Enter` Run Again (Restart Test while running), `Ctrl+Enter` copy the results as one line, `Ctrl+.` Stop Test.

### Clean Keyboard

**Clean Keyboard** locks the keyboard for 15 s, 30 s, 1 min or 2 min, or type a duration such as `45`, `90s` or `1.5m`, up to 5 minutes. Beam's GNOME extension (its `LockKeyboard` D-Bus method) dims every screen with a countdown and ignores every key, shell shortcuts included. The mouse still works, and **Unlock** ends it early.

- One-time: log out and back in once after installing, because GNOME on Wayland loads updated extension code only at login. Until then, Beam shows a notification saying so.

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
| `src/main/` | Electron main process: search, hotkeys, IPC, and the pure helpers behind the providers |
| `src/main/providers/` | Apps, files, clipboard, snippets, quicklinks, emoji, calculator, currency, scripts, windows, processes, fans, Spotify, Chrome, GIFs, Wi-Fi, Bluetooth, audio, color, caffeinate, speed test, keyboard |
| `src/renderer/` | React UI |
| `src/shared/` | Types shared by both |
| `gnome-extension/` | GNOME Shell helper for window management and Clean Keyboard (D-Bus) |
| `packaging/` | .deb install and remove scripts; `beam-fan` (root fan helper) and its polkit policy; `beam-pick-color` (portal color picker) |
