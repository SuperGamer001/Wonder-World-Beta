/**
 * worldWorker.js  —  Worker entry point
 *
 * Each worker in the pool handles two message types:
 *
 *   init { seed, blockRegistry, biomes }
 *     → Initialises the TerrainGenerator, StructurePlacer, and GreedyMesher.
 *     → Responds with { type: 'ready' }.
 *
 *   generateChunk { taskId, cx, cy, cz }
 *     → Generates terrain, places structures, returns voxel data.
 *     → Responds with { type: 'chunkGenerated', taskId, cx, cy, cz, voxels }
 *        (voxels.buffer is transferred, not copied).
 *
 *   meshChunk { taskId, cx, cy, cz, voxels, neighbors }
 *     → Runs greedy meshing on the supplied voxel data.
 *     → neighbors: plain object { "dx,dy,dz": Uint16Array }
 *     → Responds with { type: 'chunkMeshed', taskId, cx, cy, cz, geometry }
 *        (all geometry typed-array buffers are transferred).
 *
 * Note: voxels received for meshChunk are NOT transferred back — the main
 * thread keeps its copy in WorldState.
 */

import { setSeed }           from './noise.js';
import { BlockRegistry }     from '../engine/BlockRegistry.js';
import { TerrainGenerator }  from './TerrainGenerator.js';
import { StructurePlacer }   from './StructurePlacer.js';
import { GreedyMesher }      from './GreedyMesher.js';
import { CHUNK_SIZE }        from '../engine/ChunkData.js';

const N = CHUNK_SIZE;

let generator = null;
let placer    = null;
let mesher    = null;

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const { type, ...data } = e.data;

    switch (type) {
        case 'init':       handleInit(data);        break;
        case 'generateChunk': handleGenerate(data); break;
        case 'meshChunk':  handleMesh(data);        break;
        default:
            console.warn('[worldWorker] unknown message type:', type);
    }
};

function handleInit({ seed, blockRegistry: serialisedReg, biomes }) {
    const reg = BlockRegistry.deserialize(serialisedReg);

    setSeed(seed);

    generator = new TerrainGenerator(seed, reg, biomes);
    placer    = new StructurePlacer(seed, reg, generator.biomes);
    mesher    = new GreedyMesher(reg);

    self.postMessage({ type: 'ready' });
}

function handleGenerate({ taskId, cx, cy, cz }) {
    if (!generator) {
        console.error('[worldWorker] generateChunk called before init');
        return;
    }

    // ── 1. Terrain + ores ────────────────────────────────────────────────────
    const voxels = generator.generateChunk(cx, cy, cz);

    // ── 2. Structures ────────────────────────────────────────────────────────
    // Re-derive the column-level heights and blends that TerrainGenerator used.
    // StructurePlacer needs them to find surface level.
    const { heights, blends } = _buildColumnData(cx, cy, cz);
    placer.apply(voxels, cx, cy, cz, heights, blends);

    // Transfer the buffer so the main thread takes ownership without a copy.
    self.postMessage(
        { type: 'chunkGenerated', taskId, cx, cy, cz, voxels },
        [voxels.buffer],
    );
}

function handleMesh({ taskId, cx, cy, cz, voxels, neighbors }) {
    if (!mesher) {
        console.error('[worldWorker] meshChunk called before init');
        return;
    }

    // Reconstruct Uint16Array views over the incoming buffers.
    // The main thread sends copies (not transfers) so they retain their data.
    const voxelView = new Uint16Array(voxels);
    const neighbourViews = {};
    if (neighbors) {
        for (const [key, buf] of Object.entries(neighbors)) {
            if (buf) neighbourViews[key] = new Uint16Array(buf);
        }
    }

    const geo = mesher.mesh(voxelView, neighbourViews);

    // Collect all geometry buffers to transfer
    const transferList = [
        geo.positions.buffer,
        geo.normals.buffer,
        geo.colors.buffer,
        geo.indices.buffer,
    ];
    if (geo.transparentPositions.length > 0) {
        transferList.push(
            geo.transparentPositions.buffer,
            geo.transparentNormals.buffer,
            geo.transparentColors.buffer,
            geo.transparentIndices.buffer,
        );
    }

    self.postMessage(
        { type: 'chunkMeshed', taskId, cx, cy, cz, geometry: geo },
        transferList,
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct per-column height and biome-blend arrays for a chunk.
 * Must mirror the TerrainGenerator logic exactly so structures land on terrain.
 */
function _buildColumnData(cx, cy, cz) {
    // Forward to the generator which already has all the noise functions
    return generator.buildColumnData(cx, cy, cz);
}
