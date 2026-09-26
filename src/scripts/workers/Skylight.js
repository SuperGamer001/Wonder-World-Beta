/**
 * Skylight — how much sky light reaches each cell of a chunk (0..15).
 *
 * Minecraft-style rules:
 *   1. Straight down from the sky, light stays at 15 until the first opaque
 *      block. Transparent blocks (water, leaves, glass, ice) let it through.
 *   2. From there it spreads to the six neighbouring cells, losing one level
 *      per block, through anything that is not opaque.
 * So open ground and overhangs are lit, a cave mouth fades into the dark over
 * a dozen blocks, and a sealed cave is level 0.
 *
 * Light reaches SKY_MAX blocks, so a chunk's light depends on its neighbours out
 * to that distance — including the diagonal chunks. The solve runs on a region
 * of the chunk plus MARGIN blocks on each side (read from the eight surrounding
 * chunks), which is exactly enough for every cell the shader samples to come out
 * the same as its neighbour chunk computes it, so there are no seams.
 *
 * Output is the chunk plus a one-block border (the shader interpolates between
 * cells), over the chunk's filled Y band plus a little headroom:
 *   { data: Uint8Array(18 × h × 18), y0, h }   index x + y·18 + z·18·h
 * `data` holds level × 17 (0..255) so it uploads directly as a normalised R8
 * texture. Opaque cells hold the brightest neighbouring air cell instead of 0,
 * so interpolating across a surface never pulls it toward black; that also
 * gives smooth-terrain slopes, which cut through opaque cells, the light of the
 * air above them.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y } from '../engine/ChunkData.js';
import { SKY_MAX } from '../engine/Sun.js';

const S      = CHUNK_SIZE;
const N_Y    = CHUNK_SIZE_Y;
const SZ     = S * N_Y;                // voxel index stride in z
const MARGIN = SKY_MAX;                // light reaches this far; see header
const R      = S + 2 * MARGIN;         // region width in x and z
const RR     = R * R;                  // region stride in y (y-major layout)
const OUT    = S + 2;                  // output width in x and z

// Scratch, reused across jobs (a worker runs one job at a time).
const _opq   = new Uint8Array(RR * N_Y);
const _light = new Uint8Array(RR * N_Y);
const _queue = new Int32Array(RR * N_Y);
const _top   = new Int32Array(RR);     // per column: y of the highest opaque cell, or -1

// Region column → which chunk (0..2 along the axis) and local coordinate.
const _chunkOf = new Int8Array(R);
const _localOf = new Int8Array(R);
for (let i = 0; i < R; i++) {
    const w = i - MARGIN;              // coordinate relative to this chunk's origin
    const c = Math.floor(w / S);       // -1, 0, 1
    _chunkOf[i] = c + 1;
    _localOf[i] = w - c * S;
}

/**
 * @param {(Uint16Array|null)[]} views  3×3 chunk voxels, index (dx+1) + (dz+1)·3;
 *                                      null = not loaded (treated as opaque)
 * @param {number[]} minY, maxY         filled local-Y band of each view (same order)
 * @param {Uint8Array} opaque           opaque-block lookup by id
 */
