// Headroom: AI plan limits (CodexBar CLI) + today's token burn (ccusage) in the GNOME top bar.
// SPDX-License-Identifier: MIT
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const HOME = GLib.get_home_dir();
// GNOME Shell's PATH usually lacks user install dirs, so look in the common places too.
const CODEXBAR_CANDIDATES = [
    `${HOME}/.local/bin/codexbar`,
    '/home/linuxbrew/.linuxbrew/bin/codexbar',
    '/usr/local/bin/codexbar',
    '/usr/bin/codexbar',
];
// ccusage is a Node CLI, typically installed under a version manager that only interactive shells load.
const CCUSAGE_SCRIPT =
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:$PATH"; ' +
    'command -v ccusage >/dev/null || . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; ' +
    'command -v ccusage >/dev/null || exit 127; ' +
    'exec ccusage daily --json --offline';
const NOT_FOUND = 127;

const PROVIDER_NAMES = {claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', copilot: 'Copilot', openai: 'OpenAI', zai: 'z.ai'};

const LIMITS_EVERY_S = 300;
const TOKENS_EVERY_S = 120;
const STALE_ON_OPEN_S = 60;
const TRACK_PX = 292;
const METER_PX = 14;
const SPARKS = '▁▂▃▄▅▆▇█';

class ToolMissing extends Error {}

async function run(argv, cancellable) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, cancellable);
    if (proc.get_if_exited() && proc.get_exit_status() === NOT_FOUND)
        throw new ToolMissing();
    if (!proc.get_successful())
        throw new Error(`${GLib.path_get_basename(argv[0])} exited with ${proc.get_exit_status()}`);
    return stdout;
}

