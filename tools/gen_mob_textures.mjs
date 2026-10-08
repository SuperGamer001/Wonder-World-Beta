// Paints the mob textures (data/textures/entities/*.png) from the model
// definitions in src/scripts/engine/MobModelDefs.js.
//
//   node tools/gen_mob_textures.mjs            (npm run mobtex)
//
// Every texel of a model lies somewhere on a shape, so a painter is asked for a
// colour at a point *on the model* — "the texel at (x, y, z), facing this way,
// on the head" — rather than at a place in the atlas. That is what lets a cow's
// patches or the hem of a dress run from one shape onto the next without a
// seam, and what keeps the painters readable ("below y 1.2 it is hoof").
// Features that have a place — an eye, a nostril — are put at the model's
// marks (MobShapes: Builder.mark), the same points the animators use.
//
// The layout comes from the model (shape.patches, surfacePoint), so re-run
// this after changing a model's shapes. The PNGs are ordinary files: once they
// look right they can be touched up by hand, or replaced outright by a
// gamepack — but running this again repaints them.
//
// The game shades every mob by the sun, so the painters leave the light alone:
// what they paint is what the thing is made of — the lie of a coat, the curl
// of a fleece, the weave of a hat — and a darker tone only where one shape
// tucks in under another.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MODELS, QUIDDLE_HEAD } from '../src/scripts/engine/MobModelDefs.js';
import { surfacePoint, layoutKey } from '../src/scripts/engine/MobShapes.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'textures', 'entities');
fs.mkdirSync(OUT, { recursive: true });

// ── PNG ──────────────────────────────────────────────────────────────────────
function crc32(buf) {
    let c, crc = ~0;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return ~crc >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function writePng(file, w, h, rgba) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]));
}

// ── Colour and noise ─────────────────────────────────────────────────────────
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const fract = (x) => x - Math.floor(x);
const hash = (x, y, z, s = 0) => fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19) * 43758.5453);
const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
/** 0 below a, 1 above b, eased between (a may be the greater: then it falls). */
const step = (a, b, x) => smooth(clamp01((x - a) / (b - a)));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Value noise at a point of the model; `cell` px across. 0 … 1. */
function noise(p, cell, seed = 0) {
    const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi);
    let v = 0;
    for (let k = 0; k < 8; k++) {
        const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
        v += hash(xi + dx, yi + dy, zi + dz, seed) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    }
    return v;
}
/** Noise in three sizes: blotches with ragged edges. */
const blotch = (p, cell, seed) => noise(p, cell, seed) * 0.62 + noise(p, cell * 0.42, seed + 1) * 0.26 + noise(p, cell * 0.16, seed + 2) * 0.12;
/** Noise drawn out along `dir` (a unit vector): hair, the grain of cloth. `long` times as long as it is wide. */
function streak(p, dir, cell, long, seed) {
    const d = dot(p, dir) * (1 - 1 / long);
    return noise([p[0] - dir[0] * d, p[1] - dir[1] * d, p[2] - dir[2] * d], cell, seed);
}
/** Distance to the nearest of a scatter of points, one to a cell: 0 at a point … about 1 between them. */
function cells(p, cell, seed) {
    const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let best = 9;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const d = Math.hypot(cx + hash(cx, cy, cz, seed) - x, cy + hash(cx, cy, cz, seed + 1) - y, cz + hash(cx, cy, cz, seed + 2) - z);
        if (d < best) best = d;
    }
    return best;
}

/** The finish every surface gets: a little grain, a different speck for every texel. */
function finish(c, t, grain = 0.05) {
    const k = 1 + (hash(t.ax, t.ay, 0, 3) - 0.5) * grain * 2;
    return [c[0] * k, c[1] * k, c[2] * k, 255];
}
/** How far a surface is turned under: 0 level or above … 1 facing straight down. */
const under = (t) => Math.max(0, -t.n[1]);
/** Distance from a mark that is on both sides of the model. */
const fromMark = (p, m) => Math.hypot(Math.abs(p[0]) - m[0], p[1] - m[1], p[2] - m[2]);

/**
 * The directions of a head, from its marks: where a point is along it (`s`,
 * px from the poll toward the nose) and above or below its middle line (`v`,
 * + toward the forehead).
 */
function headFrame(model) {
    const o = model.marks.poll, n = model.marks.nose;
    const d = [n[0] - o[0], n[1] - o[1], n[2] - o[2]], l = Math.hypot(d[0], d[1], d[2]);
    const ax = [d[0] / l, d[1] / l, d[2] / l], up = [0, ax[2], -ax[1]];
    return (p) => {
        const q = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
        return { s: dot(q, ax), v: dot(q, up), len: l };
    };
}

/**
 * Paint one layer of a model: `fn(texel)` → [r, g, b] / [r, g, b, a] / null
 * (clear). A texel knows the shape it is on (`tag`, `part`), which patch of it
 * and where in that (`kind`, `face` or `end`; `i`, `j` of `w` × `h`; `a`, `b`
 * as fractions), and where it is on the model and which way it faces (`p`, `n`).
 */
function paint(model, file, fn) {
    const { width: W, height: H } = model.atlas;
    const img = Buffer.alloc(W * H * 4), owned = new Uint8Array(W * H);
    const pt = [];
    for (const shape of model.shapes) {
        const part = model.parts[shape.part].name;
        for (const patch of shape.patches) {
            for (let j = 0; j < patch.h; j++) for (let i = 0; i < patch.w; i++) {
                const a = (i + 0.5) / patch.w, b = (j + 0.5) / patch.h;
                surfacePoint(model, shape, patch, a, b, pt);
                const t = {
                    part, tag: shape.tag, shape, patch, kind: patch.kind, face: patch.face, end: patch.end,
                    i, j, w: patch.w, h: patch.h, a, b, ax: patch.x + i, ay: patch.y + j,
                    p: [pt[0], pt[1], pt[2]], n: [pt[3], pt[4], pt[5]],
                };
                const o = (t.ay * W + t.ax) * 4;
                owned[t.ay * W + t.ax] = 1;
                let c = fn(t);
                if (!c) continue;
                if (c.length === 3) c = finish(c, t);
                for (let k = 0; k < 4; k++) img[o + k] = Math.max(0, Math.min(255, Math.round(c[k])));
            }
        }
    }
    // The space between patches takes the colour of the texel beside it, so an
    // edge that lands a hair outside its patch shows no line.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (owned[y * W + x]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
            const u = x + dx, v = y + dy;
            if (u < 0 || v < 0 || u >= W || v >= H || !owned[v * W + u]) continue;
            img.copy(img, (y * W + x) * 4, (v * W + u) * 4, (v * W + u) * 4 + 4);
            break;
        }
    }
    writePng(path.join(OUT, file + '.png'), W, H, img);
    return file;
}

const made = [];
const BLACK = hex(0x0c0a09), SHINE = hex(0xf6f3ec);
const FACE_PY = 2, FACE_NY = 3;

/**
 * An eye, drawn texel by texel on the grid of the shape it is on, so that it
 * is sharp and the same on both sides of the head. `rows` is the eye as it is
 * seen from its own side with the nose to the right — a letter a texel, top
 * row first, a space where the coat shows through — and it is centred on the
 * texel nearest the model's `mark`. Returns (texel) => the letter there, or
 * nothing.
 */
