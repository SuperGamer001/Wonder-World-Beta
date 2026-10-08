// Verifies the rewritten GreedyMesher against a brute-force per-face reference.
import { GreedyMesher } from '../src/scripts/workers/GreedyMesher.js';
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME, voxelIndex } from '../src/scripts/engine/ChunkData.js';
import { UV_SCALE, NO_LAYER, MAX_INDEX16_VERTS } from '../src/scripts/engine/MeshFormat.js';

const reg = new BlockRegistry();
reg.register({ id: 0, name: 'AIR',   transparent: true, noCollision: true, color: [0, 0, 0] });
reg.register({ id: 1, name: 'GRASS', color: [0.38, 0.32, 0.18], topColor: [0.32, 0.58, 0.18] });
reg.register({ id: 3, name: 'STONE', color: [0.5, 0.5, 0.5] });
reg.register({ id: 5, name: 'WATER', transparent: true, liquid: true, color: [0.2, 0.4, 0.8] });
reg.register({ id: 7, name: 'LEAVES', transparent: true, color: [0.1, 0.5, 0.1] });        // a cutout, by its name
reg.register({ id: 13, name: 'ICE',   transparent: true, color: [0.7, 0.85, 0.9] });        // translucent, like water
reg.register({ id: 28, name: 'GLASS', transparent: true, render: 'cutout', color: [0.8, 0.9, 0.95] });
reg.register({ id: 4, name: 'SAND', terrainType: 'mesh', blend: 30, color: [0.8, 0.7, 0.5] });
reg.register({ id: 2, name: 'TURF', terrainType: 'mesh', blend: 60, color: [0.3, 0.6, 0.2] });
reg.register({ id: 36, name: 'TORCH', model: 'torch', noCollision: true, light: 14, color: [1, 0.8, 0.4] });
reg.register({ id: 37, name: 'WALL_TORCH_EAST', model: 'wall_torch', facing: 'east', noCollision: true, light: 14, color: [1, 0.8, 0.4] });
reg.register({ id: 40, name: 'WALL_TORCH_NORTH', model: 'wall_torch', facing: 'north', noCollision: true, light: 14, color: [1, 0.8, 0.4] });
reg.register({ id: 42, name: 'HANGING_LANTERN', model: 'hanging_lantern', noCollision: true, light: 15, color: [1, 0.7, 0.3] });
const TORCH = 36, WALL_E = 37, WALL_N = 40, HANGING = 42;

const faceMap = { 1: { top: 1, side: 2, bottom: 0 }, 3: { top: 3, side: 3, bottom: 3 }, 36: { top: 33 },
                  4: { top: 4, side: 4, bottom: 4 }, 2: { top: 9, side: 9, bottom: 9 } };
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
// Opaque blocks show a face against anything that is not opaque. Cutouts
// (leaves, glass) are in the opaque mesh and show one against anything that
// does not hide it, except more of themselves. Translucent blocks (water, ice)
// show one against air, a model or a cutout — and every such face is in the
// transparent mesh twice, once facing each way.
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
                    if (id === 0 || reg.hasModel(id)) continue;   // models draw themselves
                    const adj = read(lx+dx, ly+dy, lz+dz);
                    if (reg.isSolid(id)) { if (!isSolid(adj)) { opaque++; opaqueArea++; } }
                    else if (reg.get(id).render === 'cutout') { if (adj !== id && !isSolid(adj)) { opaque++; opaqueArea++; } }
                    else if (adj === 0 || (adj !== 0xFFFF && (reg.hasModel(adj) || reg.get(adj).render === 'cutout'))) { transparent++; transpArea += 2; }
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
    if (geo.tints.length / 4 !== vcount) return 'tint/vertex count mismatch';
    if (geo.uvs.length / 2 !== vcount) return 'uv/vertex count mismatch';
    if (geo.transparentTints.length / 4 !== tv) return 'transparent tint/vertex count mismatch';
    if (geo.transparentUVs.length / 2 !== tv) return 'transparent uv/vertex count mismatch';
    if (geo.normals.length !== vcount * 4) return 'normal/vertex count mismatch';
    if (geo.transparentNormals.length !== tv * 4) return 'transparent normal/vertex count mismatch';
    return checkNormals(geo.positions, geo.normals, geo.indices, true) ??
           checkNormals(geo.transparentPositions, geo.transparentNormals, geo.transparentIndices, true);
}

/**
 * Every triangle faces the way its vertices' normals say (so front faces are
 * the lit side), and — for greedy quads — the normal is a unit axis.
 */
