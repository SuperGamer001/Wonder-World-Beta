/**
 * OnlineSession — this game's line to the others when the world is online.
 *
 * It is to an online room what Multiplayer.js is to the game's own server:
 * world.js is handed one or the other and uses them alike — the same `id`,
 * `hostId`, `players`, `isHost`, `alone`, the same `on…` callbacks, the same
 * `state()`, `block()`, `profile()`, `atmos()`, `all()`, `host()`, `to()`,
 * `close()`. What differs is underneath.
 *
 * There is no game server in the middle. The games talk through Ably
 * (ably.com), which only carries messages; so everything a server would have
 * decided is decided by one of two things:
 *
 *   • The token (online/auth.js) decides who may speak where. Ably stamps
 *     every message with its sender's `clientId`, which comes from the token
 *     and cannot be chosen, and only the host's token may publish on the
 *     room's host channel. So who said a thing, and whether it is the host's
 *     word, are never taken from the message itself.
 *   • The host's game decides the rest: who is let in and under which number,
 *     who is sent away, and what a block ends up as when two players disagree
 *     or one reaches too far (`fix`). The world is the host's, on the host's
 *     disk.
 *
 * A room is found by a code. `open()` makes one (this game hosts);
 * `enter(code)` joins one. `join()` then only hands back the welcome, so a
 * world can be loaded after the room is in hand.
 *
 * A guest has no way to the host's machine, so what it needs of the host's
 * world — the chunks the host has data for, its own saved place — is asked
 * through the room (`manifest`, `chunk`, `loadState`, `saveState`), and the
 * host's game answers (`serve`).
 *
 * Every message is counted against the Ably plan, once sent and once for
 * each game that hears it, so things are said no oftener than they must be
 * (`RATE`): a player standing still says so every two seconds, not fifteen
 * times a second.
 *
 * Ably's SDK is handed in (`Ably`: the page's global, or a stand-in in a
 * test), so this file has no imports a browser cannot resolve.
 */
import {
    PROTOCOL, MSG, RATE, REACH, WORLD, PART_BYTES, ChunkStatus, HARD_MAX_PLAYERS, MAX_LOCAL_PLAYERS,
    channels, cleanCode, cleanName, cleanSkin,
} from './OnlineProtocol.js';

const REQUEST_MS = 12000;
const WELCOME_MS = 12000;
const RETRY_MS = 600;
const MAX_CHUNK_REQUESTS = 8;        // asked of the host at once
const MAX_STATE_BYTES = 56000;       // a saved place must fit one message

export class OnlineError extends Error {
    /** @param {string} reason a word sessionOver() (src/players.js) has a sentence for */
    constructor(reason, message) { super(message ?? reason); this.reason = reason; }
}

const b64url = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

/** Whatever Ably hands over for binary data (an ArrayBuffer in a page, a Buffer in Node), as bytes. */
function toBytes(d) {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null;
}

// ── The token service ─────────────────────────────────────────────────────────

/**
 * This game, to the token service (online/auth.js). Who it is there is a
 * secret it made up once and keeps (`storage`); nothing is signed up for.
 */
export class OnlineAuth {
    /**
     * @param {object} o
     * @param {string} o.url           the token service, e.g. https://online.example.com
     * @param {typeof fetch} [o.fetchFn]
     * @param {{ get(): string|null, set(v: string): void }} [o.storage]   where the secret is kept
     */
    constructor({ url, fetchFn = (...a) => fetch(...a), storage = null }) {
        this.url = String(url).replace(/\/+$/, '');
        this._fetch = fetchFn;
        this._storage = storage;
        this._device = null;
    }

    device() {
        if (this._device) return this._device;
        let d = this._storage?.get() ?? null;
        if (typeof d !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(d)) {
            d = b64url(crypto.getRandomValues(new Uint8Array(24)));
            this._storage?.set(d);
        }
        return this._device = d;
    }

