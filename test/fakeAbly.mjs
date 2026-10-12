/**
 * A stand-in for Ably, for tests: the part of its Realtime SDK the game uses
 * (src/scripts/engine/net/OnlineSession.js), working the way Ably's
 * documentation says the real one does, in one process.
 *
 * It is strict where it matters to the game's design:
 *   • a connection is only made with a TokenRequest whose signature is right
 *     for the key (so a test of the token service is a test of its signing);
 *   • the token's capability is enforced — publishing, subscribing or being
 *     present where the token does not allow is refused, by Ably's own rules
 *     for wildcards;
 *   • every message carries the clientId of the token that sent it, whatever
 *     the sender would like it to say;
 *   • a connection does not hear its own messages (echoMessages: false).
 *
 * It also counts messages as Ably bills them: one for each publish, and one
 * for each connection it is delivered to (`hub.count`).
 *
 * What it is not: Ably. It has no network, no limits and no clock of its own.
 * A real key is the only test of the real thing (online/README.md).
 */
import { tokenRequest } from '../online/auth.js';

/** Ably's rule: a `*` stands for one whole segment between colons; a trailing one for all that follow. */
function matches(pattern, name) {
    if (pattern === name) return true;
    const p = pattern.split(':'), n = name.split(':');
    for (let i = 0; i < p.length; i++) {
        if (p[i] === '*') { if (i === p.length - 1) return n.length > i; if (i >= n.length) return false; continue; }
        if (p[i] !== n[i]) return false;
    }
    return p.length === n.length;
}

class Emitter {
    constructor() { this._l = new Set(); }
    on(a, b) { this._l.add(b ? { event: a, fn: b } : { event: null, fn: a }); }
    off(fn) { for (const l of this._l) if (l.fn === fn) this._l.delete(l); }
    emit(event, arg) { for (const l of [...this._l]) if (!l.event || l.event === event) l.fn(arg); }
}

