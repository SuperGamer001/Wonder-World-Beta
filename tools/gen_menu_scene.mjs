// Bakes the place behind the menus into one 3D model: data/menu/scene.glb.
//
//   node tools/gen_menu_scene.mjs [--all] [--out file.glb]        (npm run menuscene)
//
// The title screen used to load a world to stand in front of — the workers, a
// few hundred chunks generated, meshed and lit — just to show two views of it.
// This does that work once, here: it generates the real terrain round a spot
// (the game's own generator, meshers and sky-light solver, so it is the game's
// land exactly), and writes what the menu's cameras can face as a single
// glTF 2.0 binary, textures inside. The menu draws that file and nothing else
// (src/scripts/MenuScene.js).
//
// What goes in:
//   • Real chunks only, out to `radius` — no far-terrain (the low-detail land
//     the game draws beyond its chunks). What must show has to be within
//     reach of real chunks, the mountain included; fog hides the edge.
//   • Only what the menu's cameras can see. A chunk no view looks toward, and
//     a face turned away from every place the camera will be, cannot show.
//     And of what is left, most is behind something: the land beyond a ridge, the
//     far slopes of a valley, a hillside behind a house. So the scene is
//     drawn here, in software, from each place the camera will be — a depth
//     picture, then every face tested against it — and a face that is hidden
//     from all of them is left out (`visible`). That is nine tenths of it.
//     `--all` keeps every face in the radius that the sky's light reaches
//     (LIT_MIN: the rest are caves) instead: the whole place, for looking at
//     from anywhere — many times the size.
//   • Light. The sky light at each vertex is baked in; the sun is the menu's
//     to add from the normal.
//
// The file is glTF — a viewer that knows its two extensions opens it (three.js,
// Blender, Babylon: KHR_mesh_quantization for normals as bytes and texture
// coordinates as shorts, KHR_texture_transform for their scale), and shows the
// land textured and unlit. One material for each block texture (a 32 × 32
// image, repeating) and a mesh primitive for every 65,535 vertices of it, so
// about fifty draws for all of it. What only the game's own shader understands
// rides along where a viewer will ignore it: `_BLEND` on each vertex — which
// ground spreads over this one's edges and from which sides (see *Ground
// blending*), the sky light there, and its glow with a bit for natural
// ground — and `extras` on each material (its texture's place, leaves that
// sway, water) and on the scene (the views, where the player's figure and the
// animals stand, the fog).
//
// **The views are part of the bake.** Move a camera (SCENE.views) and run this
// again: what it leaves out depends on where they are.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlockRegistry }    from '../src/scripts/engine/BlockRegistry.js';
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { GreedyMesher }     from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }     from '../src/scripts/workers/SmoothMesher.js';
import { computeSkylight }  from '../src/scripts/workers/Skylight.js';
import { SMOOTH_REACH }     from '../src/scripts/engine/SmoothShape.js';
import { UV_SCALE, NO_LAYER } from '../src/scripts/engine/MeshFormat.js';
import { BLOCK_FACE_MAP, blockTextureLayers } from '../src/scripts/engine/BlockTextures.js';
import { SKY_MAX, SKY_FALLOFF, SKY_MIN } from '../src/scripts/engine/Sun.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const ALL = process.argv.includes('--all');
const OUT = arg('out', path.join(root, 'data', 'menu', 'scene.glb'));

