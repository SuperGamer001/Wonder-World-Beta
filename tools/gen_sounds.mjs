// Makes the game's sounds (data/sounds/blocks, entities, ambiant, ui).
//
//   node tools/gen_sounds.mjs [name …] [--wav]          (npm run sounds)
//
// Nothing here is a recording and nothing is a beep either: each sound is
// built the way the thing itself makes it, at 44.1 kHz.
//
//   • A footstep is a heel and then the ball of the foot; each is the dull
//     knock of a body's weight plus what the ground does — blades brushing,
//     grit turning, a board ringing in its few modes, snow squeaking.
//   • A voice is a throat and a mouth: a pulse train with the jitter and the
//     roughness of a real larynx, through resonances that move as the mouth
//     does (a cow's "m–oo", the tremble in a sheep's bleat).
//   • Thunder is a lightning channel some kilometres long, every few metres of
//     which goes off at once; what arrives is each of those bangs, later and
//     duller the further up the channel it was — a crack from the nearest
//     part, then the roll from the rest — heard from two ears apart.
//   • Birds, crickets, dripping caves and lapping water are the calls and the
//     drops themselves, placed at different distances in a little air.
//
// Deterministic: a seed per name. Files are named <sound>_<take>.<ext>; the
// game plays any take of a sound (src/scripts/Sound.js), so a recording saved
// under the same name replaces a made one. Written as Ogg Vorbis when ffmpeg
// is on the PATH, else as WAV (--wav keeps WAV regardless). WW_SOUND_OUT=<dir>
// writes somewhere else to listen first.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT = process.env.WW_SOUND_OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sounds');
const KEEP_WAV = process.argv.includes('--wav');
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HAVE_FFMPEG = !KEEP_WAV && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// ── Numbers ──────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const db = (d) => 10 ** (d / 20);
const secs = (s) => Math.max(1, Math.round(s * SR));

function seedOf(name) {
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
/** A seeded source of numbers: r() in [0, 1), r.range, r.gauss, r.pick. */
function rng(seed) {
    let a = seed >>> 0;
    const r = () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(TAU * r());
    r.pick = (list) => list[Math.floor(r() * list.length)];
    r.log = (lo, hi) => lo * (hi / lo) ** r();          // even over octaves
    return r;
}

// ── Signals ──────────────────────────────────────────────────────────────────

const zeros = (s) => new Float32Array(secs(s));

function white(n, r) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
    return x;
}
/** Pink noise (Paul Kellet's filter). */
function pink(n, r) {
    const x = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
        const w = r() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
    }
    return x;
}
function brown(n, r) {
    const x = new Float32Array(n);
    let v = 0;
    for (let i = 0; i < n; i++) { v = (v + (r() * 2 - 1) * 0.02) * 0.999; x[i] = v * 3.5; }
    return x;
}

/** RBJ biquad coefficients [b0, b1, b2, a1, a2]. */
function coefs(type, f, q, gain = 0) {
    const w = TAU * clamp(f, 10, SR * 0.45) / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp')      { b1 = 1 - cw; b0 = b2 = b1 / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'hp') { b1 = -(1 + cw); b0 = b2 = -b1 / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }   // peak gain 1
    else {                                                                                            // 'peak'
        const A = 10 ** (gain / 40);
        b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
/**
 * Filter a signal. `f` (and `q`) may be functions of time in seconds, for a
 * filter that moves; they are read every 32 samples.
 */
function filt(x, type, f, q = 0.707, gain = 0) {
    const y = new Float32Array(x.length), moving = typeof f === 'function' || typeof q === 'function';
    let c = moving ? null : coefs(type, f, q, gain), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        if (moving && (i & 31) === 0) {
            const t = i / SR;
            c = coefs(type, typeof f === 'function' ? f(t) : f, typeof q === 'function' ? q(t) : q, gain);
        }
        const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}
const band = (x, lo, hi) => filt(filt(x, 'hp', lo), 'lp', hi);

/** x times an envelope given as a function of seconds. */
function shape(x, env) {
    for (let i = 0; i < x.length; i++) x[i] *= env(i / SR);
    return x;
}
/** Up in `a` seconds, then dying away with time constant `d`. */
const strike = (a, d) => (t) => (t < a ? t / a : Math.exp(-(t - a) / d));
/** Add `x` into `out` from `at` seconds, times `gain`. */
function add(out, x, at = 0, gain = 1) {
    const o = Math.round(at * SR);
    for (let i = Math.max(0, -o); i < x.length && i + o < out.length; i++) out[i + o] += x[i] * gain;
    return out;
}
function peak(x) { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; }
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }
/** Gently rounds off what goes past ±1 instead of cutting it square. */
function soften(x, drive = 1) {
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive);
    return x;
}
function fade(x, a = 0.002, b = 0.01) {
    const na = secs(a), nb = secs(b), n = x.length;
    for (let i = 0; i < na && i < n; i++) x[i] *= i / na;
    for (let i = 0; i < nb && i < n; i++) x[n - 1 - i] *= i / nb;
    return x;
}
/** Cut the silence off the end (keeping a little), so files are no longer than their sound. */
function trim(chans, floor = 0.0012) {
    const n = chans[0].length;
    let end = n - 1;
    while (end > 0 && chans.every(c => Math.abs(c[end]) < floor)) end--;
    end = Math.min(n, end + secs(0.03));
    return chans.map(c => fade(c.slice(0, end), 0.001, 0.02));
}

/**
 * A dull knock: a low note dying fast. It starts a shade sharp (`drop`), as a
 * struck thing does, but only for a few thousandths of a second — any longer
 * and it is a drum machine, not a foot.
 */
function thump(out, at, f, drop, decay, gain) {
    const n = secs(decay * 7), o = Math.round(at * SR);
    let ph = 0;
    for (let i = 0; i < n && i + o < out.length; i++) {
        const t = i / SR;
        ph += TAU * f * (1 + drop * 0.22 * Math.exp(-t / 0.004)) / SR;
        out[i + o] += Math.sin(ph) * Math.exp(-t / decay) * Math.min(1, t / 0.0015) * gain;
    }
}
/** Something ringing: damped sines, [frequency, time constant, level] each. */
function ring(out, at, modes, gain, r = null) {
    const o = Math.round(at * SR);
    for (const [f, d, a] of modes) {
        const n = secs(d * 7), ph = r ? r() * TAU : 0;
        for (let i = 0; i < n && i + o < out.length; i++) {
            const t = i / SR;
            out[i + o] += Math.sin(TAU * f * t + ph) * Math.exp(-t / d) * Math.min(1, t / 0.0004) * a * gain;
        }
    }
}
/**
 * Many small things giving way one after another — grit, blades, crystals:
 * `count` grains over `spread` seconds (most of them early when `early` > 1),
 * each a tiny ring between the two frequencies.
 */