export function computeSkylight(views, minY, maxY, opaque) {
    const self = 4;
    // Vertical extent. Above the highest block in any of the nine chunks every
    // cell is open sky; below, keep SKY_MAX of room for light that dips under
    // and comes back up into the output band.
    let top = -1;
    for (let k = 0; k < 9; k++) if (views[k] && maxY[k] > top) top = maxY[k];
    top = Math.min(N_Y - 1, top + 1);
    const oy0 = Math.max(0, minY[self] - 1);
    const oy1 = Math.min(N_Y - 1, maxY[self] + 2);
    const y0  = Math.max(0, oy0 - MARGIN);
    const y1  = Math.max(top, y0);

    const opq = _opq, light = _light, queue = _queue, colTop = _top;

    // ── Straight-down pass: open sky above each column's first opaque block ──
    // Stops at that block, so only the sky part of each column is read here.
    let minTop = y1;
    for (let z = 0; z < R; z++) {
        const cz = _chunkOf[z], lz = _localOf[z];
        for (let x = 0; x < R; x++) {
            const view = views[_chunkOf[x] + cz * 3];
            const col  = x + z * R;
            let highest = y1;                         // a missing chunk is opaque throughout
            if (view) {
                const base = _localOf[x] + lz * SZ;
                highest = -1;
                for (let y = y1; y >= y0; y--) {
                    const i = col + y * RR;
                    const o = opaque[view[base + y * S]];
                    opq[i] = o;
                    if (o) { light[i] = 0; highest = y; break; }
                    light[i] = SKY_MAX;
                }
            }
            colTop[col] = highest;
            if (highest < minTop) minTop = highest;
        }
    }

    // ── The floor: nothing below it can be lit ───────────────────────────────
    // Below its column top a cell is lit only by the spread, which starts from
    // seeds at level SKY_MAX − 1 lying above some column top — so above minTop —
    // and loses a level per block. Every cell below minTop − (SKY_MAX − 2) stays
    // at 0, and so does its output. The region is therefore only filled, spread
    // through and output down to yLo; below that, `out` keeps its zeros. With
    // the bedrock floor at local y 0, that skips most of every column.
    const yLo = Math.max(y0, minTop - SKY_MAX - 1);

    // ── Opacity below each column top, down to the floor ─────────────────────
    for (let z = 0; z < R; z++) {
        const cz = _chunkOf[z], lz = _localOf[z];
        for (let x = 0; x < R; x++) {
            const view = views[_chunkOf[x] + cz * 3];
            const col  = x + z * R;
            if (!view) {
                for (let y = yLo; y <= y1; y++) { const i = col + y * RR; opq[i] = 1; light[i] = 0; }
                continue;
            }
            const base = _localOf[x] + lz * SZ;
            for (let y = colTop[col] - 1; y >= yLo; y--) {
                const i = col + y * RR;
                opq[i]   = opaque[view[base + y * S]];
                light[i] = 0;
            }
        }
    }

    // ── Seeds: sky beside a taller column shines sideways into it ────────────
    let head = 0, tail = 0;
    const seed = SKY_MAX - 1;
    for (let z = 0; z < R; z++) {
        for (let x = 0; x < R; x++) {
            const hc = colTop[x + z * R];
            for (let d = 0; d < 4; d++) {
                const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
                const nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
                if (nx < 0 || nx >= R || nz < 0 || nz >= R) continue;
                const ncol = nx + nz * R;
                const hn = colTop[ncol];
                // Cells of the neighbour column below its top, level with this
                // column's open sky.
                for (let y = Math.max(hc + 1, yLo); y < hn; y++) {
                    const i = ncol + y * RR;
                    if (opq[i] || light[i] >= seed) continue;
                    light[i] = seed;
                    queue[tail++] = i;
                }
            }
        }
    }

    // ── Spread: breadth first, one level per block ───────────────────────────
    const cap = queue.length;
    while (head !== tail) {
        const i = queue[head]; head = head + 1 === cap ? 0 : head + 1;
        const next = light[i] - 1;
        if (next <= 0) continue;
        const col = i % RR, y = (i - col) / RR;
        const x = col % R, z = (col - x) / R;
        for (let d = 0; d < 6; d++) {
            let j;
            switch (d) {
                case 0: if (x + 1 >= R)  continue; j = i + 1;  break;
                case 1: if (x === 0)     continue; j = i - 1;  break;
                case 2: if (z + 1 >= R)  continue; j = i + R;  break;
                case 3: if (z === 0)     continue; j = i - R;  break;
                case 4: if (y + 1 > y1)  continue; j = i + RR; break;
                default: if (y - 1 < yLo) continue; j = i - RR; break;
            }
            if (opq[j] || light[j] >= next) continue;
            light[j] = next;
            queue[tail] = j; tail = tail + 1 === cap ? 0 : tail + 1;
        }
    }

    // ── Output: chunk + 1-block border ────────────────────────────────────────
    const h = oy1 - oy0 + 1;
    const out = new Uint8Array(OUT * h * OUT);
    const scale = 255 / SKY_MAX;
    for (let oz = 0; oz < OUT; oz++) {
        const z = oz + MARGIN - 1;
        for (let ox = 0; ox < OUT; ox++) {
            const x = ox + MARGIN - 1;
            const col = x + z * R;
            for (let y = Math.max(oy0, yLo); y <= oy1; y++) {   // below yLo: 0, as allocated
                let v;
                if (y > y1) v = SKY_MAX;
                else {
                    const i = col + y * RR;
                    if (!opq[i]) v = light[i];
                    else {
                        // Brightest open neighbour (see header).
                        v = 0;
                        if (x + 1 < R && !opq[i + 1] && light[i + 1] > v) v = light[i + 1];
                        if (x > 0     && !opq[i - 1] && light[i - 1] > v) v = light[i - 1];
                        if (z + 1 < R && !opq[i + R] && light[i + R] > v) v = light[i + R];
                        if (z > 0     && !opq[i - R] && light[i - R] > v) v = light[i - R];
                        if (y + 1 > y1) v = SKY_MAX;
                        else if (!opq[i + RR] && light[i + RR] > v) v = light[i + RR];
                        if (y > yLo && !opq[i - RR] && light[i - RR] > v) v = light[i - RR];
                    }
                }
                out[ox + (y - oy0) * OUT + oz * OUT * h] = Math.round(v * scale);
            }
        }
    }
    return { data: out, y0: oy0, h };
}
