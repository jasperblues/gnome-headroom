#!/usr/bin/env bash
# Run Headroom (+ Roomy Panel if present) in a throwaway headless GNOME Shell and save
# panel.png / menu.png into tools/out/. Real user settings are not touched.
# Needs mutter-devkit. Usage: tools/nested-shot.sh [extra-extension-uuid...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/data/gnome-shell/extensions" "$tmp/config" "$tmp/runtime"
chmod 700 "$tmp/runtime"
rm -f "$out"/panel.png "$out"/menu.png
ext="$tmp/data/gnome-shell/extensions"
ln -s "$(dirname "$here")" "$ext/headroom@jasperblues.github.io"
ln -s "$here/headroom-shot@local" "$ext/headroom-shot@local"
uuids="'headroom@jasperblues.github.io'"
if [[ -d $HOME/projects/gnome-roomy-panel ]]; then
    ln -s "$HOME/projects/gnome-roomy-panel" "$ext/roomy-panel@jasperblues.github.io"
    uuids+=", 'roomy-panel@jasperblues.github.io'"
fi
for u in "$@"; do uuids+=", '$u'"; done
uuids+=", 'headroom-shot@local'"
[[ -d $HOME/.config/codexbar ]] && ln -s "$HOME/.config/codexbar" "$tmp/config/codexbar"

cat > "$tmp/inner.sh" <<INNER
#!/bin/bash
dconf write /org/gnome/shell/enabled-extensions "[$uuids]"
timeout 22 gnome-shell --headless --virtual-monitor 1440x900 --wayland --no-x11 > "$out/shell.log" 2>&1
true
INNER
chmod +x "$tmp/inner.sh"
env -u WAYLAND_DISPLAY -u DISPLAY XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" \
    XDG_RUNTIME_DIR="$tmp/runtime" HR_SHOT_DIR="$out" dbus-run-session -- "$tmp/inner.sh" 2>/dev/null
grep -E 'HRSHOT|JS ERROR|token-bar' "$out/shell.log" || true
ls "$out"/*.png
