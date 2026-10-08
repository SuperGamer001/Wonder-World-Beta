/**
 * Geography — the shape of the land, from world-wide fields.
 *
 * Every value here is a pure function of world (x, z) and the seed: continents,
 * erosion, mountain belts, hills, plateaus, rivers, fjords, lakes and the
 * climate. Nothing depends on which chunk asked, so terrain is continuous
 * across chunk borders by construction — a river or a mountain range simply
 * carries on into the next chunk because the field it comes from does.
 *
 * Biomes play no part in the height. They are chosen afterwards from where a
 * column ended up (Biomes.js), which is what lets one mountain range carry
 * forest, taiga and snow at different heights.
 *
 * Three passes per column:
 *
 *   A  raw fields (_raw)        noise only — continents, erosion, climate,
 *                               mountains, hills, plateaus, islands, and the
 *                               river / fjord noise
 *   B  shaping (_shape)         needs A at the four neighbours, for gradients:
 *                               distance to the coastline, to a river's centre
 *                               line and to a fjord's, in blocks. Coastal cliffs
 *                               and beaches, swamps, fjords and rivers.
 *   C  lakes (_applyLakes)      lakes are placed per cell (Poisson-like), each
 *                               with one flat water level taken from the land
 *                               around it, so they can sit well above the sea
 *
 * region() runs all three over a chunk plus a ring (for slopes) and picks the
 * biomes; column() is the same for one column (structures, spawn, weather)
 * and is bit-for-bit the same as the chunk's value there.
 *
 * Scales, roughly: continents ~5000 blocks, climate zones ~2500, mountain belts
 * ~400 wide and thousands long, rivers every ~1000, hills ~300.
 */

import { Simplex, hashSeed } from './noise.js';
import { FLAT_TOP } from '../engine/FlatWorld.js';

export const SEA_LEVEL = 64;
const SEA = SEA_LEVEL;

// Temperature lost per block above LAPSE_START: snow on high ground, and taiga
// above forest on the same mountain. Climate.js uses the same numbers.
// Ordinary land sits at 70–120, so cooling starts above that; with these the
// snow line is near y 190 in a temperate climate and y 150 in a cool one.
export const LAPSE_START = 96;
export const LAPSE_RATE  = 0.0038;

const MAX_HEIGHT = 292;   // leaves room for trees under the 319 world top
const PEAK_SOFT  = 240;   // above this, heights are eased toward MAX_HEIGHT
const MIN_HEIGHT = -110;

// ── Helpers ────────────────────────────────────────────────────────────────

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
/** Smoothstep from e0 to e1; e0 > e1 gives a falling step. */
function smooth(e0, e1, x) {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}

/** Monotone cubic (Fritsch–Carlson): never overshoots, so no false terraces. */
class Spline {
    constructor(xs, ys) {
        const n = xs.length;
        this.x = Float64Array.from(xs);
        this.y = Float64Array.from(ys);
        const d = new Float64Array(n - 1), m = new Float64Array(n);
        for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
        m[0] = d[0]; m[n - 1] = d[n - 2];
        for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
            const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
            if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
        }
        this.m = m;
    }
    at(v) {
        const x = this.x, n = x.length;
        if (v <= x[0]) return this.y[0];
        if (v >= x[n - 1]) return this.y[n - 1];
        let i = 0;
        while (v > x[i + 1]) i++;
        const h = x[i + 1] - x[i], t = (v - x[i]) / h, t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * this.y[i] + (t3 - 2 * t2 + t) * h * this.m[i] +
               (-2 * t3 + 3 * t2) * this.y[i + 1] + (t3 - t2) * h * this.m[i + 1];
    }
}

// Continentalness → height of the bare continent (before hills and mountains).
// The coastline is continentalness 0.
const CONTINENT = new Spline(
    [-1.0, -0.55, -0.32, -0.16, -0.07, -0.02,  0.02, 0.10, 0.25, 0.45, 1.0],
    [  14,    24,    36,    48,    55,  61.5,  65.2,   68,   73,   80,  90],
);
const CONT_BIAS = 0.07;   // shifts the land/sea balance (land ≈ 60%)

// ── Lakes ──────────────────────────────────────────────────────────────────
// Each kind is scattered one per cell at most, its centre kept far enough in
// from the cell edge that two of a kind never touch. A smaller lake is dropped
// where a bigger one is; the rest is decided by the land around it.
const LAKE_KINDS = [
    { cell: 1408, chance: 0.30, r: [52, 104], depth: [8, 16] },   // large lakes
    { cell: 416,  chance: 0.34, r: [13, 30],  depth: [4, 8]  },   // lakes
    { cell: 144,  chance: 0.26, r: [4, 8],    depth: [2, 3]  },   // ponds
];
const LAKE_BANK = 3;        // blocks of shore held at the water level around a lake
const LAKE_SLOPE = 24;      // … and how far beyond that the ground slopes back to the land
const LAKE_RISE = 0.8;      // … at this rise per block, so a lake sits in a basin, not a pit
const LAKE_WOBBLE = 1.32;   // largest shoreline radius, as a multiple of r
const lakeReach = (r) => r * LAKE_WOBBLE + LAKE_BANK + LAKE_SLOPE + 1;
const LAKE_CACHE_MAX = 20000;
for (const k of LAKE_KINDS) k.reach = lakeReach(k.r[1]);

