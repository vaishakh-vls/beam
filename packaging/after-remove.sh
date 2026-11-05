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

rm -f /usr/share/polkit-1/actions/com.virallens.beam.fan.policy
rm -f /usr/share/polkit-1/actions/com.virallens.beam.power.policy

# dpkg also runs this on upgrades; keep the fan setting unless Beam is removed.
case "${1:-}" in
    remove|purge)
        rm -f /etc/modprobe.d/beam-thinkpad-fan.conf /etc/xdg/autostart/beam.desktop
        # Chrome uninstalls the Browser Tabs extension at its next start once this is gone.
        rm -f /usr/share/google-chrome/extensions/mgpijmbkbogdbehfmjlppgliampccfmp.json
        ;;
esac