function grains(out, r, at, { count, spread, early = 1.6, freq, decay, gain }) {
    for (let k = 0; k < count; k++) {
        const t = at + spread * r() ** early;
        const f = r.log(freq[0], freq[1]), d = r.range(decay[0], decay[1]);
        ring(out, t, [[f, d, 1], [f * r.range(1.3, 1.9), d * 0.6, 0.5]], gain * r.range(0.3, 1) * (1 - 0.6 * (t - at) / spread), r);
    }
}
/** A burst of noise between two frequencies, up in `a` and away in `d`. */
function hiss(out, r, at, lo, hi, a, d, gain) {
    const x = shape(band(white(secs(a + d * 6), r), lo, hi), strike(a, d));
    add(out, x, at, gain);
}

/** A small room or a big cave: four combs and two all-passes, each ear its own. */
function reverb(x, { t60 = 1.2, size = 1, damp = 0.35, offset = 0 }) {
    const n = x.length, y = new Float32Array(n);
    for (const ms of [29.7, 37.1, 41.1, 43.7, 31.3, 47.9]) {
        const d = Math.round((ms * size + offset * 0.37) * SR / 1000), g = 10 ** (-3 * (d / SR) / t60);
        const buf = new Float32Array(d);
        let p = 0, lp = 0;
        for (let i = 0; i < n; i++) {
            const v = buf[p];
            lp = v + (lp - v) * damp;
            buf[p] = x[i] + lp * g;
            if (++p === d) p = 0;
            y[i] += v;
        }
    }
    let z = y;
    for (const ms of [5.0, 1.7]) {
        const d = Math.round((ms + offset * 0.11) * SR / 1000), buf = new Float32Array(d), w = new Float32Array(n);
        let p = 0;
        for (let i = 0; i < n; i++) {
            const v = buf[p], u = z[i] + v * 0.5;
            buf[p] = u;
            if (++p === d) p = 0;
            w[i] = v - u * 0.5;
        }
        z = w;
    }
    for (let i = 0; i < n; i++) z[i] /= 6;
    return z;
}
/** The dry sound with a little of a place round it. */
function inSpace(x, opts, mix) {
    const wet = reverb(x, opts);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] + wet[i] * mix;
    return y;
}

// ── Ground and blocks ────────────────────────────────────────────────────────

/**
 * What each kind of ground does under a weight. `knock`: the body's own thud
 * [Hz, level]. `hiss`: brushing or sliding [low Hz, high Hz, seconds, level].
 * `grit`: the grains. `modes`: what rings, if it is hard or hollow.
 */
const GROUND = {
    grass:  { knock: [78, 0.5],  hiss: [1500, 7000, 0.07, 0.3],  grit: { count: 16, freq: [2600, 9000], decay: [0.0006, 0.002], gain: 0.16 } },
    dirt:   { knock: [92, 0.75], hiss: [300, 1700, 0.045, 0.4],  grit: { count: 9,  freq: [900, 3200],  decay: [0.001, 0.004],  gain: 0.2 } },
    stone:  { knock: [150, 0.5], hiss: [1400, 5200, 0.022, 0.2], grit: { count: 4,  freq: [2500, 6000], decay: [0.001, 0.003],  gain: 0.14 },
              modes: [[1830, 0.011, 0.5], [3120, 0.008, 0.4], [4750, 0.005, 0.3], [640, 0.014, 0.3]] },
    sand:   { knock: [70, 0.3],  hiss: [900, 5200, 0.085, 0.5],  grit: { count: 40, freq: [2200, 7500], decay: [0.0004, 0.0012], gain: 0.07 } },
    gravel: { knock: [95, 0.45], hiss: [1200, 6000, 0.05, 0.22], grit: { count: 46, freq: [1700, 7200], decay: [0.0012, 0.006], gain: 0.26 } },
    wood:   { knock: [128, 0.6], hiss: [900, 3200, 0.015, 0.12], grit: { count: 2,  freq: [1500, 3500], decay: [0.001, 0.003],  gain: 0.1 },
              modes: [[186, 0.05, 0.6], [322, 0.04, 0.5], [541, 0.028, 0.35], [903, 0.018, 0.22], [1490, 0.01, 0.12]] },
    snow:   { knock: [66, 0.3],  hiss: [500, 2600, 0.1, 0.42],   grit: { count: 60, freq: [700, 3000],  decay: [0.0008, 0.003], gain: 0.1 }, squeak: true },
    leaves: { knock: [70, 0.15], hiss: [2400, 9500, 0.09, 0.3],  grit: { count: 34, freq: [3000, 11000], decay: [0.0004, 0.0016], gain: 0.15 } },
    glass:  { knock: [170, 0.3], hiss: [2500, 8000, 0.012, 0.12], grit: { count: 2, freq: [4000, 8000], decay: [0.001, 0.002],  gain: 0.08 },
              modes: [[2390, 0.03, 0.5], [5310, 0.022, 0.4], [7920, 0.014, 0.3], [3660, 0.02, 0.25]] },
};

/** One foot coming down: the heel, then the ball of the foot a moment after. */
function step(name, r) {
    const g = GROUND[name], out = zeros(0.5), k = r.range(0.92, 1.08);
    const gap = r.range(0.055, 0.085);
    for (const [at, w] of [[0.004, 1], [0.004 + gap, r.range(0.5, 0.7)]]) {
        thump(out, at, g.knock[0] * k * (w < 1 ? 1.25 : 1), 0.8, 0.016, g.knock[1] * w * (g.modes ? 0.6 : 0.4));
        hiss(out, r, at, g.hiss[0], g.hiss[1], 0.004 + g.hiss[2] * 0.25, g.hiss[2], g.hiss[3] * w * 1.5);
        grains(out, r, at, { ...g.grit, count: Math.round(g.grit.count * w), spread: 0.02 + g.hiss[2] * 1.3, gain: g.grit.gain * w * 1.7 });
        if (g.modes) ring(out, at, g.modes.map(([f, d, a]) => [f * k * r.range(0.97, 1.03), d, a]), 0.3 * w, r);
    }
    // Snow gives under the foot with a squeak: a narrow band of noise sliding up.
    if (g.squeak) {
        const f0 = r.range(850, 1050);
        const sq = shape(filt(white(secs(0.16), r), 'bp', (t) => f0 + 2600 * t, 9), (t) => Math.sin(Math.PI * clamp(t / 0.16, 0, 1)) ** 1.5);
        add(out, sq, 0.01, 0.7);
    }
    return [out];
}

