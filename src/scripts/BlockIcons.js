/**
 * BlockIcons — the inventory's pictures of the blocks that are not cubes.
 *
 * A slab, a flight of stairs and a fence post are all the same planks: shown
 * as their texture they could not be told apart. So each is drawn as it
 * stands, seen from above one corner, from the same boxes the game draws it
 * with (engine/BlockShapes.js) and the same textures — nothing here has to be
 * kept in step with a model by hand, and a new model has its picture as soon
 * as it exists.
 *
 * Flat things stay flat: a plant, a ladder, a painting are their texture, and
 * a door is its two halves one over the other; a painting several blocks
 * across is the whole picture, put together from its pieces.
 *
 * The workstations (a crafting table, an oven, a smelter, a chest) are cubes
 * with faces of their own, and are drawn as cubes the same way (`CUBES`):
 * their top, their front and a side.
 *
 * main.js (not a module) reaches this through window.__wwBlockIcons(blocks):
 * a promise of { lowercased block name: image URL } for the blocks with a
 * model that are not one of several an item puts down (`variant`), and the
 * workstations.
 */
import { compileShape } from './engine/BlockShapes.js';

// Cubes drawn as cubes: their top, the face toward the left of the picture (their front) and the one toward the right.
const CUBES = {
    CRAFTING_TABLE: ['Crafting_Table_Top.png', 'Crafting_Table_Side.png', 'Crafting_Table_Side.png'],
    OVEN:           ['Oven_Top.png', 'Oven_Front.png', 'Oven_Side.png'],
    SMELTER:        ['Smelter_Top.png', 'Smelter_Front.png', 'Smelter_Side.png'],
    CHEST:          ['Chest_Top.png', 'Chest_Front.png', 'Chest_Side.png'],
};

const SIZE = 64;                        // the picture, in pixels
const T = 32;                           // a texture, in texels
// A block is 16 units. One unit along x or z goes this far across and down
// the picture, and one unit of height this far up it: a cube fills the square.
const AX = 1.75, AY = 0.875, UP = 2, TOP = 2;

// Models shown as their texture, not built.
const FLAT = new Set(['cross', 'ladder', 'painting', 'curtain', 'bunting', 'fire', 'torch', 'wall_torch', 'lantern', 'hanging_lantern']);

// The pictures are drawn one after another, a few milliseconds at a time,
// and made into images off the main thread (toBlob): drawn together, as soon
// as their textures had arrived, and each encoded there and then
// (toDataURL), they held up the title screen for half a second (there are a
// hundred of them). `fn` draws one and returns its canvas; what comes back is
// a URL of the picture.
const SLICE_MS = 6;
// A canvas kept in memory, not on the graphics card: making an image of one
// that is on the card means reading it back from there, which cost more than
// drawing it.
const CPU = { willReadFrequently: true };
let _queue = Promise.resolve(), _sliceAt = -Infinity;
function drawn(fn) {
    const turn = _queue.then(async () => {
        if (performance.now() - _sliceAt > SLICE_MS) {
            await new Promise(r => setTimeout(r, 0));
            _sliceAt = performance.now();
        }
        return fn();
    });
    _queue = turn.catch(() => {});
    return turn.then(canvas => new Promise(res => canvas.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png')));
}

const _images = new Map();
function image(file) {
    if (!_images.has(file)) {
        _images.set(file, new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = `data/textures/blocks/${file}`;
        }));
    }
    return _images.get(file);
}

const texturesOf = (def) => (typeof def.texture === 'string'
    ? { top: def.texture, side: def.texture, bottom: def.texture }
    : def.textures?.top ? { top: def.textures.top, side: def.textures.side ?? def.textures.top, bottom: def.textures.bottom ?? def.textures.top } : null);

/** A box's corners turned to the block's facing (a quarter turn keeps a box a box). */
function turned(b, c, s) {
    const ax = c * (b.from[0] - 8) + s * (b.from[2] - 8) + 8, az = -s * (b.from[0] - 8) + c * (b.from[2] - 8) + 8;
    const bx = c * (b.to[0] - 8) + s * (b.to[2] - 8) + 8, bz = -s * (b.to[0] - 8) + c * (b.to[2] - 8) + 8;
    return [Math.min(ax, bx), b.from[1], Math.min(az, bz), Math.max(ax, bx), b.to[1], Math.max(az, bz)];
}

const matOf = (el, face, fallback) => (typeof el.mat === 'string' ? el.mat : (el.mat?.[face] ?? fallback));

