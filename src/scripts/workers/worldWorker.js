/**
 * worldWorker.js  —  Worker entry point
 *
 * Each worker in the pool handles two message types:
 *
 *   init { seed, blockRegistry, biomes }
 *     → Initialises the TerrainGenerator, StructurePlacer, and GreedyMesher.
 *     → Responds with { type: 'ready' }.
 *
 *   generateChunk { taskId, cx, cz }
 *     → Generates terrain for a full 16×640×16 column, places structures,
 *       returns voxel data.
 *     → Responds with { type: 'chunkGenerated', taskId, cx, cz, voxels }
 *        (voxels.buffer is transferred, not copied).
 *
 *   meshChunk { taskId, cx, cz, chunk, neighbors, partial }
 *     → Runs greedy meshing on the supplied voxel data.
 *     → chunk / each neighbour arrives palette-compressed as
 *       { palette: Uint16Array, indices: Uint8Array, minY, maxY } and is expanded
 *       here rather than on the main thread — half the bytes over the wire and
 *       the expansion loop runs off the render thread.
 *     → neighbors: plain object { "dx,dz": snapshot } — four horizontal keys only
 *     → partial=false (full split): runs ±Y and ±XZ faces separately.
 *        Responds with { type: 'chunkMeshed', taskId, cx, cz, yGeo, xzGeo }
 *     → partial=true (XZ-only): runs only ±X and ±Z faces — used when a horizontal
 *        neighbour loads and only border faces need updating.
 *        Responds with { type: 'chunkMeshed', taskId, cx, cz, xzGeo }
 *        (all geometry typed-array buffers are transferred in both cases).
 */

import { setSeed }           from './noise.js';
import { BlockRegistry }     from '../engine/BlockRegistry.js';
import { TerrainGenerator }  from './TerrainGenerator.js';
import { StructurePlacer }   from './StructurePlacer.js';
import { GreedyMesher }      from './GreedyMesher.js';
import { CHUNK_VOLUME }      from '../engine/ChunkData.js';

let generator = null;
let placer    = null;
let mesher    = null;

// ── Message handler ──────────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const { type, ...data } = e.data;

    try {
        switch (type) {
            case 'init':          handleInit(data);     break;
            case 'generateChunk': handleGenerate(data); break;
            case 'meshChunk':     handleMesh(data);     break;
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

function handleInit({ seed, blockRegistry: serialisedReg, biomes, blockFaceMap }) {
    const reg = BlockRegistry.deserialize(serialisedReg);

    setSeed(seed);

    generator = new TerrainGenerator(seed, reg, biomes);
    placer    = new StructurePlacer(seed, reg, generator.biomes, generator);
    mesher    = new GreedyMesher(reg, blockFaceMap ?? {});

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

    self.postMessage(
        { type: 'chunkGenerated', taskId, cx, cz, voxels },
        [voxels.buffer],
    );
}

// Face index groups:
//   Y_FACES  = [2,3]       — ±Y (top/bottom): permanent, never affected by neighbour loads
//   XZ_FACES = [0,1,4,5]   — ±X and ±Z (sides): rebuilt when a horizontal neighbour changes
const Y_FACES  = [2, 3];
const XZ_FACES = [0, 1, 4, 5];

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
};

/** Expand a { palette, indices } snapshot into `out`. */
function _expand(snapshot, out) {
    const pal = snapshot.palette;
    const idx = snapshot.indices;
    for (let i = 0; i < CHUNK_VOLUME; i++) out[i] = pal[idx[i]];
    return out;
}

function handleMesh({ taskId, cx, cz, chunk, neighbors, partial }) {
    if (!mesher) {
        console.error('[worldWorker] meshChunk called before init');
        return;
    }

    const voxelView = _expand(chunk, _selfVoxels);
    const neighbourViews = {};
    if (neighbors) {
        for (const key of Object.keys(neighbors)) {
            const snap = neighbors[key];
            const buf  = _nbrVoxels[key];
            if (snap && buf) neighbourViews[key] = _expand(snap, buf);
        }
    }

    // Only sweep the band that actually contains blocks. Above the highest solid
    // voxel every mask cell would be empty, and a 448-tall column is mostly sky.
    const yRange = { min: chunk.minY | 0, max: chunk.maxY | 0 };

    if (partial) {
        // High-priority dirty re-mesh: only rebuild side faces that border neighbours.
        // ±Y faces are unchanged by neighbour loads — skip them entirely.
        const xzGeo = mesher.meshGroup(voxelView, neighbourViews, XZ_FACES, yRange);
        self.postMessage(
            { type: 'chunkMeshed', taskId, cx, cz, xzGeo },
            _geoTransferList(xzGeo),
        );
    } else {
        // Full split mesh: produce ±Y (permanent) and ±XZ (updatable) separately so
        // the render layer can replace just the XZ group on subsequent neighbour loads.
        const yGeo  = mesher.meshGroup(voxelView, neighbourViews, Y_FACES,  yRange);
        const xzGeo = mesher.meshGroup(voxelView, neighbourViews, XZ_FACES, yRange);
        self.postMessage(
            { type: 'chunkMeshed', taskId, cx, cz, yGeo, xzGeo },
            [..._geoTransferList(yGeo), ..._geoTransferList(xzGeo)],
        );
    }
}