/** A tool or a hand striking it, once. */
function hit(name, r) {
    const g = GROUND[name], out = zeros(0.5), k = r.range(0.9, 1.1);
    thump(out, 0.003, g.knock[0] * 1.3 * k, 1.2, 0.014, g.knock[1] * 0.7);
    hiss(out, r, 0.003, g.hiss[0], g.hiss[1], 0.002, g.hiss[2] * 0.6, g.hiss[3] * 1.9);
    grains(out, r, 0.004, { ...g.grit, count: Math.round(g.grit.count * 0.7) + 2, spread: 0.05 + g.hiss[2] * 0.6, gain: g.grit.gain * 2 });
    if (g.modes) ring(out, 0.003, g.modes.map(([f, d, a]) => [f * k, d * 1.5, a]), 0.55, r);
    // Rock answers a pick with a short bright ring of its own.
    if (name === 'stone') ring(out, 0.003, [[2650 * k, 0.03, 0.3], [4180 * k, 0.022, 0.22], [6100 * k, 0.012, 0.14]], 0.5, r);
    return [out];
}

/** It gives way: a crack, and what it was made of falling in. */
function breakUp(name, r) {
    const g = GROUND[name], out = zeros(0.9), k = r.range(0.92, 1.08);
    thump(out, 0.004, g.knock[0] * k, 1.4, 0.024, g.knock[1] * 0.8);
    hiss(out, r, 0.004, g.hiss[0], g.hiss[1], 0.003, g.hiss[2] * 1.2, g.hiss[3] * 2);
    if (name === 'glass') {
        // Shards: each rings on its own note, and they land over a third of a second.
        for (let i = 0; i < 26; i++) {
            const f = r.log(1900, 9500), t = 0.004 + 0.34 * r() ** 1.8;
            ring(out, t, [[f, r.range(0.02, 0.11), 1], [f * 2.76, 0.012, 0.3]], r.range(0.06, 0.22), r);
        }
        hiss(out, r, 0.003, 3000, 12000, 0.001, 0.03, 0.6);
    } else {
        if (g.modes) ring(out, 0.004, g.modes.map(([f, d, a]) => [f * k * 0.9, d * 2, a]), 0.6, r);
        const debris = name === 'wood' ? { count: 14, freq: [500, 2600], decay: [0.003, 0.012], gain: 0.22 }
            : { ...g.grit, count: Math.round(g.grit.count * 1.6) + 14, gain: g.grit.gain * 2 };
        grains(out, r, 0.01, { ...debris, spread: 0.3, early: 1.3 });
        // The pieces are heavier than grit: a few low knocks as they settle.
        for (let i = 0; i < 4; i++) thump(out, 0.03 + 0.2 * r(), g.knock[0] * r.range(1.2, 2.2), 0.5, 0.012, g.knock[1] * r.range(0.15, 0.4));
    }
    return [out];
}

/** Set down: one firm knock of the stuff, without the roll of a footstep. */
function place(name, r) {
    const g = GROUND[name], out = zeros(0.4), k = r.range(0.9, 1.06);
    thump(out, 0.003, g.knock[0] * 0.85 * k, 0.9, 0.022, g.knock[1] * 0.85);
    hiss(out, r, 0.003, g.hiss[0], g.hiss[1], 0.003, g.hiss[2] * 0.5, g.hiss[3] * 1.2);
    grains(out, r, 0.004, { ...g.grit, count: Math.round(g.grit.count * 0.4) + 1, spread: 0.04, gain: g.grit.gain * 1.5 });
    if (g.modes) ring(out, 0.003, g.modes.map(([f, d, a]) => [f * k * 0.8, d * 1.3, a]), 0.5, r);
    return [out];
}

/** A bubble: a short note that rises as the bubble shrinks. */
function bubble(out, at, f, dur, gain) {
    const n = secs(dur), o = Math.round(at * SR);
    let ph = 0;
    for (let i = 0; i < n && i + o < out.length; i++) {
        const t = i / n;
        ph += TAU * f * (1 + 1.1 * t * t) / SR;
        out[i + o] += Math.sin(ph) * Math.sin(Math.PI * Math.min(1, t * 6) / 2) * Math.exp(-t * 4.5) * gain;
    }
}

function splash(r, big) {
    const len = big ? 1.3 : 0.7, out = zeros(len);
    // The slap of the surface, then the water closing over and settling.
    hiss(out, r, 0.002, 500, 9000, 0.004, big ? 0.05 : 0.03, big ? 0.8 : 0.4);
    const body = shape(filt(pink(secs(len), r), 'lp', (t) => 5200 * Math.exp(-t / (big ? 0.28 : 0.16)) + 500, 0.8),
        (t) => Math.min(1, t / 0.012) * Math.exp(-t / (big ? 0.3 : 0.16)));
    add(out, body, 0.004, big ? 2.6 : 1.5);
    thump(out, 0.004, big ? 62 : 90, 0.6, 0.05, big ? 0.6 : 0.25);
    for (let i = 0; i < (big ? 26 : 10); i++) {
        bubble(out, 0.03 + (big ? 0.8 : 0.4) * r() ** 1.5, r.log(380, 1900), r.range(0.018, 0.06), r.range(0.03, 0.12));
    }
    return [out];
}

// ── Voices ───────────────────────────────────────────────────────────────────

/**
 * A voice: a larynx and a mouth.
 *   f0(t)        pitch in Hz, t from 0 to 1 through the sound
 *   formants(t)  [[Hz, bandwidth, level], …] — the mouth's resonances, moving
 *   env(t)       loudness
 *   jitter, shimmer   how unsteady each pulse's timing and strength is
 *   rough        every other pulse weaker by this much (a creak, a bellow)
 *   breath       air let through beside the voice
 *   tremble      [Hz, depth] — a bleat
 */
