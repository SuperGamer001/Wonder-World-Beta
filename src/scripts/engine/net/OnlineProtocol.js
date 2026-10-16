/**
 * The online protocol: what games in one online room say to one another.
 *
 * Online play goes through Ably (see *Online* in CLAUDE.md): there is no game
 * server in the middle, only channels that Ably passes messages along. A room
 * is four kinds of channel, and what a game may do on each is in its token
 * (online/auth.js — `channels` here is the game's copy of the names; a test
 * holds the two equal):
 *
 *   all    everyone speaks and hears: where each player is, the blocks they
 *          change, a guest's word of the mobs its game runs. Everyone is
 *          "present" here, which is the list of players.
 *   host   only the host speaks: who is in the room and under which number,
 *          the host's mobs, the clock and weather, a block put right, goodbye.
 *   up     guests speak, only the host hears: what a guest has for the host
 *          alone (a blow on a mob the host's game runs, a chest to open), and
 *          what it asks of the host's world (its chunks, its own saved place).
 *   to:<clientId>   the host speaks, one guest hears: the welcome, answers.
 *
 * And one channel for all rooms: `ww:lobby`, where the host of a public room
 * stands ("present") with a line about its room. No game reads it: the token
 * service does, and gives out the list (online/auth.js: `rooms`).
 *
 * PROTOCOL goes up whenever a message changes shape or meaning; a host turns
 * away a game that speaks another.
 *   2: every game runs the mobs nearest its own player and tells the others
 *      (a guest's word of its mobs goes on `all`), a mob is handed from game
 *      to game, and a chest's contents are shared — where 1 had the host run
 *      every mob and nobody share a chest. A message one player has for one
 *      other, with no line between them (guest to guest), goes on `all`
 *      marked `to`.
 *   3: chat ('chat'), commands (a guest's goes to the host as typed, 'cmd';
 *      what came of one is the host's word, 'sys', and its part for one
 *      player, 'act'), and a mob a guest has walked away from is the host's
 *      to keep ('mobsleep') and to hand back.
 *
 * No Three.js, no DOM: it runs in a test.
 */

export const PROTOCOL = 3;

/** The channels of the room with this code. */
export function channels(code) {
    return { all: `ww:${code}:all`, host: `ww:${code}:host`, up: `ww:${code}:up`, to: (clientId) => `ww:${code}:to:${clientId}` };
}

/** Where public rooms stand to be listed. */
export const LOBBY = 'ww:lobby';

/** Message names. Short: each is sent many times. */
export const MSG = {
    // all
    STATE: 's', BLOCK: 'b', SAY: 'm',
    // host
    ROSTER: 'r', ATMOS: 'a', FIX: 'f', BYE: 'bye',
    // up
    TO_HOST: 'h', ASK: 'q',
    // to:<clientId>
    WELCOME: 'w', REFUSE: 'x', KICK: 'k', TO: 't', REPLY: 'r',
};

/** What came of a chunk request. */
export const ChunkStatus = { NONE: 0, DATA: 1, EDITS: 2, RETRY: 3 };

export const WORLD = { MIN_Y: -128, MAX_Y: 319, LIMIT_XZ: 2_000_000, MAX_BLOCK_ID: 65_535, WATER: 5 };

export const MAX_NAME = 16;
export const MAX_SKIN_KEYS = 24;
export const MAX_LOCAL_PLAYERS = 4;
/** A room's most players. Ably's free plan carries 50 messages a second on a channel, and each player sends 5. */
export const HARD_MAX_PLAYERS = 6;

/** How often things are said online, at most (ms). Every message is counted against the Ably plan: see online/README.md. */
export const RATE = { STATE: 200, STATE_IDLE: 2000, MOBS: 300, ATMOS: 4000, ASK: 40, REPLY: 35 };
/** The most of one message's bytes (Ably's limit is 64 KiB). */
export const PART_BYTES = 48 * 1024;
/** How far from where a player stands a block of theirs may be, as the host judges it; further for water, which flows. */
export const REACH = { BLOCK: 12, FLUID: 96 };

/** A name as it may be shown: the game's own rule for names (src/players.js), applied to what a stranger sent. */
export function cleanName(raw) {
    return String(typeof raw === 'string' ? raw : '').replace(/[^A-Za-z0-9 ._'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Player';
}
/** A room's name in the list of public games: plain characters, and not many. */
export function cleanRoomName(raw) {
    return String(typeof raw === 'string' ? raw : '').replace(/[^A-Za-z0-9 ._'!&-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'World';
}
/** A look: small whole numbers by short names, and nothing else. */
export function cleanSkin(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
        if (n >= MAX_SKIN_KEYS) break;
        if (/^[A-Za-z]{1,16}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 64) { out[k] = v; n++; }
    }
    return out;
}

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
 * a host turns the other away. Textures, sounds, items and recipes are not in
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
