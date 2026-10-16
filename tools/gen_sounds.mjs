// Makes the game's sounds (data/sounds/blocks, entities, ambiant, ui).
//
//   node tools/gen_sounds.mjs [name …] [--wav]          (npm run sounds)
//
// Nothing here is a recording, and nothing may sound like a machine either:
// each sound is built the way the thing itself makes it, at 44.1 kHz, and kept
// soft. What made the first set harsh is written down here so it stays out:
//
//   • No bare sine for anything that is not a whistle or a bubble. A grain of
//     grit, a board, a pane of glass is a short breath of noise through what
//     resonates (`ring`, `grains`) — a pure tone of a few thousandths of a
//     second is a blip, and forty of them are a modem.
//   • Nothing bright and dry. Every one-shot ends through `finish`: the top
//     taken off, the first thousandth of a second eased in, a little air round
//     it. The air is a real decay (noise dying away, convolved), not a handful
//     of comb filters, which ring like a tin.
//   • Quiet. Levels are well under full scale; a footstep is not an event.
//
//   • A footstep is a heel and then the ball of the foot; each is the dull
//     knock of a body's weight plus what the ground does — blades brushing,
//     grit turning, a board knocking, snow creaking.
//   • A voice is a throat and a mouth: a pulse train with the jitter and the
//     roughness of a real larynx, through resonances that move as the mouth
//     does. Every take of an animal is a different thing it says — a long moo,
//     a low murmur, a call that breaks — not one call at three pitches.
//   • Rain is a soft wash with drops on it: tens of thousands of them, each a
//     soft tick of its own colour, none nearer than a few metres. The wash
//     alone hissed, and the drops alone crackled.
//   • The weight of a foot is low noise, not a note (`body`); a board or a
//     rock that is knocked rings cleanly on a few low notes for a few
//     hundredths of a second (`ring` with `tone`).
//   • Birds are far off, in trees, and say little.
//
// Thunder is not here: it is made as it happens (src/scripts/WeatherAudio.js).
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
 * A dull knock: a low note dying fast, eased in over a few thousandths of a
 * second (a foot is soft), and starting only a shade sharp (`drop`) — any
 * more and it is a drum machine, not a foot.
 */
function thump(out, at, f, drop, decay, gain) {
    const n = secs(decay * 7), o = Math.round(at * SR);
    let ph = 0;
    for (let i = 0; i < n && i + o < out.length; i++) {
        const t = i / SR;
        ph += TAU * f * (1 + drop * 0.12 * Math.exp(-t / 0.005)) / SR;
        out[i + o] += Math.sin(ph) * Math.exp(-t / decay) * smooth(t / 0.004) * gain;
    }
}
/**
 * Something ringing: [frequency, time constant, level] each — a resonance
 * set going by a strike a cycle or two long. `tone` says what the strike is:
 * 0, a breath of noise (grit, glass: no two alike, none a pure note); 1, one
 * clean push (a board, a rock: a hard thing knocked does ring on its own
 * notes, and noise there makes it fuzz instead of knock).
 */
function ring(out, at, modes, gain, r = null, tone = 0) {
    const o = Math.round(at * SR), rr = r ?? rng(seedOf('ring') + Math.round(at * 1e5));
    for (const [f, d, a] of modes) {
        const n = secs(d * 7), w = TAU * f / SR;
        // A two-pole resonator whose ring dies with time constant d.
        const rad = Math.exp(-1 / (d * SR)), a1 = -2 * rad * Math.cos(w), a2 = rad * rad;
        const push = Math.max(8, Math.round(SR / f * 1.5));        // the strike lasts a cycle or two
        const norm = Math.sin(w) / Math.sqrt(push / 12);          // as loud whatever the note
        const clean = tone * Math.sqrt(push / 12) * 4 / push;
        let y1 = 0, y2 = 0;
        for (let i = 0; i < n && i + o < out.length; i++) {
            const win = i < push ? Math.sin(Math.PI * i / push) : 0;
            const x = win * ((rr() * 2 - 1) * (1 - tone) + clean);
            const y = x - a1 * y1 - a2 * y2;
            y2 = y1; y1 = y;
            out[i + o] += y * norm * a * gain;
        }
    }
}
/**
 * The weight of something landing, as a thing with no note: low noise, up in
 * a few thousandths of a second and gone in a few hundredths. A foot on earth
 * is this and not a drum — `thump` alone, a sine, is what a drum machine does.
 */
function body(out, r, at, f, decay, gain) {
    const n = secs(0.006 + decay * 7);
    const x = shape(filt(filt(white(n, r), 'lp', f * 2.2, 0.6), 'lp', f * 3, 0.6), strike(0.005, decay));
    add(out, x, at, gain * 3.2);
    thump(out, at, f, 0.5, decay * 0.8, gain * 0.35);
}
/**
 * Many small things giving way one after another — grit, blades, crystals:
 * `count` grains over `spread` seconds (most of them early when `early` > 1),
 * each a tick of noise in a band of its own between the two frequencies.
 */
function grains(out, r, at, { count, spread, early = 1.6, freq, decay, gain }) {
    for (let k = 0; k < count; k++) {
        const t = at + spread * r() ** early;
        const f = r.log(freq[0], freq[1]), d = r.range(decay[0], decay[1]) * 1.6;
        const n = secs(d * 6), o = Math.round(t * SR), g = gain * r.range(0.3, 1) * (1 - 0.6 * (t - at) / spread) * 2.2;
        // Noise through a wide band-pass (two one-pole filters), up in half a millisecond.
        const kl = 1 - Math.exp(-TAU * f * 1.5 / SR), kh = 1 - Math.exp(-TAU * f * 0.6 / SR);
        let lp = 0, hp = 0;
        for (let i = 0; i < n && i + o < out.length; i++) {
            const tt = i / SR;
            lp += ((r() * 2 - 1) - lp) * kl;
            hp += (lp - hp) * kh;
            if (i + o >= 0) out[i + o] += (lp - hp) * Math.exp(-tt / d) * Math.min(1, tt / 0.0005) * g;
        }
    }
}
/** A burst of noise between two frequencies, up in `a` and away in `d`. */
function hiss(out, r, at, lo, hi, a, d, gain) {
    const x = shape(band(white(secs(a + d * 6), r), lo, hi), strike(a, d));
    add(out, x, at, gain);
}

// ── Air ──────────────────────────────────────────────────────────────────────

/** In-place radix-2 FFT of (re, im); `inv` for the inverse (unscaled). */
function fft(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inv ? -TAU : TAU) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k, b = a + half;
                const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}
function convolve(x, h) {
    const m = x.length + h.length - 1;
    let n = 1; while (n < m) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(x); br.set(h);
    fft(ar, ai, false); fft(br, bi, false);
    for (let i = 0; i < n; i++) {
        const r = ar[i] * br[i] - ai[i] * bi[i];
        ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r;
    }
    fft(ar, ai, true);
    const y = new Float32Array(m);
    for (let i = 0; i < m; i++) y[i] = ar[i] / n;
    return y;
}
/**
 * What a place does to a sound, as the sound it would make of one clap: noise
 * dying away over `t60` seconds, the top of it faster (`damp` 0 … 1), building
 * up over the first hundredth of a second. That is what a wood, a room or a
 * cave gives back — thousands of reflections, none of them to be picked out.
 * (Four comb filters stood in for it once, and rang like a tin.)
 */
