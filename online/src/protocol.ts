/**
 * The online protocol: what a game and this server say to each other.
 *
 * The game's side of it is src/scripts/engine/net/OnlineProtocol.js, in the
 * game's repository. This server is deployed by itself and cannot import the
 * game's source, so the two are kept in step by hand — and by
 * test/protocol.test.ts, which reads both and fails when they differ.
 *
 * PROTOCOL goes up whenever a message changes shape or meaning. A game whose
 * number the server does not speak is turned away at the door with
 * `Reject.PROTOCOL`, which the game shows as "update the game".
 */

/** The protocol this server speaks, and the oldest it still accepts. */
export const PROTOCOL = 1;
export const MIN_PROTOCOL = 1;

/** The one room type: a world someone is hosting. */
export const ROOM = 'world';

/** Game → server. */
export const C2S = {
    STATE: 'state',          // [x, y, z, yaw, pitch, speed, flags, swings, hurt] — where this player is
    BLOCK: 'block',          // { x, y, z, b } — this player changed a block
    PROFILE: 'profile',      // { name, skin }
    SYNC: 'sync',            // request { since } — the block changes missed while the line was down
    // The host's game runs what there is one of.
    ATMOS: 'atmos',          // { a } — clock and weather
    MOBS: 'mobs',            // { list, info } — every mob, ten times a second
    ATTACK: 'attack',        // { to, dmg } — a mob struck a player
    DROPS: 'drops',          // { to, pos, items } — what a mob that player killed left
    KICK: 'kick',            // { id }
    LOCK: 'lock',            // { locked }
    REPLY: 'reply',          // { rid, ok, d } — the host's answer to a Host request (below)
    // A guest's.
    HIT: 'hit',              // { id, dmg } — a blow on a mob
    MANIFEST: 'manifest',    // request — which chunks the host holds data for
    CHUNK: 'chunk',          // request { cx, cz } — one of them
    PLOAD: 'pload',          // request — this player's saved place in the host's world
    PSAVE: 'psave',          // { state } — … to be kept
} as const;

/** Server → game. */
export const S2C = {
    WELCOME: 'welcome',      // { id, hostId, code, world, players: [[id, state]…], atmos, seq, limits }
    STATES: 'states',        // [id, state, id, state, …] — everyone who moved, fifteen times a second
    BLOCK: 'block',          // { x, y, z, b, id, seq }
    REJECT: 'reject',        // { x, y, z, why } — a block change of yours was refused: put it back
    ATMOS: 'atmos',
    MOBS: 'mobs',
    HIT: 'hit',              // to the host: { from, id, dmg }
    ATTACK: 'attack',        // to one player: { dmg }
    DROPS: 'drops',          // to one player: { pos, items }
    CLOSED: 'closed',        // { reason } — the room is ending
    ASK: 'ask',              // to the host: { rid, op, … } — a Host request
} as const;

/** What the server asks the host's game for, on a guest's behalf (S2C.ASK `op`). */
export const HostOp = {
    MANIFEST: 'manifest',    // → { keys: string[] }
    CHUNK: 'chunk',          // { cx, cz } → { s: ChunkStatus, d?: Uint8Array }
    PLOAD: 'pload',          // { key } → { state }
    PSAVE: 'psave',          // { key, state } → {}
} as const;

/** What came of a chunk request. */
export const ChunkStatus = {
    NONE: 0,                 // the host has nothing for it: generate it from the seed
    DATA: 1,                 // `d` is the chunk (gzip of the game's own packing)
    EDITS: 2,                // `d` is only the blocks changed in it: generate, then apply
    RETRY: 3,                // not now (the host is busy or away): ask again shortly
} as const;

/** Why a block change was refused (S2C.REJECT `why`). */
export const RejectWhy = {
    RATE: 'rate', REACH: 'reach', BLOCK: 'block', EDITION: 'edition', MODE: 'mode', POSITION: 'position',
} as const;

/**
 * Why a join was refused. These are the `code` of the error the SDK's join
 * call rejects with; the game maps each to a sentence.
 *
 * They are in the unassigned 4xx range on purpose: a refusal made before a
 * room is reached is answered over HTTP with the code as the status, so it has
 * to be one a response can carry.
 */
export const Reject = {
    AUTH: 461,               // no token, or one that does not verify
    PROTOCOL: 462,           // the game is too old (or too new) for this server
    CONTENT: 463,            // the game's blocks and biomes are not the host's
    CODE: 464,               // wrong room code, or no such room
    FULL: 465,               // the room, or this account's share of it, is full
    BANNED: 466,             // the host sent this account away
    EDITION: 467,            // this edition may not do that (host a game)
    LIMIT: 468,              // too many rooms, connections or attempts
    BAD_REQUEST: 469,        // the join options do not make sense
    WORLD_GEN: 470,          // the game cannot generate this world (its generator is newer)
    CLOSING: 471,            // the room is ending
    VERSION: 472,            // the game is older than the server allows
} as const;

/** Why a connection was closed by the room (WebSocket close codes, 4011–4999 are the application's). */
export const Close = {
    KICKED: 4101,            // the host removed this player
    HOST_LEFT: 4102,         // the host's game has gone: the world went with it
    FLOOD: 4103,             // too many messages, or too many refused ones
    INVALID: 4104,           // messages that do not parse, repeatedly
    ROOM_CLOSED: 4105,       // the host closed the room
    SHUTDOWN: 4106,          // the server is restarting
} as const;

/** Reasons in S2C.CLOSED, as the game's sessionOver() knows them. */
export const ClosedReason = {
    HOST: 'host', CLOSED: 'closed', KICKED: 'kicked', SHUTDOWN: 'shutdown', FLOOD: 'flood',
} as const;

// ── The world, as both ends know it ───────────────────────────────────────────

export const WORLD = {
    MIN_Y: -128,
    MAX_Y: 319,
    LIMIT_XZ: 2_000_000,
    CHUNK_LIMIT: 125_000,        // LIMIT_XZ / 16
    MAX_BLOCK_ID: 65_535,
    WATER: 5,
} as const;

/** Bits of a player state's `flags` (src/scripts/Players.js). */
export const StateFlag = { ON_GROUND: 1, IN_WATER: 2, DEAD: 4, HIDDEN: 8 } as const;

export const MAX_NAME = 16;
export const MAX_SKIN_KEYS = 24;
export const MAX_LOCAL_PLAYERS = 4;          // one screen splits four ways
export const HARD_MAX_PLAYERS = 8;

/** A room code: eight of these, shown as XXXX-XXXX. No 0/O or 1/I/L to misread. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export type Edition = 'full' | 'free';
