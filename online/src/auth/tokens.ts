/**
 * Tokens: how the server knows who a connection is.
 *
 * The game has no accounts of its own, so there are two kinds of player:
 *
 *   • `steam:<id>` — someone the desktop game proved to be, with a Steam
 *     ticket this server checked with Steam (steam.ts). Owning the game there
 *     is what makes an edition `full`.
 *   • `guest:<id>` — anybody else: the free browser edition, or a desktop
 *     game that Steam could not vouch for. The id is made here, at random,
 *     the first time a game asks, and handed back inside a signed **guest
 *     credential** the game keeps and shows next time. It is a bearer token:
 *     whoever holds it is that guest. That is all an anonymous player can be.
 *
 * Either way the game is given a short-lived **session token** — who it is,
 * and which edition — and that is the only thing the rooms believe. Nothing
 * a client says about itself (its name, its edition, a Steam id, a role) is
 * read as a fact anywhere.
 *
 * Tokens are JWTs signed with HS256 (`@colyseus/auth`'s JWT, which is
 * `jsonwebtoken`), pinned to that algorithm, this issuer and an audience per
 * kind, so a guest credential cannot be shown as a session token.
 */
import crypto from 'node:crypto';
import { JWT } from '@colyseus/auth';
import { config } from '../config.js';
import type { Edition } from '../protocol.js';

const ISSUER = 'wonder-world-online';
const AUD_SESSION = 'ww-session';
const AUD_GUEST = 'ww-guest';

export interface Session {
    /** The account: `steam:<id64>`, `guest:<id>`, or `dev:<name>` outside production. */
    sub: string;
    ed: Edition;
}

/** Point the JWT helper at this server's secret. Called once before listening (and by tests). */
export function initTokens(): void {
    JWT.settings.secret = config.jwtSecret;
    JWT.settings.verify = { algorithms: ['HS256'], issuer: ISSUER, audience: AUD_SESSION };
}

export async function signSession(account: string, edition: Edition): Promise<{ token: string; expiresIn: number }> {
    const token = await JWT.sign({ ed: edition }, {
        algorithm: 'HS256', subject: account, issuer: ISSUER, audience: AUD_SESSION, expiresIn: config.sessionTtlSec,
    });
    return { token, expiresIn: config.sessionTtlSec };
}

const ACCOUNT = /^(steam:\d{17}|guest:[A-Za-z0-9_-]{22}|dev:[a-z0-9-]{1,24})$/;

/** Who a session token says its bearer is. Throws on anything that is not one of ours, in date. */
export async function verifySession(token: unknown): Promise<Session> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 2048) throw new Error('no token');
    const p = await JWT.verify<any>(token, { algorithms: ['HS256'], issuer: ISSUER, audience: AUD_SESSION });
    if (typeof p?.sub !== 'string' || !ACCOUNT.test(p.sub)) throw new Error('bad subject');
    if (p.ed !== 'full' && p.ed !== 'free') throw new Error('bad edition');
    if (p.sub.startsWith('dev:') && !config.devAuth) throw new Error('dev token');
    // A guest is never the full edition, whatever a token says: only Steam (or dev auth) grants it.
    if (p.sub.startsWith('guest:') && p.ed !== 'free') throw new Error('guest edition');
    return { sub: p.sub, ed: p.ed };
}

export function newGuestId(): string {
    return crypto.randomBytes(16).toString('base64url');      // 128 bits, 22 characters
}

export async function signGuestCredential(guestId: string): Promise<string> {
    return JWT.sign({}, {
        algorithm: 'HS256', subject: `guest:${guestId}`, issuer: ISSUER, audience: AUD_GUEST,
        expiresIn: config.guestCredentialTtlDays * 24 * 60 * 60,
    });
}

/** The guest id in a credential this server issued, or null. */
export async function verifyGuestCredential(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 2048) return null;
    try {
        const p = await JWT.verify<any>(token, { algorithms: ['HS256'], issuer: ISSUER, audience: AUD_GUEST });
        const m = /^guest:([A-Za-z0-9_-]{22})$/.exec(p?.sub ?? '');
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/**
 * The name a guest's saved place is kept under on a host's disk. The host's
 * game is told this and nothing else about who the guest is: it is the same
 * every time this guest plays this host's worlds under this name, and it says
 * nothing of the account behind it. The server makes it, so a guest cannot
 * ask for somebody else's.
 */
export function playerKey(hostAccount: string, account: string, name: string): string {
    return crypto.createHmac('sha256', config.playerKeySecret)
        .update(`${hostAccount}\n${account}\n${name.toLowerCase()}`).digest('base64url').slice(0, 24);
}

/** Constant-time comparison of two short strings. */
export function sameText(a: string, b: string): boolean {
    const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(x, y);
}