const _places = new Map();
function clap({ t60 = 1.2, damp = 0.5, offset = 0 }) {
    const key = `${t60}/${damp}/${offset}`;
    let h = _places.get(key);
    if (h) return h;
    const r = rng(seedOf('place' + key)), n = secs(t60 * 1.15);
    const w = white(n, r), low = filt(w, 'lp', 1100, 0.6);
    h = new Float32Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) {
        const t = i / SR, up = smooth(t / 0.012);
        h[i] = (low[i] * Math.exp(-6.91 * t / t60) + (w[i] - low[i]) * 0.7 * Math.exp(-6.91 * t / (t60 * (1 - 0.75 * damp)))) * up;
        e += h[i] * h[i];
    }
    e = Math.sqrt(e) || 1;
    for (let i = 0; i < n; i++) h[i] /= e;
    fade(h, 0, 0.05);
    _places.set(key, h);
    return h;
}
function reverb(x, opts) { return convolve(x, clap(opts)); }
/** The dry sound with a little of a place round it; `keep` holds its length (a loop), else the tail is let ring out. */
function inSpace(x, opts, mix, keep = false) {
    const wet = reverb(x, opts);
    const y = new Float32Array(keep ? x.length : wet.length);
    for (let i = 0; i < y.length; i++) y[i] = (i < x.length ? x[i] : 0) + wet[i] * mix;
    return y;
}

// ── Ground and blocks ────────────────────────────────────────────────────────

/**
 * What each kind of ground does under a weight. `knock`: the weight landing
 * [Hz, level]. `hiss`: brushing or sliding [low Hz, high Hz, seconds, level].
 * `grit`: the grains. `modes`: what rings, if it is hard or hollow, and
 * `tone` how cleanly (see `ring`). `top`: nothing above this is kept, and
 * `level` scales how loud its files are — the soft grounds are both duller
 * and quieter than the hard ones.
 *
 * What each is meant to be, so a change can be judged against it:
 *   grass   a soft press and a brush of blades; no grit to speak of
 *   dirt    a dull, dead thud and a little crumbling — nothing rings
 *   stone   a short hard "tock": a low clack with almost no ring, a scuff of
 *           grit after; struck with a tool, a clack and chips
 *   sand    a hush: the foot sinks, grains slide, and that is all
 *   gravel  stones turning over one another
 *   wood    a hollow knock, a board's few low notes dying in a twentieth of a second
 *   snow    a soft crump as it packs, with a low creak in it
 */
const GROUND = {
    grass:  { knock: [80, 0.55],  hiss: [450, 2000, 0.07, 0.26],  grit: { count: 5,  freq: [900, 2400],  decay: [0.001, 0.003],   gain: 0.05 }, top: 3000, level: 0.72 },
    dirt:   { knock: [95, 0.9],   hiss: [140, 800, 0.05, 0.3],    grit: { count: 6,  freq: [350, 1300],  decay: [0.002, 0.007],   gain: 0.12 }, top: 2800 },
    stone:  { knock: [170, 0.5],  hiss: [700, 2600, 0.014, 0.12], grit: { count: 3,  freq: [1200, 3000], decay: [0.001, 0.003],   gain: 0.07 }, top: 5500, tone: 0.75,
              modes: [[410, 0.009, 0.6], [760, 0.007, 0.5], [1320, 0.005, 0.32], [2150, 0.0035, 0.16]] },
    sand:   { knock: [72, 0.4],   hiss: [350, 1800, 0.1, 0.4],    grit: { count: 10, freq: [900, 2200],  decay: [0.0008, 0.002],  gain: 0.025 }, top: 2600, level: 0.68 },
    gravel: { knock: [92, 0.45],  hiss: [700, 3200, 0.05, 0.2],   grit: { count: 34, freq: [900, 3400],  decay: [0.0016, 0.006],  gain: 0.2 },  top: 5000 },
    wood:   { knock: [150, 0.35], hiss: [500, 1800, 0.01, 0.05],  grit: { count: 1,  freq: [1000, 2200], decay: [0.001, 0.003],   gain: 0.04 }, top: 5000, tone: 0.85,
              modes: [[235, 0.04, 0.7], [388, 0.032, 0.6], [640, 0.022, 0.38], [1040, 0.013, 0.2], [1720, 0.007, 0.1]] },
    snow:   { knock: [68, 0.45],  hiss: [250, 1400, 0.11, 0.4],   grit: { count: 14, freq: [450, 1500],  decay: [0.0012, 0.004],  gain: 0.05 }, top: 2400, level: 0.68, squeak: true },
    leaves: { knock: [70, 0.15],  hiss: [900, 3600, 0.09, 0.3],   grit: { count: 22, freq: [1300, 4000], decay: [0.0006, 0.002],  gain: 0.1 },  top: 4200, level: 0.8 },
    glass:  { knock: [165, 0.3],  hiss: [1800, 5000, 0.012, 0.1], grit: { count: 2,  freq: [2500, 5000], decay: [0.001, 0.002],   gain: 0.06 }, top: 6000, tone: 0.5,
              modes: [[1730, 0.03, 0.45], [3240, 0.022, 0.3], [4650, 0.014, 0.18], [2480, 0.02, 0.2]] },
};

/** One foot coming down: the heel, then the ball of the foot a moment after. */
function step(name, r) {
    const g = GROUND[name], out = zeros(0.5), k = r.range(0.92, 1.08);
    const gap = r.range(0.055, 0.085);
    for (const [at, w] of [[0.004, 1], [0.004 + gap, r.range(0.5, 0.7)]]) {
        body(out, r, at, g.knock[0] * k * (w < 1 ? 1.25 : 1), g.modes ? 0.012 : 0.022, g.knock[1] * w * (g.modes ? 0.5 : 0.6));
        hiss(out, r, at, g.hiss[0], g.hiss[1], 0.008 + g.hiss[2] * 0.35, g.hiss[2], g.hiss[3] * w * 1.5);
        grains(out, r, at + 0.004, { ...g.grit, count: Math.round(g.grit.count * w), spread: 0.02 + g.hiss[2] * 1.3, gain: g.grit.gain * w * 1.5 });
        // A sole is soft: it sets a floor ringing far less than a tool does.
        if (g.modes) ring(out, at, g.modes.map(([f, d, a]) => [f * k * r.range(0.97, 1.03), d * 0.8, a]), 0.3 * w, r, g.tone);
    }
    // Snow packs under the foot with a low creak: a band of noise sliding up a little.
    if (g.squeak) {
        const f0 = r.range(420, 560);
        const sq = shape(filt(white(secs(0.18), r), 'bp', (t) => f0 + 700 * t, 2.2), (t) => Math.sin(Math.PI * clamp(t / 0.18, 0, 1)) ** 1.5);
        add(out, sq, 0.012, 0.3);
    }
    return [out];
}

/** A tool or a hand striking it, once. */
function hit(name, r) {
    const g = GROUND[name], out = zeros(0.5), k = r.range(0.9, 1.1);
    body(out, r, 0.003, g.knock[0] * 1.3 * k, g.modes ? 0.01 : 0.018, g.knock[1] * 0.8);
    hiss(out, r, 0.003, g.hiss[0], g.hiss[1], 0.004, g.hiss[2] * 0.6, g.hiss[3] * 1.5);
    grains(out, r, 0.006, { ...g.grit, count: Math.round(g.grit.count * 0.7) + 2, spread: 0.05 + g.hiss[2] * 0.6, gain: g.grit.gain * 1.7 });
    if (g.modes) ring(out, 0.003, g.modes.map(([f, d, a]) => [f * k, d * 1.4, a]), 0.6, r, g.tone);
    // Rock under a pick: the clack, and chips coming away after it.
    if (name === 'stone') {
        ring(out, 0.003, [[1180 * k, 0.012, 0.3], [1900 * k, 0.008, 0.2]], 0.5, r, 0.6);
        grains(out, r, 0.02, { count: 6, spread: 0.12, freq: [900, 2600], decay: [0.0015, 0.005], gain: 0.09 });
    }
    return [out];
}

