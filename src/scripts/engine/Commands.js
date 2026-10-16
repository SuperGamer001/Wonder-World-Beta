/**
 * Commands — what a line of chat beginning with "/" does.
 *
 * They are run in one place: the game of the world's owner (the host of a
 * session). A guest's command is sent there as it was typed; that game looks
 * at who sent it, and whether they may, and does it. So there is one answer to
 * "is this player an operator", and one game changing the world — the others
 * see what came of it the way they see anything else the host's game does (the
 * clock, the weather, a block, a mob), or are told to do their part (`act`: a
 * player's own game is the one that moves them, hands them things, changes
 * their mode).
 *
 * Most commands need **operator status**. The world's owner always has it and
 * gives it with /op (or from the Players panel); it is kept with the world —
 * by who the player is (their `key`), not by what they are called, so a
 * change of name neither loses it nor hands it to somebody else of that name.
 *
 * This file knows nothing of the game itself: it reads a line, checks it, and
 * calls `api` — what world.js says the world can do:
 *
 *   players()                 → [{ id, name, key, x, y, z, owner }], everyone in the world
 *                               (two of one name: the later is "Name#2")
 *   isOp(player) → boolean;   setOp(player, on) — a player, or { name } for one
 *                               who is not here (to take it away);  ops() → [name]
 *   kick(playerId) → boolean  send a player away (the host's game can)
 *   pvp() / setPvp(on)        whether players can hurt each other
 *   act(playerId, action)     do something to one player, in their own game:
 *                             { k: 'mode', mode } | { k: 'tp', x, y, z } |
 *                             { k: 'give', item, n } | { k: 'heal' } | { k: 'kill' }
 *   hours() / setHours(h)     the time of day, 0 … 24
 *   weathers() → [id];  setWeather(id)      ('dynamic' is always one of them)
 *   mobs() → [type];    summon(type, x, y, z) → boolean
 *   hasItem(id) → boolean
 *   setBlock(x, y, z, NAME) → boolean
 *   seed() → number
 *   reply(actor, text)        a line for the player who asked, alone
 *   announce(text)            a line for everyone
 *
 * An `actor` is who asked: { id, name, x, y, z, owner } (owner: the world's).
 */

export const CHAT_MAX = 200;        // characters in a line of chat

const MODES = { survival: 'SURVIVAL', s: 'SURVIVAL', creative: 'CREATIVE', c: 'CREATIVE', spectator: 'SPECTATOR', sp: 'SPECTATOR' };
const TIMES = { sunrise: 6, dawn: 6, morning: 8, day: 9, noon: 12, midday: 12, afternoon: 15, sunset: 18, dusk: 18, night: 21, midnight: 0 };
const GIVE_MAX = 640, SUMMON_MAX = 16;

/** A line of text as chat may carry it: one line, no control characters, not too long. */
export function cleanChat(text) {
    return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, CHAT_MAX);
}

/** "/give "Big Al" torch 4" → { name: 'give', args: ['Big Al', 'torch', '4'] }; null if it is not a command. */
export function parseCommand(text) {
    text = cleanChat(text);
    if (text[0] !== '/') return null;
    const args = [];
    for (const m of text.slice(1).matchAll(/"([^"]*)"|(\S+)/g)) args.push(m[1] ?? m[2]);
    if (!args.length) return null;
    return { name: args.shift().toLowerCase(), args };
}

