// ChunkData stores only the rows of a column that hold blocks. Everything it
// answers — single voxels, snapshots for the workers, corner columns, the
// whole-column save format — must still be exactly the column, whatever was
// loaded and wherever it was edited. Checked against a plain Uint16Array.
import {
    ChunkData, compressVoxels, voxelIndex,
    CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME,
} from '../src/scripts/engine/ChunkData.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

let seed = 12345;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };

/** A column: bedrock-like floor (so slot 0 is not AIR), ground to `top`, something on it. */
function column(bottom, top) {
    const v = new Uint16Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = top - ((lx * 3 + lz * 5) % 7);
        for (let ly = bottom; ly <= h; ly++) v[voxelIndex(lx, ly, lz)] = ly === bottom ? 19 : ly === h ? 1 : 3;
        if ((lx + lz) % 5 === 0) v[voxelIndex(lx, h + 3, lz)] = 7;   // a floating leaf
    }
    return v;
}

/** Expand a snapshot (the worker's _expand, written plainly). */
function expand(s) {
    const out = new Uint16Array(CHUNK_VOLUME);
    const band = (s.maxY - s.minY + 1) * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let k = 0; k < band; k++) {
        out[lz * CHUNK_SIZE * CHUNK_SIZE_Y + s.minY * CHUNK_SIZE + k] = s.palette[s.indices[lz * band + k]];
    }
    return out;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Everything a chunk answers, against the reference column. */
function agrees(c, ref) {
    if (!same(c.toUint16Array(), ref)) return 'toUint16Array';
    if (!same(expand(c.snapshot()), ref)) return 'snapshot';
    for (let n = 0; n < 4000; n++) {
        const lx = rnd(16), ly = rnd(CHUNK_SIZE_Y), lz = rnd(16);
        if (c.getVoxel(lx, ly, lz) !== ref[voxelIndex(lx, ly, lz)]) return `getVoxel ${lx},${ly},${lz}`;
    }
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        let top = -1;
        for (let ly = CHUNK_SIZE_Y - 1; ly >= 0; ly--) if (ref[voxelIndex(lx, ly, lz)]) { top = ly; break; }
        if (c.columnTop(lx, lz) !== top) return `columnTop ${lx},${lz}: ${c.columnTop(lx, lz)} vs ${top}`;
    }
    const corner = c.cornerBlock(14, 0, 2);
    for (let bz = 0; bz < 2; bz++) for (let bx = 0; bx < 2; bx++) for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) {
        if (corner[(bx + bz * 2) * CHUNK_SIZE_Y + ly] !== ref[voxelIndex(14 + bx, ly, bz)]) return 'cornerBlock';
    }
    // The save format: the whole column's palette slots.
    const { palette, data } = c.serialize();
    if (data.length !== CHUNK_VOLUME) return 'serialize length';
    for (let i = 0; i < CHUNK_VOLUME; i++) if (palette[data[i]] !== ref[i]) return `serialize at ${i}`;
    const written = new Uint8Array(CHUNK_VOLUME + 7).fill(200);
    c.writeIndices(written, 7);
    for (let i = 0; i < CHUNK_VOLUME; i++) if (c._palette[written[7 + i]] !== ref[i]) return `writeIndices at ${i}`;
    for (let i = 0; i < 7; i++) if (written[i] !== 200) return 'writeIndices wrote before its offset';
    // … and back.
    const back = ChunkData.deserialize(c.cx, c.cz, { palette, data });
    if (!same(back.toUint16Array(), ref)) return 'deserialize';
    return null;
}

