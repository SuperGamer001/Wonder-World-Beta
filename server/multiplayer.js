/**
 * Multiplayer — who is in which world together, and what they tell each other.
 *
 * Everyone playing one world through this server is in that world's
 * **session**: the players of a split screen (each pane is a client of its
 * own), and the players who joined over the network (see `lan.js`). The
 * server does not run the game — the clients do, each with the whole world —
 * it only keeps them agreeing:
 *
 *   • Who is here. A client joins with a name and a look; everyone is told
 *     when someone comes or goes. The **first to join is the host**: its game
 *     is the one that runs the clock and the weather, and tells the rest
 *     (the animals are shared out: each client runs the ones nearest its own
 *     player). When the host leaves, the session is over for everybody.
 *   • Where everyone is: each client's latest `state` is passed on as it is
 *     (the server never looks inside it).
 *   • What has been built. A changed block is passed on, and kept in the
 *     session's **journal** (the latest block for each place changed), which a
 *     newcomer is handed on joining: the chunk it was in may not have been
 *     saved yet, and without the journal the newcomer would generate that
 *     land afresh, without the change.
 *   • Anything else the clients have to say to each other — the animals
 *     each runs, a blow landed on one, what is in a chest — goes through as
 *     an opaque message: to
 *     everyone else (`mp:all`), to the host (`mp:host`) or to one player
 *     (`mp:to`).
 *
 * Messages are JSON text frames on the same WebSocket as the chunk I/O
 * (server.js routes every `mp:*` type here).
 *
 *   → mp:join   { worldId, clientId, name, skin, key }
 *   ← mp:welcome { id, hostId, dup, players: [{ id, name, skin, state, key, dup }], edits: [x, y, z, block, …], atmos }
 *   ← mp:joined { player: { id, name, skin, key, dup } }   ← mp:left { id }   ← mp:closed { reason }
 *   → mp:state  { s }                                ← mp:state { id, s }
 *   → mp:block  { x, y, z, b }                       ← mp:block { x, y, z, b, id }
 *   → mp:profile { name, skin, key }                 ← mp:profile { id, name, skin, key, dup }
 *   → mp:kick   { id }       (host only: that player is sent away — reason 'kicked' — and not let back in)
 *   → mp:atmos  { a }         (host only; kept for newcomers)   ← mp:atmos { a }
 *   → mp:all / mp:host / mp:to { to, d }             ← mp:msg { from, d }
 *   → mp:leave
 *
 * `key` is who a player is, whatever they are called (the game makes it from
 * the hidden code kept with their name): the games go by it for who is an
 * operator, and the session for who has been sent away. `dup` is for two
 * players of one name: the second to arrive is #2, the next #3, and the games
 * show that after the name, so they can be told apart.
 */

const MAX_PLAYERS = 8;
const MAX_JOURNAL = 400000;       // changed places remembered a session
const MAX_NAME = 16;

const cleanKey = (key) => (typeof key === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(key) ? key : '');
const cleanName = (name, n) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : `Player ${n}`);
/** A look is a small object of small whole numbers; anything else is dropped. */
function cleanSkin(skin) {
    const out = {};
    if (skin && typeof skin === 'object') {
        for (const [k, v] of Object.entries(skin).slice(0, 24)) {
            if (/^[a-zA-Z]{1,16}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 64) out[k] = v;
        }
    }
    return out;
}

export class MultiplayerHub {
    /** @param {(worldId: string) => boolean} worldExists */
    constructor(worldExists) {
        this.worldExists = worldExists;
        this.sessions = new Map();          // worldId → session
        // Called when a session begins or ends, or its head-count changes (lan.js advertises it).
        this.onChange = null;
    }

    /** How many are playing `worldId` now — of those `which(ws)` allows, if given. */
    count(worldId, which = null) {
        const players = this.sessions.get(worldId)?.players;
        if (!players) return 0;
        if (!which) return players.size;
        let n = 0;
        for (const p of players.values()) if (which(p.ws)) n++;
        return n;
    }

    /** The number after the name of a player called what somebody here already is: 2, 3, … (0: nobody is). */
    _dup(session, player) {
        const name = player.name.toLowerCase(), used = new Set();
        let same = false;
        for (const p of session.players.values()) {
            if (p === player || p.name.toLowerCase() !== name) continue;
            same = true;
            used.add(p.dup || 1);
        }
        if (!same) return 0;
        let n = 2;
        while (used.has(n)) n++;
        return n;
    }
    _public(p) { return { id: p.id, name: p.name, skin: p.skin, key: p.key, dup: p.dup }; }

    _send(ws, msg) {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    }
    _others(session, but, msg) {
        const text = JSON.stringify(msg);
        for (const p of session.players.values()) if (p !== but && p.ws.readyState === 1) p.ws.send(text);
    }

