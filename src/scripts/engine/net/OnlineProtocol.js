/**
 * The online protocol, as the game knows it: what it and the online server
 * say to each other (online/src/protocol.ts is the server's copy; the server
 * is deployed by itself and cannot import this, so online/test/protocol.test.ts
 * reads both and fails when they differ).
 *
 * PROTOCOL goes up whenever a message changes shape or meaning. A game the
 * server does not speak the number of is turned away with `Reject.PROTOCOL`.
 *
 * No Three.js, no DOM: it runs in a test, and in the tool that tells the
 * server which blocks there are (online/tools/sync-content.mjs).
 */

export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

/** The one room type: a world someone is hosting. */
export const ROOM = 'world';

/** Game → server. */
export const C2S = {
    STATE: 'state', BLOCK: 'block', PROFILE: 'profile', SYNC: 'sync',
    ATMOS: 'atmos', MOBS: 'mobs', ATTACK: 'attack', DROPS: 'drops', KICK: 'kick', LOCK: 'lock', REPLY: 'reply',
    HIT: 'hit', MANIFEST: 'manifest', CHUNK: 'chunk', PLOAD: 'pload', PSAVE: 'psave',
};

/** Server → game. */
export const S2C = {
    WELCOME: 'welcome', STATES: 'states', BLOCK: 'block', REJECT: 'reject', ATMOS: 'atmos', MOBS: 'mobs',
    HIT: 'hit', ATTACK: 'attack', DROPS: 'drops', CLOSED: 'closed', ASK: 'ask',
};

/** What the server asks the host's game for, on a guest's behalf. */
export const HostOp = { MANIFEST: 'manifest', CHUNK: 'chunk', PLOAD: 'pload', PSAVE: 'psave' };

/** What came of a chunk request. */
export const ChunkStatus = { NONE: 0, DATA: 1, EDITS: 2, RETRY: 3 };

/** Why a block change was refused. */
export const RejectWhy = { RATE: 'rate', REACH: 'reach', BLOCK: 'block', EDITION: 'edition', MODE: 'mode', POSITION: 'position' };

/** Why a join was refused (the `code` of the error the SDK's join rejects with). */
export const Reject = {
    AUTH: 461, PROTOCOL: 462, CONTENT: 463, CODE: 464, FULL: 465, BANNED: 466, EDITION: 467,
    LIMIT: 468, BAD_REQUEST: 469, WORLD_GEN: 470, CLOSING: 471, VERSION: 472,
};

/** Why the room closed a connection (WebSocket close codes). */
export const Close = { KICKED: 4101, HOST_LEFT: 4102, FLOOD: 4103, INVALID: 4104, ROOM_CLOSED: 4105, SHUTDOWN: 4106 };

/** Reasons in S2C.CLOSED, as the game's sessionOver() knows them. */
export const ClosedReason = { HOST: 'host', CLOSED: 'closed', KICKED: 'kicked', SHUTDOWN: 'shutdown', FLOOD: 'flood' };

export const WORLD = { MIN_Y: -128, MAX_Y: 319, LIMIT_XZ: 2_000_000, CHUNK_LIMIT: 125_000, MAX_BLOCK_ID: 65_535, WATER: 5 };

export const StateFlag = { ON_GROUND: 1, IN_WATER: 2, DEAD: 4, HIDDEN: 8 };

export const MAX_NAME = 16;
export const MAX_SKIN_KEYS = 24;
export const MAX_LOCAL_PLAYERS = 4;
export const HARD_MAX_PLAYERS = 8;

/** A room code: eight of these, shown as XXXX-XXXX. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** A room code as typed — any case, with or without the dash — or '' if it cannot be one. */
export function cleanCode(text) {
    const code = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== CODE_LENGTH) return '';
    for (const c of code) if (!CODE_ALPHABET.includes(c)) return '';
    return code;
}
/** … and as shown. */
export const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// ── What a world is made of ───────────────────────────────────────────────────

/** JSON with every object's keys in order, so the same data gives the same text. */
function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v).sort().map(k => v[k] === undefined ? '' : `${JSON.stringify(k)}:${stable(v[k])}`).filter(Boolean).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
}

/** cyrb53: 53 well-mixed bits of a string. A fingerprint, not a secret. */
function hash53(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** What of a block decides the shape of the world and what stands in it — not how it looks. */
const BLOCK_FIELDS = ['id', 'name', 'terrainType', 'transparent', 'liquid', 'noCollision', 'model', 'facing', 'support', 'light'];

/**
 * A fingerprint of everything that decides what a world is: the blocks (their
 * ids, names and shapes), the biomes and the geology. Two games with the same
 * fingerprint generate the same land from the same seed and mean the same
 * thing by a block id, so they can share a world; two that differ cannot, and
 * the server keeps them apart. Textures, sounds, items and recipes are not in
 * it: a pack that only repaints the game still plays with everyone.
 *
 * @param {{ blocks?: object[], biomes?: object[], terrain?: object[] }} gamepack  the merged gamepack data
 * @returns {string} 28 hex digits
 */
export function contentHash(gamepack) {
    const blocks = [...(gamepack?.blocks ?? [])].sort((a, b) => a.id - b.id)
        .map(b => Object.fromEntries(BLOCK_FIELDS.filter(f => b[f] !== undefined && b[f] !== null && b[f] !== false).map(f => [f, b[f]])));
    const biomes = [...(gamepack?.biomes ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(({ mapColor: _colour, ...rest }) => rest);
    const terrain = [...(gamepack?.terrain ?? [])].map(stable).sort();
    const text = `${stable(blocks)}|${stable(biomes)}|[${terrain.join(',')}]`;
    return hash53(text, 1).toString(16).padStart(14, '0') + hash53(text, 2).toString(16).padStart(14, '0');
}

/** The blocks of a gamepack as the server keeps them: [id, name, liquid]. */
export function blockTable(gamepack) {
    return [...(gamepack?.blocks ?? [])].sort((a, b) => a.id - b.id).map(b => [b.id, String(b.name), b.liquid ? 1 : 0]);
}
