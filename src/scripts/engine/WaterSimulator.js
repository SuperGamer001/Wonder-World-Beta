/**
 * WaterSimulator — incremental BFS water spreading.
 *
 * Source blocks (e.g. placed by a player) are enqueued.
 * Each simulation tick spreads water one cell downward, then outward
 * (up to MAX_SPREAD blocks from any source).
 *
 * The simulator marks affected chunk columns dirty via markDirty(cx, cz).
 */

import { CHUNK_SHIFT } from './ChunkData.js';

const WATER_ID  = 5;
const MAX_SPREAD = 7;    // max horizontal distance from any source
const TICK_RATE  = 0.25; // seconds per simulation step

export class WaterSimulator {
    constructor(worldState, blockRegistry) {
        this.world   = worldState;
        this.reg     = blockRegistry;
        this._queue  = [];          // { x, y, z, dist }
        this._queued = new Set();   // "x,y,z" for dedup
        this._accum  = 0;
    }

    /** Enqueue a block position to simulate from. */
    addSource(x, y, z) {
        this._enqueue(x, y, z, 0);
    }

    /** Call every frame; markDirty(cx, cz) notifies ChunkManager. */
    tick(dt, markDirty) {
        this._accum += dt;
        if (this._accum < TICK_RATE) return;
        this._accum = 0;

        const batch = this._queue.splice(0, 64); // process up to 64 blocks per tick
        for (const { x, y, z, dist } of batch) {
            this._step(x, y, z, dist, markDirty);
        }
    }

    _step(x, y, z, dist, markDirty) {
        // Only spread from existing water blocks
        if (this.world.getBlock(x, y, z) !== WATER_ID) return;

        // Try down first (no dist cost)
        const below = this.world.getBlock(x, y - 1, z);
        if (below === 0) {
            this.world.setBlock(x, y - 1, z, WATER_ID);
            markDirty(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
            this._enqueue(x, y - 1, z, 0); // reset dist when flowing down
        }

        // Spread horizontally only if below is not open (would flow infinitely down)
        if (below !== 0 && dist < MAX_SPREAD) {
            for (const [nx, nz] of [[x+1,z],[x-1,z],[x,z+1],[x,z-1]]) {
                const adj = this.world.getBlock(nx, y, nz);
                if (adj === 0) {
                    this.world.setBlock(nx, y, nz, WATER_ID);
                    markDirty(nx >> CHUNK_SHIFT, nz >> CHUNK_SHIFT);
                    this._enqueue(nx, y, nz, dist + 1);
                }
            }
        }
    }

    _enqueue(x, y, z, dist) {
        const key = `${x},${y},${z}`;
        if (this._queued.has(key)) return;
        this._queued.add(key);
        this._queue.push({ x, y, z, dist });
    }
}