// ── The place ────────────────────────────────────────────────────────────────
// Open grass with a few houses and trees on it, a mountain with snow on its
// peak standing two hundred blocks behind, and the sea round to the left.
// Each view is where the camera stands (x, z; it is put at eye height over the
// ground there) and the way it looks (yaw and pitch as the game's camera:
// yaw 0 looks along −z). `figure` and `animals` are placed from a view: so far
// ahead of it, and so far to its right.
const SCENE = {
    seed: 4242,
    center: [-2160, -3288],
    radius: 17,                       // chunks
    hours: 16.2,                      // the afternoon it always is there
    fog: [236, 268],                  // blocks: where the haze begins, and where it is complete
    eye: 1.7,
    views: {
        title:  { at: [-2155.4, -3286.1], yaw: -0.39, pitch: 0.15, fov: 72 }, // the mountain over the meadow, a house to the left
        worlds: { at: [-2184, -3276], yaw: 0.95, pitch: 0.05, fov: 70 },      // along the hill to the sea, the cliffs on the right
    },
    figure: { view: 'title', ahead: 6.4, right: -3.6 },
    animals: [
        { type: 'cow', view: 'title', ahead: 15.5, right: 8.5 }, { type: 'cow', view: 'title', ahead: 24, right: 10 },
        { type: 'sheep', view: 'title', ahead: 15, right: 1.5 }, { type: 'chicken', view: 'title', ahead: 9, right: 3.5 },
        { type: 'sheep', view: 'worlds', ahead: 15, right: 5 }, { type: 'sheep', view: 'worlds', ahead: 19, right: 8 },
        { type: 'sheep', view: 'worlds', ahead: 14, right: 11 },
        { type: 'cow', view: 'worlds', ahead: 26, right: 4 }, { type: 'pig', view: 'worlds', ahead: 7.5, right: -6.5 },
    ],
};
const FOOT = 0.35;                                      // an animal stands on the highest ground within this of its middle
const LIT_MIN = Math.pow(SKY_FALLOFF, SKY_MAX - 5);     // a face darker than sky light 5 is a cave's
const PATH_STEPS = 24;                                  // places along the way from one view to the other that are looked from
const STILL = [2560, 1440], MOVING = [1280, 720];       // the pictures faces are tested against: where the camera rests, and on its way
// Half of what the widest view takes in sideways (the picture is 16:9), and a tenth of a turn more.
const WEDGE = Math.atan(Math.tan(Math.max(...Object.values(SCENE.views).map(v => v.fov)) * Math.PI / 360) * 16 / 9) + 0.19;

// ── The game's own pipeline (as test/pipelinebench.mjs runs it) ──────────────
const reg = new BlockRegistry();
for (const f of fs.readdirSync(path.join(root, 'data/blocks'))) reg.register(JSON.parse(fs.readFileSync(path.join(root, 'data/blocks', f), 'utf8')));
const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));
const { layers: LAYERS, faceMap, swayRange } = blockTextureLayers(reg);
const gen    = new TerrainGenerator(SCENE.seed, reg, readDir('data/biomes'), readDir('data/terrain'));
const mesher = new GreedyMesher(reg, faceMap);
const smooth = new SmoothMesher(reg, mesher);
const key = (cx, cz) => `${cx},${cz}`;
const ALL_FACES = [0, 1, 2, 3, 4, 5];
const leafLayer = (l) => l === BLOCK_FACE_MAP[7]?.top || (l >= swayRange[0] && l <= swayRange[1]);

// ── Where the camera will be ─────────────────────────────────────────────────
const fwdOf = (yaw) => [-Math.sin(yaw), -Math.cos(yaw)];
const [ccx, ccz] = SCENE.center.map(v => Math.floor(v / CHUNK_SIZE));
const poses = [];
{
    const a = SCENE.views.title, b = SCENE.views.worlds;
    for (let i = 0; i <= PATH_STEPS; i++) {
        const t = i / PATH_STEPS;
        poses.push({ x: a.at[0] + (b.at[0] - a.at[0]) * t, z: a.at[1] + (b.at[1] - a.at[1]) * t, yaw: a.yaw + (b.yaw - a.yaw) * t, y: 0,
                     pitch: a.pitch + (b.pitch - a.pitch) * t, fov: a.fov + (b.fov - a.fov) * t, still: i === 0 || i === PATH_STEPS });
    }
}
const facing = (cx, cz) => {
    const x = cx * CHUNK_SIZE + 8, z = cz * CHUNK_SIZE + 8;
    for (const p of poses) {
        const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
        if (d < 44) return true;
        const [fx, fz] = fwdOf(p.yaw);
        if (Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d))) <= WEDGE) return true;
    }
    return false;
};
const wanted = [];
for (let cz = ccz - SCENE.radius; cz <= ccz + SCENE.radius; cz++) for (let cx = ccx - SCENE.radius; cx <= ccx + SCENE.radius; cx++) {
    if (Math.hypot(cx - ccx, cz - ccz) > SCENE.radius + 0.5) continue;
    if (ALL || facing(cx, cz)) wanted.push([cx, cz]);
}

