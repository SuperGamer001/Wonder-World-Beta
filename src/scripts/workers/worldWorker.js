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
 *   meshChunk { taskId, cx, cz, voxels, neighbors, partial }
 *     → Runs greedy meshing on the supplied voxel data.
 *     → neighbors: plain object { "dx,dz": Uint16Array } — four horizontal keys only
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
import { CHUNK_SIZE }        from '../engine/ChunkData.js';

let generator = null;
let placer    = null;
let mesher    = null;

// ── Message handler ──────────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const { type, ...data } = e.data;

    switch (type) {
        case 'init':          handleInit(data);     break;
        case 'generateChunk': handleGenerate(data); break;
        case 'meshChunk':     handleMesh(data);     break;
        default:
            console.warn('[worldWorker] unknown message type:', type);
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

function _geoTransferList(geo) {
    const list = [
        geo.positions.buffer, geo.normals.buffer, geo.colors.buffer, geo.indices.buffer,
        geo.uvs.buffer, geo.layers.buffer,
    ];
    if (geo.transparentPositions.length > 0) {
        list.push(
            geo.transparentPositions.buffer, geo.transparentNormals.buffer,
            geo.transparentColors.buffer, geo.transparentIndices.buffer,
            geo.transparentUVs.buffer, geo.transparentLayers.buffer,
        );
    }
    return list;
}

function handleMesh({ taskId, cx, cz, voxels, neighbors, partial }) {
    if (!mesher) {
        console.error('[worldWorker] meshChunk called before init');
        return;
    }

    const voxelView = new Uint16Array(voxels);
    const neighbourViews = {};
    if (neighbors) {
        for (const [key, buf] of Object.entries(neighbors)) {
            if (buf) neighbourViews[key] = new Uint16Array(buf);
        }
    }

    if (partial) {
        // High-priority dirty re-mesh: only rebuild side faces that border neighbours.
        // ±Y faces are unchanged by neighbour loads — skip them entirely.
        const xzGeo = mesher.meshGroup(voxelView, neighbourViews, XZ_FACES);
        self.postMessage(
            { type: 'chunkMeshed', taskId, cx, cz, xzGeo },
            _geoTransferList(xzGeo),
        );
    } else {
        // Full split mesh: produce ±Y (permanent) and ±XZ (updatable) separately so
        // the render layer can replace just the XZ group on subsequent neighbour loads.
        const yGeo  = mesher.meshGroup(voxelView, neighbourViews, Y_FACES);
        const xzGeo = mesher.meshGroup(voxelView, neighbourViews, XZ_FACES);
        self.postMessage(
            { type: 'chunkMeshed', taskId, cx, cz, yGeo, xzGeo },
            [..._geoTransferList(yGeo), ..._geoTransferList(xzGeo)],
        );
    }
}