function checkNormals(pos, nrm, idx, axis) {
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
        const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
        const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const k = idx[t] * 4, n = [nrm[k], nrm[k + 1], nrm[k + 2]];
        if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] <= 0) return `triangle ${t / 3} is wound against its normal`;
        if (axis && Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) !== 127) return `normal ${n} is not a unit axis`;
    }
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

// 6. Leaves in air: a cutout, so in the opaque mesh
run('leaves cluster', makeWorld((x,y,z) => (x>=6&&x<=9&&z>=6&&z<=9&&y>=200&&y<=203) ? 7 : 0));

// 6b. See-through blocks against each other: a glass box in water with a
// leaf block on it and ice beside it. Glass and leaves show against water and
// each other; water shows against glass and leaves; water and ice hide each
// other's faces.
run('glass, leaves and ice in water', makeWorld((x, y, z) => {
    if (y < 90) return 3;
    if (x >= 6 && x <= 8 && z >= 6 && z <= 8 && y >= 90 && y <= 92) return 28;
    if (x === 7 && z === 7 && y === 93) return 7;
    if (y === 95 && x >= 10) return 13;
    if (y <= 95) return 5;
    return 0;
}));

// 6c. The transparent mesh is drawn with back faces culled and in the order
// of its indices, so that order has to be back to front. Two sheets of water
// one above the other, and an ice block between them: from above, below and
// between, the faces the camera can see must come further ones first, for
// faces on the same axis.
{
    const v = makeWorld((x, y, z) => (y === 100 || y === 110) ? 5 : (y === 105 && x >= 6 && x <= 9 && z >= 6 && z <= 9) ? 13 : 0);
    const geo = mesher.meshGroup(v, {}, [0, 1, 2, 3, 4, 5], filledRange(v));
    const P = geo.transparentPositions, N = geo.transparentNormals, I = geo.transparentIndices;
    let ok = true, why = '', seen = 0;
    for (const cam of [[8, 130, 8], [8, 80, 8], [8, 103.5, 8], [8, 108.2, 8], [-20, 120, 30], [40, 90, -12], [3.5, 105.5, 20]]) {
        // Per axis and facing: the last visible face's distance along the axis.
        // (Faces turned opposite ways are on opposite sides of the camera, so
        // no line of sight crosses one of each.)
        const last = new Array(6).fill(null);
        for (let t = 0; t < I.length && ok; t += 6) {
            const a = I[t], n = [N[a * 4], N[a * 4 + 1], N[a * 4 + 2]];
            const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
            const plane = P[a * 3 + axis], side = cam[axis] - plane;
            if (side * n[axis] <= 0) continue;     // turned away: culled
            seen++;
            const d = Math.abs(side), k = axis * 2 + (n[axis] > 0 ? 0 : 1);
            if (last[k] !== null && d > last[k] + 1e-6) { ok = false; why = `from ${cam}: a face ${d} away on axis ${axis} is drawn after one ${last[k]} away`; }
            last[k] = d;
        }
    }
    if (seen === 0) { ok = false; why = 'no visible translucent faces'; }
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  translucent faces are ordered back to front on each axis  ${ok ? '' : why}`);
}

// 6d. Smooth worlds: the top of natural ground carries which ground spreads
// over it, and from where (blendCode). A strip of sand (lower) beside turf
// (higher): the sand next to the turf says so on its turf side; nothing else does.
{
    const v = makeWorld((x, y, z) => y < 100 ? 3 : y === 100 ? (x < 8 ? 4 : 2) : 0);
    const occ = new Uint8Array(65536);
    for (const d of reg.serialize()) if (reg.isSolid(d.id)) occ[d.id] = 1;
    occ[0xFFFF] = 1;
    const read = (x, y, z) => (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE_Y) ? 0xFFFF : v[x + y * SY + z * SZ];
    const ctx = { occ, partial: new Uint8Array(CHUNK_VOLUME), emit: () => {}, read };
    const geo = mesher.meshGroup(v, {}, [0, 1, 2, 3, 4, 5], filledRange(v), ctx);
    let ok = true, why = '', blended = 0;
    for (let q = 0; q < geo.positions.length / 3; q += 4) {
        if (geo.normals[q * 4 + 1] !== 127 || geo.positions[q * 3 + 1] !== 101) continue;      // tops of the ground only
        const x0 = Math.min(geo.positions[q * 3], geo.positions[q * 3 + 3], geo.positions[q * 3 + 6]);
        const x1 = Math.max(geo.positions[q * 3], geo.positions[q * 3 + 3], geo.positions[q * 3 + 6]);
        const layer = geo.tints[q * 4 + 3], over = geo.tints[q * 4], sides = geo.tints[q * 4 + 1], natural = geo.tints[q * 4 + 2];
        if (natural !== 255) { ok = false; why = 'natural ground must be flagged'; }
        if (layer === 4 && x1 === 8) {
            // The column of sand along the turf: turf's layer, from +x (and its two corners).
            if (x0 !== 7 || over !== 9 || (sides & 2) === 0 || (sides & 0b01010101) !== 0) { ok = false; why = `sand by the turf: x ${x0}..${x1}, layer ${over}, sides ${sides.toString(2)}`; }
            blended++;
        } else if (sides !== 0) { ok = false; why = `layer ${layer} at x ${x0}..${x1} should not blend (sides ${sides.toString(2)})`; }
    }
    if (blended === 0) { ok = false; why ||= 'no blended face found'; }
    // Without the smooth context nothing blends, and other faces never do.
    const plain = mesher.meshGroup(v, {}, [0, 1, 2, 3, 4, 5], filledRange(v));
    for (let i = 0; i < plain.tints.length; i += 4) if (plain.tints[i + 1] !== 0) { ok = false; why = 'a blocky mesh must not blend'; break; }
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  natural ground carries its neighbour's spread (smooth worlds only)  ${ok ? '' : why}`);
}

