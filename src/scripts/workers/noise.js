/**
 * Simplex Noise  —  2D and 3D
 * Ported from Stefan Gustavson's Java reference implementation.
 * Call setSeed() before generating any noise to reproduce the same world.
 */

// Gradient vectors for 2D (6) and 3D (12)
const GRAD3 = new Float32Array([
     1, 1, 0,  -1, 1, 0,   1,-1, 0,  -1,-1, 0,
     1, 0, 1,  -1, 0, 1,   1, 0,-1,  -1, 0,-1,
     0, 1, 1,   0,-1, 1,   0, 1,-1,   0,-1,-1,
]);

// Skew / un-skew constants
const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;

const perm      = new Uint8Array(512);
const permMod12 = new Uint8Array(512);

export function setSeed(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    // Fisher-Yates shuffle seeded by a simple LCG
    let s = seed >>> 0;
    for (let i = 255; i > 0; i--) {
        s = Math.imul(s, 1664525) + 1013904223 >>> 0;
        const j = s % (i + 1);
        const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }

    for (let i = 0; i < 512; i++) {
        perm[i]      = p[i & 255];
        permMod12[i] = perm[i] % 12;
    }
}

setSeed(0); // sensible default until the world seed is set

// ── Raw simplex noise ────────────────────────────────────────────────────────

export function noise2D(xin, yin) {
    const s  = (xin + yin) * F2;
    const i  = Math.floor(xin + s);
    const j  = Math.floor(yin + s);
    const t  = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    const ii  = i & 255;
    const jj  = j & 255;
    const gi0 = permMod12[ii       + perm[jj     ]];
    const gi1 = permMod12[ii + i1  + perm[jj + j1]];
    const gi2 = permMod12[ii + 1   + perm[jj + 1 ]];

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0*x0 - y0*y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0*t0*(GRAD3[gi0*3]*x0 + GRAD3[gi0*3+1]*y0); }

    let t1 = 0.5 - x1*x1 - y1*y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1*t1*(GRAD3[gi1*3]*x1 + GRAD3[gi1*3+1]*y1); }

    let t2 = 0.5 - x2*x2 - y2*y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2*t2*(GRAD3[gi2*3]*x2 + GRAD3[gi2*3+1]*y2); }

    return 70.0 * (n0 + n1 + n2);  // result in [-1, 1]
}

export function noise3D(xin, yin, zin) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;

    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
        if      (y0 >= z0) { i1=1;j1=0;k1=0; i2=1;j2=1;k2=0; }
        else if (x0 >= z0) { i1=1;j1=0;k1=0; i2=1;j2=0;k2=1; }
        else               { i1=0;j1=0;k1=1; i2=1;j2=0;k2=1; }
    } else {
        if      (y0 < z0)  { i1=0;j1=0;k1=1; i2=0;j2=1;k2=1; }
        else if (x0 < z0)  { i1=0;j1=1;k1=0; i2=0;j2=1;k2=1; }
        else               { i1=0;j1=1;k1=0; i2=1;j2=1;k2=0; }
    }

    const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
    const x2=x0-i2+2*G3, y2=y0-j2+2*G3, z2=z0-k2+2*G3;
    const x3=x0-1+3*G3, y3=y0-1+3*G3, z3=z0-1+3*G3;

    const ii=i&255, jj=j&255, kk=k&255;
    const gi0 = permMod12[ii    + perm[jj    + perm[kk   ]]];
    const gi1 = permMod12[ii+i1 + perm[jj+j1 + perm[kk+k1]]];
    const gi2 = permMod12[ii+i2 + perm[jj+j2 + perm[kk+k2]]];
    const gi3 = permMod12[ii+1  + perm[jj+1  + perm[kk+1 ]]];

    let n0=0, n1=0, n2=0, n3=0;

    let t0=0.6-x0*x0-y0*y0-z0*z0;
    if(t0>=0){t0*=t0;n0=t0*t0*(GRAD3[gi0*3]*x0+GRAD3[gi0*3+1]*y0+GRAD3[gi0*3+2]*z0);}

    let t1=0.6-x1*x1-y1*y1-z1*z1;
    if(t1>=0){t1*=t1;n1=t1*t1*(GRAD3[gi1*3]*x1+GRAD3[gi1*3+1]*y1+GRAD3[gi1*3+2]*z1);}

    let t2=0.6-x2*x2-y2*y2-z2*z2;
    if(t2>=0){t2*=t2;n2=t2*t2*(GRAD3[gi2*3]*x2+GRAD3[gi2*3+1]*y2+GRAD3[gi2*3+2]*z2);}

    let t3=0.6-x3*x3-y3*y3-z3*z3;
    if(t3>=0){t3*=t3;n3=t3*t3*(GRAD3[gi3*3]*x3+GRAD3[gi3*3+1]*y3+GRAD3[gi3*3+2]*z3);}

    return 32.0 * (n0 + n1 + n2 + n3);  // result in [-1, 1]
}

