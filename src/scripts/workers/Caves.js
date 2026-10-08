/**
 * Caves — underground spaces at several scales.
 *
 *   tunnels   long winding caves: where two independent 3D noises are both
 *             near zero (two thin sheets cross in a line)
 *   noodles   the same at a smaller scale, thinner — tight side passages, in
 *             some regions only
 *   caverns   large chambers where a squashed 3D noise is high, only inside
 *             rare cavern regions, and never close under the surface
 *   valleys   underground valleys: long, tall galleries deep down, along the
 *             zero line of a 2D noise
 *   shafts    vertical pits from the surface, a few per square kilometre
 *   ravines   deep, narrow, V-shaped cuts open to the sky, in some regions
 *
 * Every field is a function of world position, so caves run on across chunk
 * borders like everything else.
 *
 * Cost. The 3D noises are sampled on a lattice every 4 blocks — world-aligned,
 * so neighbouring chunks share its points — and interpolated in between. They
 * are all smooth at that scale (wavelengths of 30–90 blocks), so this loses
 * almost nothing, and it replaces ~1 noise call per voxel with ~1 per 64.
 * Each column is then walked in 4-block segments; along a segment every field
 * is linear, so a segment that cannot carve (both ends of a tunnel sheet on the
 * same side, well away from zero, and so on) is skipped without touching its
 * voxels. Most of the underground is rejected that way.
 *
 * Nothing is carved above `cap` in a column: under water that keeps a floor
 * two blocks thick, and beside water it stays below the neighbouring water's
 * bed, so no cave ever opens next to standing water.
 */

import { Simplex, hashSeed } from './noise.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y } from '../engine/ChunkData.js';
import { NO_WATER, NO_WET_NEIGHBOUR } from './Geography.js';

const N = CHUNK_SIZE;                 // 16
const SZ = N * CHUNK_SIZE_Y;          // voxel stride along z
const LAT = 4;                        // lattice spacing, blocks
const NL = N / LAT + 1;               // lattice points per chunk axis (5)
export const CAVE_MIN_Y = WORLD_MIN_Y + 8;

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
function smooth(e0, e1, x) {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}
/** Smallest |v| on the segment from a to b (v is linear along it). */
const minAbs = (a, b) => (a < 0) !== (b < 0) ? 0 : Math.min(Math.abs(a), Math.abs(b));

const SHAFT_CELL = 72;
const SHAFT_MAX_R = 4;

export class CaveCarver {
    /**
     * @param {number} seed
     * @param {object} [density] multipliers from geology.json "caves":
     *        { tunnels, noodles, caverns, valleys, shafts, ravines } (1 = default, 0 = none)
     */
    constructor(seed, density = {}) {
        this.seed = seed | 0;
        const s = (k) => new Simplex(hashSeed(this.seed, 0xca7e5, k));
        this.nTA = s(1); this.nTB = s(2); this.nNA = s(3); this.nNB = s(4);
        this.nCav = s(5); this.nCav2 = s(6);
        this.nCavReg = s(7); this.nNoodleReg = s(8); this.nWidth = s(9);
        this.nValley = s(10); this.nValleyReg = s(11); this.nValleyY = s(12);
        this.nRavine = s(13); this.nRavineReg = s(14); this.nRavineW = s(15);
        this.nShaft = s(16);
        const d = density ?? {};
        const k = (v) => Math.max(0, Number.isFinite(+v) ? +v : 1);
        this.k = {
            tunnels: k(d.tunnels ?? 1), noodles: k(d.noodles ?? 1), caverns: k(d.caverns ?? 1),
            valleys: k(d.valleys ?? 1), shafts: k(d.shafts ?? 1), ravines: k(d.ravines ?? 1),
        };

        const maxLevels = Math.ceil(CHUNK_SIZE_Y / LAT) + 3;
        const n = NL * NL * maxLevels;
        this.fTA = new Float32Array(n);
        this.fTB = new Float32Array(n);
        this.fNA = new Float32Array(n);
        this.fNB = new Float32Array(n);
        this.fC  = new Float32Array(n);
        // Per lattice column (5×5): tunnel width, noodle and cavern region.
        this.lTW = new Float32Array(NL * NL);
        this.lNR = new Float32Array(NL * NL);
        this.lCR = new Float32Array(NL * NL);
        this.cap = new Int16Array(N * N);
        this.g = new Float64Array((N + 2) * (N + 2));   // a 2D field with a ring, for gradients
    }

