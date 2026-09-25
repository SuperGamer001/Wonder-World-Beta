// Verifies the rewritten GreedyMesher against a brute-force per-face reference.
import { GreedyMesher } from '../src/scripts/workers/GreedyMesher.js';
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME, voxelIndex } from '../src/scripts/engine/ChunkData.js';

const reg = new BlockRegistry();
reg.register({ id: 0, name: 'AIR',   transparent: true, noCollision: true, color: [0, 0, 0] });
reg.register({ id: 1, name: 'GRASS', color: [0.38, 0.32, 0.18], topColor: [0.32, 0.58, 0.18] });
reg.register({ id: 3, name: 'STONE', color: [0.5, 0.5, 0.5] });
reg.register({ id: 5, name: 'WATER', transparent: true, liquid: true, color: [0.2, 0.4, 0.8] });
reg.register({ id: 7, name: 'LEAVES', transparent: true, color: [0.1, 0.5, 0.1] });

const faceMap = { 1: { top: 1, side: 2, bottom: 0 }, 3: { top: 3, side: 3, bottom: 3 } };
const mesher = new GreedyMesher(reg, faceMap);

const SY = CHUNK_SIZE, SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
const NORMALS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

function makeWorld(fn) {
    const v = new Uint16Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE; lz++)
        for (let ly = 0; ly < CHUNK_SIZE_Y; ly++)
            for (let lx = 0; lx < CHUNK_SIZE; lx++)
                v[voxelIndex(lx, ly, lz)] = fn(lx, ly, lz) || 0;
    return v;
}

function filledRange(v) {
    let min = CHUNK_SIZE_Y, max = -1;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) {
        const ly = ((i / CHUNK_SIZE) | 0) % CHUNK_SIZE_Y;
        if (ly < min) min = ly;
        if (ly > max) max = ly;
    }
    return max < 0 ? { min: 0, max: 0 } : { min, max };
}

// Brute-force reference: count every visible face, per direction, one quad each.
function referenceFaces(v, nbr) {
    const read = (lx, ly, lz) => {
        if (ly < 0 || ly >= CHUNK_SIZE_Y) return 0xFFFF;
        if (lx < 0)             return nbr['-1,0'] ? nbr['-1,0'][(lx + CHUNK_SIZE) + ly*SY + lz*SZ] : 0xFFFF;
        if (lx >= CHUNK_SIZE)   return nbr['1,0']  ? nbr['1,0'][(lx - CHUNK_SIZE) + ly*SY + lz*SZ]  : 0xFFFF;
        if (lz < 0)             return nbr['0,-1'] ? nbr['0,-1'][lx + ly*SY + (lz + CHUNK_SIZE)*SZ] : 0xFFFF;
        if (lz >= CHUNK_SIZE)   return nbr['0,1']  ? nbr['0,1'][lx + ly*SY + (lz - CHUNK_SIZE)*SZ]  : 0xFFFF;
        return v[lx + ly*SY + lz*SZ];
    };
    const isSolid = (id) => id === 0xFFFF || reg.isSolid(id);
    let opaque = 0, transparent = 0;
    // area accumulators let us compare against merged quads
    let opaqueArea = 0, transpArea = 0;
    for (let ni = 0; ni < 6; ni++) {
        const [dx, dy, dz] = NORMALS[ni];
        for (let lz = 0; lz < CHUNK_SIZE; lz++)
            for (let ly = 0; ly < CHUNK_SIZE_Y; ly++)
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const id = v[lx + ly*SY + lz*SZ];
                    if (id === 0) continue;
                    const adj = read(lx+dx, ly+dy, lz+dz);
                    if (reg.isSolid(id)) { if (!isSolid(adj)) { opaque++; opaqueArea++; } }
                    else if (adj === 0)  { transparent++; transpArea++; }
                }
    }
    return { opaqueArea, transpArea };
}

