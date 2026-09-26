/**
 * worldWorker.js  —  Worker entry point
 *
 * Each worker in the pool handles two message types:
 *
 *   init { seed, blockRegistry, biomes, blockFaceMap, terrainStyle }
 *     → Initialises the TerrainGenerator, StructurePlacer, and GreedyMesher.
 *     → terrainStyle 'smooth' also creates a SmoothMesher; anything else meshes
 *       exactly as a blocky world always has.
 *     → Responds with { type: 'ready' }.
 *
 *   generateChunk { taskId, cx, cz }
 *     → Generates terrain for a full 16×448×16 column, places structures,
 *       and palette-compresses it (ChunkData.compressVoxels) so the main
 *       thread only has to adopt the arrays.
 *     → Responds with { type: 'chunkGenerated', taskId, cx, cz,
 *                        palette: Uint16Array, indices: Uint8Array, minY, maxY }
 *        (both buffers are transferred, not copied).
 *
 *   meshChunk { taskId, cx, cz, chunk, neighbors, diagonals, corners? }
 *     → Runs greedy meshing on the supplied voxel data, all six face
 *       directions into one geometry group.
 *     → chunk / each neighbour arrives palette-compressed as
 *       { palette: Uint16Array, indices: Uint8Array, minY, maxY } and is expanded
 *       here rather than on the main thread — half the bytes over the wire and
 *       the expansion loop runs off the render thread.
 *     → neighbors: plain object { "dx,dz": snapshot } — four horizontal keys only
 *     → corners (smooth worlds only): { "±1,±1": Uint16Array } — the
 *       SMOOTH_REACH × SMOOTH_REACH columns of each diagonal chunk nearest this
 *       chunk's corner (ChunkData.cornerBlock layout)
 *     → diagonals: { "±1,±1": snapshot } — the four diagonal chunks, used only
 *       for sky light, which reaches SKY_MAX blocks into every neighbour
 *     → Responds with { type: 'chunkMeshed', taskId, cx, cz, geo, light }
 *       with `light` from Skylight.js; every buffer is transferred.
 *
 *   lightChunk { taskId, cx, cz, chunk, neighbors, diagonals }
 *     → Sky light only, for a chunk whose geometry is current but whose light
 *       changed (an edit or a load up to SKY_MAX blocks away in a neighbour).
 *       Responds with { type: 'chunkLit', taskId, cx, cz, light }
 */

import { setSeed }           from './noise.js';
import { BlockRegistry }     from '../engine/BlockRegistry.js';
import { TerrainGenerator }  from './TerrainGenerator.js';
import { StructurePlacer }   from './StructurePlacer.js';
import { GreedyMesher }      from './GreedyMesher.js';
import { SmoothMesher }      from './SmoothMesher.js';
import { CHUNK_VOLUME, CHUNK_SIZE, CHUNK_SIZE_Y, compressVoxels } from '../engine/ChunkData.js';
import { computeSkylight }   from './Skylight.js';

let generator = null;
let placer    = null;
let mesher    = null;
let smoother  = null;   // SmoothMesher — only in smooth-terrain worlds

// ── Message handler ──────────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const { type, ...data } = e.data;

    try {
        switch (type) {
            case 'init':          handleInit(data);     break;
            case 'generateChunk': handleGenerate(data); break;
            case 'meshChunk':     handleMesh(data);     break;
            case 'lightChunk':    handleLight(data);    break;
            default:
                console.warn('[worldWorker] unknown message type:', type);
        }
    } catch (err) {
        // Report the failure instead of letting it escape as an uncaught worker
        // error. An uncaught throw leaves the pool believing this worker is
        // still busy, so the slot and the chunk are both lost permanently.
        console.error(`[worldWorker] ${type} failed:`, err);
        self.postMessage({
            type: 'error',
            taskId: data.taskId,
            message: `${type}: ${err?.message ?? err}`,
        });
    }
};

