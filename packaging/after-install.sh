#!/bin/bash
# Runs as root after `apt install`. Based on electron-builder's default
# script, plus an AppArmor profile so Electron's sandbox can start on
# Ubuntu 24.04+ (which restricts unprivileged user namespaces).

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/beam' ] && [ -e '/usr/bin/beam' ] && [ "$(readlink '/usr/bin/beam')" != '/etc/alternatives/beam' ]; then
        rm -f '/usr/bin/beam'
    fi
    update-alternatives --install '/usr/bin/beam' 'beam' '/opt/Beam/beam' 100 || ln -sf '/opt/Beam/beam' '/usr/bin/beam'
else
    ln -sf '/opt/Beam/beam' '/usr/bin/beam'
fi

chmod 0755 '/opt/Beam/chrome-sandbox' || true
chmod 0755 '/opt/Beam/resources/beam-run' || true
chmod 0755 '/opt/Beam/resources/beam-fan' || true
chmod 0755 '/opt/Beam/resources/beam-power' || true
chmod 0755 '/opt/Beam/resources/beam-browser-host' || true

# Browser Tabs: Chrome installs Beam's extension (a signed CRX, built by
# scripts/pack-chrome-extension.mjs) from this file the next time it starts.
# Builds without the signing key ship no CRX; users then load it by hand.
CHROME_EXTERNAL=/usr/share/google-chrome/extensions/mgpijmbkbogdbehfmjlppgliampccfmp.json
if [ -f /opt/Beam/resources/browser-tabs/beam-browser-tabs.crx ]; then
    mkdir -p /usr/share/google-chrome/extensions
    install -m 0644 /opt/Beam/resources/browser-tabs/mgpijmbkbogdbehfmjlppgliampccfmp.json "$CHROME_EXTERNAL" || true
else
    rm -f "$CHROME_EXTERNAL"
fi

# Fan Control and the battery charge limit: lets the active user change
# them through pkexec without a password.
if [ -d /usr/share/polkit-1/actions ]; then
    install -m 0644 '/opt/Beam/resources/com.virallens.beam.fan.policy' /usr/share/polkit-1/actions/ || true
    install -m 0644 '/opt/Beam/resources/com.virallens.beam.power.policy' /usr/share/polkit-1/actions/ || true
fi

if [ -d /etc/apparmor.d ]; then
    cat > /etc/apparmor.d/beam <<'EOF'
# Allows Beam's Electron sandbox to use user namespaces; otherwise unconfined.
abi <abi/4.0>,
include <tunables/global>

profile beam /opt/Beam/beam flags=(unconfined) {
  userns,

  include if exists <local/beam>
}
EOF
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/beam || true
    fi
fi

# Starts Beam at login for every user, so its hotkeys work after a fresh
# install even before anyone opens it. Beam writes a per-user entry of the
# same name on first run, which takes precedence over this one.
if [ -d /etc/xdg/autostart ]; then
    cat > /etc/xdg/autostart/beam.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Beam
Comment=Start Beam in the background
Exec=/opt/Beam/beam --hidden
Icon=beam
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
