/**
 * StructurePlacer
 *
 * Handles all structure generation (trees, houses) for the worker thread.
 *
 * Cross-chunk strategy
 * ────────────────────
 * The world is divided into non-overlapping "structure cells" of CELL_SIZE×CELL_SIZE
 * blocks (X/Z only; Y is determined by terrain height at placement time).
 *
 * When generating chunk (cx, cy, cz):
 *   • Compute which cells overlap the chunk footprint expanded by MAX_STRUCTURE_RADIUS.
 *   • For each overlapping cell, derive a deterministic placement decision from
 *     (worldSeed, cellX, cellZ, structureType).
 *   • If a structure is placed in that cell, apply every block of the structure
 *     that falls within the current chunk's [wx..wx+31, wy..wy+31, wz..wz+31] range.
 *
 * This guarantees:
 *   • Every chunk sees the same structure decisions (deterministic).
 *   • Structures that straddle chunk boundaries appear correctly in all chunks.
 *   • No inter-chunk communication is required during generation.
 *
 * Adding new structure types
 * ─────────────────────────
 * Implement a builder function returning an array of {dx, dy, dz, blockId} offsets
 * relative to the structure origin, register it in STRUCTURE_BUILDERS, and add it
 * to the biome's structures config.  The rest is automatic.
 */

import { CHUNK_SIZE, voxelIndex } from '../engine/ChunkData.js';
import { hashSeed, randFloat, noise2D } from './noise.js';

const N                   = CHUNK_SIZE;
const CELL_SIZE           = 24;    // structure-grid cell size (blocks)
const MAX_STRUCTURE_RADIUS = 12;   // furthest a structure block can be from its origin

// How many cells to scan beyond the chunk footprint in each direction
const CELL_SCAN_PAD = Math.ceil(MAX_STRUCTURE_RADIUS / CELL_SIZE) + 1;

// ── Structure definitions ─────────────────────────────────────────────────────

/**
 * Returns an array of voxel offsets { dx, dy, dz, blockId } relative to the
 * structure origin point (ground level at x=0, y=0, z=0 = base of trunk).
 */

function buildOakTree(reg) {
    const WOOD   = reg.getByName('WOOD')?.id   ?? 6;
    const LEAVES = reg.getByName('LEAVES')?.id ?? 7;

    const blocks = [];

    // Trunk: 4-6 blocks tall
    const trunkH = 4;
    for (let dy = 0; dy < trunkH; dy++) {
        blocks.push({ dx: 0, dy, dz: 0, blockId: WOOD });
    }

    // Leaf crown: 3 layers
    const crownY = trunkH - 1;

    // Bottom layer (widest, radius 2)
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // clip corners
            blocks.push({ dx, dy: crownY, dz, blockId: LEAVES });
        }
    }

    // Middle layer (radius 2)
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            blocks.push({ dx, dy: crownY + 1, dz, blockId: LEAVES });
        }
    }

    // Top layer (radius 1)
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            blocks.push({ dx, dy: crownY + 2, dz, blockId: LEAVES });
        }
    }

    // Apex
    blocks.push({ dx: 0, dy: crownY + 3, dz: 0, blockId: LEAVES });

    return blocks;
}

function buildSmallHouse(reg) {
    const STONE  = reg.getByName('STONE')?.id  ?? 3;
    const WOOD   = reg.getByName('WOOD')?.id   ?? 6;
    const LEAVES = reg.getByName('LEAVES')?.id ?? 7;
    const DIRT   = reg.getByName('DIRT')?.id   ?? 2;

    const blocks = [];
    const W = 7, H = 5, D = 9; // width, height, depth

    // Foundation — one layer of stone
    for (let dx = 0; dx < W; dx++)
        for (let dz = 0; dz < D; dz++)
            blocks.push({ dx, dy: -1, dz, blockId: STONE });

    // Walls — stone frame with wood fill
    for (let dy = 0; dy < H - 1; dy++) {
        for (let dx = 0; dx < W; dx++) {
            for (let dz = 0; dz < D; dz++) {
                const isEdgeX = dx === 0 || dx === W - 1;
                const isEdgeZ = dz === 0 || dz === D - 1;
                if (!isEdgeX && !isEdgeZ) continue;  // interior is open
                blocks.push({ dx, dy, dz, blockId: isEdgeX || isEdgeZ ? (
                    (dx % (W-1) === 0) || (dz % (D-1) === 0) ? STONE : WOOD
                ) : WOOD });
            }
        }
    }

    // Gabled roof — wood planks
    const midX = Math.floor(W / 2);
    for (let dz = 0; dz < D; dz++) {
        for (let layer = 0; layer <= midX; layer++) {
            const roofY = H - 1 + layer;
            blocks.push({ dx: midX - layer, dy: roofY, dz, blockId: WOOD });
            blocks.push({ dx: midX + layer, dy: roofY, dz, blockId: WOOD });
        }
    }

    return blocks;
}

// Map of structure type name → builder function(reg) → block array
const STRUCTURE_BUILDERS = {
    tree:  buildOakTree,
    house: buildSmallHouse,
};

// ── StructurePlacer class ────────────────────────────────────────────────────