/** It gives way: a crack, and what it was made of falling in. */
function breakUp(name, r) {
    const g = GROUND[name], out = zeros(0.9), k = r.range(0.92, 1.08);
    body(out, r, 0.004, g.knock[0] * k, g.modes ? 0.016 : 0.026, g.knock[1] * 0.9);
    hiss(out, r, 0.004, g.hiss[0], g.hiss[1], 0.005, g.hiss[2] * 1.2, g.hiss[3] * 1.8);
    if (name === 'glass') {
        // Shards: each rings on its own note, and they land over a third of a second.
        for (let i = 0; i < 22; i++) {
            const f = r.log(1500, 5500), t = 0.004 + 0.34 * r() ** 1.8;
            ring(out, t, [[f, r.range(0.015, 0.07), 1], [f * 1.9, 0.01, 0.25]], r.range(0.05, 0.16), r);
        }
        hiss(out, r, 0.003, 2000, 7000, 0.0015, 0.03, 0.4);
    } else {
        if (g.modes) ring(out, 0.004, g.modes.map(([f, d, a]) => [f * k * 0.9, d * 1.8, a]), 0.55, r, g.tone);
        if (name === 'wood') {
            // Wood splits: a few sharp cracks along the grain, then the pieces knocking together.
            for (let i = 0; i < 4; i++) {
                const t = 0.004 + 0.09 * r(), f = r.range(700, 1500);
                ring(out, t, [[f, 0.006, 1], [f * 2.3, 0.003, 0.4]], r.range(0.15, 0.35), r, 0.6);
            }
            for (let i = 0; i < 5; i++) {
                const f = r.range(240, 620);
                ring(out, 0.05 + 0.28 * r(), [[f, 0.025, 1], [f * 1.7, 0.016, 0.5]], r.range(0.08, 0.2), r, 0.85);
            }
        } else {
            const debris = { ...g.grit, count: Math.round(g.grit.count * 1.6) + 12, gain: g.grit.gain * 1.8 };
            grains(out, r, 0.01, { ...debris, spread: 0.3, early: 1.3 });
            // The pieces are heavier than grit: a few low knocks as they settle.
            for (let i = 0; i < 4; i++) body(out, r, 0.03 + 0.2 * r(), g.knock[0] * r.range(1.2, 2.2), 0.01, g.knock[1] * r.range(0.12, 0.3));
            // Rock comes apart in lumps that clack on one another.
            if (name === 'stone') for (let i = 0; i < 5; i++) {
                const f = r.range(500, 1500);
                ring(out, 0.04 + 0.25 * r(), [[f, 0.007, 1], [f * 1.8, 0.004, 0.4]], r.range(0.1, 0.25), r, 0.7);
            }
        }
    }
    return [out];
}

/** Set down: one firm knock of the stuff, without the roll of a footstep. */
function place(name, r) {
    const g = GROUND[name], out = zeros(0.4), k = r.range(0.9, 1.06);
    body(out, r, 0.003, g.knock[0] * 0.85 * k, g.modes ? 0.014 : 0.024, g.knock[1] * 0.9);
    hiss(out, r, 0.003, g.hiss[0], g.hiss[1], 0.005, g.hiss[2] * 0.5, g.hiss[3] * 1.1);
    grains(out, r, 0.006, { ...g.grit, count: Math.round(g.grit.count * 0.4) + 1, spread: 0.04, gain: g.grit.gain * 1.3 });
    if (g.modes) ring(out, 0.003, g.modes.map(([f, d, a]) => [f * k * 0.85, d * 1.2, a]), 0.5, r, g.tone);
    return [out];
}

/**
 * Doors and gates, opened and shut. What each is meant to be:
 *   door_open   the latch lifting (a small, dull metal tick), then the hinges
 *               turning — friction sticking and slipping, each slip setting
 *               the door's wood ringing low: a short, soft creak, not a squeal
 *   door_close  the door swinging to (a breath of air), the slab of it meeting
 *               the frame — a hollow wooden knock, the deepest of these — and
 *               the latch dropping into its catch just after
 *   gate_open   a lighter thing: the bolt of a metal latch drawn, a little
 *               creak of thinner wood
 *   gate_close  the rails knocking against the post (higher and shorter than
 *               a door) and the latch falling with a small clank
 */
const DOOR = [[118, 0.05, 1], [196, 0.042, 0.8], [310, 0.032, 0.55], [495, 0.022, 0.32], [790, 0.013, 0.16]];
const GATE = [[240, 0.03, 1], [385, 0.024, 0.7], [610, 0.016, 0.45], [980, 0.01, 0.2]];

