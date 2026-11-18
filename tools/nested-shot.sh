#!/usr/bin/env bash
# Run Headroom in a throwaway headless GNOME Shell and save screenshots to tools/out/:
#   panel.png, menu.png (full screen) and menu-crop.png (top-right corner, if ImageMagick is installed).
# Your real GNOME settings are not touched. Needs mutter-devkit.
#
# Usage: tools/nested-shot.sh [--demo] [extra-extension-uuid...]
#   --demo   use the fake codexbar/ccusage in tools/demo instead of real data
# Env:     EXTRA_EXTENSION_DIRS="dir1 dir2"  extension checkouts to load alongside (dir name = uuid not required;
#          the uuid is read from each dir's metadata.json)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
out="$here/out"
demo=false
if [[ ${1:-} == --demo ]]; then
    demo=true
    shift
fi

glib-compile-schemas "$repo/schemas"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/data/gnome-shell/extensions" "$tmp/config" "$tmp/runtime"
chmod 700 "$tmp/runtime"
rm -f "$out"/panel.png "$out"/menu.png "$out"/menu-crop.png
ext="$tmp/data/gnome-shell/extensions"
ln -s "$repo" "$ext/headroom@jasperblues.github.io"
ln -s "$here/headroom-shot@local" "$ext/headroom-shot@local"

uuids="'headroom@jasperblues.github.io'"
for dir in ${EXTRA_EXTENSION_DIRS:-}; do
    uuid=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$dir/metadata.json")
    ln -s "$(cd "$dir" && pwd)" "$ext/$uuid"
    uuids+=", '$uuid'"
done
for u in "$@"; do uuids+=", '$u'"; done
uuids+=", 'headroom-shot@local'"
[[ -d $HOME/.config/codexbar ]] && ln -s "$HOME/.config/codexbar" "$tmp/config/codexbar"

settings=""
if $demo; then
    settings="dconf write /org/gnome/shell/extensions/headroom/codexbar-path \"'$here/demo/codexbar'\"
dconf write /org/gnome/shell/extensions/headroom/ccusage-path \"'$here/demo/ccusage'\""
fi

cat > "$tmp/inner.sh" <<INNER
#!/bin/bash
dconf write /org/gnome/shell/enabled-extensions "[$uuids]"
dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"
$settings
timeout 30 gnome-shell --headless --virtual-monitor 1440x900 --wayland --no-x11 > "$out/shell.log" 2>&1
true
INNER
chmod +x "$tmp/inner.sh"
env -u WAYLAND_DISPLAY -u DISPLAY XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" \
    XDG_RUNTIME_DIR="$tmp/runtime" HR_SHOT_DIR="$out" dbus-run-session -- "$tmp/inner.sh" 2>/dev/null
grep -E 'HRSHOT|JS ERROR|headroom' "$out/shell.log" || true
if [[ -f $out/menu.png ]] && command -v magick >/dev/null; then
    magick "$out/menu.png" -gravity NorthEast -crop 560x620+0+0 +repage "$out/menu-crop.png"
fi
ls "$out"/*.png