    async _post(op, body) {
        let res;
        try {
            res = await this._fetch(`${this.url}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch { throw new OnlineError('unreachable'); }
        if (res.status === 429) throw new OnlineError('busy');
        if (res.status === 403) throw new OnlineError('auth');
        if (!res.ok) throw new OnlineError('unreachable');
        const r = await res.json().catch(() => null);
        if (!r?.tokenRequest || !r.clientId) throw new OnlineError('unreachable');
        return r;
    }

    /** A new room, and this game as its host: `{ code, ticket, clientId, tokenRequest }`. */
    host() { return this._post('host', { device: this.device(), slot: 0 }); }
    /** A token for a room: as its host with the ticket, else as a guest. */
    token(code, slot, ticket = null) { return this._post('token', { code, device: this.device(), slot, ...(ticket ? { ticket } : {}) }); }
}

// ── The session ───────────────────────────────────────────────────────────────

export class OnlineSession {
    /**
     * @param {{ Realtime: Function }} Ably   Ably's SDK
     * @param {OnlineAuth} auth
     * @param {{ now?: () => number }} [o]
     */
    constructor(Ably, auth, { now = () => Date.now() } = {}) {
        this._Ably = Ably;
        this.auth = auth;
        this._now = now;
        this.online = true;          // world.js: this is not the game's own server
        this.id = 0;
        this.hostId = 0;
        this.players = new Map();    // the others: id → { id, name, skin, state, client }
        this.code = '';              // the room's code, to give to whoever should join
        this.world = null;           // the host's world, as a guest's game needs it
        this.max = HARD_MAX_PLAYERS;
        this.down = false;           // the line has dropped and is being picked up
        this.locked = false;

        this.onJoined = null;        // (player)
        this.onLeft = null;          // (id)
        this.onState = null;         // (id, s)
        this.onBlock = null;         // (x, y, z, block)
        this.onBlockRejected = null; // unused here: a block the host will not have comes back as an ordinary block
        this.onProfile = null;       // (player)
        this.onAtmos = null;         // (a)
        this.onMsg = null;           // (from, d)
        this.onClosed = null;        // (reason)
        this.onDown = null;          // (down: boolean) — the line dropped / came back

        /** The host's game answers these for its guests (world.js sets them). */
        this.serve = { manifest: null, chunk: null, pload: null, psave: null };
        /** The host's game says what a block is now, or null where it has no chunk loaded (world.js sets it). */
        this.blockAt = null;

        this._rt = null;
        this._ch = null;             // { all, host, up, inbox }
        this._out = new Map();       // the host: each guest's own channel, by name
        this._lateIds = null;
        this._names = null;
        this._client = '';           // this game's clientId
        this._hostClient = '';
        this._hello = null;
        this._welcome = null;
        this._closed = false;
        this._ready = false;

        this._ids = new Map();       // clientId → id: who the host has let in (the host's own copy is the original)
        this._members = new Map();   // clientId → { name, skin, … }: who is present, by their own account
        this._conns = new Map();     // clientId → the connections they are present on
        this._everIds = new Map();   // the host: a player who comes back keeps their number
        this._nextId = 2;
        this._banned = new Set();    // the host: devices sent away

        this._stateAt = 0; this._stateSent = ''; this._stateNext = null;
        this._mobsAt = 0; this._mobInfo = null;
        this._atmosAt = 0;
        this._rid = 0;
        this._asks = new Map();      // rid → { resolve, timer, parts }
        this._paceAt = 0; this._paceQueue = []; this._paceTimer = null;
        this._chunkWaiting = []; this._chunkActive = 0;
    }

    get isHost() { return this.id !== 0 && this.id === this.hostId; }
    get alone() { return this.players.size === 0; }
    get connected() { return !!this._rt && !this._closed && !this.down; }

    // ── Getting into a room ───────────────────────────────────────────────────

    /**
     * Host a world online. Resolves with the welcome (as `join()` gives it).
     * @param {object} hello  { version, content, worldGen, name, skin, slot }
     * @param {object} world  the world as a guest's game needs it (Online.js: describe)
     */
    async open(hello, world, maxPlayers = HARD_MAX_PLAYERS) {
        this._hello = hello;
        this.world = world;
        this.max = Math.max(1, Math.min(HARD_MAX_PLAYERS, maxPlayers | 0));
        for (let tries = 0; ; tries++) {
            const grant = await this.auth.host();
            await this._connect(grant.code, 0, grant, grant.ticket);
            const ch = this._ch;
            try {
                await ch.all.attach();
                // Codes are made at random and nobody keeps a list: on the (very) off chance this one is in use, another.
                const there = (await ch.all.presence.get()).filter(m => m.clientId !== this._client);
                if (there.length && tries < 3) { this._drop(); continue; }
                if (there.length) throw new OnlineError('unreachable');
                this.id = this.hostId = 1;
                this._hostClient = this._client;
                this._listen();
                await ch.up.subscribe((m) => this._onUp(m));
                await ch.all.presence.enter(this._presenceData());
            } catch (e) {
                this._drop();
                throw e instanceof OnlineError ? e : new OnlineError('unreachable', e?.message);
            }
            break;
        }
        this._ready = true;
        this._welcome = { id: 1, hostId: 1, players: [], edits: [], atmos: null };
        return this._welcome;
    }

    /** Join the game with this code. */
    async enter(code, hello) {
        code = cleanCode(code);
        if (!code) throw new OnlineError('code');
        this._hello = hello;
        const slot = hello.slot | 0;
        const grant = await this.auth.token(code, slot);
        await this._connect(code, slot, grant, null);
        const ch = this._ch;
        try {
            const letter = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new OnlineError('code')), WELCOME_MS);
                this._onLetter = (kind, d) => { clearTimeout(timer); kind === MSG.WELCOME ? resolve(d) : reject(new OnlineError(REFUSALS.has(d?.why) ? d.why : 'code')); };
            });
            letter.catch(() => {});
            await ch.inbox.subscribe((m) => this._onInbox(m));
            await ch.host.subscribe((m) => this._onHost(m));
            this._listen();
            // Nobody there: no game has this code (or it has ended). Nothing is left behind to say which.
            const there = await ch.all.presence.get();
            if (!there.some(m => m.clientId !== this._client)) throw new OnlineError('code');
            for (const m of there) {
                this._member(m.clientId, m.data);
                if (!this._conns.has(m.clientId)) this._conns.set(m.clientId, new Set());
                this._conns.get(m.clientId).add(m.connectionId);
            }
            await ch.all.presence.enter(this._presenceData());
            const w = await letter;
            if (!Number.isInteger(w?.id) || w.id < 2 || !w.world || typeof w.ids !== 'object') throw new OnlineError('unreachable');
            this.id = w.id; this.hostId = 1; this._hostClient = String(w.host ?? '');
            this.world = w.world; this.max = w.max | 0;
            this._setIds(this._lateIds ?? w.ids, true);
            this._lateIds = null;
            this._ready = true;
            this._welcome = { id: this.id, hostId: 1, players: [...this.players.values()], edits: [], atmos: w.atmos ?? null };
            return this._welcome;
        } catch (e) {
            this._drop();
            throw e instanceof OnlineError ? e : new OnlineError('unreachable', e?.message);
        }
    }

    /** As Multiplayer.join: the welcome. The room is already in hand (open / enter). */
    async join() { return this._welcome; }

    /** Connect to Ably as one player of one room. `grant`: what the token service just gave (used for the first token). */
    async _connect(code, slot, grant, ticket) {
        this.code = code;
        this._client = grant.clientId;
        this._closed = false;
        let first = grant;
        let rt;
        try {
            rt = new this._Ably.Realtime({
                // Ably asks for a token when it connects and again before each runs out.
                authCallback: (_params, callback) => {
                    const have = first; first = null;
                    (have ? Promise.resolve(have) : this.auth.token(code, slot, ticket))
                        .then((g) => callback(null, g.tokenRequest), (e) => callback(e?.reason ?? 'auth', null));
                },
                echoMessages: false,       // what this game says is not sent back to it (and not counted)
                closeOnUnload: true,
            });
        } catch (e) { throw new OnlineError('unreachable', e?.message); }
        this._rt = rt;
        this._out.clear();
        const n = this._names = channels(code);
        const host = !!ticket;
        const get = (name, modes) => rt.channels.get(name, { modes });
        this._ch = {
            all: get(n.all, ['PUBLISH', 'SUBSCRIBE', 'PRESENCE', 'PRESENCE_SUBSCRIBE']),
            host: get(n.host, host ? ['PUBLISH'] : ['SUBSCRIBE']),
            up: get(n.up, host ? ['SUBSCRIBE'] : ['PUBLISH']),
            inbox: host ? null : get(n.to(this._client), ['SUBSCRIBE']),
        };
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => done(new OnlineError('unreachable')), REQUEST_MS);
            const done = (err) => { clearTimeout(timer); rt.connection.off(seen); err ? reject(err) : resolve(); };
            const seen = (change) => {
                if (change.current === 'connected') done();
                else if (change.current === 'failed' || change.current === 'suspended' || change.current === 'closed') {
                    done(new OnlineError(change.reason?.statusCode === 401 || change.reason?.statusCode === 403 ? 'auth' : 'unreachable'));
                }
            };
            rt.connection.on(seen);
            if (rt.connection.state === 'connected') done();
        }).catch((e) => { this._drop(); throw e; });

        rt.connection.on((change) => {
            if (this._closed || rt !== this._rt) return;
            if (change.current === 'disconnected' || change.current === 'connecting') {
                if (!this.down && this._ready) { this.down = true; this.onDown?.(true); }
            } else if (change.current === 'connected') {
                if (this.down) { this.down = false; this.onDown?.(false); }
            } else if (change.current === 'suspended' || change.current === 'failed' || change.current === 'closed') {
                // Away longer than Ably keeps a place (two minutes), or refused: what was said meanwhile is gone.
                this._over('lost');
            }
        });
    }

    _presenceData() {
        const h = this._hello;
        return { v: PROTOCOL, version: String(h.version ?? ''), content: String(h.content ?? ''), worldGen: h.worldGen | 0, name: cleanName(h.name), skin: cleanSkin(h.skin) };
    }

    // ── Hearing ───────────────────────────────────────────────────────────────

    _listen() {
        const ch = this._ch;
        // (Refused or failed, the room is simply not joined: open() and enter() find that out for themselves.)
        ch.all.subscribe((m) => this._onAll(m))?.catch?.(() => {});
        ch.all.presence.subscribe((m) => this._onPresence(m))?.catch?.(() => {});
        // A guest that Ably could not keep the thread for has missed blocks, and has no way to know which.
        const lost = (change) => { if (this._ready && !this.isHost && change?.resumed === false) this._over('lost'); };
        for (const c of [ch.all, ch.host]) { c.on?.('update', lost); }
    }

    /** Somebody is present (or has changed what they say of themselves). */
    _member(client, data) {
        if (typeof client !== 'string' || !client) return null;
        const d = data && typeof data === 'object' ? data : {};
        const m = { v: d.v, version: String(d.version ?? ''), content: String(d.content ?? ''), worldGen: d.worldGen | 0, name: cleanName(d.name), skin: cleanSkin(d.skin) };
        this._members.set(client, m);
        return m;
    }

    _onPresence(m) {
        if (this._closed) return;
        const client = m.clientId;
        // Somebody is present once for each connection of theirs (a page reloaded is, for a moment, two):
        // they have left when the last has.
        const conns = this._conns.get(client) ?? new Set();
        if (m.action === 'leave' || m.action === 'absent') {
            conns.delete(m.connectionId);
            if (conns.size) return;
            this._conns.delete(client);
            this._members.delete(client);
            if (this.isHost) return this._gone(client);
            if (client === this._hostClient && this._ready) return this._over('host');
            return this._reconcile();
        }
        conns.add(m.connectionId);
        this._conns.set(client, conns);
        const member = this._member(client, m.data);
        if (!member || client === this._client) return;
        if (this.isHost) {
            if (!this._ids.has(client)) return this._admit(client, member);
            // Somebody already in, arriving again (their page was reloaded): welcomed again, as who they were.
            if (m.action === 'enter') this._welcomeTo(client);
            return this._reconcile();
        }
        this._reconcile();
    }

    /** The players, from who the host has let in and what each says of themselves; the difference is passed on. */
    _reconcile(quiet = false) {
        const seen = new Set();
        for (const [client, id] of this._ids) {
            if (client === this._client) continue;
            const m = this._members.get(client);
            if (!m && !this.isHost) continue;          // let in, not yet seen (or just gone): the host's list says when they have left
            seen.add(id);
            const p = this.players.get(id);
            const name = m?.name ?? p?.name ?? 'Player', skin = m?.skin ?? p?.skin ?? {}, key = JSON.stringify(skin);
            if (!p) {
                const fresh = { id, name, skin, state: null, client, connected: true, _skin: key };
                this.players.set(id, fresh);
                if (!quiet) this.onJoined?.(fresh);
            } else if (p.name !== name || p._skin !== key) {
                p.name = name; p.skin = skin; p._skin = key;
                if (!quiet) this.onProfile?.(p);
            }
        }
        for (const id of [...this.players.keys()]) {
            if (!seen.has(id)) { this.players.delete(id); if (!quiet) this.onLeft?.(id); }
        }
    }

    /** A guest: the host's list of who is in the room. */
    _setIds(ids, quiet = false) {
        const next = new Map();
        for (const [client, id] of Object.entries(ids ?? {})) if (Number.isInteger(id) && id >= 1 && id < 100000) next.set(client, id);
        this._ids = next;
        // Not on it any more: sent away.
        if (this._ready && !next.has(this._client)) return this._over('kicked');
        this._reconcile(quiet);
    }

    /** Who said this, as a player: only somebody the host has let in is heard. */
    _from(m) {
        const id = this._ids.get(m.clientId);
        return id === undefined || m.clientId === this._client ? null : this.players.get(id) ?? null;
    }

    _onAll(m) {
        if (this._closed || !this._ready) return;
        const p = this._from(m);
        if (!p) return;
        const d = m.data;
        if (m.name === MSG.STATE) {
            if (!Array.isArray(d) || d.length > 16 || !d.every(Number.isFinite)) return;
            p.state = d;
            this.onState?.(p.id, d);
        } else if (m.name === MSG.BLOCK) {
            this._onBlock(p, d);
        } else if (m.name === MSG.SAY) {
            if (d && typeof d === 'object') this.onMsg?.(p.id, d);
        }
    }

    _onBlock(p, d) {
        if (!Array.isArray(d) || d.length !== 5 || !d.every(Number.isInteger)) return;
        const [x, y, z, b, was] = d;
        if (Math.abs(x) > WORLD.LIMIT_XZ || Math.abs(z) > WORLD.LIMIT_XZ || y < WORLD.MIN_Y || y > WORLD.MAX_Y ||
            b < 0 || b > WORLD.MAX_BLOCK_ID || was < 0 || was > WORLD.MAX_BLOCK_ID) return;
        if (!this.isHost) return this.onBlock?.(x, y, z, b);

        // The host's game is where the world is: what it ends up with is what everyone ends up with.
        const s = p.state;
        if (s) {
            const reach = b === WORLD.WATER || was === WORLD.WATER ? REACH.FLUID : REACH.BLOCK;
            if (Math.hypot(x + 0.5 - s[0], y + 0.5 - s[1], z + 0.5 - s[2]) > reach) {
                // Further than its player could reach: not done here, and put back wherever it was.
                const now = this.blockAt?.(x, y, z);
                return this._publish(this._ch.host, MSG.FIX, [x, y, z, now ?? was]);
            }
        }
        const now = this.blockAt?.(x, y, z);
        this.onBlock?.(x, y, z, b);
        // Its sender had not seen what this block had become (two players at one block at once): the games
        // heard the two changes in different orders. All of them are told how it stands here.
        if (now !== null && now !== undefined && now !== was) this._publish(this._ch.host, MSG.FIX, [x, y, z, b]);
    }

    /** A guest: what the host says to everyone. Only the host's token can publish here. */
    _onHost(m) {
        if (this._closed) return;
        const d = m.data;
        // (One that comes while this game is still being welcomed is kept for when it has been.)
        if (m.name === MSG.ROSTER) { if (this._ready) this._setIds(d?.ids); else this._lateIds = d?.ids; }
        else if (!this._ready) return;
        else if (m.name === MSG.ATMOS) this.onAtmos?.(d);
        else if (m.name === MSG.SAY) { if (d && typeof d === 'object') this.onMsg?.(this.hostId, d); }
        else if (m.name === MSG.FIX) {
            if (Array.isArray(d) && d.length === 4 && d.every(Number.isInteger)) this.onBlock?.(d[0], d[1], d[2], d[3]);
        } else if (m.name === MSG.BYE) this._over('host');
    }

    /** A guest: what the host says to this game alone. */
    _onInbox(m) {
        if (this._closed) return;
        const name = String(m.name ?? '');
        if (name === MSG.WELCOME || name === MSG.REFUSE) return this._onLetter?.(name, m.data);
        if (name === MSG.KICK) return this._over('kicked');
        if (name === MSG.TO) { if (this._ready && m.data && typeof m.data === 'object') this.onMsg?.(this.hostId, m.data); return; }
        if (!name.startsWith(MSG.REPLY + '|')) return;
        // r|rid            an answer, as it is
        // r|rid|x          the host could not answer
        // r|rid|s|i|n      part i of n of an answer in bytes, with status s
        const f = name.split('|'), ask = this._asks.get(Number(f[1]));
        if (!ask) return;
        const finish = (v) => { clearTimeout(ask.timer); this._asks.delete(Number(f[1])); ask.resolve(v); };
        if (f.length === 2) return finish(m.data ?? {});
        if (f[2] === 'x') return finish(null);
        const bytes = toBytes(m.data), i = Number(f[3]), n = Number(f[4]);
        if (!bytes || i !== ask.parts.length || !(n >= 1 && n <= 64)) return finish(null);
        ask.parts.push(bytes);
        if (ask.parts.length < n) return;
        let size = 0;
        for (const part of ask.parts) size += part.length;
        const whole = new Uint8Array(size);
        let at = 0;
        for (const part of ask.parts) { whole.set(part, at); at += part.length; }
        finish({ s: Number(f[2]), d: whole });
    }

    // ── The host: who is in the room ──────────────────────────────────────────

    _admit(client, member) {
        const refuse = (why) => this._publish(this._names.to(client), MSG.REFUSE, { why });
        const device = client.slice(0, -2);
        if (this._banned.has(device)) return refuse('kicked');
        if (member.v !== PROTOCOL || member.worldGen < (this.world?.worldGen ?? 0)) return refuse('update');
        if (member.content !== this._hello.content) return refuse('content');
        if (this.locked) return refuse('locked');
        if (this._ids.size + 1 >= this.max) return refuse('full');
        let local = 0;
        for (const c of this._ids.keys()) if (c.slice(0, -2) === device) local++;
        if (local + (device === this._client.slice(0, -2) ? 1 : 0) >= MAX_LOCAL_PLAYERS) return refuse('full');

        let id = this._everIds.get(client);
        if (!id) this._everIds.set(client, id = this._nextId++);
        this._ids.set(client, id);
        this._reconcile();
        this._welcomeTo(client);
        this._publish(this._ch.host, MSG.ROSTER, { ids: this._roster() });
    }

    _welcomeTo(client) {
        this._publish(this._names.to(client), MSG.WELCOME, { id: this._ids.get(client), host: this._client, world: this.world, max: this.max, ids: this._roster(), atmos: this._atmos ?? null });
    }

    _roster() {
        const ids = { [this._client]: 1 };
        for (const [client, id] of this._ids) ids[client] = id;
        return ids;
    }

    /** A guest has gone (left, or sent away). */
    _gone(client) {
        if (!this._ids.delete(client)) return;
        this._reconcile();
        this._publish(this._ch.host, MSG.ROSTER, { ids: this._roster() });
    }

    /** The host: send a player away. Their game is told; everyone else stops hearing them. */
    kick(id) {
        const p = this.isHost && this.players.get(id);
        if (!p) return;
        this._banned.add(p.client.slice(0, -2));
        this._publish(this._names.to(p.client), MSG.KICK, {});
        // Every player of that machine goes with them.
        for (const c of [...this._ids.keys()]) if (c.slice(0, -2) === p.client.slice(0, -2)) { if (c !== p.client) this._publish(this._names.to(c), MSG.KICK, {}); this._gone(c); }
    }
    /** The host: let nobody else in (or let them in again). */
    lock(locked) { if (this.isHost) this.locked = !!locked; }

    // ── Saying ────────────────────────────────────────────────────────────────

    /** Publish, and never throw: a message that could not be sent is one the others did not get, which they survive. */
    _publish(channel, name, data) {
        if (!this._rt || this._closed) return;
        try {
            let ch = channel;
            if (typeof channel === 'string') {
                ch = this._out.get(channel);
                if (!ch) this._out.set(channel, ch = this._rt.channels.get(channel, { modes: ['PUBLISH'] }));
            }
            const p = ch.publish(name, data);
            p?.catch?.(() => { /* refused or lost */ });
        } catch { /* closing */ }
    }

    /** No oftener than every `gap` ms, in order: asks, and answers to them. */
    _paced(gap, fn) {
        this._paceQueue.push(fn);
        const run = () => {
            this._paceTimer = null;
            if (this._closed) { this._paceQueue.length = 0; return; }
            const wait = this._paceAt + gap - this._now();
            if (wait > 0) { this._paceTimer = setTimeout(run, wait); return; }
            this._paceAt = this._now();
            this._paceQueue.shift()?.();
            if (this._paceQueue.length) this._paceTimer = setTimeout(run, gap);
        };
        if (!this._paceTimer) run();
    }

    /** Where this player is. Said when it has changed, at most five times a second; and every two seconds regardless. */
    state(s) {
        if (!this._ready || this._closed || this.alone) return;
        const t = this._now(), since = t - this._stateAt;
        if (since < RATE.STATE) return;
        const text = s.join(',');
        if (text === this._stateSent && since < RATE.STATE_IDLE) return;
        this._stateAt = t; this._stateSent = text;
        this._publish(this._ch.all, MSG.STATE, s);
    }

    /** A block changed here; `was` is what it was. */
    block(x, y, z, b, was = 0) {
        if (!this._ready || this._closed || this.alone) return;
        this._publish(this._ch.all, MSG.BLOCK, [x, y, z, b, was]);
    }

    profile(name, skin) {
        if (!this._ready || this._closed) return;
        this._hello = { ...this._hello, name, skin };
        this._ch.all.presence.update(this._presenceData())?.catch?.(() => {});
    }

    atmos(a) {
        if (!this.isHost) return;
        this._atmos = a;
        const t = this._now();
        if (this.alone || t - this._atmosAt < RATE.ATMOS) return;
        this._atmosAt = t;
        this._publish(this._ch.host, MSG.ATMOS, a);
    }

    /** To everyone: the host's mobs, mostly — sent a few times a second, however often they are handed over. */
    all(d) {
        if (!this._ready || this._closed || this.alone || !d) return;
        if (!this.isHost) return this._publish(this._ch.all, MSG.SAY, d);
        if (d.t !== 'mobs') return this._publish(this._ch.host, MSG.SAY, d);
        // A mob's look is sent once, with whichever snapshot it first appears in: none may be dropped with a snapshot.
        if (d.info && Object.keys(d.info).length) this._mobInfo = { ...this._mobInfo, ...d.info };
        const t = this._now();
        if (t - this._mobsAt < RATE.MOBS) return;
        this._mobsAt = t;
        const info = this._mobInfo; this._mobInfo = null;
        this._publish(this._ch.host, MSG.SAY, info ? { t: 'mobs', list: d.list, info } : { t: 'mobs', list: d.list });
    }
    /** To the host alone. */
    host(d) { if (this._ready && !this.isHost && d) this._publish(this._ch.up, MSG.TO_HOST, d); }
    /** The host, to one player alone. */
    to(id, d) {
        const p = this.isHost && this.players.get(id);
        if (p && d) this._publish(this._names.to(p.client), MSG.TO, d);
    }

    // ── A guest: the host's world ─────────────────────────────────────────────

    _request(op, payload = {}) {
        if (!this._rt || this._closed) return Promise.resolve(null);
        return new Promise((resolve) => {
            const rid = ++this._rid;
            const timer = setTimeout(() => { this._asks.delete(rid); resolve(null); }, REQUEST_MS);
            this._asks.set(rid, { resolve, timer, parts: [] });
            this._paced(RATE.ASK, () => this._publish(this._ch.up, MSG.ASK, { rid, op, ...payload }));
        });
    }

    /** Keys ("cx,cz") of the chunks the host has data for; every other chunk is as the seed makes it. */
    async manifest() {
        for (let tries = 0; tries < 6 && !this._closed; tries++) {
            const r = await this._request('manifest');
            if (r?.d) {
                const v = new Int32Array(r.d.buffer.slice(r.d.byteOffset, r.d.byteOffset + (r.d.byteLength & ~7)));
                const keys = new Set();
                for (let i = 0; i + 1 < v.length; i += 2) keys.add(`${v[i]},${v[i + 1]}`);
                return keys;
            }
            await new Promise(res => setTimeout(res, RETRY_MS * (tries + 1)));
        }
        return null;
    }

    /** One chunk of the host's: `{ s: ChunkStatus, d?: Uint8Array }`. Waits its turn, and asks again while the host is busy. */
    async chunk(cx, cz) {
        if (this._chunkActive >= MAX_CHUNK_REQUESTS) await new Promise(res => this._chunkWaiting.push(res));
        this._chunkActive++;
        try {
            for (let tries = 0; tries < 6 && !this._closed; tries++) {
                const r = this.down ? null : await this._request('chunk', { cx, cz });
                if (r && r.s !== ChunkStatus.RETRY) return r;
                await new Promise(res => setTimeout(res, RETRY_MS * (tries + 1)));
            }
            return { s: ChunkStatus.NONE };
        } finally {
            this._chunkActive--;
            this._chunkWaiting.shift()?.();
        }
    }

    /** This player's saved place in the host's world, or null. */
    async loadState() { return (await this._request('pload'))?.state ?? null; }
    saveState(state) {
        if (!this._ready || this._closed || this.isHost) return;
        let size = 0;
        try { size = JSON.stringify(state).length; } catch { return; }
        if (size <= MAX_STATE_BYTES) this._publish(this._ch.up, MSG.ASK, { rid: 0, op: 'psave', state });
    }

    // ── The host: answering for its guests ────────────────────────────────────

    _onUp(m) {
        if (this._closed || !this._ids.has(m.clientId)) return;
        const d = m.data;
        if (!d || typeof d !== 'object') return;
        if (m.name === MSG.TO_HOST) return this.onMsg?.(this._ids.get(m.clientId), d);
        if (m.name === MSG.ASK) this._answer(m.clientId, d);
    }

    async _answer(client, { rid, op, ...p }) {
        const inbox = this._names.to(client);
        const reply = (name, data) => this._paced(RATE.REPLY, () => this._publish(inbox, name, data));
        let r;
        try {
            const fn = Object.prototype.hasOwnProperty.call(this.serve, op) ? this.serve[op] : null;
            if (!fn) throw new Error('not served');
            // Whose saved place: Ably's word for who is asking, never the asker's.
            r = await fn(op === 'pload' || op === 'psave' ? { state: p.state, key: client } : { cx: p.cx, cz: p.cz });
        } catch { return rid ? reply(`${MSG.REPLY}|${rid}|x`, {}) : undefined; }
        if (!rid || !Number.isInteger(rid)) return;                       // nothing was asked back (a save)

        let bytes = null, status = 0;
        if (op === 'manifest') {
            // Tens of thousands of keys as text would be many messages; as numbers, eight bytes each.
            const keys = r?.keys ?? [], v = new Int32Array(keys.length * 2);
            let n = 0;
            for (const k of keys) { const i = k.indexOf(','); v[n++] = +k.slice(0, i); v[n++] = +k.slice(i + 1); }
            bytes = new Uint8Array(v.buffer);
        } else if (op === 'chunk') {
            status = r?.s ?? ChunkStatus.NONE;
            bytes = toBytes(r?.d) ?? new Uint8Array(0);
        }
        if (!bytes) {
            let size = 0;
            try { size = JSON.stringify(r ?? {}).length; } catch { size = Infinity; }
            return size > 60000 ? reply(`${MSG.REPLY}|${rid}|x`, {}) : reply(`${MSG.REPLY}|${rid}`, r ?? {});
        }
        const n = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
        if (n > 64) return reply(`${MSG.REPLY}|${rid}|x`, {});
        for (let i = 0; i < n; i++) reply(`${MSG.REPLY}|${rid}|${status}|${i}|${n}`, bytes.slice(i * PART_BYTES, (i + 1) * PART_BYTES));
    }

    // ── Leaving ───────────────────────────────────────────────────────────────

    /** The room is over for this game, and not by its own doing. */
    _over(reason) {
        if (this._closed) return;
        this._drop();
        this.onClosed?.(reason);
    }

    /** Let go of everything, saying nothing to anyone. */
    _drop() {
        const rt = this._rt;
        this._closed = true; this._ready = false;
        this._rt = null; this.id = 0;
        this.players.clear(); this._ids.clear(); this._members.clear(); this._conns.clear();
        clearTimeout(this._paceTimer); this._paceTimer = null; this._paceQueue.length = 0;
        for (const ask of this._asks.values()) { clearTimeout(ask.timer); ask.resolve(null); }
        this._asks.clear();
        for (const res of this._chunkWaiting.splice(0)) res();
        try { rt?.close(); } catch { /* already */ }
    }

    close() {
        if (this._closed || !this._rt) return this._drop();
        const rt = this._rt, ch = this._ch, host = this.isHost;
        // Said before going, so nobody waits the quarter minute Ably takes to notice a game that just vanished.
        const said = [];
        try {
            if (host && this._ready) said.push(ch.host.publish(MSG.BYE, {}));
            said.push(ch.all.presence.leave());
        } catch { /* closing anyway */ }
        this._rt = null;
        this._drop();
        Promise.allSettled(said).then(() => { try { rt.close(); } catch { /* already */ } });
        setTimeout(() => { try { rt.close(); } catch { /* already */ } }, 1500)?.unref?.();
    }
}

/** Why a host turns a game away, in the words sessionOver() (src/players.js) has sentences for. */
const REFUSALS = new Set(['kicked', 'update', 'content', 'locked', 'full']);

// ── A guest's stand-in for the save server ────────────────────────────────────

/**
 * What ChunkManager and world.js know as `worldClient` (WorldClient.js), for a
 * guest of an online game: chunks come from the host through the room, and
 * nothing is saved from here — the world is the host's, and the host's game
 * keeps it (it is told every block that changes).
 */
export class OnlineWorldClient {
    /**
     * @param {OnlineSession} session
     * @param {{ unpackChunk: Function, unpackEdits: Function }} codec   ChunkCodec.js
     * @param {{ pendingChanges: Map<string, Map<number, number>> }} worldState
     */
    constructor(session, codec, worldState) {
        this._session = session;
        this._codec = codec;
        this._world = worldState;
        this._savedChunks = null;
        this.bufferedAmount = 0;
    }

    get connected() { return this._session.connected; }
    get savedKeys() { return this._savedChunks; }

    async connect() { /* the room is the connection */ }

    async fetchManifest() {
        // Not known (the host did not answer): every chunk is asked for, which is slower and never wrong.
        this._savedChunks = await this._session.manifest();
    }

    /** As WorldClient.loadChunk: `{ palette, data }`, or null for "generate it". */
    async loadChunk(_worldId, cx, cz) {
        const key = `${cx},${cz}`;
        if (this._savedChunks && !this._savedChunks.has(key)) return null;
        const r = await this._session.chunk(cx, cz);
        if (!r?.d?.length) return null;
        if (r.s === ChunkStatus.DATA) return this._codec.unpackChunk(r.d);
        if (r.s === ChunkStatus.EDITS) {
            // Only what was changed there: the chunk is generated, and these put down in it —
            // under anything heard since, which is newer.
            let pending = this._world.pendingChanges.get(key);
            if (!pending) this._world.pendingChanges.set(key, pending = new Map());
            for (const [idx, id] of this._codec.unpackEdits(r.d)) if (!pending.has(idx)) pending.set(idx, id);
        }
        return null;
    }

    /**
     * Nothing is saved from here: the host's game keeps the world, and has
     * been told every block these chunks were changed by. But ChunkManager
     * forgets a chunk's changes once it has "saved" it, so each one that has
     * any is noted as one to ask the host for when it is next loaded —
     * otherwise it would come back as the seed makes it, without them.
     */
    saveChunks(_worldId, { chunks }) {
        if (!this._savedChunks) return;          // not known what the host has: every chunk is asked for anyway
        for (const key of chunks.keys()) if (this._world.pendingChanges.get(key)?.size) this._savedChunks.add(key);
    }
    close() { /* the session is closed by whoever opened it */ }
}
