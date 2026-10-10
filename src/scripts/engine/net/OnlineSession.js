/**
 * OnlineSession — this game's line to the others when the world is online.
 *
 * It is to the online server (online/, Colyseus) what Multiplayer.js is to the
 * game's own server: world.js is handed one or the other and uses them alike —
 * the same `id`, `hostId`, `players`, `isHost`, `alone`, the same `on…`
 * callbacks, the same `state()`, `block()`, `profile()`, `atmos()`, `all()`,
 * `host()`, `to()`, `close()`. What differs is underneath:
 *
 *   • It is signed in (OnlineAccount): the server knows who this is and which
 *     edition they have from a token it issued, not from anything said here.
 *   • The room is found by a code. `open()` makes one (this game hosts);
 *     `enter(code)` joins one. `join()` then only hands back the welcome, so a
 *     world can be loaded after the room is in hand.
 *   • The server checks what is sent, and may refuse it. A block it refuses
 *     comes back through `onBlockRejected`, to be put back as it was.
 *   • Every block change comes round to its sender too, numbered. Two players
 *     changing one block at the same moment end up agreeing, because both
 *     finish on the order the server put them in.
 *   • A line that drops is picked up again (the SDK retries; the room holds the
 *     place), and what was changed meanwhile is asked for (`sync`).
 *   • A guest has no way to the host's machine, so what it needs of the host's
 *     world — the chunks the host has data for, its own saved place — is asked
 *     through the room (`manifest`, `chunk`, `loadState`, `saveState`), and the
 *     host's game answers (`serve`).
 *
 * The SDK is handed in (`sdk`: the @colyseus/sdk module, or the page's
 * `Colyseus` global), so this file has no imports a browser cannot resolve and
 * runs in a test as it is.
 */
import { PROTOCOL, ROOM, C2S, S2C, ChunkStatus, Close, ClosedReason, Reject, cleanCode } from './OnlineProtocol.js';

const REQUEST_MS = 12000;
const RETRY_MS = 600;
const MAX_CHUNK_REQUESTS = 24;       // asked of the host at once
const SESSION_MARGIN_S = 90;         // a token this close to running out is renewed first

/** What a refused join means, in the words sessionOver() (src/players.js) has sentences for. */
const REJECT_REASON = {
    [Reject.AUTH]: 'auth', [Reject.PROTOCOL]: 'update', [Reject.VERSION]: 'update', [Reject.CONTENT]: 'content',
    [Reject.CODE]: 'code', [Reject.FULL]: 'full', [Reject.BANNED]: 'kicked', [Reject.EDITION]: 'edition',
    [Reject.LIMIT]: 'busy', [Reject.BAD_REQUEST]: 'unreachable', [Reject.WORLD_GEN]: 'update', [Reject.CLOSING]: 'host',
};

export class OnlineError extends Error {
    /** @param {string} reason one of REJECT_REASON's, or 'unreachable' */
    constructor(reason, message) { super(message ?? reason); this.reason = reason; }
}

// ── Signing in ────────────────────────────────────────────────────────────────

/**
 * Who this game is to the online server. With a Steam ticket (the desktop
 * game) that is the Steam account, and owning the game there is what makes the
 * edition `full`; without one it is a guest, whose identity is a credential
 * the server made up and this game keeps (`storage`).
 */
export class OnlineAccount {
    /**
     * @param {object} o
     * @param {string} o.url           the online server, e.g. https://play.example.com
     * @param {typeof fetch} [o.fetchFn]
     * @param {{ get(): string|null, set(v: string): void }} [o.storage]   where the guest credential is kept
     * @param {() => Promise<string|null>} [o.steamTicket]                 a fresh Steam ticket as hex, or null
     * @param {() => Promise<object|null>} [o.signIn]                      instead of all the above (tests)
     */
    constructor({ url, fetchFn = (...a) => fetch(...a), storage = null, steamTicket = null, signIn = null }) {
        this.url = String(url).replace(/\/+$/, '');
        this._fetch = fetchFn;
        this._storage = storage;
        this._steamTicket = steamTicket;
        this._signIn = signIn;
        this._session = null;        // { token, account, edition, until }
        this._pending = null;
    }

