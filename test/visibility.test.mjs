// engine/Visibility.js: leaving out of the draw the sections of chunks the
// camera cannot see must never leave out one it can.
//
//   • sectionConnectivity on hand-made sections: which faces open space joins.
//   • The mesher's section order on real terrain, blocky and smooth: every
//     triangle is in the range of the section it was given, and that section
//     is where it is.
//   • SectionVisibility against lines of sight: from cameras above the land,
//     high over it and down in its caves, thousands of rays are followed cell
//     by cell through real generated terrain, and whatever each one ends on
//     must be in the range its chunk would draw. Then how much is left out,
//     which is the point of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlockRegistry }    from '../src/scripts/engine/BlockRegistry.js';
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME } from '../src/scripts/engine/ChunkData.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { GreedyMesher }     from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }     from '../src/scripts/workers/SmoothMesher.js';
import { SMOOTH_REACH }     from '../src/scripts/engine/SmoothShape.js';
import {
    SECTIONS, SECTION_SHIFT, SECTION_SIZE, ALL_FACES, sectionConnectivity, connectivityOfRows, sectionOf, SectionVisibility,
} from '../src/scripts/engine/Visibility.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

const reg = new BlockRegistry();
const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));
for (const b of readDir('data/blocks')) reg.register(b);
const faceMap = {};
for (const b of reg.serialize()) faceMap[b.id] = { top: b.id, side: b.id, bottom: b.id };
const mesher = new GreedyMesher(reg, faceMap);
const smoother = new SmoothMesher(reg, mesher);
const STONE = reg.getByName('STONE').id;
const SY = CHUNK_SIZE, SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;      // a bit for each face, in GreedyMesher's order

// ── 1. Which faces open space joins ─────────────────────────────────────────
console.log('--- connectivity of a section ---');
{
    // The lowest section of a chunk, stone wherever `solid(x, y, z)`.
    const conn = (solid) => {
        const v = new Uint16Array(CHUNK_VOLUME);
        for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            if (solid(x, y, z)) v[x + y * SY + z * SZ] = STONE;
        }
        return [...sectionConnectivity(v, 0, 15, mesher._solid).subarray(0, 6)];
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const show = (a) => `[${a.join(' ')}]`;

    let c = conn(() => true);
    check('solid rock joins nothing', same(c, [0, 0, 0, 0, 0, 0]), show(c));
    c = conn(() => false);
    check('air joins everything', same(c, [63, 63, 63, 63, 63, 63]), show(c));
    c = conn((x, y, z) => !(y >= 7 && y <= 8 && z >= 7 && z <= 8));
    check('a tunnel along x joins its two ends, and only them', same(c, [PX | NX, PX | NX, 0, 0, 0, 0]), show(c));
    c = conn((x, y, z) => !((y === 7 && z === 7 && x <= 7) || (y === 7 && x === 7 && z >= 7)));
    check('a tunnel that turns joins the faces it runs between', same(c, [0, NX | PZ, 0, 0, NX | PZ, 0]), show(c));
    c = conn((x, y) => y === 8);
    const above = PX | NX | PY | PZ | NZ, below = PX | NX | NY | PZ | NZ;
    check('a floor right across parts what is above from what is below',
        c[2] === above && c[3] === below && (c[2] & NY) === 0 && (c[3] & PY) === 0, show(c));
    check('… and a side both touch is joined to both', c[0] === (above | below), show(c));
    c = conn((x, y, z) => !(x > 3 && x < 12 && y > 3 && y < 12 && z > 3 && z < 12));
    check('a sealed pocket joins nothing', same(c, [0, 0, 0, 0, 0, 0]), show(c));
    c = conn((x, y, z) => x === 15 && !(y === 3 && z === 3));
    check('a hole in a wall joins the faces either side of it', (c[0] & NX) !== 0 && (c[1] & PX) !== 0, show(c));

    const v = new Uint16Array(CHUNK_VOLUME).fill(0);
    for (let i = 0; i < 16 * 16; i++) v[(i & 15) + 40 * SY + (i >> 4) * SZ] = STONE;
    const all = sectionConnectivity(v, 40, 40, mesher._solid);
    check('sections outside the filled band are air',
        all[0] === ALL_FACES && all[(SECTIONS - 1) * 6 + 3] === ALL_FACES && all[2 * 6 + 2] !== ALL_FACES);

    // In a smooth world a voxel cut to a shape is open, however much is left of it.
    const sm = new Uint16Array(CHUNK_VOLUME).fill(STONE, 0, 16 * SZ);
    for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sm[x + y * SY + z * SZ] = STONE;
    const partial = new Uint8Array(CHUNK_VOLUME);
    for (let x = 0; x < 16; x++) partial[x + 5 * SY + 5 * SZ] = 1;
    const c2 = sectionConnectivity(sm, 0, 15, mesher._solid, partial);
    check('a row of shaped voxels lets sight through', c2[0] === (PX | NX) && c2[1] === (PX | NX) && c2[2] === 0);
}

