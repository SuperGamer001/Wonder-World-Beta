// Sky light (workers/Skylight.js): the propagation rules, and that neighbouring
// chunks compute identical light where their volumes overlap (no seams).
import { computeSkylight } from '../src/scripts/workers/Skylight.js';
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { GreedyMesher } from '../src/scripts/workers/GreedyMesher.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME, voxelIndex } from '../src/scripts/engine/ChunkData.js';

const reg = new BlockRegistry();
reg.register({ id: 0, name: 'AIR',   transparent: true, noCollision: true, color: [0, 0, 0] });
reg.register({ id: 3, name: 'STONE', color: [0.5, 0.5, 0.5] });
reg.register({ id: 5, name: 'WATER', transparent: true, liquid: true, color: [0.2, 0.4, 0.8] });
const opaque = new GreedyMesher(reg, {})._solid;
const AIR = 0, STONE = 3, WATER = 5;

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

/** Light every chunk in [-R, R]² of a world given as fn(wx, ly, wz) → block id. */
function lightWorld(fn, R = 1) {
    const chunks = new Map();
    const get = (cx, cz) => {
        const k = `${cx},${cz}`;
        if (!chunks.has(k)) {
            const v = new Uint16Array(CHUNK_VOLUME);
            let minY = CHUNK_SIZE_Y, maxY = -1;
            for (let lz = 0; lz < CHUNK_SIZE; lz++)
                for (let ly = 0; ly < CHUNK_SIZE_Y; ly++)
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const id = fn(cx * CHUNK_SIZE + lx, ly, cz * CHUNK_SIZE + lz) || 0;
                        v[voxelIndex(lx, ly, lz)] = id;
                        if (id) { if (ly < minY) minY = ly; if (ly > maxY) maxY = ly; }
                    }
            chunks.set(k, { v, minY: Math.max(0, minY), maxY: Math.max(0, maxY) });
        }
        return chunks.get(k);
    };
    const out = new Map();
    for (let cx = -R; cx <= R; cx++) for (let cz = -R; cz <= R; cz++) {
        const views = [], minY = [], maxY = [];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const c = get(cx + dx, cz + dz);
            views.push(c.v); minY.push(c.minY); maxY.push(c.maxY);
        }
        out.set(`${cx},${cz}`, computeSkylight(views, minY, maxY, opaque));
    }
    // Level (0..15) at world (wx, ly, wz) as seen by chunk (cx, cz), or null outside its volume.
    const at = (cx, cz, wx, ly, wz) => {
        const L = out.get(`${cx},${cz}`);
        const ox = wx - cx * CHUNK_SIZE + 1, oz = wz - cz * CHUNK_SIZE + 1, oy = ly - L.y0;
        if (ox < 0 || ox > 17 || oz < 0 || oz > 17 || oy < 0 || oy >= L.h) return null;
        return L.data[ox + oy * 18 + oz * 18 * L.h] / 17;
    };
    const lightAt = (wx, ly, wz) => at(Math.floor(wx / 16), Math.floor(wz / 16), wx, ly, wz);
    return { out, at, lightAt };
}

// ── 1. Open ground, a sealed cave, a shaft into a tunnel, water ──────────────
const G = 40;   // ground top (local Y)
const world = (x, y, z) => {
    if (y > G) {
        // A pond on the surface: water sits on the ground.
        if (y <= G + 3 && x >= -20 && x <= -12 && z >= 4 && z <= 10) return WATER;
        return AIR;
    }
    // Sealed cave: a box of air deep underground, no opening.
    if (y >= 10 && y <= 13 && x >= 3 && x <= 8 && z >= 3 && z <= 8) return AIR;
    // Shaft at (0, 0) from the surface down to a tunnel at y 20..22 running +X.
    if (x === 0 && z === 0 && y >= 20) return AIR;
    if (y >= 20 && y <= 22 && z === 0 && x >= 0 && x <= 30) return AIR;
    return STONE;
};
const W = lightWorld(world);