// ── Generate ─────────────────────────────────────────────────────────────────
const t0 = performance.now();
const voxels = new Map(), chunks = new Map();
const need = new Set();
for (const [cx, cz] of wanted) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) need.add(key(cx + dx, cz + dz));
for (const k of need) {
    const [cx, cz] = k.split(',').map(Number);
    const v = gen.generate(cx, cz), cd = new ChunkData(cx, cz);
    cd.loadVoxels(v);
    voxels.set(k, v); chunks.set(k, cd);
}
console.log(`generated ${need.size} chunks (${wanted.length} to draw) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

/** The top of the ground at a column, from the voxels: the highest block that is not air, leaves or a log. */
const SOFT = new Set(reg.serialize().filter(b => /LEAVES|LOG|WOOD|CACTUS|MUSHROOM/.test(b.name)).map(b => b.id));
function columnTop(x, z) {
    const v = voxels.get(key(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
    if (!v) return 64;
    const lx = ((Math.floor(x) % 16) + 16) % 16, lz = ((Math.floor(z) % 16) + 16) % 16;
    for (let ly = CHUNK_SIZE_Y - 1; ly >= 0; ly--) {
        const id = v[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE_Y];
        if (id !== 0 && !SOFT.has(id)) return ly + WORLD_MIN_Y + 1;
    }
    return 64;
}
for (const p of poses) p.y = columnTop(p.x, p.z) + SCENE.eye;

// Places whose exact height on the drawn ground is wanted: the views, the figure, the animals.
const from = (view, ahead, right) => {
    const v = SCENE.views[view], [fx, fz] = fwdOf(v.yaw);
    return [v.at[0] + fx * ahead + Math.cos(v.yaw) * right, v.at[1] + fz * ahead - Math.sin(v.yaw) * right];
};
// A camera wants the ground under it; whoever stands there wants the ground under its feet, which on a
// slope is not what is under its middle (an animal placed by its middle stood up to its belly in a bank).
const spots = [];
const spot = (s, r) => spots.push({ ...s, y: null, pts: (r ? [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] : [[0, 0]]).map(([dx, dz]) => ({ x: s.x + dx, z: s.z + dz, y: null })) });
for (const [name, v] of Object.entries(SCENE.views)) spot({ kind: 'view', name, x: v.at[0], z: v.at[1] }, 0);
{ const [x, z] = from(SCENE.figure.view, SCENE.figure.ahead, SCENE.figure.right); spot({ kind: 'figure', view: SCENE.figure.view, x, z }, 0.2); }
for (const a of SCENE.animals) { const [x, z] = from(a.view, a.ahead, a.right); spot({ kind: 'animal', type: a.type, view: a.view, x, z }, FOOT); }

// ── What is kept: buckets of triangles, one for each texture ─────────────────
const ORIGIN = [SCENE.center[0], 0, SCENE.center[1]];
const buckets = new Map();       // key → { layer, water, pos, nrm, uv, col, blend, idx }
const bucket = (layer, water) => {
    const k = `${layer}|${water ? 1 : 0}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = { layer, water, pos: [], nrm: [], uv: [], col: [], blend: [], idx: [], tri: [] });
    return b;
};
const bright = (level) => Math.max(Math.pow(SKY_FALLOFF, SKY_MAX - level), SKY_MIN);