/**
 * The same answer the slow way, for checking: flood every open region of
 * every section cell by cell, and join the faces each one touches.
 */
function floodConnectivity(v, yMin, yMax, closed, partial) {
    const out = new Uint8Array(SECTIONS * 6);
    const open = new Uint8Array(4096), stack = new Int32Array(4096);
    for (let s = 0; s < SECTIONS; s++) {
        if (s < (yMin >> SECTION_SHIFT) || s > (yMax >> SECTION_SHIFT)) { out.fill(ALL_FACES, s * 6, s * 6 + 6); continue; }
        for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            const i = x + (s * 16 + y) * SY + z * SZ;
            open[x | (y << 4) | (z << 8)] = closed[v[i]] !== 1 || (partial !== null && partial[i] === 1) ? 1 : 0;
        }
        for (let start = 0; start < 4096; start++) {
            if (open[start] !== 1) continue;
            let n = 0, mask = 0;
            stack[n++] = start; open[start] = 2;
            while (n > 0) {
                const k = stack[--n], x = k & 15, y = (k >> 4) & 15, z = k >> 8;
                const go = (d) => { if (open[k + d] === 1) { open[k + d] = 2; stack[n++] = k + d; } };
                if (x === 15) mask |= PX; else go(1);
                if (x === 0)  mask |= NX; else go(-1);
                if (y === 15) mask |= PY; else go(16);
                if (y === 0)  mask |= NY; else go(-16);
                if (z === 15) mask |= PZ; else go(256);
                if (z === 0)  mask |= NZ; else go(-256);
            }
            for (let f = 0; f < 6; f++) if ((mask >> f) & 1) out[s * 6 + f] |= mask;
        }
    }
    return out;
}

// A chunk of noise — every kind of ragged region — must come out the same both ways.
{
    const rand = (() => { let s = 12345; return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296; })();
    let differ = 0;
    for (const fill of [0.2, 0.45, 0.6, 0.8]) {
        const v = new Uint16Array(CHUNK_VOLUME);
        for (let z = 0; z < 16; z++) for (let y = 0; y < 96; y++) for (let x = 0; x < 16; x++) {
            if (rand() < fill) v[x + y * SY + z * SZ] = STONE;
        }
        const a = sectionConnectivity(v, 0, 95, mesher._solid), b = floodConnectivity(v, 0, 95, mesher._solid, null);
        if (!a.every((x, i) => x === b[i])) differ++;
    }
    check('noise: joined faces match a cell-by-cell flood', differ === 0, `${differ} of 4 differ`);
}

// ── Real terrain ─────────────────────────────────────────────────────────────
const SEED = 2024, R = 3;
const gen = new TerrainGenerator(SEED, reg, readDir('data/biomes'), readDir('data/terrain'));
const key = (cx, cz) => `${cx},${cz}`;
const voxels = new Map(), data = new Map();
for (let cz = -R - 1; cz <= R + 1; cz++) for (let cx = -R - 1; cx <= R + 1; cx++) {
    const v = gen.generate(cx, cz);
    voxels.set(key(cx, cz), v);
    const cd = new ChunkData(cx, cz);
    cd.loadVoxels(v);
    data.set(key(cx, cz), cd);
}

/** Mesh every chunk within R of the origin as the worker does; smooth or blocky. */
let rowsDiffer = 0, floodDiffer = 0;
function meshAll(smooth) {
    const out = new Map();
    rowsDiffer = floodDiffer = 0;
    const far = CHUNK_SIZE - SMOOTH_REACH;
    for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
        const v = voxels.get(key(cx, cz)), cd = data.get(key(cx, cz));
        const nb = {}, corners = {};
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) nb[key(dx, dz)] = voxels.get(key(cx + dx, cz + dz));
        for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            corners[key(dx, dz)] = data.get(key(cx + dx, cz + dz)).cornerBlock(dx > 0 ? 0 : far, dz > 0 ? 0 : far, SMOOTH_REACH);
        }
        const yRange = { min: cd.minFilledY, max: cd.maxFilledY };
        const ctx = smooth ? smoother.prepare(v, nb, corners, yRange) : null;
        const geo = mesher.meshGroup(v, nb, [0, 1, 2, 3, 4, 5], yRange, ctx);
        const closed = smooth ? ctx.occ : mesher._solid;
        const partial = smooth ? ctx.partial.slice() : null;
        const conn = sectionConnectivity(v, yRange.min, yRange.max, closed, partial).slice();
        // … and the mesher's own row words say the same (what the worker uses),
        // and so does flooding it cell by cell.
        const fromRows = connectivityOfRows(mesher.closedRows(), yRange.min, yRange.max);
        const flooded = floodConnectivity(v, yRange.min, yRange.max, closed, partial);
        if (!conn.every((x, i) => x === fromRows[i])) rowsDiffer++;
        if (!conn.every((x, i) => x === flooded[i])) floodDiffer++;
        let secLo = SECTIONS, secHi = -1;
        for (let s = 0; s < SECTIONS; s++) {
            if (geo.sections[s + 1] > geo.sections[s]) { if (s < secLo) secLo = s; secHi = s; }
        }
        out.set(key(cx, cz), { cx, cz, v, geo, conn, closed, partial, secLo, secHi, drawLo: 0, drawHi: SECTIONS - 1 });
    }
    return out;
}