/** Hinges turning: `rate` slips a second (from, to), each ringing what it turns in. */
function creak(out, r, at, dur, rate0, rate1, modes, gain) {
    let t = 0;
    while (t < dur) {
        const k = t / dur, env = Math.sin(Math.PI * k) ** 0.8;
        ring(out, at + t, modes.map(([f, d, a]) => [f * r.range(0.97, 1.03), d, a]), gain * env * r.range(0.55, 1), r, 0.65);
        t += 1 / (lerp(rate0, rate1, k) * r.range(0.8, 1.2));
    }
}
/** A latch: a short knock of metal, dull, on a few notes of its own. */
function latch(out, r, at, f, gain) {
    ring(out, at, [[f, 0.006, 1], [f * 1.53, 0.0045, 0.55], [f * 2.31, 0.003, 0.3]], gain, r, 0.55);
    hiss(out, r, at, 1500, 4200, 0.0008, 0.004, gain * 0.25);
}
function doorSound(kind, r) {
    const out = zeros(1.0), k = r.range(0.94, 1.06);
    const wood = (set, s = 1) => set.map(([f, d, a]) => [f * k * s, d, a]);
    if (kind === 'door_open') {
        latch(out, r, 0.004, 1650 * k, 0.32);
        creak(out, r, 0.05, r.range(0.32, 0.45), r.range(48, 60), r.range(80, 105), wood(DOOR, 2.1), 0.075);
        hiss(out, r, 0.08, 180, 900, 0.12, 0.12, 0.05);            // the air it moves
    } else if (kind === 'door_close') {
        hiss(out, r, 0.003, 160, 800, 0.06, 0.05, 0.08);
        const at = 0.07;
        body(out, r, at, 72 * k, 0.03, 1);                             // the slab of it, against the frame
        ring(out, at, wood(DOOR), 0.85, r, 0.85);
        latch(out, r, at + r.range(0.022, 0.035), 1450 * k, 0.4);
        ring(out, at + 0.04, wood(DOOR, 1.04), 0.12, r, 0.85);        // a little rattle in the frame after
    } else if (kind === 'gate_open') {
        latch(out, r, 0.004, 1700 * k, 0.36);
        latch(out, r, 0.02, 1550 * k, 0.2);
        creak(out, r, 0.04, r.range(0.22, 0.3), r.range(60, 72), r.range(95, 120), wood(GATE, 1.5), 0.05);
    } else {
        body(out, r, 0.004, 105 * k, 0.018, 0.6);
        ring(out, 0.004, wood(GATE), 0.75, r, 0.85);
        latch(out, r, 0.018, 1800 * k, 0.45);
        ring(out, 0.05, wood(GATE, 1.06), 0.14, r, 0.85);
    }
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
    hiss(out, r, 0.002, 400, 5500, 0.006, big ? 0.05 : 0.03, big ? 0.6 : 0.3);
    const body = shape(filt(pink(secs(len), r), 'lp', (t) => 3800 * Math.exp(-t / (big ? 0.28 : 0.16)) + 450, 0.8),
        (t) => Math.min(1, t / 0.015) * Math.exp(-t / (big ? 0.3 : 0.16)));
    add(out, body, 0.004, big ? 2.6 : 1.5);
    thump(out, 0.004, big ? 62 : 90, 0.6, 0.05, big ? 0.6 : 0.25);
    for (let i = 0; i < (big ? 22 : 8); i++) {
        bubble(out, 0.03 + (big ? 0.8 : 0.4) * r() ** 1.5, r.log(320, 1300), r.range(0.02, 0.06), r.range(0.02, 0.08));
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
 *   voiced       how much of it is the larynx at all (0: a snort, a sigh)
 *   tremble      [Hz, depth] — a bleat
 */
function voice(r, { dur, f0, formants, env, jitter = 0.012, shimmer = 0.06, rough = 0, breath = 0.04, voiced = 1, tremble = null, tilt = 5 }) {
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
        src[i] = (lp * voiced + air) * (1 + (tremble ? tr * tremble[1] : 0));
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
/** A nose with air going through it: what a snort or a snuffle is shaped by. */
const NOSE = [[480, 300, 1], [1450, 500, 0.55], [2500, 700, 0.22]];

/**
 * Each animal's takes are different things it says, not one call at several
 * pitches: `take` picks which. The game adds a little pitch of its own every
 * time one is played (Sound.js `vary`), and more for a small or a big animal.
 */

// Mouth shapes: [Hz, bandwidth, level] for each resonance.
const COW_M = [[240, 70, 1], [880, 160, 0.2], [2100, 300, 0.08], [3100, 400, 0.03]];
const COW_OO = [[370, 90, 1], [760, 130, 0.7], [2150, 320, 0.3], [3200, 420, 0.12]];
const COW_OH = [[450, 110, 1], [860, 150, 0.8], [2250, 340, 0.4], [3300, 440, 0.16]];

function cow(r, kind, take) {
    const k = r.range(0.95, 1.05), out = zeros(2.4);
    const say = (at, o, gain = 1) => add(out, voice(r, { jitter: 0.02, shimmer: 0.1, breath: 0.06, rough: 0.3, tilt: 5, ...o }), at, gain);
    if (kind === 'idle' && take === 1) {
        // The long moo: mouth shut, opening, closing again.
        say(0.005, { dur: r.range(1.5, 1.9), f0: through(92 * k, 148 * k, 140 * k, 118 * k, 84 * k),
            formants: mouth(COW_M, COW_OO, COW_OH, COW_OO, COW_M), env: held(0.14, 0.35) });
    } else if (kind === 'idle' && take === 2) {
        // A low murmur with the mouth barely open, sinking: a cow at ease.
        say(0.005, { dur: r.range(0.6, 0.8), rough: 0.15, tilt: 3, breath: 0.09, f0: through(104 * k, 98 * k, 74 * k),
            formants: mouth(COW_M, COW_M, COW_OO), env: held(0.25, 0.55) });
    } else if (kind === 'idle') {
        // A call: it starts low and the voice breaks upward, then falls away.
        say(0.005, { dur: r.range(1.1, 1.4), rough: 0.42, tilt: 6, f0: through(86 * k, 98 * k, 198 * k, 186 * k, 122 * k),
            formants: mouth(COW_M, COW_OO, COW_OH, COW_OH, COW_OO), env: held(0.1, 0.3) });
    } else if (take === 1) {
        // A short bellow.
        say(0.005, { dur: r.range(0.5, 0.65), rough: 0.5, tilt: 6.5, f0: through(150 * k, 212 * k, 168 * k),
            formants: mouth(COW_OH, COW_OH, COW_OO), env: held(0.08, 0.35) });
    } else {
        // A snort through the nose, and a groan after it.
        say(0.005, { dur: 0.17, voiced: 0, breath: 1.4, f0: () => 100, formants: () => NOSE, env: held(0.12, 0.6) }, 0.8);
        say(0.2, { dur: r.range(0.45, 0.6), rough: 0.6, tilt: 4, f0: through(126 * k, 104 * k, 70 * k),
            formants: mouth(COW_OO, COW_OO, COW_M), env: held(0.12, 0.5) });
    }
    return [filt(out, 'hp', 60)];
}

function sheep(r, kind, take) {
    const k = r.range(0.95, 1.06), out = zeros(1.6);
    const a = [[760, 130, 1], [1720, 200, 0.55], [2650, 300, 0.2]], e = [[620, 120, 1], [1900, 220, 0.5], [2700, 300, 0.18]];
    const m = [[300, 90, 1], [1300, 200, 0.2], [2500, 300, 0.05]];
    const say = (at, o, gain = 1) => add(out, voice(r, { rough: 0.18, jitter: 0.02, shimmer: 0.09, breath: 0.07, tilt: 5.5, ...o }), at, gain);
    if (kind === 'idle' && take === 1) {
        // "Baa": the mouth opening on a trembling note.
        say(0.005, { dur: r.range(0.8, 1.05), tremble: [r.range(8, 10), 0.5], f0: through(250 * k, 330 * k, 315 * k, 255 * k),
            formants: mouth(m, e, a, a), env: held(0.1, 0.4) });
    } else if (kind === 'idle' && take === 2) {
        // A short low "meh", hardly trembling: an old ewe, not much bothered.
        say(0.005, { dur: r.range(0.36, 0.48), tilt: 4, tremble: [7, 0.2], f0: through(206 * k, 222 * k, 184 * k),
            formants: mouth(m, e, e), env: held(0.15, 0.5) });
    } else if (kind === 'idle') {
        // A lamb: higher, longer, rising, all tremble.
        const up = a.map(([f, bw, l]) => [f * 1.16, bw, l]);
        say(0.005, { dur: r.range(1.0, 1.25), tremble: [r.range(11, 13), 0.6], rough: 0.08, f0: through(370 * k, 452 * k, 468 * k, 410 * k),
            formants: mouth(e, up, up, e), env: held(0.12, 0.35) });
    } else if (take === 1) {
        // One sharp bleat.
        say(0.005, { dur: r.range(0.3, 0.4), tremble: [12, 0.3], rough: 0.3, f0: through(330 * k, 425 * k, 300 * k),
            formants: mouth(e, a, a), env: held(0.08, 0.45) });
    } else {
        // Two short ones, the second lower: startled.
        say(0.005, { dur: 0.17, tremble: [14, 0.25], f0: through(300 * k, 340 * k, 290 * k), formants: mouth(e, a), env: held(0.12, 0.4) });
        say(0.25, { dur: 0.24, tremble: [10, 0.35], rough: 0.3, f0: through(280 * k, 290 * k, 226 * k), formants: mouth(a, e, m), env: held(0.1, 0.5) }, 0.9);
    }
    return [filt(out, 'hp', 120)];
}

function pig(r, kind, take) {
    const out = zeros(1.5), k = r.range(0.94, 1.06);
    const grunt = [[430, 150, 1], [1080, 260, 0.6], [2250, 420, 0.25]], open = [[620, 200, 1], [1500, 300, 0.6], [2600, 450, 0.22]];
    const say = (at, o, gain = 1) => add(out, voice(r, { rough: 0.6, jitter: 0.09, shimmer: 0.25, breath: 0.28, tilt: 7, formants: () => grunt, env: held(0.2, 0.5), ...o }), at, gain);
    if (kind === 'idle' && take === 1) {
        // A run of grunts.
        let t = 0.005;
        for (let i = 0, n = Math.round(r.range(2, 4)); i < n; i++) {
            const kk = k * r.range(0.88, 1.12), dur = r.range(0.11, 0.22);
            say(t, { dur, f0: through(74 * kk, 92 * kk, 66 * kk) }, r.range(0.6, 1));
            t += dur + r.range(0.03, 0.12);
        }
    } else if (kind === 'idle' && take === 2) {
        // An oink: one grunt that opens and climbs.
        say(0.005, { dur: r.range(0.42, 0.52), rough: 0.4, jitter: 0.05, breath: 0.16, tilt: 5,
            f0: through(78 * k, 96 * k, 210 * k, 262 * k), formants: mouth(grunt, grunt, open), env: held(0.12, 0.35) });
    } else if (kind === 'idle') {
        // Snuffling at the ground: breath through the nose, in little pulls.
        let t = 0.005;
        for (let i = 0, n = Math.round(r.range(4, 6)); i < n; i++) {
            const dur = r.range(0.07, 0.13);
            say(t, { dur, voiced: 0.12, breath: 1.2, f0: () => 70 * k, formants: () => NOSE, env: held(0.3, 0.6) }, r.range(0.5, 1));
            t += dur + r.range(0.05, 0.11);
        }
    } else if (take === 1) {
        // A squeal.
        say(0.005, { dur: r.range(0.45, 0.65), rough: 0.3, jitter: 0.03, shimmer: 0.12, breath: 0.1, tilt: 3.2,
            f0: through(520 * k, 940 * k, 1010 * k, 740 * k),
            formants: mouth([[900, 250, 1], [1900, 350, 0.7], [3000, 500, 0.25]], [[1250, 300, 1], [2400, 400, 0.7], [3300, 600, 0.22]]),
            env: held(0.06, 0.4) });
    } else {
        // A grunt of surprise, then a shriek that falls.
        say(0.005, { dur: 0.1, f0: through(96 * k, 120 * k) }, 0.8);
        say(0.13, { dur: r.range(0.32, 0.42), rough: 0.45, jitter: 0.04, shimmer: 0.15, breath: 0.12, tilt: 3.4,
            f0: through(860 * k, 700 * k, 410 * k), formants: mouth([[1150, 300, 1], [2300, 400, 0.7], [3200, 600, 0.2]], open), env: held(0.08, 0.5) });
    }
    return [filt(out, 'hp', 50)];
}

function chicken(r, kind, take) {
    const out = zeros(1.6), k = r.range(0.94, 1.06);
    const beak = [[1250, 260, 1], [2650, 380, 0.6], [3700, 600, 0.2]], low = [[820, 220, 1], [1900, 320, 0.4], [3000, 500, 0.1]];
    const cluck = (t, dur, lo, hi, gain, o = null) => add(out, voice(r, {
        dur, rough: 0.35, jitter: 0.05, shimmer: 0.18, breath: 0.16, tilt: 5,
        f0: through(lo, hi, lo * 1.08), formants: () => beak, env: held(0.15, 0.5), ...o,
    }), t, gain);
    if (kind === 'idle' && take === 1) {
        // "Buk, buk, buk": pottering about.
        let t = 0.005;
        for (let i = 0, n = Math.round(r.range(3, 5)); i < n; i++) {
            const dur = r.range(0.055, 0.085);
            cluck(t, dur, 390 * k, 540 * k * r.range(0.94, 1.06), r.range(0.5, 0.9));
            t += dur + r.range(0.09, 0.2);
        }
    } else if (kind === 'idle' && take === 2) {
        // Two clucks and the long one that rises out of them: "buk-buk-bkaaw".
        cluck(0.005, 0.06, 400 * k, 540 * k, 0.6);
        cluck(0.13, 0.06, 410 * k, 560 * k, 0.7);
        cluck(0.27, r.range(0.3, 0.4), 430 * k, 730 * k, 1, { f0: through(430 * k, 730 * k, 700 * k, 520 * k), env: held(0.12, 0.4) });
    } else if (kind === 'idle') {
        // A croon: low, slow, purring — a hen settled in the sun.
        cluck(0.005, r.range(0.8, 1.05), 0, 0, 1, {
            f0: through(296 * k, 352 * k, 338 * k, 300 * k), tremble: [r.range(20, 25), 0.55], rough: 0.2, breath: 0.1, tilt: 3,
            formants: () => low, env: held(0.2, 0.4) });
    } else if (take === 1) {
        // A squawk.
        cluck(0.005, r.range(0.25, 0.34), 620 * k, 960 * k, 1);
    } else {
        // The alarm: quick clucks climbing over one another.
        let t = 0.005;
        for (let i = 0, n = Math.round(r.range(5, 7)); i < n; i++) {
            const up = 1 + 0.07 * i;
            cluck(t, 0.05, 560 * k * up, 780 * k * up, 0.6 + 0.4 * i / n);
            t += 0.05 + r.range(0.035, 0.06);
        }
    }
    return [filt(out, 'hp', 250)];
}

/**
 * A Quiddle, without words. Idle: "hm", "hm?", "hm-hm", a small sigh. Hurt:
 * "ah!", "ow", "oof".
 */
function person(r, kind, take) {
    const k = r.range(0.92, 1.22), out = zeros(1);
    const HUM = [[250, 80, 1], [1050, 180, 0.07], [2300, 300, 0.02]], AH = [[720, 120, 1], [1180, 140, 0.6], [2600, 260, 0.2]];
    const UH = [[560, 110, 1], [1000, 130, 0.5], [2500, 260, 0.15]], OO = [[340, 90, 1], [820, 120, 0.5], [2300, 260, 0.08]];
    const hum = (at, o, gain = 1) => add(out, voice(r, { jitter: 0.01, shimmer: 0.05, breath: 0.03, tilt: 2.5, formants: () => HUM, env: held(0.2, 0.45), ...o }), at, gain);
    const cry = (at, o, gain = 1) => add(out, voice(r, { rough: 0.25, jitter: 0.03, shimmer: 0.12, breath: 0.2, tilt: 4, env: held(0.08, 0.5), ...o }), at, gain);
    if (kind === 'idle') {
        if (take === 1) hum(0.005, { dur: r.range(0.32, 0.45), f0: through(132 * k, 140 * k, 112 * k) });
        else if (take === 2) hum(0.005, { dur: r.range(0.34, 0.46), f0: through(118 * k, 122 * k, 168 * k) });
        else if (take === 3) {
            hum(0.005, { dur: 0.2, f0: through(146 * k, 150 * k, 140 * k) });
            hum(0.27, { dur: 0.3, f0: through(124 * k, 122 * k, 104 * k) }, 0.9);
        } else {
            // A sigh: mostly breath, the voice only just there.
            cry(0.005, { dur: r.range(0.5, 0.65), rough: 0, breath: 0.5, voiced: 0.5, tilt: 2.5, f0: through(150 * k, 138 * k, 104 * k),
                formants: mouth(AH, UH, UH), env: held(0.3, 0.6) });
        }
    } else if (take === 1) {
        cry(0.005, { dur: r.range(0.22, 0.32), f0: through(175 * k, 192 * k, 130 * k), formants: mouth(AH, UH) });
    } else if (take === 2) {
        cry(0.005, { dur: r.range(0.34, 0.44), f0: through(168 * k, 206 * k, 150 * k, 112 * k), formants: mouth(AH, AH, OO, OO), env: held(0.08, 0.55) });
    } else {
        // "Oof": the breath knocked out.
        cry(0.005, { dur: r.range(0.2, 0.28), breath: 0.6, voiced: 0.7, rough: 0.35, tilt: 3, f0: through(140 * k, 118 * k, 92 * k), formants: mouth(OO, UH, OO), env: held(0.06, 0.6) });
    }
    return [filt(out, 'hp', 80)];
}

// ── Things the player does ───────────────────────────────────────────────────

function playerHurt(r, take) {
    const out = person(r, 'hurt', take)[0], full = zeros(1);
    add(full, out, 0.01, 0.9);
    thump(full, 0.002, 95, 1.2, 0.035, 0.6);                 // the blow landing
    hiss(full, r, 0.002, 300, 2000, 0.003, 0.03, 0.3);
    return [full];
}
function fall(r) {
    const out = zeros(0.6);
    thump(out, 0.003, 58, 1.5, 0.06, 1);
    thump(out, 0.02, 110, 0.6, 0.03, 0.4);
    hiss(out, r, 0.003, 200, 1600, 0.005, 0.06, 0.45);      // clothes and limbs
    grains(out, r, 0.01, { count: 8, spread: 0.12, freq: [700, 2400], decay: [0.001, 0.004], gain: 0.1 });
    return [out];
}
function eat(r) {
    // One bite, heard from inside the head: a crunch with the top taken off it.
    const out = zeros(0.4);
    grains(out, r, 0.004, { count: 20, spread: 0.11, early: 1.2, freq: [500, 2600], decay: [0.001, 0.005], gain: 0.26 });
    hiss(out, r, 0.004, 250, 1700, 0.012, 0.05, 0.35);
    thump(out, 0.006, 130, 0.5, 0.02, 0.3);
    return [out];
}
function pickup(r) {
    // A small thing caught in the hand and dropped in a pouch: cloth, and a soft pat.
    const out = zeros(0.3), k = r.range(0.94, 1.06);
    hiss(out, r, 0.002, 700, 3200, 0.012, 0.025, 0.4);
    ring(out, 0.012, [[430 * k, 0.014, 0.5], [760 * k, 0.01, 0.25]], 0.5, r);
    thump(out, 0.03, 170, 0.4, 0.016, 0.35);
    return [out];
}
function swing(r) {
    // An arm through the air: a breath of noise that rises and falls.
    const n = secs(0.3), k = r.range(0.9, 1.1);
    const x = filt(white(n, r), 'bp', (t) => (420 + 1200 * Math.sin(Math.PI * clamp(t / 0.22, 0, 1)) ** 2) * k, 1.3);
    return [shape(x, (t) => Math.sin(Math.PI * clamp(t / 0.24, 0, 1)) ** 2)];
}
function punch(r) {
    const out = zeros(0.4), k = r.range(0.9, 1.1);
    thump(out, 0.002, 100 * k, 1.4, 0.032, 1);
    hiss(out, r, 0.002, 400, 2800, 0.003, 0.022, 0.5);       // the slap of it
    thump(out, 0.004, 190 * k, 0.8, 0.013, 0.35);
    return [out];
}
function bowDraw(r) {
    // Wood and string taking the strain: creaks, closer together as it tightens.
    const out = zeros(0.7);
    let t = 0.01, gap = 0.05;
    while (t < 0.6) {
        const f = r.range(220, 380) * (1 + t);
        ring(out, t, [[f, 0.008, 1], [f * 2.1, 0.005, 0.4], [f * 3.4, 0.003, 0.2]], r.range(0.1, 0.25), r);
        t += gap * r.range(0.6, 1.3);
        gap *= 0.93;
    }
    hiss(out, r, 0.01, 600, 2200, 0.3, 0.2, 0.05);
    return [out];
}
function bowShoot(r) {
    // The string let go — a plucked string, damped by the bow — and the arrow leaving.
    const out = zeros(0.6), f = r.range(150, 180), d = Math.round(SR / f), line = filt(white(d, r), 'lp', 2500);
    let p = 0, prev = 0;
    for (let i = 0; i < secs(0.35); i++) {
        const v = line[p], nv = (v + prev) * 0.5 * 0.97;
        prev = v; line[p] = nv;
        if (++p === d) p = 0;
        out[i] += v * 0.6;
    }
    add(out, swing(r)[0], 0.01, 0.5);
    thump(out, 0.001, 220, 0.5, 0.012, 0.4);
    return [out];
}
function arrowHit(r) {
    const out = zeros(0.5), k = r.range(0.9, 1.1);
    thump(out, 0.002, 150 * k, 1, 0.022, 0.8);
    ring(out, 0.002, [[340 * k, 0.03, 0.5], [870 * k, 0.02, 0.3], [1500 * k, 0.012, 0.14]], 0.6, r);
    hiss(out, r, 0.002, 800, 3600, 0.002, 0.012, 0.35);
    // The shaft quivering after.
    const q = shape(filt(white(secs(0.22), r), 'bp', 95 * k, 12), (t) => Math.exp(-t / 0.06));
    add(out, q, 0.006, 1.6);
    return [out];
}
/**
 * An animal's own feet, on no ground in particular (the game adds a little of
 * the ground under them: world.js `_mobStep`).
 *   hoof     a cow: a great weight coming down on a hard hoof — a deep thud
 *            with a short dull clop in it
 *   trotter  a pig, a sheep: the same, small and quick
 *   chicken  claws: two or three tiny scratches
 */
function footfall(kind, r) {
    const out = zeros(0.4), k = r.range(0.92, 1.08);
    if (kind === 'hoof') {
        body(out, r, 0.004, 64 * k, 0.034, 1);
        ring(out, 0.006, [[250 * k, 0.012, 0.6], [430 * k, 0.008, 0.4], [760 * k, 0.005, 0.18]], 0.5, r, 0.7);
        hiss(out, r, 0.006, 180, 1100, 0.01, 0.04, 0.3);
    } else if (kind === 'trotter') {
        body(out, r, 0.004, 105 * k, 0.016, 0.7);
        ring(out, 0.005, [[520 * k, 0.007, 0.6], [880 * k, 0.005, 0.35], [1400 * k, 0.003, 0.14]], 0.55, r, 0.7);
        hiss(out, r, 0.005, 300, 1600, 0.006, 0.022, 0.2);
    } else {
        for (let i = 0, n = Math.round(r.range(2, 3)), t = 0.004; i < n; i++, t += r.range(0.018, 0.04)) {
            hiss(out, r, t, 900, 3000, 0.003, 0.008, r.range(0.4, 0.8));
        }
        grains(out, r, 0.006, { count: 4, spread: 0.06, freq: [900, 2400], decay: [0.001, 0.003], gain: 0.12 });
        body(out, r, 0.004, 160, 0.008, 0.12);
    }
    return [out];
}

function click(r) {
    // A wooden button: a small soft knock, and not a beep.
    const out = zeros(0.12);
    ring(out, 0.001, [[620, 0.008, 0.6], [1150, 0.006, 0.35], [1900, 0.004, 0.14], [300, 0.012, 0.4]], 0.7, r);
    hiss(out, r, 0.001, 900, 3500, 0.001, 0.004, 0.15);
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
    return st.map((c, i) => inSpace(c, { ...opts, offset: i * 23 }, mix, true));
}

/**
 * One note of birdsong: a whistle whose pitch moves. A syrinx is not an
 * oscillator — the note wavers a little and swells unevenly (`r`), and it
 * comes in and goes out gently.
 */
function whistle(r, dur, f, { vib = 0, vibHz = 0, sharp = 2 } = {}) {
    const n = secs(dur), x = new Float32Array(n);
    let ph = 0, drift = 0, swell = 0;
    for (let i = 0; i < n; i++) {
        const t = i / n;
        drift += (r.gauss() * 0.004 - drift) * 0.002;
        swell += (r.gauss() * 0.5 - swell) * 0.004;
        ph += TAU * f(t) * (1 + drift + vib * Math.sin(TAU * vibHz * i / SR)) / SR;
        const e = Math.sin(Math.PI * t) ** (1 / sharp) * smooth(t * 5) * smooth((1 - t) * 4);
        x[i] = (Math.sin(ph) + 0.1 * Math.sin(2 * ph)) * e * (1 + clamp(swell, -0.5, 0.5));
    }
    return x;
}
// None of them sings high: the top of a bird's song is the first thing a
// distance takes away, and the thing that drills into an ear when it is left.
const BIRDS = {
    // Two notes over and over, the first the higher: a tit, taking its time.
    tit(r) {
        const out = zeros(2.4), hi = r.range(2700, 3200), lo = hi * r.range(0.74, 0.8);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(2, 4)); i < n; i++) {
            add(out, whistle(r, 0.13, () => hi), t, 1); t += 0.19;
            add(out, whistle(r, 0.16, (u) => lo * (1 - 0.03 * u)), t, 0.9); t += 0.3;
        }
        return out;
    },
    // A short run of slides up and down, no two alike: a warbler.
    warbler(r) {
        const out = zeros(2.4);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(4, 7)); i < n; i++) {
            const a = r.range(1900, 3400), b = r.range(1900, 3400), d = r.range(0.08, 0.15);
            add(out, whistle(r, d, (u) => lerp(a, b, smooth(u))), t, r.range(0.6, 1));
            t += d + r.range(0.05, 0.12);
        }
        return out;
    },
    // Slow, low and round, three or four notes: a dove.
    dove(r) {
        const out = zeros(2.8), f = r.range(430, 500);
        let t = 0;
        for (const [d, k, g] of [[0.34, 1, 0.8], [0.54, 1.07, 1], [0.32, 0.98, 0.8], [0.32, 0.96, 0.6]]) {
            add(out, whistle(r, d, (u) => f * k * (1 + 0.03 * Math.sin(Math.PI * u)), { sharp: 1.2, vib: 0.01, vibHz: 24 }), t, g);
            t += d + 0.18;
        }
        return out;
    },
    // A few clear, fluting notes with a waver in them: a blackbird.
    blackbird(r) {
        const out = zeros(3);
        let t = 0;
        for (let i = 0, n = Math.round(r.range(3, 6)); i < n; i++) {
            const a = r.range(1400, 2500), b = a * r.range(0.82, 1.25), d = r.range(0.16, 0.3);
            add(out, whistle(r, d, (u) => lerp(a, b, smooth(u)), { vib: 0.012, vibHz: r.range(18, 30), sharp: 1.5 }), t, r.range(0.7, 1));
            t += d + r.range(0.07, 0.18);
        }
        return out;
    },
    // Two soft falling notes, the same every time: a thrush far down the wood.
    thrush(r) {
        const out = zeros(1.6), f = r.range(1900, 2300);
        add(out, whistle(r, 0.22, (u) => f * (1 - 0.12 * u), { sharp: 1.4 }), 0, 1);
        add(out, whistle(r, 0.3, (u) => f * 0.8 * (1 - 0.1 * u), { sharp: 1.4 }), 0.4, 0.85);
        return out;
    },
};
/**
 * Birds a good way off, in trees. They were once in the listener's ear: seven
 * of them, bright, singing every few seconds. Now there are five, each on a
 * far perch, heard mostly as what the wood gives back of it; each waits a long
 * while between songs, and under them the leaves move.
 */