function pixelEye(model, tag, mark, rows) {
    const shape = model.shapes.find(s => s.tag === tag), side = shape.patches[0], pt = [];
    const at = [null, null], near = [Infinity, Infinity];
    for (let j = 0; j < side.h; j++) for (let i = 0; i < side.w; i++) {
        surfacePoint(model, shape, side, (i + 0.5) / side.w, (j + 0.5) / side.h, pt);
        for (let s = 0; s < 2; s++) {
            const d = Math.hypot(pt[0] - (s ? -mark[0] : mark[0]), pt[1] - mark[1], pt[2] - mark[2]);
            if (d < near[s]) { near[s] = d; at[s] = [i, j]; }
        }
    }
    const w = rows[0].length, h = rows.length;
    return (t) => {
        if (t.shape !== shape || t.kind !== 'side') return null;
        // Along the shape is toward the nose; round it is up on the one side and down on the other.
        const s = t.p[0] < 0 ? 1 : 0, c = at[s];
        const x = t.j - c[1] + (w >> 1), y = ((h - 1) >> 1) - (s ? 1 : -1) * (t.i - c[0]);
        const ch = x >= 0 && x < w && y >= 0 && y < h ? rows[y][x] : ' ';
        return ch === ' ' ? null : ch;
    };
}

// ── Cow ──────────────────────────────────────────────────────────────────────
{
    const M = MODELS.cow, head = headFrame(M), NOSE = M.marks.nose;
    // Big, dark and wet, under a heavy lid.
    const eye = pixelEye(M, 'head', M.marks.eye, [' LLLL ', 'LKKSKl', 'lKKKKl', ' llll ']);
    const LIE = [0, -0.5, -0.866];           // the way the coat lies: back and down
    const coats = [
        // Red and white: a white face, belly, legs and switch.
        { hair: hex(0x9a5230), white: hex(0xf0eadc), muzzle: hex(0xe2aa9c), nostril: hex(0x6a3a33), horn: hex(0xe6dcc4), hoof: hex(0x9b8a72), seed: 11 },
        // Black and white, in patches.
        { hair: hex(0x242328), white: hex(0xf2f0ea), muzzle: hex(0xd9a39b), nostril: hex(0x35221f), horn: hex(0xdcd4c2), hoof: hex(0x2b2623), seed: 29 },
        // Fawn, shading to brown at the shoulders, the head and the legs; a dark muzzle in a pale ring.
        { hair: hex(0xb98b5c), white: hex(0xe6d2ae), muzzle: hex(0x2e2826), nostril: hex(0x100e0d), horn: hex(0xd8cdb6), hoof: hex(0x2a2421), seed: 47 },
    ];
    coats.forEach((coat, n) => made.push(paint(M, `cow_${n + 1}`, (t) => {
        const p = t.p, y = p[1];
        const k = blotch(p, 9, coat.seed);
        const h = t.tag === 'head' ? head(p) : null;
        // The coat here: hair or white.
        let c;
        if (n === 0) {
            const low = y + (k - 0.5) * 5;                    // a ragged line along the flank
            let white = low < 12.2 || k > 0.64;
            if (t.tag === 'leg') white = y < 8.5 + (k - 0.5) * 5 || white;
            if (t.tag === 'head') white = h.s > 0.9 + Math.abs(p[0]) * 0.5 + (k - 0.5) * 1.6;
            if (t.tag === 'tail') white = y < 9.4;
            c = white ? coat.white : coat.hair;
        } else if (n === 1) {
            let black = k > 0.5;
            if (t.tag === 'leg') black = black && y > 6.5 + (k - 0.5) * 6;
            if (t.tag === 'head') black = !(Math.abs(p[0]) < 0.95 - h.s * 0.05 && h.v > 0.2 && h.s > 0.4);      // a blaze down the face
            if (t.tag === 'tail') black = y > 9.4;
            c = black ? coat.hair : coat.white;
        } else {
            const brown = hex(0x6f4a2e);
            let dark = step(4, 10, p[2]) * 0.3 + step(13, 21, y) * 0.12 + (k - 0.5) * 0.3;
            if (t.tag === 'leg') dark = 0.2 + step(9, 3, y) * 0.4;
            if (t.tag === 'head') dark = 0.38 + step(3.5, 6.5, h.s) * 0.2;
            if (t.tag === 'tail') dark = y < 9.4 ? 1.1 : 0.25;
            c = mix(coat.hair, brown, clamp01(dark));
            c = mix(c, coat.white, step(12.5, 9.5, y) * 0.6 * (t.tag === 'body' || t.tag === 'udder' ? 1 : 0));   // paler underneath
        }
        // Hair has a lie to it, and is a shade darker where it is turned under.
        const lie = 1 + (streak(p, LIE, 0.9, 5, coat.seed + 5) - 0.5) * 0.2;
        const coatHere = () => finish(mul(c, lie * (1 - 0.13 * under(t))), t);

        switch (t.tag) {
            case 'leg': {
                if (y < 1.2) {                                        // the hoof, cloven in front
                    const cleft = Math.abs(Math.abs(p[0]) - 3.55) < 0.14 && t.n[2] > 0.5;
                    return finish(mul(coat.hoof, cleft ? 0.55 : 0.92 + streak(p, [0, 1, 0], 0.5, 4, 3) * 0.16), t, 0.03);
                }
                if (y < 1.55) return finish(mix(c, coat.hoof, 0.55), t);                         // the coronet
                // Darker up inside, where the leg goes into the body.
                const inside = t.n[0] * Math.sign(p[0]) < -0.3 ? 0.9 : 1;
                return finish(mul(c, lie * inside * (1 - 0.1 * step(10.5, 13.5, y))), t);
            }
            case 'udder': return finish(mul(hex(0xe3a79d), 1 - 0.1 * under(t)), t, 0.03);
            case 'horn':  return finish(mix(coat.horn, hex(0x3a332d), step(23.0, 24.2, y)), t, 0.03);
            case 'ear':
                // Its hollow faces forward: bare skin, with a fringe of hair round it.
                if (t.n[2] > 0.45 && Math.abs(p[0]) > 2.3 && Math.abs(p[0]) < 4.8) return finish(mix(hex(0xd9a097), c, 0.25), t, 0.03);
                return coatHere();
            case 'tail':
                if (y < 9.4) return finish(mul(c, 0.8 + streak(p, [0, 1, 0], 0.4, 6, 7) * 0.35), t, 0.03);   // the switch: long hair
                return coatHere();
            case 'head': {
                const e = eye(t);
                if (e) {
                    const lid = n === 1 ? mul(coat.hair, 0.7) : mix(c, hex(0x2a1c14), 0.6);
                    return finish(e === 'K' ? hex(0x140d09) : e === 'S' ? SHINE : e === 'L' ? lid : mix(lid, c, 0.4), t, 0.02);
                }
                if (h.s > 6.75) {
                    // The muzzle: bare, moist skin; nostrils to either side, the mouth below.
                    let m = coat.muzzle;
                    if (Math.hypot(Math.abs(p[0]) - 0.95, p[1] - NOSE[1] - 0.35, p[2] - NOSE[2] + 0.2) < 0.36) m = coat.nostril;
                    else if (h.v < -0.5 && h.v > -0.78) m = mul(m, 0.62);
                    return finish(mul(m, 1 - 0.1 * under(t)), t, 0.035);
                }
                if (n === 2 && h.s > 5.6) return finish(mul(coat.white, lie), t);                 // the pale ring
                if (h.s > 4.6 && h.v < -0.55 && h.v > -0.8) return finish(mul(c, 0.7), t);        // the line of the mouth
                return coatHere();
            }
        }
        return coatHere();
    })));
}

