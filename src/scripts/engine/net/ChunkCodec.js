/**
 * A chunk, packed to go from the host's game to a guest's through the online
 * server (which passes it on unread, up to a size).
 *
 * It is the save format — `[palette length u16][palette u16…][one byte a voxel,
 * the whole column]` — gzipped: a column is mostly air and solid rock, so the
 * 115 KB of it comes down to a few. The guest's end is what
 * `ChunkData.deserialize` already takes.
 *
 * Unpacking never trusts the sender for a size: it stops reading at the most a
 * chunk can be, so a small message cannot be made to unpack into a huge one.
 *
 * No Three.js, no DOM (CompressionStream is in browsers and in Node).
 */
import { CHUNK_VOLUME, MAX_PALETTE } from '../ChunkData.js';

const MAX_RAW = 2 + MAX_PALETTE * 2 + CHUNK_VOLUME;

async function pipe(bytes, stream, limit) {
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(() => { /* the reader reports it */ });
    writer.close().catch(() => { /* likewise */ });
    const reader = stream.readable.getReader(), parts = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) { reader.cancel().catch(() => {}); throw new Error('too large'); }
        parts.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Pack a chunk. `chunk` is a ChunkData, or `{ palette, data }` as the save
 * server hands a saved one back (WorldClient.loadChunk).
 * @returns {Promise<Uint8Array>}
 */
export async function packChunk(chunk) {
    const palette = chunk._palette ?? chunk.palette;
    const raw = new Uint8Array(2 + palette.length * 2 + CHUNK_VOLUME);
    const dv = new DataView(raw.buffer);
    dv.setUint16(0, palette.length, true);
    for (let i = 0; i < palette.length; i++) dv.setUint16(2 + i * 2, palette[i], true);
    const at = 2 + palette.length * 2;
    if (typeof chunk.writeIndices === 'function') chunk.writeIndices(raw, at);
    else raw.set(chunk.data.subarray(0, CHUNK_VOLUME), at);
    return pipe(raw, new CompressionStream('gzip'), MAX_RAW);
}

/**
 * Unpack what packChunk made.
 * @returns {Promise<{ palette: number[], data: Uint8Array } | null>} null if it is not a chunk
 */
export async function unpackChunk(bytes) {
    let raw;
    try { raw = await pipe(bytes, new DecompressionStream('gzip'), MAX_RAW); } catch { return null; }
    if (raw.length < 2) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = dv.getUint16(0, true);
    if (n === 0 || n > MAX_PALETTE || raw.length !== 2 + n * 2 + CHUNK_VOLUME) return null;
    const palette = [];
    for (let i = 0; i < n; i++) palette.push(dv.getUint16(2 + i * 2, true));
    const data = raw.subarray(2 + n * 2);
    // A voxel naming a palette slot there is not would read as `undefined`: not a chunk.
    for (let i = 0; i < data.length; i++) if (data[i] >= n) return null;
    return { palette, data };
}

/** The blocks changed in a chunk the host has not loaded or saved: `Map<voxelIndex, blockId>` → six bytes each. */
export function packEdits(changes) {
    const out = new Uint8Array(changes.size * 6), dv = new DataView(out.buffer);
    let o = 0;
    for (const [idx, id] of changes) { dv.setUint32(o, idx, true); dv.setUint16(o + 4, id, true); o += 6; }
    return out;
}

/** @returns {[number, number][]} `[voxelIndex, blockId]`, the ones that are inside a chunk */
export function unpackEdits(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
    for (let o = 0; o + 6 <= bytes.length; o += 6) {
        const idx = dv.getUint32(o, true);
        if (idx < CHUNK_VOLUME) out.push([idx, dv.getUint16(o + 4, true)]);
    }
    return out;
}
