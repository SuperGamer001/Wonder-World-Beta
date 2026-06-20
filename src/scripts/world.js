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
 */

import * as THREE from 'three';

import { buildRegistryFromGamePack } from './engine/BlockRegistry.js';
import { WorldState }                from './engine/WorldState.js';
import { WorkerPool }                from './engine/WorkerPool.js';
import { ChunkManager }              from './engine/ChunkManager.js';
import { CHUNK_SIZE }                from './engine/ChunkData.js';

// ── Three.js singletons ───────────────────────────────────────────────────────

let scene, camera, renderer;
let ambientLight, sunLight;

// ── Engine singletons ─────────────────────────────────────────────────────────

let worldState   = null;
let workerPool   = null;
let chunkManager = null;

// ── Shared materials (reused across all chunk meshes) ─────────────────────────

let opaqueMaterial      = null;
let transparentMaterial = null;

// ── Active mesh map  key → { opaque: Mesh|null, transparent: Mesh|null } ──────

const chunkMeshes = new Map();

// ── Player / camera state ─────────────────────────────────────────────────────

const playerVelocity = { x: 0, y: 0, z: 0 };
const PLAYER_SPEED   = 12;          // blocks/second (run: ×3)
const GRAVITY        = 0;           // 0 = creative / fly mode for now
const CAMERA_HEIGHT  = 1.6;        // eye offset above player.position.y

let   yaw   = 0;    // horizontal camera angle  (radians)
let   pitch = 0;    // vertical camera angle    (radians)
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// ── Input state ───────────────────────────────────────────────────────────────

const KEYS = {};

// ── Initialisation ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');

    // Scene
    scene            = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog        = new THREE.Fog(0x87CEEB, 160, 280);

    // Camera
    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        512,    // far plane — covers 16 chunks of content
    );

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Lighting
    ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xfffaed, 0.90);
    sunLight.position.set(0.6, 1.0, 0.4).normalize();
    scene.add(sunLight);

    // Shared materials
    opaqueMaterial = new THREE.MeshLambertMaterial({
        vertexColors: true,
    });

    transparentMaterial = new THREE.MeshLambertMaterial({
        vertexColors:  true,
        transparent:   true,
        opacity:       0.72,
        side:          THREE.DoubleSide,
        depthWrite:    false,
    });
});

// ── World load event (fired by main.js → startGame) ───────────────────────────

document.addEventListener('WorldJS_startWorldLoad', async (e) => {
    const gamepackData = e.data?.gamepackData ?? {};

    // Build block registry from GamePack
    const registry = buildRegistryFromGamePack(gamepackData);

    // WorldState
    worldState = new WorldState();

    // Worker URL relative to world.js (works with module workers)
    const workerUrl = new URL('./workers/worldWorker.js', import.meta.url);

    // Worker pool (auto-sizes to hardware)
    workerPool = new WorkerPool(workerUrl);

    // Initialise all workers — send seed, block registry, biome data
    await workerPool.init({
        seed:          worldState.seed,
        blockRegistry: registry.serialize(),
        biomes:        gamepackData.biomes ?? [],
    });

    // Chunk manager
    chunkManager = new ChunkManager(worldState, workerPool, 4);

    // Wire render callbacks
    chunkManager.onMeshReady   = _onMeshReady;
    chunkManager.onChunkUnload = _onChunkUnload;

    // Spawn the player above sea level
    me.position = { x: 0, y: 80, z: 0 };
    camera.position.set(0, 80 + CAMERA_HEIGHT, 0);

    console.log('[world] World load complete — seed:', worldState.seed,
        '— workers:', workerPool.workerCount);
});

// ── Quit event ─────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_quitWorld', () => {
    _disposeAll();
    chunkManager = null;
    workerPool?.clearQueue();
    renderer?.dispose();
});

// ── Tick event (called every animation frame from main.js) ─────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);   // seconds, clamped

    _updatePlayer(dt);
    _updateCamera();

    // Derive view direction and movement direction from current camera state
    const viewDir = _horizontalForward();
    const moveDir = _movementDir();

    chunkManager.update(me.position, viewDir, moveDir);

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

// ── Pointer lock (mouse look) ──────────────────────────────────────────────────

document.addEventListener('pointerlockchange', () => {
    // Nothing extra needed — main.js manages pointer lock state.
});

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

function _onMeshReady(cx, cy, cz, geometry) {
    const key = WorldState.key(cx, cy, cz);

    // Remove existing meshes for this chunk first
    _removeMeshes(key);

    const worldX = cx * CHUNK_SIZE;
    const worldY = cy * CHUNK_SIZE;
    const worldZ = cz * CHUNK_SIZE;

    const entry = { opaque: null, transparent: null };

    // Opaque mesh
    if (geometry.positions.length > 0) {
        const geo = _buildGeometry(geometry, false);
        const mesh = new THREE.Mesh(geo, opaqueMaterial);
        mesh.position.set(worldX, worldY, worldZ);
        scene.add(mesh);
        entry.opaque = mesh;
    }

    // Transparent mesh
    if (geometry.transparentPositions.length > 0) {
        const geo = _buildGeometry(geometry, true);
        const mesh = new THREE.Mesh(geo, transparentMaterial);
        mesh.position.set(worldX, worldY, worldZ);
        scene.add(mesh);
        entry.transparent = mesh;
    }

    chunkMeshes.set(key, entry);
}

function _onChunkUnload(key) {
    _removeMeshes(key);
}

// ── Three.js geometry construction ────────────────────────────────────────────

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
    for (const mesh of [entry.opaque, entry.transparent]) {
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
    const fwd  = _horizontalForward();
    const right = { x: fwd.z, z: -fwd.x };    // 90° clockwise
    const speed = (KEYS['ShiftLeft'] || KEYS['ShiftRight']) ? PLAYER_SPEED * 3 : PLAYER_SPEED;

    let dx = 0, dz = 0, dy = 0;

    if (KEYS['KeyW'])     { dx += fwd.x;   dz += fwd.z;   }
    if (KEYS['KeyS'])     { dx -= fwd.x;   dz -= fwd.z;   }
    if (KEYS['KeyA'])     { dx -= right.x; dz -= right.z; }
    if (KEYS['KeyD'])     { dx += right.x; dz += right.z; }
    if (KEYS['Space'])    dy += 1;
    if (KEYS['ControlLeft'] || KEYS['KeyQ']) dy -= 1;

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

    // Build a quaternion from yaw + pitch
    const q = new THREE.Quaternion();
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), yaw));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), pitch));
    camera.quaternion.copy(q);
}

// ── Direction helpers ──────────────────────────────────────────────────────────

function _horizontalForward() {
    return {
        x: -Math.sin(yaw),
        z: -Math.cos(yaw),
    };
}

function _movementDir() {
    let dx = 0, dz = 0;
    const fwd   = _horizontalForward();
    const right = { x: fwd.z, z: -fwd.x };
    if (KEYS['KeyW']) { dx += fwd.x;   dz += fwd.z;   }
    if (KEYS['KeyS']) { dx -= fwd.x;   dz -= fwd.z;   }
    if (KEYS['KeyA']) { dx -= right.x; dz -= right.z; }
    if (KEYS['KeyD']) { dx += right.x; dz += right.z; }
    const len = Math.sqrt(dx*dx + dz*dz);
    return len > 0 ? { x: dx/len, z: dz/len } : { x: 0, z: 0 };
}