// Pass A output, one slot per grid point.
const A_KEYS = ['h', 'C', 'R', 'R2', 'F', 'T', 'H', 'e', 'K', 'ch', 'FL', 'rw', 'sw', 'pl', 'dry', 'isl', 'wd', 'mic'];
// Pass B/C output over the chunk plus its ring.
const B_KEYS = ['h', 'dC', 'rT', 'rs', 'fj'];

/** Does ring point j of region R hold water? */
const wet = (R, j) => R.wl[j] !== NO_WATER && Math.floor(R.B.h[j]) < R.wl[j];
/** The top block of ring point j if it holds water, else DRY. */
const DRY = 32767;
const wetTop = (R, j) => wet(R, j) ? Math.floor(R.B.h[j]) : DRY;

function makeGrid(keys, n) {
    const g = {};
    for (const k of keys) g[k] = new Float64Array(n);
    return g;
}

/** Scratch for one region() size. */
class RegionBuffers {
    constructor(w) {
        this.w = w;
        const nA = (w + 4) * (w + 4), nB = (w + 2) * (w + 2), n = w * w;
        this.A = makeGrid(A_KEYS, nA);
        this.B = makeGrid(B_KEYS, nB);
        // Which ring points anything reads. Pass B is only read at the columns
        // and their side neighbours (slopes, wet neighbours), never at the
        // ring's corners, and pass A only where some needed B point takes a
        // gradient. For one column that is 13 raw points instead of 25.
        const wa = w + 4, wb = w + 2;
        this.needB = new Uint8Array(nB);
        this.needA = new Uint8Array(nA);
        for (let ix = 0; ix < wb; ix++) for (let iz = 0; iz < wb; iz++) {
            const inX = ix >= 1 && ix <= w, inZ = iz >= 1 && iz <= w;
            if (!(inX || inZ)) continue;
            this.needB[ix * wb + iz] = 1;
            const a = (ix + 1) * wa + (iz + 1);
            this.needA[a] = this.needA[a + 1] = this.needA[a - 1] = this.needA[a + wa] = this.needA[a - wa] = 1;
        }
        this.wl    = new Int16Array(nB);      // water level, or NO_WATER
        this.lake  = new Uint8Array(nB);      // 1 inside a lake, 3 its shore, 2 its basin side
        // Per column of the inner w×w, index lx * w + lz.
        this.out = {
            top:    new Int16Array(n),        // Y of the top solid block
            water:  new Int16Array(n),        // Y of the water surface, or NO_WATER
            // Lowest top block among the side neighbours that hold water (DRY if
            // none): opening this column above it would show that water's side.
            wetFloor: new Int16Array(n),
            biome:  new Uint8Array(n),
            slope:  new Float32Array(n),
            temp:   new Float32Array(n),      // after altitude cooling (at the surface)
            humid:  new Float32Array(n),
            flags:  new Uint8Array(n),        // COL_* bits
            river:  new Float32Array(n),      // distance from a river's centre, in widths
            dry:    new Float32Array(n),
            plateau: new Float32Array(n),
        };
    }
}

export const NO_WATER = -32768;
export { DRY as NO_WET_NEIGHBOUR };
export const COL_LAKE     = 1;    // water here is a lake above the sea
export const COL_RIVER    = 2;    // in a river channel or on its banks
export const COL_NEAR_WET = 4;    // a side neighbour holds water
export const COL_ISLAND   = 8;
export const COL_COAST    = 16;   // within reach of the sea shore
export const COL_SHORE    = 32;   // the flat shore ring right around a lake

// Field seeds: one independent noise per field.
const FIELDS = [
    'warpX', 'warpZ', 'cont', 'inland', 'ero', 'range', 'peak', 'iso', 'hill', 'local',
    'micro', 'high', 'plat', 'mesa', 'dune', 'arch', 'isl', 'temp', 'humi', 'cwarpX',
    'cwarpZ', 'river', 'rwarpX', 'rwarpZ', 'rwidth', 'fjord', 'cliff', 'cliffH', 'weird',
    'jitter', 'lake', 'coastUp', 'creek',
];

export class Geography {
    /**
     * @param {number}   seed
     * @param {BiomeSet} biomes  used by region() / column() to pick biomes
     * @param {object}   [flat]  a Flat world's settings (engine/FlatWorld.js,
     *        normaliseFlat): no land is shaped at all — see _flatRegion
     */
    constructor(seed, biomes, flat = null) {
        this.seed = seed | 0;
        this.biomes = biomes;
        // Flat worlds: the one height, and the one biome if the world has one
        // (-1: biomes by climate, as in a normal world).
        this.flat = null;
        if (flat) {
            let biome = -1;
            if (flat.mode === 'layers') {
                const b = biomes.byName.get(flat.biome) ?? biomes.byName.get('PLAINS') ?? biomes.byCategory.land[0];
                biome = biomes.list.indexOf(b);
            }
            this.flat = { top: FLAT_TOP, biome };
        }
        this.n = {};
        FIELDS.forEach((name, i) => { this.n[name] = new Simplex(hashSeed(this.seed, 0x5eed, i + 1)); });
        this._bufs = new Map();
        this._lakeCache = new Map();
        this._pt = makeGrid(A_KEYS, 5);        // _preLake scratch: a point and its 4 neighbours
        this._ptB = makeGrid(B_KEYS, 1);
        this._lakesNear = [];
        this._sel = { temperature: 0, humidity: 0, elevation: 0, slope: 0, plateau: 0, weirdness: 0, island: 0 };
    }

