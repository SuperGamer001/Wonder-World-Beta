/**
 * The token service — the one piece of online play that is the game's own.
 *
 * Online games go through Ably (ably.com): every game connects to Ably, and
 * Ably passes what they say to one another along. Ably will only talk to a
 * game that shows it a token, and a token can only be made by something that
 * holds the app's API key. The key must never be in the game (anyone could
 * read it out and do anything with the account), so it lives here, and this
 * hands out what a game needs instead: a signed *token request*, good for one
 * room, as one player of it, for an hour.
 *
 * It keeps no state and stores nothing, so it runs anywhere and any number of
 * copies agree: as a Cloudflare Worker (worker.js), a small Node server
 * (server.mjs), or inside the game's own server on a developer's machine
 * (server/server.js, when WW_ABLY_KEY is set). It uses only Web Crypto, which
 * all of those have.
 *
 * What it decides, and how, with nothing remembered:
 *
 *   • Who a game is. A game makes up a long random secret once (`device`) and
 *     keeps it. Its name to everyone else — Ably's `clientId`, which Ably
 *     stamps on everything it sends — is a keyed hash of that secret, so
 *     nobody can speak as another player without that player's secret.
 *   • Which room. `host` makes up a code; `token` takes one. The token is good
 *     for that room's channels and no others.
 *   • Who the host is. Whoever asked for the room is handed a *ticket*: a
 *     keyed hash of the code and of who they are. Only a token asked for with
 *     the ticket may publish on the room's host channel or read what guests
 *     send the host. A guest has no ticket and cannot make one.
 *
 * What it cannot do is in online/README.md (*What this does not protect*).
 */