function voice(r, { dur, f0, formants, env, jitter = 0.012, shimmer = 0.06, rough = 0, breath = 0.04, tremble = null, tilt = 5 }) {
    const n = secs(dur), src = new Float32Array(n);
    let ph = 0, jit = 0, shim = 1, cycle = 0, lp = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n, tr = tremble ? Math.sin(TAU * tremble[0] * i / SR) : 0;
        const f = f0(t) * (1 + jit) * (1 + (tremble ? tr * tremble[1] * 0.35 : 0));
        ph += f / SR;
        if (ph >= 1) {
            ph -= 1; cycle++;
            jit = r.gauss() * jitter;
            shim = (1 + r.gauss() * shimmer) * (rough && (cycle & 1) ? 1 - rough * r.range(0.6, 1) : 1);
        }
        // The folds open slowly and snap shut: a ramp with a sharp fall. `tilt`
        // says how many harmonics up the voice starts to fall away — a pressed,
        // calling voice is bright, a murmur is not.
        const saw = (ph < 0.86 ? ph / 0.86 : (1 - ph) / 0.14) * 2 - 1;
        lp += (saw * shim - lp) * clamp(f * tilt * TAU / SR, 0, 0.95);
        const air = (r() * 2 - 1) * breath * (0.6 + 0.4 * Math.cos(TAU * ph));
        src[i] = (lp + air) * (1 + (tremble ? tr * tremble[1] : 0));
    }
    // The mouth: resonances side by side, retuned every 64 samples.
    const out = new Float32Array(n), count = formants(0).length;
    for (let k = 0; k < count; k++) {
        let c = null, x1 = 0, x2 = 0, y1 = 0, y2 = 0, level = 0;
        for (let i = 0; i < n; i++) {
            if ((i & 63) === 0) {
                const [f, bw, a] = formants(i / n)[k];
                c = coefs('bp', f, Math.max(0.5, f / bw));
                level = a;
            }
            const v = c[0] * src[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
            x2 = x1; x1 = src[i]; y2 = y1; y1 = v;
            out[i] += v * level;
        }
    }
    for (let i = 0; i < n; i++) out[i] *= env(i / n);
    return out;
}
/** Up over `a` of the sound, held, down over the last `rel`. */
const held = (a, rel) => (t) => smooth(t / a) * smooth((1 - t) / rel);
/** Through these values, evenly spaced, smoothly. */
const through = (...v) => (t) => {
    const x = clamp(t, 0, 1) * (v.length - 1), i = Math.min(v.length - 2, Math.floor(x));
    return lerp(v[i], v[i + 1], smooth(x - i));
};
const mouth = (...shapes) => (t) => {
    const x = clamp(t, 0, 1) * (shapes.length - 1), i = Math.min(shapes.length - 2, Math.floor(x)), k = smooth(x - i);
    return shapes[i].map((s, j) => [lerp(s[0], shapes[i + 1][j][0], k), lerp(s[1], shapes[i + 1][j][1], k), lerp(s[2], shapes[i + 1][j][2], k)]);
};

// Mouth shapes: [Hz, bandwidth, level] for each resonance.
const COW_M = [[240, 70, 1], [880, 160, 0.2], [2100, 300, 0.08], [3100, 400, 0.03]];
const COW_OO = [[370, 90, 1], [760, 130, 0.7], [2150, 320, 0.3], [3200, 420, 0.12]];
const COW_OH = [[450, 110, 1], [860, 150, 0.8], [2250, 340, 0.4], [3300, 440, 0.16]];

function cow(r, hurt) {
    const dur = hurt ? r.range(0.55, 0.75) : r.range(1.3, 1.9), k = r.range(0.92, 1.08) * (hurt ? 1.45 : 1);
    const v = voice(r, {
        dur, rough: hurt ? 0.5 : 0.3, jitter: 0.02, shimmer: 0.1, breath: 0.06, tilt: hurt ? 9 : 6,
        f0: through(92 * k, 148 * k, 140 * k, 118 * k, 84 * k),
        formants: hurt ? mouth(COW_OH, COW_OH, COW_OO) : mouth(COW_M, COW_OO, COW_OH, COW_OO, COW_M),
        env: held(hurt ? 0.08 : 0.14, 0.35),
    });
    return [inSpace(filt(v, 'hp', 60), { t60: 0.5, size: 0.8 }, 0.12)];
}

function sheep(r, hurt) {
    const dur = hurt ? r.range(0.35, 0.5) : r.range(0.7, 1.05), k = r.range(0.9, 1.12) * (hurt ? 1.25 : 1);
    const a = [[760, 130, 1], [1720, 200, 0.55], [2650, 300, 0.2]], e = [[620, 120, 1], [1900, 220, 0.5], [2700, 300, 0.18]];
    const v = voice(r, {
        dur, rough: 0.18, jitter: 0.02, shimmer: 0.09, breath: 0.07, tilt: 7, tremble: [r.range(8, 11), hurt ? 0.35 : 0.5],
        f0: through(250 * k, 330 * k, 315 * k, 255 * k),
        formants: mouth([[300, 90, 1], [1300, 200, 0.2], [2500, 300, 0.05]], e, a, a),
        env: held(0.1, 0.4),
    });
    return [inSpace(filt(v, 'hp', 120), { t60: 0.45, size: 0.7 }, 0.1)];
}

function pig(r, hurt) {
    const out = zeros(hurt ? 0.9 : 1.2);
    const grunt = [[430, 150, 1], [1080, 260, 0.6], [2250, 420, 0.25]];
    if (hurt) {
        // A squeal.
        const k = r.range(0.9, 1.1);
        add(out, voice(r, {
            dur: r.range(0.45, 0.65), rough: 0.3, jitter: 0.03, shimmer: 0.12, breath: 0.1, tilt: 4,
            f0: through(520 * k, 980 * k, 1080 * k, 760 * k),
            formants: mouth([[900, 250, 1], [1900, 350, 0.8], [3100, 500, 0.4]], [[1300, 300, 1], [2500, 400, 0.9], [3600, 600, 0.4]]),
            env: held(0.06, 0.4),
        }), 0.005);
    } else {
        let t = 0.005;
        for (let i = 0, n = Math.round(r.range(2, 4)); i < n; i++) {
            const k = r.range(0.85, 1.15), dur = r.range(0.11, 0.22);
            add(out, voice(r, {
                dur, rough: 0.6, jitter: 0.09, shimmer: 0.25, breath: 0.28, tilt: 9,
                f0: through(74 * k, 92 * k, 66 * k),
                formants: () => grunt,
                env: held(0.2, 0.5),
            }), t, r.range(0.6, 1));
            t += dur + r.range(0.03, 0.12);
        }
    }
    return [inSpace(filt(out, 'hp', 50), { t60: 0.4, size: 0.7 }, 0.1)];
}

function chicken(r, hurt) {
    const out = zeros(hurt ? 0.6 : 1.3);
    const beak = [[1250, 260, 1], [2650, 380, 0.7], [3900, 600, 0.3]];
    const cluck = (t, dur, lo, hi, gain) => add(out, voice(r, {
        dur, rough: 0.35, jitter: 0.05, shimmer: 0.18, breath: 0.16, tilt: 6,
        f0: through(lo, hi, lo * 1.08),
        formants: () => beak, env: held(0.15, 0.5),
    }), t, gain);
    if (hurt) {
        const k = r.range(0.9, 1.1);
        cluck(0.005, r.range(0.25, 0.36), 640 * k, 1020 * k, 1);
    } else {
        let t = 0.005;
        const n = Math.round(r.range(3, 5)), k = r.range(0.9, 1.1);
        for (let i = 0; i < n; i++) {
            const last = i === n - 1 && r() < 0.6;
            const dur = last ? r.range(0.2, 0.3) : r.range(0.055, 0.085);
            cluck(t, dur, 390 * k, (last ? 720 : 540) * k, last ? 1 : r.range(0.5, 0.8));
            t += dur + r.range(0.07, 0.16);
        }
    }
    return [inSpace(filt(out, 'hp', 250), { t60: 0.35, size: 0.6 }, 0.08)];
}

