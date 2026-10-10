/**
 * The server's few HTTP routes: signing in, finding a room by its code, and
 * the ones an operator's tools read.
 *
 *   POST /auth/guest     { credential? }   → { token, credential, account, edition, expiresIn }
 *   POST /auth/steam     { ticket }        → { token, account, edition, expiresIn }
 *   POST /auth/dev       { name, edition } → the same; development and tests only
 *   POST /rooms/resolve  { code }          → { roomId }          (needs a session token)
 *   GET  /info                             → what a game needs to know before it tries
 *   GET  /healthz                          → 200 while the process is up
 *   GET  /readyz                           → 200 while it is taking players, 503 while it shuts down
 *   GET  /metrics                          → counters, for whoever holds METRICS_TOKEN
 *
 * Everything that takes a body takes a small one, is counted against the
 * address it came from, and answers a failure the same way whatever the
 * reason was — an answer that explained itself would be a way to guess.
 */
import crypto from 'node:crypto';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { matchMaker } from 'colyseus';
import { config } from './config.js';
import { log, metrics, acctTag, netOf } from './log.js';
import { clientIp, ipKey, originAllowed } from './net.js';
import { registry } from './registry.js';
import { steam, SteamError } from './auth/steam.js';
import { signSession, verifySession, newGuestId, signGuestCredential, verifyGuestCredential } from './auth/tokens.js';
import { PROTOCOL, MIN_PROTOCOL, CODE_ALPHABET, CODE_LENGTH } from './protocol.js';
import { knownContents } from './content.js';
import { CODES } from './rooms/WorldRoom.js';

const ipOf = (req: Request) => clientIp(req.headers, req.socket?.remoteAddress);

/** Count a request against its address; answer 429 when that is one too many. */
function limited(limiter: 'auth' | 'resolveIp', req: Request, res: Response): boolean {
    const ip = ipOf(req);
    if (registry.limiters[limiter].hit(ipKey(ip))) return false;
    log.security('http_rate', { net: netOf(ip), route: req.path });
    res.status(429).set('Retry-After', '60').json({ error: 'too many requests' });
    return true;
}

function bearer(req: Request): string {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/** HTTP Basic authentication for an operator's page: one user, one password, compared in constant time. */
export function passwordGuard(user: string, password: string) {
    const want = crypto.createHash('sha256').update(`${user}:${password}`).digest();
    return (req: Request, res: Response, next: NextFunction) => {
        const h = req.headers.authorization ?? '';
        const got = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8') : '';
        if (got && crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(), want)) return next();
        res.status(401).set('WWW-Authenticate', 'Basic realm="Wonder World", charset="UTF-8"').type('text/plain').send('authentication required');
    };
}