/** Draw one block as it stands. `img`: { top, side, bottom } images. */
function drawModel(ctx, shape, img) {
    const els = typeof shape.els === 'function' ? shape.els(0) : shape.els;
    const boxes = [], plants = [];
    for (const el of els) {
        if (el.cross) { plants.push(el); continue; }
        if (el.uv) continue;                           // a sheet of rectangles: those models are shown flat
        boxes.push({ el, b: turned(el, shape.cos, shape.sin) });
    }
    // Far to near, low to high: what is nearer the eye is drawn over what is behind it.
    boxes.sort((p, q) => (p.b[0] + p.b[3] + p.b[2] + p.b[5] + p.b[1] + p.b[4]) - (q.b[0] + q.b[3] + q.b[2] + q.b[5] + q.b[1] + q.b[4]));
    const face = (im, shade, a, b, c, d, e, f, sx, sy, sw, sh) => {
        if (!im || sw <= 0 || sh <= 0) return;
        ctx.setTransform(a, b, c, d, e, f);
        ctx.drawImage(im, sx, sy, sw, sh, sx, sy, sw, sh);
        if (shade > 0) { ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(sx, sy, sw, sh); }
    };
    for (const { el, b } of boxes) {
        const [x0, y0, z0, x1, y1, z1] = b;
        const only = el.only ?? 'ewsnud';
        const yt = (T / 16) * (16 - y1), h = (T / 16) * (y1 - y0);
        // The top, the side toward +X, the side toward +Z: the three that can be seen.
        if (only.includes('u')) face(img[matOf(el, 'u', 'top')], 0, AX / 2, AY / 2, -AX / 2, AY / 2, SIZE / 2, TOP + (16 - y1) * UP, x0 * 2, z0 * 2, (x1 - x0) * 2, (z1 - z0) * 2);
        if (only.includes('e')) face(img[matOf(el, 'e', 'side')], 0.2, -AX / 2, AY / 2, 0, UP / 2, SIZE / 2 + x1 * AX, TOP + x1 * AY, z0 * 2, yt, (z1 - z0) * 2, h);
        if (only.includes('s')) face(img[matOf(el, 's', 'side')], 0.38, AX / 2, AY / 2, 0, UP / 2, SIZE / 2 - z1 * AX, TOP + z1 * AY, x0 * 2, yt, (x1 - x0) * 2, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A plant in a pot: its picture, standing in the middle.
    for (const el of plants) {
        const im = img[el.mat ?? 'top'];
        if (!im) continue;
        const c = el.cross, w = (c[3] - c[0]) * AX * 1.3, hgt = (c[4] - c[1]) * UP * 1.15;
        const base = TOP + 16 * AY + (16 - c[1]) * UP;
        ctx.drawImage(im, SIZE / 2 - w / 2, base - hgt, w, hgt);
    }
}

/** A cube: its top, and the two sides that can be seen. */
async function cubeIcon(files) {
    const [top, left, right] = await Promise.all(files.map(image));
    if (!top || !left || !right) return null;
    return drawn(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext('2d', CPU);
        ctx.imageSmoothingEnabled = false;
        drawModel(ctx, { els: [{ from: [0, 0, 0], to: [16, 16, 16], mat: { u: 'top', e: 'side', s: 'bottom' } }], cos: 1, sin: 0 }, { top, side: right, bottom: left });
        return canvas;
    });
}

/** A painting several blocks across, whole: each piece's part of its texture, where the piece hangs. */
async function paintingIcon(def, byName) {
    const p = def.place, names = p.pictures?.[0]?.east;
    if (!names || names.length !== p.w * p.h) return null;
    const pieces = names.map(n => byName.get(n));
    const ims = await Promise.all(pieces.map(piece => (piece?.texture ? image(piece.texture) : null)));
    if (pieces.some((piece, i) => !ims[i] || !Array.isArray(piece?.shape?.tile))) return null;
    return drawn(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext('2d', CPU);
        ctx.imageSmoothingEnabled = false;
        const cell = Math.floor(SIZE / Math.max(p.w, p.h)), x0 = (SIZE - cell * p.w) / 2, y0 = (SIZE - cell * p.h) / 2;
        for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
            const im = ims[j * p.w + i], [k, u0, v0] = pieces[j * p.w + i].shape.tile, w = im.width * k, h = im.height * k;
            ctx.drawImage(im, u0 * im.width, (1 - v0 - k) * im.height, w, h, x0 + i * cell, y0 + (p.h - 1 - j) * cell, cell, cell);
        }
        return canvas;
    });
}

async function iconFor(def, byName) {
    if (CUBES[def.name] && !def.model) return cubeIcon(CUBES[def.name]);
    if (def.place?.mode === 'painting') return paintingIcon(def, byName);
    // Stairs are shown climbing away, so the steps are seen (built facing east, they would be seen from the back).
    const facing = def.model === 'stairs' ? 'west' : def.facing;
    const shape = compileShape({ model: def.model, facing, shape: def.shape ?? {} });
    const tex = texturesOf(def);
    if (!shape || !tex) return null;
    if (FLAT.has(def.model)) return null;               // its texture, as main.js shows any block's
    const [top, side, bottom] = await Promise.all([image(tex.top), image(tex.side), image(tex.bottom)]);
    if (!top && !side) return null;
    // A door is its two halves, one over the other.
    const upper = def.model === 'door' ? await image(String(tex.top).replace(/_Bottom\.png$/, '_Top.png')) : null;
    return drawn(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext('2d', CPU);
        ctx.imageSmoothingEnabled = false;
        if (def.model === 'door') {
            if (upper) ctx.drawImage(upper, SIZE / 4, 0, SIZE / 2, SIZE / 2);
            ctx.drawImage(top, SIZE / 4, SIZE / 2, SIZE / 2, SIZE / 2);
        } else {
            drawModel(ctx, shape, { top, side, bottom });
        }
        return canvas;
    });
}

window.__wwBlockIcons = async (blocks) => {
    const out = {};
    const byName = new Map((blocks ?? []).map(b => [b.name, b]));
    await Promise.all((blocks ?? []).filter(b => (b.model && !b.variant) || CUBES[b.name]).map(async (b) => {
        try {
            const url = await iconFor(b, byName);
            if (url) out[b.name.toLowerCase()] = url;
        } catch { /* its texture will do */ }
    }));
    return out;
};