/** A Quiddle, without words: a hum with the mouth shut, or a short cry. */
function person(r, kind) {
    const k = r.range(0.85, 1.35);
    const HUM = [[250, 80, 1], [1050, 180, 0.07], [2300, 300, 0.02]], AH = [[720, 120, 1], [1180, 140, 0.6], [2600, 260, 0.2]];
    const UH = [[560, 110, 1], [1000, 130, 0.5], [2500, 260, 0.15]];
    let v;
    if (kind === 'idle') {
        // "Hm", "hm-hm", or a "hm?" that rises.
        const rise = r() < 0.4;
        v = voice(r, {
            dur: r.range(0.3, 0.5), jitter: 0.01, shimmer: 0.05, breath: 0.03, tilt: 2.5,
            f0: rise ? through(118 * k, 122 * k, 165 * k) : through(132 * k, 140 * k, 112 * k),
            formants: () => HUM, env: held(0.2, 0.45),
        });
    } else {
        v = voice(r, {
            dur: r.range(0.22, 0.34), rough: 0.25, jitter: 0.03, shimmer: 0.12, breath: 0.2, tilt: 5,
            f0: through(175 * k, 190 * k, 128 * k),
            formants: mouth(AH, UH), env: held(0.08, 0.5),
        });
    }
    return [inSpace(filt(v, 'hp', 80), { t60: 0.4, size: 0.6 }, 0.08)];
}

// ── Things the player does ───────────────────────────────────────────────────

function playerHurt(r) {
    const out = person(r, 'hurt')[0], full = zeros(0.6);
    add(full, out, 0.01, 0.9);
    thump(full, 0.002, 95, 1.2, 0.035, 0.7);                 // the blow landing
    hiss(full, r, 0.002, 300, 2400, 0.002, 0.03, 0.4);
    return [full];
}
function fall(r) {
    const out = zeros(0.6);
    thump(out, 0.003, 58, 1.5, 0.06, 1);
    thump(out, 0.02, 110, 0.6, 0.03, 0.4);
    hiss(out, r, 0.003, 200, 1800, 0.004, 0.06, 0.5);       // clothes and limbs
    grains(out, r, 0.01, { count: 8, spread: 0.12, freq: [800, 3000], decay: [0.001, 0.004], gain: 0.12 });
    return [out];
}
function eat(r) {
    // One bite, heard from inside the head: a crunch with the top taken off it.
    const out = zeros(0.4);
    grains(out, r, 0.004, { count: 22, spread: 0.11, early: 1.2, freq: [600, 3400], decay: [0.001, 0.005], gain: 0.3 });
    hiss(out, r, 0.004, 250, 1900, 0.01, 0.05, 0.35);
    thump(out, 0.006, 130, 0.5, 0.02, 0.3);
    return [filt(out, 'lp', 3800)];
}
function pickup(r) {
    // A small thing caught in the hand and dropped in a pouch.
    const out = zeros(0.3), k = r.range(0.94, 1.06);
    hiss(out, r, 0.002, 1200, 6000, 0.003, 0.018, 0.35);
    ring(out, 0.004, [[610 * k, 0.03, 0.5], [1240 * k, 0.02, 0.3], [2050 * k, 0.012, 0.15]], 0.6, r);
    thump(out, 0.03, 190, 0.5, 0.015, 0.3);
    return [out];
}
function swing(r) {
    // An arm through the air: a breath of noise that rises and falls.
    const n = secs(0.3), k = r.range(0.9, 1.1);
    const x = filt(white(n, r), 'bp', (t) => (500 + 1700 * Math.sin(Math.PI * clamp(t / 0.22, 0, 1)) ** 2) * k, 1.6);
    return [shape(x, (t) => Math.sin(Math.PI * clamp(t / 0.24, 0, 1)) ** 2)];
}
function punch(r) {
    const out = zeros(0.4), k = r.range(0.9, 1.1);
    thump(out, 0.002, 105 * k, 1.6, 0.03, 1);
    hiss(out, r, 0.002, 500, 4200, 0.0015, 0.022, 0.75);     // the slap of it
    thump(out, 0.004, 210 * k, 0.8, 0.012, 0.4);
    return [out];
}
function bowDraw(r) {
    // Wood and string taking the strain: creaks, closer together as it tightens.
    const out = zeros(0.7);
    let t = 0.01, gap = 0.05;
    while (t < 0.6) {
        const f = r.range(240, 420) * (1 + t);
        ring(out, t, [[f, 0.008, 1], [f * 2.1, 0.005, 0.5], [f * 3.4, 0.003, 0.3]], r.range(0.1, 0.25), r);
        t += gap * r.range(0.6, 1.3);
        gap *= 0.93;
    }
    hiss(out, r, 0.01, 700, 2600, 0.3, 0.2, 0.05);
    return [out];
}
function bowShoot(r) {
    // The string let go — a plucked string, damped by the bow — and the arrow leaving.
    const out = zeros(0.6), f = r.range(150, 180), d = Math.round(SR / f), line = new Float32Array(d);
    for (let i = 0; i < d; i++) line[i] = r() * 2 - 1;
    let p = 0, prev = 0;
    for (let i = 0; i < secs(0.35); i++) {
        const v = line[p], nv = (v + prev) * 0.5 * 0.975;
        prev = v; line[p] = nv;
        if (++p === d) p = 0;
        out[i] += v * 0.5;
    }
    add(out, swing(r)[0], 0.01, 0.5);
    thump(out, 0.001, 240, 0.5, 0.01, 0.4);
    return [filt(out, 'lp', 5000)];
}
function arrowHit(r) {
    const out = zeros(0.5), k = r.range(0.9, 1.1);
    thump(out, 0.002, 150 * k, 1, 0.02, 0.8);
    ring(out, 0.002, [[340 * k, 0.03, 0.5], [870 * k, 0.02, 0.35], [1630 * k, 0.012, 0.2]], 0.7, r);
    hiss(out, r, 0.002, 1000, 6000, 0.001, 0.012, 0.5);
    // The shaft quivering after.
    const q = shape(filt(white(secs(0.22), r), 'bp', 95 * k, 12), (t) => Math.exp(-t / 0.06));
    add(out, q, 0.006, 1.6);
    return [out];
}
function click(r) {
    // A wooden button: quiet, short, and not a beep.
    const out = zeros(0.12);
    ring(out, 0.001, [[1180, 0.007, 0.6], [2240, 0.005, 0.4], [3560, 0.003, 0.2], [420, 0.012, 0.35]], 0.7, r);
    hiss(out, r, 0.001, 1500, 7000, 0.0006, 0.004, 0.25);
    return [out];
}

// ── Ambience (stereo, and each one loops without a join) ─────────────────────