let trisIn = 0, trisOut = 0;
const t1 = performance.now();
for (const [cx, cz] of wanted) {
    const c = chunks.get(key(cx, cz)), v = voxels.get(key(cx, cz));
    const nb = {}, corners = {}, far = CHUNK_SIZE - SMOOTH_REACH;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) nb[key(dx, dz)] = voxels.get(key(cx + dx, cz + dz));
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        corners[key(dx, dz)] = chunks.get(key(cx + dx, cz + dz)).cornerBlock(dx > 0 ? 0 : far, dz > 0 ? 0 : far, SMOOTH_REACH);
    }
    const yRange = { min: c.minFilledY, max: c.maxFilledY };
    const geo = mesher.meshGroup(v, nb, ALL_FACES, yRange, smooth.prepare(v, nb, corners, yRange));

    // The sky light round this chunk, as the game's shader reads it: half a block out along the normal.
    const views = [], minY = [], maxY = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const n = chunks.get(key(cx + dx, cz + dz));
        views.push(voxels.get(key(cx + dx, cz + dz))); minY.push(n.minFilledY); maxY.push(n.maxFilledY);
    }
    const L = computeSkylight(views, minY, maxY, mesher._solid);
    const lightAt = (x, y, z) => {
        const ly = Math.floor(y) - L.y0;
        if (ly >= L.h) return 1;
        if (ly < 0) return SKY_MIN;
        const lx = Math.max(0, Math.min(17, Math.floor(x) + 1)), lz = Math.max(0, Math.min(17, Math.floor(z) + 1));
        return bright(L.data[lx + ly * 18 + lz * 18 * L.h] / 255 * SKY_MAX);
    };

    const wx = cx * CHUNK_SIZE - ORIGIN[0], wz = cz * CHUNK_SIZE - ORIGIN[2];
    for (const water of [false, true]) {
        const P = water ? geo.transparentPositions : geo.positions, T = water ? geo.transparentTints : geo.tints;
        const U = water ? geo.transparentUVs : geo.uvs, N = water ? geo.transparentNormals : geo.normals;
        const I = water ? geo.transparentIndices : geo.indices;
        const light = new Float32Array(P.length / 3);
        for (let i = 0; i < light.length; i++) {
            light[i] = lightAt(P[i * 3] + N[i * 4] / 127 * 0.5, P[i * 3 + 1] + N[i * 4 + 1] / 127 * 0.5, P[i * 3 + 2] + N[i * 4 + 2] / 127 * 0.5);
        }
        const remap = new Map();      // this chunk's vertex → its place in its bucket
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t], b = I[t + 1], d = I[t + 2];
            trisIn++;
            // Which way it faces, from its corners (world y is local y + the world's floor).
            const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
            const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
            const vx = P[d * 3] - ax, vy = P[d * 3 + 1] - ay, vz = P[d * 3 + 2] - az;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            // The ground under a spot: where the upright line through it meets a face that looks up.
            if (!water && ny > 0) {
                for (const s of spots) {
                    if (s.x - cx * CHUNK_SIZE < -2 || s.z - cz * CHUNK_SIZE < -2 || s.x - cx * CHUNK_SIZE > 18 || s.z - cz * CHUNK_SIZE > 18) continue;
                    for (const q of s.pts) {
                        const px = q.x - cx * CHUNK_SIZE, pz = q.z - cz * CHUNK_SIZE;
                        const d1 = (uz * vx - ux * vz), e1 = ((px - ax) * -vz + (pz - az) * vx) / d1, e2 = ((px - ax) * uz - (pz - az) * ux) / d1;
                        if (!(e1 >= -1e-6 && e2 >= -1e-6 && e1 + e2 <= 1 + 1e-6)) continue;
                        const y = ay + e1 * uy + e2 * vy + WORLD_MIN_Y;
                        // Not a roof or a treetop: the first ground at or under where the land's own top is.
                        if (y <= columnTop(q.x, q.z) + 0.5 && (q.y === null || y > q.y)) q.y = y;
                    }
                }
            }
            if (ALL) {
                // The whole place: all but the caves.
                if (Math.max(light[a], light[b], light[d]) < LIT_MIN) continue;
            } else {
                // A face turned away from every place the camera will be cannot show. (Whether it is hidden
                // is asked later, of the pictures: a cave's mouth shows its walls, however dark.)
                const gx = ax + cx * CHUNK_SIZE, gy = ay + WORLD_MIN_Y, gz = az + cz * CHUNK_SIZE;
                let seen = false;
                for (const p of poses) if (nx * (p.x - gx) + ny * (p.y - gy) + nz * (p.z - gz) > 0) { seen = true; break; }
                if (!seen) continue;
            }
            const layer = T[a * 4 + 3];
            const out = bucket(layer, water);
            for (const i of [a, b, d]) {
                const rk = layer * 4194304 + i;
                let at = remap.get(rk);
                if (at === undefined) {
                    at = out.pos.length / 3;
                    remap.set(rk, at);
                    out.pos.push(P[i * 3] + wx, P[i * 3 + 1] + WORLD_MIN_Y, P[i * 3 + 2] + wz);
                    // The normal and the texture coordinates as the game packs them (MeshFormat.js).
                    out.nrm.push(N[i * 4], N[i * 4 + 1], N[i * 4 + 2]);
                    out.uv.push(U[i * 2], U[i * 2 + 1]);
                    const l = Math.round(light[i] * 255), glow = (Math.max(0, N[i * 4 + 3]) * 2) & 254;
                    if (layer === NO_LAYER) {
                        // No texture: its own colour, in the light there.
                        out.col.push(T[i * 4] * light[i], T[i * 4 + 1] * light[i], T[i * 4 + 2] * light[i], 255);
                        out.blend.push(0, 0, l, glow);
                    } else {
                        out.col.push(255, 255, 255, 255);
                        // Which ground spreads over this one's edges (its texture) and from which sides; the sky
                        // light here; and how much it glows, with one bit for "this is natural ground".
                        out.blend.push(T[i * 4], T[i * 4 + 1], l, glow | (T[i * 4 + 2] > 127 ? 1 : 0));
                    }
                }
                out.idx.push(at);
            }
            out.tri.push(trisOut++);
        }
    }
}
console.log(`meshed and lit in ${((performance.now() - t1) / 1000).toFixed(1)} s: ${trisOut.toLocaleString()} of ${trisIn.toLocaleString()} triangles face a view`);