function isExecutable(path) {
    return path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

function findCodexbar(configured) {
    if (configured)
        return isExecutable(configured) ? configured : null;
    return GLib.find_program_in_path('codexbar') ?? CODEXBAR_CANDIDATES.find(isExecutable) ?? null;
}

function ccusageArgv(configured) {
    if (configured)
        return isExecutable(configured) ? [configured, 'daily', '--json', '--offline'] : null;
    return ['/bin/bash', '-c', CCUSAGE_SCRIPT];
}

function providerName(id) {
    return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function compact(n) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) {
        if (n >= size) {
            const v = n / size;
            return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${suffix}`;
        }
    }
    return `${Math.round(n)}`;
}

function money(n) {
    return n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
}

function until(iso) {
    if (!iso)
        return null;
    let s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s - h * 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

function localDate(date = new Date()) {
    const pad = v => String(v).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shortModel(name) {
    return name.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
}

function severity(leftPercent) {
    if (leftPercent <= 10)
        return 'crit';
    if (leftPercent <= 25)
        return 'warn';
    return null;
}

// Cool → hot: blue, purple, orange, red as a day approaches your all-time best.
const HEAT_STOPS = [[0, [0x62, 0xa0, 0xea]], [0.45, [0xc0, 0x61, 0xcb]], [0.75, [0xff, 0x78, 0x00]], [1, [0xed, 0x33, 0x3b]]];

function heat(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    let i = 1;
    while (i < HEAT_STOPS.length - 1 && f > HEAT_STOPS[i][0])
        i++;
    const [p0, c0] = HEAT_STOPS[i - 1];
    const [p1, c1] = HEAT_STOPS[i];
    const t = (f - p0) / (p1 - p0);
    return `#${c0.map((c, k) => Math.round(c + (c1[k] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass ?? '', ...props});
}

// Dim text that wraps instead of ellipsizing (status and error messages).
function note(text) {
    const l = label(text, 'headroom-dim headroom-note');
    l.clutter_text.line_wrap = true;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function row(left, right, leftClass, rightClass) {
    const box = new St.BoxLayout({x_expand: true});
    box.add_child(label(left, leftClass, {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    box.add_child(label(right, rightClass ?? 'headroom-row-value', {y_align: Clutter.ActorAlign.CENTER}));
    return box;
}

function bar(usedPercent) {
    const left = 100 - usedPercent;
    const track = new St.Widget({style_class: 'headroom-track', style: `width: ${TRACK_PX}px;`});
    const fill = new St.Widget({style_class: 'headroom-fill'});
    const sev = severity(left);
    if (sev)
        fill.add_style_class_name(sev);
    fill.set_style(`width: ${Math.round(TRACK_PX * Math.max(0, Math.min(100, left)) / 100)}px;`);
    track.add_child(fill);
    return track;
}

// A non-interactive menu item holding a vertical stack of widgets we rebuild on each refresh.
const Card = GObject.registerClass(
class Card extends PopupMenu.PopupBaseMenuItem {
    _init() {
        // Stay reactive so St doesn't apply :insensitive (dimmed) styling, but never hover or activate.
        super._init({reactive: true, activate: false, hover: false, can_focus: false});
        this.box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'headroom-card', x_expand: true});
        this.add_child(this.box);
    }

    syncSensitive() {
        this.reactive = true;
        this.can_focus = false;
        return true;
    }

    reset(...children) {
        this.box.destroy_all_children();
        for (const c of children)
            this.box.add_child(c);
    }
});

const Headroom = GObject.registerClass(
class Headroom extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Headroom');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._limits = null;
        this._tokens = null;
        this._limitsError = null;
        this._tokensError = null;
        this._limitsAt = 0;
        this._tokensAt = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box headroom-panel-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/brain-symbolic.svg`),
            style_class: 'system-status-icon headroom-icon',
        });
        // Small vertical meter of headroom left, so the icon alone tells you how much is left.
        this._meter = new St.Widget({style_class: 'headroom-meter', y_align: Clutter.ActorAlign.CENTER});
        this._meterFill = new St.Widget({style_class: 'headroom-meter-fill', y_align: Clutter.ActorAlign.END});
        this._meter.layout_manager = new Clutter.BinLayout();
        this._meter.add_child(this._meterFill);
        this._label = label('…', 'headroom-panel-label', {y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._meter);
        box.add_child(this._label);
        this.add_child(box);

        this._limitsCard = new Card();
        this._tokensCard = new Card();
        this.menu.addMenuItem(this._limitsCard);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._tokensCard);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Refresh', () => this._refresh(true));

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(false, STALE_ON_OPEN_S);
        });

        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'panel-style') {
                this._render();
                return;
            }
            this._limits = this._tokens = null;
            this._refresh(true);
        }, this);

        this._render();
        this._refresh(true);
        this._limitsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LIMITS_EVERY_S, () => {
            this._refreshLimits();
            return GLib.SOURCE_CONTINUE;
        });
        this._tokensTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TOKENS_EVERY_S, () => {
            this._refreshTokens();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh(force, staleS = 0) {
        const now = Date.now() / 1000;
        if (force || now - this._limitsAt > staleS)
            this._refreshLimits();
        if (force || now - this._tokensAt > staleS)
            this._refreshTokens();
    }

    async _refreshLimits() {
        const provider = this._settings.get_string('provider') || 'claude';
        const codexbar = findCodexbar(this._settings.get_string('codexbar-path'));
        try {
            if (!codexbar)
                throw new ToolMissing();
            const out = await run([codexbar, 'usage', '--provider', provider, '--json'], this._cancellable);
            const entry = JSON.parse(out).find(e => e.provider === provider) ?? null;
            this._limits = entry;
            this._limitsError = entry ? null : `No ${providerName(provider)} data from CodexBar`;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._limits = null;
            this._limitsError = e instanceof ToolMissing
                ? 'CodexBar CLI not found. Install it to see plan limits.'
                : e.message;
        }
        this._limitsAt = Date.now() / 1000;
        this._render();
    }

    async _refreshTokens() {
        const argv = ccusageArgv(this._settings.get_string('ccusage-path'));
        try {
            if (!argv)
                throw new ToolMissing();
            const out = await run(argv, this._cancellable);
            this._tokens = JSON.parse(out).daily ?? [];
            this._tokensError = null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._tokens = null;
            this._tokensError = e instanceof ToolMissing
                ? 'ccusage not found. Install it with npm i -g ccusage to see token counts.'
                : e.message;
        }
        this._tokensAt = Date.now() / 1000;
        this._render();
    }

    // Rate windows in display order: session (primary), weekly (secondary), monthly (tertiary), extras.
    _windows() {
        const u = this._limits?.usage;
        if (!u)
            return [];
        const names = this._limits.rateWindowLabels ?? {};
        const pace = this._limits.pace ?? {};
        const out = [];
        for (const [key, fallback] of [['primary', 'Session'], ['secondary', 'Weekly'], ['tertiary', 'Monthly']]) {
            if (u[key])
                out.push({title: names[key] ?? fallback, window: u[key], pace: pace[key]?.summary?.split('|')[0].trim()});
        }
        for (const extra of u.extraRateWindows ?? [])
            out.push({title: extra.title, window: extra.window, pace: null});
        return out;
    }

    _today() {
        return (this._tokens ?? []).find(d => d.period === localDate()) ?? null;
    }

    _render() {
        if (!this._label)
            return;
        // Panel: brain + meter of the tightest main window's headroom; optionally % left and today's tokens.
        const main = this._windows().filter(w => !this._limits.usage.extraRateWindows?.some(x => x.window === w.window));
        const tightest = main.reduce((a, w) => (!a || w.window.usedPercent > a.window.usedPercent ? w : a), null);
        const today = this._today();
        const style = this._settings.get_string('panel-style');
        const left = tightest ? Math.max(0, Math.min(100, 100 - tightest.window.usedPercent)) : null;
        const sev = left !== null ? severity(left) : null;
        const failed = !tightest && !today && (this._limitsError || this._tokensError);

        const parts = [];
        if (style !== 'icon' && tightest)
            parts.push(`${Math.round(left)}%`);
        if (style === 'full') {
            if (today)
                parts.push(compact(today.totalTokens));
            else if (this._tokens)
                parts.push('0');
        }
        // Text only when the style asks for it, or as a warning sign when both data sources failed.
        this._label.text = parts.length ? parts.join(' · ') : failed ? '⚠' : style === 'icon' ? '' : '…';
        this._label.visible = this._label.text !== '';

        this._meter.visible = left !== null;
        this._meterFill.set_style(`height: ${Math.max(1, Math.round(METER_PX * (left ?? 0) / 100))}px;`);
        for (const actor of [this._label, this._icon, this._meterFill]) {
            actor.remove_style_class_name('warn');
            actor.remove_style_class_name('crit');
            if (sev)
                actor.add_style_class_name(sev);
        }
        const accessible = [tightest && `${Math.round(left)}% of ${tightest.title.toLowerCase()} limit left`,
            today && `${compact(today.totalTokens)} tokens today`].filter(Boolean).join(', ');
        this.accessible_name = accessible ? `Headroom: ${accessible}` : 'Headroom';

        this._renderLimits();
        this._renderTokens(today);
    }

    _renderLimits() {
        if (!this._limits) {
            this._limitsCard.reset(
                label('Plan limits', 'headroom-heading'),
                note(this._limitsError ?? 'Loading…'));
            return;
        }
        const u = this._limits.usage;
        const children = [row(providerName(this._limits.provider), u.loginMethod ?? '', 'headroom-heading', 'headroom-dim')];
        for (const w of this._windows()) {
            const used = w.window.usedPercent ?? 0;
            children.push(row(w.title, `${100 - Math.round(used)}% left`));
            children.push(bar(used));
            const detail = [until(w.window.resetsAt) && `Resets in ${until(w.window.resetsAt)}`, w.pace]
                .filter(Boolean).join(' · ');
            if (detail)
                children.push(label(detail, 'headroom-dim'));
        }
        if (this._limitsError)
            children.push(note(`⚠ ${this._limitsError}`));
        this._limitsCard.reset(...children);
    }

    _renderTokens(today) {
        if (!this._tokens) {
            this._tokensCard.reset(
                label('Today', 'headroom-heading'),
                note(this._tokensError ?? 'Loading…'));
            return;
        }
        const days = this._tokens;
        const todayTokens = today?.totalTokens ?? 0;
        const header = row('Today', '', 'headroom-heading', 'headroom-dim');
        if (today)
            header.get_last_child().clutter_text.set_markup(`<b>${money(today.totalCost)}</b> API-equivalent`);
        const children = [header];
        children.push(label(`${compact(todayTokens)} tokens`, 'headroom-big'));

        if (today) {
            children.push(label(
                `out ${compact(today.outputTokens)} · in ${compact(today.inputTokens)} · ` +
                `cache read ${compact(today.cacheReadTokens)} · write ${compact(today.cacheCreationTokens)}`,
                'headroom-dim'));
            const models = [...(today.modelBreakdowns ?? [])].sort((a, b) => b.cost - a.cost);
            for (const m of models) {
                const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
                children.push(row(shortModel(m.modelName), `${compact(total)} · ${money(m.cost)}`, 'headroom-dim', 'headroom-dim'));
            }
        }

        // Last 7 days sparkline, oldest → today.
        const byDate = new Map(days.map(d => [d.period, d.totalTokens]));
        const week = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            week.push(byDate.get(localDate(d)) ?? 0);
        }
        const peak = Math.max(...week, 1);
        const record = Math.max(...days.map(d => d.totalTokens), 1);
        const spark = week.map(v => {
            if (v === 0)
                return ' ';
            const glyph = SPARKS[Math.min(7, Math.floor((v / peak) * 7.999))];
            return `<span foreground="${heat(v / record)}">${glyph}</span>`;
        }).join('');
        const weekTotal = week.reduce((a, b) => a + b, 0);
        const sparkRow = new St.BoxLayout({x_expand: true});
        sparkRow.add_child(label('Last 7 days', 'headroom-dim', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const sparkLabel = label(spark, 'headroom-spark', {y_align: Clutter.ActorAlign.CENTER});
        sparkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        // Leading zero-width space: Clutter otherwise lets the CSS colour win over the first span.
        sparkLabel.clutter_text.set_markup(`\u200b${spark}`);
        sparkRow.add_child(sparkLabel);
        children.push(sparkRow);
        children.push(row(`${compact(weekTotal)} this week`, `avg ${compact(weekTotal / 7)}/day`, 'headroom-dim', 'headroom-dim'));

        // Personal best (excluding today). Purely for entertainment; see README.
        const past = days.filter(d => d.period !== today?.period);
        const best = past.reduce((a, d) => (!a || d.totalTokens > a.totalTokens ? d : a), null);
        if (best) {
            const when = GLib.DateTime.new_from_iso8601(`${best.period}T12:00:00Z`, null)?.format('%-d %b') ?? best.period;
            if (todayTokens > best.totalTokens) {
                children.push(label(`🏆 New record. Previous best ${compact(best.totalTokens)} on ${when}`, 'headroom-record'));
            } else {
                const pct = Math.round((todayTokens / best.totalTokens) * 100);
                children.push(row(`Best: ${compact(best.totalTokens)} on ${when}`, `today ${pct}% of PB`, 'headroom-dim', 'headroom-dim'));
            }
        }
        if (this._tokensError)
            children.push(note(`⚠ ${this._tokensError}`));
        this._tokensCard.reset(...children);
    }

    destroy() {
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        this._settings = null;
        for (const id of [this._limitsTimer, this._tokensTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._limitsTimer = this._tokensTimer = 0;
        this._label = this._meter = this._meterFill = null;
        super.destroy();
    }
});

export default class HeadroomExtension extends Extension {
    enable() {
        this._indicator = new Headroom(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