export function makeFakeAbly({ key }) {
    const split = key.indexOf(':'), keyName = key.slice(0, split), keySecret = key.slice(split + 1);
    const hub = {
        channels: new Map(),         // name → { subs: Map<conn, fn[]>, present: Map<clientId, { data, conn }>, watchers: Map<conn, fn[]> }
        connections: new Set(),
        count: { inbound: 0, outbound: 0 },
        get messages() { return this.count.inbound + this.count.outbound; },
        refused: [],                 // what was tried and not allowed: "publish ww:…:host"
        reset() { this.count.inbound = this.count.outbound = 0; },
        /** What Ably's REST API answers for `GET /channels/<name>/presence`: data that is not text comes as JSON text, marked so. */
        restPresence(name) {
            return [...(this.channels.get(name)?.present.values() ?? [])].map((p) => ({
                clientId: p.clientId, connectionId: p.conn.id, action: 1, timestamp: Date.now(),
                ...(typeof p.data === 'string' ? { data: p.data } : { data: JSON.stringify(p.data), encoding: 'json' }),
            }));
        },
        /** The line of the connection with this clientId drops, and comes back. */
        async blip(clientId) {
            const c = [...this.connections].find(x => x.clientId === clientId);
            c._state('disconnected');
            await tick();
            c._state('connecting');
            c._state('connected');
        },
        /** … or does not come back: Ably gives its place up, and tells the others it has gone. */
        vanish(clientId) {
            const c = [...this.connections].find(x => x.clientId === clientId);
            c._leaveAll();
            c._state('suspended');
        },
    };
    const tick = () => new Promise(r => setTimeout(r, 0));
    const chan = (name) => {
        let c = hub.channels.get(name);
        if (!c) hub.channels.set(name, c = { subs: new Map(), present: new Map(), watchers: new Map() });
        return c;
    };
    // One queue for everything delivered, so the order things were published in is the order they arrive in.
    let queue = Promise.resolve();
    const later = (fn) => { queue = queue.then(() => new Promise(r => setTimeout(() => { try { fn(); } finally { r(); } }, 0))); };

    let made = 0;
    class Realtime {
        constructor(options) {
            this._options = options;
            this.clientId = null;
            this._cap = {};
            this._channels = new Map();
            this._open = false;
            this.id = `conn${++made}`;
            const conn = this.connection = new Emitter();
            conn.state = 'initialized';
            this._state = (s, reason) => { const previous = conn.state; conn.state = s; conn.emit(s, { current: s, previous, reason }); };
            this.channels = { get: (name, opts) => this._get(name, opts) };
            this.auth = { get clientId() { return conn._clientId; } };
            hub.connections.add(this);
            setTimeout(() => this._connect(), 0);
        }

        async _authorise() {
            const request = await new Promise((resolve, reject) => this._options.authCallback({}, (err, r) => err ? reject(new Error(String(err))) : resolve(r)));
            // What Ably does with a TokenRequest: the signature must be the key's, over exactly these fields.
            const right = await tokenRequest({ keyName, keySecret, clientId: request.clientId, capability: JSON.parse(request.capability), ttl: request.ttl, timestamp: request.timestamp, nonce: request.nonce });
            if (request.keyName !== keyName || request.mac !== right.mac || right.capability !== request.capability) throw Object.assign(new Error('bad token request'), { statusCode: 401 });
            this.clientId = this.connection._clientId = request.clientId;
            this._cap = JSON.parse(request.capability);
            this.tokens = (this.tokens ?? 0) + 1;
        }

        async _connect() {
            this._state('connecting');
            try { await this._authorise(); } catch (e) { return this._state('failed', { statusCode: e.statusCode ?? 401, message: e.message }); }
            this._open = true;
            this._state('connected');
        }

        /** As when a token runs out: Ably asks for another, on the same connection. */
        async renew() { await this._authorise(); }

        _can(op, name) {
            for (const [pattern, ops] of Object.entries(this._cap)) {
                if (matches(pattern, name) && (ops.includes(op) || ops.includes('*'))) return true;
            }
            return false;
        }

        _get(name, opts) {
            let ch = this._channels.get(name);
            if (ch) return ch;
            const rt = this, c = chan(name), modes = opts?.modes ?? ['PUBLISH', 'SUBSCRIBE', 'PRESENCE', 'PRESENCE_SUBSCRIBE'];
            const denied = (op) => (hub.refused.push(`${op} ${name}`), Promise.reject(Object.assign(new Error(`Channel denied access based on given capability; channel = ${name}, operation = ${op}`), { code: 40160, statusCode: 401 })));
            const hears = (conn) => conn._open && conn._can('subscribe', name);
            const tell = (map, m, from) => {
                for (const [conn, fns] of map) {
                    if (conn === from || !hears(conn)) continue;
                    hub.count.outbound++;
                    const copy = { ...m, data: m.data instanceof Uint8Array ? m.data.slice().buffer : (m.data === undefined ? undefined : structuredClone(m.data)) };
                    later(() => { if (conn._open) for (const fn of fns) fn(copy); });
                }
            };
            const presence = (action, data) => {
                if (!rt._can('presence', name)) return denied('presence');
                hub.count.inbound++;
                const id = `${rt.clientId}|${rt.id}`;
                if (action === 'leave') c.present.delete(id); else c.present.set(id, { clientId: rt.clientId, data: structuredClone(data), conn: rt });
                tell(c.watchers, { action, clientId: rt.clientId, connectionId: rt.id, data }, null);
                return Promise.resolve();
            };
            ch = {
                name,
                attach: async () => {},
                on: () => {},
                subscribe: (fn) => {
                    if (!modes.includes('SUBSCRIBE') || !rt._can('subscribe', name)) return denied('subscribe');
                    if (!c.subs.has(rt)) c.subs.set(rt, []);
                    c.subs.get(rt).push(fn);
                    return Promise.resolve();
                },
                publish: (msgName, data) => {
                    if (!rt._open) return Promise.reject(new Error('not connected'));
                    if (!modes.includes('PUBLISH') || !rt._can('publish', name)) return denied('publish');
                    const size = data instanceof Uint8Array ? data.length : JSON.stringify(data ?? null).length;
                    if (size > 65536) return Promise.reject(Object.assign(new Error('Maximum message length exceeded'), { code: 40009 }));
                    // Billed in units of 5 KiB.
                    const units = Math.max(1, Math.ceil(size / 5120));
                    hub.count.inbound += units;
                    const before = hub.count.outbound;
                    tell(c.subs, { name: msgName, data, clientId: rt.clientId, timestamp: Date.now() }, rt);
                    hub.count.outbound += (hub.count.outbound - before) * (units - 1);
                    return Promise.resolve();
                },
                presence: {
                    enter: (data) => presence('enter', data),
                    update: (data) => presence('update', data),
                    leave: () => presence('leave'),
                    get: async () => {
                        if (!rt._can('subscribe', name)) return denied('presence-subscribe');
                        return [...c.present.values()].map((p) => ({ clientId: p.clientId, connectionId: p.conn.id, action: 'present', data: structuredClone(p.data) }));
                    },
                    subscribe: (fn) => {
                        if (!modes.includes('PRESENCE_SUBSCRIBE') || !rt._can('subscribe', name)) return denied('presence-subscribe');
                        if (!c.watchers.has(rt)) c.watchers.set(rt, []);
                        c.watchers.get(rt).push(fn);
                        return Promise.resolve();
                    },
                },
            };
            this._channels.set(name, ch);
            return ch;
        }

        _leaveAll() {
            this._open = false;
            for (const [name, c] of hub.channels) {
                c.subs.delete(this); c.watchers.delete(this);
                if (c.present.delete(`${this.clientId}|${this.id}`)) {
                    for (const [conn, fns] of c.watchers) {
                        if (!conn._open || !conn._can('subscribe', name)) continue;
                        hub.count.outbound++;
                        later(() => { if (conn._open) for (const fn of fns) fn({ action: 'leave', clientId: this.clientId, connectionId: this.id }); });
                    }
                }
            }
        }

        close() {
            if (this.connection.state === 'closed') return;
            this._leaveAll();
            hub.connections.delete(this);
            this._state('closed');
        }
    }

    /** Everything published so far has arrived. */
    const settle = async () => { for (let i = 0; i < 4; i++) { await queue; await tick(); } };
    return { Ably: { Realtime }, hub, settle, matches };
}