// ── What can be seen ─────────────────────────────────────────────────────────
// Every triangle that faces a view, as nine numbers, and whether it hides what
// is behind it (glass and water do not).
const GLASSY = new Set(LAYERS.map((p, i) => /glass/i.test(p) ? i : -1).filter(i => i >= 0));
const TP = new Float32Array(trisOut * 9), solid = new Uint8Array(trisOut);
for (const b of buckets.values()) {
    const hides = !b.water && !GLASSY.has(b.layer) ? 1 : 0;
    for (let t = 0; t < b.tri.length; t++) {
        const g = b.tri[t];
        solid[g] = hides;
        for (let k = 0; k < 3; k++) {
            const v = b.idx[t * 3 + k] * 3;
            TP[g * 9 + k * 3] = b.pos[v] + ORIGIN[0]; TP[g * 9 + k * 3 + 1] = b.pos[v + 1]; TP[g * 9 + k * 3 + 2] = b.pos[v + 2] + ORIGIN[2];
        }
    }
}

/**
 * Mark (in `seen`) the triangles that show from one place. The scene is drawn
 * twice, as a graphics card would draw it: once for depth alone, and again
 * with each triangle asking whether any of it is at the front. A triangle too
 * thin to cover the middle of any pixel is judged by its corners instead — a
 * sliver that shows on a bigger screen than this picture must not be lost.
 */
function visible(pose, [W, H], seen, slivers = true) {
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;                 // the way it looks
    const rx = cy, rz = -sy;                                     // its right
    const ux = -fy * rz, uy = rz * fx - rx * fz, uz = rx * fy;   // its up: right × forward
    const f = 1 / Math.tan(pose.fov * Math.PI / 360), ax = f * H / W * 0.5 * W, ay = f * 0.5 * H;
    const depth = new Float32Array(W * H).fill(Infinity);
    const S = new Float32Array(9);       // the triangle on the picture: x, y and distance for each corner
    const NEAR = 0.1;
    /** Put triangle g on the picture. 0: not in it; 1: it is; 2: it comes through the camera (kept without asking). */
    const project = (g) => {
        const o = g * 9;
        // Turned away from here: a card would not draw it either.
        const e1x = TP[o + 3] - TP[o], e1y = TP[o + 4] - TP[o + 1], e1z = TP[o + 5] - TP[o + 2];
        const e2x = TP[o + 6] - TP[o], e2y = TP[o + 7] - TP[o + 1], e2z = TP[o + 8] - TP[o + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        if (nx * (pose.x - TP[o]) + ny * (pose.y - TP[o + 1]) + nz * (pose.z - TP[o + 2]) <= 0) return 0;
        let behind = 0;
        for (let k = 0; k < 3; k++) {
            const dx = TP[o + k * 3] - pose.x, dy = TP[o + k * 3 + 1] - pose.y, dz = TP[o + k * 3 + 2] - pose.z;
            const z = dx * fx + dy * fy + dz * fz;
            if (z < NEAR) { behind++; continue; }
            S[k * 3] = W * 0.5 + (dx * rx + dz * rz) * ax / z;
            S[k * 3 + 1] = H * 0.5 - (dx * ux + dy * uy + dz * uz) * ay / z;
            S[k * 3 + 2] = z;
        }
        return behind === 3 ? 0 : behind > 0 ? 2 : 1;
    };
    /** Walk the pixels whose middles triangle S covers: fn(index, distance) → true to stop. Returns how many. */
    const walk = (fn) => {
        const x0 = S[0], y0 = S[1], x1 = S[3], y1 = S[4], x2 = S[6], y2 = S[7];
        const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5)), maxX = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
        const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5)), maxY = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
        if (minX > maxX || minY > maxY) return 0;
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0) return 0;
        const iz0 = 1 / S[2], iz1 = 1 / S[5], iz2 = 1 / S[8];
        let n = 0;
        for (let y = minY; y <= maxY; y++) {
            const py = y + 0.5;
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5;
                const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
                const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                n++;
                if (fn(y * W + x, 1 / (w0 * iz0 + w1 * iz1 + w2 * iz2))) return n;
            }
        }
        return n;
    };
    const put = (i, z) => { if (z < depth[i]) depth[i] = z; return false; };
    for (let g = 0; g < trisOut; g++) if (solid[g] && project(g) === 1) walk(put);
    let front = false;
    const ask = (i, z) => (front = z <= depth[i] * 1.0005 + 0.03);
    for (let g = 0; g < trisOut; g++) {
        if (seen[g]) continue;
        const how = project(g);
        if (how === 0) continue;
        if (how === 2) { seen[g] = 1; continue; }
        front = false;
        if (walk(ask) === 0 && slivers) {
            // A sliver: is any corner of it, on the picture, at the front there?
            for (let k = 0; k < 3 && !front; k++) {
                const x = Math.floor(S[k * 3]), y = Math.floor(S[k * 3 + 1]);
                if (x >= 0 && y >= 0 && x < W && y < H) front = S[k * 3 + 2] <= depth[y * W + x] * 1.0005 + 0.03;
            }
        }
        if (front) seen[g] = 1;
    }
}

