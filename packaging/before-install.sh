#!/bin/bash
# Runs as root before `apt install` unpacks Beam. A running Electron app
# breaks when its files are replaced underneath it, so stop Beam first; the
# next hotkey press (or login) starts the new version.
#
# Only the main process is signalled. Killing Electron's helper processes
# (--type=zygote, gpu-process, renderer) as well makes the main process hit
# an internal check on the way out and crash with SIGTRAP.

for pid in $(pgrep -f '^/opt/Beam/beam( |$)'); do
    grep -qa -- '--type=' "/proc/$pid/cmdline" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
done

# Give Beam up to five seconds to save its data and exit.
for _ in $(seq 1 10); do
    pgrep -f '^/opt/Beam/beam' >/dev/null || break
    sleep 0.5
done

exit 0