const stereo = (s) => [zeros(s), zeros(s)];
/** Add a mono sound into both ears: `pan` −1 left … 1 right, the further ear a little late. */
function placeAt(st, x, at, pan, gain) {
    const a = (pan + 1) * Math.PI / 4, late = Math.abs(pan) * 0.0005;
    add(st[0], x, at + (pan > 0 ? late : 0), Math.cos(a) * gain);
    add(st[1], x, at + (pan < 0 ? late : 0), Math.sin(a) * gain);
}
/** Make a stretch loop: its last `x` seconds are folded back over its first. */
function looped(st, x = 1.5) {
    const nx = secs(x), n = st[0].length - nx;
    return st.map((c) => {
        const out = c.slice(0, n);
        for (let i = 0; i < nx; i++) {
            const k = i / nx;
            out[i] = c[i] * Math.sqrt(k) + c[n + i] * Math.sqrt(1 - k);
        }
        return out;
    });
}
function wetStereo(st, opts, mix) {
    return st.map((c, i) => inSpace(c, { ...opts, offset: i * 23 }, mix));
}

/** One note of birdsong: a whistle whose pitch moves, with a little of the octave above. */
function whistle(dur, f, { vib = 0, vibHz = 0, sharp = 2 } = {}) {
    const n = secs(dur), x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        ph += TAU * f(t) * (1 + vib * Math.sin(TAU * vibHz * i / SR)) / SR;
        const e = Math.sin(Math.PI * t) ** (1 / sharp) * smooth(t * 8) * smooth((1 - t) * 6);
        x[i] = (Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.05 * Math.sin(3 * ph)) * e;
    }
    return x;
}
const BIRDS = {
    // Two notes over and over, the first the higher: a tit.
    tit(r) {
        const out = zeros(2.2), hi = r.range(3900, 4500), lo = hi * r.range(0.74, 0.8);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(3, 6)); i < n; i++) {
            add(out, whistle(0.1, () => hi), t, 1); t += 0.14;
            add(out, whistle(0.12, (u) => lo * (1 - 0.03 * u)), t, 0.9); t += 0.2;
        }
        return out;
    },
    // A run of quick slides up and down, no two alike: a warbler.
    warbler(r) {
        const out = zeros(2.4);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(6, 11)); i < n; i++) {
            const a = r.range(2500, 5600), b = r.range(2500, 5600), d = r.range(0.05, 0.11);
            add(out, whistle(d, (u) => lerp(a, b, smooth(u))), t, r.range(0.6, 1));
            t += d + r.range(0.02, 0.07);
        }
        return out;
    },
    // Short falling chips: a sparrow.
    sparrow(r) {
        const out = zeros(1.2);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(2, 5)); i < n; i++) {
            const top = r.range(4600, 5600);
            add(out, whistle(0.06, (u) => top * (1 - 0.4 * u), { sharp: 3 }), t, r.range(0.7, 1));
            t += r.range(0.12, 0.3);
        }
        return out;
    },
    // Slow, low and round, three or four notes: a dove.
    dove(r) {
        const out = zeros(2.6), f = r.range(440, 520);
        let t = 0;
        for (const [d, k, g] of [[0.32, 1, 0.8], [0.5, 1.07, 1], [0.3, 0.98, 0.8], [0.3, 0.96, 0.6]]) {
            add(out, whistle(d, (u) => f * k * (1 + 0.03 * Math.sin(Math.PI * u)), { sharp: 1.2, vib: 0.01, vibHz: 24 }), t, g);
            t += d + 0.16;
        }
        return out;
    },
    // A few clear, fluting notes with a waver in them: a blackbird.
    blackbird(r) {
        const out = zeros(2.6);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(4, 7)); i < n; i++) {
            const a = r.range(1700, 3100), b = a * r.range(0.82, 1.25), d = r.range(0.13, 0.26);
            add(out, whistle(d, (u) => lerp(a, b, smooth(u)), { vib: 0.012, vibHz: r.range(18, 30), sharp: 1.5 }), t, r.range(0.7, 1));
            t += d + r.range(0.04, 0.12);
        }
        return out;
    },
};
function birds(r) {
    const len = 26, st = stereo(len + 1.5);
    const kinds = Object.keys(BIRDS);
    // Each bird keeps to its own perch: a side, a distance, a song it repeats.
    for (let b = 0; b < 7; b++) {
        const kind = kinds[b % kinds.length], pan = r.range(-0.9, 0.9), near = r.range(0.12, 1);
        const cut = 2500 + 9000 * near;
        for (let t = r.range(0, 6); t < len; t += r.range(3.5, 9)) {
            const song = filt(BIRDS[kind](rng(seedOf(kind) + b * 97 + Math.round(t * 10))), 'lp', cut);
            placeAt(st, song, t, pan, (0.2 * near + 0.03) * (kind === 'dove' ? 0.4 : 1));
        }
    }
    // The air itself, barely there.
    for (const c of st) add(c, filt(pink(c.length, r), 'lp', 900), 0, 0.018);
    return looped(wetStereo(st, { t60: 0.9, size: 1.4, damp: 0.5 }, 0.22));
}

function crickets(r) {
    const len = 14, st = stereo(len + 1.5);
    for (let c = 0; c < 6; c++) {
        const f = r.range(4250, 5150), every = r.range(0.42, 0.62), pan = r.range(-0.95, 0.95), near = r.range(0.2, 1);
        const pulses = Math.round(r.range(3, 4));
        // A chirp: a few strokes of the wing, each a burst of the wing's one note.
        const chirp = zeros(0.1);
        for (let p = 0; p < pulses; p++) {
            const n = secs(0.011), o = Math.round(p * 0.0195 * SR);
            for (let i = 0; i < n; i++) chirp[o + i] += Math.sin(TAU * f * i / SR) * Math.sin(Math.PI * i / n) ** 0.7;
        }
        for (let t = r.range(0, every); t < len + 1; t += every * r.range(0.97, 1.03)) {
            if (r() < 0.06) { t += every * r.range(2, 5); continue; }    // it stops to listen
            placeAt(st, chirp, t, pan, 0.11 * near);
        }
    }
    // Further off, the steady trill of tree crickets.
    for (let c = 0; c < 2; c++) {
        const f = r.range(2900, 3400), rate = r.range(36, 46), pan = c ? 0.6 : -0.6, x = zeros(len + 1.5);
        for (let i = 0; i < x.length; i++) {
            const t = i / SR;
            x[i] = Math.sin(TAU * f * t) * Math.max(0, Math.sin(TAU * rate * t)) ** 2 * (0.6 + 0.4 * Math.sin(TAU * 0.11 * t + c));
        }
        placeAt(st, x, 0, pan, 0.02);
    }
    for (const c of st) add(c, filt(pink(c.length, r), 'lp', 700), 0, 0.015);
    return looped(wetStereo(st, { t60: 0.7, size: 1.2, damp: 0.6 }, 0.12));
}