    /**
     * Carve the chunk at (ox, oz). `cols` is Geography.region() output for it.
     * `ids`: { air, water, bedrock }.
     */
    carve(vox, ox, oz, cols, ids) {
        const cap = this.cap;
        let yHi = CAVE_MIN_Y - 1;
        for (let c = 0; c < N * N; c++) {
            const top = cols.top[c];
            let m = cols.water[c] !== NO_WATER ? top - 2 : top;
            const wf = cols.wetFloor[c];
            if (wf !== NO_WET_NEIGHBOUR && wf - 1 < m) m = wf - 1;
            cap[c] = m;
            if (m > yHi) yHi = m;
        }
        if (yHi < CAVE_MIN_Y) return;

        this._lattice(ox, oz, yHi);
        this._walk(vox, ox, oz, cols, ids);
        if (this.k.valleys > 0) this._valleys(vox, ox, oz, cols, ids);
        if (this.k.ravines > 0) this._ravines(vox, ox, oz, cols, ids);
        if (this.k.shafts > 0)  this._shafts(vox, ox, oz, cols, ids);
    }

    // ── Lattice fields ───────────────────────────────────────────────────────

    _lattice(ox, oz, yHi) {
        const k = this.k;
        this.kLo = Math.floor(CAVE_MIN_Y / LAT);
        this.kHi = Math.ceil(yHi / LAT);
        const nLev = this.nLev = this.kHi - this.kLo + 1;

        let anyNoodle = false, anyCavern = false;
        for (let ix = 0; ix < NL; ix++) {
            for (let iz = 0; iz < NL; iz++) {
                const x = ox + ix * LAT, z = oz + iz * LAT;
                const l = ix * NL + iz;
                this.lTW[l] = (0.05 + 0.046 * clamp01(0.5 + 1.4 * this.nWidth.noise2(x / 240, z / 240))) * Math.sqrt(k.tunnels);
                this.lNR[l] = smooth(0.0, 0.25, this.nNoodleReg.noise2(x / 520, z / 520)) * k.noodles;
                this.lCR[l] = smooth(0.28, 0.55, this.nCavReg.noise2(x / 820, z / 820)) * k.caverns;
                if (this.lNR[l] > 0) anyNoodle = true;
                if (this.lCR[l] > 0) anyCavern = true;
            }
        }
        this.anyNoodle = anyNoodle;
        this.anyCavern = anyCavern;

        for (let ix = 0; ix < NL; ix++) {
            for (let iz = 0; iz < NL; iz++) {
                const x = ox + ix * LAT, z = oz + iz * LAT;
                const base = (ix * NL + iz) * nLev;
                for (let kk = 0; kk < nLev; kk++) {
                    const y = (this.kLo + kk) * LAT;
                    const i = base + kk;
                    if (k.tunnels > 0) {
                        // Tunnels run where both are near zero. Every tunnel
                        // wall is drawn (nothing culls geometry underground),
                        // so these scales set most of a chunk's triangles.
                        this.fTA[i] = this.nTA.noise3(x / 104, y / 70, z / 104);
                        this.fTB[i] = this.nTB.noise3(x / 104, y / 70, z / 104);
                    }
                    if (anyNoodle) {
                        this.fNA[i] = this.nNA.noise3(x / 38, y / 30, z / 38);
                        this.fNB[i] = this.nNB.noise3(x / 38, y / 30, z / 38);
                    }
                    if (anyCavern) {
                        this.fC[i] = 0.72 * this.nCav.noise3(x / 84, y / 46, z / 84) +
                                     0.28 * this.nCav2.noise3(x / 30, y / 22, z / 30);
                    }
                }
            }
        }
    }

    // ── Column walk ──────────────────────────────────────────────────────────

