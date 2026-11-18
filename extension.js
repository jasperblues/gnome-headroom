// Token Bar: AI plan limits (CodexBar CLI) + today's token burn (ccusage) in the GNOME top bar.
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
const CODEXBAR = `${HOME}/.local/bin/codexbar`;
const CODEXBAR_APP = `${HOME}/.local/bin/codexbar-linux`;
const PROVIDER = 'claude';
// ccusage is usually an nvm-managed global, which GNOME Shell's PATH doesn't see.
const CCUSAGE_ARGV = ['/bin/bash', '-c',
    'command -v ccusage >/dev/null || . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; ' +
    'exec ccusage daily --json --offline'];

const LIMITS_EVERY_S = 300;
const TOKENS_EVERY_S = 120;
const STALE_ON_OPEN_S = 60;
const TRACK_PX = 292;
const SPARKS = '▁▂▃▄▅▆▇█';

async function run(argv, cancellable) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, cancellable);
    if (!proc.get_successful())
        throw new Error(`${argv[0]} exited with ${proc.get_exit_status()}`);
    return stdout;
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

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass ?? '', ...props});
}

function row(left, right, leftClass, rightClass) {
    const box = new St.BoxLayout({x_expand: true});
    box.add_child(label(left, leftClass, {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    box.add_child(label(right, rightClass ?? 'token-bar-row-value', {y_align: Clutter.ActorAlign.CENTER}));
    return box;
}

function bar(usedPercent) {
    const left = 100 - usedPercent;
    const track = new St.Widget({style_class: 'token-bar-track', style: `width: ${TRACK_PX}px;`});
    const fill = new St.Widget({style_class: 'token-bar-fill'});
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
        this.box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'token-bar-card', x_expand: true});
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

const TokenBar = GObject.registerClass(
class TokenBar extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Token Bar');
        this._ext = ext;
        this._cancellable = new Gio.Cancellable();
        this._limits = null;
        this._tokens = null;
        this._limitsError = null;
        this._tokensError = null;
        this._limitsAt = 0;
        this._tokensAt = 0;

        this._label = label('…', 'token-bar-panel-label', {y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);

        this._limitsCard = new Card();
        this._tokensCard = new Card();
        this.menu.addMenuItem(this._limitsCard);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._tokensCard);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Refresh', () => this._refresh(true));
        this.menu.addAction('Open CodexBar', () => {
            try {
                Gio.Subprocess.new([CODEXBAR_APP, '--usage'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.notifyError('Token Bar', `Couldn't start CodexBar: ${e.message}`);
            }
        });

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(false, STALE_ON_OPEN_S);
        });

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
        try {
            const out = await run([CODEXBAR, 'usage', '--provider', PROVIDER, '--json'], this._cancellable);
            const entry = JSON.parse(out).find(e => e.provider === PROVIDER) ?? null;
            this._limits = entry;
            this._limitsError = entry ? null : `No ${PROVIDER} data`;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._limitsError = e.message;
        }
        this._limitsAt = Date.now() / 1000;
        this._render();
    }

    async _refreshTokens() {
        try {
            const out = await run(CCUSAGE_ARGV, this._cancellable);
            this._tokens = JSON.parse(out).daily ?? [];
            this._tokensError = null;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._tokensError = e.message;
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
        // Panel: tightest main window's % left, then today's tokens.
        const main = this._windows().filter(w => !this._limits.usage.extraRateWindows?.some(x => x.window === w.window));
        const tightest = main.reduce((a, w) => (!a || w.window.usedPercent > a.window.usedPercent ? w : a), null);
        const today = this._today();
        const parts = [];
        if (tightest)
            parts.push(`${100 - Math.round(tightest.window.usedPercent)}%`);
        if (today)
            parts.push(compact(today.totalTokens));
        else if (this._tokens)
            parts.push('0');
        this._label.text = parts.length ? parts.join(' · ') : (this._limitsError || this._tokensError ? '⚠' : '…');
        this._label.remove_style_class_name('warn');
        this._label.remove_style_class_name('crit');
        const sev = tightest ? severity(100 - tightest.window.usedPercent) : null;
        if (sev)
            this._label.add_style_class_name(sev);

        this._renderLimits();
        this._renderTokens(today);
    }

    _renderLimits() {
        if (!this._limits) {
            this._limitsCard.reset(
                label('Plan limits', 'token-bar-heading'),
                label(this._limitsError ?? 'Loading…', 'token-bar-dim'));
            return;
        }
        const u = this._limits.usage;
        const children = [row('Claude', u.loginMethod ?? '', 'token-bar-heading', 'token-bar-dim')];
        for (const w of this._windows()) {
            const used = w.window.usedPercent ?? 0;
            children.push(row(w.title, `${100 - Math.round(used)}% left`));
            children.push(bar(used));
            const detail = [until(w.window.resetsAt) && `Resets in ${until(w.window.resetsAt)}`, w.pace]
                .filter(Boolean).join(' · ');
            if (detail)
                children.push(label(detail, 'token-bar-dim'));
        }
        if (this._limitsError)
            children.push(label(`⚠ ${this._limitsError}`, 'token-bar-dim'));
        this._limitsCard.reset(...children);
    }

    _renderTokens(today) {
        if (!this._tokens) {
            this._tokensCard.reset(
                label('Today', 'token-bar-heading'),
                label(this._tokensError ?? 'Loading…', 'token-bar-dim'));
            return;
        }
        const days = this._tokens;
        const todayTokens = today?.totalTokens ?? 0;
        const children = [row('Today', today ? `${money(today.totalCost)} API-equivalent` : '', 'token-bar-heading', 'token-bar-dim')];
        children.push(label(`${compact(todayTokens)} tokens`, 'token-bar-big'));

        if (today) {
            children.push(label(
                `out ${compact(today.outputTokens)} · in ${compact(today.inputTokens)} · ` +
                `cache read ${compact(today.cacheReadTokens)} · write ${compact(today.cacheCreationTokens)}`,
                'token-bar-dim'));
            const models = [...(today.modelBreakdowns ?? [])].sort((a, b) => b.cost - a.cost);
            for (const m of models) {
                const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
                children.push(row(shortModel(m.modelName), `${compact(total)} · ${money(m.cost)}`, 'token-bar-dim', 'token-bar-dim'));
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
        const spark = week.map(v => (v === 0 ? ' ' : SPARKS[Math.min(7, Math.floor((v / peak) * 7.999))])).join('');
        const weekTotal = week.reduce((a, b) => a + b, 0);
        const sparkRow = new St.BoxLayout({x_expand: true});
        sparkRow.add_child(label('Last 7 days', 'token-bar-dim', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const sparkLabel = label(spark, 'token-bar-spark', {y_align: Clutter.ActorAlign.CENTER});
        sparkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        sparkRow.add_child(sparkLabel);
        children.push(sparkRow);
        children.push(row(`${compact(weekTotal)} this week`, `avg ${compact(weekTotal / 7)}/day`, 'token-bar-dim', 'token-bar-dim'));

        // Personal best (excluding today), for the tokenmaxers.
        const past = days.filter(d => d.period !== today?.period);
        const best = past.reduce((a, d) => (!a || d.totalTokens > a.totalTokens ? d : a), null);
        if (best) {
            const when = GLib.DateTime.new_from_iso8601(`${best.period}T12:00:00Z`, null)?.format('%-d %b') ?? best.period;
            if (todayTokens > best.totalTokens) {
                children.push(label(`🏆 New record. Previous best ${compact(best.totalTokens)} on ${when}`, 'token-bar-record'));
            } else {
                const pct = Math.round((todayTokens / best.totalTokens) * 100);
                children.push(row(`Best: ${compact(best.totalTokens)} on ${when}`, `today ${pct}% of PB`, 'token-bar-dim', 'token-bar-dim'));
            }
        }
        if (this._tokensError)
            children.push(label(`⚠ ${this._tokensError}`, 'token-bar-dim'));
        this._tokensCard.reset(...children);
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of [this._limitsTimer, this._tokensTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._limitsTimer = this._tokensTimer = 0;
        this._label = null;
        super.destroy();
    }
});

export default class TokenBarExtension extends Extension {
    enable() {
        this._indicator = new TokenBar(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