function handleInit({ seed, blockRegistry: serialisedReg, biomes, blockFaceMap, terrainStyle }) {
    const reg = BlockRegistry.deserialize(serialisedReg);

    setSeed(seed);

    generator = new TerrainGenerator(seed, reg, biomes);
    placer    = new StructurePlacer(seed, reg, generator.biomes, generator);
    mesher    = new GreedyMesher(reg, blockFaceMap ?? {});
    smoother  = terrainStyle === 'smooth' ? new SmoothMesher(reg, mesher) : null;

    self.postMessage({ type: 'ready' });
}

function handleGenerate({ taskId, cx, cz }) {
    if (!generator) {
        console.error('[worldWorker] generateChunk called before init');
        return;
    }

    // ── 1. Terrain + ores ────────────────────────────────────────────────────
    const voxels = generator.generateChunk(cx, cz);

    // ── 2. Structures ────────────────────────────────────────────────────────
    const { heights, blends } = generator.buildColumnData(cx, cz);
    placer.apply(voxels, cx, cz, heights, blends);

    // ── 3. Compress here, so the main thread only adopts the result ─────────
    const { palette, indices, minY, maxY } = compressVoxels(voxels, cx, cz);
    self.postMessage(
        { type: 'chunkGenerated', taskId, cx, cz, palette, indices, minY, maxY },
        [palette.buffer, indices.buffer],
    );
}

// Every chunk is meshed whole, all six face directions into one group, so it
// draws as one opaque and one transparent mesh.
const ALL_FACES = [0, 1, 2, 3, 4, 5];

// No `normals` entry: the chunk shaders bake directional brightness into vertex
// colour and never read a normal, so the mesher does not produce one.
function _geoTransferList(geo) {
    const list = [
        geo.positions.buffer, geo.colors.buffer, geo.indices.buffer,
        geo.uvs.buffer, geo.layers.buffer,
    ];
    if (geo.transparentPositions.length > 0) {
        list.push(
            geo.transparentPositions.buffer, geo.transparentColors.buffer,
            geo.transparentIndices.buffer, geo.transparentUVs.buffer,
            geo.transparentLayers.buffer,
        );
    }
    return list;
}

// Scratch buffers reused across mesh jobs on this worker. A worker handles one
// job at a time, so a single self buffer plus four neighbour buffers is enough,
// and reusing them keeps a 16×448×16 chunk mesh from allocating ~1 MB of
// short-lived Uint16Array per job.
const _selfVoxels = new Uint16Array(CHUNK_VOLUME);
const _nbrVoxels  = {
    '1,0':  new Uint16Array(CHUNK_VOLUME),
    '-1,0': new Uint16Array(CHUNK_VOLUME),
    '0,1':  new Uint16Array(CHUNK_VOLUME),
    '0,-1': new Uint16Array(CHUNK_VOLUME),
    '1,1':   new Uint16Array(CHUNK_VOLUME),
    '1,-1':  new Uint16Array(CHUNK_VOLUME),
    '-1,1':  new Uint16Array(CHUNK_VOLUME),
    '-1,-1': new Uint16Array(CHUNK_VOLUME),
};

// Local-Y band each scratch buffer currently holds non-zero data in, so the
// next expansion only has to clear what falls outside its own band. Starts
// as the whole column, since nothing is known about a fresh buffer — it is
// actually all zero, so the first clear is merely redundant.
const _held = new Map();
for (const buf of [_selfVoxels, ...Object.values(_nbrVoxels)]) _held.set(buf, { lo: 0, hi: CHUNK_SIZE_Y - 1 });

/**
 * Expand a { palette, indices, minY, maxY } snapshot into `out`.
 *
 * The snapshot holds only the chunk's filled band [minY, maxY], packed one
 * block per z slice (ChunkData.snapshot); ChunkData guarantees every voxel
 * outside it is AIR. Outside the band `out` must therefore read as AIR (0),
 * so whatever the previous job left there is cleared.
 */