// ── 2. The mesher's section order ───────────────────────────────────────────
function checkOrder(label, chunks, below) {
    let bad = 0, unsorted = 0, tris = 0, quadsAcross = 0;
    const worst = [];
    for (const c of chunks.values()) {
        const { positions, indices, sections } = c.geo;
        if (sections[0] !== 0 || sections[SECTIONS] !== indices.length) unsorted++;
        for (let s = 0; s < SECTIONS; s++) {
            if (sections[s + 1] < sections[s] || sections[s] % 3 !== 0) unsorted++;
            const lo = s * SECTION_SIZE - below, hi = (s + 1) * SECTION_SIZE;
            for (let i = sections[s]; i < sections[s + 1]; i += 3) {
                tris++;
                let y0 = Infinity, y1 = -Infinity;
                for (let k = 0; k < 3; k++) {
                    const y = positions[indices[i + k] * 3 + 1];
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                }
                if (y0 < lo - 1e-6 || y1 > hi + 1e-6) { bad++; if (worst.length < 4) worst.push(`section ${s}: y ${y0.toFixed(3)} … ${y1.toFixed(3)}`); }
                if (y1 - y0 > SECTION_SIZE + 1e-6) quadsAcross++;
            }
        }
    }
    check(`${label}: the sections' ranges are in order and cover the indices`, unsorted === 0, `${unsorted} wrong`);
    check(`${label}: every triangle lies in the section it was given`, bad === 0, `${bad} of ${tris} outside${worst.length ? ': ' + worst.join('; ') : ''}`);
    check(`${label}: no face spans two sections`, quadsAcross === 0, `${quadsAcross}`);
}

// ── 3. Against lines of sight ───────────────────────────────────────────────
const vis = new SectionVisibility();
const inner = (cx, cz) => Math.abs(cx) <= R && Math.abs(cz) <= R;

/** A deterministic stream of numbers in [0, 1). */
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Follow `rays` lines of sight from (ex, ey, ez) — world x, z and local y —
 * cell by cell. Returns how many end on something outside what its chunk draws.
 */
function castRays(chunks, ex, ey, ez, rays, seed) {
    const rand = rng(seed);
    let missed = 0, hits = 0;
    const cellOf = (x, y, z) => {
        const cx = x >> 4, cz = z >> 4;
        if (y < 0 || y >= CHUNK_SIZE_Y || !inner(cx, cz)) return null;
        const c = chunks.get(key(cx, cz));
        return { c, i: (x & 15) + y * SY + (z & 15) * SZ };
    };
    const isOpen = (cell) => cell.c.closed[cell.c.v[cell.i]] !== 1 || (cell.c.partial !== null && cell.c.partial[cell.i] === 1);
    const drawn = (c, y) => { const s = y >> SECTION_SHIFT; return s >= c.drawLo && s <= c.drawHi; };

    for (let r = 0; r < rays; r++) {
        // A direction, evenly over the sphere.
        const u = rand() * 2 - 1, a = rand() * Math.PI * 2, h = Math.sqrt(1 - u * u);
        const dx = h * Math.cos(a), dy = u, dz = h * Math.sin(a);
        let x = Math.floor(ex), y = Math.floor(ey), z = Math.floor(ez);
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
        let tx = (dx > 0 ? x + 1 - ex : ex - x) * tdx, ty = (dy > 0 ? y + 1 - ey : ey - y) * tdy, tz = (dz > 0 ? z + 1 - ez : ez - z) * tdz;
        let py = y;                                 // the level of the open cell the ray was last in
        for (let step = 0; step < 600; step++) {
            if (tx <= ty && tx <= tz) { x += sx; tx += tdx; }
            else if (ty <= tz)        { y += sy; ty += tdy; }
            else                      { z += sz; tz += tdz; }
            const cell = cellOf(x, y, z);
            if (cell === null) break;                // out of the land that was meshed
            if (isOpen(cell)) {
                // A shaped voxel has its own surface in its cell.
                if (cell.c.partial !== null && cell.c.partial[cell.i] === 1) {
                    hits++;
                    if (!drawn(cell.c, y)) missed++;
                }
                py = y;
                continue;
            }
            // A full cube: its face is seen from the cell before it. In a smooth
            // world the surface of a voxel over it may dip into it, too (by a
            // block and a half at most, so from one of the two above).
            hits++;
            let ok = drawn(cell.c, py);
            if (ok && cell.c.partial !== null) {
                for (let k = 1; k <= 2 && y + k < CHUNK_SIZE_Y; k++) {
                    if (cell.c.partial[cell.i + k * SY] === 1) { ok = drawn(cell.c, y + k); break; }
                }
            }
            if (!ok) missed++;
            break;
        }
    }
    return { missed, hits };
}

