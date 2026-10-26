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

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
