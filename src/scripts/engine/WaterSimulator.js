/**
 * WaterSimulator — water that flows from where it stands, and goes when that
 * is taken away.
 *
 * Water is one of three things (BlockRegistry `fluid`):
 *   a source   a block of standing water (WATER): the sea, a lake, what a
 *              bucket puts down. It stays until someone takes it.
 *   a flow     water on its way from a source, of a level from 7 (beside the
 *              source) down to 1 (the end of its reach): WATER_7 … WATER_1.
 *   a fall     water coming down from the block above it (WATER_FALL), a full
 *              block of it, however thin the flow it falls from.
 *
 * Every block that is not a source is only what its neighbours make it. A
 * block that is open to water takes, in this order:
 *   • water above it                → a fall
 *   • two sources beside it, on something that holds water → a source (so a
 *     hole dug in a lake fills, and a pool two blocks wide never runs dry)
 *   • the fullest water beside it that spreads, less one level. A source
 *     always spreads; a flow or a fall only where the block under it holds
 *     water up — water runs off an edge and down before it runs on.
 *   • nothing: it is, or becomes, air. That is how a stream goes when its
 *     source is taken: level by level, from the source outward.
 *
 * It works by touch: when a block changes, it and the six round it are looked
 * at on the next step, and whatever changes then is touched in turn. So water
 * moves a block a step, nothing is looked at that nothing happened near, and
 * the sea as the world was made — all sources — costs nothing until someone
 * digs beside it.
 *
 * Every game runs this for itself from the same rules, on the changes all of
 * them are told (a block dug, a bucket emptied); what the water then does is
 * not sent (world.js). No Three.js and no DOM.
 */

import { CHUNK_SHIFT, WORLD_MIN_Y, CHUNK_SIZE, CHUNK_SIZE_Y } from './ChunkData.js';
import { FLUID_FALL, FLUID_SOURCE } from './BlockRegistry.js';

export const WATER_STEP = 0.2;      // seconds between steps: a flow runs five blocks a second
const MAX_PER_STEP = 800;           // blocks looked at in one step; the rest wait for the next

const OFF = 2097152;                // 2²¹: world x and z are within ±2,000,000
const key = (x, y, z) => ((x + OFF) * 4194304 + (z + OFF)) * 512 + (y - WORLD_MIN_Y);

const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];

export class WaterSimulator {
    /**
     * @param {{ getBlock, setBlock, getChunk }} worldState
     * @param {BlockRegistry} blockRegistry
     */
    constructor(worldState, blockRegistry) {
        this.world = worldState;
        // level[id]: 0 not water, 1 … 7 a flow, FLUID_FALL, FLUID_SOURCE.
        // open[id]: water may take its place (air, and what water washes away).
        this.level = new Uint8Array(65536);
        this.open  = new Uint8Array(65536);
        this.open[0] = 1;
        this.flowId = new Uint16Array(8);
        this.fallId = 0;
        this.sourceId = 0;
        for (const def of blockRegistry.serialize()) {
            const f = def.fluid | 0;
            this.level[def.id] = f;
            if (def.wash) this.open[def.id] = 1;
            if (f >= 1 && f <= 7 && !this.flowId[f]) this.flowId[f] = def.id;
            else if (f === FLUID_FALL && !this.fallId) this.fallId = def.id;
            else if (f === FLUID_SOURCE && (!this.sourceId || def.name === 'WATER')) this.sourceId = def.id;
        }
        // A pack without the flowing blocks has water that stays where it is put.
        this.enabled = !!this.sourceId && !!this.fallId && this.flowId.subarray(1).every(Boolean);

        this._pending = new Set();
        this._t = 0;
        /** Water took the place of something it washes away: (x, y, z, id). */
        this.onWash = null;
        /** A block of water changed at (x, y, z): its chunk has to be drawn again. */
        this.onChange = null;
        this.steps = 0;         // steps taken (diagnostics)
    }

    /** How many blocks are waiting to be looked at. */
    get pending() { return this._pending.size; }

    /** A block changed at (x, y, z): look at it and the six round it on the next step. */
    touch(x, y, z) {
        if (!this.enabled) return;
        const p = this._pending;
        p.add(key(x, y, z));
        p.add(key(x + 1, y, z)); p.add(key(x - 1, y, z));
        p.add(key(x, y + 1, z)); p.add(key(x, y - 1, z));
        p.add(key(x, y, z + 1)); p.add(key(x, y, z - 1));
    }

