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
 * When generating chunk column (cx, cz):
 *   • Compute which cells overlap the chunk footprint expanded by MAX_STRUCTURE_RADIUS.
 *   • For each overlapping cell, derive a deterministic placement decision from
 *     (worldSeed, cellX, cellZ, structureType).
 *   • If a structure is placed in that cell, apply every block of the structure
 *     that falls within the current chunk column's bounds.
 *
 * This guarantees:
 *   • Every chunk sees the same structure decisions (deterministic).
 *   • Structures that straddle chunk boundaries appear correctly in all chunks.
 *   • No inter-chunk communication is required during generation.
 *
 * Height accuracy
 * ───────────────
 * When a structure origin falls outside the current chunk, surface Y is computed
 * via terrainGen._blendedHeight so structure bases line up perfectly across
 * chunk boundaries.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, voxelIndex } from '../engine/ChunkData.js';
import { hashSeed, noise2D, fbm2D } from './noise.js';

const N                    = CHUNK_SIZE;         // 16 — XZ size
const N_Y                  = CHUNK_SIZE_Y;       // 640 — full column height
const CELL_SIZE            = 24;
const MAX_STRUCTURE_RADIUS = 12;
const SEA_LEVEL            = 64;

// Continent / biome noise constants — must match TerrainGenerator exactly.
const CONTINENT_FREQ   = 0.00008;
const CONTINENT_OCTAVE = 5;
const TEMP_FREQ        = 0.00035;
const HUMI_FREQ        = 0.00030;

// ── Structure definitions ─────────────────────────────────────────────────────

function buildOakTree(reg) {
    const WOOD   = reg.getByName('WOOD')?.id   ?? 6;
    const LEAVES = reg.getByName('LEAVES')?.id ?? 7;

    const blocks = [];

    const trunkH = 4;
    for (let dy = 0; dy < trunkH; dy++) {
        blocks.push({ dx: 0, dy, dz: 0, blockId: WOOD });
    }

    const crownY = trunkH - 1;

    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            blocks.push({ dx, dy: crownY,     dz, blockId: LEAVES });
            blocks.push({ dx, dy: crownY + 1, dz, blockId: LEAVES });
        }
    }

    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            blocks.push({ dx, dy: crownY + 2, dz, blockId: LEAVES });
        }
    }

    blocks.push({ dx: 0, dy: crownY + 3, dz: 0, blockId: LEAVES });

    return blocks;
}