    _walk(vox, ox, oz, cols, ids) {
        const { air, water, bedrock } = ids;
        const nLev = this.nLev, kLo = this.kLo;
        const TA = this.fTA, TB = this.fTB, NA = this.fNA, NB = this.fNB, CV = this.fC;
        const doTun = this.k.tunnels > 0, doNoo = this.anyNoodle, doCav = this.anyCavern;

        for (let lx = 0; lx < N; lx++) {
            const ix = lx >> 2, fx = (lx & 3) / LAT;
            for (let lz = 0; lz < N; lz++) {
                const iz = lz >> 2, fz = (lz & 3) / LAT;
                const c = lx * N + lz;
                const capY = this.cap[c];
                if (capY < CAVE_MIN_Y) continue;
                const top = cols.top[c];

                // Bilinear weights of the four lattice columns around this one.
                const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
                const l00 = ix * NL + iz, l10 = l00 + NL, l01 = l00 + 1, l11 = l10 + 1;
                const b00 = l00 * nLev, b10 = l10 * nLev, b01 = l01 * nLev, b11 = l11 * nLev;
                const bil = (F, k) => F[b00 + k] * w00 + F[b10 + k] * w10 + F[b01 + k] * w01 + F[b11 + k] * w11;

                const tw  = this.lTW[l00] * w00 + this.lTW[l10] * w10 + this.lTW[l01] * w01 + this.lTW[l11] * w11;
                const nr  = this.lNR[l00] * w00 + this.lNR[l10] * w10 + this.lNR[l01] * w01 + this.lNR[l11] * w11;
                const cr  = this.lCR[l00] * w00 + this.lCR[l10] * w10 + this.lCR[l01] * w01 + this.lCR[l11] * w11;
                const nw  = 0.036 * nr;
                const noodles = doNoo && nw > 0.004;
                const caverns = doCav && cr > 0.01;
                // Cavern threshold falls with the region's strength; it rises
                // again toward the surface, so chambers stay underground.
                const cBase = 0.98 - 0.5 * cr;

                const kEnd = Math.floor(capY / LAT) - kLo;
                const colBase = lx + lz * SZ;
                let tA0 = doTun ? bil(TA, 0) : 1, tB0 = doTun ? bil(TB, 0) : 1;
                let nA0 = noodles ? bil(NA, 0) : 1, nB0 = noodles ? bil(NB, 0) : 1;
                let c0 = caverns ? bil(CV, 0) : -1;

                for (let k = 0; k <= kEnd && k < nLev - 1; k++) {
                    const tA1 = doTun ? bil(TA, k + 1) : 1, tB1 = doTun ? bil(TB, k + 1) : 1;
                    const nA1 = noodles ? bil(NA, k + 1) : 1, nB1 = noodles ? bil(NB, k + 1) : 1;
                    const c1 = caverns ? bil(CV, k + 1) : -1;
                    const y0 = (kLo + k) * LAT;

                    // Could anything carve in this 4-block segment? (The cavern
                    // threshold only ever rises above cBase.)
                    const tun = doTun && minAbs(tA0, tA1) < tw && minAbs(tB0, tB1) < tw;
                    const noo = noodles && minAbs(nA0, nA1) < nw && minAbs(nB0, nB1) < nw;
                    const cav = caverns && (c0 > cBase - 0.01 || c1 > cBase - 0.01);

                    if (tun || noo || cav) {
                        const yA = y0 < CAVE_MIN_Y ? CAVE_MIN_Y : y0;
                        const yB = y0 + LAT - 1 < capY ? y0 + LAT - 1 : capY;
                        for (let y = yA; y <= yB; y++) {
                            const t = (y - y0) / LAT;
                            let hit = false;
                            if (tun) {
                                // Tunnels breaking the surface stay a little narrower.
                                const w = y > top - 4 ? tw * 0.8 : tw;
                                const a = tA0 + (tA1 - tA0) * t, b = tB0 + (tB1 - tB0) * t;
                                hit = (a < 0 ? -a : a) < w && (b < 0 ? -b : b) < w;
                            }
                            if (!hit && noo) {
                                const a = nA0 + (nA1 - nA0) * t, b = nB0 + (nB1 - nB0) * t;
                                hit = (a < 0 ? -a : a) < nw && (b < 0 ? -b : b) < nw;
                            }
                            if (!hit && cav) {
                                const v = c0 + (c1 - c0) * t;
                                const thr = cBase + 0.35 * smooth(top - 26, top - 10, y) + 0.1 * smooth(-20, 60, y);
                                hit = v > thr;
                            }
                            if (hit) {
                                const i = colBase + (y - WORLD_MIN_Y) * N;
                                const id = vox[i];
                                if (id !== air && id !== water && id !== bedrock) vox[i] = air;
                            }
                        }
                    }
                    tA0 = tA1; tB0 = tB1; nA0 = nA1; nB0 = nB1; c0 = c1;
                }
            }
        }
    }