check('open sky above the ground is 15', W.lightAt(5, G + 1, 5) === 15 && W.lightAt(-7, G + 2, 9) === 15);
check('sealed cave is completely dark', W.lightAt(5, 11, 5) === 0 && W.lightAt(8, 13, 3) === 0);
check('light falls straight down a shaft at full strength', W.lightAt(0, 21, 0) === 15 && W.lightAt(0, 30, 0) === 15);
const tunnel = [1, 2, 5, 10, 14, 15, 20].map(d => W.lightAt(d, 21, 0));
check('tunnel light fades one level per block from the shaft',
    tunnel.join() === [14, 13, 10, 5, 1, 0, 0].join(), `got ${tunnel.join()}`);
check('water lets sky light through', W.lightAt(-15, G + 1, 7) === 15);
check('a ground block reads the light of the air above it', W.lightAt(5, G, 5) === 15);
check('a deep stone block reads its brightest open neighbour (dark)', W.lightAt(20, 5, 20) === 0);

// ── 2. Seams: every chunk agrees with every neighbour on shared cells ────────
// A tunnel network that crosses seams and a chunk corner, lit by two shafts.
const seamWorld = (x, y, z) => {
    if (y > G) return AIR;
    if ((x === -3 && z === -3) || (x === 18 && z === 20)) { if (y >= 20) return AIR; }
    if (y >= 20 && y <= 22 && ((z === -3 && x >= -3 && x <= 25) || (x === 12 && z >= -3 && z <= 30) ||
                               (z === 20 && x >= -10 && x <= 30))) return AIR;
    return STONE;
};
const S = lightWorld(seamWorld, 1);
let compared = 0, mismatches = 0, lit = 0;
for (const a of S.out.keys()) {
    const [acx, acz] = a.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const bcx = acx + dx, bcz = acz + dz;
        if ((!dx && !dz) || !S.out.has(`${bcx},${bcz}`)) continue;
        // Cells inside both volumes.
        for (let wx = acx * 16 - 1; wx <= acx * 16 + 16; wx++)
            for (let wz = acz * 16 - 1; wz <= acz * 16 + 16; wz++)
                for (let y = 18; y <= 24; y++) {
                    const va = S.at(acx, acz, wx, y, wz), vb = S.at(bcx, bcz, wx, y, wz);
                    if (va === null || vb === null) continue;
                    compared++;
                    if (va !== vb) mismatches++;
                    if (va > 0 && va < 15) lit++;
                }
    }
}
check('neighbouring chunks agree on every shared cell (incl. diagonals)',
    compared > 1000 && lit > 50 && mismatches === 0, `${compared} compared, ${lit} partly lit, ${mismatches} differ`);

// ── 3. Cost on a realistic column band ────────────────────────────────────────
const hills = (x, y, z) => {
    const h = 64 + Math.round(10 * Math.sin(x * 0.11) + 8 * Math.cos(z * 0.07));
    if (y > h) return AIR;
    const cave = Math.sin(x * 0.2) * Math.cos(z * 0.2) + Math.sin(y * 0.25) > 1.3;
    return cave ? AIR : STONE;
};
const views = [], minY = [], maxY = [];
for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const v = new Uint16Array(CHUNK_VOLUME);
    let mx = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = hills(dx * 16 + lx, ly, dz * 16 + lz);
        v[voxelIndex(lx, ly, lz)] = id;
        if (id && ly > mx) mx = ly;
    }
    views.push(v); minY.push(0); maxY.push(mx);
}
for (let i = 0; i < 5; i++) computeSkylight(views, minY, maxY, opaque);   // warm up
const t0 = performance.now();
for (let i = 0; i < 20; i++) computeSkylight(views, minY, maxY, opaque);
console.log(`      ${((performance.now() - t0) / 20).toFixed(1)} ms per chunk`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