// 7. With a solid neighbour on +X: the +X boundary faces must be culled
const solidNbr = makeWorld((x,y,z) => y <= 200 ? 3 : 0);
run('ground with solid +X neighbour', makeWorld((x,y,z) => y <= 200 ? 3 : 0), { '1,0': solidNbr });

// 8. Checkerboard — worst case for greedy merging
run('checkerboard', makeWorld((x,y,z) => ((x + y + z) % 2 === 0 && y >= 100 && y <= 102) ? 3 : 0));

// 9. Empty chunk
run('empty chunk', makeWorld(() => 0));

// 10. Torches and a lantern on and against stone, beside water. Model blocks
// are not greedy-meshed and hide nothing: the stone under a torch and the
// water beside one keep their faces (the reference counts them).
const torchWorld = makeWorld((x, y, z) => {
    if (y < 100) return 3;
    if (y === 100 && x >= 10) return 5;                       // water beside the torch at x 9
    if (x === 9 && y === 100 && z === 8) return TORCH;
    if (x === 1 && y === 101 && z === 1) return WALL_E;       // leaning off the pillar at x 0
    if (x === 0 && y <= 103 && z === 1) return 3;
    if (x === 5 && y === 102 && z === 12) return WALL_N;      // leaning off the pillar at z 13
    if (x === 5 && y <= 103 && z === 13) return 3;
    if (x === 12 && y === 104 && z === 3) return HANGING;     // under the slab at y 105
    if (y === 105 && x >= 11 && x <= 13 && z >= 2 && z <= 4) return 3;
    return 0;
});
run('torches and a lantern (as cubes, the rest must be unchanged)', torchWorld);
{
    const yr = filledRange(torchWorld);
    const plain = mesher.meshGroup(torchWorld, {}, [0, 1, 2, 3, 4, 5], yr, null, false);
    const geo   = mesher.meshGroup(torchWorld, {}, [0, 1, 2, 3, 4, 5], yr, null, true);
    const first = plain.positions.length / 3, vcount = geo.positions.length / 3;
    // Torch 1 box, wall torches 1 each, hanging lantern: body 6 faces, cap 5, chain 4.
    const want = (6 + 6 + 6 + 6 + 5 + 4) * 4;
    let ok = vcount - first === want && mesher.hasModels([0, 3, TORCH]) && !mesher.hasModels([0, 3, 5]);
    let why = `${vcount - first} model vertices, expected ${want}`;
    // Every model vertex inside one of the model voxels, glowing, and the
    // model triangles wound to match their normals.
    const voxels = [[9, 100, 8], [1, 101, 1], [5, 102, 12], [12, 104, 3]];
    for (let v = first; v < vcount && ok; v++) {
        const p = [geo.positions[v * 3], geo.positions[v * 3 + 1], geo.positions[v * 3 + 2]];
        const inside = voxels.some(([x, y, z]) => p[0] >= x - 1e-6 && p[0] <= x + 1 + 1e-6 &&
            p[1] >= y - 1e-6 && p[1] <= y + 1 + 1e-6 && p[2] >= z - 1e-6 && p[2] <= z + 1 + 1e-6);
        if (!inside) { ok = false; why = `vertex ${p.map(x => x.toFixed(3))} outside every model voxel`; }
        if (geo.normals[v * 4 + 3] !== 127) { ok = false; why = 'a model vertex does not glow'; }
    }
    const modelIdx = geo.indices.filter(i => i >= first);
    const wound = checkNormals(geo.positions, geo.normals, modelIdx, false);
    if (wound) { ok = false; why = wound; }
    // The wall torch leans away from its wall: its top is further from x 0 than its foot.
    let footX = Infinity, topX = -Infinity;
    for (let v = first; v < vcount; v++) {
        const x = geo.positions[v * 3], y = geo.positions[v * 3 + 1], z = geo.positions[v * 3 + 2];
        if (z < 1 || z > 2 || x > 2) continue;
        if (y < 101.3) footX = Math.min(footX, x);
        if (y > 101.7) topX = Math.max(topX, x);
    }
    if (!(topX > footX + 0.2)) { ok = false; why = `wall torch does not lean off its wall (foot ${footX}, top ${topX})`; }
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  model blocks: geometry inside the voxel, facing out, glowing  ${ok ? '' : why}`);
}

// ── Vertex packing (engine/MeshFormat.js) ────────────────────────────────────
// One grass block (textured: top layer 1, side 2, bottom 0) on its own, and a
// 3 × 2 slab of leaves (untextured, its own colour; a cutout, so in the opaque
// mesh with it).
{
    const v = makeWorld((x, y, z) => (x === 4 && y === 60 && z === 4) ? 1 : (y === 50 && x < 3 && z < 2) ? 7 : 0);
    const geo = mesher.meshGroup(v, {}, [0, 1, 2, 3, 4, 5], filledRange(v));
    let ok = true, why = '';
    const fail = (m) => { if (ok) { ok = false; why = m; } };
    if (!(geo.tints instanceof Uint8Array) || !(geo.uvs instanceof Uint16Array)) fail('tints must be bytes and uvs shorts');
    if (!(geo.indices instanceof Uint16Array)) fail('a small mesh must use 16-bit indices');
    const layers = new Set();
    const t = geo.tints, want = [0.1, 0.5, 0.1].map(c => Math.round(c * 255));
    let maxUV = 0, leaves = 0;
    for (let i = 0; i < t.length; i += 4) {
        if (t[i + 3] === NO_LAYER) {
            // Untextured (the leaves): the block's colour.
            if (t[i] !== want[0] || t[i + 1] !== want[1] || t[i + 2] !== want[2]) fail(`leaf colour: got ${t[i]},${t[i + 1]},${t[i + 2]}`);
            maxUV = Math.max(maxUV, geo.uvs[i / 2], geo.uvs[i / 2 + 1]);
            leaves++;
        } else {
            // Textured: no colour of its own — the blend bytes, here "nothing".
            if (t[i] !== 0 || t[i + 1] !== 0 || t[i + 2] !== 0) fail('a textured face that blends with nothing must carry zeros');
            layers.add(t[i + 3]);
            for (const u of [geo.uvs[i / 2], geo.uvs[i / 2 + 1]]) if (u !== 0 && u !== UV_SCALE) fail(`a one-block face's uv must be 0 or 1 block, got ${u / UV_SCALE}`);
        }
    }
    if ([...layers].sort().join() !== '0,1,2') fail(`grass layers: got ${[...layers].sort().join()}`);
    if (leaves === 0) fail('the leaves should be in the opaque mesh');
    if (geo.transparentPositions.length !== 0) fail('nothing here is translucent');
    // The merged top quad is 3 × 2 blocks: its uvs reach 3.
    if (maxUV / UV_SCALE !== 3) fail(`merged quad uv should reach 3 blocks, got ${maxUV / UV_SCALE}`);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  packed vertices: tint bytes, layers, 16-bit uvs and indices  ${ok ? '' : why}`);
}
{
    // A checkerboard has more vertices than 16-bit indices can address.
    const v = makeWorld((x, y, z) => (y < 80 && (x + y + z) % 2 === 0) ? 3 : 0);
    const geo = mesher.meshGroup(v, {}, [0, 1, 2, 3, 4, 5], filledRange(v));
    const verts = geo.positions.length / 3;
    let max = 0;
    for (const i of geo.indices) if (i > max) max = i;
    const ok = verts > MAX_INDEX16_VERTS && geo.indices instanceof Uint32Array && max === verts - 1;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  a mesh too large for 16-bit indices keeps 32-bit ones  verts ${verts}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
