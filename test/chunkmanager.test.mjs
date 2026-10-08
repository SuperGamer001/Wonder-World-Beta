// ChunkManager scheduling, driven through the real WorkerPool with fake
// workers that answer after random delays, so chunks arrive in arbitrary
// order the way they do in the game.
//
// Checks that however the player moves, every chunk in range ends up
// generated and meshed with nothing left waiting; that a block edit is meshed
// at once; and that a chunk is meshed about once while an area loads, not
// once per neighbour that arrives after it.
import { compressVoxels, CHUNK_VOLUME, CHUNK_SIZE, CHUNK_SIZE_Y } from '../src/scripts/engine/ChunkData.js';
import { WorldState }   from '../src/scripts/engine/WorldState.js';
import { WorkerPool }   from '../src/scripts/engine/WorkerPool.js';
import { ChunkManager } from '../src/scripts/engine/ChunkManager.js';

// The pool logs each (simulated) worker failure; keep the output readable.
const logError = console.error;
console.error = (...a) => { if (!a.some(x => String(x).includes('simulated failure'))) logError(...a); };

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// Deterministic randomness, so a failure reproduces.
let rs = 0x2545F491;
const rand = () => ((rs = Math.imul(rs ^ (rs >>> 13), 0x5bd1e995) + 0x6b43a9b5 | 0) >>> 0) / 4294967296;

// One flat column (stone to y 70), compressed once and copied per reply.
const FLAT = (() => {
    const v = new Uint16Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let ly = 0; ly < 198; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++)
        v[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE_Y] = 3;
    return compressVoxels(v);
})();

// ── Fake workers: reply to each job after 1–4 ticks; ~3% fail ──────────────
const stats = { gen: 0, mesh: 0, light: 0, meshBy: new Map(), inFlight: new Set() };
let pendingReplies = [];
let failRate = 0.03;
class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(msg) {
        const { type, taskId, cx, cz } = msg;
        stats.inFlight.add(taskId);
        let reply;
        if (type === 'init') { reply = { type: 'ready' }; }
        else if (rand() < failRate) { reply = { type: 'error', taskId, message: 'simulated failure' }; }
        else if (type === 'generateChunk') {
            stats.gen++;
            reply = { type: 'chunkGenerated', taskId, cx, cz, palette: FLAT.palette.slice(),
                      indices: FLAT.indices.slice(), minY: FLAT.minY, maxY: FLAT.maxY };
        } else if (type === 'meshChunk') {
            // The payload must be a real snapshot built for this chunk.
            const s = msg.chunk;
            if (!(s?.indices instanceof Uint8Array) ||
                s.indices.length !== (s.maxY - s.minY + 1) * CHUNK_SIZE * CHUNK_SIZE) throw new Error('bad mesh payload');
            const k = `${cx},${cz}`;
            stats.mesh++;
            stats.meshBy.set(k, (stats.meshBy.get(k) ?? 0) + 1);
            reply = { type: 'chunkMeshed', taskId, cx, cz, geo: {}, light: { data: new Uint8Array(1), y0: 0, h: 1 } };
        } else if (type === 'lightChunk') {
            stats.light++;
            reply = { type: 'chunkLit', taskId, cx, cz, light: { data: new Uint8Array(1), y0: 0, h: 1 } };
        }
        pendingReplies.push({ at: tick + 1 + ((rand() * 4) | 0), w: this, reply, taskId });
    }
    terminate() {}
}
globalThis.Worker = FakeWorker;

let tick = 0;
function deliver() {
    const due = pendingReplies.filter(r => r.at <= tick);
    pendingReplies = pendingReplies.filter(r => r.at > tick);
    // Out of order within a tick, too.
    due.sort(() => rand() - 0.5);
    for (const r of due) { stats.inFlight.delete(r.taskId); r.w.onmessage?.({ data: r.reply }); }
}

async function makeManager(smooth, rd = 5) {
    const world = new WorldState();
    const pool  = new WorkerPool('fake://worker', 4);
    const initDone = pool.init({});
    for (let i = 0; i < 6; i++) { tick++; deliver(); }
    await initDone;
    const cm = new ChunkManager(world, pool, rd);
    cm.smooth = smooth;
    const shown = new Set();
    cm.onMeshReady   = (cx, cz) => shown.add(`${cx},${cz}`);
    cm.onChunkUnload = (key) => shown.delete(key);
    cm.ready = true;
    return { world, pool, cm, shown };
}

function step(cm, pos) { tick++; deliver(); cm.update(pos); }

/** Run until nothing is in flight or queued, or give up. */
function settle(cm, pool, pos, max = 4000) {
    for (let i = 0; i < max; i++) {
        step(cm, pos);
        if (pendingReplies.length === 0 && pool._queue.length === 0 && i > 5) {
            // One more update to pick up anything retried after a failure.
            step(cm, pos);
            if (pendingReplies.length === 0 && pool._queue.length === 0) return i;
        }
    }
    return -1;
}