if (!ALL) {
    const t2 = performance.now(), seen = new Uint8Array(trisOut);
    const count = () => seen.reduce((s, v) => s + v, 0);
    // Where the camera rests, everything that shows is kept, to the last
    // sliver. On its way between the two it is moving, for two seconds: there
    // a face has to cover a pixel to be worth keeping.
    for (const p of poses.filter(p => p.still)) { visible(p, STILL, seen); console.log(`  at rest: ${count().toLocaleString()}`); }
    for (const p of poses.filter(p => !p.still)) visible(p, MOVING, seen, false);
    console.log(`  with the way between: ${count().toLocaleString()}`);
    // Each bucket again, with what shows and only the vertices that still belongs to.
    let kept = 0;
    for (const b of buckets.values()) {
        const map = new Map(), n = { pos: [], nrm: [], uv: [], col: [], blend: [], idx: [] };
        // Faces that meet share their corners where the corners are the same in
        // every way — place, normal, texture, light — whichever chunk each came from.
        const same = (v) => `${b.pos[v * 3]},${b.pos[v * 3 + 1]},${b.pos[v * 3 + 2]},${b.nrm[v * 3]},${b.nrm[v * 3 + 1]},${b.nrm[v * 3 + 2]},` +
            `${b.uv[v * 2]},${b.uv[v * 2 + 1]},${b.col[v * 4]},${b.col[v * 4 + 1]},${b.col[v * 4 + 2]},${b.blend[v * 4]},${b.blend[v * 4 + 1]},${b.blend[v * 4 + 2]},${b.blend[v * 4 + 3]}`;
        for (let t = 0; t < b.tri.length; t++) {
            if (!seen[b.tri[t]]) continue;
            kept++;
            for (let k = 0; k < 3; k++) {
                const v = b.idx[t * 3 + k], key = same(v);
                let at = map.get(key);
                if (at === undefined) {
                    at = n.pos.length / 3;
                    map.set(key, at);
                    n.pos.push(b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]);
                    n.nrm.push(b.nrm[v * 3], b.nrm[v * 3 + 1], b.nrm[v * 3 + 2]);
                    n.uv.push(b.uv[v * 2], b.uv[v * 2 + 1]);
                    for (let c = 0; c < 4; c++) { n.col.push(b.col[v * 4 + c]); n.blend.push(b.blend[v * 4 + c]); }
                }
                n.idx.push(at);
            }
        }
        Object.assign(b, n);
    }
    console.log(`looked from ${poses.length} places in ${((performance.now() - t2) / 1000).toFixed(1)} s: ${kept.toLocaleString()} of ${trisOut.toLocaleString()} triangles can be seen`);
    trisOut = kept;
}