// ── Composite noise helpers ──────────────────────────────────────────────────

/**
 * Fractional Brownian Motion — layered octaves for natural-looking terrain.
 * Returns a value in approximately [-1, 1].
 */
export function fbm2D(x, z, octaves, frequency, persistence = 0.5, lacunarity = 2.0) {
    let value = 0, amplitude = 1, freq = frequency, max = 0;
    for (let i = 0; i < octaves; i++) {
        value     += noise2D(x * freq, z * freq) * amplitude;
        max       += amplitude;
        amplitude *= persistence;
        freq      *= lacunarity;
    }
    return value / max;
}

export function fbm3D(x, y, z, octaves, frequency, persistence = 0.5, lacunarity = 2.0) {
    let value = 0, amplitude = 1, freq = frequency, max = 0;
    for (let i = 0; i < octaves; i++) {
        value     += noise3D(x * freq, y * freq, z * freq) * amplitude;
        max       += amplitude;
        amplitude *= persistence;
        freq      *= lacunarity;
    }
    return value / max;
}

/**
 * Ridged noise — inverted abs, produces sharp mountain ridges.
 * Returns a value in approximately [0, 1].
 */
export function ridged2D(x, z, octaves, frequency, persistence = 0.5, lacunarity = 2.0) {
    let value = 0, amplitude = 1, freq = frequency, max = 0;
    for (let i = 0; i < octaves; i++) {
        value     += (1.0 - Math.abs(noise2D(x * freq, z * freq))) * amplitude;
        max       += amplitude;
        amplitude *= persistence;
        freq      *= lacunarity;
    }
    return value / max;
}

/**
 * Domain-warped fbm — feeds one fbm into the input of another for dramatic
 * terrain shapes (cliffs, overhangs, winding rivers).
 */
export function warpedFbm2D(x, z, octaves, frequency) {
    const wx = x + 4.2 * fbm2D(x + 0.0,   z + 0.0,   4, frequency, 0.5, 2.0);
    const wz = z + 4.2 * fbm2D(x + 5.678, z + 5.678, 4, frequency, 0.5, 2.0);
    return fbm2D(wx, wz, octaves, frequency, 0.5, 2.0);
}

// ── Seeded PRNG (for deterministic per-chunk random choices) ─────────────────

/**
 * Returns a deterministic pseudo-random integer in [0, 0xFFFFFFFF]
 * given a world seed and up to 4 extra integer coordinates.
 * Uses a few rounds of xorshift mixing so close seeds produce different outputs.
 */
export function hashSeed(seed, a = 0, b = 0, c = 0, d = 0) {
    let s = (seed ^ 0xDEADBEEF) >>> 0;
    s = Math.imul(s ^ (a * 2654435761), 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (b * 2246822519), 0x85ebca6b) >>> 0;
    s = Math.imul(s ^ (c * 3266489917), 0xc2b2ae35) >>> 0;
    s = Math.imul(s ^ (d * 668265263),  0x27d4eb2f) >>> 0;
    s ^= s >>> 16; s = Math.imul(s, 0x45d9f3b) >>> 0;
    return (s ^ (s >>> 16)) >>> 0;   // final >>> 0 keeps result unsigned
}

/** Deterministic float in [0, 1) from seed + coords. */
export function randFloat(seed, a = 0, b = 0, c = 0) {
    return hashSeed(seed, a, b, c) / 0x100000000;
}