// ── Pig ──────────────────────────────────────────────────────────────────────
{
    const M = MODELS.pig, head = headFrame(M), NOSE = M.marks.nose;
    // Small and deep-set.
    const eye = pixelEye(M, 'head', M.marks.eye, [' LL ', 'lKSl', ' KK ']);
    const LIE = [0, -0.3, -0.954];
    const coats = [
        { skin: hex(0xe9a99d), dark: null, snout: hex(0xf2b8ae), horn: hex(0xcbb99a), seed: 5 },                 // pink
        { skin: hex(0xe6a89c), dark: hex(0x2d292a), snout: hex(0x4a3d3c), horn: hex(0x2c2623), seed: 17 },       // saddleback: black, belted pink
        { skin: hex(0xa5633c), dark: hex(0x7e4526), snout: hex(0xc48a72), horn: hex(0x3a2a20), seed: 31 },       // ginger
    ];
    coats.forEach((coat, n) => made.push(paint(M, `pig_${n + 1}`, (t) => {
        const p = t.p, y = p[1];
        const k = blotch(p, 6, coat.seed);
        const h = t.tag === 'head' || t.tag === 'ear' ? head(p) : null;
        let c = coat.skin, bristle = 0.1;
        if (n === 1) {
            // Black fore and aft of a pink belt over the shoulders and down the forelegs.
            const belt = p[2] > 2.2 + (k - 0.5) * 2.2 && p[2] < 7.4 + (k - 0.5) * 2 && !h;
            if (!belt) { c = coat.dark; bristle = 0.16; }
        } else if (n === 2) {
            c = mix(coat.skin, coat.dark, clamp01(0.3 + (k - 0.5) * 1.2 + step(11, 13, y) * 0.3));
            bristle = 0.22;
        }
        // Paler and pinker underneath; a crease where the jowl meets the shoulder.
        if (n !== 1 || c === coat.skin) c = mix(c, mul(coat.skin, 1.07), step(7, 4.5, y) * 0.4);
        const hair = 1 + (streak(p, LIE, 0.7, 6, coat.seed + 3) - 0.5) * bristle * 2;
        const hide = () => finish(mul(c, hair * (1 - 0.12 * under(t))), t, 0.04);

        switch (t.tag) {
            case 'leg':
                if (y < 0.85) return finish(mul(coat.horn, 0.9 + streak(p, [0, 1, 0], 0.4, 4, 2) * 0.2), t, 0.03);   // the trotter
                return finish(mul(c, hair * (1 - 0.12 * step(4.5, 7, y)) * (t.n[0] * Math.sign(p[0]) < -0.3 ? 0.9 : 1)), t, 0.04);
            case 'ear':
                // Thin enough to show the blood in it; pinker in the hollow, which faces forward.
                if (t.n[2] > 0.3) return finish(mix(n === 1 ? hex(0x5a4644) : mix(coat.skin, hex(0xe08d88), 0.5), c, 0.2), t, 0.03);
                return hide();
            case 'tail': return finish(mul(n === 1 ? coat.dark : coat.skin, 0.95), t, 0.03);
            case 'neck':
                return finish(mul(c, hair * (1 - 0.12 * under(t)) * (1 - 0.1 * step(0.35, 0, Math.abs(p[2] - 7.2)) * step(9, 6, y))), t, 0.04);
            case 'head': {
                if (t.kind === 'cap') {
                    // The disc of the snout, and its two nostrils.
                    const nostril = Math.hypot((Math.abs(p[0]) - 0.62) * 1.6, h.v - 0.05) < 0.44;
                    return finish(nostril ? mul(coat.snout, 0.35) : mul(coat.snout, 0.97 - 0.07 * Math.hypot(p[0], h.v) / 1.5), t, 0.03);
                }
                const e = eye(t);
                if (e) return finish(e === 'K' ? hex(0x150e0a) : e === 'S' ? hex(0x6b6a70) : mul(c, e === 'L' ? 0.62 : 0.8), t, 0.02);
                if (h.s > 6.9) return finish(mul(coat.snout, 0.92), t, 0.03);                      // the rim of the disc
                if (h.s > 4.4) c = mix(c, coat.snout, step(4.4, 6.5, h.s) * 0.7);
                if (h.s > 3.9 && h.v < -0.55 && h.v > -0.85) return finish(mul(c, 0.66), t, 0.03);  // the mouth
                return hide();
            }
        }
        return hide();
    })));
}

// ── Sheep ────────────────────────────────────────────────────────────────────
{
    const M = MODELS.sheep, head = headFrame(M), NOSE = M.marks.nose;
    // Amber, with a pupil that is a bar lying level.
    const eye = pixelEye(M, 'head', M.marks.eye, ['LLLL', 'AKKA', 'lAAl']);
    const coats = [
        { wool: hex(0xefe9d9), face: hex(0x2a2624), nose: hex(0x161312), seed: 3 },       // white, with a black face and legs
        { wool: hex(0x9d9a95), face: hex(0xe7e1d3), nose: hex(0xcf9c93), seed: 13 },      // grey, with a white face
        { wool: hex(0x6d4e3a), face: hex(0x3b2b21), nose: hex(0x1c1512), seed: 23 },      // brown
    ];
    coats.forEach((coat, n) => made.push(paint(M, `sheep_${n + 1}`, (t) => {
        const p = t.p, y = p[1];
        // A fleece is locks, each a little dome: light on its top, shadow between it and the next.
        const wool = () => {
            const d = cells(p, 1.25, coat.seed), top = cells([p[0], p[1] - 0.35, p[2]], 1.25, coat.seed);
            const lock = 0.84 + 0.17 * step(0.62, 0.2, d) + (top - d) * 0.22;
            const dull = 1 - 0.1 * step(9, 6, y) - 0.1 * under(t) + (noise(p, 5, coat.seed + 4) - 0.5) * 0.1;
            return finish(mul(coat.wool, lock * dull), t, 0.03);
        };
        const hair = (c, grain = 0.05) => finish(mul(c, (0.93 + streak(p, [0, 1, 0], 0.5, 4, coat.seed + 2) * 0.14) * (1 - 0.1 * under(t))), t, grain);
        switch (t.tag) {
            case 'leg':
                if (y < 0.75) return finish(hex(0x1b1715), t, 0.04);                                // hoof
                if (y > 6.6 + (noise(p, 1.2, 9) - 0.5) * 1.4) return wool();                       // wool to the knee, ragged
                return hair(coat.face);
            case 'ear':
                if (t.n[2] > 0.45 && Math.abs(p[0]) > 2 && Math.abs(p[0]) < 4.1) return finish(mix(hex(0xc9968f), coat.face, 0.3), t, 0.03);
                return hair(mul(coat.face, 1.08));
            case 'head': {
                const h = head(p);
                const e = eye(t);
                if (e) {
                    const lid = n === 1 ? mul(coat.face, 0.5) : mix(coat.face, hex(0x8a7a6a), 0.35);
                    return finish(e === 'K' ? BLACK : e === 'A' ? hex(0xc79a3f) : e === 'L' ? lid : mix(lid, coat.face, 0.5), t, 0.02);
                }
                if (h.s > 5.3) {
                    // The nose: bare skin in a Y, a slit of a nostril to either side.
                    if (Math.abs(p[0]) < 0.14 && h.v < 0.25 && h.v > -0.7) return finish(mul(coat.nose, 0.8), t, 0.02);
                    if (Math.hypot(Math.abs(p[0]) - 0.48, p[1] - NOSE[1] - 0.22, p[2] - NOSE[2] + 0.1) < 0.3) return finish(coat.nose, t, 0.02);
                }
                if (h.s > 3.6 && h.v < -0.5 && h.v > -0.74) return finish(mul(coat.face, 0.62), t, 0.03);      // mouth
                return hair(mix(coat.face, mul(coat.face, 1.18), step(3.2, 5.6, h.s)));           // paler toward the muzzle
            }
        }
        return wool();
    })));
}