    // ── Pass A: raw fields ───────────────────────────────────────────────────

    /**
     * Temperature and humidity at (x, z), into this._T and this._H. Climate
     * has its own warp, so zones do not simply follow the coasts, and
     * humidity leans against temperature a little: hot country is drier.
     * 3-octave fbm spreads about ±0.29, so both span roughly 0.05–0.95 with
     * the extremes (deserts, ice) the rarer.
     */
    _climate(x, z) {
        const n = this.n;
        const cx = x + 380 * n.cwarpX.fbm2(x, z, 2, 1 / 1600);
        const cz = z + 380 * n.cwarpZ.fbm2(x, z, 2, 1 / 1600);
        const T = clamp01(0.5 + 0.8 * n.temp.fbm2(cx, cz, 3, 1 / 5200));
        this._T = T;
        this._H = clamp01(0.5 + 0.8 * n.humi.fbm2(cx, cz, 3, 1 / 4400) - 0.3 * (T - 0.5));
    }

    _raw(x, z, A, i) {
        const n = this.n;

        // Large domain warp: bends coasts and mountain belts into bays,
        // peninsulas and arcs rather than noise blobs.
        const wx = x + 650 * n.warpX.fbm2(x, z, 2, 1 / 2800);
        const wz = z + 650 * n.warpZ.fbm2(x, z, 2, 1 / 2800);

        // Continentalness: < 0 sea, > 0 land.
        let C = n.cont.fbm2(wx, wz, 5, 1 / 5200) * 1.35 + CONT_BIAS;
        // Rare inland seas, deep inside continents.
        const inl = smooth(0.30, 0.44, n.inland.fbm2(x, z, 2, 1 / 3400));
        if (inl > 0) C -= inl * 0.62 * smooth(0.04, 0.32, C);
        const land = smooth(-0.02, 0.24, C);

        // Erosion: 0 rugged … 1 worn flat. Decides where mountains may rise and
        // how hilly, how wide river valleys are.
        const e = smooth(-0.3, 0.3, n.ero.fbm2(x, z, 3, 1 / 2400));

        this._climate(x, z);
        const T = this._T, H = this._H;

        // Mountain belts: long ranges along the zero lines of a warped noise,
        // only where erosion is low and well inland.
        const rn = n.range.fbm2(wx, wz, 3, 1 / 3200);
        const belt = smooth(0.075, 0.012, Math.abs(rn));
        const inland = smooth(0.03, 0.2, C);
        const mBelt = belt * smooth(0.56, 0.2, e) * inland;
        // Lone mountains and massifs away from the belts.
        const iso = smooth(0.28, 0.52, n.iso.fbm2(x, z, 2, 1 / 1100)) * smooth(0.75, 0.35, e) * inland * (1 - belt);
        const mtn = mBelt > iso ? mBelt : iso;
        let hm = 0;
        if (mtn > 0.001) {
            // A broad massif carrying ridges and the valleys between them. The
            // ridges are kept to slopes the terrain can draw: past a rise of
            // about 1.5 per block, smooth terrain breaks up into spikes, so
            // cliffs are left to the places meant to have them.
            const pk = n.peak.ridged2(x, z, 4, 1 / 640, 0.45, 2.1);
            hm = Math.pow(mtn, 1.3) * (40 + 118 * Math.pow(pk, 1.5) * (0.55 + 0.45 * mtn));
        }

        // Hills and smaller detail. Each octave adds its own slope, and the
        // total has to stay drawable (see the ridges above), so the fine
        // octaves are kept low: rolling ground, not rubble.
        const hillN = n.hill.fbm2(x, z, 3, 1 / 700, 0.45);
        const hills = hillN * (14 + 42 * (1 - e));
        const localN = n.local.fbm2(x, z, 2, 1 / 170);
        const local = localN * (3 + 7 * (1 - e));
        const micro = n.micro.fbm2(x, z, 2, 1 / 30) * 0.65;
        const high  = smooth(-0.05, 0.3, n.high.fbm2(x, z, 3, 1 / 3400)) * (22 + 30 * (1 - e));

        // Plateaus and mesas: flat-topped tiers with cliff sides, commoner in
        // dry climates (where the biomes make them badlands). Never on a
        // mountain, which the tiers would ring with a cliff.
        const dry = smooth(0.58, 0.74, T) * smooth(0.42, 0.26, H);
        const pl = smooth(0.36 - 0.2 * dry, 0.5 - 0.2 * dry, n.plat.fbm2(x, z, 2, 1 / 2100)) * land * (1 - mtn);
        let mesa = 0;
        if (pl > 0.001) {
            // Full height once the plateau region is established, so mesas
            // stand tall instead of dwindling with the region's edge.
            const m = n.mesa.fbm2(x, z, 3, 1 / 320) + 0.02 * micro;
            mesa = smooth(0.06, 0.45, pl) * (8 + 20 * smooth(-0.025, 0.0, m) + 18 * smooth(0.15, 0.175, m) + 14 * smooth(0.3, 0.325, m));
        }

        // Dunes: crescent ridges across the wind in sandy deserts.
        const desert = smooth(0.66, 0.78, T) * smooth(0.34, 0.22, H) * land * (1 - pl) * (1 - mtn);
        let dune = 0;
        if (desert > 0.001) {
            const d = 1 - Math.abs(n.dune.noise2((x * 0.8 + z * 0.6) / 52, (z * 0.8 - x * 0.6) / 150));
            dune = desert * 9 * d * d;
        }

        // Cold rugged coasts: high ground right to the sea, cut by fjords.
        const FL = smooth(0.36, 0.22, T) * smooth(0.62, 0.3, e);
        const coastUp = FL > 0.001 ? FL * smooth(-0.02, 0.1, C) * (26 + 22 * (0.5 + n.coastUp.fbm2(x, z, 2, 1 / 500))) : 0;

        let h = CONTINENT.at(C) + land * (high + hills + hm + mesa) + coastUp +
                local * (0.35 + 0.65 * land) + micro * 1.4 + dune;

        // Islands and archipelagos in some stretches of sea.
        let isl = 0;
        if (C < 0.06) {
            const arch = smooth(0.16, 0.38, n.arch.fbm2(x, z, 2, 1 / 2600));
            if (arch > 0) {
                const hi = SEA - 22 + n.isl.fbm2(x, z, 3, 1 / 460) * 190 * arch;
                const w = arch * smooth(0.06, -0.12, C);
                if (hi > h) h += (hi - h) * w;
                isl = w * smooth(SEA - 2, SEA + 3, hi);
            }
        }

        A.h[i]   = h;
        A.C[i]   = C;
        A.T[i]   = T;
        A.H[i]   = H;
        A.e[i]   = e;
        A.FL[i]  = FL;
        A.sw[i]  = smooth(0.62, 0.74, H) * smooth(0.46, 0.58, T);
        A.pl[i]  = pl;
        A.dry[i] = dry;
        A.isl[i] = isl;
        A.mic[i] = 0.65 * localN + 0.35 * micro;    // swamp hummocks
        A.wd[i]  = n.weird.fbm2(x, z, 2, 1 / 1900) * 2.5;
        // Cliffs: some coasts rise sheer from the water; fjord coasts always.
        const K = smooth(0.12, 0.34, n.cliff.fbm2(x, z, 2, 1 / 1500)) * (0.45 + 0.55 * (1 - e));
        A.K[i]   = K > FL ? K : FL;
        A.ch[i]  = 7 + 17 * clamp01(0.5 + 1.6 * n.cliffH.fbm2(x, z, 2, 1 / 900));

        // Rivers run along the zero lines of one noise, creeks along a finer
        // one, fjords along a third.
        const rwx = x + 200 * n.rwarpX.fbm2(x, z, 2, 1 / 800);
        const rwz = z + 200 * n.rwarpZ.fbm2(x, z, 2, 1 / 800);
        A.R[i]  = n.river.fbm2(rwx, rwz, 2, 1 / 2000);
        A.R2[i] = n.creek.fbm2(rwx, rwz, 2, 1 / 950);
        A.rw[i] = clamp01(0.5 + 1.8 * n.rwidth.fbm2(x, z, 2, 1 / 1500));
        // Only sampled in cold country; anywhere its gradient could be needed
        // (next to a column with FL > 0) is colder than this.
        A.F[i]  = T < 0.42 ? n.fjord.fbm2(wx, wz, 3, 1 / 1200) : 1;
    }

