/**
 * world.js  —  Render layer
 *
 * Responsibilities (main thread only):
 *   • Three.js scene, camera, renderer, lighting
 *   • First-person player controls (WASD + mouse look)
 *   • Calls ChunkManager.update() every frame
 *   • Converts greedy-meshed geometry data into Three.js BufferGeometry / Mesh
 *   • Disposes geometry and materials when chunks unload
 *
 * World state (voxel data, generation) lives in WorldState / ChunkManager
 * and is fully decoupled from rendering.
 *
 * Chunks are 16×640×16 columns spanning the full world height.
 * Each chunk mesh is positioned at (cx*16, WORLD_MIN_Y, cz*16) in world space.
 */

import * as THREE from 'three';

import { buildRegistryFromGamePack } from './engine/BlockRegistry.js';
import { WorldState }                from './engine/WorldState.js';
import { WorkerPool }                from './engine/WorkerPool.js';
import { ChunkManager }              from './engine/ChunkManager.js';
import { WorldClient }               from './engine/WorldClient.js';
import { CHUNK_SIZE, WORLD_MIN_Y }   from './engine/ChunkData.js';

const WS_URL       = 'ws://localhost:3000';
const AUTO_SAVE_MS = 5 * 60 * 1000;

// ── Three.js singletons ───────────────────────────────────────────────────────

let scene, camera, renderer;
let ambientLight, sunLight;

// ── Engine singletons ─────────────────────────────────────────────────────────

let worldState    = null;
let workerPool    = null;
let chunkManager  = null;
let worldClient   = null;
let _autoSaveTimer = null;
let _wasLocked    = false;

// ── Shared materials (reused across all chunk meshes) ─────────────────────────

let opaqueMaterial      = null;
let transparentMaterial = null;

// ── Active mesh map  key → { opaqueY, opaqueXZ, transpY, transpXZ } ──────────
// Y meshes (±Y faces) are permanent — they never change when a neighbour loads.
// XZ meshes (±X, ±Z faces) are rebuilt via partial re-mesh when a neighbour loads.

const chunkMeshes = new Map();

// ── Player / camera state ─────────────────────────────────────────────────────

const playerVelocity = { x: 0, y: 0, z: 0 };
const PLAYER_SPEED   = 12;
const GRAVITY        = 0;
const CAMERA_HEIGHT  = 1.6;

let   yaw   = 0;
let   pitch = 0;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// Reused every frame — avoids per-frame quaternion allocation and GC pressure.
const _camQ  = new THREE.Quaternion();
const _camQy = new THREE.Quaternion();
const _camQx = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);

// ── Input state ───────────────────────────────────────────────────────────────

const KEYS = {};

// ── Initialisation ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');

    scene            = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog        = new THREE.Fog(0x87CEEB, 160, 280);

    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        512,
    );

    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xfffaed, 0.90);
    sunLight.position.set(0.6, 1.0, 0.4).normalize();
    scene.add(sunLight);

    opaqueMaterial = new THREE.MeshLambertMaterial({
        vertexColors: true,
    });

    transparentMaterial = new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent:  true,
        opacity:      0.72,
        side:         THREE.DoubleSide,
        depthWrite:   false,
    });
});

// ── World load event (fired by main.js → startGame) ───────────────────────────

document.addEventListener('WorldJS_startWorldLoad', async (e) => {
    const { gamepackData = {}, worldId = null, worldSeed = null, playerPos = null } = e.data ?? {};

    const registry = buildRegistryFromGamePack(gamepackData);

    worldState = new WorldState();
    if (worldSeed != null) worldState.seed = worldSeed;

    const workerUrl = new URL('./workers/worldWorker.js', import.meta.url);

    workerPool = new WorkerPool(workerUrl);

    await workerPool.init({
        seed:          worldState.seed,
        blockRegistry: registry.serialize(),
        biomes:        gamepackData.biomes ?? [],
    });

    chunkManager = new ChunkManager(worldState, workerPool, 12);
    chunkManager.worldId = worldId;

    chunkManager.onMeshReady        = _onMeshReady;
    chunkManager.onPartialMeshReady = _onPartialMeshReady;
    chunkManager.onChunkUnload      = _onChunkUnload;

    if (worldId) {
        worldClient = new WorldClient(WS_URL);
        try {
            await worldClient.connect();
            await worldClient.fetchManifest(worldId);
            chunkManager.worldClient = worldClient;
            _autoSaveTimer = setInterval(() => chunkManager.saveAll(), AUTO_SAVE_MS);
        } catch {
            console.warn('[world] Save server not reachable — world will not be persisted');
            worldClient = null;
        }
    }

    const spawnPos = playerPos ?? { x: 0, y: 80, z: 0 };
    me.position = { ...spawnPos };
    camera.position.set(spawnPos.x, spawnPos.y + CAMERA_HEIGHT, spawnPos.z);

    console.log('[world] World load — seed:', worldState.seed,
        '— worldId:', worldId, '— workers:', workerPool.workerCount);
});

// ── Quit event ─────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_quitWorld', () => {
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;

    chunkManager?.saveAll();

    _disposeAll();
    chunkManager = null;
    worldClient  = null;
    workerPool?.clearQueue();
    renderer?.dispose();
});

// ── Tick event (called every animation frame from main.js) ─────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) chunkManager.saveAll();
    _wasLocked = isLocked;

    _updatePlayer(dt);
    _updateCamera();

    chunkManager.update(me.position);

    renderer.render(scene, camera);
});

// ── Resize ─────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Pointer lock ───────────────────────────────────────────────────────────────

document.addEventListener('pointerlockchange', () => {});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== document.getElementById('GameScreen')) return;

    const sensitivity = 0.0018;
    yaw   -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
});