// Sum of quad areas emitted by the mesher, computed from positions.
function meshedArea(geo, transparentPass) {
    const pos = transparentPass ? geo.transparentPositions : geo.positions;
    let area = 0;
    for (let q = 0; q < pos.length; q += 12) {
        const p0 = [pos[q], pos[q+1], pos[q+2]];
        const p1 = [pos[q+3], pos[q+4], pos[q+5]];
        const p3 = [pos[q+9], pos[q+10], pos[q+11]];
        const e1 = [p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]];
        const e2 = [p3[0]-p0[0], p3[1]-p0[1], p3[2]-p0[2]];
        const cr = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
        area += Math.abs(cr[0]) + Math.abs(cr[1]) + Math.abs(cr[2]);
    }
    return area;
}

function checkIndices(geo) {
    const vcount = geo.positions.length / 3;
    for (const i of geo.indices) if (i >= vcount) return `opaque index ${i} >= ${vcount}`;
    const tv = geo.transparentPositions.length / 3;
    for (const i of geo.transparentIndices) if (i >= tv) return `transparent index ${i} >= ${tv}`;
    if (geo.indices.length % 3 !== 0) return 'opaque index count not a multiple of 3';
    if (geo.colors.length / 3 !== vcount) return 'colour/vertex count mismatch';
    if (geo.uvs.length / 2 !== vcount) return 'uv/vertex count mismatch';
    if (geo.layers.length !== vcount) return 'layer/vertex count mismatch';
    return null;
}

let failures = 0;
function run(name, voxels, nbr = {}) {
    const yr = filledRange(voxels);
    const geo = mesher.mesh(voxels, nbr, yr);
    const ref = referenceFaces(voxels, nbr);
    const gotO = meshedArea(geo, false);
    const gotT = meshedArea(geo, true);
    const idxErr = checkIndices(geo);
    const ok = gotO === ref.opaqueArea && gotT === ref.transpArea && !idxErr;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`        opaque area  expected ${ref.opaqueArea}  got ${gotO}`);
    console.log(`        transp area  expected ${ref.transpArea}  got ${gotT}`);
    console.log(`        verts ${geo.positions.length/3} tris ${geo.indices.length/3}  yRange ${yr.min}..${yr.max}`);
    if (idxErr) console.log(`        INDEX ERROR: ${idxErr}`);
}

// 1. Single block floating in the middle
run('single stone block', makeWorld((x,y,z) => (x===8 && y===200 && z===8) ? 3 : 0));

// 2. Flat slab — greedy merging should collapse the top into few quads
run('flat 16x16 slab', makeWorld((x,y,z) => y === 200 ? 3 : 0));

// 3. Solid fill from 0..200 (ground)
run('solid ground to y=200', makeWorld((x,y,z) => y <= 200 ? 3 : 0));

// 4. Grass over stone (multi-material, exercises face colour + layer tables)
run('grass over stone', makeWorld((x,y,z) => y === 200 ? 1 : y < 200 ? 3 : 0));

// 5. Transparent water pool over stone
run('water over stone', makeWorld((x,y,z) => {
    if (y < 198) return 3;
    if (y >= 198 && y <= 200) return 5;
    return 0;
}));

// 6. Mixed leaves (transparent, non-liquid) in air
run('leaves cluster', makeWorld((x,y,z) => (x>=6&&x<=9&&z>=6&&z<=9&&y>=200&&y<=203) ? 7 : 0));

// 7. With a solid neighbour on +X: the +X boundary faces must be culled
const solidNbr = makeWorld((x,y,z) => y <= 200 ? 3 : 0);
run('ground with solid +X neighbour', makeWorld((x,y,z) => y <= 200 ? 3 : 0), { '1,0': solidNbr });

// 8. Checkerboard — worst case for greedy merging
run('checkerboard', makeWorld((x,y,z) => ((x + y + z) % 2 === 0 && y >= 100 && y <= 102) ? 3 : 0));

// 9. Empty chunk
run('empty chunk', makeWorld(() => 0));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