const clock = (h) => {
    const m = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const title = (s) => s.replace(/_/g, ' ');

export class CommandRunner {
    constructor(api) {
        this.api = api;
        const c = (usage, help, op, run) => ({ usage, help, op, run });
        this.commands = {
            help:      c('/help [command]', 'What the commands are, or how one is used.', false, this._help),
            list:      c('/list', 'Who is in the world.', false, this._list),
            seed:      c('/seed', 'The seed this world was made from.', false, this._seed),
            ops:       c('/ops', 'Who has operator status.', false, this._ops),
            say:       c('/say <text>', 'Say something to everyone, as an announcement.', true, this._say),
            op:        c('/op <player>', 'Give a player operator status.', true, this._op),
            deop:      c('/deop <player>', 'Take it away again.', true, this._deop),
            kick:      c('/kick <player>', 'Send a player away. They are not let back in while the world stays open.', true, this._kick),
            pvp:       c('/pvp <on|off>', 'Whether players can hurt each other.', true, this._pvp),
            time:      c('/time set <day|noon|sunset|night|midnight|0-24>  ·  /time add <hours>', 'Change the time of day.', true, this._time),
            weather:   c('/weather <type>', 'Change the weather ("dynamic" lets it change by itself again).', true, this._weather),
            gamemode:  c('/gamemode <survival|creative|spectator> [player]', 'Change how a player plays.', true, this._gamemode),
            tp:        c('/tp <player>  ·  /tp <x> <y> <z>  ·  /tp <who> <player>  ·  /tp <who> <x> <y> <z>', 'Move a player. "~" is where they are now: ~ ~10 ~ is ten blocks up.', true, this._tp),
            give:      c('/give <item> [count] [player]', 'Hand a player some of an item.', true, this._give),
            heal:      c('/heal [player]', 'Make a player well, fed and rested.', true, this._heal),
            kill:      c('/kill [player]', 'Kill a player.', true, this._kill),
            summon:    c('/summon <mob> [count]', 'Bring mobs to where you stand.', true, this._summon),
            setblock:  c('/setblock <x> <y> <z> <block>', 'Put a block somewhere ("air" removes one).', true, this._setblock),
        };
        this.aliases = { gm: 'gamemode', teleport: 'tp', '?': 'help', players: 'list', who: 'list' };
    }

    /** Run what `actor` typed. Returns true if it was a command (known or not). */
    run(actor, text) {
        const cmd = parseCommand(text);
        if (!cmd) return false;
        const name = this.aliases[cmd.name] ?? cmd.name;
        const def = Object.hasOwn(this.commands, name) ? this.commands[name] : null;
        if (!def) { this.api.reply(actor, `There is no command "/${cmd.name}". /help lists them.`); return true; }
        if (def.op && !this.mayOp(actor)) { this.api.reply(actor, `/${name} needs operator status.`); return true; }
        try {
            const said = def.run.call(this, actor, cmd.args);
            if (said === false) this.api.reply(actor, `Usage: ${def.usage}`);
        } catch (err) {
            this.api.reply(actor, `/${name} did not work: ${err?.message ?? err}`);
        }
        return true;
    }

    /** May this player use the operators' commands? The world's owner always may. */
    mayOp(actor) { return !!actor?.owner || (!!actor && this.api.isOp(actor)); }

    // ── Reading arguments ─────────────────────────────────────────────────────

    /** The player a name means: the name itself (any case), or the one name it begins. null: nobody, or more than one. */
    _player(name) {
        if (typeof name !== 'string' || !name) return null;
        const all = this.api.players(), n = name.toLowerCase();
        const exact = all.find(p => p.name.toLowerCase() === n);
        if (exact) return exact;
        const begin = all.filter(p => p.name.toLowerCase().startsWith(n));
        return begin.length === 1 ? begin[0] : null;
    }

    /** The player named, or — with no name — whoever asked. Says so, and returns null, if there is no such player. */
    _target(actor, name) {
        if (name === undefined) return this.api.players().find(p => p.id === actor.id) ?? actor;
        const p = this._player(name);
        if (!p) this.api.reply(actor, `There is no player "${name}" here.`);
        return p;
    }

    /** A coordinate: a number, or "~" (where `at` is) with an offset after it. NaN if it is neither. */
    _coord(text, at) {
        if (typeof text !== 'string') return NaN;
        if (text[0] === '~') { const d = text.length > 1 ? Number(text.slice(1)) : 0; return at + d; }
        return text.trim() === '' ? NaN : Number(text);
    }

    _place(args, at) {
        const x = this._coord(args[0], at.x), y = this._coord(args[1], at.y), z = this._coord(args[2], at.z);
        if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 2e6 || Math.abs(z) > 2e6 || y < -200 || y > 2000) return null;
        return { x, y, z };
    }

    // ── The commands ──────────────────────────────────────────────────────────

    _help(actor, [name]) {
        if (name) {
            const n = name.replace(/^\//, '').toLowerCase(), def = this.commands[this.aliases[n] ?? n];
            if (!def || !Object.hasOwn(this.commands, this.aliases[n] ?? n)) return void this.api.reply(actor, `There is no command "/${n}".`);
            this.api.reply(actor, `${def.usage} — ${def.help}${def.op ? ' (operators)' : ''}`);
            return;
        }
        const op = this.mayOp(actor);
        const names = Object.entries(this.commands).filter(([, d]) => op || !d.op).map(([n]) => `/${n}`);
        this.api.reply(actor, `Commands: ${names.join('  ')}`);
        this.api.reply(actor, op ? '/help <command> says how one is used.' : 'Most commands need operator status: the world\'s owner gives it with /op.');
    }

    _list(actor) {
        const all = this.api.players();
        this.api.reply(actor, `${all.length} here: ${all.map(p => p.name + (this.api.isOp(p) || p.owner ? '*' : '')).join(', ')}   (* operator)`);
    }

    _seed(actor) { this.api.reply(actor, `Seed: ${this.api.seed()}`); }

    _ops(actor) {
        const ops = this.api.ops();
        this.api.reply(actor, ops.length ? `Operators, besides the world's owner: ${ops.join(', ')}` : 'Only the world\'s owner is an operator.');
    }

    _say(actor, args) {
        if (!args.length) return false;
        this.api.announce(`[${actor.name}] ${args.join(' ')}`);
    }

    _op(actor, [name]) {
        if (!name) return false;
        const p = this._target(actor, name);
        if (!p) return;
        if (p.owner) return void this.api.reply(actor, `${p.name} owns this world, and is an operator already.`);
        if (this.api.isOp(p)) return void this.api.reply(actor, `${p.name} is an operator already.`);
        this.api.setOp(p, true);
        this.api.announce(`${actor.name} made ${p.name} an operator.`);
    }

    _deop(actor, [name]) {
        if (!name) return false;
        // Someone who is not here now can still have it taken away, by their whole name.
        const p = this._player(name), who = p?.name ?? name;
        if (p?.owner) return void this.api.reply(actor, 'The world\'s owner is always an operator.');
        const is = p ? this.api.isOp(p) : this.api.ops().some(n => n.toLowerCase() === name.toLowerCase());
        if (!is) return void this.api.reply(actor, `${who} is not an operator.`);
        this.api.setOp(p ?? { name }, false);
        this.api.announce(`${actor.name} took operator status from ${who}.`);
    }

    _kick(actor, [name]) {
        if (!name) return false;
        const p = this._target(actor, name);
        if (!p) return;
        if (p.id === actor.id) return void this.api.reply(actor, 'You cannot send yourself away. Save & Quit is the way out.');
        if (p.owner) return void this.api.reply(actor, 'The world\'s owner cannot be sent away from it.');
        if (!this.api.kick(p.id)) return void this.api.reply(actor, `${p.name} could not be sent away.`);
        this.api.announce(`${actor.name} removed ${p.name} from the game.`);
    }

    _pvp(actor, [how]) {
        if (how === undefined) return void this.api.reply(actor, `PvP is ${this.api.pvp() ? 'on: players can hurt each other' : 'off'}.`);
        const on = { on: true, off: false, true: true, false: false, yes: true, no: false }[String(how).toLowerCase()];
        if (on === undefined) return false;
        this.api.setPvp(on);
        this.api.announce(`${actor.name} turned PvP ${on ? 'on: players can hurt each other' : 'off'}.`);
    }

    _time(actor, [what, value]) {
        let h;
        if (what === 'set') {
            h = Object.hasOwn(TIMES, String(value).toLowerCase()) ? TIMES[String(value).toLowerCase()] : Number(value);
            if (value === undefined || !(h >= 0 && h <= 24)) return false;
        } else if (what === 'add') {
            const d = Number(value);
            if (value === undefined || !Number.isFinite(d) || Math.abs(d) > 1000) return false;
            h = (((this.api.hours() + d) % 24) + 24) % 24;
        } else if (what === undefined) {
            return void this.api.reply(actor, `It is ${clock(this.api.hours())}.`);
        } else return false;
        this.api.setHours(h % 24);
        this.api.announce(`${actor.name} set the time to ${clock(h)}.`);
    }

    _weather(actor, [type]) {
        const all = this.api.weathers();
        if (!type) return void this.api.reply(actor, `Weather: ${all.join(', ')}`);
        const want = type.toLowerCase();
        const id = all.find(w => w === want) ?? all.find(w => w.replace(/_/g, '') === want.replace(/[_-]/g, ''));
        if (!id) return void this.api.reply(actor, `There is no weather "${type}". /weather lists them.`);
        this.api.setWeather(id);
        this.api.announce(id === 'dynamic' ? `${actor.name} let the weather change by itself.` : `${actor.name} set the weather to ${title(id)}.`);
    }

    _gamemode(actor, [mode, name]) {
        const m = MODES[String(mode).toLowerCase()];
        if (!m) return false;
        const p = this._target(actor, name);
        if (!p) return;
        this.api.act(p.id, { k: 'mode', mode: m });
        const label = m[0] + m.slice(1).toLowerCase();
        this.api.announce(p.id === actor.id ? `${actor.name} is now in ${label} mode.` : `${actor.name} put ${p.name} in ${label} mode.`);
    }

    _tp(actor, args) {
        const me = this._target(actor);
        let who = me, to = null, label = '';
        if (args.length === 1) {
            const p = this._target(actor, args[0]);
            if (!p) return;
            to = p; label = p.name;
        } else if (args.length === 2) {
            who = this._target(actor, args[0]);
            const p = who && this._target(actor, args[1]);
            if (!p) return;
            to = p; label = p.name;
        } else if (args.length === 3) {
            to = this._place(args, me);
        } else if (args.length === 4) {
            who = this._target(actor, args[0]);
            if (!who) return;
            to = this._place(args.slice(1), who);
        } else return false;
        if (!to) return false;
        if (!label) label = `${Math.round(to.x)}, ${Math.round(to.y)}, ${Math.round(to.z)}`;
        if (who.id === to.id) return void this.api.reply(actor, `${who.name} is there already.`);
        this.api.act(who.id, { k: 'tp', x: to.x, y: to.y, z: to.z });
        this.api.announce(`${actor.name} sent ${who.id === actor.id ? 'themselves' : who.name} to ${label}.`);
    }

    _give(actor, args) {
        if (!args.length) return false;
        // The item first — or, as it is written elsewhere, the player first.
        let rest = args, name;
        if (!this.api.hasItem(args[0].toLowerCase()) && args.length > 1 && this.api.hasItem(args[1].toLowerCase())) { name = args[0]; rest = args.slice(1); }
        const item = rest[0].toLowerCase();
        if (!this.api.hasItem(item)) return void this.api.reply(actor, `There is no item "${rest[0]}".`);
        let n = 1;
        if (rest[1] !== undefined && /^\d+$/.test(rest[1])) { n = Number(rest[1]); rest = [rest[0], ...rest.slice(2)]; }
        if (rest[1] !== undefined) name = rest[1];
        if (!(n >= 1 && n <= GIVE_MAX)) return void this.api.reply(actor, `Between 1 and ${GIVE_MAX} at a time.`);
        const p = this._target(actor, name);
        if (!p) return;
        this.api.act(p.id, { k: 'give', item, n });
        this.api.announce(`${actor.name} gave ${p.id === actor.id ? 'themselves' : p.name} ${n} × ${title(item)}.`);
    }

    _heal(actor, [name]) {
        const p = this._target(actor, name);
        if (!p) return;
        this.api.act(p.id, { k: 'heal' });
        this.api.announce(`${actor.name} healed ${p.id === actor.id ? 'themselves' : p.name}.`);
    }

    _kill(actor, [name]) {
        const p = this._target(actor, name);
        if (!p) return;
        this.api.act(p.id, { k: 'kill' });
        this.api.announce(p.id === actor.id ? `${actor.name} ended it all.` : `${actor.name} struck ${p.name} down.`);
    }

    _summon(actor, [type, count]) {
        if (!type) return void this.api.reply(actor, `Mobs: ${this.api.mobs().join(', ')}`);
        const id = type.toLowerCase();
        if (!this.api.mobs().includes(id)) return void this.api.reply(actor, `There is no mob "${type}". /summon lists them.`);
        const n = count === undefined ? 1 : Number(count);
        if (!Number.isInteger(n) || n < 1 || n > SUMMON_MAX) return void this.api.reply(actor, `Between 1 and ${SUMMON_MAX} at a time.`);
        const at = this._target(actor);
        let made = 0;
        for (let i = 0; i < n; i++) {
            // Round whoever asked, not on top of them — nor all in one spot.
            const a = (i / n) * Math.PI * 2 + 0.6, r = n === 1 ? 2 : 2.5 + (i % 3) * 0.8;
            if (this.api.summon(id, at.x + Math.sin(a) * r, at.y + 0.5, at.z + Math.cos(a) * r)) made++;
        }
        if (!made) return void this.api.reply(actor, 'Nothing came.');
        this.api.announce(`${actor.name} summoned ${made === 1 ? `a ${title(id)}` : `${made} × ${title(id)}`}.`);
    }

    _setblock(actor, args) {
        if (args.length !== 4) return false;
        const at = this._place(args, this._target(actor));
        if (!at) return false;
        const name = args[3].toUpperCase();
        if (!this.api.setBlock(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z), name)) {
            return void this.api.reply(actor, `There is no block "${args[3]}" — or that place is not loaded here.`);
        }
        this.api.announce(`${actor.name} put ${title(name.toLowerCase())} at ${Math.floor(at.x)}, ${Math.floor(at.y)}, ${Math.floor(at.z)}.`);
    }
}