    // ── Pass B: shaping that needs distances ───────────────────────────────

    /**
     * Coast, swamp, fjord and river shaping for the point at A index c, whose
     * side neighbours are xp, xm, zp, zm. Writes B at index j. `g` turns a
     * difference across the neighbours into a gradient per block: 0.5 when they
     * are one block away, 0.5 / step on a coarse lattice (region's step).
     */
    _shape(A, c, xp, xm, zp, zm, B, j, g = 0.5) {
        let h = A.h[c];
        const C = A.C[c];

        // Distance to the coastline in blocks (positive inland): the
        // continentalness over its gradient.
        const gCx = (A.C[xp] - A.C[xm]) * g, gCz = (A.C[zp] - A.C[zm]) * g;
        const dC = C / (Math.sqrt(gCx * gCx + gCz * gCz) + 1e-9);

        if (dC > -90 && dC < 90) {
            const K = A.K[c];
            if (K > 0.001) {
                if (dC >= 0) {
                    // Sheer rise within a few blocks of the water line, easing
                    // back into the land further in.
                    const top = SEA + A.ch[c] * smooth(-0.5, 4.5, dC);
                    const w = K * smooth(80, 35, dC);
                    if (top > h) h += (top - h) * w;
                } else {
                    // … and deep water at its foot.
                    const foot = SEA - 3 - 9 * smooth(0, -10, dC);
                    const w = K * smooth(-60, -20, dC);
                    if (foot < h) h += (foot - h) * w;
                }
            }
            // Gentle coasts are drawn toward a shallow ramp: wide beaches and a
            // sandy shelf.
            const bw = (1 - K) * smooth(40, 12, Math.abs(dC - 4)) * (1 - A.isl[c]);
            if (bw > 0.001) h += (SEA + 0.35 + 0.09 * dC - h) * bw * 0.85;
        }

        // Swamps: warm, wet lowland pulled to the water line — land and shallow
        // pools in a patchwork.
        const sw = A.sw[c];
        if (sw > 0.001 && h > 54 && h < 80 && C > 0) {
            const w = sw * smooth(80, 68, h) * smooth(54, 60, h) * smooth(0, 0.05, C);
            h += (SEA + 0.25 + 1.8 * A.mic[c] - h) * w * 0.9;
        }

        // Fjords: U-shaped sea inlets cut into cold, rugged coasts, fading
        // into dry glacial valleys inland.
        let fj = 0;
        const FL = A.FL[c];
        if (FL > 0.001) {
            const gx = (A.F[xp] - A.F[xm]) * g, gz = (A.F[zp] - A.F[zm]) * g;
            const dF = Math.abs(A.F[c]) / (Math.sqrt(gx * gx + gz * gz) + 1e-9);
            const W = 7 + 7 * A.rw[c];
            const t = dF / W;
            if (t < 2.4) {
                const bed = SEA - 24 - 8 * A.rw[c];
                const hf = bed + (h - bed) * smooth(0.45, 2.4, t);
                const w = FL * smooth(420, 140, dC) * smooth(-160, -60, dC);
                if (hf < h) { h += (hf - h) * w; fj = w * smooth(2.4, 0.9, t); }
            }
        }

        // Rivers: a channel below the sea level with banks and a valley whose
        // width follows the land (broad in worn lowland, a gorge in rugged
        // ground, a canyon in dry plateau country). All rivers run at sea
        // level, so they meet the sea and each other; on high ground the
        // valley stays but runs dry, which is where a river rises.
        //
        // Two networks: rivers, and a finer one of creeks that only runs in
        // lower, wetter country. Both sit at sea level, so where they cross
        // they join.
        let rT = 99, rs = 0;
        {
            const e = A.e[c];
            const canyon = A.pl[c] * A.dry[c];
            const humid = smooth(0.12, 0.38, A.H[c]);
            let high = smooth(158, 108, h);
            if (canyon > high) high = canyon;
            for (let net = 0; net < 2; net++) {
                const F = net === 0 ? A.R : A.R2;
                const gx = (F[xp] - F[xm]) * g, gz = (F[zp] - F[zm]) * g;
                const dR = Math.abs(F[c]) / (Math.sqrt(gx * gx + gz * gz) + 1e-9);
                const W = net === 0 ? 2.2 + 6.5 * A.rw[c] * (0.55 + 0.6 * e) : 1.1 + 1.6 * A.rw[c];
                let V = net === 0 ? W * (2.2 + 8 * e) + 5 : W * (2 + 5 * e) + 3;
                V += (W * 1.2 + 3 - V) * canyon;
                if (dR >= V) continue;
                const s = net === 0
                    ? high * (0.45 + 0.55 * humid)
                    : high * smooth(118, 90, h) * smooth(0.3, 0.55, A.H[c]);
                if (s <= 0) continue;
                const bed = net === 0 ? SEA - 1.6 - 0.42 * W : SEA - 1.1 - 0.4 * W;
                const t = dR / W;
                const hr = t < 1
                    ? bed + (SEA + 0.4 - bed) * t * t
                    : SEA + 0.4 + (h - SEA - 0.4) * smooth(W, V, dR);
                const carved = h + (hr - h) * s;
                if (carved < h) h = carved;
                if (t < rT) { rT = t; rs = s; }
            }
        }

        B.h[j] = h;
        B.dC[j] = dC;
        B.rT[j] = rT;
        B.rs[j] = rs;
        B.fj[j] = fj;
    }