// ── glTF ─────────────────────────────────────────────────────────────────────
const bin = [];
let binLen = 0;
const gltf = {
    asset: { version: '2.0', generator: 'Wonder World tools/gen_menu_scene.mjs' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'MenuScene', mesh: 0, translation: ORIGIN }],
    meshes: [{ name: 'Terrain', primitives: [] }],
    materials: [], textures: [], images: [], accessors: [], bufferViews: [], buffers: [],
    // Blocks are drawn texel for texel up close, and smoothed far off; a texture repeats every block.
    samplers: [{ magFilter: 9728, minFilter: 9986, wrapS: 10497, wrapT: 10497 }],
    // Normals are bytes and texture coordinates shorts, as in the game's own meshes: 24 bytes a vertex, not 40.
    extensionsUsed: ['KHR_mesh_quantization', 'KHR_texture_transform'],
    extensionsRequired: ['KHR_mesh_quantization', 'KHR_texture_transform'],
};
function view(bytes, target, stride) {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
    gltf.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.byteLength, ...(stride ? { byteStride: stride } : {}), ...(target ? { target } : {}) });
    bin.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    binLen += bytes.byteLength;
    return gltf.bufferViews.length - 1;
}
/** `stride`: the bytes each element takes in the file, where that is more than its own (three bytes kept on a 4-byte step). */
function accessor(array, type, componentType, extra = {}) {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], step = extra.stride ? extra.stride / array.BYTES_PER_ELEMENT : n;
    gltf.accessors.push({ bufferView: view(array, extra.index ? 34963 : 34962, extra.stride), componentType, count: array.length / step, type, ...extra.more });
    return gltf.accessors.length - 1;
}
// A texture for each layer in use (and for each a blend names), in the order they are met.
const imageOf = new Map();
const image = (layer) => {
    if (imageOf.has(layer)) return imageOf.get(layer);
    const file = LAYERS[layer], i = gltf.images.length;
    const png = fs.readFileSync(path.join(root, file));
    gltf.images.push({ name: path.basename(file, '.png'), mimeType: 'image/png', bufferView: view(png) });
    gltf.textures.push({ sampler: 0, source: i });
    imageOf.set(layer, i);
    return i;
};

let verts = 0;
for (const b of [...buckets.values()].sort((p, q) => (p.water - q.water) || (p.layer - q.layer))) {
    if (b.idx.length === 0) continue;
    const textured = b.layer !== NO_LAYER, tex = textured ? image(b.layer) : -1;
    // The blend's layer is the game's; in the file it is the image's place.
    for (let i = 0; i < b.blend.length; i += 4) if (textured && b.blend[i + 1] !== 0) b.blend[i] = image(b.blend[i]);
    const name = textured ? gltf.images[tex].name : 'Plain';
    const leaves = textured && leafLayer(b.layer), cutout = textured && /leaves|glass/i.test(name);
    // A texture coordinate in the file is the game's: tiles × UV_SCALE, as a short. The material says so.
    const scaled = { index: tex, extensions: { KHR_texture_transform: { scale: [1 / UV_SCALE, 1 / UV_SCALE] } } };
    gltf.materials.push({
        name: b.water ? `${name} (clear)` : name,
        pbrMetallicRoughness: { ...(textured ? { baseColorTexture: scaled } : {}), baseColorFactor: [1, 1, 1, b.water ? 0.72 : 1], metallicFactor: 0, roughnessFactor: 1 },
        ...(b.water ? { alphaMode: 'BLEND' } : cutout ? { alphaMode: 'MASK', alphaCutoff: 0.5 } : {}),
        extras: { image: tex, leaves, water: b.water },
    });
    // A primitive holds at most 65,535 vertices, so its indices are shorts: a
    // texture with more (grass, stone) is several primitives of one material.
    const parts = [];
    let part = null;
    for (let t = 0; t < b.idx.length; t += 3) {
        let fresh = 0;
        for (let k = 0; k < 3; k++) if (!part?.map.has(b.idx[t + k])) fresh++;
        if (!part || part.pos.length / 3 + fresh > 65535) parts.push(part = { map: new Map(), pos: [], nrm: [], uv: [], col: [], blend: [], idx: [] });
        for (let k = 0; k < 3; k++) {
            const v = b.idx[t + k];
            let at = part.map.get(v);
            if (at === undefined) {
                at = part.pos.length / 3;
                part.map.set(v, at);
                part.pos.push(b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]);
                part.nrm.push(b.nrm[v * 3], b.nrm[v * 3 + 1], b.nrm[v * 3 + 2], 0);
                part.uv.push(b.uv[v * 2], b.uv[v * 2 + 1]);
                for (let c = 0; c < 4; c++) { part.col.push(b.col[v * 4 + c]); part.blend.push(b.blend[v * 4 + c]); }
            }
            part.idx.push(at);
        }
    }
    for (const p of parts) {
        const pos = new Float32Array(p.pos), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < min[k]) min[k] = pos[i]; if (pos[i] > max[k]) max[k] = pos[i]; }
        verts += pos.length / 3;
        gltf.meshes[0].primitives.push({
            attributes: {
                POSITION: accessor(pos, 'VEC3', 5126, { more: { min, max } }),
                NORMAL: accessor(new Int8Array(p.nrm), 'VEC3', 5120, { stride: 4, more: { normalized: true } }),
                TEXCOORD_0: accessor(new Uint16Array(p.uv), 'VEC2', 5123),
                // Only what has no texture has a colour of its own.
                ...(textured ? {} : { COLOR_0: accessor(new Uint8Array(p.col), 'VEC4', 5121, { more: { normalized: true } }) }),
                _BLEND: accessor(new Uint8Array(p.blend), 'VEC4', 5121, { more: { normalized: true } }),
            },
            indices: accessor(new Uint16Array(p.idx), 'SCALAR', 5123, { index: true }),
            material: gltf.materials.length - 1,
        });
    }
}