    /** Kept for what places a source: the same as touch. */
    addSource(x, y, z) { this.touch(x, y, z); }

    /**
     * A chunk has come (generated, or read from the save): water in it that
     * was on its way when it was last here goes on from where it was.
     */
    scanChunk(chunk, cx, cz) {
        if (!this.enabled || !chunk?.paletteHas?.((id) => { const f = this.level[id]; return f >= 1 && f <= FLUID_FALL; })) return;
        const lo = Math.max(0, chunk.minFilledY | 0), hi = Math.min(CHUNK_SIZE_Y - 1, chunk.maxFilledY | 0);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let ly = lo; ly <= hi; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const f = this.level[chunk.getVoxel(lx, ly, lz)];
            if (f >= 1 && f <= FLUID_FALL) this._pending.add(key((cx << CHUNK_SHIFT) + lx, ly + WORLD_MIN_Y, (cz << CHUNK_SHIFT) + lz));
        }
    }

    /** Call every frame. */
    tick(dt) {
        if (!this.enabled || this._pending.size === 0) { this._t = 0; return; }
        this._t += dt;
        if (this._t < WATER_STEP) return;
        this._t = Math.min(this._t - WATER_STEP, WATER_STEP);
        this.step();
    }

    /** One step: everything touched since the last is looked at once. */
    step() {
        const cur = this._pending;
        this._pending = new Set();
        this.steps++;
        let n = 0;
        for (const k of cur) {
            if (n++ >= MAX_PER_STEP) { this._pending.add(k); continue; }
            const y = (k % 512) + WORLD_MIN_Y, xz = Math.floor(k / 512);
            this._update(Math.floor(xz / 4194304) - OFF, y, (xz % 4194304) - OFF);
        }
    }

    _loaded(x, z) { return !!this.world.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT)?.generated; }

    /** What the block at (x, y, z) should be, given the blocks round it; and make it so. */
    _update(x, y, z) {
        const w = this.world, level = this.level, open = this.open;
        if (y < WORLD_MIN_Y || y >= WORLD_MIN_Y + CHUNK_SIZE_Y) return;
        // Not beside land that is not here yet: its water would be read as none.
        if (!this._loaded(x, z) || !this._loaded(x + 1, z) || !this._loaded(x - 1, z) || !this._loaded(x, z + 1) || !this._loaded(x, z - 1)) return;

        const id = w.getBlock(x, y, z), lv = level[id];
        if (lv === FLUID_SOURCE) return;                 // standing water stays
        if (lv === 0 && open[id] !== 1) return;          // something water does not go into

        let want = 0;
        if (level[w.getBlock(x, y + 1, z)] !== 0) want = FLUID_FALL;
        else {
            let sources = 0;
            for (let d = 0; d < 4; d++) {
                const nx = x + DX[d], nz = z + DZ[d];
                const nl = level[w.getBlock(nx, y, nz)];
                if (nl === 0) continue;
                if (nl === FLUID_SOURCE) { sources++; want = 7; continue; }
                // A flow or a fall runs on sideways only where it cannot go down.
                const under = w.getBlock(nx, y - 1, nz);
                if (level[under] !== 0 || open[under] === 1) continue;
                const reach = nl === FLUID_FALL ? 7 : nl - 1;
                if (reach > want) want = reach;
            }
            if (sources >= 2) {
                const below = w.getBlock(x, y - 1, z);
                if (level[below] === FLUID_SOURCE || (level[below] === 0 && open[below] !== 1)) want = FLUID_SOURCE;
            }
        }
        if (want === lv) return;

        if (lv === 0 && id !== 0) this.onWash?.(x, y, z, id);          // a torch, a flower: gone
        const to = want === 0 ? 0 : want === FLUID_SOURCE ? this.sourceId : want === FLUID_FALL ? this.fallId : this.flowId[want];
        w.setBlock(x, y, z, to);
        // (A world with no onEdit of its own — a test's — is touched here.)
        if (!w.onEdit) this.touch(x, y, z);
        this.onChange?.(x, y, z);
    }
}