function buildSmallHouse(reg) {
    const STONE = reg.getByName('STONE')?.id ?? 3;
    const WOOD  = reg.getByName('WOOD')?.id  ?? 6;

    const blocks = [];
    const W = 7, H = 5, D = 9;

    for (let dx = 0; dx < W; dx++)
        for (let dz = 0; dz < D; dz++)
            blocks.push({ dx, dy: -1, dz, blockId: STONE });

    for (let dy = 0; dy < H - 1; dy++) {
        for (let dx = 0; dx < W; dx++) {
            for (let dz = 0; dz < D; dz++) {
                const isEdgeX = dx === 0 || dx === W - 1;
                const isEdgeZ = dz === 0 || dz === D - 1;
                if (!isEdgeX && !isEdgeZ) continue;
                blocks.push({ dx, dy, dz, blockId: isEdgeX || isEdgeZ ? (
                    (dx % (W-1) === 0) || (dz % (D-1) === 0) ? STONE : WOOD
                ) : WOOD });
            }
        }
    }

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

const STRUCTURE_BUILDERS = {
    tree:  buildOakTree,
    house: buildSmallHouse,
};

// ── StructurePlacer class ────────────────────────────────────────────────────

export class StructurePlacer {
    /**
     * @param {number}           seed
     * @param {BlockRegistry}    blockRegistry
     * @param {object[]}         biomes         — normalised biome defs
     * @param {TerrainGenerator} terrainGen     — used for accurate height estimation
     */
    constructor(seed, blockRegistry, biomes, terrainGen) {
        this.seed       = seed;
        this.reg        = blockRegistry;
        this.biomes     = biomes;
        this.terrainGen = terrainGen ?? null;

        this._builtStructures = {};
        for (const [type, builder] of Object.entries(STRUCTURE_BUILDERS)) {
            this._builtStructures[type] = builder(blockRegistry);
        }
    }

    /**
     * Apply all structures whose blocks overlap this chunk column.
     *
     * @param {Uint16Array} voxels   — chunk voxel data (163,840 elements)
     * @param {number}      cx       — chunk X coordinate
     * @param {number}      cz       — chunk Z coordinate
     * @param {Int16Array}  heights  — per-column terrain heights (N×N)
     * @param {Array}       blends   — per-column biome blends (N×N)
     */
    apply(voxels, cx, cz, heights, blends) {
        const ox = cx * N;
        const oz = cz * N;
        // The chunk column always starts at WORLD_MIN_Y
        const oy = WORLD_MIN_Y;

        const cellMinX = Math.floor((ox - MAX_STRUCTURE_RADIUS) / CELL_SIZE) - 1;
        const cellMaxX = Math.floor((ox + N + MAX_STRUCTURE_RADIUS) / CELL_SIZE) + 1;
        const cellMinZ = Math.floor((oz - MAX_STRUCTURE_RADIUS) / CELL_SIZE) - 1;
        const cellMaxZ = Math.floor((oz + N + MAX_STRUCTURE_RADIUS) / CELL_SIZE) + 1;

        for (let cx2 = cellMinX; cx2 <= cellMaxX; cx2++) {
            for (let cz2 = cellMinZ; cz2 <= cellMaxZ; cz2++) {
                this._processCell(voxels, cx2, cz2, ox, oy, oz, heights, blends);
            }
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _processCell(voxels, cellX, cellZ, ox, oy, oz, heights, blends) {
        for (const type of Object.keys(STRUCTURE_BUILDERS)) {
            const cellHash = hashSeed(this.seed, cellX * 73856093, cellZ * 19349663, type.length);

            const originX = cellX * CELL_SIZE + (cellHash        % CELL_SIZE);
            const originZ = cellZ * CELL_SIZE + ((cellHash >> 8) % CELL_SIZE);

            const lxO = originX - ox;
            const lzO = originZ - oz;
            let surfaceY;

            if (lxO >= 0 && lxO < N && lzO >= 0 && lzO < N) {
                surfaceY = heights[lxO * N + lzO];
            } else {
                surfaceY = this._estimateHeight(originX, originZ);
            }

            const originY = surfaceY;

            const blend        = this._blendAt(lxO, lzO, blends);
            const spawnInWater = this._structureFlag(blend, type, 'spawnInWater', true);
            if (!spawnInWater && surfaceY < SEA_LEVEL) continue;

            const freq = this._structureFrequency(blend, type);
            if (freq <= 0) continue;

            const spawnRoll = (cellHash >>> 16) / 0x10000;
            if (spawnRoll > freq * CELL_SIZE * CELL_SIZE) continue;

            const blockList = this._builtStructures[type];
            if (!blockList) continue;

            for (const { dx, dy, dz, blockId } of blockList) {
                const wx = originX + dx;
                const wy = originY + dy;
                const wz = originZ + dz;

                const lx = wx - ox;
                const ly = wy - oy;   // oy = WORLD_MIN_Y
                const lz = wz - oz;

                if (lx < 0 || lx >= N || ly < 0 || ly >= N_Y || lz < 0 || lz >= N) continue;

                const idx      = voxelIndex(lx, ly, lz);
                const woodId   = this.reg.getByName('WOOD')?.id;
                const leavesId = this.reg.getByName('LEAVES')?.id;
                if (voxels[idx] === 0 || (blockId === woodId && voxels[idx] === leavesId)) {
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

    _structureFlag(blend, type, flag, defaultVal) {
        if (!blend) return defaultVal;
        let bestW = -1, value = defaultVal;
        for (let i = 0; i < this.biomes.length; i++) {
            const w = blend.weights[i];
            if (w > bestW) {
                const cfg = this.biomes[i].structures?.[type];
                if (cfg && flag in cfg) {
                    value = cfg[flag];
                    bestW = w;
                }
            }
        }
        return value;
    }

    _estimateHeight(wx, wz) {
        if (this.terrainGen) {
            const continent = fbm2D(wx + 8000, wz + 8000, CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
            const temp      = (noise2D(wx * TEMP_FREQ + 1000, wz * TEMP_FREQ + 1000) + 1) * 0.5;
            const humi      = (noise2D(wx * HUMI_FREQ + 5000, wz * HUMI_FREQ + 5000) + 1) * 0.5;
            const blend     = this.terrainGen._biomeBlend(temp, humi, continent);
            return this.terrainGen._blendedHeight(wx, wz, blend) | 0;
        }
        return (noise2D(wx * 0.003, wz * 0.003) * 14 + 64) | 0;
    }
}