    // ── Pass C: lakes ─────────────────────────────────────────────────────

    /** Height after passes A and B at one point (lake placement only). */
    _preLake(x, z) {
        const P = this._pt;
        this._raw(x, z, P, 0);
        this._raw(x + 1, z, P, 1);
        this._raw(x - 1, z, P, 2);
        this._raw(x, z + 1, P, 3);
        this._raw(x, z - 1, P, 4);
        this._shape(P, 0, 1, 2, 3, 4, this._ptB, 0);
        return this._ptB;
    }

    /** The lake of one kind in one cell, or null. Deterministic, cached. */
    _lake(k, gx, gz) {
        const key = `${k},${gx},${gz}`;
        const hit = this._lakeCache.get(key);
        if (hit !== undefined) return hit;
        if (this._lakeCache.size > LAKE_CACHE_MAX) this._lakeCache.clear();
        const lake = this._resolveLake(k, gx, gz);
        this._lakeCache.set(key, lake);
        return lake;
    }

    _resolveLake(k, gx, gz) {
        const K = LAKE_KINDS[k];
        const h1 = hashSeed(this.seed, gx, gz, 0x1a4e + k);
        if ((h1 & 0xffff) / 0x10000 >= K.chance) return null;
        const h2 = hashSeed(h1, gx, gz, 7);
        const margin = K.reach;
        const span = K.cell - 2 * margin;
        const x = gx * K.cell + margin + ((h1 >>> 16) / 0x10000) * span;
        const z = gz * K.cell + margin + ((h2 & 0xffff) / 0x10000) * span;
        const r = K.r[0] + ((h2 >>> 16) / 0x10000) * (K.r[1] - K.r[0]);
        const depth = K.depth[0] + (hashSeed(h2, 3) / 0x100000000) * (K.depth[1] - K.depth[0]);

        // A smaller lake whose reach meets a bigger one's is dropped, so no two
        // lakes ever shape the same column.
        const reach = lakeReach(r);
        for (let b = 0; b < k; b++) {
            const B = LAKE_KINDS[b];
            const bx = Math.floor(x / B.cell), bz = Math.floor(z / B.cell);
            for (let ix = bx - 1; ix <= bx + 1; ix++) for (let iz = bz - 1; iz <= bz + 1; iz++) {
                const o = this._lake(b, ix, iz);
                if (o && Math.hypot(o.x - x, o.z - z) < o.reach + reach) return null;
            }
        }

        // The land here decides whether a lake fits and where its water stands:
        // flat enough across, not in the sea or on a river, and the level just
        // under the lowest point of its rim so the rim holds it.
        const c = this._preLake(Math.round(x), Math.round(z));
        if (c.rT[0] < 3 || c.dC[0] < 40 || c.h[0] < SEA + 3) return null;
        const hc = c.h[0];
        let lo = Infinity, hi = -Infinity;
        const rr = r * 1.15;
        for (let a = 0; a < 8; a++) {
            const ang = a * Math.PI / 4 + (h1 & 7) * 0.1;
            const p = this._preLake(Math.round(x + Math.cos(ang) * rr), Math.round(z + Math.sin(ang) * rr));
            if (p.rT[0] < 1.5) return null;
            const v = p.h[0];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (hi - lo > 0.5 * r + 6) return null;
        const level = Math.floor(lo) - 1;
        if (level < SEA + 2) return null;
        // A centre far above the water would make the lake a pit in a hill.
        if (hc > level + 6 + 0.1 * r) return null;
        return {
            x, z, r, depth, level, reach,
            // Where this lake reads its shoreline wobble, so lakes differ.
            ox: ((h2 >>> 8) & 0xfff) * 1.37, oz: ((h1 >>> 4) & 0xfff) * 1.73,
        };
    }

    /** Lakes whose reach touches the box [x0, x1] × [z0, z1]. */
    _collectLakes(x0, z0, x1, z1) {
        const list = this._lakesNear;
        list.length = 0;
        for (let k = 0; k < LAKE_KINDS.length; k++) {
            const K = LAKE_KINDS[k];
            const gx0 = Math.floor((x0 - K.reach) / K.cell), gx1 = Math.floor((x1 + K.reach) / K.cell);
            const gz0 = Math.floor((z0 - K.reach) / K.cell), gz1 = Math.floor((z1 + K.reach) / K.cell);
            for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
                const L = this._lake(k, gx, gz);
                if (!L) continue;
                if (L.x + L.reach < x0 || L.x - L.reach > x1 || L.z + L.reach < z0 || L.z - L.reach > z1) continue;
                list.push(L);
            }
        }
        return list;
    }

