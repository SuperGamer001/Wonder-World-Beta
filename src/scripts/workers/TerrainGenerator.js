/**
 * TerrainGenerator
 *
 * Runs entirely inside a worker thread.  Fills a 32×32×32 Uint16Array with
 * block IDs for one chunk using layered noise.
 *
 * Generation pipeline per chunk:
 *   1. Continental scale — determines ocean vs land at very low frequency.
 *   2. Biome selection   — temperature + humidity noise maps to a weighted
 *                          blend of biome definitions loaded from the GamePack.
 *   3. Height field      — per-biome FBM / ridged noise, blended by biome weight.
 *   4. Block fill        — surface / subsurface / stone layers, water fill.
 *   5. Cave carving      — two layers of 3D noise (Swiss-cheese + spaghetti).
 *   6. Ore placement     — vein-based, data-driven from biome config.
 *
 * Ore / vein system:
 *   Generic — any block type can be an ore with frequency, size range, and
 *   Y-range constraints.  All parameters come from the biome definition.
 */

import { CHUNK_SIZE, voxelIndex } from '../engine/ChunkData.js';
import {
    setSeed, noise2D, noise3D,
    fbm2D, fbm3D, ridged2D, warpedFbm2D, hashSeed, randFloat,
} from './noise.js';

const N          = CHUNK_SIZE;
const SEA_LEVEL  = 64;
const BEDROCK_Y  = -160;

// Continent noise parameters — controls where oceans and landmasses appear.
const CONTINENT_FREQ   = 0.00008;
const CONTINENT_OCTAVE = 5;

// Temperature / humidity control biome selection.
const TEMP_FREQ = 0.00035;
const HUMI_FREQ = 0.00030;

// Cave noise parameters
const CAVE_FREQ_A  = 0.040;   // main cave network
const CAVE_FREQ_B  = 0.065;   // spaghetti detail
const CAVE_THRESH  = 0.55;    // abs(noise) below this → carved

// Minimum and maximum Y where caves generate
const CAVE_MIN_Y   = BEDROCK_Y + 8;

export class TerrainGenerator {
    /**
     * @param {number}          seed         — world seed
     * @param {BlockRegistry}   blockRegistry
     * @param {object[]}        biomes        — biome defs from GamePack JSON
     */
    constructor(seed, blockRegistry, biomes) {
        this.seed  = seed;
        this.reg   = blockRegistry;
        this.biomes = biomes.map(b => this._normaliseBiome(b));

        setSeed(seed);

        // Pre-resolve block IDs for fast lookup inside the hot loop.
        // Each biome stores string names; resolve them to numeric IDs once.
        for (const b of this.biomes) {
            b._surfaceId    = this._id(b.surfaceBlock);
            b._subId        = this._id(b.subsurfaceBlock);
            b._stoneId      = this._id(b.stoneBlock);
            b._deepId       = this._id(b.deepBlock ?? b.stoneBlock);
            for (const ore of b.ores) {
                ore._blockId = this._id(ore.block);
            }
        }

        this._stoneId   = this._id('STONE');
        this._airId     = 0;
        this._waterId   = this._id('WATER');
        this._bedrockId = this._id('BEDROCK');
    }

    _id(name) { return this.reg.getByName(name)?.id ?? 0; }

