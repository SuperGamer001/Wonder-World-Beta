/**
 * The blocks of each version of the game this server knows (src/content/known.json,
 * written by tools/sync-content.mjs from the game's data/).
 *
 * A room is made by a host whose game has a fingerprint (`content`); if the
 * server knows it, every block a player places there is checked against that
 * game's list. A fingerprint it does not know — a gamepack that adds blocks —
 * is let in only where ALLOW_UNKNOWN_CONTENT says so, and block ids are then
 * only checked to be in range.
 */
import known from './content/known.json' with { type: 'json' };
import { WORLD } from './protocol.js';

export interface Content {
    hash: string;
    version: string;
    /** Block name by id. */
    names: Map<number, string>;
    liquids: Set<number>;
}

const contents = new Map<string, Content>();
for (const [hash, c] of Object.entries(known as unknown as Record<string, { version: string; blocks: [number, string, number][] }>)) {
    const names = new Map<number, string>(), liquids = new Set<number>();
    for (const [id, name, liquid] of c.blocks) {
        names.set(id, name);
        if (liquid) liquids.add(id);
    }
    contents.set(hash, { hash, version: c.version, names, liquids });
}

/** The blocks of the game with this fingerprint, or null if the server does not know it. */
export function contentFor(hash: string): Content | null {
    return contents.get(hash) ?? null;
}

export function knownContents(): string[] {
    return [...contents.keys()];
}

/** Whether `id` is a block a player of this content may name at all. */
export function isBlock(content: Content | null, id: number): boolean {
    if (!Number.isInteger(id) || id < 0 || id > WORLD.MAX_BLOCK_ID) return false;
    return content ? content.names.has(id) : true;
}

export function isLiquid(content: Content | null, id: number): boolean {
    return content ? content.liquids.has(id) : id === WORLD.WATER;
}
