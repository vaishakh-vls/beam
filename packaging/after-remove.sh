#!/bin/bash
# Runs as root after `apt remove`: undo what after-install.sh added.

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'beam' '/opt/Beam/beam' || true
else
    rm -f '/usr/bin/beam'
fi

if [ -f /etc/apparmor.d/beam ]; then
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove /etc/apparmor.d/beam || true
    fi
    rm -f /etc/apparmor.d/beam
fi