/** A room code: eight of these (nothing that reads as something else). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const MAX_SLOT = 3;

const enc = new TextEncoder();
const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, text) {
    const key = await crypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, enc.encode(text));
}

/** Equal, in time that does not depend on where they differ. */
function same(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

/** The channels of a room (src/scripts/engine/net/OnlineProtocol.js has the game's copy; a test holds them equal). */
export function channels(code) {
    return { all: `ww:${code}:all`, host: `ww:${code}:host`, up: `ww:${code}:up`, to: (clientId) => `ww:${code}:to:${clientId}` };
}

/** What a token may do: the room's host, or one of its guests. */
export function capability(code, clientId, host) {
    const c = channels(code);
    return host ? {
        [c.all]: ['presence', 'publish', 'subscribe'],
        [c.host]: ['publish'],                         // only the host speaks here: what is heard on it is the host's word
        [c.up]: ['subscribe'],                         // … and only the host hears what guests send the host
        [`ww:${code}:to:*`]: ['publish'],              // … and writes to each guest alone
    } : {
        [c.all]: ['presence', 'publish', 'subscribe'],
        [c.host]: ['subscribe'],
        [c.up]: ['publish'],
        [c.to(clientId)]: ['subscribe'],               // a guest reads its own letters, nobody else's
    };
}

/**
 * An Ably TokenRequest, signed with the key: what a game hands Ably to be given a token.
 * (The text signed is Ably's: each field, in this order, each followed by a newline.)
 */
export async function tokenRequest({ keyName, keySecret, clientId, capability: cap, ttl = TOKEN_TTL_MS, timestamp, nonce }) {
    // In Ably's canonical form — resources in order, and each one's operations — which is how its own SDKs write it.
    const capText = JSON.stringify(Object.fromEntries(Object.keys(cap).sort().map(k => [k, [...cap[k]].sort()])));
    const text = `${keyName}\n${ttl}\n${capText}\n${clientId}\n${timestamp}\n${nonce}\n`;
    return { keyName, ttl, capability: capText, clientId, timestamp, nonce, mac: b64(await hmac(keySecret, text)) };
}

export function cleanCode(text) {
    const code = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== CODE_LENGTH) return '';
    for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return '';
    return code;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

/**
 * @param {object} o
 * @param {string} o.key                 the Ably API key, "appId.keyId:secret". Never sent anywhere.
 * @param {string[]} [o.allowedOrigins]  exact origins of the browser edition ("https://play.example.com")
 * @param {boolean} [o.allowLoopback]    pages served from this machine (the desktop app, a developer's server)
 * @param {number} [o.ratePerMinute]     requests an address may make
 * @param {() => number} [o.now]
 */
export function createAuth({ key, allowedOrigins = [], allowLoopback = true, ratePerMinute = 40, now = Date.now }) {
    key = String(key ?? '');
    const split = key.indexOf(':');
    if (split < 3 || !/^[\w-]+\.[\w-]+$/.test(key.slice(0, split)) || key.length - split < 9) throw new Error('not an Ably API key ("appId.keyId:secret")');
    const keyName = key.slice(0, split), keySecret = key.slice(split + 1);
    // One secret to look after: everything this signs for itself is signed with a key made from Ably's.
    const own = hmac(keySecret, 'wonder-world-online-v1');
    const sign = async (text) => b64url(await hmac(await own, text));

    const buckets = new Map();
    function limited(ip) {
        const t = now();
        let b = buckets.get(ip);
        if (!b) { if (buckets.size > 20000) buckets.clear(); buckets.set(ip, b = { n: ratePerMinute, t }); }
        b.n = Math.min(ratePerMinute, b.n + (t - b.t) * ratePerMinute / 60000);
        b.t = t;
        if (b.n < 1) return true;
        b.n -= 1;
        return false;
    }

    const originOk = (origin) => !origin || allowedOrigins.includes(origin) || (allowLoopback && LOOPBACK.test(origin));

    async function identity(device, slot) {
        if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(device)) return null;
        if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) return null;
        const deviceId = 'p' + (await sign(`device|${device}`)).slice(0, 20);
        return { deviceId, clientId: `${deviceId}-${slot}` };
    }
    const ticketFor = (code, deviceId) => sign(`host|${code}|${deviceId}`);

    function newCode() {
        let code = '';
        const bytes = new Uint8Array(32);
        while (code.length < CODE_LENGTH) {
            crypto.getRandomValues(bytes);
            // 248 is the largest multiple of 31 a byte holds: anything above would favour the first letters.
            for (const b of bytes) if (b < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
        }
        return code;
    }

    async function grant(code, who, host) {
        const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
        return tokenRequest({ keyName, keySecret, clientId: who.clientId, capability: capability(code, who.clientId, host), timestamp: now(), nonce });
    }

    /**
     * Answer one request.
     * @param {{ method: string, path: string, origin?: string, body?: any, ip?: string }} req  `path` ends in /host or /token
     * @returns {Promise<{ status: number, headers: Record<string,string>, body: object|null }>}
     */
    async function respond({ method, path, origin = '', body = null, ip = '' }) {
        const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
        if (origin && originOk(origin)) {
            headers['Access-Control-Allow-Origin'] = origin;
            headers['Vary'] = 'Origin';
            headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
            headers['Access-Control-Allow-Headers'] = 'Content-Type';
            headers['Access-Control-Max-Age'] = '600';
        }
        const out = (status, b) => ({ status, headers, body: b });
        if (!originOk(origin)) return out(403, { error: 'origin' });
        if (method === 'OPTIONS') return out(204, null);
        const op = /\/(host|token)\/?$/.exec(path)?.[1];
        if (method === 'GET' && !op) return out(200, { ok: true, service: 'wonder-world-online' });
        if (method !== 'POST' || !op) return out(404, { error: 'not found' });
        if (limited(ip || 'unknown')) return out(429, { error: 'slow down' });
        if (!body || typeof body !== 'object' || Array.isArray(body)) return out(400, { error: 'bad request' });

        const who = await identity(body.device, body.slot ?? 0);
        if (!who) return out(400, { error: 'bad request' });

        if (op === 'host') {
            if (body.slot) return out(400, { error: 'bad request' });       // the first player of a machine hosts
            const code = newCode();
            return out(200, { code, clientId: who.clientId, host: true, ticket: await ticketFor(code, who.deviceId), tokenRequest: await grant(code, who, true) });
        }

        const code = cleanCode(body.code);
        if (!code || body.code !== code) return out(400, { error: 'bad request' });
        let host = false;
        if (body.ticket !== undefined && body.ticket !== null) {
            // A ticket that is not this room's, or not this player's, is not a mistake to pass over.
            if (body.slot || !same(body.ticket, await ticketFor(code, who.deviceId))) return out(403, { error: 'ticket' });
            host = true;
        }
        return out(200, { code, clientId: who.clientId, host, tokenRequest: await grant(code, who, host) });
    }

    /** The same, for anything that speaks Request and Response (a Worker, Node's own). */
    async function handle(request, ip = '') {
        let body = null;
        if (request.method === 'POST') {
            const text = await request.text();
            if (text.length > 2048) return json(413, {}, { error: 'too large' });
            try { body = JSON.parse(text); } catch { body = null; }
        }
        const r = await respond({ method: request.method, path: new URL(request.url).pathname, origin: request.headers.get('Origin') ?? '', body, ip });
        return json(r.status, r.headers, r.body);
    }
    const json = (status, headers, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: body === null ? headers : { ...headers, 'Content-Type': 'application/json' } });

    return { respond, handle, keyName };
}