/** The share of the chunks' triangles that their draw ranges take in. */
function drawnShare(chunks) {
    let all = 0, drawn = 0;
    for (const c of chunks.values()) {
        const s = c.geo.sections;
        all += s[SECTIONS];
        if (c.drawHi >= c.drawLo) drawn += s[c.drawHi + 1] - s[c.drawLo];
    }
    return drawn / all;
}

function checkVisibility(label, chunks) {
    const centre = chunks.get(key(0, 0));
    const solid = (x, y, z) => centre.closed[centre.v[x + y * SY + z * SZ]] === 1;
    let top = CHUNK_SIZE_Y - 1;
    while (top > 0 && !solid(8, top, 8)) top--;

    // Cameras: just over the ground, high above it, and in the open cells
    // found under it — caves — at different depths.
    const cams = [
        { name: 'on the ground', x: 8.5, y: top + 2.6, z: 8.5 },
        { name: 'high above',    x: 8.5, y: top + 70.3, z: 8.5 },
    ];
    const open = (c, x, y, z) => c.closed[c.v[x + y * SY + z * SZ]] !== 1;
    for (const [cx, cz] of [[0, 0], [1, -1], [-2, 1], [2, 2], [-1, -2]]) {
        const c = chunks.get(key(cx, cz));
        let found = 0;
        for (let y = top - 12; y > 8 && found < 2; y -= 3) {
            search:
            for (let z = 2; z < 14; z++) for (let x = 2; x < 14; x++) {
                if (open(c, x, y, z) && open(c, x, y + 1, z) && !open(c, x, y - 1, z)) {
                    cams.push({ name: `in a cave at level ${y}`, x: cx * 16 + x + 0.5, y: y + 0.6, z: cz * 16 + z + 0.5 });
                    found++; y -= 30;
                    break search;
                }
            }
        }
    }

    let surfaceShare = 1, worst = 0, caves = 0;
    cams.forEach((cam, n) => {
        vis.compute(chunks.values(), Math.floor(cam.x) >> 4, Math.floor(cam.z) >> 4, sectionOf(cam.y));
        const { missed, hits } = castRays(chunks, cam.x, cam.y, cam.z, 30000, 1000 + n);
        const share = drawnShare(chunks);
        if (n === 0) surfaceShare = share;
        if (n >= 2) caves++;
        worst = Math.max(worst, missed);
        check(`${label}, ${cam.name}: nothing a line of sight ends on is left out`, missed === 0,
            `${missed} of ${hits} missed; ${(share * 100).toFixed(0)}% of the triangles drawn`);
    });
    check(`${label}: cameras were found in caves`, caves >= 2, `${caves}`);
    check(`${label}: from the ground, a good part of the triangles is left out`, surfaceShare < 0.8,
        `${(surfaceShare * 100).toFixed(0)}% drawn`);

    // Chunks that have not said what joins what are drawn whole.
    const blind = [...chunks.values()].map(c => ({ ...c, conn: null }));
    vis.compute(blind, 0, 0, sectionOf(top + 3));
    check(`${label}: chunks with no connectivity are drawn whole`,
        blind.every(c => c.secHi < c.secLo || (c.drawLo === c.secLo && c.drawHi === c.secHi)));
}

for (const smooth of [false, true]) {
    const label = smooth ? 'smooth' : 'blocky';
    console.log(`--- ${label} terrain ---`);
    const chunks = meshAll(smooth);
    check(`${label}: joined faces match a cell-by-cell flood`, floodDiffer === 0, `${floodDiffer} of ${chunks.size} chunks differ`);
    check(`${label}: … and what the mesher's row words give`, rowsDiffer === 0, `${rowsDiffer} of ${chunks.size} chunks differ`);
    // A smooth surface may dip under its own voxel: a block on a diagonal
    // slope, and half a block more where that meets a diagonal step.
    checkOrder(label, chunks, smooth ? 1.5 : 0);
    checkVisibility(label, chunks);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