function cave(r) {
    const len = 18, st = stereo(len + 2);
    // Air moving through passages: a low note that is never quite the same.
    st.forEach((c, i) => {
        const a = r.range(0, TAU), b = r.range(0, TAU);
        const air = filt(brown(c.length, r), 'bp', (t) => 85 + 30 * Math.sin(TAU * 0.07 * t + a) + 14 * Math.sin(TAU * 0.19 * t + b), 2.2);
        const low = filt(brown(c.length, r), 'lp', 140);
        for (let k = 0; k < c.length; k++) {
            const t = k / SR;
            c[k] += (air[k] * 1.3 + low[k] * 0.5) * (0.65 + 0.35 * Math.sin(TAU * 0.045 * t + a + i));
        }
    });
    // Water dripping into pools, each drop a note of its own, far off in the dark.
    const drips = stereo(len + 2);
    for (let t = r.range(0.5, 2); t < len; t += r.range(1.2, 4.5)) {
        const d = zeros(0.2), f = r.log(700, 1900);
        hiss(d, r, 0, 2000, 9000, 0.0004, 0.002, 0.3);
        bubble(d, 0.004, f, r.range(0.05, 0.09), 1);
        placeAt(drips, d, t, r.range(-0.9, 0.9), r.range(0.03, 0.12));
    }
    const wet = wetStereo(drips, { t60: 3.2, size: 2.3, damp: 0.3 }, 2.2);
    st.forEach((c, i) => add(c, wet[i]));
    return looped(st, 2);
}

function water(r) {
    const len = 12, st = stereo(len + 1.5);
    st.forEach((c) => {
        // Wavelets coming in a little out of step with one another.
        for (let b = 0; b < 4; b++) {
            const f = r.log(350, 2800), rate = r.range(0.22, 0.5), ph = r.range(0, TAU);
            const x = filt(pink(c.length, r), 'bp', f, 1.1);
            for (let i = 0; i < c.length; i++) {
                const t = i / SR;
                c[i] += x[i] * (0.25 + 0.75 * Math.max(0, Math.sin(TAU * rate * t + ph)) ** 2) * 0.5;
            }
        }
    });
    for (let t = 0; t < len + 1; t += r.range(0.03, 0.22)) {
        const b = zeros(0.08);
        bubble(b, 0, r.log(450, 2200), r.range(0.015, 0.05), 1);
        placeAt(st, b, t, r.range(-1, 1), r.range(0.01, 0.045));
    }
    return looped(st);
}

function underwater(r) {
    const len = 12, st = stereo(len + 1.5);
    st.forEach((c, i) => {
        const x = filt(brown(c.length, r), 'lp', (t) => 190 + 60 * Math.sin(TAU * 0.09 * t + i * 2), 1.2);
        for (let k = 0; k < c.length; k++) c[k] += x[k] * (0.7 + 0.3 * Math.sin(TAU * 0.13 * (k / SR) + i)) * 1.6;
    });
    for (let t = 0.5; t < len + 1; t += r.range(0.4, 1.8)) {
        const b = zeros(0.2);
        bubble(b, 0, r.log(180, 520), r.range(0.05, 0.12), 1);
        placeAt(st, b, t, r.range(-0.8, 0.8), r.range(0.03, 0.1));
    }
    return looped(st.map(c => filt(c, 'lp', 900)));
}

// ── Thunder ──────────────────────────────────────────────────────────────────

/**
 * Thunder from a stroke `dist` metres away. The channel runs from the ground
 * up into the cloud, wandering, with branches; every few metres of it is a
 * source that goes off at the same instant. Each is heard after its distance
 * over the speed of sound, weaker by that distance, and as a slower pulse the
 * further it came (the air takes the top off it) — a short one is a crack, a
 * long one a boom. Two ears twenty metres apart hear them at slightly
 * different times, which is all the stereo there is. Then the land answers.
 */
function thunder(r, dist, len) {
    const C = 343, ears = [-10, 10], st = stereo(len);
    const sources = [];
    const channel = (x, y, z, dx, dy, dz, length, strength, depth) => {
        const stepLen = 4;
        for (let s = 0; s < length; s += stepLen) {
            // It wanders: the direction is nudged at every step, and kept going up.
            dx += r.gauss() * 0.28; dy += r.gauss() * 0.28; dz += r.gauss() * 0.16;
            const m = Math.hypot(dx, dy, dz) || 1;
            dx /= m; dy /= m; dz /= m;
            if (depth === 0 && dz < 0.25) dz = 0.25;
            x += dx * stepLen; y += dy * stepLen; z += dz * stepLen;
            if (z < 0) z = 0;
            sources.push([x, y, z, strength * Math.exp(r.gauss() * 0.7)]);
            if (depth < 2 && r() < (depth === 0 ? 0.02 : 0.012)) {
                channel(x, y, z, r.gauss(), r.gauss(), r.range(-0.6, 0.3), r.range(150, 700), strength * 0.45, depth + 1);
            }
        }
    };
    const bearing = r.range(0, TAU);
    channel(dist * Math.cos(bearing), dist * Math.sin(bearing), 0, r.gauss() * 0.2, r.gauss() * 0.2, 1, r.range(2200, 3400), 1, 0);

    let first = Infinity;
    for (const s of sources) first = Math.min(first, Math.hypot(s[0], s[1], s[2]));
    for (let e = 0; e < 2; e++) {
        const out = st[e];
        for (const [x, y, z, a] of sources) {
            const d = Math.hypot(x - ears[e] * Math.sin(bearing), y + ears[e] * Math.cos(bearing), z);
            const at = (d - first) / C + 0.02;
            if (at >= len) continue;
            // The pulse: one push and one pull (a Gaussian's slope), wider with distance.
            const sigma = 0.00011 + d * 1.6e-6, n = Math.ceil(sigma * 7 * SR), o = Math.round(at * SR), g = a * 60 / (d + 60) * (r() < 0.5 ? -1 : 1);
            for (let i = -n; i <= n; i++) {
                const k = o + i;
                if (k < 0 || k >= out.length) continue;
                const u = i / (sigma * SR);
                out[k] += -u * Math.exp(-0.5 * u * u) * g;
            }
        }
    }
    // Close to, the air itself is torn: under the crack there is a hiss, which
    // does not carry.
    if (dist < 500) {
        const tear = (1 - dist / 500) ** 2;
        st.forEach((c, e) => {
            const env = new Float32Array(c.length);
            let v = 0;
            for (let i = 0; i < c.length; i++) { v = Math.max(Math.abs(c[i]), v * 0.9993); env[i] = v; }
            const n = band(white(c.length, rng(seedOf('tear') + e + Math.round(dist))), 1500, 9000);
            for (let i = 0; i < c.length; i++) c[i] += n[i] * env[i] * 0.5 * tear;
        });
    }
    // The land answers: hills and cloud send the sound back, long and dull.
    const dry = st.map(c => filt(c, 'hp', 22));
    const wetA = dry.map((c, i) => reverb(filt(c, 'lp', 900), { t60: 4.5, size: 3.1, damp: 0.55, offset: i * 31 }));
    const out = dry.map((c, i) => {
        const y = new Float32Array(c.length), far = clamp(dist / 1500, 0.15, 1);
        for (let k = 0; k < c.length; k++) y[k] = c[k] + wetA[i][k] * (0.5 + 1.2 * far);
        // What is far off has lost its top altogether.
        return dist > 500 ? filt(y, 'lp', clamp(2600 - dist, 350, 2200)) : y;
    });
    return out.map(c => fade(c, 0.001, Math.min(2.5, len * 0.35)));
}

