/**
 * Blocklight — light from torches, lanterns and lamps around one chunk (0..15).
 *
 * The same rules as sky light's spread (Skylight.js): a block that gives off
 * light (BlockRegistry `light`) holds its level in its own cell, and light
 * spreads to the six neighbouring cells through anything not opaque, one level
 * less per block. A lamp is opaque but still shines out of its cell.
 *
 * It reaches at most 14 blocks, so like sky light it is solved over the chunk
 * plus a SKY_MAX-block margin read from all eight neighbours — exactly enough
 * for neighbouring chunks to agree on every cell they share — and written in
 * the same layout: the chunk plus a one-block border, level × 17, opaque cells
 * holding their brightest open neighbour (or, shut in, what the opaque cell
 * over them holds — see Skylight.js).
 *
 * Unlike sky light it is almost always absent: natural terrain has no light
 * sources. worldWorker checks the nine chunks' palettes first (paletteHasLight),
 * and the solve returns null when nothing lights the chunk. When something
 * does, the region and the output cover only the levels the light can reach —
 * a torch lights a slice about thirty blocks tall, not the whole column:
 *   { data: Uint8Array(18 × h × 18), y0, h }   index x + y·18 + z·18·h
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y } from '../engine/ChunkData.js';
import { SKY_MAX } from '../engine/Sun.js';

const S      = CHUNK_SIZE;
const N_Y    = CHUNK_SIZE_Y;
const SZ     = S * N_Y;                // voxel index stride in z
const MARGIN = SKY_MAX;                // light reaches this far (see Skylight.js)
const R      = S + 2 * MARGIN;         // region width in x and z
const RR     = R * R;                  // region stride in y
const OUT    = S + 2;                  // output width in x and z

// Region columns belonging to each chunk along an axis (0 = the -1 neighbour).
const RANGE = [[0, MARGIN - 1], [MARGIN, MARGIN + S - 1], [MARGIN + S, R - 1]];
// Region column → which chunk along the axis (0..2) and local coordinate there.
const CHUNK_OF = new Int8Array(R), LOCAL = new Int8Array(R);
for (let i = 0; i < R; i++) {
    const w = i - MARGIN, c = Math.floor(w / S);
    CHUNK_OF[i] = c + 1;
    LOCAL[i] = w - c * S;
}

// Scratch, grown to the tallest band seen (a worker runs one job at a time).
let _opq = new Uint8Array(0), _light = new Uint8Array(0), _queue = new Int32Array(0);
let _seeds = new Int32Array(256);

function fit(cells) {
    if (_opq.length >= cells) return;
    _opq = new Uint8Array(cells); _light = new Uint8Array(cells); _queue = new Int32Array(cells);
}

/** Whether a chunk palette holds anything that gives off light. */
export function paletteHasLight(palette, light) {
    if (!palette) return false;
    for (let i = 0; i < palette.length; i++) if (light[palette[i]] > 0) return true;
    return false;
}

/**
 * @param {(Uint16Array|null)[]} views  3×3 chunk voxels, index (dx+1) + (dz+1)·3; null = not loaded (opaque)
 * @param {number[]} minY, maxY         filled local-Y band of each view (same order)
 * @param {Uint8Array} opaque           opaque-block lookup by id
 * @param {Uint8Array} light            light given off, by id (0..15)
 * @param {boolean[]} [scan]            which views may hold light sources (their
 *                                      palettes say so); default all of them
 * @returns {{ data: Uint8Array, y0: number, h: number } | null}
 */
