/**
 * worldWorker.js  —  Worker entry point
 *
 * Each worker in the pool handles two message types:
 *
 *   init { seed, blockRegistry, biomes, blockFaceMap, terrainStyle, terrain, worldGen, farPalette, flat }
 *     → Initialises the generator and the GreedyMesher. worldGen ≥ 2 builds
 *       TerrainGenerator (with the world settings in `terrain`); older worlds
 *       get LegacyWorldGen, the generator they were made with.
 *     → terrainStyle 'smooth' also creates a SmoothMesher; anything else meshes
 *       exactly as a blocky world always has.
 *     → Responds with { type: 'ready' }.
 *
 *   generateChunk { taskId, cx, cz }
 *     → Generates a full 16×448×16 column (terrain, caves, ores, structures)
 *       and palette-compresses it (ChunkData.compressVoxels) so the main
 *       thread only has to adopt the arrays.
 *     → Responds with { type: 'chunkGenerated', taskId, cx, cz,
 *                        palette: Uint16Array, indices: Uint8Array, minY, maxY }
 *        (both buffers are transferred, not copied). `indices` holds only the
 *        filled rows minY … maxY, in the layout a chunk is stored in.
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
 *       for light, which reaches SKY_MAX blocks into every neighbour
 *     → Responds with { type: 'chunkMeshed', taskId, cx, cz, geo, light }
 *       with `light` from Skylight.js (plus `light.block` from Blocklight.js,
 *       or null), `geo.rain` the 16×16 column heights rain stops at
 *       (_rainHeights), and `geo.sections` / `geo.conn`: where each
 *       16-level section's triangles are in the opaque indices, and which
 *       of its faces open space joins (engine/Visibility.js); every buffer
 *       is transferred.
 *
 *   farTile { taskId, x0, z0, step, cells, edits? }
 *     → A far-terrain tile (FarTiles.js): the heightfield of the square at
 *       (x0, z0), `cells` × `step` blocks wide, straight from the geography,
 *       with its trees and buildings as boxes at the finer steps. `edits`:
 *       the surfaces of chunks the player has changed there, which replace
 *       the generated ones ([{ cx, cz, heights, ids }]).
 *       Responds with { type: 'farTileBuilt', taskId, x0, z0, step, positions,
 *       colors, normals, indices, yMin, yMax, features }; every buffer is
 *       transferred. Its colours come from `farPalette` (init), the render
 *       thread's average texture colour of each block.
 *
 *   lightChunk { taskId, cx, cz, chunk, neighbors, diagonals }
 *     → Light only (sky and block), for a chunk whose geometry is current but
 *       whose light changed (an edit or a load up to SKY_MAX blocks away in a
 *       neighbour). Responds with { type: 'chunkLit', taskId, cx, cz, light }
 */

import { BlockRegistry }     from '../engine/BlockRegistry.js';
import { TerrainGenerator }  from './TerrainGenerator.js';
import { LegacyWorldGen }    from './legacy/LegacyTerrainGenerator.js';
import { buildFarTile }      from './FarTiles.js';
import { GreedyMesher }      from './GreedyMesher.js';
import { SmoothMesher }      from './SmoothMesher.js';
import { CHUNK_VOLUME, CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, compressVoxels } from '../engine/ChunkData.js';
import { computeSkylight }   from './Skylight.js';
import { computeBlocklight, paletteHasLight } from './Blocklight.js';
import { connectivityOfRows } from '../engine/Visibility.js';

let generator = null;   // TerrainGenerator, or LegacyWorldGen for worlds made before it
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
            case 'farTile':       handleFarTile(data);  break;
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

function handleInit({ seed, blockRegistry: serialisedReg, biomes, blockFaceMap, terrainStyle, terrain, worldGen, farPalette, flat }) {
    const reg = BlockRegistry.deserialize(serialisedReg);

    // A world keeps the generator it was made with: worlds from before the
    // current one (no worldGen) go on generating their old terrain, so what the
    // player has not explored yet still matches what they have.
    generator = (worldGen ?? 1) >= 2
        ? new TerrainGenerator(seed, reg, biomes, terrain, flat)   // flat: a Flat world's settings, or null
        : new LegacyWorldGen(seed, reg);
    generator.setFarPalette(farPalette);
    mesher    = new GreedyMesher(reg, blockFaceMap ?? {});
    smoother  = terrainStyle === 'smooth' ? new SmoothMesher(reg, mesher) : null;

    self.postMessage({ type: 'ready' });
}

function handleGenerate({ taskId, cx, cz }) {
    if (!generator) {
        console.error('[worldWorker] generateChunk called before init');
        return;
    }

    // Terrain, caves, ores and structures.
    const voxels = generator.generate(cx, cz);

    // Compress here, so the main thread only adopts the result.
    const { palette, indices, minY, maxY } = compressVoxels(voxels, cx, cz);
    self.postMessage(
        { type: 'chunkGenerated', taskId, cx, cz, palette, indices, minY, maxY },
        [palette.buffer, indices.buffer],
    );
}

// Every chunk is meshed whole, all six face directions into one group, so it
// draws as one opaque and one transparent mesh.
const ALL_FACES = [0, 1, 2, 3, 4, 5];