// What the menu needs to know about the place.
for (const s of spots) {
    const ys = s.pts.map(q => q.y).filter(y => y !== null);
    if (ys.length) { s.y = Math.max(...ys); s.uneven = s.y - Math.min(...ys); }
}
const spotY = (s) => +(s.y ?? columnTop(s.x, s.z)).toFixed(3);
const views = {};
for (const s of spots.filter(s => s.kind === 'view')) {
    const v = SCENE.views[s.name];
    views[s.name] = { at: [v.at[0], +(spotY(s) + SCENE.eye).toFixed(3), v.at[1]], yaw: v.yaw, pitch: v.pitch, fov: v.fov };
}
const fig = spots.find(s => s.kind === 'figure');
gltf.scenes[0].extras = { wonderWorld: {
    seed: SCENE.seed, hours: SCENE.hours, fog: SCENE.fog, views,
    figure: { at: [fig.x, spotY(fig), fig.z], faces: SCENE.figure.view },
    animals: spots.filter(s => s.kind === 'animal').map(s => ({ type: s.type, at: [+s.x.toFixed(2), spotY(s), +s.z.toFixed(2)] })),
    whole: ALL,
} };

const pad4 = (buf, fill) => { const p = (4 - (buf.length % 4)) % 4; return p ? Buffer.concat([buf, Buffer.alloc(p, fill)]) : buf; };
const binChunk = pad4(Buffer.concat(bin), 0);
gltf.buffers.push({ byteLength: binChunk.length });
const jsonChunk = pad4(Buffer.from(JSON.stringify(gltf)), 0x20);
const head = Buffer.alloc(12 + 8), binHead = Buffer.alloc(8);
head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
head.writeUInt32LE(jsonChunk.length, 12); head.writeUInt32LE(0x4E4F534A, 16);
binHead.writeUInt32LE(binChunk.length, 0); binHead.writeUInt32LE(0x004E4942, 4);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([head, jsonChunk, binHead, binChunk]));
console.log(`${OUT}\n  ${trisOut.toLocaleString()} triangles, ${verts.toLocaleString()} vertices, ${gltf.meshes[0].primitives.length} primitives, ` +
            `${gltf.images.length} textures, ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB`);
// Whoever is put in the scene should be seen whole from the view they were put in front of. On ground that
// falls away beyond a rise they are not: only their backs show over it, and they look sunk in the ground.
// Asked of the land as it is drawn: does the line from the view's eye to just over their feet meet a face?
const feetHidden = (s) => {
    const v = views[s.view];
    if (!v || s.y === null) return false;
    const ox = v.at[0], oy = v.at[1], oz = v.at[2], dx = s.x - ox, dy = s.y + 0.15 - oy, dz = s.z - oz;
    for (let g = 0; g < solid.length; g++) {
        if (!solid[g]) continue;
        const o = g * 9;
        const e1x = TP[o + 3] - TP[o], e1y = TP[o + 4] - TP[o + 1], e1z = TP[o + 5] - TP[o + 2];
        const e2x = TP[o + 6] - TP[o], e2y = TP[o + 7] - TP[o + 1], e2z = TP[o + 8] - TP[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;
        const tx = ox - TP[o], ty = oy - TP[o + 1], tz = oz - TP[o + 2];
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (dx * qx + dy * qy + dz * qz) / det;
        if (w < 0 || u + w > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (t > 0.01 && t < 0.97) return true;
    }
    return false;
};
for (const s of spots) {
    console.log(`  ${s.kind.padEnd(7)} ${(s.name ?? s.type ?? '').padEnd(8)} ${s.x.toFixed(1)}, ${s.y === null ? '(no ground found) ' + columnTop(s.x, s.z) : s.y.toFixed(2)}, ${s.z.toFixed(1)}` +
                (s.uneven > 0.25 ? `   on a slope: ${s.uneven.toFixed(2)} from one side of it to the other` : '') +
                (feetHidden(s) ? `   its feet are hidden from "${s.view}" (behind a rise in the ground, or something standing on it)` : ''));
}