function birds(r) {
    const len = 44, st = stereo(len + 2);
    const kinds = ['blackbird', 'dove', 'warbler', 'thrush', 'tit'];
    for (let b = 0; b < 5; b++) {
        const kind = kinds[b], pan = r.range(-0.85, 0.85), near = r.range(0.25, 1);
        const cut = 1700 + 2600 * near;                      // the air between takes the top off
        for (let t = r.range(0, 12); t < len - 1; t += r.range(9, 22)) {
            const song = filt(BIRDS[kind](rng(seedOf(kind) + b * 97 + Math.round(t * 10))), 'lp', cut, 0.6);
            placeAt(st, song, t, pan, 0.1 * near * (kind === 'dove' ? 0.5 : 1));
        }
    }
    // Mostly the wood's answer, little of the bird itself: that is what far off sounds like.
    const wet = wetStereo(st, { t60: 1.9, damp: 0.7 }, 1.5);
    // Leaves in a light air, coming and going.
    wet.forEach((c, i) => {
        const leaf = band(pink(c.length, r), 500, 3200), ph = r.range(0, TAU);
        for (let k = 0; k < c.length; k++) {
            const t = k / SR;
            c[k] += leaf[k] * 0.02 * (0.5 + 0.5 * Math.sin(TAU * t / 11 + ph + i * 0.7)) ** 2 + leaf[k] * 0.006;
        }
    });
    return looped(wet, 2);
}