    /**
     * Apply the lakes in `lakes` to the column at (x, z) whose height is h.
     * Returns the new height; sets this._lakeLevel (or NO_WATER) and
     * this._lakeState (0 none, 1 in the lake, 3 on its flat shore, 2 on the
     * basin side beyond).
     *
     * Inside the shore every column is at least one block under the level, and
     * the first LAKE_BANK blocks outside it are held at the level or above, so
     * the water is always enclosed — even where a river valley or a slope runs
     * past (it becomes a dam). Higher ground around is sloped down to that
     * shore, so the lake lies in a basin rather than at the foot of a wall.
     * The shore wobbles on noise scaled to the lake, gently enough that
     * neighbouring columns never jump past the bank.
     */
    _applyLakes(x, z, h, lakes) {
        this._lakeLevel = NO_WATER;
        this._lakeState = 0;
        for (let i = 0; i < lakes.length; i++) {
            const L = lakes[i];
            const dx = x - L.x, dz = z - L.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > L.reach * L.reach) continue;
            const s = 0.7 * L.r;
            const wob = 1 + 0.24 * this.n.lake.noise2(x / s + L.ox, z / s + L.oz) +
                            0.08 * this.n.lake.noise2(x / (0.3 * L.r) - L.oz, z / (0.3 * L.r) + L.ox);
            const re = L.r * wob;
            const d = Math.sqrt(d2);
            if (d < re) {
                const q = d / re;
                const bowl = L.level - 0.7 - L.depth * Math.pow(1 - q * q, 0.8);
                if (bowl < h) h = bowl;
                this._lakeLevel = L.level;
                this._lakeState = 1;
                return h;
            }
            const out = d - re;
            if (out < LAKE_BANK + LAKE_SLOPE) {
                // Held between a floor that keeps the water in and a ceiling
                // that slopes the land down to it: a flat shore right at the
                // water, then a basin side. The floor wins at the shore.
                const s = Math.max(0, out - LAKE_BANK);
                const floor = L.level + 0.6 - s * 0.6;
                const ceil = L.level + 0.6 + s * LAKE_RISE;
                if (h > ceil) h = ceil;
                if (h < floor) h = floor;
                if (this._lakeState === 0) this._lakeState = out < LAKE_BANK ? 3 : 2;
            }
        }
        return h;
    }

    // ── Regions and columns ────────────────────────────────────────────────

    _buffers(w) {
        let b = this._bufs.get(w);
        if (!b) { b = new RegionBuffers(w); this._bufs.set(w, b); }
        return b;
    }

    /**
     * Everything about the w×w columns whose lowest corner is (ox, oz).
     * The returned arrays are scratch, reused by the next call with the same w;
     * index lx * w + lz.
     *
     * `step` > 1 samples a coarse lattice instead, one column every `step`
     * blocks, for far terrain (FarTiles.js). Everything that needs a gradient —
     * the distances to coasts, rivers and fjords, and the slope — then takes it
     * across the lattice rather than across one block. The fields are far
     * smoother than that at every step far terrain uses, so the land comes out
     * the same shape; it is exact only at step 1, and a river narrower than the
     * step shows only where a sample happens to fall in it.
     */
    region(ox, oz, w = 16, step = 1) {
        if (this.flat) return this._flatRegion(ox, oz, w, step);
        const R = this._buffers(w);
        const A = R.A, B = R.B;
        const wa = w + 4, wb = w + 2;
        const g = 0.5 / step;

        // Pass A over the columns plus a ring of two.
        const needA = R.needA, needB = R.needB;
        for (let ix = 0; ix < wa; ix++) {
            const x = ox + (ix - 2) * step;
            for (let iz = 0; iz < wa; iz++) {
                const i = ix * wa + iz;
                if (needA[i]) this._raw(x, oz + (iz - 2) * step, A, i);
            }
        }

        // Pass B over the columns plus a ring of one.
        for (let ix = 0; ix < wb; ix++) {
            for (let iz = 0; iz < wb; iz++) {
                const j = ix * wb + iz;
                if (!needB[j]) continue;
                const c = (ix + 1) * wa + (iz + 1);
                this._shape(A, c, c + wa, c - wa, c + 1, c - 1, B, j, g);
            }
        }

        // Pass C: lakes, and where water stands.
        const lakes = this._collectLakes(ox - step, oz - step, ox + w * step, oz + w * step);
        for (let ix = 0; ix < wb; ix++) {
            for (let iz = 0; iz < wb; iz++) {
                const j = ix * wb + iz;
                if (!needB[j]) continue;
                let h = B.h[j];
                let wl = NO_WATER, state = 0;
                if (lakes.length) {
                    h = this._applyLakes(ox + (ix - 1) * step, oz + (iz - 1) * step, h, lakes);
                    wl = this._lakeLevel;
                    state = this._lakeState;
                }
                // The very highest peaks are squashed toward MAX_HEIGHT rather
                // than cut flat.
                if (h > PEAK_SOFT) h = PEAK_SOFT + (MAX_HEIGHT - PEAK_SOFT) * Math.tanh((h - PEAK_SOFT) / (MAX_HEIGHT - PEAK_SOFT));
                if (h < MIN_HEIGHT) h = MIN_HEIGHT;
                if (wl === NO_WATER && h < SEA) wl = SEA;
                B.h[j] = h;
                R.wl[j] = wl;
                R.lake[j] = state;
            }
        }

        this._finish(R, ox, oz, step, g);
        return R.out;
    }

    /**
     * region() in a Flat world: every column level at the same height, dry,
     * with no slope, river or coast. Only the climate is left of the
     * geography — the same fields, so a seed keeps its hot and cold country —
     * and it picks the biome (land biomes only, their borders wound as in
     * _finish) unless the world has one biome throughout.
     */
    _flatRegion(ox, oz, w, step) {
        const O = this._buffers(w).out;
        const F = this.flat, sel = this._sel, jit = this.n.jitter;
        for (let lx = 0; lx < w; lx++) {
            for (let lz = 0; lz < w; lz++) {
                const x = ox + lx * step, z = oz + lz * step;
                const o = lx * w + lz;
                this._climate(x, z);
                const T = this._T, H = this._H;
                let biome = F.biome;
                if (biome < 0) {
                    const bx = x + 34 * jit.noise2(x / 120, z / 120) + 10 * jit.noise2(x / 37 + 31.7, z / 37 - 12.2);
                    const bz = z + 34 * jit.noise2(x / 120 + 77.1, z / 120 - 4.4) + 10 * jit.noise2(x / 37 - 50.3, z / 37 + 8.8);
                    this._climate(bx, bz);
                    sel.temperature = this._T;
                    sel.humidity    = this._H;
                    sel.elevation   = F.top;
                    sel.slope       = 0;
                    sel.plateau     = 0.1 * jit.noise2(x / 46 - 9.9, z / 46 + 3.3);
                    sel.weirdness   = 0;
                    sel.island      = 0;
                    biome = this.biomes.select('land', sel);
                }
                O.top[o]      = F.top;
                O.water[o]    = NO_WATER;
                O.wetFloor[o] = DRY;
                O.biome[o]    = biome;
                O.slope[o]    = 0;
                O.temp[o]     = T;
                O.humid[o]    = H;
                O.flags[o]    = 0;
                O.river[o]    = 99;
                O.dry[o]      = 0;
                O.plateau[o]  = 0;
            }
        }
        return O;
    }

    /** Per-column results and biomes for the inner w×w. */
    _finish(R, ox, oz, step, g) {
        const w = R.w, wa = w + 4, wb = w + 2;
        const A = R.A, B = R.B, O = R.out;
        const sel = this._sel;
        for (let lx = 0; lx < w; lx++) {
            for (let lz = 0; lz < w; lz++) {
                const x = ox + lx * step, z = oz + lz * step;
                const j = (lx + 1) * wb + (lz + 1);
                const a = (lx + 2) * wa + (lz + 2);
                const o = lx * w + lz;
                const h = B.h[j];
                const top = Math.floor(h);
                const wl = R.wl[j];
                const water = wl !== NO_WATER && top < wl ? wl : NO_WATER;

                const gx = (B.h[j + wb] - B.h[j - wb]) * g, gz = (B.h[j + 1] - B.h[j - 1]) * g;
                const slope = Math.sqrt(gx * gx + gz * gz);

                let flags = 0;
                if (R.lake[j] === 1) flags |= COL_LAKE;
                if (R.lake[j] === 3) flags |= COL_SHORE;
                const rT = B.rT[j], rs = B.rs[j];
                const C = A.C[a];
                if (rT < 1.35 && rs > 0.4 && C > -0.04) flags |= COL_RIVER;
                if (A.isl[a] > 0.2) flags |= COL_ISLAND;
                const dC = B.dC[j];
                if ((dC > -12 && dC < 28) || A.isl[a] > 0.2) flags |= COL_COAST;
                const wf = Math.min(wetTop(R, j + wb), wetTop(R, j - wb), wetTop(R, j + 1), wetTop(R, j - 1));
                if (wf !== DRY) flags |= COL_NEAR_WET;
                O.wetFloor[o] = wf;

                const T = A.T[a];
                const tEff = T - (top > LAPSE_START ? (top - LAPSE_START) * LAPSE_RATE : 0);
                const jit = this.n.jitter;

                // Category from the geography; the biome within it from climate.
                let cat;
                if (R.lake[j] === 1) cat = 'land';
                else if (water !== NO_WATER) {
                    if (flags & COL_RIVER) cat = 'river';
                    else if (C < 0.03 || A.isl[a] > 0.05) cat = 'ocean';
                    else cat = 'land';
                } else if ((flags & COL_RIVER) && top <= SEA + 1) cat = 'river';
                else if ((flags & COL_COAST) && top <= SEA + 4 && (C < 0.2 || A.isl[a] > 0.2)) cat = 'beach';
                else cat = 'land';

                // Climate is so smooth that over a few hundred blocks it is
                // nearly linear, and a biome bounded by "hotter than a, drier
                // than b" came out as a polygon with straight sides. Reading
                // it a little way off — a warp at two scales — winds every
                // border. The terrain itself keeps the unwarped values.
                const bx = x + 34 * jit.noise2(x / 120, z / 120) + 10 * jit.noise2(x / 37 + 31.7, z / 37 - 12.2);
                const bz = z + 34 * jit.noise2(x / 120 + 77.1, z / 120 - 4.4) + 10 * jit.noise2(x / 37 - 50.3, z / 37 + 8.8);
                this._climate(bx, bz);
                sel.temperature = this._T - (tEff < T ? T - tEff : 0);
                sel.humidity    = this._H;
                sel.elevation   = top;
                sel.slope       = slope;
                sel.plateau     = A.pl[a] + 0.1 * jit.noise2(x / 46 - 9.9, z / 46 + 3.3);
                sel.weirdness   = A.wd[a];
                sel.island      = A.isl[a];

                O.top[o]   = top;
                O.water[o] = water;
                O.biome[o] = this.biomes.select(cat, sel);
                O.slope[o] = slope;
                O.temp[o]  = tEff;
                O.humid[o] = A.H[a];
                O.flags[o] = flags;
                O.river[o] = rT;
                O.dry[o]   = A.dry[a];
                O.plateau[o] = A.pl[a];
            }
        }
    }

    /**
     * One column, exactly as region() computes it for a chunk. Returns a
     * scratch object (valid until the next call): { top, water, biome, slope,
     * temp, humid, flags, river, dry, plateau }.
     */
    column(x, z) {
        const O = this.region(x, z, 1);
        const c = this._col ??= {};
        for (const k in O) c[k] = O[k][0];
        return c;
    }

    /**
     * A good place to start a world near (x, z): the nearest dry, fairly flat
     * land that is neither a peak nor a beach, searched in widening rings.
     * Returns { x, z }, or the start itself if none turns up within maxR.
     */
    findSpawn(x, z, maxR = 3072, step = 24) {
        if (this.flat) return { x, z };      // it is all dry, level land
        const ok = (px, pz) => {
            const c = this.column(px, pz);
            return c.water === NO_WATER && c.top > SEA + 1 && c.top < SEA + 60 && c.slope < 0.7 &&
                   this.biomes.list[c.biome].category === 'land';
        };
        if (ok(x, z)) return { x, z };
        for (let r = step; r <= maxR; r += step) {
            const n = Math.max(8, Math.round(2 * Math.PI * r / step));
            for (let k = 0; k < n; k++) {
                const a = (k / n) * Math.PI * 2;
                const px = Math.round(x + Math.cos(a) * r), pz = Math.round(z + Math.sin(a) * r);
                if (ok(px, pz)) return { x: px, z: pz };
            }
        }
        return { x, z };
    }
}