    /** A text message whose type begins `mp:`. */
    handle(ws, msg) {
        if (msg.type === 'mp:join') return this._join(ws, msg);
        const at = ws._mp;
        if (!at) return;                                       // not in a session: nothing to say
        const { session, player } = at;
        switch (msg.type) {
            case 'mp:state':
                player.state = msg.s;
                this._others(session, player, { type: 'mp:state', id: player.id, s: msg.s });
                break;
            case 'mp:block': {
                const { x, y, z, b } = msg;
                if (![x, y, z, b].every(Number.isInteger) || b < 0 || b > 65535) break;
                const key = `${x},${y},${z}`;
                if (session.journal.size < MAX_JOURNAL || session.journal.has(key)) session.journal.set(key, b);
                this._others(session, player, { type: 'mp:block', x, y, z, b, id: player.id });
                break;
            }
            case 'mp:profile': {
                const was = player.name;
                player.name = cleanName(msg.name, player.id);
                player.skin = cleanSkin(msg.skin);
                if (cleanKey(msg.key)) player.key = cleanKey(msg.key);
                if (player.name.toLowerCase() !== was.toLowerCase()) player.dup = this._dup(session, player);
                this._others(session, player, { type: 'mp:profile', ...this._public(player) });
                this._send(ws, { type: 'mp:you', dup: player.dup });
                break;
            }
            case 'mp:kick': {
                // The host sends a player away: they are told why, and their key is not let in again this session.
                const out = player.id === session.hostId ? session.players.get(msg.id) : null;
                if (!out || out === player) break;
                session.banned.add(out.key || out.clientId);
                this._send(out.ws, { type: 'mp:closed', reason: 'kicked' });
                this.leave(out.ws);
                break;
            }
            case 'mp:atmos':
                if (player.id !== session.hostId) break;
                session.atmos = msg.a ?? null;
                this._others(session, player, { type: 'mp:atmos', a: session.atmos });
                break;
            case 'mp:all':
                this._others(session, player, { type: 'mp:msg', from: player.id, d: msg.d });
                break;
            case 'mp:host': {
                const host = session.players.get(session.hostId);
                if (host && host !== player) this._send(host.ws, { type: 'mp:msg', from: player.id, d: msg.d });
                break;
            }
            case 'mp:to': {
                const to = session.players.get(msg.to);
                if (to && to !== player) this._send(to.ws, { type: 'mp:msg', from: player.id, d: msg.d });
                break;
            }
            case 'mp:leave':
                this.leave(ws);
                break;
        }
    }

    _join(ws, msg) {
        if (ws._mp) this.leave(ws);
        const worldId = String(msg.worldId ?? '');
        if (!worldId || !this.worldExists(worldId)) return this._send(ws, { type: 'mp:closed', reason: 'no-world' });
        let session = this.sessions.get(worldId);
        if (!session) {
            session = { worldId, players: new Map(), journal: new Map(), hostId: 0, nextId: 1, atmos: null, banned: new Set() };
            this.sessions.set(worldId, session);
        }
        if (session.players.size >= MAX_PLAYERS) return this._send(ws, { type: 'mp:closed', reason: 'full' });
        const id = session.nextId++;
        const player = { id, ws, clientId: String(msg.clientId ?? '').slice(0, 80), name: cleanName(msg.name, id), skin: cleanSkin(msg.skin), state: null, key: cleanKey(msg.key), dup: 0 };
        if (session.banned.has(player.key || player.clientId)) { session.nextId--; return this._send(ws, { type: 'mp:closed', reason: 'kicked' }); }
        player.dup = this._dup(session, player);
        if (session.players.size === 0) session.hostId = id;
        session.players.set(id, player);
        ws._mp = { session, player };

        const edits = [];
        for (const [key, b] of session.journal) {
            const c = key.split(',');
            edits.push(+c[0], +c[1], +c[2], b);
        }
        this._send(ws, {
            type: 'mp:welcome', id, hostId: session.hostId, dup: player.dup, atmos: session.atmos, edits,
            players: [...session.players.values()].filter(p => p !== player).map(p => ({ ...this._public(p), state: p.state })),
        });
        this._others(session, player, { type: 'mp:joined', player: this._public(player) });
        this.onChange?.(worldId);
    }

    /** The socket closed, or its client left the world. */
    leave(ws) {
        const at = ws._mp;
        if (!at) return;
        ws._mp = null;
        const { session, player } = at;
        session.players.delete(player.id);
        if (player.id === session.hostId || session.players.size === 0) {
            // The host's game was the one running the world: without it there is no session.
            this._others(session, null, { type: 'mp:closed', reason: 'host' });
            for (const p of session.players.values()) p.ws._mp = null;
            this.sessions.delete(session.worldId);
        } else {
            this._others(session, null, { type: 'mp:left', id: player.id });
        }
        this.onChange?.(session.worldId);
    }

    /** End a world's session from outside (the world was deleted, or closed to the network). */
    close(worldId, reason = 'closed', only = null) {
        const session = this.sessions.get(worldId);
        if (!session) return;
        for (const p of [...session.players.values()]) {
            if (only && !only(p.ws)) continue;
            this._send(p.ws, { type: 'mp:closed', reason });
            this.leave(p.ws);
        }
    }
}
