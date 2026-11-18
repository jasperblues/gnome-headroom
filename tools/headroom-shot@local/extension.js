// Test helper for tools/nested-shot.sh: waits for data, screenshots panel and open menu.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
const OUT = GLib.getenv('HR_SHOT_DIR');
const wait = ms => new Promise(r => GLib.timeout_add(0, ms, () => { r(); return GLib.SOURCE_REMOVE; }));

async function shot(name) {
    const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

export default class extends Extension {
    enable() {
        (async () => {
            try {
                await wait(12000);
                Main.overview.hide();
                await wait(800);
                const tb = Main.panel.statusArea['headroom@jasperblues.github.io'];
                console.log(`HRSHOT indicator=${!!tb}`);
                await shot('panel');
                tb?.menu.open();
                await wait(1500);
                await shot('menu');
                console.log('HRSHOT done');
            } catch (e) {
                console.error('HRSHOT', e);
            }
        })();
    }

    disable() {}
}
