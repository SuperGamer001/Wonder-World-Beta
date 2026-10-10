/**
 * What a message must look like before the room reads it.
 *
 * Every message a client can send has a schema here. They are strict: an
 * unknown field is an error, a number must be finite and inside the range the
 * world has, a list has a longest length. What passes is small, typed and
 * bounded, so the handlers in WorldRoom.ts never look at anything they have to
 * be careful with.
 *
 * Two payloads belong to the game and are not the server's to understand —
 * the host's clock and weather, and a guest's saved place (their inventory and
 * so on). Those are only checked to be plain data of a bounded size
 * (`bounded`), and who may send them is checked in the room.
 */
import { z } from 'zod';
import { MAX_NAME, MAX_SKIN_KEYS, MAX_LOCAL_PLAYERS, HARD_MAX_PLAYERS, WORLD, CODE_ALPHABET, CODE_LENGTH } from '../protocol.js';

// zod's number is already finite: NaN and the infinities do not pass.
const finite = z.number();
const coordXZ = z.number().int().min(-WORLD.LIMIT_XZ).max(WORLD.LIMIT_XZ);
const coordY = z.number().int().min(WORLD.MIN_Y).max(WORLD.MAX_Y);
const chunkCoord = z.number().int().min(-WORLD.CHUNK_LIMIT).max(WORLD.CHUNK_LIMIT);
const pid = z.number().int().min(1).max(1_000_000);

// ── Names and looks ───────────────────────────────────────────────────────────

/** A name as the game itself cleans one (src/players.js): the characters it allows, single spaces, sixteen at most. */
export function cleanName(raw: unknown, fallback: string): string {
    const name = String(typeof raw === 'string' ? raw : '').replace(/[^A-Za-z0-9 ._'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    return name || fallback;
}

/** A look is a small object of small whole numbers; anything else in it is dropped. */
export function cleanSkin(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
        if (n >= MAX_SKIN_KEYS) break;
        const v = (raw as any)[k];
        if (/^[a-zA-Z]{1,16}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 64) { out[k] = v; n++; }
    }
    return out;
}

// ── Plain data of a bounded size ──────────────────────────────────────────────

/**
 * Whether `v` is plain JSON-like data — nothing but objects, arrays, strings,
 * finite numbers, booleans and null — within the given bounds. Returns its
 * approximate size in bytes, or -1.
 */
export function boundedSize(v: unknown, maxBytes: number, maxDepth = 8): number {
    let bytes = 0;
    const walk = (x: unknown, depth: number): boolean => {
        if (depth > maxDepth) return false;
        if (x === null || typeof x === 'boolean') { bytes += 4; return bytes <= maxBytes; }
        if (typeof x === 'number') { bytes += 8; return Number.isFinite(x) && bytes <= maxBytes; }
        if (typeof x === 'string') { bytes += 2 + x.length * 2; return bytes <= maxBytes; }
        if (Array.isArray(x)) {
            bytes += 2;
            for (const e of x) if (!walk(e, depth + 1)) return false;
            return bytes <= maxBytes;
        }
        if (typeof x === 'object') {
            // Only a bare object: not a Map, a Date, a typed array or anything with a prototype of its own.
            const proto = Object.getPrototypeOf(x);
            if (proto !== Object.prototype && proto !== null) return false;
            bytes += 2;
            for (const k of Object.keys(x as object)) {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
                bytes += 2 + k.length * 2;
                if (!walk((x as any)[k], depth + 1)) return false;
            }
            return bytes <= maxBytes;
        }
        return false;      // undefined, functions, symbols, bigints
    };
    return walk(v, 0) ? bytes : -1;
}

const bounded = (maxBytes: number, maxDepth = 8) =>
    z.custom<any>((v) => v !== undefined && boundedSize(v, maxBytes, maxDepth) >= 0, 'not plain data of an allowed size');

// ── Joining ───────────────────────────────────────────────────────────────────

const version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/);
const contentHash = z.string().regex(/^[0-9a-f]{28}$/);
const blockName = z.string().regex(/^[A-Z0-9_]{1,40}$/);

/** A Flat world's settings (engine/FlatWorld.js normaliseFlat checks them again on arrival). */
const flat = z.strictObject({
    mode: z.enum(['layers', 'biomes']),
    layers: z.array(z.strictObject({ block: blockName, depth: z.number().int().min(1).max(64) })).max(16),
    biome: blockName.nullable(),
    decorations: z.boolean(),
    structures: z.boolean(),
});

/** What a guest's game needs to make the host's world: nothing that is not in the host's world.json. */
export const worldInfo = z.strictObject({
    name: z.string().max(64),
    seed: z.number().int().min(-2147483648).max(4294967295),
    worldGen: z.number().int().min(1).max(1000),
    terrainStyle: z.enum(['smooth', 'blocky']),
    gameMode: z.enum(['SURVIVAL', 'CREATIVE', 'SPECTATOR']),
    difficulty: z.enum(['PEACEFUL', 'EASY', 'NORMAL', 'HARD']),
    daylightCycle: z.boolean(),
    weather: z.string().regex(/^[a-z_]{2,32}$/),
    flat: flat.nullable(),
});
export type WorldInfo = z.infer<typeof worldInfo>;

