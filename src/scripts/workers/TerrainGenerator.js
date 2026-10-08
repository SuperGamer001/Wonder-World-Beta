/**
 * TerrainGenerator — one chunk column's voxels, from the landscape down.
 *
 * Runs in a worker. For chunk (cx, cz):
 *
 *   1. Geography.region()  the shape of the land for every column: height,
 *                          water, biome, slope, temperature (Geography.js)
 *   2. fill                each column from the bottom: bedrock, the deep
 *                          stone (slate), the biome's stone, then its cover —
 *                          layers and a top block, chosen by what the column
 *                          is: under water, too steep for soil, above the snow
 *                          line, or ordinary ground with its noise patches —
 *                          then water, freezing where it is cold
 *   3. CaveCarver          tunnels, noodles, caverns, underground valleys,
 *                          shafts and ravines (Caves.js)
 *   4. rock blobs, ores    from the world's geology (data/terrain/geology.json)
 *                          plus the biome's extra ores
 *   5. StructurePlacer     trees, plants, boulders, houses (generate() only)
 *
 * Everything is a function of world position and the seed, so a chunk comes
 * out the same whenever it is generated and matches its neighbours at every
 * seam. Biomes decide materials and what grows; the land's shape is theirs to
 * decorate, not to make.
 *
 * Worlds made before this generator use legacy/LegacyTerrainGenerator.js
 * (chosen by the world's `worldGen`, see worldWorker.js).
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, WORLD_MAX_Y, CHUNK_VOLUME } from '../engine/ChunkData.js';
import { Simplex, hashSeed } from './noise.js';
import { Geography, NO_WATER, LAPSE_START, LAPSE_RATE, COL_SHORE } from './Geography.js';
import { BiomeSet, blockIdOf } from './Biomes.js';
import { CaveCarver } from './Caves.js';
import { StructurePlacer } from './StructurePlacer.js';
import { normaliseFlat } from '../engine/FlatWorld.js';

/** The generator version new worlds are stamped with (server.js WORLD_GEN). */
export const WORLD_GEN = 2;

const N = CHUNK_SIZE;
const SZ = N * CHUNK_SIZE_Y;
const BEDROCK_TOP = WORLD_MIN_Y + 2;

const SNOW_T  = 0.14;     // snow lies where the temperature (after altitude) is below this
const GLACIER_T = -0.12;  // … and packed ice builds up under it below this
const ICE_T   = 0.14;     // water freezes over below this
const STEEP   = 1.25;     // rise per block above which soil gives way to the biome's rock
const BAND_PERIOD = 96;   // blocks before a biome's bands repeat
const FAR_WATER_ALPHA = 0.72;   // far terrain: water over its bed, as the chunk shader draws it

/** Used when no geology.json is loaded (the old fallback gamepack). */
const DEFAULT_GEOLOGY = {
    bedrock: 'BEDROCK',
    stone: 'STONE',
    deepStone: { block: 'SLATE', y: 0, wobble: 5, blend: 4 },
    rockBlobs: [
        { block: 'GRANITE',  minY: -70, maxY: 180, frequency: 0.00012, radius: [2.5, 4.5] },
        { block: 'DIORITE',  minY: -70, maxY: 180, frequency: 0.00012, radius: [2.5, 4.5] },
        { block: 'ANDESITE', minY: -70, maxY: 220, frequency: 0.00016, radius: [2.5, 5] },
        { block: 'DIRT',     minY: 0,   maxY: 220, frequency: 0.000078, radius: [2, 3.5] },
        { block: 'GRAVEL',   minY: -60, maxY: 220, frequency: 0.000078, radius: [2, 3.5] },
    ],
    blobHosts: ['STONE', 'SLATE'],
    ores: [
        { block: 'COAL_ORE', minY: 0,    maxY: 260, frequency: 0.0062, minSize: 4, maxSize: 14 },
        { block: 'IRON_ORE', minY: -110, maxY: 190, frequency: 0.0068, minSize: 3, maxSize: 9 },
        { block: 'GOLD_ORE', minY: -128, maxY: -30, frequency: 0.0045, minSize: 2, maxSize: 7 },
    ],
    oreHosts: ['STONE', 'SLATE', 'GRANITE', 'DIORITE', 'ANDESITE', 'LIMESTONE', 'SANDSTONE', 'RED_SANDSTONE', 'TERRACOTTA'],
    caves: {},
};