    get edition() { return this._session?.edition ?? null; }

    async _post(path, body) {
        const res = await this._fetch(`${this.url}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return res.ok ? res.json() : null;
    }

    /** A session token that is good for a while yet: `{ token, account, edition }`. Throws OnlineError. */
    async session() {
        if (this._session && this._session.until > Date.now()) return this._session;
        // Two things asking at once (a pane and its world) share one sign-in.
        return this._pending ??= this._get().finally(() => { this._pending = null; });
    }

    async _get() {
        let s = null;
        try {
            if (this._signIn) s = await this._signIn();
            if (!s && this._steamTicket) {
                const ticket = await this._steamTicket().catch(() => null);
                if (ticket) s = await this._post('/auth/steam', { ticket });
            }
            // No Steam, or Steam could not vouch for us: a guest, with the free edition.
            if (!s) {
                s = await this._post('/auth/guest', { credential: this._storage?.get() ?? undefined });
                if (s?.credential) this._storage?.set(s.credential);
            }
        } catch {
            throw new OnlineError('unreachable');
        }
        if (!s?.token) throw new OnlineError('unreachable');
        this._session = { token: s.token, account: s.account, edition: s.edition, until: Date.now() + Math.max(30, (s.expiresIn ?? 600) - SESSION_MARGIN_S) * 1000 };
        return this._session;
    }
}

// ── The session ───────────────────────────────────────────────────────────────

export class OnlineSession {
    /**
     * @param {{ Client: Function }} sdk   the Colyseus SDK
     * @param {OnlineAccount} account
     */
    constructor(sdk, account) {
        this._sdk = sdk;
        this.account = account;
        this.url = account.url;
        this.room = null;
        this.online = true;          // world.js: this is not the game's own server
        this.id = 0;
        this.hostId = 0;
        this.players = new Map();    // the others: id → { id, name, skin, state, connected }
        this.code = '';              // the room's code, to give to whoever should join
        this.world = null;           // the host's world, as a guest's game needs it
        this.edition = null;         // 'full' | 'free', as the server has it
        this.canBuild = true;
        this.seq = 0;                // the last block change seen
        this.down = false;           // the line has dropped and is being picked up

        this.onJoined = null;        // (player)
        this.onLeft = null;          // (id)
        this.onState = null;         // (id, s)
        this.onBlock = null;         // (x, y, z, block)
        this.onBlockRejected = null; // (x, y, z, was, why) — put it back
        this.onProfile = null;       // (player)
        this.onAtmos = null;         // (a)
        this.onMsg = null;           // (from, d)
        this.onClosed = null;        // (reason)
        this.onDown = null;          // (down: boolean) — the line dropped / came back

        /** The host's game answers these for its guests (world.js sets them). */
        this.serve = { manifest: null, chunk: null, pload: null, psave: null };

        this._welcome = null;
        this._closed = false;
        this._own = new Map();       // "x,y,z" → { n, was, crossed } — block changes of ours not yet come round
        this._held = [];             // block changes made while the line was down
        this._chunkWaiting = [];
        this._chunkActive = 0;
    }

    get isHost() { return this.id !== 0 && this.id === this.hostId; }
    get alone() { return this.players.size === 0; }
    get connected() { return !!this.room && !this._closed && !this.down; }

    // ── Getting into a room ───────────────────────────────────────────────────

    async _client() {
        const session = await this.account.session();
        const client = new this._sdk.Client(this.url);
        client.auth.token = session.token;
        return client;
    }

    /**
     * Host a world online. Resolves with the welcome (as `join()` gives it).
     * @param {object} hello  { version, content, worldGen, name, skin, slot }
     * @param {object} world  the world as a guest needs it (see worldInfo in online/src/rooms/validate.ts)
     */
    async open(hello, world, maxPlayers = 8) {
        return this._enter((client) => client.create(ROOM, { protocol: PROTOCOL, ...hello, world, maxPlayers }));
    }

    /** Join the game with this code. */
    async enter(code, hello) {
        code = cleanCode(code);
        if (!code) throw new OnlineError('code');
        return this._enter(async (client) => {
            const session = await this.account.session();
            let res;
            try {
                res = await this.account._fetch(`${this.url}/rooms/resolve`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                    body: JSON.stringify({ code }),
                });
            } catch { throw new OnlineError('unreachable'); }
            if (res.status === 404) throw new OnlineError('code');
            if (res.status === 429) throw new OnlineError('busy');
            if (!res.ok) throw new OnlineError(res.status === 401 ? 'auth' : 'unreachable');
            const { roomId } = await res.json();
            return client.joinById(roomId, { protocol: PROTOCOL, ...hello, code });
        });
    }

    async _enter(connect) {
        let room;
        try {
            room = await connect(await this._client());
        } catch (e) {
            if (e instanceof OnlineError) throw e;
            throw new OnlineError(REJECT_REASON[e?.code] ?? 'unreachable', e?.message);
        }
        this.room = room;
        const welcome = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new OnlineError('unreachable')), REQUEST_MS);
            this._onWelcome = (w) => { clearTimeout(timer); resolve(w); };
        });
        this._listen(room);
        const w = await welcome;
        this.id = w.id; this.hostId = w.hostId; this.code = w.code; this.world = w.world; this.seq = w.seq ?? 0;
        this.edition = w.edition; this.canBuild = w.canBuild !== false;
        const states = new Map(w.players ?? []);
        this._roster(room.state, true);
        for (const p of this.players.values()) p.state = states.get(p.id) ?? null;
        this._welcome = { id: w.id, hostId: w.hostId, players: [...this.players.values()], edits: [], atmos: w.atmos ?? null };
        return this._welcome;
    }

    /** As Multiplayer.join: the welcome. The room is already in hand (open / enter). */
    async join() { return this._welcome; }

    // ── Hearing ───────────────────────────────────────────────────────────────

    _listen(room) {
        room.onMessage(S2C.WELCOME, (w) => this._onWelcome?.(w));
        room.onStateChange((state) => { if (this._welcome) this._roster(state, false); });
        room.onMessage(S2C.STATES, (list) => {
            for (let i = 0; i + 1 < list.length; i += 2) {
                const p = this.players.get(list[i]);
                if (p) { p.state = list[i + 1]; this.onState?.(p.id, p.state); }
            }
        });
        room.onMessage(S2C.BLOCK, (m) => this._onBlock(m));
        room.onMessage(S2C.REJECT, (m) => {
            const key = `${m.x},${m.y},${m.z}`, own = this._own.get(key);
            if (!own) return;
            if (--own.n <= 0) this._own.delete(key);
            this.onBlockRejected?.(m.x, m.y, m.z, own.was, m.why);
        });
        room.onMessage(S2C.ATMOS, (m) => this.onAtmos?.(m.a));
        // The host's own messages, in the shapes world.js has always been handed them.
        room.onMessage(S2C.MOBS, (m) => this.onMsg?.(this.hostId, { t: 'mobs', list: m.list, info: m.info }));
        room.onMessage(S2C.HIT, (m) => this.onMsg?.(m.from, { t: 'hit', id: m.id, dmg: m.dmg }));
        room.onMessage(S2C.ATTACK, (m) => this.onMsg?.(this.hostId, { t: 'attack', dmg: m.dmg }));
        room.onMessage(S2C.DROPS, (m) => this.onMsg?.(this.hostId, { t: 'drops', pos: m.pos, items: m.items }));
        room.onMessage(S2C.ASK, (m) => this._answer(m));
        room.onMessage(S2C.CLOSED, (m) => { this._reason = m?.reason ?? ClosedReason.CLOSED; });

        room.onDrop(() => { this.down = true; this.onDown?.(true); });
        room.onReconnect(() => this._resync());
        room.onError(() => { /* onLeave says what came of it */ });
        room.onLeave((code) => {
            if (this._closed) return;
            const reason = this._reason ?? {
                [Close.KICKED]: ClosedReason.KICKED, [Close.HOST_LEFT]: ClosedReason.HOST, [Close.ROOM_CLOSED]: ClosedReason.CLOSED,
                [Close.SHUTDOWN]: ClosedReason.SHUTDOWN, 4001: ClosedReason.SHUTDOWN, [Close.FLOOD]: ClosedReason.FLOOD, [Close.INVALID]: ClosedReason.FLOOD,
            }[code] ?? 'lost';
            this._end();
            this.onClosed?.(reason);
        });
    }

    /** Who is here, from the room's own list: told apart from who was, and the difference passed on. */
    _roster(state, quiet) {
        if (!state?.players) return;
        const seen = new Set();
        state.players.forEach((info) => {
            if (info.id === this.id || !info.id) return;
            seen.add(info.id);
            let skin = {};
            try { skin = JSON.parse(info.skin || '{}'); } catch { /* a look that does not parse is no look */ }
            const p = this.players.get(info.id);
            if (!p) {
                const fresh = { id: info.id, name: info.name, skin, state: null, connected: info.connected, _skin: info.skin };
                this.players.set(info.id, fresh);
                if (!quiet) this.onJoined?.(fresh);
            } else {
                p.connected = info.connected;
                if (p.name !== info.name || p._skin !== info.skin) {
                    p.name = info.name; p.skin = skin; p._skin = info.skin;
                    if (!quiet) this.onProfile?.(p);
                }
            }
        });
        for (const id of [...this.players.keys()]) {
            if (!seen.has(id)) { this.players.delete(id); if (!quiet) this.onLeft?.(id); }
        }
        if (state.hostId) this.hostId = state.hostId;
    }

    _onBlock(m) {
        if (m.seq > this.seq) this.seq = m.seq;
        const key = `${m.x},${m.y},${m.z}`, own = this._own.get(key);
        if (m.id !== this.id) {
            // Someone else's, while one of ours for the same place is on its way round: ours may have to be redone.
            if (own) own.crossed = true;
            return this.onBlock?.(m.x, m.y, m.z, m.b);
        }
        if (!own) return this.onBlock?.(m.x, m.y, m.z, m.b);      // ours from before a reconnection
        if (--own.n > 0) return;
        this._own.delete(key);
        // Ours came after theirs in the server's order: it is what the block ends as, here too.
        if (own.crossed) this.onBlock?.(m.x, m.y, m.z, m.b);
    }

    /** The line is back: what was changed while it was down, then what we changed. */
    async _resync() {
        let r = null;
        try { r = await this.room.request(C2S.SYNC, { since: this.seq }, { timeout: REQUEST_MS }); } catch { /* below */ }
        if (!r || r.gap) {
            // Too much went by to catch up on: this game no longer has the world the others have.
            const room = this.room;
            this._end();
            try { room?.leave(true); } catch { /* gone */ }
            return this.onClosed?.('lost');
        }
        for (let i = 0; i + 3 < r.list.length; i += 4) this.onBlock?.(r.list[i], r.list[i + 1], r.list[i + 2], r.list[i + 3]);
        this.seq = r.seq;
        this._own.clear();
        this.down = false;
        for (const b of this._held.splice(0)) this.room.send(C2S.BLOCK, b);
        this.onDown?.(false);
    }

    // ── Saying ────────────────────────────────────────────────────────────────

    _send(type, m) {
        if (this.room && !this._closed && !this.down) this.room.send(type, m);
    }

    /** Where this player is. Sent even alone: the server judges a block by where its player stands. */
    state(s) { this._send(C2S.STATE, s); }

    /** A block changed here; `was` is what it was, in case the server says no. */
    block(x, y, z, b, was = 0) {
        if (!this.room || this._closed) return;
        const key = `${x},${y},${z}`, own = this._own.get(key);
        if (own) own.n++; else this._own.set(key, { n: 1, was, crossed: false });
        const m = { x, y, z, b };
        // While the line is down the change waits here; the SDK's own queue is ten messages long.
        if (this.down) { if (this._held.length < 20000) this._held.push(m); return; }
        this.room.send(C2S.BLOCK, m);
    }

    profile(name, skin) { this._send(C2S.PROFILE, { name: String(name ?? ''), skin: skin ?? {} }); }
    atmos(a) { if (this.isHost) this._send(C2S.ATMOS, { a }); }

    /** The host's mobs, to everyone else. */
    all(d) { if (d?.t === 'mobs' && this.isHost && !this.alone) this._send(C2S.MOBS, d.info && Object.keys(d.info).length ? { list: d.list, info: d.info } : { list: d.list }); }
    /** A blow on a mob, to the host. */
    host(d) { if (d?.t === 'hit' && !this.isHost) this._send(C2S.HIT, { id: d.id, dmg: d.dmg }); }
    /** A mob's blow, or a kill's drops, to one player. */
    to(id, d) {
        if (!this.isHost) return;
        if (d?.t === 'attack') this._send(C2S.ATTACK, { to: id, dmg: d.dmg });
        else if (d?.t === 'drops') this._send(C2S.DROPS, { to: id, pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, items: d.items });
    }

    /** The host: send a player away, and keep their account out. */
    kick(id) { if (this.isHost) this._send(C2S.KICK, { id }); }
    /** The host: let nobody else in (or let them in again). */
    lock(locked) { if (this.isHost) this._send(C2S.LOCK, { locked: !!locked }); }

    // ── A guest: the host's world ─────────────────────────────────────────────

    async _request(type, payload) {
        if (!this.room || this._closed) return null;
        try { return await this.room.request(type, payload, { timeout: REQUEST_MS }); } catch { return null; }
    }

    /** Keys ("cx,cz") of the chunks the host has data for; every other chunk is as the seed makes it. */
    async manifest() {
        for (let tries = 0; tries < 6 && !this._closed; tries++) {
            const r = await this._request(C2S.MANIFEST);
            if (Array.isArray(r?.keys)) return new Set(r.keys);
            await new Promise(res => setTimeout(res, RETRY_MS * (tries + 1)));
        }
        return null;
    }

    /** One chunk of the host's: `{ s: ChunkStatus, d?: Uint8Array }`. Waits its turn, and asks again while the host is busy. */
    async chunk(cx, cz) {
        if (this._chunkActive >= MAX_CHUNK_REQUESTS) await new Promise(res => this._chunkWaiting.push(res));
        this._chunkActive++;
        try {
            for (let tries = 0; tries < 8 && !this._closed; tries++) {
                const r = this.down ? null : await this._request(C2S.CHUNK, { cx, cz });
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
    async loadState() { return (await this._request(C2S.PLOAD))?.state ?? null; }
    saveState(state) { this._send(C2S.PSAVE, { state }); }

    // ── The host: answering for its guests ────────────────────────────────────

    async _answer({ rid, op, ...p }) {
        let d, ok = true;
        try {
            const fn = this.serve[op];
            if (!fn) throw new Error('not served');
            d = await fn(p);
        } catch { ok = false; }
        if (this.room && !this._closed) this.room.send(C2S.REPLY, ok ? { rid, ok, d: d ?? {} } : { rid, ok });
    }

    // ── Leaving ───────────────────────────────────────────────────────────────

    _end() {
        this._closed = true;
        this.room = null; this.id = 0; this.players.clear(); this._own.clear(); this._held.length = 0;
        for (const res of this._chunkWaiting.splice(0)) res();
    }

    close() {
        const room = this.room;
        this._end();
        try { room?.leave(true); } catch { /* already */ }
    }
}

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

    get connected() { return !!this._session.room; }
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
        if (!r?.d) return null;
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