/** What every game says of itself when it asks for a place in a room. */
const hello = {
    protocol: z.number().int().min(0).max(100000),
    version,
    content: contentHash,
    /** The newest world generator this game has. */
    worldGen: z.number().int().min(1).max(1000),
    name: z.string().max(64),
    skin: z.record(z.string(), z.unknown()).optional(),
    /** Which player of a shared screen this is: 0 the first. */
    slot: z.number().int().min(0).max(MAX_LOCAL_PLAYERS - 1),
};

export const createOptions = z.strictObject({
    ...hello,
    world: worldInfo,
    maxPlayers: z.number().int().min(1).max(HARD_MAX_PLAYERS),
});

export const joinOptions = z.strictObject({
    ...hello,
    code: z.string().length(CODE_LENGTH).refine((s) => [...s].every(c => CODE_ALPHABET.includes(c))),
});

// ── In the room ───────────────────────────────────────────────────────────────

export const msg = {
    /** [x, y, z, yaw, pitch, speed, flags, swings, hurt] (src/scripts/Players.js packState). */
    state: z.tuple([
        finite.min(-WORLD.LIMIT_XZ - 64).max(WORLD.LIMIT_XZ + 64),
        finite.min(WORLD.MIN_Y - 256).max(WORLD.MAX_Y + 1024),
        finite.min(-WORLD.LIMIT_XZ - 64).max(WORLD.LIMIT_XZ + 64),
        finite.min(-1e7).max(1e7),
        finite.min(-10).max(10),
        finite.min(0).max(1000),
        z.number().int().min(0).max(15),
        z.number().int().min(0).max(2147483647),
        finite.min(0).max(1),
    ]),
    block: z.strictObject({ x: coordXZ, y: coordY, z: coordXZ, b: z.number().int().min(0).max(WORLD.MAX_BLOCK_ID) }),
    profile: z.strictObject({ name: z.string().max(64), skin: z.record(z.string(), z.unknown()).optional() }),
    sync: z.strictObject({ since: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),

    atmos: z.strictObject({ a: bounded(4096, 5) }),
    /** Eleven numbers a mob, and the look of each mob not announced before (EntityManager.snapshot). */
    mobs: z.strictObject({
        list: z.array(finite.min(-1e9).max(1e9)).max(11 * 1024),
        info: z.record(z.string().regex(/^\d{1,9}$/), bounded(1024, 3)).optional(),
    }),
    attack: z.strictObject({ to: pid, dmg: finite.min(0).max(1000) }),
    drops: z.strictObject({
        to: pid,
        pos: z.strictObject({ x: finite.min(-WORLD.LIMIT_XZ).max(WORLD.LIMIT_XZ), y: finite.min(WORLD.MIN_Y - 16).max(WORLD.MAX_Y + 64), z: finite.min(-WORLD.LIMIT_XZ).max(WORLD.LIMIT_XZ) }),
        items: z.array(z.tuple([z.string().regex(/^[a-z0-9_]{1,40}$/), z.number().int().min(1).max(999)])).min(1).max(16),
    }),
    kick: z.strictObject({ id: pid }),
    lock: z.strictObject({ locked: z.boolean() }),
    hit: z.strictObject({ id: z.number().int().min(0).max(1e9), dmg: finite.min(0).max(1e6) }),

    manifest: z.undefined().or(z.strictObject({})),
    chunk: z.strictObject({ cx: chunkCoord, cz: chunkCoord }),
    pload: z.undefined().or(z.strictObject({})),
    /** `state`'s size is checked against the configured limit in the room. */
    psave: z.strictObject({ state: z.custom<any>((v) => v !== undefined) }),
};

// ── The host's answers ────────────────────────────────────────────────────────

export const reply = z.strictObject({
    rid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ok: z.boolean(),
    d: z.unknown().optional(),
});

export const hostReply = {
    manifest: z.strictObject({ keys: z.array(z.string().regex(/^-?\d{1,6},-?\d{1,6}$/)).max(60_000) }),
    chunk: z.strictObject({
        s: z.number().int().min(0).max(3),
        d: z.instanceof(Uint8Array).optional(),
    }),
    pload: z.strictObject({ state: z.custom<any>(() => true).optional() }),
    psave: z.strictObject({}).or(z.undefined()),
};

/** "major.minor.patch" → comparable; a prerelease tag is ignored (it sorts with its release). */
export function versionAtLeast(have: string, need: string): boolean {
    const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
    const a = parse(have), b = parse(need);
    if (a.length < 3 || b.length < 3) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
}
