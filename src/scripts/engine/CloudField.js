/**
 * CloudField — the one cloud pattern the whole weather system reads.
 *
 * It is a tiling noise texture plus a few numbers (wind offsets, a coverage
 * threshold). The GPU samples the texture to draw clouds, cloud shadows and
 * rain; the CPU samples the same bytes with the same bilinear filter to decide
 * where lightning strikes and how hard it is raining on the player. Because both
 * read one source, rain only ever falls from a cloud you can see, and the darker
 * (thicker) the cloud, the heavier it rains.
 *
 * Keep cloudNoise/cloudCover/cloudThick/rainMask in CLOUD_GLSL (AtmosGLSL.js)
 * and the methods below identical — test/weather.test.mjs checks the CPU side.
 *
 * Two layers of the same texture:
 *   A — broad pattern, one tile per CLOUD_PERIOD_A blocks: cloud groups, clear gaps
 *   B — detail, one tile per CLOUD_PERIOD_B blocks, drifting a little faster than
 *       A, so cloud shapes slowly change as they move instead of sliding rigidly
 * Each layer's offset wraps at its own period, which keeps it seamless forever.
 *
 * No Three.js — the texture is built from `data` in Clouds.js.
 */

export const CLOUD_TEX      = 256;     // texels per side
export const CLOUD_PERIOD_A = 2048;    // blocks per tile, broad layer
export const CLOUD_PERIOD_B = 512;     // blocks per tile, detail layer
export const CLOUD_MIX_A    = 0.7;     // weight of the broad layer
export const DETAIL_SHIFT   = [0.37, 0.61];
export const COVER_SOFT     = 0.05;    // noise range over which a cloud's edge fades in
export const THICK_GAIN     = 4.5;     // noise above the threshold → thickness 0..1

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/** Periodic gradient-noise fBm, normalised to bytes. Deterministic per seed. */
function buildTexture(seed) {
    const N = CLOUD_TEX;
    const hash = (x, y, p) => {
        x = ((x % p) + p) % p; y = ((y % p) + p) % p;
        let h = (x * 374761393 + y * 668265263 + seed * 2246822519 + p * 3266489917) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const grad = (ix, iy, p, fx, fy) => {
        const a = hash(ix, iy, p) * Math.PI * 2;
        return Math.cos(a) * fx + Math.sin(a) * fy;
    };
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const perlin = (x, y, p) => {
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const fx = x - x0, fy = y - y0;
        const u = fade(fx), v = fade(fy);
        const n00 = grad(x0, y0, p, fx, fy),         n10 = grad(x0 + 1, y0, p, fx - 1, fy);
        const n01 = grad(x0, y0 + 1, p, fx, fy - 1), n11 = grad(x0 + 1, y0 + 1, p, fx - 1, fy - 1);
        return (n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v;
    };

    const raw = new Float32Array(N * N);
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            let v = 0, amp = 1, cells = 4;
            for (let o = 0; o < 6; o++) {
                v += perlin(x * cells / N, y * cells / N, cells) * amp;
                amp *= 0.5; cells *= 2;
            }
            raw[y * N + x] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
    }
    const data = new Uint8Array(N * N);
    const k = 255 / (hi - lo || 1);
    for (let i = 0; i < raw.length; i++) data[i] = Math.round((raw[i] - lo) * k);
    return data;
}

export class CloudField {
    constructor(seed = 1337) {
        this.data = buildTexture(seed);
        this.offA = [0, 0];
        this.offB = [0, 0];
        this.threshold = 2;      // noise level clouds start at — 2 means none at all
        this.rainBase  = 0;      // minimum rain under any cloud (heavy rain has no dry patches)
        this._q = this._quantiles();
    }

    /** Bilinear read at texture coords (u, v), exactly as GL LinearFilter + Repeat. */
    _tex(u, v) {
        const N = CLOUD_TEX, d = this.data;
        const x = u * N - 0.5, y = v * N - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const fx = x - x0, fy = y - y0;
        const xa = ((x0 % N) + N) % N, xb = (xa + 1) % N;
        const ya = ((y0 % N) + N) % N, yb = (ya + 1) % N;
        const a = d[ya * N + xa], b = d[ya * N + xb], c = d[yb * N + xa], e = d[yb * N + xb];
        return ((a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy) / 255;
    }

    /** Raw cloud noise (0..1) at world (x, z), with the current wind offsets. */
    noise(x, z) {
        const a = this._tex((x + this.offA[0]) / CLOUD_PERIOD_A, (z + this.offA[1]) / CLOUD_PERIOD_A);
        const b = this._tex((x + this.offB[0]) / CLOUD_PERIOD_B + DETAIL_SHIFT[0],
                            (z + this.offB[1]) / CLOUD_PERIOD_B + DETAIL_SHIFT[1]);
        return a * CLOUD_MIX_A + b * (1 - CLOUD_MIX_A);
    }

    cover(n) { return smoothstep(this.threshold, this.threshold + COVER_SOFT, n); }
    thick(n) { return Math.min(1, Math.max(0, (n - this.threshold) * THICK_GAIN)); }

    /** 0..1: how much of the current precipitation falls at (x, z). */
    rainMask(x, z) {
        const n = this.noise(x, z);
        const c = this.cover(n);
        if (c <= 0) return 0;
        const r = this.rainBase + (1 - this.rainBase) * smoothstep(0.1, 0.55, this.thick(n));
        return c * Math.min(1, Math.max(0, r));
    }

    /** Cloud thickness at (x, z): 0 in clear sky … 1 in the darkest cores. */
    thicknessAt(x, z) {
        const n = this.noise(x, z);
        return this.cover(n) * this.thick(n);
    }

    /** Move the pattern by the wind (blocks). The detail layer runs a little faster. */
    drift(dx, dz, dt = 0) {
        const pa = CLOUD_PERIOD_A, pb = CLOUD_PERIOD_B;
        this.offA[0] = (((this.offA[0] - dx) % pa) + pa) % pa;
        this.offA[1] = (((this.offA[1] - dz) % pa) + pa) % pa;
        // The detail layer also creeps on its own, so clouds keep evolving in a calm.
        this.offB[0] = (((this.offB[0] - dx * 1.25 - dt * 0.35) % pb) + pb) % pb;
        this.offB[1] = (((this.offB[1] - dz * 1.25 - dt * 0.2) % pb) + pb) % pb;
    }

    /** Set the threshold so that about `cover` (0..1+) of the sky is cloud. */
    setCoverage(cover) { this.threshold = this.thresholdFor(cover); }

    thresholdFor(cover) {
        const q = this._q, n = q.length - 1;
        if (cover <= 0.002) return 2;
        // At full cover and beyond, drop below the thinnest cloud so there are no
        // gaps at all; the extra lowers the threshold further, thickening
        // everything, which is what makes heavy rain's "lighter patches".
        if (cover >= 1) return q[0] - 0.02 - (cover - 1) * 1.2;
        const f = (1 - cover) * n, i = Math.floor(f), t = f - i;
        return q[i] + ((q[Math.min(i + 1, n)] - q[i]) * t);
    }

    /** Quantiles of the combined noise, so a coverage fraction means what it says. */
    _quantiles() {
        const S = 192, vals = new Float32Array(S * S);
        const step = CLOUD_PERIOD_A / S;
        for (let j = 0; j < S; j++) {
            for (let i = 0; i < S; i++) vals[j * S + i] = this.noise(i * step + 0.5, j * step + 0.5);
        }
        vals.sort();
        const Q = 256, q = new Float32Array(Q + 1);
        for (let k = 0; k <= Q; k++) q[k] = vals[Math.min(vals.length - 1, Math.round(k / Q * (vals.length - 1)))];
        return q;
    }
}
