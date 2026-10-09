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
 *     is the one that runs the animals, the clock and the weather, and tells
 *     the rest. When the host leaves, the session is over for everybody.
 *   • Where everyone is: each client's latest `state` is passed on as it is
 *     (the server never looks inside it).
 *   • What has been built. A changed block is passed on, and kept in the
 *     session's **journal** (the latest block for each place changed), which a
 *     newcomer is handed on joining: the chunk it was in may not have been
 *     saved yet, and without the journal the newcomer would generate that
 *     land afresh, without the change.
 *   • Anything else the clients have to say to each other — the host's
 *     animals, a blow landed on one — goes through as an opaque message: to
 *     everyone else (`mp:all`), to the host (`mp:host`) or to one player
 *     (`mp:to`).
 *
 * Messages are JSON text frames on the same WebSocket as the chunk I/O
 * (server.js routes every `mp:*` type here).
 *
 *   → mp:join   { worldId, clientId, name, skin }
 *   ← mp:welcome { id, hostId, players: [{ id, name, skin, state }], edits: [x, y, z, block, …], atmos }
 *   ← mp:joined { player: { id, name, skin } }      ← mp:left { id }      ← mp:closed { reason }
 *   → mp:state  { s }                                ← mp:state { id, s }
 *   → mp:block  { x, y, z, b }                       ← mp:block { x, y, z, b, id }
 *   → mp:profile { name, skin }                      ← mp:profile { id, name, skin }
 *   → mp:atmos  { a }         (host only; kept for newcomers)   ← mp:atmos { a }
 *   → mp:all / mp:host / mp:to { to, d }             ← mp:msg { from, d }
 *   → mp:leave
 */

const MAX_PLAYERS = 8;
const MAX_JOURNAL = 400000;       // changed places remembered a session
const MAX_NAME = 16;

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

    /** How many are playing `worldId` now. */
    count(worldId) { return this.sessions.get(worldId)?.players.size ?? 0; }

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
            case 'mp:profile':
                player.name = cleanName(msg.name, player.id);
                player.skin = cleanSkin(msg.skin);
                this._others(session, player, { type: 'mp:profile', id: player.id, name: player.name, skin: player.skin });
                break;
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
            session = { worldId, players: new Map(), journal: new Map(), hostId: 0, nextId: 1, atmos: null };
            this.sessions.set(worldId, session);
        }
        if (session.players.size >= MAX_PLAYERS) return this._send(ws, { type: 'mp:closed', reason: 'full' });
        const id = session.nextId++;
        const player = { id, ws, clientId: String(msg.clientId ?? '').slice(0, 80), name: cleanName(msg.name, id), skin: cleanSkin(msg.skin), state: null };
        if (session.players.size === 0) session.hostId = id;
        session.players.set(id, player);
        ws._mp = { session, player };

        const edits = [];
        for (const [key, b] of session.journal) {
            const c = key.split(',');
            edits.push(+c[0], +c[1], +c[2], b);
        }
        this._send(ws, {
            type: 'mp:welcome', id, hostId: session.hostId, atmos: session.atmos, edits,
            players: [...session.players.values()].filter(p => p !== player).map(p => ({ id: p.id, name: p.name, skin: p.skin, state: p.state })),
        });
        this._others(session, player, { type: 'mp:joined', player: { id, name: player.name, skin: player.skin } });
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