    _normaliseBiome(b) {
        return {
            name:            b.name,
            temperature:     b.temperature    ?? 0.5,
            humidity:        b.humidity       ?? 0.5,
            baseHeight:      b.baseHeight     ?? 64,
            heightVariation: b.heightVariation ?? 12,
            heightOctaves:   b.heightOctaves  ?? 4,
            heightFrequency: b.heightFrequency ?? 0.003,
            mountainBlend:   b.mountainBlend  ?? 0.1,
            surfaceBlock:    b.surfaceBlock    ?? 'GRASS',
            subsurfaceBlock: b.subsurfaceBlock ?? 'DIRT',
            stoneBlock:      b.stoneBlock      ?? 'STONE',
            deepBlock:       b.deepBlock       ?? b.stoneBlock ?? 'STONE',
            structures:      b.structures      ?? {},
            ores:            b.ores            ?? [],
        };
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Generates a full chunk and returns its voxel array.
     * @param {number} cx  chunk X coordinate
     * @param {number} cy  chunk Y coordinate
     * @param {number} cz  chunk Z coordinate
     * @returns {Uint16Array}
     */
    generateChunk(cx, cy, cz) {
        const voxels = new Uint16Array(N * N * N);

        const worldOriginX = cx * N;
        const worldOriginY = cy * N;
        const worldOriginZ = cz * N;

        // ── 1. Column-level data (height, biome) ───────────────────────────
        // Cache per-column to avoid re-computing noise for each Y level.
        const heights  = new Int16Array(N * N);
        const blends   = [];          // blends[x * N + z] = { weights[], totalWeight }
        const continents = new Float32Array(N * N);

        for (let lx = 0; lx < N; lx++) {
            const wx = worldOriginX + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz = worldOriginZ + lz;
                const col = lx * N + lz;

                // Continental noise (very low frequency) in [-1, 1].
                // Values below -0.05 → ocean; above → land.
                const continent = fbm2D(wx + 8000, wz + 8000,
                    CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
                continents[col] = continent;

                // Temperature and humidity (0→1)
                const temp = (noise2D(wx * TEMP_FREQ + 1000, wz * TEMP_FREQ + 1000) + 1) * 0.5;
                const humi = (noise2D(wx * HUMI_FREQ + 5000, wz * HUMI_FREQ + 5000) + 1) * 0.5;

                // Biome blending
                const blend = this._biomeBlend(temp, humi, continent);
                blends[col] = blend;

                // Blended terrain height
                heights[col] = this._blendedHeight(wx, wz, blend) | 0;
            }
        }

        // ── 2. Voxel fill ──────────────────────────────────────────────────

        for (let lx = 0; lx < N; lx++) {
            const wx = worldOriginX + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz  = worldOriginZ + lz;
                const col = lx * N + lz;
                const terrainHeight = heights[col];
                const blend         = blends[col];

                // Pick the dominant biome's block types, weighted
                const surfaceId = this._blendedBlock(blend, '_surfaceId');
                const subId     = this._blendedBlock(blend, '_subId');
                const stoneId   = this._blendedBlock(blend, '_stoneId');
                const deepId    = this._blendedBlock(blend, '_deepId');

                for (let ly = 0; ly < N; ly++) {
                    const wy  = worldOriginY + ly;
                    const idx = voxelIndex(lx, ly, lz);

                    // Bedrock layer
                    if (wy <= BEDROCK_Y + 2) {
                        voxels[idx] = this._bedrockId;
                        continue;
                    }

                    if (wy > terrainHeight) {
                        // Air, or water fill up to sea level
                        voxels[idx] = (wy <= SEA_LEVEL) ? this._waterId : this._airId;
                        continue;
                    }

                    // Surface layer
                    if (wy === terrainHeight) {
                        // Don't place grass/snow on top of underwater terrain
                        voxels[idx] = (wy <= SEA_LEVEL - 2) ? stoneId : surfaceId;
                        continue;
                    }

                    // Subsurface layers (2-4 blocks deep under surface)
                    const depth = terrainHeight - wy;
                    if (depth <= 4) {
                        voxels[idx] = subId;
                        continue;
                    }

                    // Deep stone / variant
                    voxels[idx] = (wy < -80) ? deepId : stoneId;
                }
            }
        }

        // ── 3. Cave carving ────────────────────────────────────────────────
        this._carveCaves(voxels, worldOriginX, worldOriginY, worldOriginZ, heights);

        // ── 4. Ore placement ───────────────────────────────────────────────
        this._placeOres(voxels, cx, cy, cz, worldOriginX, worldOriginY, worldOriginZ, blends);

        return voxels;
    }

    // ── Biome blending ──────────────────────────────────────────────────────