function mergeGeology(defs) {
    const g = (Array.isArray(defs) ? defs : defs ? [defs] : []).find(d => d && d.name === 'geology') ?? {};
    return {
        ...DEFAULT_GEOLOGY, ...g,
        deepStone: { ...DEFAULT_GEOLOGY.deepStone, ...(g.deepStone ?? {}) },
        caves: { ...(g.caves ?? {}) },
    };
}

// Vein random-walk steps: +X -X +Y -Y +Z -Z.
const VEIN_DX = [1, -1, 0, 0, 0, 0];
const VEIN_DY = [0, 0, 1, -1, 0, 0];
const VEIN_DZ = [0, 0, 0, 0, 1, -1];

export class TerrainGenerator {
    /**
     * @param {number}          seed
     * @param {BlockRegistry}   blockRegistry
     * @param {object[]}        biomes    biome definitions (data/biomes)
     * @param {object[]|object} [terrain] world settings (data/terrain: geology.json)
     * @param {object}          [flat]    a Flat world's settings (engine/FlatWorld.js):
     *        level ground and nothing under it but its layers
     */
    constructor(seed, blockRegistry, biomes, terrain, flat = null) {
        this.seed = seed | 0;
        this.reg = blockRegistry;
        const G = this.geology = mergeGeology(terrain);
        this.biomes = new BiomeSet(biomes);
        this.flat = normaliseFlat(flat);
        this.geo = new Geography(this.seed, this.biomes, this.flat);
        this.caves = new CaveCarver(this.seed, G.caves);
        // A Flat world of the player's own layers: block ids and thicknesses,
        // top first (null: the ground is the biome's, as in a normal world).
        this.flatLayers = this.flat?.mode === 'layers'
            ? this.flat.layers.map(l => ({ id: blockIdOf(blockRegistry, l.block), depth: l.depth }))
            : null;

        const id = (n) => blockIdOf(blockRegistry, n);
        this.ids = {
            air: 0, water: id('WATER'), ice: id('ICE'), bedrock: id(G.bedrock),
            stone: id(G.stone), deep: id(G.deepStone.block), snow: id('SNOW'), packedIce: id('PACKED_ICE'),
        };
        this.surfaces = this.biomes.list.map((b, i) => this._compile(b.surface, i));

        const s = (k) => new Simplex(hashSeed(this.seed, 0x3d7a11, k));
        this.nDetail = s(1);    // snow line, steepness and layer-depth wobble
        this.nPatch  = s(2);
        this.nDeep   = s(3);
        this.nBand   = s(4);

        const hostSet = (names) => {
            const t = new Uint8Array(65536);
            for (const n of names ?? []) { const d = blockRegistry.getByName(n); if (d) t[d.id] = 1; }
            return t;
        };
        this.blobHosts = hostSet(G.blobHosts);
        this.oreHosts = hostSet(G.oreHosts);
        this.blobs = (G.rockBlobs ?? []).map(b => ({
            id: id(b.block), minY: b.minY ?? -64, maxY: b.maxY ?? 128, frequency: b.frequency ?? 0,
            r0: b.radius?.[0] ?? 2, r1: b.radius?.[1] ?? 4,
        })).filter(b => b.frequency > 0 && b.id !== this.ids.stone);
        const ore = (o) => ({
            id: id(o.block), minY: o.minY ?? -64, maxY: o.maxY ?? 128, frequency: o.frequency ?? 0,
            minSize: o.minSize ?? 3, maxSize: o.maxSize ?? Math.max(o.minSize ?? 3, 8),
        });
        this.ores = (G.ores ?? []).map(ore);
        this.biomeOres = this.biomes.list.map(b => (b.ores ?? []).map(ore));

        this.placer = new StructurePlacer(this.seed, blockRegistry, this.biomes, this.geo,
            (x, z, col) => this._cover(x, z, col.water, col.biome, col.slope, col.temp, col.flags));
        if (this.flat) {
            this.placer.plants    = this.flat.decorations;
            this.placer.buildings = this.flat.structures;
        }
        this.topBlocks = new Uint16Array(N * N);
        this._cv = { cover: null, top: 0, first: -1, snowy: false, steep: false, glacier: 0 };
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** The finished chunk: terrain, caves, rock, ores and structures. */
    generate(cx, cz) {
        const voxels = this.generateChunk(cx, cz);
        this.placer.apply(voxels, cx, cz, this.lastColumns, this.topBlocks);
        return voxels;
    }

    /**
     * Terrain, caves, rock and ores for chunk (cx, cz) — everything but the
     * structures. Leaves the column data in `lastColumns` (Geography.region's
     * scratch, valid until the next chunk) and each column's top block in
     * `topBlocks`.
     */
    generateChunk(cx, cz) {
        const ox = cx * N, oz = cz * N;
        const cols = this.geo.region(ox, oz, N);
        const vox = new Uint16Array(CHUNK_VOLUME);
        for (let lx = 0; lx < N; lx++) {
            for (let lz = 0; lz < N; lz++) this._fillColumn(vox, lx, lz, ox + lx, oz + lz, cols, lx * N + lz);
        }
        // A Flat world is its layers and nothing else.
        if (!this.flat) {
            this.caves.carve(vox, ox, oz, cols, this.ids);
            this._placeBlobs(vox, cx, cz);
            this._placeOres(vox, cx, cz, cols);
        }
        this.lastColumns = cols;
        return vox;
    }

    // ── Surfaces ─────────────────────────────────────────────────────────────

    _compile(S, biomeIndex) {
        const id = (n) => blockIdOf(this.reg, n);
        const cover = (c) => ({ top: id(c.top), layers: c.layers.map(l => ({ id: id(l.block), depth: l.depth })) });
        const patches = (list) => list.map((p, k) => ({
            id: id(p.block), scale: p.scale, thr: p.threshold, under: p.under,
            off: (biomeIndex * 7 + k) * 13.37,
        }));
        let bands = null;
        if (S.bands) {
            // Stripes 1–4 blocks thick, the biome's list in order, repeating.
            bands = new Uint16Array(BAND_PERIOD);
            const ids = S.bands.map(id);
            let y = 0, k = 0;
            while (y < BAND_PERIOD) {
                const t = 1 + hashSeed(this.seed, biomeIndex, y, 0xba2d) % 4;
                for (let i = 0; i < t && y < BAND_PERIOD; i++, y++) bands[y] = ids[k % ids.length];
                k++;
            }
        }
        return {
            ground: cover({ top: S.top, layers: S.layers }),
            steep: cover(S.steep),
            underwater: cover(S.underwater),
            stone: id(S.stone),
            deep: S.deep ? id(S.deep) : this.ids.deep,
            snow: id(S.snow),
            patches: patches(S.patches),
            underwaterPatches: patches(S.underwaterPatches),
            bands, bandDepth: S.bandDepth,
            topDepth: S.topDepth,
        };
    }

    /**
     * Decide a column's cover and return its top block. Pure in (x, z) and the
     * column's values, so the structure placer can ask about columns in other
     * chunks and get what those chunks built. Leaves the choice in this._cv.
     */
    _cover(x, z, water, biome, slope, temp, flags) {
        const S = this.surfaces[biome];
        const cv = this._cv;
        if (this.flatLayers) {
            // The player's layers: the top one, whatever the biome and the cold.
            cv.cover = S.ground; cv.top = this.flatLayers[0].id; cv.first = -1;
            cv.snowy = false; cv.steep = false; cv.glacier = 0;
            return cv.top;
        }
        const d = this.nDetail.noise2(x / 14, z / 14);
        let cover, patches, snowy = false, steep = false;
        if (water !== NO_WATER || (flags & COL_SHORE)) {
            // Beds of seas, rivers and lakes, and a lake's shore: sand,
            // gravel, clay or mud by biome.
            cover = S.underwater;
            patches = S.underwaterPatches;
        } else {
            steep = slope > STEEP + 0.35 * d;
            snowy = temp + 0.04 * d < SNOW_T;
            // Snow clings to moderate slopes; sheer rock stays bare.
            if (steep && snowy && slope < STEEP + 0.9) steep = false;
            if (steep) { cover = S.steep; patches = null; snowy = false; }
            else { cover = S.ground; patches = S.patches; }
        }
        let t = cover.top, first = -1;
        if (patches) {
            for (let k = 0; k < patches.length; k++) {
                const p = patches[k];
                if (this.nPatch.noise2(x / p.scale + p.off, z / p.scale - p.off) > p.thr) {
                    t = p.id;
                    if (p.under) first = p.id;
                    break;
                }
            }
        }
        let glacier = 0;
        if (snowy) {
            t = S.snow;
            if (temp < GLACIER_T && slope < 1) glacier = Math.min(5, 2 + Math.floor((GLACIER_T - temp) * 20));
        }
        cv.cover = cover; cv.top = t; cv.first = first; cv.snowy = snowy; cv.steep = steep; cv.glacier = glacier;
        return t;
    }

    _fillColumn(vox, lx, lz, x, z, cols, c) {
        const ids = this.ids;
        const top = cols.top[c], water = cols.water[c], biome = cols.biome[c];
        const S = this.surfaces[biome];
        const base = lx + lz * SZ;
        const put = (y0, y1, id) => {
            if (y0 < WORLD_MIN_Y) y0 = WORLD_MIN_Y;
            if (y1 > WORLD_MAX_Y) y1 = WORLD_MAX_Y;
            for (let y = y0, i = base + (y0 - WORLD_MIN_Y) * N; y <= y1; y++, i += N) vox[i] = id;
        };

        if (this.flatLayers) {
            // The stack, from the top down; under it there is nothing.
            this.topBlocks[c] = this.flatLayers[0].id;
            let y = top;
            for (const l of this.flatLayers) { put(y - l.depth + 1, y, l.id); y -= l.depth; }
            return;
        }
        put(WORLD_MIN_Y, BEDROCK_TOP, ids.bedrock);
        const topId = this._cover(x, z, water, biome, cols.slope[c], cols.temp[c], cols.flags[c]);
        this.topBlocks[c] = topId;
        if (top > BEDROCK_TOP) {
            const cv = this._cv;
            const cover = cv.cover;
            // Top block(s): deep sand on dunes, a snow cap over a glacier.
            const topDepth = water === NO_WATER && !cv.steep ? S.topDepth : 1;
            let y = top;
            put(y - topDepth + 1, y, topId);
            y -= topDepth;
            if (cv.glacier) { put(y - cv.glacier + 1, y, ids.packedIce); y -= cv.glacier; }
            // The cover's layers, the first a block deeper or shallower here and there.
            const jit = Math.round(1.1 * this.nDetail.noise2(x / 9 + 40.5, z / 9 - 17.25));
            const layers = cover.layers;
            for (let k = 0; k < layers.length; k++) {
                const dd = layers[k].depth + (k === 0 ? jit : 0);
                if (dd <= 0) continue;
                put(y - dd + 1, y, k === 0 && cv.first >= 0 ? cv.first : layers[k].id);
                y -= dd;
            }
            // Rock below: the deep stone up to a wavy, ragged boundary, then the
            // biome's stone.
            const D = this.geology.deepStone;
            const deepTop = Math.floor(D.y + D.wobble * this.nDeep.noise2(x / 60, z / 60) +
                                       D.blend * this.nDeep.noise2(x * 0.37 + 11.3, z * 0.37 - 5.1));
            const stoneTop = y;
            put(BEDROCK_TOP + 1, Math.min(deepTop, stoneTop), S.deep);
            put(Math.max(deepTop + 1, BEDROCK_TOP + 1), stoneTop, S.stone);
            // Badlands: stripes of terracotta under the cover, and right up to
            // the surface on the cliffs.
            if (S.bands && water === NO_WATER) {
                const lo = Math.max(BEDROCK_TOP + 1, top - S.bandDepth);
                const hi = cv.steep ? top : stoneTop;
                const wob = Math.round(3 * this.nBand.noise2(x / 50, z / 50));
                for (let yy = lo, i = base + (lo - WORLD_MIN_Y) * N; yy <= hi; yy++, i += N) {
                    vox[i] = S.bands[(((yy + wob) % BAND_PERIOD) + BAND_PERIOD) % BAND_PERIOD];
                }
            }
        }
        if (water !== NO_WATER) {
            put(Math.max(top + 1, BEDROCK_TOP + 1), water, ids.water);
            if (this._freezes(x, z, top, water, cols.temp[c])) put(water, water, ids.ice);
        }
    }

    /** Does the water standing over this column freeze? Broken ice near the edge. */
    _freezes(x, z, top, water, temp) {
        const above = (y) => (y > LAPSE_START ? y - LAPSE_START : 0);
        const tWater = temp - (above(water) - above(top)) * LAPSE_RATE;
        return tWater + 0.05 * this.nDetail.noise2(x / 11 - 33.3, z / 11 + 20.7) < ICE_T;
    }

    // ── Far terrain (FarTiles.js) ────────────────────────────────────────────

    /**
     * The colour far terrain draws each block with (r, g, b per id): its top
     * texture's average from the render thread, so distant land matches the
     * chunks it continues. Until one is set, the blocks' own colours.
     */
    setFarPalette(palette) { this.farPalette = palette ?? null; }

    _farRgb(id, out, k = 1) {
        const P = this.farPalette;
        let r, g, b;
        if (P && id * 3 + 2 < P.length) { r = P[id * 3]; g = P[id * 3 + 1]; b = P[id * 3 + 2]; }
        else { const d = this.reg.get(id); const c = d.topColor ?? d.color ?? [0.5, 0.5, 0.5]; r = c[0]; g = c[1]; b = c[2]; }
        out.r = r * k; out.g = g * k; out.b = b * k;
    }

    /**
     * One column as far terrain draws it, into `out`: `h`, the world Y of its
     * surface (the water's where there is water), and with `wantColor` its
     * colour `r, g, b` — the surface block the chunk would have (snow, rock,
     * sand, patches…), water shaded by depth over its bed, ice, and forests as
     * a raised canopy in their leaves' colour. Exactly the chunk's geography
     * (Geography.column), so far terrain meets the chunks where they end.
     */
    farSample(x, z, wantColor, out, canopy = true) {
        const c = this.geo.column(x, z);
        return this._farPoint(x, z, c.top, c.water, c.biome, c.slope, c.temp, c.flags, wantColor, out, canopy);
    }

    /**
     * farSample over an m×m lattice `step` blocks apart from (x0, z0), from one
     * pass of Geography.region() in its coarse mode: heights into H and colours
     * into rgb (3 floats a point), index i * m + j with i along x. A quarter of
     * the cost per point of asking column by column; the price is that slopes
     * and the distances to rivers and coasts are measured across the lattice.
     *
     * `canopy` false leaves the trees out of it — bare ground, for the tiles
     * near enough to draw them as shapes (farFeatures, which reads the lattice
     * this leaves behind and so must be called before anything else here).
     */
    farGrid(x0, z0, step, m, H, rgb, canopy = true) {
        const O = this.geo.region(x0, z0, m, step);
        const s = this._farS ??= { h: 0, r: 0, g: 0, b: 0 };
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < m; j++) {
                const o = i * m + j;
                this._farPoint(x0 + i * step, z0 + j * step, O.top[o], O.water[o], O.biome[o],
                               O.slope[o], O.temp[o], O.flags[o], true, s, canopy);
                H[o] = s.h;
                rgb[o * 3] = s.r; rgb[o * 3 + 1] = s.g; rgb[o * 3 + 2] = s.b;
            }
        }
        this._farLattice = { O, x0, z0, step, m };
    }

    /**
     * The plants and buildings of the square of `size` blocks at (x0, z0), as
     * far terrain draws them: emit(x, y, z, proxy, hash, dense) with (x, z) the
     * root, y the ground under it, `proxy` its boxes (StructurePlacer.proxies)
     * and `dense` whether it stands in a wood.
     * They are the ones the chunks there have, placed by the same rule from
     * the same cells; what the rule is told about each spot comes from the
     * lattice of the farGrid() call just before (the nearest point's biome and
     * slope, the height between points), so now and then one differs.
     *
     * @param {number} thin  keep one plant in this many (see StructurePlacer.farScan)
     * @param {(x, z) => boolean} [skip]  leave out what is rooted here
     */
    farFeatures(x0, z0, size, emit, thin = 1, skip = null) {
        const L = this._farLattice;
        if (!L) return;
        const { O, step, m } = L;
        const col = this._farCol ??= { top: 0, water: 0, biome: 0, slope: 0, flags: 0, topBlock: 0, y: 0 };
        const at = (x, z) => {
            const fi = Math.min(Math.max((x - L.x0) / step, 0), m - 1), fj = Math.min(Math.max((z - L.z0) / step, 0), m - 1);
            const o = Math.round(fi) * m + Math.round(fj);
            col.top = O.top[o]; col.water = O.water[o]; col.biome = O.biome[o];
            col.slope = O.slope[o]; col.flags = O.flags[o];
            col.topBlock = this._cover(x, z, col.water, col.biome, col.slope, O.temp[o], col.flags);
            // The ground between the lattice's points.
            const i0 = Math.min(Math.floor(fi), m - 2), j0 = Math.min(Math.floor(fj), m - 2);
            const u = fi - i0, v = fj - j0, a = i0 * m + j0;
            col.y = (O.top[a] * (1 - u) + O.top[a + m] * u) * (1 - v) + (O.top[a + 1] * (1 - u) + O.top[a + m + 1] * u) * v + 1;
            return col;
        };
        this.placer.farScan(x0, z0, size, at, (x, z, c, proxy, h, dense) => {
            if (skip && skip(x, z)) return;
            emit(x, c.y, z, proxy, h, dense);
        }, thin);
    }

    /** The colour far terrain gives block `id`, into out.r/g/b (× k). */
    farColor(id, out, k = 1) { this._farRgb(id, out, k); return out; }

    _farPoint(x, z, top, water, biome, slope, temp, flags, wantColor, out, canopy = true) {
        const wet = water !== NO_WATER;
        out.h = (wet ? water : top) + 1;
        if (!wantColor && !wet) {
            // The canopy raises the surface, colour or not, so neighbouring
            // tiles agree on the heights their normals are taken from.
            if (!canopy) return out;
            const id = this._cover(x, z, water, biome, slope, temp, flags);
            const cp = this.placer.canopy[biome];
            if (cp.cover > 0.02 && !this._cv.steep && this.placer.soil.has(id)) out.h += cp.height * cp.cover * 0.75;
            return out;
        }
        if (!wantColor) return out;
        if (wet) {
            if (this._freezes(x, z, top, water, temp)) { this._farRgb(this.ids.ice, out); return out; }
            // The chunks draw water at 0.72 opacity over a bed the sky still
            // lights however deep it is, so that is the mix here too.
            const bed = this._cover(x, z, water, biome, slope, temp, flags);
            this._farRgb(bed, out);
            const br = out.r, bg = out.g, bb = out.b;
            this._farRgb(this.ids.water, out);
            out.r = br + (out.r - br) * FAR_WATER_ALPHA;
            out.g = bg + (out.g - bg) * FAR_WATER_ALPHA;
            out.b = bb + (out.b - bb) * FAR_WATER_ALPHA;
            return out;
        }
        const id = this._cover(x, z, water, biome, slope, temp, flags);
        this._farRgb(id, out);
        const cp = this.placer.canopy[biome];
        if (canopy && cp.cover > 0.02 && !this._cv.steep && this.placer.soil.has(id)) {
            // Tree cover: the crowns' colour over the ground's, and the crowns'
            // height spread over the ground they shade.
            let lr = 0, lg = 0, lb = 0, w = 0;
            for (const [leaf, share] of cp.leaves) {
                const r = out.r, g = out.g, b = out.b;
                this._farRgb(leaf, out);
                lr += out.r * share; lg += out.g * share; lb += out.b * share; w += share;
                out.r = r; out.g = g; out.b = b;
            }
            const f = cp.cover * 0.85;
            out.r += (lr / w - out.r) * f; out.g += (lg / w - out.g) * f; out.b += (lb / w - out.b) * f;
            out.h += cp.height * cp.cover * 0.75;
        }
        return out;
    }

    // ── Rock and ore ─────────────────────────────────────────────────────────

    /**
     * Blobs of granite, diorite, andesite, dirt and gravel in the stone. The
     * blobs of the eight neighbouring chunks are placed too where they reach
     * in, so a blob is whole even when it straddles a seam.
     */
    _placeBlobs(vox, cx, cz) {
        const hosts = this.blobHosts;
        const ox = cx * N, oz = cz * N;
        for (let bi = 0; bi < this.blobs.length; bi++) {
            const B = this.blobs[bi];
            const lo = Math.max(B.minY, WORLD_MIN_Y + 3), hi = Math.min(B.maxY, WORLD_MAX_Y);
            if (hi < lo) continue;
            const span = hi - lo + 1;
            const attempts = Math.ceil(B.frequency * N * N * span);
            for (let dcx = -1; dcx <= 1; dcx++) for (let dcz = -1; dcz <= 1; dcz++) {
                const bx = cx + dcx, bz = cz + dcz;
                for (let a = 0; a < attempts; a++) {
                    const h = hashSeed(this.seed, bx * 7919 + a, bz * 5237 + bi, 0xb10b);
                    const h2 = hashSeed(h, 3);
                    const r = B.r0 + (h2 & 0xffff) / 0x10000 * (B.r1 - B.r0);
                    const x = bx * N + (h & 15), z = bz * N + ((h >>> 4) & 15);
                    if (x + r < ox || x - r >= ox + N || z + r < oz || z - r >= oz + N) continue;
                    const y = lo + ((h >>> 8) % span);
                    const ry = r * (0.7 + ((h2 >>> 16) & 0xff) / 255 * 0.5);
                    const x0 = Math.max(ox, Math.floor(x - r)), x1 = Math.min(ox + N - 1, Math.ceil(x + r));
                    const z0 = Math.max(oz, Math.floor(z - r)), z1 = Math.min(oz + N - 1, Math.ceil(z + r));
                    const y0 = Math.max(WORLD_MIN_Y, Math.floor(y - ry)), y1 = Math.min(WORLD_MAX_Y, Math.ceil(y + ry));
                    for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
                        const qxz = ((wx - x) / r) ** 2 + ((wz - z) / r) ** 2;
                        if (qxz > 1) continue;
                        const base = (wx - ox) + (wz - oz) * SZ;
                        for (let wy = y0; wy <= y1; wy++) {
                            // A ragged edge rather than a clean ellipsoid: a
                            // cheap per-block hash eats into the outer third.
                            const rag = (((wx * 73856093) ^ (wy * 19349663) ^ (wz * 83492791)) >>> 0 & 255) / 255;
                            if (qxz + ((wy - y) / ry) ** 2 > 1 - 0.38 * rag) continue;
                            const i = base + (wy - WORLD_MIN_Y) * N;
                            if (hosts[vox[i]]) vox[i] = B.id;
                        }
                    }
                }
            }
        }
    }

    _placeOres(vox, cx, cz, cols) {
        // The chunk's commonest land biome adds its own ores to the world's.
        const count = this._count ??= new Uint16Array(256);
        count.fill(0);
        let dom = cols.biome[0];
        for (let c = 0; c < N * N; c++) {
            const b = cols.biome[c];
            if (++count[b] > count[dom]) dom = b;
        }
        this._veins(vox, cx, cz, cols, this.ores, 0);
        if (this.biomeOres[dom].length) this._veins(vox, cx, cz, cols, this.biomeOres[dom], 1);
    }

    /** Random-walk veins, as the old generator placed them, in host rock only. */
    _veins(vox, cx, cz, cols, ores, salt) {
        const hosts = this.oreHosts;
        for (const ore of ores) {
            if (!ore.id || ore.frequency <= 0) continue;
            const loW = Math.max(ore.minY, WORLD_MIN_Y), hiW = Math.min(ore.maxY, WORLD_MAX_Y);
            if (hiW < loW) continue;
            const span = hiW - loW + 1;
            const attempts = Math.ceil(ore.frequency * N * N * span);
            for (let a = 0; a < attempts; a++) {
                const rng = hashSeed(this.seed, cx * 7919 + a, cz * 5237 + ore.id + salt * 131, 6271);
                let x = rng & 0x0F, z = (rng >> 4) & 0x0F;
                const wy0 = loW + (((rng >> 8) & 0xFFFFF) % span);
                if (wy0 > cols.top[x * N + z] - 4) continue;
                let y = wy0 - WORLD_MIN_Y;
                const size = ore.minSize + (hashSeed(rng, a) % (ore.maxSize - ore.minSize + 1));
                for (let i = 0; i < size; i++) {
                    if (x >= 0 && x < N && z >= 0 && z < N && y >= 0 && y < CHUNK_SIZE_Y &&
                        WORLD_MIN_Y + y <= cols.top[x * N + z] - 4) {
                        const idx = x + y * N + z * SZ;
                        if (hosts[vox[idx]]) vox[idx] = ore.id;
                    }
                    const step = hashSeed(rng, i, ore.id) % 6;
                    x += VEIN_DX[step]; y += VEIN_DY[step]; z += VEIN_DZ[step];
                }
            }
        }
    }
}