    // ── 2D-driven features ───────────────────────────────────────────────────

    /**
     * Fill this.g with f over the chunk plus a one-block ring and return, per
     * column, |f| / |∇f|: the distance to f's zero line in blocks.
     */
    _distanceField(ox, oz, f, out) {
        const g = this.g, W = N + 2;
        for (let ix = 0; ix < W; ix++) for (let iz = 0; iz < W; iz++) g[ix * W + iz] = f(ox - 1 + ix, oz - 1 + iz);
        for (let lx = 0; lx < N; lx++) {
            for (let lz = 0; lz < N; lz++) {
                const j = (lx + 1) * W + (lz + 1);
                const gx = (g[j + W] - g[j - W]) * 0.5, gz = (g[j + 1] - g[j - 1]) * 0.5;
                out[lx * N + lz] = Math.abs(g[j]) / (Math.sqrt(gx * gx + gz * gz) + 1e-9);
            }
        }
        return out;
    }

    /**
     * A region field per column; false if it is zero over the whole chunk, in
     * which case the (costlier) distance field need not be built. Per column,
     * not a few samples, so a region edge is treated alike by both chunks.
     */
    _region(ox, oz, f) {
        const r = this._reg ??= new Float64Array(N * N);
        let any = false;
        for (let lx = 0; lx < N; lx++) for (let lz = 0; lz < N; lz++) {
            const v = f(ox + lx, oz + lz);
            r[lx * N + lz] = v;
            if (v > 0) any = true;
        }
        return any;
    }

    _valleys(vox, ox, oz, cols, ids) {
        const k = this.k.valleys;
        if (!this._region(ox, oz, (x, z) => smooth(0.3, 0.55, this.nValleyReg.noise2(x / 1300, z / 1300)) * k)) return;
        const reg = this._reg;
        const dist = this._distanceField(ox, oz, (x, z) => this.nValley.fbm2(x, z, 2, 1 / 700), this._d ??= new Float64Array(N * N));
        const { air, water, bedrock } = ids;
        for (let lx = 0; lx < N; lx++) {
            for (let lz = 0; lz < N; lz++) {
                const c = lx * N + lz;
                const x = ox + lx, z = oz + lz;
                const r = reg[c];
                if (r <= 0) continue;
                const W = 9 + 9 * r;
                const q = dist[c] / W;
                if (q >= 1) continue;
                const yc = -44 + 16 * this.nValleyY.noise2(x / 380, z / 380);
                const up = 14 * r * Math.sqrt(1 - q * q), down = 5 * r * (1 - q * q);
                const y0 = Math.max(CAVE_MIN_Y, Math.ceil(yc - down)), y1 = Math.min(this.cap[c], Math.floor(yc + up));
                for (let y = y0; y <= y1; y++) {
                    const i = lx + (y - WORLD_MIN_Y) * N + lz * SZ;
                    const id = vox[i];
                    if (id !== air && id !== water && id !== bedrock) vox[i] = air;
                }
            }
        }
    }