export class StructurePlacer {
    /**
     * @param {number}        seed
     * @param {BlockRegistry} blockRegistry
     * @param {object[]}      biomes       — normalised biome defs (with _surfaceId etc.)
     */
    constructor(seed, blockRegistry, biomes) {
        this.seed   = seed;
        this.reg    = blockRegistry;
        this.biomes = biomes;

        // Pre-build block arrays for each structure type (avoid rebuilding per chunk)
        this._builtStructures = {};
        for (const [type, builder] of Object.entries(STRUCTURE_BUILDERS)) {
            this._builtStructures[type] = builder(blockRegistry);
        }
    }

    /**
     * Apply all structures whose blocks overlap this chunk.
     * Modifies `voxels` in-place.
     *
     * @param {Uint16Array}  voxels
     * @param {number}       cx, cy, cz   — chunk coordinates
     * @param {Int16Array}   heights      — terrain height per column [lx*N+lz]
     * @param {object[]}     blends       — biome blend per column
     */
    apply(voxels, cx, cy, cz, heights, blends) {
        const ox = cx * N;
        const oy = cy * N;
        const oz = cz * N;

        // Determine cell range that can reach this chunk
        const cellMinX = Math.floor((ox - MAX_STRUCTURE_RADIUS) / CELL_SIZE) - 1;
        const cellMaxX = Math.floor((ox + N + MAX_STRUCTURE_RADIUS) / CELL_SIZE) + 1;
        const cellMinZ = Math.floor((oz - MAX_STRUCTURE_RADIUS) / CELL_SIZE) - 1;
        const cellMaxZ = Math.floor((oz + N + MAX_STRUCTURE_RADIUS) / CELL_SIZE) + 1;

        for (let cx2 = cellMinX; cx2 <= cellMaxX; cx2++) {
            for (let cz2 = cellMinZ; cz2 <= cellMaxZ; cz2++) {
                this._processCell(voxels, cx, cy, cz, cx2, cz2, ox, oy, oz, heights, blends);
            }
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _processCell(voxels, cx, cy, cz, cellX, cellZ, ox, oy, oz, heights, blends) {
        // For each structure type registered in STRUCTURE_BUILDERS
        for (const type of Object.keys(STRUCTURE_BUILDERS)) {
            // Unique hash for this cell × type combination
            const cellHash = hashSeed(this.seed, cellX * 73856093, cellZ * 19349663, type.length);

            // Determine structure origin in world space (within the cell)
            const originX = cellX * CELL_SIZE + (cellHash         % CELL_SIZE);
            const originZ = cellZ * CELL_SIZE + ((cellHash >> 8)  % CELL_SIZE);

            // Get terrain height at origin (may be outside this chunk — skip if so)
            const lxO = originX - ox;
            const lzO = originZ - oz;
            let surfaceY;

            if (lxO >= 0 && lxO < N && lzO >= 0 && lzO < N) {
                surfaceY = heights[lxO * N + lzO];
            } else {
                // Origin column is in a different chunk — estimate height using noise
                // (same formula as TerrainGenerator so it matches)
                surfaceY = this._estimateHeight(originX, originZ);
            }

            const originY = surfaceY; // structure base sits on the surface block

            // Check if the structure should spawn here using per-biome frequency
            const blend = this._blendAt(lxO, lzO, blends);
            const freq  = this._structureFrequency(blend, type);
            if (freq <= 0) continue;

            // Probabilistic spawn using the hash as a random float in [0,1)
            const spawnRoll = (cellHash >>> 16) / 0x10000;
            if (spawnRoll > freq * CELL_SIZE * CELL_SIZE) continue;

            // Apply structure blocks that fall within this chunk
            const blockList = this._builtStructures[type];
            if (!blockList) continue;

            for (const { dx, dy, dz, blockId } of blockList) {
                const wx = originX + dx;
                const wy = originY + dy;
                const wz = originZ + dz;

                const lx = wx - ox;
                const ly = wy - oy;
                const lz = wz - oz;

                if (lx < 0 || lx >= N || ly < 0 || ly >= N || lz < 0 || lz >= N) continue;

                const idx = voxelIndex(lx, ly, lz);
                // Overwrite air only (leaves can be overwritten by trunk etc.)
                if (voxels[idx] === 0 || (blockId === this.reg.getByName('WOOD')?.id && voxels[idx] === this.reg.getByName('LEAVES')?.id)) {
                    voxels[idx] = blockId;
                }
            }
        }
    }

    _blendAt(lx, lz, blends) {
        if (lx >= 0 && lx < N && lz >= 0 && lz < N) {
            return blends[lx * N + lz];
        }
        return null;
    }

    _structureFrequency(blend, type) {
        if (!blend) return 0;
        let freq = 0;
        for (let i = 0; i < this.biomes.length; i++) {
            const w  = blend.weights[i];
            const sf = this.biomes[i].structures?.[type]?.frequency ?? 0;
            freq    += w * sf;
        }
        return freq;
    }

    _estimateHeight(wx, wz) {
        // Cheap approximation — must use the same noise formula as TerrainGenerator.
        // This is called only for structure origins outside the current chunk.
        // 64 is the nominal sea level / plains base height.
        const h = noise2D(wx * 0.003, wz * 0.003) * 14 + 64;
        return h | 0;
    }
}