function crickets(r) {
    const len = 14, st = stereo(len + 1.5);
    for (let c = 0; c < 5; c++) {
        const f = r.range(3300, 4100), every = r.range(0.5, 0.75), pan = r.range(-0.95, 0.95), near = r.range(0.2, 1);
        const pulses = Math.round(r.range(3, 4));
        // A chirp: a few strokes of the wing, each a burst of the wing's one note.
        const chirp = zeros(0.1);
        for (let p = 0; p < pulses; p++) {
            const n = secs(0.013), o = Math.round(p * 0.0195 * SR), ph = r() * TAU;
            for (let i = 0; i < n; i++) chirp[o + i] += Math.sin(TAU * f * i / SR + ph) * Math.sin(Math.PI * i / n) ** 1.4;
        }
        const far = filt(chirp, 'lp', 2600 + 2400 * near, 0.6);
        for (let t = r.range(0, every); t < len + 1; t += every * r.range(0.97, 1.03)) {
            if (r() < 0.08) { t += every * r.range(2, 5); continue; }    // it stops to listen
            placeAt(st, far, t, pan, 0.08 * near);
        }
    }
    for (const c of st) add(c, filt(pink(c.length, r), 'lp', 700), 0, 0.012);
    return looped(wetStereo(st, { t60: 1.1, damp: 0.7 }, 0.9));
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
    for (let t = r.range(0.5, 2); t < len; t += r.range(1.6, 5.5)) {
        const d = zeros(0.2), f = r.log(600, 1400);
        hiss(d, r, 0, 1500, 5000, 0.0006, 0.002, 0.2);
        bubble(d, 0.004, f, r.range(0.05, 0.09), 1);
        placeAt(drips, d, t, r.range(-0.9, 0.9), r.range(0.02, 0.07));
    }
    const wet = wetStereo(drips, { t60: 3.4, damp: 0.5 }, 2.4);
    st.forEach((c, i) => add(c, wet[i]));
    return looped(st, 2);
}