function _geoTransferList(geo) {
    const list = [
        geo.positions.buffer, geo.tints.buffer, geo.indices.buffer,
        geo.uvs.buffer, geo.normals.buffer, geo.rain.buffer,
        geo.sections.buffer, geo.conn.buffer,
    ];
    if (geo.transparentPositions.length > 0) {
        list.push(
            geo.transparentPositions.buffer, geo.transparentTints.buffer,
            geo.transparentIndices.buffer, geo.transparentUVs.buffer,
            geo.transparentNormals.buffer,
        );
    }
    return list;
}

function _lightTransferList(light) {
    return light.block ? [light.data.buffer, light.block.data.buffer] : [light.data.buffer];
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
const _lightScan  = new Array(9).fill(false);   // may hold light sources (palette)

/**
 * Sky light, with the block light (torches, lanterns, lamps) as `light.block`
 * — null unless one of the nine chunks' palettes has a light source, which
 * natural terrain never does.
 */
function _light(voxelView, chunk, neighbors, diagonals, neighbourViews) {
    for (let k = 0; k < 9; k++) { _lightViews[k] = null; _lightScan[k] = false; }
    let anyLight = false;
    const put = (key, view, snap) => {
        const [dx, dz] = key.split(',').map(Number);
        const k = (dx + 1) + (dz + 1) * 3;
        _lightViews[k] = view;
        _lightMinY[k]  = snap.minY | 0;
        _lightMaxY[k]  = snap.maxY | 0;
        _lightScan[k]  = paletteHasLight(snap.palette, mesher._light);
        anyLight ||= _lightScan[k];
    };
    put('0,0', voxelView, chunk);
    for (const key of Object.keys(neighbourViews)) put(key, neighbourViews[key], neighbors[key]);
    for (const key of Object.keys(diagonals ?? {})) {
        const snap = diagonals[key], buf = _nbrVoxels[key];
        if (snap && buf) put(key, _expand(snap, buf), snap);
    }
    const light = computeSkylight(_lightViews, _lightMinY, _lightMaxY, mesher._solid);
    light.block = anyLight
        ? computeBlocklight(_lightViews, _lightMinY, _lightMaxY, mesher._solid, mesher._light, _lightScan)
        : null;
    return light;
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

/**
 * Where rain stops in each column, for the render thread's RainHeightmap
 * (Precipitation.js): the world Y of the top of the highest non-air block
 * (torches and lanterns do not count), or,
 * for a deformed Mesh voxel in a smooth world, of its surface at the column
 * centre. NaN for an empty column; x fastest.
 *
 * Computed here because the smooth shapes are already memoised from meshing
 * this chunk. On the render thread the same heights cost hundreds of shape
 * evaluations per chunk against the live world.
 */
function _rainHeights(voxels, yRange) {
    const out = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
    const SZ  = CHUNK_SIZE * CHUNK_SIZE_Y;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            let h = NaN;
            let i = lx + yRange.max * CHUNK_SIZE + lz * SZ;
            for (let ly = yRange.max; ly >= yRange.min; ly--, i -= CHUNK_SIZE) {
                const id = voxels[i];
                if (id === 0 || mesher._model[id] === 1) continue;   // rain falls past a torch
                h = WORLD_MIN_Y + ly + (smoother?.isMesh(id) ? smoother.topHeight(lx, ly, lz) : 1);
                break;
            }
            out[lx + lz * CHUNK_SIZE] = h;
        }
    }
    return out;
}

function handleFarTile({ taskId, x0, z0, step, cells, edits }) {
    // Thrown, not just logged, so the pool hears back and frees this worker.
    if (!generator) throw new Error('farTile called before init');
    const t = buildFarTile(generator, x0, z0, step, cells, edits);
    self.postMessage(
        { type: 'farTileBuilt', taskId, x0, z0, step, ...t },
        [t.positions.buffer, t.colors.buffer, t.normals.buffer, t.indices.buffer],
    );
}

function handleLight({ taskId, cx, cz, chunk, neighbors, diagonals }) {
    if (!mesher) {
        console.error('[worldWorker] lightChunk called before init');
        return;
    }
    const voxelView = _expand(chunk, _selfVoxels);
    const light = _light(voxelView, chunk, neighbors, diagonals, _expandNeighbours(neighbors));
    self.postMessage({ type: 'chunkLit', taskId, cx, cz, light }, _lightTransferList(light));
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

    // Torches and lanterns are drawn from their models, if the palette has any.
    const models = mesher.hasModels(chunk.palette);
    const geo   = mesher.meshGroup(voxelView, neighbourViews, ALL_FACES, yRange, smoothCtx, models);
    geo.rain    = _rainHeights(voxelView, yRange);
    // Which faces of each section open space joins, for the render thread to
    // work out what the camera cannot see (engine/Visibility.js). Sight passes
    // through every cell that is not a full opaque cube — in a smooth world,
    // through the Mesh voxels that are cut to a shape too. The mesher knows
    // which cells those are from meshing the chunk.
    geo.conn    = connectivityOfRows(mesher.closedRows(), yRange.min, yRange.max);
    const light = _light(voxelView, chunk, neighbors, diagonals, neighbourViews);
    self.postMessage(
        { type: 'chunkMeshed', taskId, cx, cz, geo, light },
        [..._geoTransferList(geo), ..._lightTransferList(light)],
    );
}
