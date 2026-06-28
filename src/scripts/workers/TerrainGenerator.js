/**
 * TerrainGenerator
 *
 * Runs entirely inside a worker thread.  Fills a 16×640×16 Uint16Array with
 * block IDs for one chunk column using layered noise.  Each column spans the
 * full world height (WORLD_MIN_Y = -160 to +480), so cy is not a parameter.
 *
 * Generation pipeline per chunk:
 *   1. Continental scale — determines ocean vs land at very low frequency.
 *   2. Biome selection   — temperature + humidity noise maps to a weighted
 *                          blend of biome definitions loaded from the GamePack.
 *   3. Height field      — per-biome FBM / ridged noise, blended by biome weight.
 *                          A low-frequency "lake" noise dips flat biomes below
 *                          sea level to create natural ponds and lakes.
 *   4. Block fill        — surface / subsurface / stone layers, water fill.
 *   5. Cave carving      — two layers of 3D noise (lower threshold = sparser caves).
 *   6. Ore placement     — vein-based, data-driven from biome config.
 *                          Veins are clamped below terrain surface.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, CHUNK_VOLUME, voxelIndex } from '../engine/ChunkData.js';
import {
    setSeed, noise2D, noise3D,
    fbm2D, fbm3D, ridged2D, warpedFbm2D, hashSeed, randFloat,
} from './noise.js';

const N         = CHUNK_SIZE;    // 16 — XZ size
const N_Y       = CHUNK_SIZE_Y;  // 640 — full world height
const SEA_LEVEL = 64;
const BEDROCK_Y = WORLD_MIN_Y;   // -160

// Continent noise parameters
const CONTINENT_FREQ   = 0.00008;
const CONTINENT_OCTAVE = 5;

// Temperature / humidity control biome selection.
const TEMP_FREQ = 0.00035;
const HUMI_FREQ = 0.00030;

// Cave noise parameters.
const CAVE_FREQ_A  = 0.010;
const CAVE_FREQ_B  = 0.01;
const CAVE_THRESH  = 0.1;

const CAVE_MIN_Y   = BEDROCK_Y + 8;

// Lake / pond noise
const LAKE_FREQ       = 0.00045;
const LAKE_THRESHOLD  = 0.55;
const LAKE_MAX_DIP    = 18;

export class TerrainGenerator {
    /**
     * @param {number}          seed
     * @param {BlockRegistry}   blockRegistry
     * @param {object[]}        biomes         — biome defs from GamePack JSON
     */
    constructor(seed, blockRegistry, biomes) {
        this.seed   = seed;
        this.reg    = blockRegistry;
        this.biomes = biomes.map(b => this._normaliseBiome(b));

        setSeed(seed);

        for (const b of this.biomes) {
            b._surfaceId = this._id(b.surfaceBlock);
            b._subId     = this._id(b.subsurfaceBlock);
            b._stoneId   = this._id(b.stoneBlock);
            b._deepId    = this._id(b.deepBlock ?? b.stoneBlock);
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

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Generates a full chunk column and returns its voxel array.
     * The column spans WORLD_MIN_Y to WORLD_MIN_Y + CHUNK_SIZE_Y - 1.
     *
     * @param {number} cx  chunk X coordinate
     * @param {number} cz  chunk Z coordinate
     * @returns {Uint16Array}  length = CHUNK_VOLUME (163,840)
     */
    generateChunk(cx, cz) {
        const voxels = new Uint16Array(CHUNK_VOLUME);

        const worldOriginX = cx * N;
        const worldOriginZ = cz * N;

        // ── 1. Column-level data (height, biome) ───────────────────────────
        const heights    = new Int16Array(N * N);
        const blends     = [];
        const continents = new Float32Array(N * N);

        for (let lx = 0; lx < N; lx++) {
            const wx = worldOriginX + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz  = worldOriginZ + lz;
                const col = lx * N + lz;

                const continent = fbm2D(wx + 8000, wz + 8000,
                    CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
                continents[col] = continent;

                const temp = (noise2D(wx * TEMP_FREQ + 1000, wz * TEMP_FREQ + 1000) + 1) * 0.5;
                const humi = (noise2D(wx * HUMI_FREQ + 5000, wz * HUMI_FREQ + 5000) + 1) * 0.5;

                const blend = this._biomeBlend(temp, humi, continent);
                blends[col] = blend;

                heights[col] = this._blendedHeight(wx, wz, blend) | 0;
            }
        }

        // ── 2. Voxel fill (full 640-block column) ─────────────────────────
        for (let lx = 0; lx < N; lx++) {
            const wx = worldOriginX + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz            = worldOriginZ + lz;
                const col           = lx * N + lz;
                const terrainHeight = heights[col];
                const blend         = blends[col];

                const surfaceId = this._blendedBlock(blend, '_surfaceId');
                const subId     = this._blendedBlock(blend, '_subId');
                const stoneId   = this._blendedBlock(blend, '_stoneId');
                const deepId    = this._blendedBlock(blend, '_deepId');

                for (let ly = 0; ly < N_Y; ly++) {
                    const wy  = WORLD_MIN_Y + ly;
                    const idx = voxelIndex(lx, ly, lz);

                    if (wy <= BEDROCK_Y + 2) {
                        voxels[idx] = this._bedrockId;
                        continue;
                    }

                    if (wy > terrainHeight) {
                        voxels[idx] = (wy <= SEA_LEVEL) ? this._waterId : this._airId;
                        continue;
                    }

                    if (wy === terrainHeight) {
                        voxels[idx] = (wy <= SEA_LEVEL - 2) ? stoneId : surfaceId;
                        continue;
                    }

                    const depth = terrainHeight - wy;
                    if (depth <= 4) {
                        voxels[idx] = subId;
                        continue;
                    }

                    voxels[idx] = (wy < -80) ? deepId : stoneId;
                }
            }
        }

        // ── 3. Cave carving ────────────────────────────────────────────────
        this._carveCaves(voxels, worldOriginX, worldOriginZ, heights);

        // ── 4. Ore placement ───────────────────────────────────────────────
        this._placeOres(voxels, cx, cz, worldOriginX, worldOriginZ, blends, heights);

        return voxels;
    }

    // ── Biome blending ──────────────────────────────────────────────────────

    _biomeBlend(temp, humi, continent) {
        const continentFactor = Math.max(0, Math.min(1, (continent + 0.15) / 0.30));

        const weights = new Float32Array(this.biomes.length);
        let total = 0;

        for (let i = 0; i < this.biomes.length; i++) {
            const b       = this.biomes[i];
            const dt      = temp - b.temperature;
            const dh      = humi - b.humidity;
            const dist    = Math.sqrt(dt*dt + dh*dh) + 0.0001;
            const isOcean = b.name === 'OCEAN';

            let w = 1.0 / (dist * dist);
            if (isOcean) w *= (1 - continentFactor) * 4 + 0.1;
            else         w *= continentFactor;

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

        const ridge = ridged2D(wx, wz,
            biome.heightOctaves,
            biome.heightFrequency * 0.6,
            0.55, 2.0);

        const mf      = biome.mountainBlend;
        const blended = plain * (1 - mf) + ridge * mf;

        let detail = 0;
        if (biome.heightVariation > 40) {
            detail = warpedFbm2D(wx, wz, 3, biome.heightFrequency * 4) * 8;
        }

        let height = biome.baseHeight + blended * biome.heightVariation + detail;

        if (biome.mountainBlend < 0.15) {
            const lakeNoise = noise2D(wx * LAKE_FREQ + 2222, wz * LAKE_FREQ + 3333);
            if (lakeNoise > LAKE_THRESHOLD) {
                const t = (lakeNoise - LAKE_THRESHOLD) / (1 - LAKE_THRESHOLD);
                height -= t * t * LAKE_MAX_DIP;
            }
        }

        return height;
    }

    _blendedBlock(blend, field) {
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

    _carveCaves(voxels, ox, oz, heights) {
        for (let lx = 0; lx < N; lx++) {
            const wx = ox + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz       = oz + lz;
                const surfaceY = heights[lx * N + lz];
                // On land, carve all the way up through the surface block so caves
                // that reach the top break open into sinkholes / cave mouths.
                // Underwater, keep the surface capped so we don't punch air pockets
                // beneath the ocean floor.
                const maxCaveY = surfaceY > SEA_LEVEL ? surfaceY : surfaceY - 1;

                for (let ly = 0; ly < N_Y; ly++) {
                    const wy = WORLD_MIN_Y + ly;
                    if (wy > maxCaveY || wy <= BEDROCK_Y + 4) continue;

                    const idx     = voxelIndex(lx, ly, lz);
                    const current = voxels[idx];
                    if (current === this._airId || current === this._waterId) continue;

                    const na = Math.abs(noise3D(wx * CAVE_FREQ_A, wy * CAVE_FREQ_A, wz * CAVE_FREQ_A));
                    const nb = Math.abs(noise3D(wx * CAVE_FREQ_B + 31.5, wy * CAVE_FREQ_B, wz * CAVE_FREQ_B - 17.2));

                    if (na < CAVE_THRESH && nb < CAVE_THRESH) {
                        voxels[idx] = this._airId;
                    }
                }
            }
        }
    }

    // ── Ore / vein placement ────────────────────────────────────────────────

    _placeOres(voxels, cx, cz, ox, oz, blends, heights) {
        const dominantIdx = this._dominantBiome(blends);
        const ores        = this.biomes[dominantIdx].ores;

        for (const ore of ores) {
            if (!ore._blockId) continue;

            // Check if this ore's Y range overlaps the world height range at all
            const worldMaxY = WORLD_MIN_Y + N_Y - 1;
            if (worldMaxY < ore.minY || WORLD_MIN_Y > ore.maxY) continue;

            const attempts = Math.ceil(ore.frequency * N * N * N_Y);

            for (let attempt = 0; attempt < attempts; attempt++) {
                const rng = hashSeed(this.seed, cx * 7919 + attempt, cz * 5237 + ore._blockId, 6271);

                // 4 bits for XZ (0-15), 10 bits for Y (0-1023 → % N_Y for 0-639)
                const rx  = rng & 0x0F;
                const ry  = ((rng >> 4) & 0x3FF) % N_Y;
                const rz  = (rng >> 14) & 0x0F;

                const wy = WORLD_MIN_Y + ry;

                if (wy < ore.minY || wy > ore.maxY) continue;

                const colHeight = heights[rx * N + rz];
                if (wy > colHeight - 4) continue;

                const veinSize = ore.minSize + (hashSeed(rng, attempt) % (ore.maxSize - ore.minSize + 1));
                this._placeVein(voxels, ox, oz, rx, ry, rz, ore._blockId, veinSize, rng, heights);
            }
        }
    }

    _placeVein(voxels, ox, oz, lx, ly, lz, blockId, size, seed, heights) {
        let x = lx, y = ly, z = lz;
        for (let i = 0; i < size; i++) {
            if (x >= 0 && x < N && y >= 0 && y < N_Y && z >= 0 && z < N) {
                const wy   = WORLD_MIN_Y + y;
                const colH = heights[x * N + z];
                if (wy <= colH - 4) {
                    const idx = voxelIndex(x, y, z);
                    const cur = voxels[idx];
                    if (cur !== this._airId && cur !== this._waterId &&
                        cur !== this._bedrockId) {
                        voxels[idx] = blockId;
                    }
                }
            }
            const step = hashSeed(seed, i, blockId) % 6;
            const dirs  = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
            const [dx, dy, dz] = dirs[step];
            x += dx; y += dy; z += dz;
        }
    }

    /**
     * Expose column-level data so StructurePlacer can reuse the same heights
     * that TerrainGenerator computed, without re-running noise.
     */
    buildColumnData(cx, cz) {
        const ox      = cx * N;
        const oz      = cz * N;
        const heights = new Int16Array(N * N);
        const blends  = [];

        for (let lx = 0; lx < N; lx++) {
            const wx = ox + lx;
            for (let lz = 0; lz < N; lz++) {
                const wz  = oz + lz;
                const col = lx * N + lz;
                const continent = fbm2D(wx + 8000, wz + 8000, 5, CONTINENT_FREQ, 0.5, 2.0);
                const temp      = (noise2D(wx * TEMP_FREQ + 1000, wz * TEMP_FREQ + 1000) + 1) * 0.5;
                const humi      = (noise2D(wx * HUMI_FREQ + 5000, wz * HUMI_FREQ + 5000) + 1) * 0.5;
                const blend     = this._biomeBlend(temp, humi, continent);
                blends[col]     = blend;
                heights[col]    = this._blendedHeight(wx, wz, blend) | 0;
            }
        }
        return { heights, blends };
    }

    _dominantBiome(blends) {
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