    _biomeBlend(temp, humi, continent) {
        // Compute weights for all biomes based on distance in temp/humi space.
        // Apply a continental bias: push toward OCEAN when continent < 0.
        const continentFactor = Math.max(0, Math.min(1, (continent + 0.15) / 0.30));

        const weights = new Float32Array(this.biomes.length);
        let total = 0;

        for (let i = 0; i < this.biomes.length; i++) {
            const b   = this.biomes[i];
            const dt  = temp - b.temperature;
            const dh  = humi - b.humidity;
            const dist = Math.sqrt(dt*dt + dh*dh) + 0.0001;

            // Ocean biomes gain weight when continent < 0
            const isOcean  = b.name === 'OCEAN';
            let w = 1.0 / (dist * dist);
            if (isOcean)  w *= (1 - continentFactor) * 4 + 0.1;
            else          w *= continentFactor;

            weights[i] = w;
            total      += w;
        }

        if (total > 0) for (let i = 0; i < weights.length; i++) weights[i] /= total;

        return { weights, total };
    }

    _blendedHeight(wx, wz, blend) {
        let height = 0;
        for (let i = 0; i < this.biomes.length; i++) {
            const w = blend.weights[i];
            if (w < 0.001) continue;
            height += w * this._biomeHeight(wx, wz, this.biomes[i]);
        }
        return height;
    }

    _biomeHeight(wx, wz, biome) {
        const plain = fbm2D(wx, wz,
            biome.heightOctaves,
            biome.heightFrequency,
            0.50, 2.0);

        // Mountain ridges scaled by biome's mountainBlend factor
        const ridge = ridged2D(wx, wz,
            biome.heightOctaves,
            biome.heightFrequency * 0.6,
            0.55, 2.0);

        const mf = biome.mountainBlend;
        const blended = plain * (1 - mf) + ridge * mf;

        // Dramatic landmarks: high-variation biomes get domain warping
        let detail = 0;
        if (biome.heightVariation > 40) {
            detail = warpedFbm2D(wx, wz, 3, biome.heightFrequency * 4) * 8;
        }

        return biome.baseHeight + blended * biome.heightVariation + detail;
    }

    _blendedBlock(blend, field) {
        // Return the block ID of the biome with the highest weight that has
        // a non-zero value for the given field.
        let best = 0, bestW = -1;
        for (let i = 0; i < this.biomes.length; i++) {
            const w = blend.weights[i];
            if (w > bestW && this.biomes[i][field] !== 0) {
                best  = this.biomes[i][field];
                bestW = w;
            }
        }
        return best;
    }

    // ── Cave carving ────────────────────────────────────────────────────────

