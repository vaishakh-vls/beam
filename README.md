# Beam

A Raycast-style launcher for Ubuntu (GNOME): a dark glass command bar for apps, files, clipboard history, snippets, window management and more.

Built with Electron, React and TypeScript.

## Install

One step, on Ubuntu 24.04 or newer with GNOME (64-bit Intel/AMD):

```bash
curl -fsSL https://raw.githubusercontent.com/vaishakh-vls/beam/main/install.sh | bash
```

No `curl`? Use `wget -qO- https://raw.githubusercontent.com/vaishakh-vls/beam/main/install.sh | bash`.

That downloads the newest release, installs it with everything it needs (`apt` asks for your password), and starts Beam in the background. Press `Super+Space`: the first time, Beam opens a welcome tour of everything it can do; it stays available as **Welcome to Beam**.

Other ways:

- **Download the package:** [beam_amd64.deb](https://github.com/vaishakh-vls/beam/releases/latest/download/beam_amd64.deb), then `sudo apt install ./beam_amd64.deb` and open Beam from the app grid (or log out and in; it starts at login).
- **From a checkout:** `./install.sh` (newest release), `./install.sh path/to/beam.deb`, or `./install.sh --build` (builds with Node.js 20+ first).

Log out and back in once after installing so GNOME loads Beam's GNOME Shell helper, which does window management and Clean Keyboard. GNOME on Wayland loads new or updated extension code only at login, so log out again after an upgrade that updates the helper. Restart Chrome once as well, for Browser Tabs.

Fan Control and the charge limit are for ThinkPads; Browser Tabs is for Google Chrome. The rest works on any Ubuntu laptop with GNOME.

### Publishing a release

The asset is named `beam_amd64.deb` so the download link above always gets the newest release. Build with the Chrome extension signing key in place (see [Browser Tabs](#browser-tabs)).

```bash
npm ci && npm run dist
cp release/beam_0.2.1_amd64.deb beam_amd64.deb
gh release create v0.2.1 beam_amd64.deb --title "Beam 0.2.1" --notes "..."
rm beam_amd64.deb
```

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
| `Super+Shift+C` | Confetti |
| `Ctrl+K` | Actions for the selected item |
| `Tab` | Next field, on commands that have fields, such as Caffeinate |
| `Esc` | Go back one step; closes Beam from the home screen |

Any command can get its own hotkey or alias from its action panel (`Ctrl+K`). Shortcuts are registered as GNOME custom keybindings.

## Features

- **Apps** from `.desktop` files, with system icons
- **Files**: indexed search of the folders in `fileSearchRoots`, with **Quick Look** (`Ctrl+Y`: text, formatted JSON, images, a PDF's first page, folder contents) and **Open With…** (`Ctrl+O`: the apps for that file type, every other app, and "Always Open … with" to change the default)
- **Welcome tour** on first launch: every feature with a "Try It"; reopen it any time with **Welcome to Beam**
- **Clipboard history**: text and images, with password and token filtering
- **Snippets** with placeholders (`{clipboard}`, `{date}`, ...)
- **Quicklinks** to URLs with `{query}`
- **Emoji picker**
- **Calculator and unit conversion** (mathjs)
- **Currency conversion**: `10 usd`, `$10 to eur`, `2 lakh inr in usd`. Daily rates from open.er-api.com. Converts to `"currency"` in the config, or with `"auto"` to your region's currency (from the time zone).
- **Script commands** in Raycast's `@raycast.*` format, in `~/.config/beam/scripts`
- **Window management**: everything in Raycast's Window Management except Rename Desktop (GNOME shows desktop names nowhere), via a bundled GNOME Shell extension (`gnome-extension/`):
  - Halves, Center Half, quarters, thirds, Center Two Thirds, fourths, three fourths and sixths
  - Maximize, Almost Maximize, Maximize Height/Width, Reasonable Size, Make Larger/Smaller (10% of the screen a step), Center, Restore, Minimize, Toggle Fullscreen
  - Move Up/Down/Left/Right to a screen edge; **Move Window** and **Resize Window** take the values in fields beside the search box (`Tab` between X and Y, or width and height)
  - Minimize on This Display; Focus Next/Previous App Window
  - Next/Previous Display; **Next Desktop** / **Previous Desktop** move the window you were using to the next or previous desktop and take you with it (from the last one, it gets a new desktop of its own); Open Desktop 1–9, Move to Desktop 1–9, Close Desktop (the current one, or 1–9; its windows move to the desktop beside it)
- **Confetti** (`Super+Shift+C`): confetti bursts from the bottom corners of the screen, drawn by the GNOME extension above every window; it takes no clicks or focus and is gone after 4.5 seconds. Each press adds another burst on top of the ones still falling (up to 8 at once)
- **Processes**: list running processes by CPU or memory, and quit or force-kill them
- **Fan Control** (ThinkPad): fan speed and temperatures, and fan levels from Auto to Full Speed
- **Spotify**: now playing, playback controls and search, via playerctl
- **Google Chrome**: search bookmarks and history, and open new or incognito windows
- **GIF search**: search GIPHY and copy a GIF's URL or Markdown
- **Wi-Fi**: connect to, disconnect from and forget networks, turn Wi-Fi on or off, and copy or show saved passwords with a QR code for phones
- **Bluetooth**: connect, pair and remove devices, and turn Bluetooth on or off
- **Audio**: volume, mute, and output and input devices. `volume 40` in the main search sets the volume.
- **Color picker**: pick a color anywhere on screen, copy it as HEX, RGB, HSL or OKLCH, and keep a history. Typing `#ff8800` or `rgb(255, 136, 0)` in the main search converts it.
- **Caffeinate**: keep the laptop awake until stopped, or for a set time
- **Speed test**: ping, jitter, download and upload, measured against Cloudflare
- **Clean Keyboard**: lock the keyboard for up to 5 minutes so you can wipe it
- **Browser Tabs**: search the open tabs of every Chrome window, switch to one or close it
- **Developer Tools**: decode JWT and bearer tokens, format JSON, convert timestamps, Base64, URLs and number bases, hash text, generate UUIDs, passwords and secrets
- **Convert Files**: images, video, audio and documents, e.g. PNG to JPEG, HEIC to JPEG, MP4 to GIF, DOCX to PDF
- **Power Management**: battery health and time left, power profiles, ThinkPad charge limit, sleep and shutdown timers
- **Themes**: 10 built-in themes, Follow System, and your own theme files
- **Fonts**: browse installed fonts with live previews
- **Web search fallbacks**

Config lives in `~/.config/beam/config.json`.

## Commands

Type a command's name, or a keyword such as `kill` or `bt`. Keys below act on the selected item; `Ctrl+K` lists all of its actions.

### Files

Type part of a file or folder name in the main search. `Enter` opens it, `Ctrl+Enter` Show in Folder, `Ctrl+Y` Quick Look, `Ctrl+O` Open With…, `Ctrl+T` Convert File, `Ctrl+Shift+C` copy path.

- **Quick Look** shows it inside Beam: text, formatted JSON, images, a PDF's first page, or a folder's contents.
- **Open With…** lists the apps for that file type, then every other app. `Enter` opens the file with the selected app; `Ctrl+Enter` makes that app the default for the type.

### Processes

**Search Processes** (also `kill`, `task manager`, `htop`) lists processes by CPU use, refreshed every 1.5 s, with a details pane. Filter by name, command line or PID.

- Keys: `Enter` Quit Process (SIGTERM), `Ctrl+Enter` Force Kill (SIGKILL), `Ctrl+Shift+Enter` quit all your processes with that name, `Ctrl+Shift+C` copy PID, `Ctrl+M` sort by memory or CPU. Copy Command Line is in `Ctrl+K`.
- Before ending a session-critical process such as `gnome-shell`, `systemd`, `Xwayland` or `dbus-daemon` (or Beam itself), Beam asks you to type its name.
- Processes owned by root or another user are ended through `pkexec`, which asks for the admin password.

Snaps such as Slack refuse signals from Beam directly (AppArmor), so Beam sends those through your user session's systemd; no password is needed.

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

- Network: `Enter` Connect, `Ctrl+Shift+S` rescan, `Ctrl+Shift+C` copy name, `Ctrl+D` Forget Network (saved networks).
- Saved secured network: `Ctrl+Enter` Copy Password, `Ctrl+Shift+P` Show Password and QR Code.
- Connected network: `Enter` Copy Password, `Ctrl+Enter` Show Password and QR Code, `Ctrl+I` copy IP address, `Ctrl+Shift+D` Disconnect. (An open network: `Enter` copy IP, `Ctrl+Enter` Disconnect.)
- **Saved Networks** lists networks you've joined that are out of range, so their passwords can be copied or shown anywhere, even with Wi-Fi off.
- The QR code is the standard `WIFI:` code: a phone camera scans it to join. Copied passwords are kept out of clipboard history.
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

- **Caffeinate**: set a time beside the search box: type `caffeinate`, `Tab` to Hours, `Tab` to Minutes, `Tab` to Seconds, `Enter`. With the fields empty it stays on until stopped, and when already on `Enter` turns it off.
- **Caffeinate For…**: the same fields; with them empty, `Enter` lists 15 minutes to 8 hours, where you can also type a duration such as `45m`, `1.5h` or `2h30m` (a bare number is minutes). Timers go up to 24 hours, and setting one while on changes the time.
- **Decaffeinate**: off.

### Speed test

**Speed Test** starts at once and shows ping, jitter, download and upload, measured against speed.cloudflare.com, with the Cloudflare data center and your network. Each throughput phase runs about 7 s and is capped at about 200 MB down and 75 MB up.

- Keys: `Enter` Run Again (Restart Test while running), `Ctrl+Enter` copy the results as one line, `Ctrl+.` Stop Test.

### Clean Keyboard

**Clean Keyboard** locks the keyboard for 15 s, 30 s, 1 min or 2 min, or type a duration such as `45`, `90s` or `1.5m`, up to 5 minutes. Beam's GNOME extension (its `LockKeyboard` D-Bus method) dims every screen with a countdown and ignores every key, shell shortcuts included. The mouse still works, and **Unlock** ends it early.

- One-time: log out and back in once after installing, because GNOME on Wayland loads updated extension code only at login. Until then, Beam shows a notification saying so.

### Power Management

Commands: **Power Management**, **Battery Status**, **Set Power Profile: Performance / Balanced / Power Saver**.

- Live battery level, time to full or empty, power draw, health (capacity versus design), charge cycles and charger wattage.
- Power profiles through `powerprofilesctl`, the current one marked.
- ThinkPad charge limit: Full, Stop at 80%, Stop at 60% or custom. A root helper (`beam-power`, allowed by a polkit policy) writes the thresholds, which the battery firmware keeps.
- Lock, Sleep, Hibernate (when available), Log Out, Restart and Shut Down; the last three need a second Enter within 4 seconds.
- Timers: type `45m`, `sleep 30` or `shutdown at 23:00` in the view, with Cancel. Beam warns a minute before.

### Themes and Fonts

- **Change Beam Theme**: Beam Dark, Beam Light, Catppuccin Mocha and Latte, Nord, Tokyo Night, Gruvbox Dark, Dracula, Rosé Pine and Rosé Pine Dawn, plus Follow System (GNOME's light/dark setting). Your own themes go in `~/.config/beam/themes/*.json` and only need the colors they change; **New Theme from This…** (`Ctrl+N`) writes a starting file.
- **Search Fonts**: every installed family, with a preview drawn in the font (scripts without Latin letters show their own glyphs). Type `"your text` to preview your own words. Copy the family name or CSS `font-family`, show the file, open it in GNOME Fonts, or install a font file.

### Browser Tabs

Command: **Search Browser Tabs**. Search the open tabs of every Chrome window and profile: `Enter` switches to the tab, `Ctrl+Enter` copies its URL, `Ctrl+W` closes it, `Ctrl+Shift+C` copies a Markdown link.

Chrome only shows tabs to extensions, so Beam ships a small one (`chrome-extension/`) and a native messaging host (`packaging/beam-browser-host`) that relays to Beam over a private socket. The .deb registers the signed extension with Chrome, which installs it at its next restart and removes it again when Beam is uninstalled. It is signed with a key that stays out of the repo (`~/.config/beam-signing/chrome-extension.pem`, needed only to build a release). Builds without the key leave the extension out, and the view then lists the steps for loading it by hand.

### Developer Tools

Commands: **Developer Tools**, **Decode JWT**, **Format JSON in Clipboard**, **Generate UUID**, **Generate Password**, **Generate Secret** and **Copy Unix Timestamp**.

- Paste or type anything into Developer Tools and it shows what fits: a JWT or `Bearer` token decoded (claims, expiry as "expires in 2h", header, payload; the signature is not verified), JSON formatted, minified, key-sorted or escaped (invalid JSON shows the line and column), Unix timestamps and ISO dates converted, URLs and their query parameters, Base64 and Base64URL, number bases, UUID versions, MD5/SHA hashes, case styles and text counts.
- Opened with nothing typed, it reads the clipboard.
- The main search decodes a pasted JWT and a 10- or 13-digit timestamp inline, and `uuid` gives a fresh UUID.
- Tokens, passwords and secrets are copied without entering clipboard history.

### Convert Files

Command: **Convert Files**; `Ctrl+T` on a file in search results. Copy files in the Files app (`Ctrl+C`) and open Convert Files, or choose files from it.

- Images (PNG, JPEG, WebP, AVIF, HEIC, GIF, BMP, TIFF, SVG, ICO) to PNG, JPEG, WebP, AVIF, GIF, ICO (favicon sizes), BMP, TIFF; Resize 50%, Fit 1920 px, Compress. Via ImageMagick.
- Videos to MP4, WebM, GIF, MP3, Compress; audio between MP3, WAV, OGG, FLAC and M4A. Via ffmpeg, with progress.
- Office documents to PDF (LibreOffice, if installed); PDF to PNG pages (poppler).
- The result is saved next to the original and never overwrites a file. Recent Conversions has Open and Show in Folder.

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
| `src/main/providers/` | Apps, files, clipboard, snippets, quicklinks, emoji, calculator, currency, scripts, windows, processes, fans, Spotify, Chrome, GIFs, Wi-Fi, Bluetooth, audio, color, caffeinate, speed test, keyboard, Browser Tabs, developer tools, file conversion, Open With and Quick Look, power, fonts, themes, welcome tour |
| `src/renderer/` | React UI |
| `src/shared/` | Types shared by both |
| `gnome-extension/` | GNOME Shell helper for window management and Clean Keyboard (D-Bus) |
| `chrome-extension/` | Chrome extension behind Browser Tabs |
| `scripts/` | Build helpers: bundling, icons, and packing the signed Chrome extension |
| `install.sh` | The one-step installer |
| `packaging/` | .deb install and remove scripts; `beam-fan` and `beam-power` (root helpers) and their polkit policies; `beam-pick-color` (portal color picker); `beam-browser-host` (Chrome native messaging host) |

## License

[MIT](LICENSE). The bundled Inter font is under the SIL Open Font License (`src/renderer/fonts/LICENSE.txt`).