export function computeBlocklight(views, minY, maxY, opaque, light, scan = null) {
    const self = 4;

    // ── Light sources within reach ───────────────────────────────────────────
    let nSeeds = 0, eyLo = N_Y, eyHi = -1;
    for (let k = 0; k < 9; k++) {
        const view = views[k];
        if (!view || (scan && !scan[k])) continue;
        const [x0, x1] = RANGE[k % 3], [z0, z1] = RANGE[(k / 3) | 0];
        const lx0 = LOCAL[x0];
        for (let z = z0; z <= z1; z++) {
            const lz = LOCAL[z];
            for (let y = minY[k]; y <= maxY[k]; y++) {
                const row = y * S + lz * SZ - x0 + lx0;   // + x → local x of region column x
                for (let x = x0; x <= x1; x++) {
                    const lvl = light[view[row + x]];
                    if (lvl === 0) continue;
                    if (nSeeds * 3 + 3 > _seeds.length) {
                        const next = new Int32Array(_seeds.length * 2);
                        next.set(_seeds); _seeds = next;
                    }
                    _seeds[nSeeds * 3] = x + z * R; _seeds[nSeeds * 3 + 1] = y; _seeds[nSeeds * 3 + 2] = lvl;
                    nSeeds++;
                    if (y < eyLo) eyLo = y;
                    if (y > eyHi) eyHi = y;
                }
            }
        }
    }
    if (nSeeds === 0) return null;

    // ── The slice light can reach, and the part of it this chunk shows ───────
    // Levels ≤ 15 fall to 0 within 15 blocks; one more level either side lets an
    // opaque cell at the edge find its brightest neighbour.
    const bLo = Math.max(0, eyLo - SKY_MAX), bHi = Math.min(N_Y - 1, eyHi + SKY_MAX);
    const oy0 = Math.max(bLo, Math.max(0, minY[self] - 1));
    const oy1 = Math.min(bHi, Math.min(N_Y - 1, maxY[self] + 2));
    if (oy1 < oy0) return null;
    const bandH = bHi - bLo + 1;
    fit(RR * bandH);
    const opq = _opq, lt = _light, queue = _queue;

    // ── Opacity over the slice ───────────────────────────────────────────────
    for (let z = 0; z < R; z++) {
        const cz = CHUNK_OF[z], lz = LOCAL[z];
        for (let x = 0; x < R; x++) {
            const view = views[CHUNK_OF[x] + cz * 3];
            const col = x + z * R;
            if (!view) {
                for (let y = 0; y < bandH; y++) { opq[col + y * RR] = 1; lt[col + y * RR] = 0; }
                continue;
            }
            const base = LOCAL[x] + lz * SZ;
            for (let y = 0; y < bandH; y++) {
                const i = col + y * RR;
                opq[i] = opaque[view[base + (y + bLo) * S]];
                lt[i] = 0;
            }
        }
    }

    // ── Seeds, then spread: breadth first, one level per block ───────────────
    let head = 0, tail = 0;
    const cap = queue.length;
    for (let s = 0; s < nSeeds; s++) {
        const i = _seeds[s * 3] + (_seeds[s * 3 + 1] - bLo) * RR, lvl = _seeds[s * 3 + 2];
        if (lt[i] >= lvl) continue;
        lt[i] = lvl;
        queue[tail] = i; tail = tail + 1 === cap ? 0 : tail + 1;
    }
    while (head !== tail) {
        const i = queue[head]; head = head + 1 === cap ? 0 : head + 1;
        const next = lt[i] - 1;
        if (next <= 0) continue;
        const col = i % RR, y = (i - col) / RR;
        const x = col % R, z = (col - x) / R;
        for (let d = 0; d < 6; d++) {
            let j;
            switch (d) {
                case 0: if (x + 1 >= R)      continue; j = i + 1;  break;
                case 1: if (x === 0)         continue; j = i - 1;  break;
                case 2: if (z + 1 >= R)      continue; j = i + R;  break;
                case 3: if (z === 0)         continue; j = i - R;  break;
                case 4: if (y + 1 >= bandH)  continue; j = i + RR; break;
                default: if (y === 0)        continue; j = i - RR; break;
            }
            if (opq[j] || lt[j] >= next) continue;
            lt[j] = next;
            queue[tail] = j; tail = tail + 1 === cap ? 0 : tail + 1;
        }
    }

    // ── Output: chunk + 1-block border, over the reachable slice ─────────────
    const h = oy1 - oy0 + 1;
    const out = new Uint8Array(OUT * h * OUT);
    const scale = 255 / SKY_MAX;
    // What the opaque cell i holds: its brightest open neighbour, so
    // interpolating across a surface never pulls it toward black. A light
    // source's own cell counts even when opaque: a lamp lights its own faces'
    // edges.
    const held = (i, x, by, z) => {
        let v = lt[i];
        if (x + 1 < R && !opq[i + 1] && lt[i + 1] > v) v = lt[i + 1];
        if (x > 0     && !opq[i - 1] && lt[i - 1] > v) v = lt[i - 1];
        if (z + 1 < R && !opq[i + R] && lt[i + R] > v) v = lt[i + R];
        if (z > 0     && !opq[i - R] && lt[i - R] > v) v = lt[i - R];
        if (by + 1 < bandH && !opq[i + RR] && lt[i + RR] > v) v = lt[i + RR];
        if (by > 0         && !opq[i - RR] && lt[i - RR] > v) v = lt[i - RR];
        return v;
    };
    for (let oz = 0; oz < OUT; oz++) {
        const z = oz + MARGIN - 1;
        for (let ox = 0; ox < OUT; ox++) {
            const x = ox + MARGIN - 1;
            const col = x + z * R;
            for (let y = oy0; y <= oy1; y++) {
                const by = y - bLo, i = col + by * RR;
                let v;
                if (!opq[i]) v = lt[i];
                else {
                    v = held(i, x, by, z);
                    // Shut in: what the cell over it holds (leaning ground).
                    if (v === 0 && by + 1 < bandH && opq[i + RR]) {
                        v = held(i + RR, x, by + 1, z);
                        if (v === 0 && by + 2 < bandH && opq[i + 2 * RR]) v = held(i + 2 * RR, x, by + 2, z);
                    }
                }
                out[ox + (y - oy0) * OUT + oz * OUT * h] = Math.round(v * scale);
            }
        }
    }
    return { data: out, y0: oy0, h };
}