// ── Writing them out ─────────────────────────────────────────────────────────

function wav(chans) {
    const n = chans[0].length, ch = chans.length, buf = Buffer.alloc(44 + n * ch * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
    for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) {
        buf.writeInt16LE(Math.round(clamp(chans[c][i], -1, 1) * 32767), o);
    }
    return buf;
}

let written = 0, bytes = 0;
/**
 * Make one sound and write it. `level` is its peak, 0 … 1; `loop` keeps its
 * length exactly (a loop must not be trimmed).
 */
function emit(dir, name, make, { level = 0.85, loop = false, quality = 4 } = {}) {
    if (ONLY.length && !ONLY.some(o => name.startsWith(o))) return;
    let chans = make(rng(seedOf(name)));
    if (!loop) chans = trim(chans);
    const p = Math.max(...chans.map(peak)) || 1;
    for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= level / p;
    const folder = path.join(OUT, dir);
    fs.mkdirSync(folder, { recursive: true });
    const wavPath = path.join(folder, `${name}.wav`), oggPath = path.join(folder, `${name}.ogg`);
    fs.writeFileSync(wavPath, wav(chans));
    let file = wavPath;
    if (HAVE_FFMPEG) {
        const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', String(quality), oggPath]);
        if (res.status === 0) { fs.unlinkSync(wavPath); file = oggPath; }
    } else if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
    written++; bytes += fs.statSync(file).size;
    console.log(`${dir}/${path.basename(file).padEnd(28)} ${(chans[0].length / SR).toFixed(2).padStart(6)} s  ${String(chans.length)} ch  rms ${rms(chans[0]).toFixed(3)}`);
}

for (const g of Object.keys(GROUND)) {
    for (let i = 1; i <= 4; i++) emit('blocks', `${g}_step_${i}`, (r) => step(g, r), { level: 0.7 });
    for (let i = 1; i <= 3; i++) emit('blocks', `${g}_hit_${i}`, (r) => hit(g, r), { level: 0.8 });
    for (let i = 1; i <= 2; i++) emit('blocks', `${g}_break_${i}`, (r) => breakUp(g, r), { level: 0.9 });
    for (let i = 1; i <= 2; i++) emit('blocks', `${g}_place_${i}`, (r) => place(g, r), { level: 0.8 });
}
for (let i = 1; i <= 2; i++) emit('blocks', `water_splash_${i}`, (r) => splash(r, true), { level: 0.9 });
for (let i = 1; i <= 3; i++) emit('blocks', `water_swim_${i}`, (r) => splash(r, false), { level: 0.6 });

const VOICES = { cow, sheep, pig, chicken };
for (const [name, fn] of Object.entries(VOICES)) {
    for (let i = 1; i <= 3; i++) emit('entities', `${name}_idle_${i}`, (r) => fn(r, false), { level: 0.8 });
    for (let i = 1; i <= 2; i++) emit('entities', `${name}_hurt_${i}`, (r) => fn(r, true), { level: 0.85 });
}
for (let i = 1; i <= 4; i++) emit('entities', `quiddle_idle_${i}`, (r) => person(r, 'idle'), { level: 0.6 });
for (let i = 1; i <= 3; i++) emit('entities', `quiddle_hurt_${i}`, (r) => person(r, 'hurt'), { level: 0.8 });
for (let i = 1; i <= 3; i++) emit('entities', `player_hurt_${i}`, playerHurt, { level: 0.85 });
for (let i = 1; i <= 2; i++) emit('entities', `fall_${i}`, fall, { level: 0.9 });
for (let i = 1; i <= 3; i++) emit('entities', `eat_${i}`, eat, { level: 0.7 });
for (let i = 1; i <= 2; i++) emit('entities', `pickup_${i}`, pickup, { level: 0.55 });
for (let i = 1; i <= 3; i++) emit('entities', `swing_${i}`, swing, { level: 0.45 });
for (let i = 1; i <= 3; i++) emit('entities', `punch_${i}`, punch, { level: 0.85 });
emit('entities', 'bow_draw', bowDraw, { level: 0.5 });
for (let i = 1; i <= 2; i++) emit('entities', `bow_shoot_${i}`, bowShoot, { level: 0.75 });
for (let i = 1; i <= 2; i++) emit('entities', `arrow_hit_${i}`, arrowHit, { level: 0.8 });

emit('ui', 'click', click, { level: 0.5 });

emit('ambiant', 'birds', birds, { level: 0.7, loop: true });
emit('ambiant', 'crickets', crickets, { level: 0.55, loop: true });
emit('ambiant', 'cave', cave, { level: 0.7, loop: true });
emit('ambiant', 'water', water, { level: 0.6, loop: true });
emit('ambiant', 'underwater', underwater, { level: 0.75, loop: true });
// A near stroke is louder than anything can play: it is let press against the
// ceiling a little (`drive`), as it does against the ear.
const thunderTake = (lo, hi, len, drive) => (r) => {
    const st = thunder(r, r.range(lo, hi), len), p = Math.max(...st.map(peak)) || 1;
    return st.map((c) => { for (let k = 0; k < c.length; k++) c[k] *= drive / p; return soften(c); });
};
for (let i = 1; i <= 3; i++) emit('ambiant', `thunder_close_${i}`, thunderTake(60, 220, 9, 1.9), { level: 0.95, quality: 5 });
for (let i = 1; i <= 3; i++) emit('ambiant', `thunder_mid_${i}`, thunderTake(400, 900, 11, 1.3), { level: 0.9, quality: 5 });
for (let i = 1; i <= 2; i++) emit('ambiant', `thunder_far_${i}`, thunderTake(1400, 2600, 12, 1), { level: 0.8, quality: 5 });

console.log(`\n${written} sounds, ${(bytes / 1024).toFixed(0)} KB, in ${OUT}${HAVE_FFMPEG ? '' : '  (WAV: ffmpeg not found)'}`);
