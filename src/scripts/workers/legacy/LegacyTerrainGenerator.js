/**
 * LegacyTerrainGenerator — the world generator from before the world-generation
 * overhaul, kept byte-for-byte so worlds created with it (no `worldGen` in their
 * world.json) keep generating the same terrain where the player has not been
 * yet, instead of meeting new terrain at a seam. It uses the biome definitions
 * of that time (legacyBiomes.js), not data/biomes/. Frozen: do not change what
 * it generates. New worlds use TerrainGenerator.js.
 *
 * LegacyWorldGen (below) wraps it with its structure placer behind the same
 * generate(cx, cz) the worker calls on the current generator.
 *
 * Original notes follow.
 *
 * Fills a 16×448×16 Uint16Array with block IDs for one chunk column using
 * layered noise. Each column spans the full world height.
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

import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, WORLD_MAX_Y, CHUNK_VOLUME, voxelIndex } from '../../engine/ChunkData.js';
import {
    setSeed, noise2D, noise3D,
    fbm2D, fbm3D, ridged2D, warpedFbm2D, hashSeed, randFloat,
} from '../noise.js';
import { LEGACY_BIOMES } from './legacyBiomes.js';
import { LegacyStructurePlacer } from './LegacyStructurePlacer.js';

const N         = CHUNK_SIZE;    // 16 — XZ size
const N_Y       = CHUNK_SIZE_Y;  // full world height
const SEA_LEVEL = 64;
const BEDROCK_Y = WORLD_MIN_Y;

// Continent noise parameters
export const CONTINENT_FREQ   = 0.00008;
export const CONTINENT_OCTAVE = 5;

// Temperature / humidity control biome selection.
export const TEMP_FREQ = 0.00035;
export const HUMI_FREQ = 0.00030;

// Cave noise parameters.
const CAVE_FREQ_A  = 0.010;
const CAVE_FREQ_B  = 0.01;
const CAVE_THRESH  = 0.1;

// Lowest world Y that can be carved. Cave carving is the single most expensive
// step in generation — two 3D noise samples per candidate voxel — and caves down
// at the bedrock floor are never seen. Leaving a solid band above bedrock both
// speeds generation up and gives the deep-stone layer something to be.
const CAVE_MIN_Y   = BEDROCK_Y + 8;

// Lake / pond noise
const LAKE_FREQ       = 0.00045;
const LAKE_THRESHOLD  = 0.55;
const LAKE_MAX_DIP    = 18;

// Vein random-walk steps: +X -X +Y -Y +Z -Z.
const VEIN_DX = [1, -1, 0, 0, 0, 0];
const VEIN_DY = [0, 0, 1, -1, 0, 0];
const VEIN_DZ = [0, 0, 0, 0, 1, -1];

export class LegacyTerrainGenerator {
    /**
     * @param {number}          seed
     * @param {BlockRegistry}   blockRegistry
     * @param {object[]}        biomes         — biome defs from GamePack JSON
     */
    constructor(seed, blockRegistry, biomes) {
        this.seed   = seed;
        this.reg    = blockRegistry;
        this.biomes = (biomes ?? []).map(b => this._normaliseBiome(b));

        // A pack that supplies no biomes used to take down every worker with an
        // unhandled TypeError deep in ore placement, leaving the player on a
        // loading screen forever with nothing in the UI to explain it.
        // Synthesise a plain biome instead so the world still generates.
        if (this.biomes.length === 0) {
            console.warn('[TerrainGenerator] no biomes supplied — falling back to a default biome');
            this.biomes = [this._normaliseBiome({ name: 'DEFAULT' })];
        }

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

        // ── 2. Voxel fill ──────────────────────────────────────────────────
        // Written as contiguous vertical bands rather than a per-voxel branch
        // chain. Each band walks the column with `idx += SY` instead of
        // recomputing voxelIndex, and the air above the terrain is skipped
        // entirely because the buffer is already zero-filled — on a 448-tall
        // world that is most of every column.
        const SY = N;   // voxelIndex stride between consecutive ly values

        for (let lx = 0; lx < N; lx++) {
            for (let lz = 0; lz < N; lz++) {
                const col           = lx * N + lz;
                const terrainHeight = heights[col];
                const blend         = blends[col];

                const surfaceId = this._blendedBlock(blend, '_surfaceId');
                const subId     = this._blendedBlock(blend, '_subId');
                const stoneId   = this._blendedBlock(blend, '_stoneId');
                const deepId    = this._blendedBlock(blend, '_deepId');

                const colBase = voxelIndex(lx, 0, lz);
                // Write voxels in world-Y band [loW, hiW] with a single id.
                const band = (loW, hiW, id) => {
                    let lo = loW - WORLD_MIN_Y;
                    let hi = hiW - WORLD_MIN_Y;
                    if (lo < 0) lo = 0;
                    if (hi > N_Y - 1) hi = N_Y - 1;
                    let idx = colBase + lo * SY;
                    for (let ly = lo; ly <= hi; ly++, idx += SY) voxels[idx] = id;
                };

                const bedrockTopW = BEDROCK_Y + 2;

                // Bedrock floor — always wins.
                band(BEDROCK_Y, bedrockTopW, this._bedrockId);

                if (terrainHeight > bedrockTopW) {
                    // Deep fill and ordinary stone, below the 4-block subsurface layer.
                    const fillHiW  = terrainHeight - 5;
                    const deepHiW  = Math.min(fillHiW, -81);      // deep applies where wy < -80
                    const stoneLoW = Math.max(bedrockTopW + 1, -80);
                    if (deepHiW >= bedrockTopW + 1) band(bedrockTopW + 1, deepHiW, deepId);
                    if (fillHiW >= stoneLoW)        band(stoneLoW, fillHiW, stoneId);

                    // Subsurface (dirt / sand) directly under the surface block.
                    const subLoW = Math.max(bedrockTopW + 1, terrainHeight - 4);
                    const subHiW = terrainHeight - 1;
                    if (subHiW >= subLoW) band(subLoW, subHiW, subId);

                    // Surface block. Below sea level the exposed floor is stone.
                    band(terrainHeight, terrainHeight,
                         terrainHeight <= SEA_LEVEL - 2 ? stoneId : surfaceId);
                }

                // Water from just above the terrain up to sea level. Everything
                // above that stays AIR, which the zero-filled buffer already is.
                if (terrainHeight < SEA_LEVEL) {
                    band(Math.max(terrainHeight + 1, bedrockTopW + 1), SEA_LEVEL, this._waterId);
                }
            }
        }

        // ── 3. Cave carving ────────────────────────────────────────────────
        this._carveCaves(voxels, worldOriginX, worldOriginZ, heights);

        // ── 4. Ore placement ───────────────────────────────────────────────
        this._placeOres(voxels, cx, cz, worldOriginX, worldOriginZ, blends, heights);

        // Kept for buildColumnData, which the structure pass calls next for
        // this same chunk.
        this._lastColumns = { cx, cz, heights, blends };

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
        // Carving only ever applies between CAVE_MIN_Y and the column surface, so
        // the loop is bounded to that band rather than walking all N_Y levels and
        // discarding most of them. At two noise3D samples per candidate voxel this
        // is the hottest loop in generation, and the skipped levels were by far
        // the majority of it.
        const lyLo = Math.max(0, CAVE_MIN_Y - WORLD_MIN_Y);

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
                const lyHi     = Math.min(N_Y - 1, maxCaveY - WORLD_MIN_Y);

                for (let ly = lyLo; ly <= lyHi; ly++) {
                    const idx     = voxelIndex(lx, ly, lz);
                    const current = voxels[idx];
                    if (current === this._airId || current === this._waterId) continue;

                    const wy = WORLD_MIN_Y + ly;
                    const na = Math.abs(noise3D(wx * CAVE_FREQ_A, wy * CAVE_FREQ_A, wz * CAVE_FREQ_A));
                    if (na >= CAVE_THRESH) continue;   // cheap reject before the second sample

                    const nb = Math.abs(noise3D(wx * CAVE_FREQ_B + 31.5, wy * CAVE_FREQ_B, wz * CAVE_FREQ_B - 17.2));
                    if (nb < CAVE_THRESH) voxels[idx] = this._airId;
                }
            }
        }
    }

    // ── Ore / vein placement ────────────────────────────────────────────────

    _placeOres(voxels, cx, cz, ox, oz, blends, heights) {
        const dominantIdx = this._dominantBiome(blends);
        const ores        = this.biomes[dominantIdx]?.ores;
        if (!ores) return;

        for (const ore of ores) {
            if (!ore._blockId) continue;

            // Clamp the ore band to the world, and skip ores whose configured
            // range falls entirely outside it.
            const loW = Math.max(ore.minY, WORLD_MIN_Y);
            const hiW = Math.min(ore.maxY, WORLD_MAX_Y);
            if (hiW < loW) continue;
            const span = hiW - loW + 1;

            // Attempts scale with the band volume rather than the whole column,
            // and the sampled Y lands inside the band by construction. Previously
            // every attempt sampled the full height and most were thrown away —
            // for a narrow band that was well over 80% wasted work.
            const attempts = Math.ceil(ore.frequency * N * N * span);

            for (let attempt = 0; attempt < attempts; attempt++) {
                const rng = hashSeed(this.seed, cx * 7919 + attempt, cz * 5237 + ore._blockId, 6271);

                // Disjoint bit fields: 4 for X, 4 for Z, 20 for the Y offset.
                const rx  = rng & 0x0F;
                const rz  = (rng >> 4) & 0x0F;
                const wy  = loW + (((rng >> 8) & 0xFFFFF) % span);
                const ry  = wy - WORLD_MIN_Y;

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
            x += VEIN_DX[step]; y += VEIN_DY[step]; z += VEIN_DZ[step];
        }
    }

    /**
     * Expose column-level data so StructurePlacer can reuse the same heights
     * that TerrainGenerator computed, without re-running noise.
     */
    buildColumnData(cx, cz) {
        // generateChunk has just computed exactly this; recomputing it ran the
        // continent, climate, biome-blend and height noise a second time per
        // column. Nothing mutates the arrays, so they can be handed out as-is.
        const last = this._lastColumns;
        if (last && last.cx === cx && last.cz === cz) return { heights: last.heights, blends: last.blends };

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

// ── Wrapper used by the worker ──────────────────────────────────────────────

/** Terrain plus structures for a pre-overhaul world, exactly as it was made. */
export class LegacyWorldGen {
    constructor(seed, blockRegistry) {
        // The old generator reads the module-wide noise seed.
        setSeed(seed);
        this.terrain = new LegacyTerrainGenerator(seed, blockRegistry, LEGACY_BIOMES);
        this.placer  = new LegacyStructurePlacer(seed, blockRegistry, this.terrain.biomes, this.terrain);
    }

    generate(cx, cz) {
        const voxels = this.terrain.generateChunk(cx, cz);
        const { heights, blends } = this.terrain.buildColumnData(cx, cz);
        this.placer.apply(voxels, cx, cz, heights, blends);
        return voxels;
    }

    // Far terrain (workers/FarTiles.js): the same interface as the current
    // generator's. Reads the old generator's column noise; generates nothing,
    // so it cannot change what these worlds are made of.
    setFarPalette(palette) { this.farPalette = palette ?? null; }

    /** The colour far terrain gives block `id` (for the surfaces of changed chunks). */
    farColor(id, out, k = 1) {
        const P = this.farPalette;
        let c;
        if (P && id * 3 + 2 < P.length) c = [P[id * 3], P[id * 3 + 1], P[id * 3 + 2]];
        else { const d = this.terrain.reg.get(id); c = d.topColor ?? d.color ?? [0.5, 0.5, 0.5]; }
        out.r = c[0] * k; out.g = c[1] * k; out.b = c[2] * k;
        return out;
    }

    farSample(x, z, wantColor, out) {
        const t = this.terrain;
        const continent = fbm2D(x + 8000, z + 8000, CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
        const temp = (noise2D(x * TEMP_FREQ + 1000, z * TEMP_FREQ + 1000) + 1) * 0.5;
        const humi = (noise2D(x * HUMI_FREQ + 5000, z * HUMI_FREQ + 5000) + 1) * 0.5;
        const blend = t._biomeBlend(temp, humi, continent);
        const h = t._blendedHeight(x, z, blend) | 0;
        const water = h < SEA_LEVEL;
        out.h = (water ? SEA_LEVEL : h) + 1;
        if (!wantColor) return out;
        const P = this.farPalette;
        const rgb = (id) => {
            if (P && id * 3 + 2 < P.length) return [P[id * 3], P[id * 3 + 1], P[id * 3 + 2]];
            const d = t.reg.get(id);
            return d.topColor ?? d.color ?? [0.5, 0.5, 0.5];
        };
        const c = [...rgb(t._blendedBlock(blend, '_surfaceId'))];   // a copy: it may be the block's own colour
        if (water) {
            // Water over its bed at the chunk shader's 0.72 opacity.
            const w = rgb(t._waterId);
            for (let k = 0; k < 3; k++) c[k] += (w[k] - c[k]) * 0.72;
        }
        out.r = c[0]; out.g = c[1]; out.b = c[2];
        return out;
    }
}