    _carveCaves(voxels, ox, oy, oz, heights) {
        // Only bother if any part of the chunk is below the terrain surface.
        // Caves are never carved above terrain height (avoids floating air pockets).
        for (let lx = 0; lx < N; lx++) {
            const wx = ox + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz = oz + lz;
                const maxCaveY = heights[lx * N + lz] - 4;

                for (let ly = 0; ly < N; ly++) {
                    const wy = oy + ly;
                    if (wy > maxCaveY || wy <= BEDROCK_Y + 4) continue;

                    const idx     = voxelIndex(lx, ly, lz);
                    const current = voxels[idx];

                    // Don't carve through water or air
                    if (current === this._airId || current === this._waterId) continue;

                    // Two overlapping noise fields — where BOTH have abs < threshold,
                    // the intersection creates a more organic, cavern-like shape.
                    const na = Math.abs(noise3D(wx * CAVE_FREQ_A, wy * CAVE_FREQ_A, wz * CAVE_FREQ_A));
                    const nb = Math.abs(noise3D(wx * CAVE_FREQ_B + 31.5, wy * CAVE_FREQ_B, wz * CAVE_FREQ_B - 17.2));

                    if (na < CAVE_THRESH && nb < CAVE_THRESH) {
                        // Gradually fill with water near sea level in deep caves
                        voxels[idx] = (wy < SEA_LEVEL - 16) ? this._waterId : this._airId;
                    }
                }
            }
        }
    }

    // ── Ore / vein placement ────────────────────────────────────────────────

    _placeOres(voxels, cx, cy, cz, ox, oy, oz, blends) {
        // Collect the blended set of ores: use the dominant biome's ore list.
        // Blend by checking the biome with the highest weight.
        const dominantIdx = this._dominantBiome(blends);
        const ores        = this.biomes[dominantIdx].ores;

        for (const ore of ores) {
            if (!ore._blockId) continue;

            const chunkMinY = oy;
            const chunkMaxY = oy + N - 1;

            // Skip ore entirely if the chunk Y range doesn't overlap ore Y range
            if (chunkMaxY < ore.minY || chunkMinY > ore.maxY) continue;

            // Number of vein attempts proportional to frequency × chunk volume
            const attempts = Math.ceil(ore.frequency * N * N * N);

            for (let attempt = 0; attempt < attempts; attempt++) {
                // Deterministic origin per (chunk, ore, attempt)
                const rng  = hashSeed(this.seed, cx * 7919 + attempt, cy * 6271, cz * 5237 + ore._blockId);
                const rx   = rng         & 0x1F;
                const ry   = (rng >> 5)  & 0x1F;
                const rz   = (rng >> 10) & 0x1F;

                const wx = ox + rx;
                const wy = oy + ry;
                const wz = oz + rz;

                if (wy < ore.minY || wy > ore.maxY) continue;

                const veinSize = ore.minSize + (hashSeed(rng, attempt) % (ore.maxSize - ore.minSize + 1));
                this._placeVein(voxels, ox, oy, oz, rx, ry, rz, ore._blockId, veinSize, rng);
            }
        }
    }

    _placeVein(voxels, ox, oy, oz, lx, ly, lz, blockId, size, seed) {
        // Random-walk vein: scatter blocks in a small 3D ball around the origin.
        let x = lx, y = ly, z = lz;
        for (let i = 0; i < size; i++) {
            if (x >= 0 && x < N && y >= 0 && y < N && z >= 0 && z < N) {
                const idx = voxelIndex(x, y, z);
                // Only replace stone-like blocks (not air, water, surface)
                const cur = voxels[idx];
                if (cur !== this._airId && cur !== this._waterId &&
                    cur !== this._bedrockId) {
                    voxels[idx] = blockId;
                }
            }
            // Step in a deterministic random direction
            const step = hashSeed(seed, i, blockId) % 6;
            const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
            const [dx, dy, dz] = dirs[step];
            x += dx; y += dy; z += dz;
        }
    }

    /**
     * Expose column-level data so StructurePlacer can re-use the same heights
     * that TerrainGenerator computed, without re-running noise.
     */
    buildColumnData(cx, cy, cz) {
        const ox = cx * N;
        const oz = cz * N;
        const heights = new Int16Array(N * N);
        const blends  = [];

        for (let lx = 0; lx < N; lx++) {
            const wx = ox + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz  = oz + lz;
                const col = lx * N + lz;
                const continent = fbm2D(wx + 8000, wz + 8000,
                    5, CONTINENT_FREQ, 0.5, 2.0);
                const temp = (noise2D(wx * TEMP_FREQ + 1000, wz * TEMP_FREQ + 1000) + 1) * 0.5;
                const humi = (noise2D(wx * HUMI_FREQ + 5000, wz * HUMI_FREQ + 5000) + 1) * 0.5;
                const blend = this._biomeBlend(temp, humi, continent);
                blends[col]  = blend;
                heights[col] = this._blendedHeight(wx, wz, blend) | 0;
            }
        }
        return { heights, blends };
    }

    _dominantBiome(blends) {
        // Pick the most-weighted biome across all columns (rough approximation).
        const sum = new Float32Array(this.biomes.length);
        for (const blend of blends) {
            if (!blend) continue;
            for (let i = 0; i < this.biomes.length; i++) sum[i] += blend.weights[i];
        }
        let best = 0;
        for (let i = 1; i < sum.length; i++) if (sum[i] > sum[best]) best = i;
        return best;
    }
}
