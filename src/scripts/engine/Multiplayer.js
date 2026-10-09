/**
 * Multiplayer — this game's line to the others playing the same world.
 *
 * Every world played through a server is a session there (server/multiplayer.js
 * has the whole protocol): one player alone is a session of one, and a second
 * pane of a split screen or a guest from the network simply joins it. So the
 * game does not have a multiplayer mode — it always tells the session what it
 * does, and listens; with nobody else there, nothing is sent.
 *
 * The first to join is the **host**. All the games hold the whole world and
 * each runs its own player; the host's also runs what there must be only one
 * of — the animals, the clock, the weather — and tells the rest.
 *
 * This class is the socket and nothing else: it knows who is here and passes
 * messages. What they mean is world.js's business (the `on…` callbacks).
 *
 * No Three.js, no DOM beyond WebSocket: it runs in a test as it is.
 */

const JOIN_TIMEOUT = 6000;   // ms to wait for the server's welcome

export class Multiplayer {
    /** @param {string} wsUrl the game server's WebSocket address */
    constructor(wsUrl, WS = globalThis.WebSocket) {
        this.url = wsUrl;
        this._WS = WS;
        this.ws = null;
        this.id = 0;                 // this player, in the session (0: not in one)
        this.hostId = 0;
        this.players = new Map();    // the others: id → { id, name, skin, state }

        this.onJoined = null;        // (player)
        this.onLeft = null;          // (id)
        this.onState = null;         // (id, s)
        this.onBlock = null;         // (x, y, z, block)
        this.onProfile = null;       // (player)
        this.onAtmos = null;         // (a)
        this.onMsg = null;           // (from, d)
        this.onClosed = null;        // (reason) — the session ended, or the line went dead
    }

    get isHost() { return this.id !== 0 && this.id === this.hostId; }
    /** Nobody else is here: there is nobody to tell anything. */
    get alone() { return this.players.size === 0; }

    /**
     * Join a world's session. Resolves with the server's welcome — `{ id,
     * hostId, players, edits: [x, y, z, block, …], atmos }` — or null if the
     * server cannot be reached or will not have us.
     */
    join({ worldId, clientId, name, skin }) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
            const timer = setTimeout(() => finish(null), JOIN_TIMEOUT);
            let ws;
            try { ws = new this._WS(this.url); } catch { return finish(null); }
            this.ws = ws;
            ws.onopen = () => ws.send(JSON.stringify({ type: 'mp:join', worldId, clientId, name, skin }));
            ws.onerror = () => finish(null);
            ws.onclose = () => {
                finish(null);
                if (this.ws !== ws) return;
                const was = this.id;
                this.ws = null; this.id = 0;
                if (was) this.onClosed?.('lost');
            };
            ws.onmessage = (e) => {
                if (typeof e.data !== 'string') return;
                let m;
                try { m = JSON.parse(e.data); } catch { return; }
                if (m.type === 'mp:welcome') {
                    this.id = m.id; this.hostId = m.hostId;
                    this.players.clear();
                    for (const p of m.players ?? []) this.players.set(p.id, p);
                    finish(m);
                } else if (m.type === 'mp:closed' && !done) {
                    finish(null);
                } else this._handle(m);
            };
        });
    }

    _handle(m) {
        switch (m.type) {
            case 'mp:joined':  this.players.set(m.player.id, m.player); this.onJoined?.(m.player); break;
            case 'mp:left':    this.players.delete(m.id); this.onLeft?.(m.id); break;
            case 'mp:state': {
                const p = this.players.get(m.id);
                if (p) { p.state = m.s; this.onState?.(m.id, m.s); }
                break;
            }
            case 'mp:block':   this.onBlock?.(m.x, m.y, m.z, m.b); break;
            case 'mp:profile': {
                const p = this.players.get(m.id);
                if (p) { p.name = m.name; p.skin = m.skin; this.onProfile?.(p); }
                break;
            }
            case 'mp:atmos':   this.onAtmos?.(m.a); break;
            case 'mp:msg':     this.onMsg?.(m.from, m.d); break;
            case 'mp:closed': {
                const ws = this.ws;
                this.id = 0; this.ws = null; this.players.clear();
                try { ws?.close(); } catch { /* already */ }
                this.onClosed?.(m.reason ?? 'closed');
                break;
            }
        }
    }

    _send(m) {
        if (this.id !== 0 && this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
    }

    /** Where this player is and what they are doing (the session passes it on as it is). */
    state(s) { if (!this.alone) this._send({ type: 'mp:state', s }); }
    /** A block changed here. Sent even alone: the session keeps it for whoever joins later. */
    block(x, y, z, b) { this._send({ type: 'mp:block', x, y, z, b }); }
    profile(name, skin) { this._send({ type: 'mp:profile', name, skin }); }
    atmos(a) { if (this.isHost) this._send({ type: 'mp:atmos', a }); }
    /** A message to everyone else, to the host, or to one player. */
    all(d) { if (!this.alone) this._send({ type: 'mp:all', d }); }
    host(d) { this._send({ type: 'mp:host', d }); }
    to(id, d) { this._send({ type: 'mp:to', to: id, d }); }

    close() {
        const ws = this.ws;
        this.ws = null; this.id = 0; this.players.clear();
        if (!ws) return;
        try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'mp:leave' })); ws.close(); } catch { /* already */ }
    }
}
