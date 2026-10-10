/**
 * Configuration: everything that differs between a developer's machine and the
 * real server comes from the environment, is checked here, and is read from
 * `config` everywhere else.
 *
 * `@colyseus/tools` loads `.env.<NODE_ENV>` (or `.env`) before this module is
 * evaluated; on a host the variables are simply set (see docs/OPERATIONS.md).
 * No secret has a default. In development the signing secrets are made up
 * afresh at every start; in production the server refuses to start without
 * real ones (`assertProductionSafe`), rather than run with something guessable.
 */
import crypto from 'node:crypto';

export type Env = 'development' | 'production' | 'test';

type Source = Record<string, string | undefined>;

function int(src: Source, name: string, def: number, min: number, max: number): number {
    const raw = src[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
    return Math.max(min, Math.min(max, Math.round(n)));
}

function bool(src: Source, name: string, def: boolean): boolean {
    const raw = src[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '') return def;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new Error(`${name} must be true or false (got "${src[name]}")`);
}

function list(src: Source, name: string): string[] {
    return (src[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export interface EditionPolicy {
    /** May create a room (host a world online). */
    canHost: boolean;
    /** The most players a room this edition hosts may hold. */
    maxRoomPlayers: number;
    /** Players of one account in one room: the panes of a split screen. */
    maxLocalPlayers: number;
    /** May change blocks at all. */
    canBuild: boolean;
    /** Block names this edition may not place (breaking is not restricted). */
    blockedBlocks: string[];
}

export function loadConfig(src: Source = process.env) {
    const env: Env = src.NODE_ENV === 'production' ? 'production' : src.NODE_ENV === 'test' ? 'test' : 'development';
    const prod = env === 'production';
    // Made up per process outside production: nothing to leak, nothing to guess.
    const throwaway = () => crypto.randomBytes(48).toString('base64url');

    const editionJson = (name: string, def: EditionPolicy): EditionPolicy => {
        const raw = src[name];
        if (!raw) return def;
        let o: any;
        try { o = JSON.parse(raw); } catch { throw new Error(`${name} must be JSON`); }
        return {
            canHost: typeof o.canHost === 'boolean' ? o.canHost : def.canHost,
            maxRoomPlayers: Number.isInteger(o.maxRoomPlayers) ? Math.max(1, Math.min(8, o.maxRoomPlayers)) : def.maxRoomPlayers,
            maxLocalPlayers: Number.isInteger(o.maxLocalPlayers) ? Math.max(1, Math.min(4, o.maxLocalPlayers)) : def.maxLocalPlayers,
            canBuild: typeof o.canBuild === 'boolean' ? o.canBuild : def.canBuild,
            blockedBlocks: Array.isArray(o.blockedBlocks) ? o.blockedBlocks.map((s: unknown) => String(s).toUpperCase()).slice(0, 512) : def.blockedBlocks,
        };
    };

    return {
        env, prod,
        port: int(src, 'PORT', 2567, 1, 65535),

        // ── Secrets ──────────────────────────────────────────────────────────
        /** Signs session tokens and guest credentials (HS256). */
        jwtSecret: src.JWT_SECRET || (prod ? '' : throwaway()),
        /** Keys the name a guest's saved place is kept under on a host's disk. Changing it orphans them. */
        playerKeySecret: src.PLAYER_KEY_SECRET || (prod ? '' : throwaway()),
        /** Salts the account and address tags in the logs, so a log does not name anyone. */
        logSalt: src.LOG_SALT || throwaway(),

        // ── Who may connect ──────────────────────────────────────────────────
        /** Exact origins of the browser edition, e.g. https://play.example.com */
        allowedOrigins: list(src, 'ALLOWED_ORIGINS'),
        /** The desktop app's page comes from 127.0.0.1 on a port the system picks. */
        allowLoopbackOrigins: bool(src, 'ALLOW_LOOPBACK_ORIGINS', true),
        /** A client with no Origin at all (not a browser: a test, a tool). */
        allowNoOrigin: bool(src, 'ALLOW_NO_ORIGIN', !prod),
        /**
         * Whether a reverse proxy in front of this process sets X-Real-IP /
         * X-Forwarded-For. Only then are those headers believed: without one
         * anybody can write them.
         */
        trustProxy: bool(src, 'TRUST_PROXY', false),

        // ── Steam ────────────────────────────────────────────────────────────
        steamAppId: src.STEAM_APP_ID || '',
        /** The publisher Web API key. Server only: never in a client. */
        steamWebApiKey: src.STEAM_WEB_API_KEY || '',
        /** The identity a game asks its ticket for (GetAuthTicketForWebApi), and this server checks it against. */
        steamIdentity: src.STEAM_IDENTITY || 'wonder-world-online',
        /** Whether a library shared by a family member counts as owning the game. */
        steamAllowFamilySharing: bool(src, 'STEAM_ALLOW_FAMILY_SHARING', true),
        steamTimeoutMs: int(src, 'STEAM_TIMEOUT_MS', 6000, 500, 30000),

        /** POST /auth/dev hands out a token for any edition. Development and tests only. */
        devAuth: bool(src, 'DEV_AUTH', !prod),

        sessionTtlSec: int(src, 'SESSION_TTL_SEC', 60 * 60, 60, 24 * 60 * 60),
        guestCredentialTtlDays: int(src, 'GUEST_CREDENTIAL_TTL_DAYS', 180, 1, 730),

        // ── Versions ─────────────────────────────────────────────────────────
        /** Oldest game version let in, e.g. "0.2.0". Empty: any. */
        minGameVersion: src.MIN_GAME_VERSION || '',
        /** Let rooms be made by games whose blocks this server does not know (gamepacks). Block ids are then only range-checked. */
        allowUnknownContent: bool(src, 'ALLOW_UNKNOWN_CONTENT', !prod),

        // ── Editions ─────────────────────────────────────────────────────────
        editions: {
            full: editionJson('EDITION_FULL', { canHost: true, maxRoomPlayers: 8, maxLocalPlayers: 4, canBuild: true, blockedBlocks: [] }),
            free: editionJson('EDITION_FREE', { canHost: false, maxRoomPlayers: 4, maxLocalPlayers: 2, canBuild: true, blockedBlocks: [] }),
        },

        // ── Capacity ─────────────────────────────────────────────────────────
        maxRooms: int(src, 'MAX_ROOMS', 200, 1, 100000),
        maxConnections: int(src, 'MAX_CONNECTIONS', 1500, 1, 1000000),
        /** Sockets from one address. Four players share a screen, and a household shares an address. */
        maxConnectionsPerIp: int(src, 'MAX_CONNECTIONS_PER_IP', 12, 1, 10000),
        /** Rooms one account may be in at a time. */
        maxRoomsPerAccount: int(src, 'MAX_ROOMS_PER_ACCOUNT', 1, 1, 16),

        // ── Rates (per minute unless said otherwise) ─────────────────────────
        rate: {
            matchmakePerIp: int(src, 'RATE_MATCHMAKE_PER_IP', 30, 1, 100000),
            createPerAccountPerHour: int(src, 'RATE_CREATE_PER_ACCOUNT_HOUR', 12, 1, 100000),
            authPerIp: int(src, 'RATE_AUTH_PER_IP', 20, 1, 100000),
            newGuestsPerIpPerHour: int(src, 'RATE_NEW_GUESTS_PER_IP_HOUR', 10, 1, 100000),
            resolvePerIp: int(src, 'RATE_RESOLVE_PER_IP', 20, 1, 100000),
            resolvePerAccount: int(src, 'RATE_RESOLVE_PER_ACCOUNT', 12, 1, 100000),
            /** Every message of a connection, per second: past it Colyseus closes the socket. */
            messagesPerSecond: int(src, 'RATE_MESSAGES_PER_SECOND', 300, 20, 10000),
            /** Refused or dropped messages a minute before a player is removed. */
            violationsPerMinute: int(src, 'RATE_VIOLATIONS_PER_MINUTE', 600, 10, 1000000),
            /** Messages that do not parse, a minute, before a player is removed. */
            invalidPerMinute: int(src, 'RATE_INVALID_PER_MINUTE', 8, 1, 100000),
            /** Requests passed on to a room's host, a second, for all its guests together. */
            hostAsksPerSecond: int(src, 'RATE_HOST_ASKS_PER_SECOND', 60, 1, 10000),
        },

        // ── Sizes ────────────────────────────────────────────────────────────
        /** The largest body an HTTP request may carry: sign-in, and asking for a place in a room. */
        maxHttpBodyBytes: int(src, 'MAX_HTTP_BODY_BYTES', 16 * 1024, 1024, 1024 * 1024),
        /** The largest frame a client may send: a host's chunk, compressed. */
        maxPayloadBytes: int(src, 'MAX_PAYLOAD_BYTES', 96 * 1024, 4096, 4 * 1024 * 1024),
        maxChunkBytes: int(src, 'MAX_CHUNK_BYTES', 80 * 1024, 1024, 4 * 1024 * 1024),
        maxPlayerStateBytes: int(src, 'MAX_PLAYER_STATE_BYTES', 48 * 1024, 1024, 1024 * 1024),
        /** Bytes of chunk data relayed for one room, a minute. */
        maxRelayBytesPerMinute: int(src, 'MAX_RELAY_BYTES_PER_MINUTE', 48 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024 * 1024),
        /** Block changes kept to replay to a player whose line dropped. */
        recentEdits: int(src, 'RECENT_EDITS', 8192, 64, 1_000_000),

        // ── Play ─────────────────────────────────────────────────────────────
        /** Seconds a dropped player's place is held. */
        guestGraceSec: int(src, 'GUEST_GRACE_SEC', 30, 0, 600),
        /** … and the host's: the room waits this long before it ends. */
        hostGraceSec: int(src, 'HOST_GRACE_SEC', 60, 0, 600),
        /** Blocks a second, level: faster than this is not passed on. */
        maxSpeed: int(src, 'MAX_SPEED', 60, 5, 1000),
        /** How far from a player a block they change may be. */
        blockReach: int(src, 'BLOCK_REACH', 12, 4, 256),
        /** … water, which runs on from where it was poured. */
        fluidReach: int(src, 'FLUID_REACH', 96, 8, 1024),
        /** How far a blow lands: a sword is short, an arrow is not. */
        hitReach: int(src, 'HIT_REACH', 96, 4, 1024),
        maxHitDamage: int(src, 'MAX_HIT_DAMAGE', 100, 1, 100000),
        maxMobs: int(src, 'MAX_MOBS', 64, 1, 1024),

        // ── Operations ───────────────────────────────────────────────────────
        logLevel: (['debug', 'info', 'warn', 'error'].includes(src.LOG_LEVEL ?? '') ? src.LOG_LEVEL : (env === 'test' ? 'error' : 'info')) as 'debug' | 'info' | 'warn' | 'error',
        /** GET /metrics answers a request carrying this as a bearer token. Empty: no /metrics. */
        metricsToken: src.METRICS_TOKEN || '',
        /** The Colyseus monitor at /monitor, behind this password (user "admin"). Empty: no monitor in production. */
        monitorPassword: src.MONITOR_PASSWORD || '',
    };
}

export type Config = ReturnType<typeof loadConfig>;

/** The one configuration. Tests change its fields before they boot the server. */
export const config: Config = loadConfig();

/**
 * Refuse to run in production with anything a release must not have. Called
 * before the server listens; throws with every problem at once.
 */
export function assertProductionSafe(c: Config = config): void {
    if (!c.prod) return;
    const bad: string[] = [];
    const strong = (s: string) => s.length >= 32 && new Set(s).size >= 12;
    if (!strong(c.jwtSecret)) bad.push('JWT_SECRET must be set to at least 32 random characters');
    if (!strong(c.playerKeySecret)) bad.push('PLAYER_KEY_SECRET must be set to at least 32 random characters');
    if (c.jwtSecret && c.jwtSecret === c.playerKeySecret) bad.push('JWT_SECRET and PLAYER_KEY_SECRET must differ');
    if (c.devAuth) bad.push('DEV_AUTH must be off: it hands out tokens to anyone');
    if (c.allowedOrigins.length === 0 && !c.allowLoopbackOrigins) bad.push('ALLOWED_ORIGINS is empty and ALLOW_LOOPBACK_ORIGINS is off: no game could connect');
    if (c.allowedOrigins.some(o => o === '*' || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))) bad.push('ALLOWED_ORIGINS must be exact https:// origins (no *, no paths)');
    if (!!c.steamAppId !== !!c.steamWebApiKey) bad.push('STEAM_APP_ID and STEAM_WEB_API_KEY go together');
    if (c.monitorPassword && c.monitorPassword.length < 16) bad.push('MONITOR_PASSWORD must be at least 16 characters');
    if (c.metricsToken && c.metricsToken.length < 24) bad.push('METRICS_TOKEN must be at least 24 characters');
    if (bad.length) throw new Error(`Refusing to start in production:\n  - ${bad.join('\n  - ')}`);
}