export function bindRoutes(app: Application): void {
    app.disable('x-powered-by');
    app.set('trust proxy', false);        // addresses are read in net.ts, on this server's own terms

    // An API, not a site: nothing it answers is a page to frame, sniff or cache.
    app.use((req: Request, res: Response, next: NextFunction) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        if (config.prod) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        // The matchmaker's CORS answer is already on the response (gate.ts); a page it does not allow goes no further.
        if (req.method !== 'GET' && !originAllowed(req.headers.origin)) return res.status(403).json({ error: 'forbidden' });
        next();
    });

    const json = express.json({ limit: '8kb', strict: true, type: 'application/json' });
    const body = (req: Request) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

    // ── Signing in ────────────────────────────────────────────────────────────

    app.post('/auth/guest', json, async (req, res) => {
        if (limited('auth', req, res)) return;
        let id = await verifyGuestCredential(body(req).credential);
        if (!id) {
            // A new guest. Cheap to make, so not many from one address.
            const ip = ipOf(req);
            if (!registry.limiters.newGuests.hit(ipKey(ip))) {
                log.security('guest_rate', { net: netOf(ip) });
                return res.status(429).set('Retry-After', '600').json({ error: 'too many requests' });
            }
            id = newGuestId();
            metrics.inc('guests_created');
        }
        const account = `guest:${id}`;
        const session = await signSession(account, 'free');
        // A fresh credential each time, so one in use never runs out.
        res.json({ ...session, credential: await signGuestCredential(id), account, edition: 'free' });
        metrics.inc('auth_guest');
    });

    app.post('/auth/steam', json, async (req, res) => {
        if (limited('auth', req, res)) return;
        try {
            const r = await steam.verifyTicket(body(req).ticket);
            const account = `steam:${r.steamId}`, edition = r.owns ? 'full' as const : 'free' as const;
            const session = await signSession(account, edition);
            metrics.inc(`auth_steam_${edition}`);
            log.info('auth.steam', { acct: acctTag(account), edition, shared: r.ownerSteamId !== r.steamId });
            res.json({ ...session, account, edition });
        } catch (e) {
            const reason = e instanceof SteamError ? e.reason : 'unavailable';
            metrics.inc(`auth_steam_${reason}`);
            if (reason === 'invalid' || reason === 'banned') log.security('steam_refused', { net: netOf(ipOf(req)), reason });
            // Steam not answering is the operator's to know. (SteamError's messages are fixed: the address, which carries the key, is never in one.)
            if (reason === 'unavailable' && e instanceof SteamError) log.warn('auth.steam_unavailable', { message: e.message });
            if (!(e instanceof SteamError)) log.error('auth.steam_error', { message: String((e as Error)?.message ?? e).slice(0, 200) });
            // Steam being down is the server's trouble (503); anything else is "no" (401), without saying why.
            res.status(reason === 'disabled' || reason === 'unavailable' ? 503 : 401).json({ error: reason === 'disabled' ? 'steam sign-in is not available' : reason === 'unavailable' ? 'steam did not answer' : 'not accepted' });
        }
    });

    // Any name, any edition: for a developer's machine and the tests. Off, it is a page that is not there —
    // and assertProductionSafe() will not let a production server start with it on.
    app.post('/auth/dev', json, async (req, res, next) => {
        if (!config.devAuth) return next();
        {
            const name = String(body(req).name ?? 'dev').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'dev';
            const edition = body(req).edition === 'free' ? 'free' as const : 'full' as const;
            res.json({ ...await signSession(`dev:${name}`, edition), account: `dev:${name}`, edition });
        }
    });

    // ── Finding a room ────────────────────────────────────────────────────────

    app.post('/rooms/resolve', json, async (req, res) => {
        if (limited('resolveIp', req, res)) return;
        const session = await verifySession(bearer(req)).catch(() => null);
        if (!session) return res.status(401).json({ error: 'sign in again' });
        if (!registry.limiters.resolveAccount.hit(session.sub)) {
            log.security('resolve_rate', { acct: acctTag(session.sub) });
            return res.status(429).set('Retry-After', '60').json({ error: 'too many requests' });
        }
        const code = String(body(req).code ?? '');
        const wellFormed = code.length === CODE_LENGTH && [...code].every(c => CODE_ALPHABET.includes(c));
        const roomId = wellFormed ? await matchMaker.presence.hget(CODES, code) : null;
        if (!roomId) {
            metrics.inc('resolve_miss');
            return res.status(404).json({ error: 'no game has that code' });
        }
        metrics.inc('resolve_hit');
        res.json({ roomId });
    });

    // ── For games and operators ───────────────────────────────────────────────

    app.get('/info', (_req, res) => {
        res.json({
            protocol: PROTOCOL, minProtocol: MIN_PROTOCOL, minGameVersion: config.minGameVersion || null,
            steam: steam.enabled, contents: knownContents(),
            editions: { full: { canHost: config.editions.full.canHost }, free: { canHost: config.editions.free.canHost } },
        });
    });

    app.get('/healthz', (_req, res) => { res.type('text/plain').send('ok'); });
    app.get('/readyz', (_req, res) => {
        const ready = !registry.closing;
        res.status(ready ? 200 : 503).json({ ready, rooms: registry.rooms.size, players: registry.players() });
    });

    app.get('/metrics', (req, res) => {
        const want = config.metricsToken, got = bearer(req);
        // No token set: there is no such page. A wrong one is told the same.
        const ok = !!want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
        if (!ok) return res.status(404).type('text/plain').send('not found');
        res.type('text/plain; version=0.0.4').send(metrics.render());
    });

    app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'not found' }); });
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        // A body too big or not JSON: the client's mistake, and not worth a stack trace.
        const status = err?.type === 'entity.too.large' ? 413 : err?.status === 400 || err instanceof SyntaxError ? 400 : 500;
        if (status === 500) log.error('http.error', { message: String(err?.message ?? err).slice(0, 200) });
        res.status(status).json({ error: status === 500 ? 'server error' : 'bad request' });
    });
}