function _expand(snapshot, out) {
    const pal  = snapshot.palette;
    const idx  = snapshot.indices;
    const lo   = snapshot.minY | 0;
    const hi   = snapshot.maxY | 0;
    const band = (hi - lo + 1) * CHUNK_SIZE;
    const held = _held.get(out);
    const SZ   = CHUNK_SIZE * CHUNK_SIZE_Y;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const slab = lz * SZ;
        // Clear the old band's rows that the new band does not overwrite.
        if (held.lo < lo) out.fill(0, slab + held.lo * CHUNK_SIZE, slab + Math.min(held.hi + 1, lo) * CHUNK_SIZE);
        if (held.hi > hi) out.fill(0, slab + Math.max(held.lo, hi + 1) * CHUNK_SIZE, slab + (held.hi + 1) * CHUNK_SIZE);
        const dst = slab + lo * CHUNK_SIZE;
        const src = lz * band;
        for (let k = 0; k < band; k++) out[dst + k] = pal[idx[src + k]];
    }
    held.lo = lo;
    held.hi = hi;
    return out;
}

// The 3×3 block of chunks around (and including) the one being lit, in the
// order computeSkylight wants: index (dx+1) + (dz+1)·3.
const _lightViews = new Array(9).fill(null);
const _lightMinY  = new Array(9).fill(0);
const _lightMaxY  = new Array(9).fill(0);

function _light(voxelView, chunk, neighbors, diagonals, neighbourViews) {
    for (let k = 0; k < 9; k++) _lightViews[k] = null;
    const put = (key, view, snap) => {
        const [dx, dz] = key.split(',').map(Number);
        const k = (dx + 1) + (dz + 1) * 3;
        _lightViews[k] = view;
        _lightMinY[k]  = snap.minY | 0;
        _lightMaxY[k]  = snap.maxY | 0;
    };
    put('0,0', voxelView, chunk);
    for (const key of Object.keys(neighbourViews)) put(key, neighbourViews[key], neighbors[key]);
    for (const key of Object.keys(diagonals ?? {})) {
        const snap = diagonals[key], buf = _nbrVoxels[key];
        if (snap && buf) put(key, _expand(snap, buf), snap);
    }
    return computeSkylight(_lightViews, _lightMinY, _lightMaxY, mesher._solid);
}

function _expandNeighbours(neighbors) {
    const neighbourViews = {};
    if (neighbors) {
        for (const key of Object.keys(neighbors)) {
            const snap = neighbors[key];
            const buf  = _nbrVoxels[key];
            if (snap && buf) neighbourViews[key] = _expand(snap, buf);
        }
    }
    return neighbourViews;
}

function handleLight({ taskId, cx, cz, chunk, neighbors, diagonals }) {
    if (!mesher) {
        console.error('[worldWorker] lightChunk called before init');
        return;
    }
    const voxelView = _expand(chunk, _selfVoxels);
    const light = _light(voxelView, chunk, neighbors, diagonals, _expandNeighbours(neighbors));
    self.postMessage({ type: 'chunkLit', taskId, cx, cz, light }, [light.data.buffer]);
}

function handleMesh({ taskId, cx, cz, chunk, neighbors, diagonals, corners }) {
    if (!mesher) {
        console.error('[worldWorker] meshChunk called before init');
        return;
    }

    const voxelView = _expand(chunk, _selfVoxels);
    const neighbourViews = _expandNeighbours(neighbors);

    // Only sweep the band that actually contains blocks. Above the highest solid
    // voxel every mask cell would be empty, and a 448-tall column is mostly sky.
    const yRange = { min: chunk.minY | 0, max: chunk.maxY | 0 };

    // Smooth worlds: classify Mesh voxels first. Deformed ones are drawn by the
    // smooth pass instead of the greedy one.
    const smoothCtx = smoother ? smoother.prepare(voxelView, neighbourViews, corners, yRange) : null;

    const geo   = mesher.meshGroup(voxelView, neighbourViews, ALL_FACES, yRange, smoothCtx);
    const light = _light(voxelView, chunk, neighbors, diagonals, neighbourViews);
    self.postMessage(
        { type: 'chunkMeshed', taskId, cx, cz, geo, light },
        [..._geoTransferList(geo), light.data.buffer],
    );
}