    _ravines(vox, ox, oz, cols, ids) {
        const k = Math.min(1, this.k.ravines);
        if (!this._region(ox, oz, (x, z) => smooth(0.32, 0.5, this.nRavineReg.noise2(x / 900, z / 900)) * k)) return;
        const reg = this._reg;
        const dist = this._distanceField(ox, oz, (x, z) => this.nRavine.fbm2(x, z, 2, 1 / 620), this._d ??= new Float64Array(N * N));
        const { air, water, bedrock } = ids;
        for (let lx = 0; lx < N; lx++) {
            for (let lz = 0; lz < N; lz++) {
                const c = lx * N + lz;
                if (cols.water[c] !== NO_WATER || cols.wetFloor[c] !== NO_WET_NEIGHBOUR) continue;
                const x = ox + lx, z = oz + lz;
                const r = reg[c];
                if (r <= 0) continue;
                const wv = clamp01(0.5 + 1.5 * this.nRavineW.noise2(x / 160, z / 160));
                const W = (1.6 + 3.2 * wv) * r;
                if (dist[c] >= W) continue;
                const top = cols.top[c];
                const D = (20 + 34 * wv) * r;
                const yBot = Math.max(CAVE_MIN_Y, Math.floor(top - D));
                const yTop = this.cap[c];
                for (let y = yBot; y <= yTop; y++) {
                    // V-shaped: full width at the top, closing to the floor.
                    const half = W * Math.sqrt((y - yBot + 1) / (D + 1));
                    if (dist[c] >= half) continue;
                    const i = lx + (y - WORLD_MIN_Y) * N + lz * SZ;
                    const id = vox[i];
                    if (id !== air && id !== water && id !== bedrock) vox[i] = air;
                }
            }
        }
    }

    _shafts(vox, ox, oz, cols, ids) {
        const { air, water, bedrock } = ids;
        const chance = 0.3 * Math.min(2, this.k.shafts);
        const reach = SHAFT_MAX_R + 3;
        const gx0 = Math.floor((ox - reach) / SHAFT_CELL), gx1 = Math.floor((ox + N + reach) / SHAFT_CELL);
        const gz0 = Math.floor((oz - reach) / SHAFT_CELL), gz1 = Math.floor((oz + N + reach) / SHAFT_CELL);
        for (let gx = gx0; gx <= gx1; gx++) {
            for (let gz = gz0; gz <= gz1; gz++) {
                const h = hashSeed(this.seed, gx, gz, 0x5aa7);
                if ((h & 0xffff) / 0x10000 >= chance) continue;
                const h2 = hashSeed(h, 11);
                const cx = gx * SHAFT_CELL + reach + ((h >>> 16) / 0x10000) * (SHAFT_CELL - 2 * reach);
                const cz = gz * SHAFT_CELL + reach + ((h2 & 0xffff) / 0x10000) * (SHAFT_CELL - 2 * reach);
                const r0 = 1.4 + ((h2 >>> 16) & 0xff) / 255 * (SHAFT_MAX_R - 2);
                const depth = 22 + ((h2 >>> 24) / 255) * 48;
                const ph = (h & 0x3ff) * 0.37;
                for (let lx = 0; lx < N; lx++) {
                    const x = ox + lx;
                    if (Math.abs(x - cx) > reach) continue;
                    for (let lz = 0; lz < N; lz++) {
                        const z = oz + lz;
                        if (Math.abs(z - cz) > reach) continue;
                        const c = lx * N + lz;
                        if (cols.water[c] !== NO_WATER || cols.wetFloor[c] !== NO_WET_NEIGHBOUR) continue;
                        const top = cols.top[c];
                        const yBot = Math.max(CAVE_MIN_Y, Math.floor(top - depth));
                        const yTop = this.cap[c];
                        for (let y = yBot; y <= yTop; y++) {
                            // A wandering, uneven pit rather than a drilled tube.
                            const ddx = x - cx - 1.3 * this.nShaft.noise2(y / 9 + ph, 0.5);
                            const ddz = z - cz - 1.3 * this.nShaft.noise2(0.5, y / 9 - ph);
                            const r = r0 * (0.8 + 0.35 * this.nShaft.noise2(y / 6 - ph, ph));
                            if (ddx * ddx + ddz * ddz > r * r) continue;
                            const i = lx + (y - WORLD_MIN_Y) * N + lz * SZ;
                            const id = vox[i];
                            if (id !== air && id !== water && id !== bedrock) vox[i] = air;
                        }
                    }
                }
            }
        }
    }
}
