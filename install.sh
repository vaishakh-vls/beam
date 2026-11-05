#!/bin/bash
# Installs Beam in one step on Ubuntu (GNOME), then starts it in the
# background. The first Super+Space opens the welcome tour.
#
#   ./install.sh                    newest release from GitHub (needs `gh` signed in)
#   ./install.sh beam_0.2.0.deb     a .deb you were sent
#   ./install.sh --build            build this checkout first (needs Node.js 20+)
#
# Without a checkout:
#   gh api -H "Accept: application/vnd.github.raw" repos/vaishakh-vls/beam/contents/install.sh | bash

set -euo pipefail

REPO="vaishakh-vls/beam"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v apt-get >/dev/null || die "Beam needs Ubuntu or another Debian-based system with apt."
[ "$(dpkg --print-architecture)" = "amd64" ] || die "Beam is built for 64-bit Intel/AMD (amd64) only."
[ "$(id -u)" -ne 0 ] || die "Run this as yourself, not with sudo; it asks for your password when it needs it."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "${1:-}" in
    *.deb)
        [ -f "$1" ] || die "No such file: $1"
        deb="$(realpath "$1")"
        ;;
    --build)
        cd "$(dirname "$(realpath "$0")")"
        command -v npm >/dev/null || die "Building needs Node.js 20 or newer (npm was not found)."
        say "Building Beam (takes a minute or two)"
        npm ci
        npm run dist
        deb="$(realpath "$(ls -t release/beam_*_amd64.deb | head -n 1)")"
        ;;
    "")
        command -v gh >/dev/null || die "Install GitHub CLI (sudo apt install gh) and sign in with 'gh auth login', or pass a .deb file."
        say "Downloading the newest Beam release"
        gh release download --repo "$REPO" --pattern 'beam_*_amd64.deb' --dir "$work" \
            || die "Could not download the release. Do you have access to $REPO? Try 'gh auth status'."
        deb="$(ls "$work"/beam_*_amd64.deb | head -n 1)"
        ;;
    *)
        die "Unknown option: $1 (use a .deb path, --build, or nothing)"
        ;;
esac

say "Installing $(basename "$deb") and what it needs (asks for your password)"
# apt reads the file as a package only with a path, hence the absolute path.
# --reinstall: without it apt skips a file of the version already installed.
sudo apt-get install -y --reinstall "$deb"

say "Starting Beam"
# In the background: a window opened from here would sit behind this terminal
# without focus. The hotkey below gives it focus, and the tour opens then.
setsid -f /opt/Beam/beam --hidden >/dev/null 2>&1 < /dev/null

cat <<'EOF'

Beam is installed and running.

  Super+Space   open Beam; the first time, a tour shows what it can do
  Super+V       clipboard history

Two one-time steps finish the setup:
  - Log out and back in, for window layouts and Clean Keyboard.
  - Restart Chrome, for Browser Tabs.
EOF