// ── A generated chunk ────────────────────────────────────────────────────────
{
    const ref = column(0, 200);
    const c = new ChunkData(2, -3);
    c.loadVoxels(ref);
    const rows = c.maxFilledY - c.minFilledY + 1;
    check('a loaded chunk stores only its filled rows',
        c.minFilledY === 0 && c.maxFilledY === 203 && c.byteLength === rows * 256, `${c.byteLength} bytes for rows ${c.minFilledY}..${c.maxFilledY}`);
    check('… and answers as the whole column', agrees(c, ref) === null, agrees(c, ref) ?? '');
    check('the palette does not start with AIR here (the fill outside the rows must not assume it)', c._palette[0] !== 0);

    // Edits inside, above and below the stored rows, and air set where it is air.
    const edit = (lx, ly, lz, id) => { ref[voxelIndex(lx, ly, lz)] = id; return c.setVoxel(lx, ly, lz, id); };
    edit(3, 100, 3, 0); edit(3, 100, 4, 44);
    edit(5, 260, 5, 3);                       // far above: grows the storage
    edit(5, 300, 5, 0);                       // air into air above everything
    edit(6, 447, 6, 4);                       // the top row of the world
    for (let n = 0; n < 300; n++) edit(rnd(16), rnd(CHUNK_SIZE_Y), rnd(16), [0, 1, 3, 7, 44][rnd(5)]);
    check('edits anywhere in the column are kept', agrees(c, ref) === null, agrees(c, ref) ?? '');
    check('the filled band covers every block placed', (() => {
        for (let i = 0; i < CHUNK_VOLUME; i++) {
            if (!ref[i]) continue;
            const ly = ((i / CHUNK_SIZE) | 0) % CHUNK_SIZE_Y;
            if (ly < c.minFilledY || ly > c.maxFilledY) return false;
        }
        return true;
    })());
}

// ── A chunk whose blocks start well above the bottom ─────────────────────────
{
    const ref = column(120, 180);
    const c = new ChunkData(0, 0);
    c.loadVoxels(ref);
    check('rows below the first block are not stored either', c.minFilledY === 120 && c.byteLength === (c.maxFilledY - 119) * 256);
    ref[voxelIndex(8, 2, 8)] = 3; c.setVoxel(8, 2, 8, 3);            // far below
    check('a block placed below the stored rows', agrees(c, ref) === null && c.minFilledY === 2, agrees(c, ref) ?? '');
}

// ── Built by hand, and empty ─────────────────────────────────────────────────
{
    const ref = new Uint16Array(CHUNK_VOLUME);
    const c = new ChunkData(1, 1);
    check('a new chunk is all air and holds nothing', c.byteLength === 0 && agrees(c, ref) === null, agrees(c, ref) ?? '');
    for (let n = 0; n < 400; n++) {
        const lx = rnd(16), ly = 90 + rnd(40), lz = rnd(16), id = [0, 3, 5][rnd(3)];
        ref[voxelIndex(lx, ly, lz)] = id; c.setVoxel(lx, ly, lz, id);
    }
    check('a chunk built block by block', agrees(c, ref) === null, agrees(c, ref) ?? '');
    c._recomputeFilledY();
    let lo = CHUNK_SIZE_Y, hi = -1;
    for (let i = 0; i < CHUNK_VOLUME; i++) if (ref[i]) { const ly = ((i / 16) | 0) % CHUNK_SIZE_Y; lo = Math.min(lo, ly); hi = Math.max(hi, ly); }
    check('_recomputeFilledY finds the real extent', c.minFilledY === lo && c.maxFilledY === hi && agrees(c, ref) === null);

    const e = new ChunkData(0, 0);
    e.loadVoxels(new Uint16Array(CHUNK_VOLUME));
    check('an empty generated chunk', e.minFilledY === 0 && e.maxFilledY === 0 && agrees(e, new Uint16Array(CHUNK_VOLUME)) === null);

    const full = new Uint16Array(CHUNK_VOLUME).fill(3);
    const f = new ChunkData(0, 0);
    f.loadVoxels(full);
    check('a column with no air at all', f.byteLength === CHUNK_VOLUME && agrees(f, full) === null);
}

// ── adoptCompressed takes the band, or a whole column ────────────────────────
{
    const ref = column(0, 150);
    const packed = compressVoxels(ref);
    const a = new ChunkData(0, 0);
    a.adoptCompressed(packed.palette, packed.indices, packed.minY, packed.maxY);
    const whole = new Uint8Array(CHUNK_VOLUME);
    a.writeIndices(whole);
    const b = new ChunkData(0, 0);
    b.adoptCompressed(Array.from(packed.palette), whole, packed.minY, packed.maxY);
    check('adoptCompressed: band-packed and whole-column indices give the same chunk',
        agrees(a, ref) === null && agrees(b, ref) === null && same(a._indices, b._indices));
    check('compressVoxels sends only the filled rows',
        packed.indices.length === (packed.maxY - packed.minY + 1) * 256, `${packed.indices.length} bytes`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