function invariants(label, { world, pool, cm, shown }, pos) {
    const pcx = WorldState.worldToChunk(Math.floor(pos.x)), pcz = WorldState.worldToChunk(Math.floor(pos.z));
    const rd = cm.renderDistance;
    let needed = 0, generated = 0, meshed = 0, onScreen = 0, stuck = 0;
    // The loaded area is the full (2rd+1)² square around the player's chunk.
    for (let dx = -rd; dx <= rd; dx++) for (let dz = -rd; dz <= rd; dz++) {
        needed++;
        const c = world.getChunk(pcx + dx, pcz + dz);
        if (c?.generated) generated++;
        if (c?.meshed) meshed++;
        if (shown.has(`${pcx + dx},${pcz + dz}`)) onScreen++;
        if (c && (c.dirty || c._needLight)) stuck++;
    }
    check(`${label}: every chunk in range generated`, generated === needed, `${generated}/${needed}`);
    check(`${label}: every chunk in range meshed and shown`, meshed === needed && onScreen === needed, `${meshed}/${needed}`);
    check(`${label}: nothing left waiting`, cm._gated.size === 0 && stuck === 0 &&
          cm._pendingMesh.size === 0 && cm._pendingLight.size === 0,
          `gated ${cm._gated.size}, flagged ${stuck}`);
    check(`${label}: nothing loaded outside range`, world.chunks.size === needed, `${world.chunks.size} loaded`);
}

for (const smooth of [true, false]) {
    const name = smooth ? 'smooth' : 'blocky';
    for (const k of ['gen', 'mesh', 'light']) stats[k] = 0;
    stats.meshBy.clear();
    const env = await makeManager(smooth);
    const { cm, pool } = env;

    // ── Initial load ────────────────────────────────────────────────────────
    let pos = { x: 8, y: 80, z: 8 };
    check(`${name}: initial load settles`, settle(cm, pool, pos) >= 0);
    invariants(`${name} initial`, env, pos);
    const meshes = [...stats.meshBy.values()];
    const avg = meshes.reduce((a, b) => a + b, 0) / meshes.length;
    // With simulated failures a few chunks mesh twice; before gating, the
    // average here was ~3 in smooth worlds (every later neighbour re-meshed it).
    check(`${name}: about one full mesh per chunk while loading`, avg < 1.35, `avg ${avg.toFixed(2)}, max ${Math.max(...meshes)}`);

    // ── Fly, turn, fly back; stop and settle ────────────────────────────────
    for (let i = 0; i < 120; i++) { pos = { x: pos.x + 1.5, y: 80, z: pos.z + (i > 60 ? 1 : 0) }; step(cm, pos); }
    for (let i = 0; i < 90; i++)  { pos = { x: pos.x - 2, y: 80, z: pos.z - 0.5 }; step(cm, pos); }
    check(`${name}: settles after flying`, settle(cm, pool, pos) >= 0);
    invariants(`${name} after flight`, env, pos);

    // Just below zero on both axes: the player's chunk is -1, not 0.
    for (let i = 0; i < 12; i++) { pos = { x: pos.x - 2.625, y: 80, z: pos.z - 2.625 }; step(cm, pos); }
    pos = { x: -0.5, y: 80, z: -0.25 };
    check(`${name}: settles just below zero`, settle(cm, pool, pos) >= 0);
    invariants(`${name} at negative coords`, env, pos);

    // ── Render distance change ──────────────────────────────────────────────
    cm.renderDistance = 3;
    check(`${name}: settles after shrinking render distance`, settle(cm, pool, pos) >= 0);
    invariants(`${name} rd 3`, env, pos);
    cm.renderDistance = 6;
    check(`${name}: settles after growing render distance`, settle(cm, pool, pos) >= 0);
    invariants(`${name} rd 6`, env, pos);

    // ── A block edit is meshed straight away ────────────────────────────────
    failRate = 0;
    const before = stats.mesh;
    const wx = (pos.x | 0) + 3, wz = (pos.z | 0) + 3;
    env.world.setBlock(wx, 70, wz, 0);
    cm.markEdited(wx, wz);
    // The pool builds and posts at once when a worker is free.
    check(`${name}: edit dispatches a mesh job immediately`, stats.mesh > before, `${stats.mesh - before} new`);
    check(`${name}: settles after the edit`, settle(cm, pool, pos) >= 0);
    invariants(`${name} after edit`, env, pos);
    failRate = 0.03;

    console.log(`      jobs: ${stats.gen} generate, ${stats.mesh} mesh, ${stats.light} light`);
    env.pool.terminate();
}

// ── A job whose chunk unloads before it runs costs nothing ──────────────────
{
    const env = await makeManager(true, 2);
    const { cm, pool, world } = env;
    const pos = { x: 8, y: 80, z: 8 };
    settle(cm, pool, pos);
    // Fill every worker, then queue a mesh and unload its chunk before it runs.
    const busy = [];
    for (const e of pool._workers) { e.busy = true; busy.push(e); }
    const c = world.getChunk(0, 0);
    let result = null;
    const beforePosted = stats.mesh;
    cm._requestMesh(0, 0);
    const cb = pool._callbacks.get(pool._taskId - 1);
    pool._callbacks.set(pool._taskId - 1, (r) => { result = r; cb(r); });
    cm._unload('0,0');
    for (const e of busy) e.busy = false;
    pool._flush();
    check('queued job for an unloaded chunk is cancelled, not built', result?.type === 'cancelled' && stats.mesh === beforePosted);
    check('its pending flag is cleared', !cm._pendingMesh.has('0,0'));
    void c;
    env.pool.terminate();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