// ── Chicken ──────────────────────────────────────────────────────────────────
{
    const M = MODELS.chicken, EYE = M.marks.eye;
    // Round, bright and orange, in bare red skin.
    const eye = pixelEye(M, 'skull', EYE, ['OOO', 'OKO', 'OOO']);
    const coats = [
        { feather: hex(0xf4f1e8), edge: hex(0xd6d0c0), tail: hex(0xeeeade), bar: null, seed: 2 },             // white
        { feather: hex(0x9a4a26), edge: hex(0x5e2b18), tail: hex(0x1d2420), bar: null, seed: 9 },             // red, with a black tail
        { feather: hex(0xe9e7e0), edge: hex(0xc9c6bd), tail: hex(0xe3e1da), bar: hex(0x2a2a30), seed: 19 },   // barred
    ];
    const red = hex(0xcf2c21), shank = hex(0xe0a630);
    // Feathers lie in rows from the breast back, each overlapping the next: a
    // scallop a pixel or so long, darker along its trailing edge.
    const feathers = (t, coat, size = 0.95, c = coat.feather) => {
        const p = t.p, round = Math.atan2(p[0], p[1] - 4.9) * 2.1;
        const rowN = Math.floor(round / size), along = (p[2] + p[1] * 0.25) / size + (rowN & 1) * 0.5;
        const f = fract(along), across = fract(round / size) - 0.5;
        const tip = step(0.42, 0.05, f + across * across * 1.2);
        let col = mix(c, coat.edge, tip * 0.6);
        if (coat.bar && fract(along * 0.75 + 0.2) < 0.45) col = mix(col, coat.bar, 0.9);
        return finish(mul(col, 1 - 0.14 * under(t)), t, 0.035);
    };
    coats.forEach((coat, n) => made.push(paint(M, `chicken_${n + 1}`, (t) => {
        const p = t.p;
        switch (t.tag) {
            case 'beak': {
                if (Math.hypot(Math.abs(p[0]) - 0.2, p[1] - 8.52, p[2] - 4.2) < 0.13) return finish(hex(0x6a4a1c), t, 0);   // nostril
                return finish(mix(hex(0xe9b23a), hex(0xb9862a), step(4.5, 5.1, p[2]) * 0.7 + under(t) * 0.3), t, 0.03);
            }
            case 'comb': {
                // Five points, the tallest in the middle, cut out of the plate.
                const z = (p[2] - 2.5) / 1.8, top = 9.35 + 1.1 * (0.5 + 0.5 * Math.sin(z * Math.PI)) * (0.72 + 0.28 * Math.abs(Math.sin(z * Math.PI * 5)));
                if (p[1] > top - 0.04) return null;
                return finish(mul(red, 0.92 + 0.12 * step(9.4, 10.2, p[1])), t, 0.03);
            }
            case 'wattle': return finish(mul(red, 0.9), t, 0.03);
            case 'skull': {
                const e = eye(t);
                if (e) return finish(e === 'K' ? BLACK : hex(0xe0921f), t, 0);
                // Bare red skin about the eye and down to the beak.
                if (fromMark(p, EYE) < 0.62 || (p[2] > 3.3 && p[1] < 9.0)) return finish(mul(red, 0.95), t, 0.03);
                return feathers(t, coat, 0.6);
            }
            case 'neck': return feathers(t, coat, 0.7, n === 1 ? mix(coat.feather, hex(0xc9772e), 0.45) : coat.feather);    // hackles
            case 'wing': {
                // Coverts at the shoulder; behind them the long flight feathers, laid edge to edge.
                if (p[2] > -0.6) return feathers(t, coat, 0.8);
                const quill = fract((p[1] + p[2] * 0.35) * 1.6);
                let c = mix(coat.feather, coat.edge, quill < 0.25 ? 0.75 : 0.15);
                if (coat.bar && fract(p[2] * 0.9) < 0.4) c = mix(c, coat.bar, 0.9);
                if (n === 1) c = mix(c, coat.tail, step(-1.4, -2.8, p[2]) * 0.7);
                return finish(c, t, 0.035);
            }
            case 'tail': {
                // Sickles: long feathers fanned out from the root.
                const fan = Math.atan2(p[1] - 6.0, -(p[2] + 2.6));
                let c = mix(coat.tail, mul(coat.tail, n === 1 ? 1.6 : 0.82), fract(fan * 4.5) < 0.3 ? 1 : 0);
                if (coat.bar && fract(Math.hypot(p[1] - 6.0, p[2] + 2.6) * 0.8) < 0.42) c = mix(c, coat.bar, 0.9);
                return finish(c, t, 0.035);
            }
            case 'leg':
                if (p[1] > 2.4) return feathers(t, coat, 0.6);                                      // the thigh, in feathers
                return finish(mul(shank, fract(p[1] * 2.2) < 0.3 ? 0.78 : 1), t, 0.03);            // the shank, ringed with scales
            case 'toes': {
                // Three toes forward and one back, cut out of the plate; a dark claw on each.
                const x = Math.abs(p[0]) - 0.95, z = p[2];
                const seg = (x1, z1, x2, z2) => {
                    const dx = x2 - x1, dz = z2 - z1, k = clamp01(((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz));
                    return [Math.hypot(x - x1 - dx * k, z - z1 - dz * k), k];
                };
                let best = [9, 0];
                for (const s of [seg(0, 0, 0, 1.55), seg(0, 0.05, 0.72, 1.2), seg(0, 0.05, -0.72, 1.2), seg(0, 0, 0, -0.68)]) if (s[0] < best[0]) best = s;
                if (best[0] > 0.17) return null;
                return finish(best[1] > 0.93 ? hex(0x4a3a22) : mul(shank, t.face === FACE_NY ? 0.75 : 0.95), t, 0.03);
            }
        }
        // The body: paler and fluffier underneath; the red is darker over the back.
        const c = n === 1 ? mix(coat.feather, coat.edge, step(5.7, 6.9, p[1]) * 0.35) : coat.feather;
        return feathers(t, coat, 0.95, mix(c, mul(coat.feather, 1.06), step(3.9, 2.7, p[1]) * 0.5));
    })));
}

// ── Fish ─────────────────────────────────────────────────────────────────────
{
    const M = MODELS.fish;
    // A round eye in a ring of gold.
    const eye = pixelEye(M, 'body', M.marks.eye, ['GGG', 'GKG', 'GGG']);
    const coats = [
        // A trout: olive above, a rose band along the side, spotted.
        { back: hex(0x55683a), side: hex(0xb7c2ad), belly: hex(0xeeeee6), band: hex(0xd68a98), mark: hex(0x26301c), fin: hex(0x7c8450), seed: 4 },
        // A carp in orange and white.
        { back: hex(0xe2601c), side: hex(0xf2933a), belly: hex(0xf6efe2), band: null, mark: hex(0xf6f0e4), fin: hex(0xf1a85a), seed: 14 },
        // A perch: green-gold, barred, with red fins below.
        { back: hex(0x4f5e2a), side: hex(0xa3a850), belly: hex(0xeae2bd), band: null, mark: hex(0x27311a), fin: hex(0xd4532a), seed: 24 },
    ];
    coats.forEach((coat, n) => made.push(paint(M, `fish_${n + 1}`, (t) => {
        const p = t.p;
        // A fin: rays fanning from its root, the membrane paler between them.
        const fin = (c, root, cut) => {
            if (cut) return null;
            const ray = fract(Math.atan2(p[1] - root[0], p[2] - root[1]) * 5.5);
            return finish(mul(c, ray < 0.28 ? 0.72 : 1), t, 0.04);
        };
        switch (t.tag) {
            case 'tailfin': {
                // Narrow at the root, spreading, forked.
                const back = -3.7 - p[2], dy = Math.abs(p[1] - 2.2);
                return fin(coat.fin, [2.2, -3.4], dy > 0.45 + back * 0.55 || dy < (back - 1.75) * 1.1 || back > 2.45 + dy * 0.14);
            }
            case 'dorsal': {
                // Rises quickly behind the head and falls away toward the tail.
                const z = p[2], top = z > 1.2 ? 3.5 + (2.15 - z) * 1.3 : 4.72 - (1.2 - z) * 0.5;
                return fin(n === 2 ? mul(coat.back, 0.9) : coat.fin, [3.3, -0.3], p[1] > top);
            }
            case 'anal': return fin(coat.fin, [1.5, -1.2], p[1] < 1.42 - (p[2] + 2.5) * 0.62 * (p[2] < -1.6 ? 0.4 : 1) - (p[2] > -1.6 ? (p[2] + 1.6) * -0.2 : 0) && p[1] < 0.55 + Math.abs(p[2] + 1.7) * 0.9);
            case 'fin': {
                // A pectoral: a rounded leaf. Laid out along its patch, since the fin itself is set at an angle.
                const u = t.face === FACE_PY || t.face === FACE_NY ? [t.a, t.b] : null;
                if (u && Math.hypot((u[0] - 0.5) * 2, (u[1] - 0.5) * 2) > 1) return null;
                if (!u) return null;
                return finish(mul(coat.fin, fract(u[0] * 4) < 0.3 ? 0.75 : 1), t, 0.04);
            }
        }
        // The body. Back, side and belly; then each kind its own markings.
        const k = clamp01((p[1] - 0.95) / 2.75), z = p[2];
        let c = k > 0.72 ? coat.back : k > 0.3 ? mix(coat.side, coat.back, step(0.55, 0.72, k)) : mix(coat.belly, coat.side, step(0.16, 0.3, k));
        if (n === 0) {
            if (Math.abs(k - 0.5) < 0.1 && z < 2.5) c = mix(c, coat.band, 0.7);
            if (k > 0.4 && hash(Math.floor(z * 2.3), Math.floor(p[1] * 2.3), Math.sign(p[0]), coat.seed) > 0.78) c = coat.mark;
        } else if (n === 1) {
            if (blotch([p[0] * 0.3, p[1], p[2]], 2.6, coat.seed) > 0.5) c = coat.mark;
        } else if (k > 0.26 && z < 2.6 && fract(z * 0.62 + 0.15) < 0.4 - (0.72 - k) * 0.25) c = mix(c, coat.mark, 0.8);
        if (z < 2.45) {
            // Scales: a lattice of them, each catching the light at its edge.
            const sx = z * 2 + (Math.floor(p[1] * 2) & 1) * 0.5;
            c = mul(c, fract(sx) < 0.3 ? 0.9 : 1.03);
        } else {
            // The head: smooth. An eye ringed with gold, the gill cover behind it, a mouth.
            const e = eye(t);
            if (e) return finish(e === 'K' ? BLACK : hex(0xd9b545), t, 0);
            if (Math.abs(z - 2.5 - (1 - ((p[1] - 2.3) / 1.2) ** 2) * 0.22) < 0.09 && Math.abs(p[1] - 2.3) < 1.1) c = mul(c, 0.7);
            if (z > 3.85 && Math.abs(p[1] - 2.0) < 0.08) c = mul(c, 0.5);
        }
        return finish(c, t, 0.04);
    })));
}

// ── Quiddle ──────────────────────────────────────────────────────────────────
{
    const M = MODELS.quiddle;
    // The head is modelled life-size and then enlarged (QUIDDLE_HEAD). The
    // painters below work on the life-size head: a texel on anything that is
    // on the head is taken back to where it was before it grew.
    const lifeSize = (p) => p.map((v, i) => QUIDDLE_HEAD.at[i] + (v - QUIDDLE_HEAD.at[i]) / QUIDDLE_HEAD.scale);
    const ON_HEAD = new Set(['skull', 'nose', 'ear', 'lid', 'hairShort', 'hairLong', 'hairUnderHat', 'hatCrown', 'hatBrim']);
    const head = (fn) => (t) => { if (ON_HEAD.has(t.tag)) t.p = lifeSize(t.p); return fn(t); };
    const mark = (name) => lifeSize(M.marks[name]), EYE = mark('eye');
    const SKINS = [hex(0xf0c6a2), hex(0xdcae84), hex(0xc68e62), hex(0x7a5136), hex(0x58382a)];
    const skull = M.shapes.find(s => s.tag === 'skull'), side = skull.patches[0];
    // The face is drawn on the skull's own grid of texels, so that it is sharp
    // and the same both sides: `col` counts texels out from the middle of the
    // face, and the rows are found from the heights of the features.
    const rowY = Array.from({ length: side.h }, (_, j) => lifeSize(surfacePoint(M, skull, side, 0.5, (j + 0.5) / side.h, []).slice(0, 3))[1]);
    const rowAt = (y) => rowY.reduce((best, v, j) => Math.abs(v - y) < Math.abs(rowY[best] - y) ? j : best, 0);
    const R = { eye: rowAt(EYE[1] + 0.08), mouth: rowAt(mark('mouth')[1]), nose: rowAt(mark('noseBase')[1] - 0.12) };
    R.brow = Math.min(rowAt(mark('brow')[1] + 0.05), R.eye - 3);          // always a row of skin between the lid and the brow
    const col = (t) => { const k = t.i - t.w / 2; return k >= 0 ? k : -k - 1; };
    const onFace = (t) => t.tag === 'skull' && t.kind === 'side' && col(t) < t.w / 4;
    // An eye is four texels across, the fifth of the face it should be, and
    // three down — rounder and more open than life, as a drawn face has them.
    // The iris is its middle two.
    const inEye = (t) => onFace(t) && t.j >= R.eye && t.j <= R.eye + 2 && col(t) >= 2 && col(t) <= 5;

    SKINS.forEach((skin, n) => made.push(paint(M, `quiddle_skin_${n + 1}`, head((t) => {
        const p = t.p, shade = mul(skin, 0.84), lip = mix(skin, hex(0xa8433f), n >= 3 ? 0.45 : 0.55), browC = mul(skin, n >= 3 ? 0.32 : 0.42);
        switch (t.tag) {
            case 'skull': {
                let c = skin;
                if (t.kind === 'cap') return finish(t.end ? shade : skin, t, 0.03);                // under the chin; the crown
                if (onFace(t)) {
                    const m = col(t), j = t.j;
                    if (inEye(t)) {
                        // The white: rounded off at its lower corners, so the eye has a shape.
                        if (j === R.eye + 2 && (m === 2 || m === 5)) return finish(mul(skin, 0.8), t, 0.02);
                        return finish(j === R.eye ? hex(0xe2ddd6) : hex(0xf6f3ee), t, 0);
                    }
                    if (j === R.eye - 1 && m >= 2 && m <= 5) return finish(mul(skin, m === 2 ? 0.7 : m === 5 ? 0.55 : 0.42), t, 0.02);   // the upper lid and its lashes
                    if (j === R.eye - 1 && m === 6) c = mul(skin, 0.8);
                    if (j === R.eye + 3 && m >= 3 && m <= 4) c = mul(skin, 0.92);                                         // the lower lid
                    if (j === R.brow && m >= 1 && m <= 6) return finish(m === 1 || m === 6 ? mix(skin, browC, 0.5) : browC, t, 0.03);
                    if (j === R.brow - 1 && m >= 3 && m <= 4) return finish(mix(skin, browC, 0.45), t, 0.03);            // the arch of the brow
                    if (m === 0 && j > R.eye + 2 && j < R.nose) c = mul(skin, 1.04);                                      // the bridge of the nose, where it runs into the face
                    if (m <= 1 && j === R.nose + 1) c = mul(skin, 0.86);                                                  // under the nose
                    if (j === R.mouth && m <= 2) return finish(mul(lip, m === 2 ? 0.8 : 0.62), t, 0.02);                  // the line between the lips
                    if (j === R.mouth - 1 && m <= 1) c = mix(skin, lip, 0.5);                                             // upper lip
                    if (j === R.mouth + 1 && m <= 1) c = mix(skin, lip, 0.7);                                             // lower lip, fuller
                    if (j === R.mouth + 2 && m <= 1) c = mul(skin, 0.9);                                                  // the hollow under it
                    if (m >= 5 && m <= 8 && j > R.nose - 2 && j < R.mouth) c = mix(c, hex(0xd9776c), 0.14);               // colour in the cheeks
                }
                if (p[1] < 24.95) c = mix(c, shade, 0.5);                                           // the jaw turns under
                return finish(c, t, 0.03);
            }
            case 'nose':
                if (t.kind === 'cap') return finish(Math.abs(Math.abs(p[0]) - 0.15) < 0.09 ? mul(skin, 0.45) : shade, t, 0.02);   // nostrils
                return finish(mul(skin, 1.03 - 0.12 * step(0.5, 0.95, Math.abs(t.n[0]))), t, 0.02);
            case 'ear':  return finish(mul(skin, Math.abs(t.n[0]) > 0.5 ? 0.84 + 0.14 * step(0.12, 0.4, Math.hypot(p[1] - 26.3, p[2] + 0.12)) : 0.95), t, 0.02);   // darker in its hollow
            case 'neck': return finish(mix(skin, shade, step(24.2, 24.7, p[1]) * 0.8), t, 0.03);
            case 'lid':  return finish(t.j === t.h - 1 ? mul(skin, 0.45) : mul(skin, 0.93), t, 0.02);   // lashes along the edge of the lid
            case 'arm': {
                let c = skin;
                if (Math.abs(p[1] - 18.5) < 0.3 && t.n[2] < -0.5) c = mul(skin, 0.92);                    // the point of the elbow
                if (p[1] < 13.15 && p[1] > 12.9) c = mul(skin, 0.94);                                     // the knuckles
                return finish(c, t, 0.035);
            }
            case 'finger': return finish(t.kind === 'cap' ? mix(skin, hex(0xf2d9cf), 0.45) : mul(skin, 0.97), t, 0.03);   // paler at the tip: the nail
            case 'leg': return finish(Math.abs(p[1] - 8.4) < 0.4 && t.n[2] > 0.5 ? mul(skin, 0.93) : skin, t, 0.035);
            case 'shoe': case 'torso': return finish(skin, t, 0.035);
        }
        return null;   // skirts are the outfits', hair and hats the hair layers'
    }))));

    // Eyes: the iris, darker under the lid, lighter below.
    [hex(0x6a4424), hex(0x3d78c2), hex(0x3f8f4f)].forEach((iris, n) => made.push(paint(M, `quiddle_eyes_${n + 1}`, (t) => {
        if (!inEye(t) || col(t) < 3 || col(t) > 4) return null;
        // Dark under the lid, a pupil toward the nose, the colour clearest below it.
        return [...mul(iris, t.j === R.eye ? 0.45 : t.j === R.eye + 1 && col(t) === 3 ? 0.3 : 1.05), 255];
    })));

    // Outfits. Heights, in px: shoulder 22.6, elbow 18.5, waist 17.6, wrist 14.6,
    // crotch 13.5, knee 8.3, ankle 1.5.
    const FALL = [0, 1, 0];
    const cloth = (c, t, seed, folds = 0.1) => finish(mul(c, 1 + (streak(t.p, FALL, 0.8, 5, seed) - 0.5) * folds * 2 - 0.1 * under(t)), t, 0.045);
    const front = (t) => t.n[2] > 0.25;
    const leather = (c, t) => finish(mul(c, 0.92 + noise(t.p, 0.9, 6) * 0.16), t, 0.03);
    const sole = (t) => t.tag === 'shoe' && t.p[1] < 0.28;
    const OUTFITS = [
        // 1 — a farmer: a green tunic, belted, open at the throat, over brown trousers and boots.
        (t) => {
            const p = t.p, y = p[1], ax = Math.abs(p[0]);
            const tunic = hex(0x4c8440), trim = hex(0x2f5a2a), belt = hex(0x5a3a20), buckle = hex(0xd8b24a), trousers = hex(0x6b4d33), boot = hex(0x3d2c20);
            switch (t.tag) {
                case 'torso':
                    if (y < 17.0) return cloth(trousers, t, 3);
                    if (y < 17.75) return front(t) && ax < 0.55 ? finish(buckle, t, 0.02) : leather(belt, t);
                    // The neck of it: a slit down the breast, edged.
                    if (front(t) && y > 21.0) {
                        const open = (y - 21.0) * 0.42;
                        if (ax < open) return null;
                        if (ax < open + 0.36) return cloth(trim, t, 4, 0.05);
                    }
                    if (y > 23.3) return cloth(trim, t, 4, 0.05);                                  // the collar
                    return cloth(tunic, t, 4);
                case 'skirt':
                    // The skirt of the tunic, hemmed.
                    if (y < 12.75) return cloth(trim, t, 4, 0.05);
                    return cloth(mul(tunic, 0.96), t, 4, 0.14);
                case 'arm':
                    if (y < 19.3) return null;                                                      // short sleeves
                    return cloth(y < 19.75 ? trim : tunic, t, 4);
                case 'leg':  return y < 5.4 ? leather(y > 4.95 ? mul(boot, 1.35) : boot, t) : cloth(trousers, t, 3);   // boots to the calf, turned over at the top
                case 'shoe': return leather(sole(t) ? mul(boot, 0.6) : boot, t);
            }
            return null;
        },
        // 2 — blue overalls over a cream shirt, the sleeves rolled.
        (t) => {
            const p = t.p, y = p[1], ax = Math.abs(p[0]);
            const denim = hex(0x3f64a6), seam = hex(0x2a4577), shirt = hex(0xece3cf), cuff = hex(0xd6cbb2), shoe = hex(0x4b3324), button = hex(0xe0bf58);
            switch (t.tag) {
                case 'torso': {
                    if (y < 17.9) return cloth(y > 17.45 ? seam : denim, t, 5);                    // the waistband
                    if (front(t)) {
                        if (ax < 1.75 && y < 21.5) {                                                // the bib, with a pocket
                            if (y > 21.1 || ax > 1.45) return cloth(seam, t, 5, 0.04);
                            if (ax < 0.9 && y > 19.0 && y < 20.4 && (ax > 0.62 || y > 20.1 || y < 19.3)) return cloth(seam, t, 5, 0.04);
                            return cloth(denim, t, 5);
                        }
                        // Straps from the corners of the bib over the shoulders, buttoned.
                        if (y >= 20.8 && Math.abs(ax - 1.45 - (y - 21.3) * 0.28) < 0.42) return y < 21.6 && y > 21.0 ? finish(button, t, 0.02) : cloth(denim, t, 5);
                    } else if (t.n[2] < -0.25 || y > 23.2) {
                        if (y > 18 && Math.abs(ax - (23.9 - y) * 0.42) < 0.4) return cloth(denim, t, 5);   // crossed behind
                    }
                    if (y > 23.35 && !(front(t) && ax < 0.7)) return cloth(cuff, t, 6, 0.04);       // collar
                    return cloth(shirt, t, 6);
                }
                case 'arm':
                    if (y < 17.3) return null;                                                      // forearms bare
                    return cloth(y < 17.9 ? cuff : shirt, t, 6);                                    // the roll of the sleeve
                case 'leg':
                    if (y < 2.9) return cloth(seam, t, 5, 0.04);                                    // turn-ups
                    if (Math.abs(t.n[0]) > 0.93 && Math.sign(t.n[0]) === Math.sign(p[0])) return cloth(seam, t, 5, 0.04);   // the seam down the outside
                    return cloth(mul(denim, Math.abs(y - 8.3) < 0.7 && t.n[2] > 0.4 ? 1.1 : 1), t, 5);   // worn pale at the knee
                case 'shoe': return leather(sole(t) ? mul(shoe, 0.6) : shoe, t);
            }
            return null;
        },
        // 3 — a long plum dress with a white apron, stockings and dark shoes.
        (t) => {
            const p = t.p, y = p[1], ax = Math.abs(p[0]);
            const dress = hex(0x87406d), dark = hex(0x5f2a4d), apron = hex(0xf0e8da), sash = hex(0xdfa63c), shoe = hex(0x2e2530), stocking = hex(0xe8e1d5);
            switch (t.tag) {
                case 'torso':
                    if (y < 17.2) return cloth(dress, t, 7);
                    if (y < 17.95) return cloth(sash, t, 8, 0.04);
                    if (front(t)) {
                        if (y > 22.3 && ax < 1.35 - (23.6 - y) * 0.25) return null;                 // a scooped neck
                        if (y > 22.05 && ax < 1.6 - (23.6 - y) * 0.25) return cloth(dark, t, 7, 0.04);
                        if (ax < 1.3 && y < 21.3) return cloth(apron, t, 8, 0.06);                  // the bib of the apron
                    }
                    if (Math.abs(ax - 1.3 - (y - 21.3) * 0.5) < 0.24 && y >= 21.3 && y < 23.6) return cloth(apron, t, 8, 0.05);   // its straps
                    return cloth(dress, t, 7);
                case 'skirt': {
                    // To the shins, falling in folds; the apron widens with it.
                    if (y < 6.1) return cloth(dark, t, 7, 0.05);                                    // the hem
                    if (front(t) && ax < 1.5 + (17.5 - y) * 0.13 && y > 8.6) {
                        return cloth(y < 9.1 || ax > 1.2 + (17.5 - y) * 0.13 ? mul(apron, 0.88) : apron, t, 8, 0.07);
                    }
                    const fold = fract(Math.atan2(p[0], p[2]) * 3.2 + 0.1) < 0.3 ? 0.86 : 1;
                    return cloth(mul(dress, y < 15 ? fold : 1), t, 7, 0.12);
                }
                case 'arm':
                    if (y < 14.9) return null;
                    if (y < 15.6) return cloth(apron, t, 8, 0.04);                                  // cuffs
                    return cloth(y > 21.2 ? mul(dress, 1.08) : dress, t, 7);
                case 'leg':  return cloth(stocking, t, 9, 0.04);
                case 'shoe': return leather(sole(t) ? mul(shoe, 0.6) : (p[1] > 1.05 && p[2] > -0.2 && p[2] < 1.2 ? stocking : shoe), t);   // cut low over the instep
            }
            return null;
        },
        // 4 — a man's: a white shirt under a brown waistcoat, grey trousers, black shoes.
        (t) => {
            const p = t.p, y = p[1], ax = Math.abs(p[0]);
            const shirt = hex(0xeeeae0), vest = hex(0x5a3d2a), edge = hex(0x3e2a1c), trousers = hex(0x55565c), shoe = hex(0x1f1c1c), button = hex(0xcfa94a);
            switch (t.tag) {
                case 'torso': {
                    if (y < 17.3) return cloth(trousers, t, 11);
                    // The waistcoat: open in a V over the shirt, buttoned below it, cut away at the arms.
                    const open = Math.max(0, (y - 19.6) * 0.5);
                    if (y < 22.9 && !(front(t) && ax < open) && ax < 3.05) {
                        if (front(t) && ax < open + 0.3) return cloth(edge, t, 12, 0.04);
                        if (front(t) && ax < 0.22 && y < 19.5) return fract(y * 1.1) < 0.35 ? finish(button, t, 0.02) : cloth(edge, t, 12, 0.04);
                        return cloth(y < 17.7 ? edge : vest, t, 12);
                    }
                    if (front(t) && ax < 0.8 && y > 23.2) return null;                              // the collar, open
                    return cloth(shirt, t, 13, 0.06);
                }
                case 'arm':  return y < 14.9 ? null : cloth(y < 15.4 ? mul(shirt, 0.9) : shirt, t, 13, 0.06);
                case 'leg':  return cloth(trousers, t, 11);
                case 'shoe': return leather(sole(t) ? mul(shoe, 0.6) : shoe, t);
            }
            return null;
        },
        // 5 — a woman's: a cream blouse, the sleeves to the elbow, and a long teal skirt.
        (t) => {
            const p = t.p, y = p[1], ax = Math.abs(p[0]);
            const blouse = hex(0xf2ead8), trim = hex(0xd9cdb0), skirt = hex(0x2f7a78), dark = hex(0x1f5957), band = hex(0x6a3a2a), shoe = hex(0x4a3226), stocking = hex(0xe8e1d5);
            switch (t.tag) {
                case 'torso':
                    if (y < 17.2) return cloth(skirt, t, 14);
                    if (y < 17.95) return leather(band, t);
                    if (front(t) && y > 22.5 && ax < 1.1 - (23.6 - y) * 0.3) return null;           // a round neck
                    if (front(t) && y > 22.3 && ax < 1.4 - (23.6 - y) * 0.3) return cloth(trim, t, 15, 0.04);
                    if (front(t) && ax < 0.16 && y < 22.3) return fract(y * 0.9) < 0.3 ? finish(hex(0xb9a67c), t, 0.02) : cloth(trim, t, 15, 0.04);   // buttons down the front
                    return cloth(blouse, t, 15, 0.08);
                case 'skirt': {
                    if (y < 6.3) return cloth(dark, t, 14, 0.05);
                    const fold = fract(Math.atan2(p[0], p[2]) * 4 + 0.3) < 0.28 ? 0.85 : 1;
                    return cloth(mul(skirt, y < 15.5 ? fold : 1), t, 14, 0.12);
                }
                case 'arm':
                    if (y < 17.6) return null;
                    return cloth(y < 18.2 ? trim : blouse, t, 15, 0.08);
                case 'leg':  return cloth(stocking, t, 9, 0.04);
                case 'shoe': return leather(sole(t) ? mul(shoe, 0.6) : shoe, t);
            }
            return null;
        },
        // 6 — a knitted jumper, russet, ribbed at the neck, the cuffs and the hem; dark trousers and boots.
        (t) => {
            const p = t.p, y = p[1];
            const wool = hex(0xa5512e), rib = hex(0x7e3a20), trousers = hex(0x3a3f4d), boot = hex(0x3a2a1f);
            // Knitting: rows of stitches, each a little V.
            const knit = (c) => finish(mul(c, (fract(y * 2.2) < 0.4 ? 0.9 : 1) * (0.94 + noise(p, 0.6, 21) * 0.12) * (1 - 0.1 * under(t))), t, 0.04);
            const ribbed = (c) => finish(mul(c, fract((t.tag === 'arm' ? p[2] : Math.atan2(p[0], p[2]) * 3) * 2.4) < 0.45 ? 0.8 : 1), t, 0.03);
            switch (t.tag) {
                case 'torso':
                    if (y < 16.4) return cloth(trousers, t, 16);
                    if (y < 17.1) return ribbed(rib);
                    if (y > 23.3) return ribbed(rib);
                    return knit(wool);
                case 'arm':
                    if (y < 14.7) return null;
                    return y < 15.4 ? ribbed(rib) : knit(wool);
                case 'leg':  return y < 4.6 ? leather(boot, t) : cloth(trousers, t, 16);
                case 'shoe': return leather(sole(t) ? mul(boot, 0.6) : boot, t);
            }
            return null;
        },
    ];
    OUTFITS.forEach((fn, n) => made.push(paint(M, `quiddle_outfit_${n + 1}`, fn)));

    // Hair and hats. The hair is a shape of its own over the skull; the texture
    // cuts its edge. `round` is how far round the head a texel is from the
    // front, radians: 0 the middle of the forehead, π the back.
    const round = (p) => Math.abs(Math.atan2(p[0], p[2] - 0.1));
    const strands = (c, t, seed) => {
        // Hair lies outward from the crown on top and falls straight below it.
        const p = t.p, top = p[1] > 28.2;
        const lock = top ? streak(p, [p[0], 0, p[2] + 0.4].map(v => v / (Math.hypot(p[0], p[2] + 0.4) || 1)), 0.32, 7, seed) : streak(p, FALL, 0.3, 9, seed);
        return finish(mul(c, 0.82 + lock * 0.36), t, 0.03);
    };
    // Behind the ear and round the back, hair comes down to `nape`; over the ear it stops above it.
    const below = (p, nape) => { const r = round(p); return r > 1.42 && r < 2.0 ? p[1] > 26.95 : r >= 2.0 && p[1] > nape + (Math.PI - r) * 0.45; };
    // Five colours: brown, fair, black, auburn, grey — each a tone and a deeper one.
    const COLOURS = [[hex(0x5b3b24), hex(0x3e2616)], [hex(0xdeb25a), hex(0xb7862f)], [hex(0x2d2521), hex(0x191413)], [hex(0x9a4a22), hex(0x6e3013)], [hex(0xb5b2ac), hex(0x8b8882)]];
    const short = (t, c) => {
        const p = t.p, r = round(p);
        const ragged = (noise([p[0] * 3, 0, p[2] * 3], 1, 2) - 0.5) * 0.22;
        if (r < 0.95) {
            // The fringe: lowest on the side it is swept to.
            const line = 27.98 - step(-0.5, 1.3, p[0]) * 0.55 + ragged;
            return p[1] > line ? strands(p[1] < line + 0.2 ? mul(c, 0.85) : c, t, 1) : null;
        }
        if (r <= 1.42) return p[1] > 27.45 - (r - 0.95) * 2.4 + ragged ? strands(c, t, 1) : null;   // the temple, down to a sideburn
        return below(p, 25.75 + ragged) ? strands(c, t, 1) : null;
    };
    const HAIR = [
        // 1 — short, parted on one side and swept across the brow.
        (t, c) => t.tag === 'hairShort' ? short(t, c) : null,
        // 2 — long, parted in the middle, framing the face and falling down the back.
        (t, c, deep) => {
            const p = t.p;
            if (t.tag === 'hairBack') {
                if (t.kind === 'cap') return strands(deep, t, 2);
                // Uneven ends.
                if (p[1] < 20.3 + hash(Math.floor(p[0] * 5), 0, 0, 5) * 0.9) return null;
                return strands(t.n[2] > 0.3 ? deep : c, t, 2);
            }
            if (t.tag !== 'hairLong') return null;
            const r = round(p);
            // The face shows between two curtains of hair that part at the crown.
            const edge = 0.14 + step(28.2, 26.6, p[1]) * 0.82;
            if (r < edge && p[1] < 28.25) return null;
            if (r < edge + 0.13 && p[1] < 28.25) return strands(deep, t, 2);
            return strands(Math.abs(p[0]) < 0.09 && p[1] > 28.2 && p[2] > -0.6 ? deep : c, t, 2);   // the parting
        },
        // 3 — a straw hat with a red band, hair showing under it.
        (t, c) => {
            const p = t.p, straw = hex(0xe2c574), weave = hex(0xc2a04c), band = hex(0xb5332b);
            if (t.tag === 'hatBrim' || t.tag === 'hatCrown') {
                if (t.tag === 'hatCrown' && t.kind === 'side' && p[1] < 28.95) return finish(mul(band, 0.9 + 0.2 * step(28.45, 28.9, p[1])), t, 0.03);
                // Plaited straw: the braid runs round the hat, ring after ring.
                const ring = t.tag === 'hatBrim' || t.kind === 'cap' ? Math.hypot(p[0], p[2] - 0.1) : p[1] * 1.1;
                const plait = fract(ring * 2.6 + (Math.floor(Math.atan2(p[0], p[2]) * 9) & 1) * 0.5) < 0.5;
                return finish(mul(plait ? straw : weave, t.tag === 'hatBrim' && t.n[1] < -0.3 ? 0.7 : 1), t, 0.035);
            }
            if (t.tag !== 'hairUnderHat' || p[1] > 28.4) return null;
            const r = round(p);
            if (r < 1.05) return null;
            if (r <= 1.42) return p[1] > 26.5 ? strands(c, t, 3) : null;                              // sideburns
            return below(p, 25.7) ? strands(c, t, 3) : null;
        },
        // 4 — a man's: cropped close, the hairline high and square.
        (t, c) => {
            if (t.tag !== 'hairShort') return null;
            const p = t.p, r = round(p), crop = mul(c, 0.92);
            if (r < 0.95) return p[1] > 28.05 ? strands(crop, t, 4) : null;
            if (r <= 1.42) return p[1] > 28.05 - (r - 0.95) * 2.2 ? strands(crop, t, 4) : null;
            return below(p, 26.35) ? strands(crop, t, 4) : null;
        },
        // 5 — a woman's: drawn back off the face into a bun.
        (t, c, deep) => {
            const p = t.p;
            if (t.tag === 'bun') return finish(mul(c, 0.84 + streak(p, [1, 0, 0], 0.3, 7, 5) * 0.34), t, 0.03);
            if (t.tag !== 'hairLong') return null;
            const r = round(p);
            if (r < 1.0) return p[1] > 27.95 - r * r * 0.85 ? strands(c, t, 5) : null;
            if (r <= 1.42) return p[1] > 27.1 - (r - 1.0) * 0.4 ? strands(c, t, 5) : null;
            return below(p, 25.95) ? strands(p[1] < 26.3 ? deep : c, t, 5) : null;
        },
        // 6 — a man's: short, with a full beard and moustache.
        (t, c, deep) => {
            if (t.tag === 'hairShort') return short(t, c);
            if (t.tag !== 'skull') return null;
            const p = t.p, ax = Math.abs(p[0]), y = p[1];
            if (t.kind === 'cap') return t.end ? strands(deep, t, 6) : null;                        // under the chin
            if (p[2] < -0.3 || y > 26.35) return null;
            const lips = ax < 0.5 && y > 25.05 && y < 25.42;
            const moustache = ax < 0.78 && y >= 25.42 && y < 25.62;
            // Down the cheek from the sideburn, round the jaw and over the chin.
            const jaw = y < 25.5 - (1 - Math.min(1, ax / 1.1)) * 0.0 && (y < 25.0 || ax > 0.62 + (25.6 - y) * 0.2) || (ax > 1.12 && y < 26.35);
            if (lips || !(moustache || jaw)) return null;
            return strands(y > 25.9 ? c : deep, t, 6);
        },
    ];
    HAIR.forEach((fn, n) => COLOURS.forEach(([c, deep], k) => made.push(paint(M, `quiddle_hair_${n + 1}_${k + 1}`, head((t) => fn(t, c, deep))))));
}

// What these were painted for (MobShapes: layoutKey), so the game can tell when a model has moved on.
fs.writeFileSync(path.join(OUT, 'layout.json'), JSON.stringify(Object.fromEntries(Object.entries(MODELS).map(([name, m]) => [name, layoutKey(m)])), null, 2) + '\n');
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png') && !made.includes(f.slice(0, -4))) fs.unlinkSync(path.join(OUT, f));   // a look that is no longer made
console.log(`${made.length} textures → ${OUT}`);
for (const [name, m] of Object.entries(MODELS)) console.log(`  ${name.padEnd(8)} ${m.atlas.width} × ${m.atlas.height}`);