function water(r) {
    const len = 12, st = stereo(len + 1.5);
    st.forEach((c) => {
        // Wavelets coming in a little out of step with one another.
        for (let b = 0; b < 4; b++) {
            const f = r.log(300, 1900), rate = r.range(0.22, 0.5), ph = r.range(0, TAU);
            const x = filt(pink(c.length, r), 'bp', f, 1.1);
            for (let i = 0; i < c.length; i++) {
                const t = i / SR;
                c[i] += x[i] * (0.25 + 0.75 * Math.max(0, Math.sin(TAU * rate * t + ph)) ** 2) * 0.5;
            }
        }
    });
    for (let t = 0; t < len + 1; t += r.range(0.05, 0.3)) {
        const b = zeros(0.08);
        bubble(b, 0, r.log(400, 1500), r.range(0.02, 0.05), 1);
        placeAt(st, b, t, r.range(-1, 1), r.range(0.006, 0.03));
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

// ── Rain ─────────────────────────────────────────────────────────────────────

/**
 * Rain, heard from a little way inside it. Two things together, because each
 * alone was tried and was wrong:
 *
 *   • The wash — all the rain too far off to be drops: a soft, level rush,
 *     most of it between a few hundred and a few thousand hertz, that swells
 *     and eases a little. By itself (filtered noise) it hissed.
 *   • The patter — drops landing nearer, each a soft tick in a band of its own
 *     (a leaf, wet earth, a puddle are not one note), as many again at twice
 *     the distance and each a quarter as loud. By themselves, with some landing
 *     at the listener's feet, they crackled like a bad wire.
 *
 * So the drops keep their distance (none within `near` metres, so none
 * stands out), come in gently (a thousandth of a second), carry nothing much
 * above 4 kHz, and lie on the wash rather than making it. WeatherAudio.js
 * plays `rain_light` and `rain_heavy` and moves between them.
 */
function rain(r, heavy) {
    const len = 18, fold = 2.5, st = stereo(len + fold), n = st[0].length;
    const drops = Math.round((heavy ? 4200 : 520) * (len + fold)), near = heavy ? 7 : 5, reach = heavy ? 34 : 26;
    const L = st[0], R = st[1];
    for (let k = 0; k < drops; k++) {
        const d = near + reach * Math.sqrt(r());             // metres off: even over the ground
        const size = Math.exp(r.gauss() * 0.35);
        const amp = size / d;
        const lo = r.log(280, 1500), hi = Math.min(lo * r.range(2, 3.5), 1400 + 16000 / d);
        const tau = r.range(0.002, 0.006) * (0.7 + 0.3 * size) * (heavy ? 1.2 : 1);
        const m = secs(0.001 + tau * 6), o = Math.floor(r() * (n - m));
        const a = (r.range(-1, 1) + 1) * Math.PI / 4, gl = Math.cos(a) * amp, gr = Math.sin(a) * amp;
        const kl = 1 - Math.exp(-TAU * hi / SR), kh = 1 - Math.exp(-TAU * lo / SR);
        let lp = 0, lp2 = 0, hp = 0;
        for (let i = 0; i < m; i++) {
            const tt = i / SR;
            lp += ((r() * 2 - 1) - lp) * kl;
            lp2 += (lp - lp2) * kl;                          // twice: a soft tick, not a click
            hp += (lp2 - hp) * kh;
            const v = (lp2 - hp) * Math.exp(-tt / tau) * smooth(tt / 0.001);
            L[o + i] += v * gl; R[o + i] += v * gr;
        }
    }
    const patter = Math.max(...st.map(rms)) || 1;
    // The wash, each ear its own, about as strong as the patter (stronger in a downpour).
    st.forEach((c, e) => {
        const w = filt(band(pink(n, r), heavy ? 260 : 380, heavy ? 3000 : 2600), 'peak', 1100, 0.7, 3);
        const k = patter / (rms(w) || 1) * (heavy ? 1.5 : 1.1), a = r.range(0, TAU), b = r.range(0, TAU);
        for (let i = 0; i < n; i++) {
            const t = i / SR;
            c[i] += w[i] * k * (0.86 + 0.09 * Math.sin(TAU * t / 7.3 + a + e) + 0.05 * Math.sin(TAU * t / 2.9 + b));
        }
    });
    return looped(st.map(c => filt(band(c, 140, 4600), 'lp', 5200, 0.6)), fold);
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

/**
 * The last thing done to every one-shot: nothing above `top` Hz to speak of,
 * and a little air round it (`air`: how much, `room`: how long it hangs), so
 * it is a sound in a place and not a sample in a speaker.
 */
function finish(c, top, air, room) {
    const y = filt(filt(c, 'hp', 35), 'lp', top, 0.6);
    return air > 0 ? inSpace(y, { t60: room, damp: 0.6 }, air) : y;
}

let written = 0, bytes = 0;
/**
 * Make one sound and write it. `level` is its peak, 0 … 1 — or `rms` its
 * loudness, for a loop, which is steady and is heard as that; `loop` keeps its
 * length exactly (a loop must not be trimmed) and is written as it was made.
 */
function emit(dir, name, make, { level = 0.5, rms: loud = 0, loop = false, quality = 4, top = 6000, air = 0.3, room = 0.3 } = {}) {
    if (ONLY.length && !ONLY.some(o => name.startsWith(o))) return;
    let chans = make(rng(seedOf(name)));
    if (!loop) chans = trim(chans.map(c => finish(c, top, air, room)));
    if (loud) {
        const k = loud / (Math.max(...chans.map(rms)) || 1);
        for (const c of chans) for (let i = 0; i < c.length; i++) c[i] = Math.tanh(c[i] * k);    // a near drop presses, it does not clip
    } else {
        const p = Math.max(...chans.map(peak)) || 1;
        for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= level / p;
    }
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
    console.log(`${dir}/${path.basename(file).padEnd(28)} ${(chans[0].length / SR).toFixed(2).padStart(6)} s  ${String(chans.length)} ch  peak ${Math.max(...chans.map(peak)).toFixed(2)}  rms ${rms(chans[0]).toFixed(3)}`);
}

for (const g of Object.keys(GROUND)) {
    const { top, level: k = 1 } = GROUND[g];
    for (let i = 1; i <= 4; i++) emit('blocks', `${g}_step_${i}`, (r) => step(g, r), { level: 0.42 * k, top });
    for (let i = 1; i <= 3; i++) emit('blocks', `${g}_hit_${i}`, (r) => hit(g, r), { level: 0.48 * k, top });
    for (let i = 1; i <= 2; i++) emit('blocks', `${g}_break_${i}`, (r) => breakUp(g, r), { level: 0.58 * k, top });
    for (let i = 1; i <= 2; i++) emit('blocks', `${g}_place_${i}`, (r) => place(g, r), { level: 0.48 * k, top });
}
for (const kind of ['door_open', 'door_close', 'gate_open', 'gate_close']) {
    for (let i = 1; i <= 2; i++) emit('blocks', `${kind}_${i}`, (r) => doorSound(kind, r), { level: kind.endsWith('close') ? 0.5 : 0.4, top: 4500, air: 0.3, room: 0.35 });
}
for (let i = 1; i <= 2; i++) emit('blocks', `water_splash_${i}`, (r) => splash(r, true), { level: 0.6, top: 5000 });
for (let i = 1; i <= 3; i++) emit('blocks', `water_swim_${i}`, (r) => splash(r, false), { level: 0.4, top: 4500 });

// Out of doors, a voice has a field round it: more air, and longer.
const VOICES = { cow, sheep, pig, chicken };
const SPOKEN = { top: 5000, air: 0.4, room: 0.55 };
for (const [name, fn] of Object.entries(VOICES)) {
    for (let i = 1; i <= 3; i++) emit('entities', `${name}_idle_${i}`, (r) => fn(r, 'idle', i), { level: 0.5, ...SPOKEN });
    for (let i = 1; i <= 2; i++) emit('entities', `${name}_hurt_${i}`, (r) => fn(r, 'hurt', i), { level: 0.58, ...SPOKEN });
}
for (let i = 1; i <= 4; i++) emit('entities', `quiddle_idle_${i}`, (r) => person(r, 'idle', i), { level: 0.4, ...SPOKEN });
for (let i = 1; i <= 3; i++) emit('entities', `quiddle_hurt_${i}`, (r) => person(r, 'hurt', i), { level: 0.55, ...SPOKEN });
for (let i = 1; i <= 3; i++) emit('entities', `player_hurt_${i}`, (r) => playerHurt(r, i), { level: 0.58, top: 5000 });
for (let i = 1; i <= 2; i++) emit('entities', `fall_${i}`, fall, { level: 0.62 });
for (let i = 1; i <= 3; i++) emit('entities', `eat_${i}`, eat, { level: 0.45, top: 3200, air: 0 });
for (let i = 1; i <= 2; i++) emit('entities', `pickup_${i}`, pickup, { level: 0.34, top: 4500 });
for (let i = 1; i <= 3; i++) emit('entities', `swing_${i}`, swing, { level: 0.32, top: 4500 });
for (let i = 1; i <= 3; i++) emit('entities', `punch_${i}`, punch, { level: 0.58, top: 4500 });
for (let i = 1; i <= 4; i++) emit('entities', `hoof_step_${i}`, (r) => footfall('hoof', r), { level: 0.5, top: 3200 });
for (let i = 1; i <= 4; i++) emit('entities', `trotter_step_${i}`, (r) => footfall('trotter', r), { level: 0.36, top: 3800 });
for (let i = 1; i <= 3; i++) emit('entities', `chicken_step_${i}`, (r) => footfall('chicken', r), { level: 0.2, top: 3600 });
emit('entities', 'bow_draw', bowDraw, { level: 0.36, top: 4500 });
for (let i = 1; i <= 2; i++) emit('entities', `bow_shoot_${i}`, bowShoot, { level: 0.5, top: 4500 });
for (let i = 1; i <= 2; i++) emit('entities', `arrow_hit_${i}`, arrowHit, { level: 0.55, top: 4500 });

emit('ui', 'click', click, { level: 0.3, top: 4500, air: 0.15, room: 0.15 });

emit('ambiant', 'birds', birds, { rms: 0.02, loop: true });
emit('ambiant', 'crickets', crickets, { rms: 0.025, loop: true });
emit('ambiant', 'cave', cave, { level: 0.7, loop: true });
emit('ambiant', 'water', water, { level: 0.5, loop: true });
emit('ambiant', 'underwater', underwater, { level: 0.75, loop: true });
emit('ambiant', 'rain_light', (r) => rain(r, false), { rms: 0.055, loop: true, quality: 5 });
emit('ambiant', 'rain_heavy', (r) => rain(r, true), { rms: 0.11, loop: true, quality: 5 });

console.log(`\n${written} sounds, ${(bytes / 1024).toFixed(0)} KB, in ${OUT}${HAVE_FFMPEG ? '' : '  (WAV: ffmpeg not found)'}`);