// ── Keyboard ───────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => { KEYS[e.code] = true;  });
document.addEventListener('keyup',   (e) => { KEYS[e.code] = false; });

// ── Mesh callbacks ─────────────────────────────────────────────────────────────

// Full split mesh — initial appearance or block-edit re-mesh.
// yGeo  holds ±Y (top/bottom) faces — permanent until a full re-mesh.
// xzGeo holds ±X/±Z (side)    faces — replaced by partial re-meshes on neighbour load.
function _onMeshReady(cx, cz, yGeo, xzGeo) {
    const key    = WorldState.key(cx, cz);
    const worldX = cx * CHUNK_SIZE;
    const worldZ = cz * CHUNK_SIZE;

    _removeMeshes(key);

    const entry = { opaqueY: null, opaqueXZ: null, transpY: null, transpXZ: null };
    _attachGeo(entry, yGeo,  worldX, worldZ, 'Y');
    _attachGeo(entry, xzGeo, worldX, worldZ, 'XZ');
    chunkMeshes.set(key, entry);
}

// Partial XZ re-mesh — only the side faces are replaced.
// Called at high priority when a horizontal neighbour finishes loading.
function _onPartialMeshReady(cx, cz, xzGeo) {
    const key   = WorldState.key(cx, cz);
    const entry = chunkMeshes.get(key);
    if (!entry) return; // chunk unloaded while job was in flight

    const worldX = cx * CHUNK_SIZE;
    const worldZ = cz * CHUNK_SIZE;

    // Dispose the old XZ meshes only.
    for (const m of [entry.opaqueXZ, entry.transpXZ]) {
        if (!m) continue;
        scene.remove(m);
        m.geometry.dispose();
    }
    entry.opaqueXZ = null;
    entry.transpXZ = null;

    _attachGeo(entry, xzGeo, worldX, worldZ, 'XZ');
}

function _onChunkUnload(key) {
    _removeMeshes(key);
}

// ── Three.js geometry construction ────────────────────────────────────────────

// Build opaque + transparent meshes from a geometry group and attach them to
// `entry` under the given suffix ('Y' or 'XZ'), adding them to the scene.
function _attachGeo(entry, geo, worldX, worldZ, suffix) {
    if (geo.positions.length > 0) {
        const mesh = new THREE.Mesh(_buildGeometry(geo, false), opaqueMaterial);
        mesh.position.set(worldX, WORLD_MIN_Y, worldZ);
        scene.add(mesh);
        entry[`opaque${suffix}`] = mesh;
    }
    if (geo.transparentPositions.length > 0) {
        const mesh = new THREE.Mesh(_buildGeometry(geo, true), transparentMaterial);
        mesh.position.set(worldX, WORLD_MIN_Y, worldZ);
        scene.add(mesh);
        entry[`transp${suffix}`] = mesh;
    }
}

function _buildGeometry(geo, transparent) {
    const buf = new THREE.BufferGeometry();
    const pos  = transparent ? geo.transparentPositions : geo.positions;
    const norm = transparent ? geo.transparentNormals   : geo.normals;
    const col  = transparent ? geo.transparentColors    : geo.colors;
    const idx  = transparent ? geo.transparentIndices   : geo.indices;
    buf.setAttribute('position', new THREE.BufferAttribute(pos,  3));
    buf.setAttribute('normal',   new THREE.BufferAttribute(norm, 3));
    buf.setAttribute('color',    new THREE.BufferAttribute(col,  3));
    buf.setIndex(new THREE.BufferAttribute(idx, 1));
    return buf;
}

function _removeMeshes(key) {
    const entry = chunkMeshes.get(key);
    if (!entry) return;
    for (const mesh of [entry.opaqueY, entry.opaqueXZ, entry.transpY, entry.transpXZ]) {
        if (!mesh) continue;
        scene.remove(mesh);
        mesh.geometry.dispose();
    }
    chunkMeshes.delete(key);
}

function _disposeAll() {
    for (const key of [...chunkMeshes.keys()]) _removeMeshes(key);
}

// ── Player movement ────────────────────────────────────────────────────────────

function _updatePlayer(dt) {
    const fwd   = _horizontalForward();
    const right = { x: fwd.z, z: -fwd.x };
    const speed = (KEYS['ShiftLeft']) ? PLAYER_SPEED * 3 : PLAYER_SPEED;

    let dx = 0, dz = 0, dy = 0;

    if (KEYS['KeyW'])     { dx += fwd.x;   dz += fwd.z;   }
    if (KEYS['KeyS'])     { dx -= fwd.x;   dz -= fwd.z;   }
    if (KEYS['KeyA'])     { dx += right.x; dz += right.z; }
    if (KEYS['KeyD'])     { dx -= right.x; dz -= right.z; }
    if (KEYS['Space'])    dy += 1;
    if (KEYS['ShiftRight']) dy -= 1;

    const len = Math.sqrt(dx*dx + dz*dz);
    if (len > 0) { dx /= len; dz /= len; }

    me.position.x += dx * speed * dt;
    me.position.y += dy * speed * dt;
    me.position.z += dz * speed * dt;
}

function _updateCamera() {
    camera.position.set(
        me.position.x,
        me.position.y + CAMERA_HEIGHT,
        me.position.z,
    );

    _camQ.identity();
    _camQ.multiply(_camQy.setFromAxisAngle(_axisY, yaw));
    _camQ.multiply(_camQx.setFromAxisAngle(_axisX, pitch));
    camera.quaternion.copy(_camQ);
}

// ── Direction helpers ──────────────────────────────────────────────────────────

function _horizontalForward() {
    return {
        x: -Math.sin(yaw),
        z: -Math.cos(yaw),
    };
}

