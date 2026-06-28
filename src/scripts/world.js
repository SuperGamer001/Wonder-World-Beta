/**
 * world.js — Render layer + gameplay systems
 *
 * Responsibilities:
 *   • Three.js scene, camera, renderer, lighting
 *   • First-person player controls via PlayerPhysics (AABB, gravity, jump, creative fly)
 *   • Block selection outline + block breaking with tool-speed / hardness
 *   • Right-click: block placement or interactive block UI open
 *   • Survival stats: hunger/energy drain, fall damage, death/respawn
 *   • Attack charge bar, entity hitting
 *   • Water simulation via WaterSimulator
 *   • Mob spawning, AI, and dropped-item pickup via EntityManager
 *   • Crafting via CraftingSystem (opened from interactive blocks)
 *   • Chunk lifecycle via ChunkManager; persistence via WorldClient
 */

import * as THREE from 'three';

import { buildRegistryFromGamePack }         from './engine/BlockRegistry.js';
import { buildItemRegistryFromGamePack }     from './engine/ItemRegistry.js';
import { WorldState }                        from './engine/WorldState.js';
import { WorkerPool }                        from './engine/WorkerPool.js';
import { ChunkManager }                      from './engine/ChunkManager.js';
import { WorldClient }                       from './engine/WorldClient.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, CHUNK_SHIFT } from './engine/ChunkData.js';
import { PlayerPhysics }                     from './engine/PlayerPhysics.js';
import { Inventory }                         from './engine/Inventory.js';
import { raycast }                           from './engine/Raycast.js';
import { WaterSimulator }                    from './engine/WaterSimulator.js';
import { EntityManager }                     from './engine/EntityManager.js';
import { CraftingSystem }                    from './engine/CraftingSystem.js';

const WS_URL       = 'ws://localhost:3000';
const SERVER_URL   = 'http://localhost:3000';
const AUTO_SAVE_MS = 5 * 60 * 1000;
const CAMERA_HEIGHT = 1.6;
const INTERACT_REACH = 4.5;
const SEA_LEVEL    = 64;                              // matches TerrainGenerator
const WORLD_MAX_Y  = WORLD_MIN_Y + CHUNK_SIZE_Y - 1;  // top of the world

// ── Three.js singletons ───────────────────────────────────────────────────────

let scene, camera, renderer;
let ambientLight, sunLight;

// ── Engine singletons ─────────────────────────────────────────────────────────

let worldState   = null;
let workerPool   = null;
let chunkManager = null;
let worldClient  = null;
let _blockReg    = null;
let _itemReg     = null;
let _physics     = null;
let _inventory   = null;
let _water       = null;
let _entities    = null;
let _crafting    = null;
let _autoSaveTimer = null;
let _wasLocked     = false;

// ── Materials ─────────────────────────────────────────────────────────────────

let opaqueMaterial      = null;
let transparentMaterial = null;
let selectionMaterial   = null;
const chunkMeshes = new Map();

// ── Block texture atlas ───────────────────────────────────────────────────────

// Ordered list of PNG paths; index = layer number in the DataArrayTexture
const BLOCK_TEX_LAYERS = [
    'data/textures/blocks/Dirt.png',        // 0
    'data/textures/blocks/Grass.png',       // 1  (grass top)
    'data/textures/blocks/Grass_Side.png',  // 2  (grass side)
    'data/textures/blocks/Stone.png',       // 3
    'data/textures/blocks/Sand.png',        // 4
    'data/textures/blocks/Water.png',       // 5
    'data/textures/blocks/Log_Side.png',    // 6
    'data/textures/blocks/Log_Top.png',     // 7
    'data/textures/blocks/leaves.png',      // 8
    'data/textures/blocks/gravel.png',      // 9
    'data/textures/blocks/Coal_Ore.png',    // 10
    'data/textures/blocks/Iron_Ore.png',    // 11
    'data/textures/blocks/Gold_Ore.png',    // 12
    'data/textures/blocks/snow.png',        // 13
    'data/textures/blocks/Ice.png',         // 14
    'data/textures/blocks/Sandstone.png',   // 15
    'data/textures/blocks/Clay.png',        // 16
    'data/textures/blocks/Bedrock.png',     // 17
    'data/textures/blocks/SnowDirt.png',    // 18
    'data/textures/blocks/Diorite.png',     // 19
    'data/textures/blocks/Granite.png',           // 20
    'data/textures/blocks/Crafting_Table_Top.png', // 21
    'data/textures/blocks/Crafting_Table_Side.png',// 22
    'data/textures/blocks/Oven_Top.png',           // 23
    'data/textures/blocks/Oven_Front.png',         // 24
    'data/textures/blocks/Oven_Side.png',          // 25
    'data/textures/blocks/Smelter_Top.png',        // 26
    'data/textures/blocks/Smelter_Front.png',      // 27
    'data/textures/blocks/Smelter_Side.png',       // 28
    'data/textures/blocks/Chest_Top.png',          // 29
    'data/textures/blocks/Chest_Front.png',        // 30
    'data/textures/blocks/Chest_Side.png',         // 31
    'data/textures/blocks/Anvil.png',              // 32
];

// blockId → { top, side, bottom } texture layer index (-1 = vertex color fallback)
const BLOCK_FACE_MAP = {
    1:  { top: 1,  side: 2,  bottom: 0  },  // GRASS
    2:  { top: 0,  side: 0,  bottom: 0  },  // DIRT
    3:  { top: 3,  side: 3,  bottom: 3  },  // STONE
    4:  { top: 4,  side: 4,  bottom: 4  },  // SAND
    5:  { top: 5,  side: 5,  bottom: 5  },  // WATER
    6:  { top: 7,  side: 6,  bottom: 7  },  // WOOD LOG
    7:  { top: 8,  side: 8,  bottom: 8  },  // LEAVES
    8:  { top: 9,  side: 9,  bottom: 9  },  // GRAVEL
    9:  { top: 10, side: 10, bottom: 10 },  // COAL_ORE
    10: { top: 11, side: 11, bottom: 11 },  // IRON_ORE
    11: { top: 12, side: 12, bottom: 12 },  // GOLD_ORE
    12: { top: 13, side: 13, bottom: 13 },  // SNOW
    13: { top: 14, side: 14, bottom: 14 },  // ICE
    14: { top: 15, side: 15, bottom: 15 },  // SANDSTONE
    15: { top: 16, side: 16, bottom: 16 },  // CLAY
    16: { top: 18, side: 18, bottom: 0  },  // SNOW_DIRT
    17: { top: 20, side: 20, bottom: 20 },  // GRANITE
    18: { top: 19, side: 19, bottom: 19 },  // DIORITE
    19: { top: 17, side: 17, bottom: 17 },  // BEDROCK
    20: { top: 21, side: 22, bottom: 0  },  // CRAFTING_TABLE
    21: { top: 23, side: 25, bottom: 3  },  // OVEN
    22: { top: 26, side: 28, bottom: 3  },  // SMELTER
    23: { top: 29, side: 31, bottom: 31 },  // CHEST
    24: { top: 32, side: 32, bottom: 32 },  // ANVIL
};

// GLSL 300 es shaders (Three.js injects the version + built-in uniforms automatically)
// Three.js automatically injects `position`, `normal`, `uv` before our code,
// so we only declare our custom attributes here.
const CHUNK_VERT = `
in vec3  color;
in float layer;

out vec3  vColor;
out vec2  vUV;
out float vLayer;

void main() {
    vColor  = color;
    vUV     = uv;
    vLayer  = layer;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CHUNK_FRAG = `
precision highp sampler2DArray;
uniform sampler2DArray uTex;

in vec3  vColor;
in vec2  vUV;
in float vLayer;

out vec4 fragColor;

void main() {
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(fract(vUV.x), fract(vUV.y), floor(vLayer + 0.5)));
        if (t.a < 0.1) discard;
        fragColor = vec4(t.rgb * vColor.r, t.a);
    } else {
        fragColor = vec4(vColor, 1.0);
    }
}
`;

const CHUNK_TRANSP_FRAG = `
precision highp sampler2DArray;
uniform sampler2DArray uTex;

in vec3  vColor;
in vec2  vUV;
in float vLayer;

out vec4 fragColor;

void main() {
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(fract(vUV.x), fract(vUV.y), floor(vLayer + 0.5)));
        if (t.a < 0.05) discard;
        fragColor = vec4(t.rgb * vColor.r, t.a * 0.72);
    } else {
        fragColor = vec4(vColor, 0.72);
    }
}
`;

function _loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed: ${url}`));
        img.src = url;
    });
}

async function _buildBlockTextureArray() {
    const SIZE = 16;
    const N    = BLOCK_TEX_LAYERS.length;
    const data = new Uint8Array(N * SIZE * SIZE * 4);
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < N; i++) {
        try {
            const img = await _loadImage(BLOCK_TEX_LAYERS[i]);
            ctx.clearRect(0, 0, SIZE, SIZE);
            ctx.drawImage(img, 0, 0, SIZE, SIZE);
            const imgData = ctx.getImageData(0, 0, SIZE, SIZE).data;
            // DataArrayTexture is uploaded via texImage3D which does NOT auto-flip Y.
            // Canvas data has row 0 at the top; OpenGL expects row 0 at the bottom.
            // Flip here so UV V=0 samples the bottom of the image (standard convention).
            const layerBase = i * SIZE * SIZE * 4;
            for (let row = 0; row < SIZE; row++) {
                const srcStart = (SIZE - 1 - row) * SIZE * 4;
                const dstStart = layerBase + row * SIZE * 4;
                for (let col = 0; col < SIZE * 4; col++) data[dstStart + col] = imgData[srcStart + col];
            }
        } catch {
            console.warn('[world] Missing block texture:', BLOCK_TEX_LAYERS[i]);
        }
    }

    const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, N);
    tex.format     = THREE.RGBAFormat;
    tex.type       = THREE.UnsignedByteType;
    tex.minFilter  = THREE.NearestFilter;
    tex.magFilter  = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function _createChunkMaterials(texArray) {
    const uniforms = { uTex: { value: texArray } };

    opaqueMaterial = new THREE.ShaderMaterial({
        glslVersion:  THREE.GLSL3,
        uniforms,
        vertexShader:   CHUNK_VERT,
        fragmentShader: CHUNK_FRAG,
    });

    transparentMaterial = new THREE.ShaderMaterial({
        glslVersion:  THREE.GLSL3,
        uniforms,
        vertexShader:   CHUNK_VERT,
        fragmentShader: CHUNK_TRANSP_FRAG,
        transparent:  true,
        depthWrite:   false,
        side:         THREE.DoubleSide,
    });
}

// ── Selection + break state ───────────────────────────────────────────────────

let _selMesh     = null;   // THREE.LineSegments for target block outline
let _breakTarget = null;   // { x, y, z, blockId }
let _breakProgress = 0;   // 0..1

// ── Player state ──────────────────────────────────────────────────────────────

let _gameMode    = 'CREATIVE';
let _hotbarSlot  = 0;
let _isDead        = false;
let _damageFade    = 0;     // 0..1, drives vignette
let _attackCharge  = 0;   // 0..1
let _suffocateTimer = 0;   // seconds inside an opaque block
let _eatTimer      = 0;   // 0..EAT_TIME while eating food
let _creativeMineCD = 0;  // seconds remaining before next creative break

// Ground-spawn state. While _spawnPending the player hovers (physics frozen)
// until terrain around the spawn column has generated and a dry, open surface
// is found, then the player is dropped onto it.
let _spawnPending = false;
let _spawnXZ      = { x: 0, z: 0 };
let _spawnStart   = 0;
let _worldSpawn   = null;  // { x, z } — locked the first time a ground spawn resolves

const EAT_TIME = 1.5;       // seconds to hold right-click to consume food
const CREATIVE_MINE_CD = 0.3; // seconds between creative mining breaks

// ── Camera ────────────────────────────────────────────────────────────────────

let yaw   = 0;
let pitch = 0;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
let _bowZoom = false;

const _camQ  = new THREE.Quaternion();
const _camQy = new THREE.Quaternion();
const _camQx = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _camFwd = new THREE.Vector3();

// ── Mouse state ───────────────────────────────────────────────────────────────

const MOUSE = { left: false, right: false };
let _rightJust  = false;
let _bowDrawing = false;
let _bowCharge  = 0;      // 0..1, fills while holding right-click with bow

// ── Keyboard ──────────────────────────────────────────────────────────────────

const KEYS = {};

// ── Initialization ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');

    scene            = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    scene.fog        = new THREE.Fog(0x87CEEB, 160, 280);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 512);

    // preserveDrawingBuffer lets us grab a world screenshot at save time.
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xfffaed, 0.90);
    sunLight.position.set(0.6, 1.0, 0.4).normalize();
    scene.add(sunLight);

    // opaqueMaterial and transparentMaterial are created in startWorldLoad
    // after the block texture atlas is built.
    selectionMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });

    // Selection outline (block highlight box, hidden until targeting a block)
    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    _selMesh = new THREE.LineSegments(boxEdges, selectionMaterial);
    _selMesh.visible = false;
    scene.add(_selMesh);
});

// ── World load event ──────────────────────────────────────────────────────────

document.addEventListener('WorldJS_startWorldLoad', async (e) => {
    const {
        gamepackData = {}, worldId = null, worldSeed = null,
        playerPos = null, gameMode = 'SURVIVAL',
    } = e.data ?? {};

    _gameMode = gameMode;

    // Reset survivals stats to safe defaults; will be overwritten by saved state below.
    me.health = 100;
    me.hunger = 100;
    me.energy = 100;

    _blockReg = buildRegistryFromGamePack(gamepackData);
    _itemReg  = buildItemRegistryFromGamePack(gamepackData);
    _itemToBlock = _buildItemToBlock(gamepackData.blocks ?? []);

    worldState = new WorldState();
    if (worldSeed != null) worldState.seed = worldSeed;

    _physics   = new PlayerPhysics(worldState, _blockReg);
    _inventory = new Inventory(100);
    _inventory.setItemRegistry(_itemReg);

    _water    = new WaterSimulator(worldState, _blockReg);
    _crafting = new CraftingSystem();
    _crafting.loadRecipes(gamepackData.recipes ?? []);

    _entities = new EntityManager(worldState, _blockReg, _itemReg, scene);
    _entities.loadEntityTypes(gamepackData.entities ?? []);
    _entities.setBiomeData(gamepackData.biomes ?? []);

    // Expose inventory on window.me so main.js can read it
    window.me.inventory = _inventory;

    // Build block texture atlas and create shader materials before workers start
    const texArray = await _buildBlockTextureArray();
    _createChunkMaterials(texArray);

    const workerUrl = new URL('./workers/worldWorker.js', import.meta.url);
    workerPool = new WorkerPool(workerUrl);
    await workerPool.init({
        seed:          worldState.seed,
        blockRegistry: _blockReg.serialize(),
        biomes:        gamepackData.biomes ?? [],
        blockFaceMap:  BLOCK_FACE_MAP,
    });

    chunkManager = new ChunkManager(worldState, workerPool, _renderDist);
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
            _autoSaveTimer = setInterval(() => _saveAll(), AUTO_SAVE_MS);
        } catch {
            console.warn('[world] Save server unreachable — world will not be persisted');
            worldClient?.close();   // stop the auto-reconnect loop for this discarded client
            worldClient = null;
        }

        // Load saved player state if available
        try {
            const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/player-state`);
            if (res.ok) {
                const state = await res.json();
                if (state) _applyPlayerState(state);
            }
        } catch { /* server offline */ }
    }

    if (!_physics) return; // guard if quitWorld raced

    // _disposeAll() removes the selection mesh from the scene; re-add it here.
    if (_selMesh && !scene.children.includes(_selMesh)) scene.add(_selMesh);

    const spawnPos = playerPos ?? { x: 0, y: 80, z: 0 };
    _worldSpawn   = null;
    _spawnPending = false;
    _loadGateDone = false;   // re-gate the loading screen for this world
    if (me.position && me.position.fromSave) {
        // Returning player — keep their saved position.
        me.position = { x: me.position.x, y: me.position.y, z: me.position.z };
    } else {
        // Fresh spawn — drop onto the ground once terrain loads.
        _beginGroundSpawn(spawnPos.x, spawnPos.z);
    }
    camera.position.set(me.position.x, me.position.y + CAMERA_HEIGHT, me.position.z);
    camera.rotation.set(0, 0, 0);

    _isDead         = false;
    _damageFade     = 0;
    _attackCharge   = 0;
    _suffocateTimer = 0;
    _eatTimer       = 0;

    // Persistence + spawn position are now established. Release the generation gate
    // so the render loop's chunk dispatches load saved edits from disk (rather than
    // regenerating fresh terrain over the player's build during the connect window).
    chunkManager.ready = true;

    console.log('[world] Loaded — seed:', worldState.seed, '— mode:', _gameMode,
                '— workers:', workerPool.workerCount);
});

function _applyPlayerState(state) {
    if (state.position) {
        me.position = { ...state.position, fromSave: true };
    }
    if (state.rotation) {
        yaw   = state.rotation.yaw   ?? 0;
        pitch = state.rotation.pitch ?? 0;
    }
    if (state.health   != null) me.health   = state.health;
    if (state.hunger   != null) me.hunger   = state.hunger;
    if (state.energy   != null) me.energy   = state.energy;
    if (state.inventory && _inventory) _inventory.fromJSON(state.inventory);
}

// ── Quit event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_quitWorld', () => {
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;

    const client = worldClient;   // capture before nulling so we can flush + close it
    _saveAll();                   // queues the final chunk save onto the socket
    _savePlayerState();
    _disposeAll();

    chunkManager = null;
    worldClient  = null;
    // Let the queued save drain, THEN close the socket — closing immediately would
    // drop the player's final edits.
    if (client) _flushAndCloseClient(client);
    // Fully terminate the worker pool — clearQueue() alone leaves the workers
    // alive. Without this, the next world spins up a second pool while the old
    // one keeps running with the previous world's seed.
    workerPool?.terminate();
    workerPool = null;
    worldState = null;
    // Do NOT call renderer.dispose() — it destroys the WebGL context and makes
    // the renderer unusable for the next world load in the same session.
    _blockReg = _itemReg = _physics = _inventory = _water = _entities = _crafting = null;
});

// ── Tick event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    // While the loading screen is up, report how much of the area around the
    // player has finished meshing so main.js can gate the reveal + drive the bar.
    if (!_loadGateDone) _reportLoadGate();

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) { _saveAll(); _savePlayerState(); }
    _wasLocked = isLocked;

    if (_isDead) { renderer.render(scene, camera); return; }

    // Waiting for a ground spawn: keep loading terrain around the spawn column and
    // hold the player frozen above it until a surface is found.
    if (_spawnPending) {
        _tryGroundSpawn();
        _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
        _updateCamera();
        chunkManager.update(me.position, _camFwd, { x: 0, z: 0 });
        _updateHUD();
        renderer.render(scene, camera);
        return;
    }

    // Build input object for physics. Movement keys are only honoured while the
    // pointer is locked to the game — when paused or in a menu the character
    // must not respond to WASD / Space.
    const controlsActive = document.pointerLockElement === document.getElementById('GameScreen');
    const fwd      = _horizontalForward();
    const rightDir = { x: fwd.z, z: -fwd.x };
    const input = {
        forward:  controlsActive && !!KEYS['KeyW'],
        backward: controlsActive && !!KEYS['KeyS'],
        left:     controlsActive && !!KEYS['KeyA'],
        right:    controlsActive && !!KEYS['KeyD'],
        jump:     controlsActive && !!KEYS['Space'],
        sneak:    controlsActive && (!!KEYS['ControlLeft'] || !!KEYS['KeyQ']),
        sprint:   controlsActive && !!KEYS['ShiftLeft'],
        fwd,
        rightDir,
    };

    const result = _physics.update(me.position, input, dt, _gameMode, {
        hunger: me.hunger, energy: me.energy,
    });

    if (result.fallDamage > 0) _applyDamage(result.fallDamage);
    if (result.fellIntoVoid)   _applyDamage(20);

    if (_gameMode === 'SURVIVAL') _survivalTick(dt);

    _checkSuffocation(dt);
    _water.tick(dt, (cx, cz) => chunkManager?.markDirty(cx, cz));
    _entities.update(dt, me.position, _inventory, _gameMode);

    // Raycast for block targeting
    _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    const origin = { x: me.position.x, y: me.position.y + CAMERA_HEIGHT, z: me.position.z };
    const hit    = raycast(worldState, _blockReg, origin, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, INTERACT_REACH);

    // Mob targeting — check before block so mobs in front of walls are hit correctly
    const mobHit = _entities?.getClosestMobInRay(origin, _camFwd, INTERACT_REACH) ?? null;

    // Bow draw start / zoom — must run before placement so the bow has first
    // priority on _rightJust (placement would otherwise always consume it).
    const isBowSelected = _bowItemSelected();
    if (!isBowSelected && _bowDrawing) { _bowDrawing = false; _bowCharge = 0; }
    if (_rightJust && isBowSelected) { _bowDrawing = true; _bowCharge = 0; _rightJust = false; }
    if (_bowDrawing) _handleBowDraw(dt);
    _bowZoom = _bowDrawing;

    // Block breaking only when no mob is targeted. If the head is buried inside a
    // mineable block, dig that block out first (lets you escape being stuck).
    const headHit = _mineableHeadBlock();
    _handleBreaking(dt, mobHit ? null : (headHit ?? hit));
    _handlePlacement(hit);
    _handleEating(dt);
    _handleAttackCharge(dt, mobHit, mobHit ? null : hit);

    // Selection outline: mob outline overrides block outline
    if (mobHit) {
        _updateMobOutline(mobHit.mob);
    } else if (hit) {
        _updateSelectionOutline(hit);
    } else if (_selMesh) {
        _selMesh.visible = false;
    }

    _updateCamera();
    chunkManager.update(me.position, _camFwd, { x: fwd.x, z: fwd.z });
    _updateHUD();

    // Fade vignette
    if (_damageFade > 0) _damageFade = Math.max(0, _damageFade - dt * 1.5);

    renderer.render(scene, camera);
});

// ── Resize ────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Pointer lock ──────────────────────────────────────────────────────────────

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== document.getElementById('GameScreen')) return;
    const sensitivity = 0.0018 * _sensMult;
    yaw   -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity * (_invertY ? -1 : 1);
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
});

// Player display/control settings pushed from main.js (cosmetic + control only).
let _sensMult  = 1.0;
let _invertY   = false;
let _baseFov   = 75;
let _renderDist = 12;
document.addEventListener('WorldJS_applySettings', (e) => {
    const s = e.data ?? {};
    if (s.sensitivity != null) _sensMult = s.sensitivity;
    if (s.invertY     != null) _invertY  = !!s.invertY;
    if (s.fov         != null) _baseFov  = s.fov;
    if (s.renderDistance != null) {
        _renderDist = s.renderDistance;
        if (chunkManager) chunkManager.renderDistance = _renderDist;
    }
});

document.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== document.getElementById('GameScreen')) return;
    if (e.button === 0) MOUSE.left  = true;
    if (e.button === 2) { MOUSE.right = true; _rightJust = true; }
});

document.addEventListener('mouseup', (e) => {
    if (e.button === 0) { MOUSE.left = false; _breakTarget = null; _breakProgress = 0; }
    if (e.button === 2) {
        MOUSE.right = false;
        if (_bowDrawing) _fireBow();
        _bowDrawing = false;
        _bowCharge  = 0;
    }
});

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    KEYS[e.code] = true;
    // Hotbar number keys (1–0 for slots 0–9)
    const digit = e.code.match(/^Digit(\d)$/);
    if (digit) {
        const n = parseInt(digit[1]);
        _hotbarSlot = n === 0 ? 9 : n - 1;
        window.dispatchEvent(new CustomEvent('ww_hotbarChange', { detail: { slot: _hotbarSlot } }));
    }
    // Inventory toggle
    if (e.code === 'KeyE' && document.pointerLockElement === document.getElementById('GameScreen')) {
        window.dispatchEvent(new CustomEvent('ww_toggleInventory'));
    }
    // Craft menu / creative inventory
    if (e.code === 'KeyC' && document.pointerLockElement === document.getElementById('GameScreen')) {
        window.dispatchEvent(new CustomEvent('ww_toggleCraftMenu', { detail: { gameMode: _gameMode } }));
    }
});

document.addEventListener('keyup', (e) => { KEYS[e.code] = false; });

// ── Block / mob selection outlines ───────────────────────────────────────────

function _updateSelectionOutline(hit) {
    if (!hit || !_selMesh) return;
    _selMesh.visible = true;
    _selMesh.scale.set(1, 1, 1);
    _selMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    selectionMaterial.color.setRGB(0, 0, 0);   // reset from any mob tint
}

function _updateMobOutline(mob) {
    if (!_selMesh) return;
    const w = (mob.def.width  ?? 0.8) + 0.1;
    const h = (mob.def.height ?? 1.4) + 0.1;
    _selMesh.visible = true;
    _selMesh.scale.set(w, h, w * 0.7);   // 0.7 matches body depth ratio
    _selMesh.position.set(mob.pos.x, mob.pos.y + h / 2, mob.pos.z);
    selectionMaterial.color.setRGB(1, 0.4, 0.4);   // reddish tint for mobs
}

// ── Block breaking ────────────────────────────────────────────────────────────

function _handleBreaking(dt, hit) {
    // Count down the creative mining cooldown regardless of target state.
    if (_creativeMineCD > 0) _creativeMineCD = Math.max(0, _creativeMineCD - dt);

    if (!MOUSE.left || !hit) {
        if (_breakTarget) {
            _breakTarget   = null;
            _breakProgress = 0;
            if (_selMesh) selectionMaterial.color.setRGB(0, 0, 0);
        }
        return;
    }

    // Reset if targeting a different block
    if (!_breakTarget || _breakTarget.x !== hit.x || _breakTarget.y !== hit.y || _breakTarget.z !== hit.z) {
        _breakTarget   = { x: hit.x, y: hit.y, z: hit.z, blockId: hit.blockId };
        _breakProgress = 0;
    }

    // Creative: fast break with a short cooldown so holding the button doesn't
    // clear blocks every single frame.
    if (_gameMode === 'CREATIVE') {
        if (_creativeMineCD > 0) return;
        _breakBlock(hit);
        _creativeMineCD = CREATIVE_MINE_CD;
        _breakTarget   = null;
        _breakProgress = 0;
        return;
    }

    const block      = _blockReg.get(hit.blockId);
    const hardness   = block.hardness ?? 1.0;
    const hotbarItem = _inventory?.getHotbar(_hotbarSlot);
    const heldDef    = hotbarItem ? (_itemReg?.getItem(hotbarItem.itemId) ?? null) : null;

    // Check tool requirement: blocks marked requiresTool need the right tool subtype
    const needsTool   = block.requiresTool ?? null;
    const hasCorrectTool = needsTool
        ? (heldDef?.subtype === needsTool)
        : true;   // no tool required — bare hand is fine

    let miningSpeed = heldDef?.miningSpeed ?? 1.0;
    if (needsTool && !hasCorrectTool) miningSpeed = 0.3;  // penalty for wrong/no tool

    _breakProgress += dt * miningSpeed / Math.max(hardness, 0.05);

    // Tint selection outline whiter as block breaks
    if (_selMesh) {
        const fade = 0.3 + _breakProgress * 0.7;
        selectionMaterial.color.setRGB(fade, fade, fade);
    }

    if (_breakProgress >= 1.0) {
        _breakBlock(hit, hasCorrectTool);
        _breakTarget   = null;
        _breakProgress = 0;
        if (_selMesh) selectionMaterial.color.setRGB(0, 0, 0);
    }
}

function _breakBlock(hit, hasCorrectTool = true) {
    if (!worldState || !chunkManager) return;
    const block = _blockReg.get(hit.blockId);
    worldState.setBlock(hit.x, hit.y, hit.z, 0);
    chunkManager.markDirty(hit.x >> CHUNK_SHIFT, hit.z >> CHUNK_SHIFT);

    // Creative players don't collect broken blocks.
    if (_gameMode === 'CREATIVE') return;

    // Blocks with requiresTool drop nothing if broken with the wrong tool
    if (block.requiresTool && !hasCorrectTool) return;

    // Drop items
    const dropPos = { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 };
    if (block.drops && block.drops.length > 0) {
        for (const drop of block.drops) {
            if (Math.random() > (drop.chance ?? 1)) continue;
            const itemId = drop.itemId ?? drop.item;
            if (!itemId) continue;
            const n = drop.count ?? 1;
            const overflow = (_inventory?.addItem(itemId, n)) ?? n;
            if (overflow > 0) _entities?.dropItem(dropPos, itemId, overflow);
        }
    } else {
        // Default: drop item with same name as block (lowercased)
        const itemId = block.name.toLowerCase();
        if (_itemReg?.hasItem(itemId)) {
            const overflow = (_inventory?.addItem(itemId, 1)) ?? 1;
            if (overflow > 0) _entities?.dropItem(dropPos, itemId, overflow);
        }
    }

    // Refresh the hotbar so collected blocks / updated stack counts show up.
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));
}

// ── Block placement / interaction ─────────────────────────────────────────────

function _handlePlacement(hit) {
    if (!_rightJust) return;
    _rightJust = false;
    if (!hit) return;

    // Interactive block: open UI instead of placing
    if (_blockReg.isInteractable(hit.blockId)) {
        const block = _blockReg.get(hit.blockId);
        window.dispatchEvent(new CustomEvent('ww_openInteractive', {
            detail: { interactType: block.interactType, x: hit.x, y: hit.y, z: hit.z },
        }));
        return;
    }

    // Place block from selected hotbar slot
    if (!_inventory) return;
    const held = _inventory.getHotbar(_hotbarSlot);
    if (!held) return;

    const itemDef = _itemReg?.getItem(held.itemId);
    // Food is consumed via hold — don't place anything on right-press
    if (itemDef?.type === 'food') return;

    // Resolve which block this item places (by block name, then reverse of the
    // block's drop list). Returns null for non-block items (tools, ingots, …).
    const blockDef = _itemToBlock.get(held.itemId);
    if (!blockDef) return;

    const px = hit.x + hit.face.x;
    const py = hit.y + hit.face.y;
    const pz = hit.z + hit.face.z;

    // Don't place inside player
    const pw = 0.3;
    if (Math.abs(px + 0.5 - me.position.x) < pw &&
        py + 1 > me.position.y && py < me.position.y + 1.8 &&
        Math.abs(pz + 0.5 - me.position.z) < pw) return;

    worldState.setBlock(px, py, pz, blockDef.id);
    chunkManager?.markDirty(px >> CHUNK_SHIFT, pz >> CHUNK_SHIFT);

    // Trigger water simulation if placing water
    if (blockDef.id === 5) _water?.addSource(px, py, pz);

    if (_gameMode !== 'CREATIVE') {
        _inventory.removeItem(held.itemId, 1);
        window.dispatchEvent(new CustomEvent('ww_itemPickup'));
    }
}

// item id → block def. Built once per world load from the block list: a block's
// own lowercased name maps to it, and (unless already mapped) each item the
// block drops maps back to it — so e.g. "coal" places COAL_ORE, "wood_log"
// places WOOD, "clay_ball" places CLAY.
let _itemToBlock = new Map();

function _buildItemToBlock(blocks) {
    const map = new Map();
    // Pass 1: canonical name match (gives "dirt" → DIRT even though GRASS drops dirt).
    for (const b of blocks) {
        const def = _blockReg.getByName(b.name);
        if (def) map.set(b.name.toLowerCase(), def);
    }
    // Pass 2: reverse drops, without overriding a canonical name mapping.
    for (const b of blocks) {
        const def = _blockReg.getByName(b.name);
        if (!def) continue;
        for (const drop of (b.drops ?? [])) {
            const id = drop.itemId ?? drop.item;
            if (id && !map.has(id)) map.set(id, def);
        }
    }
    return map;
}

// ── Attack charge ─────────────────────────────────────────────────────────────

function _handleAttackCharge(dt, mobHit, hit) {
    const held  = _inventory?.getHotbar(_hotbarSlot);
    const def   = held ? _itemReg?.getItem(held.itemId) : null;
    const speed = def?.attackChargeSpeed ?? 1.5;

    if (MOUSE.left && mobHit) {
        // Directly targeting a mob — attack it
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            _entities?.hitNearest(
                { x: mobHit.mob.pos.x, y: mobHit.mob.pos.y + 0.7, z: mobHit.mob.pos.z },
                dmg, 2
            );
        }
        _attackCharge = 0;
    } else if (MOUSE.left && !hit) {
        // Swinging at air — try nearby mobs with wider radius
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            _entities?.hitNearest(
                { x: me.position.x + _camFwd.x * 2.5, y: me.position.y + 1, z: me.position.z + _camFwd.z * 2.5 },
                dmg, 3
            );
        }
        _attackCharge = 0;
    } else {
        _attackCharge = Math.min(1, _attackCharge + dt * speed);
    }
}

// ── Food eating ───────────────────────────────────────────────────────────────

function _handleEating(dt) {
    if (!MOUSE.right) { _eatTimer = 0; return; }
    const held = _inventory?.getHotbar(_hotbarSlot);
    if (!held) { _eatTimer = 0; return; }
    const itemDef = _itemReg?.getItem(held.itemId);
    if (itemDef?.type !== 'food') { _eatTimer = 0; return; }
    // Don't eat if hunger is full and item provides no health
    if (me.hunger >= 100 && !itemDef.healthRestore) { _eatTimer = 0; return; }

    _eatTimer += dt;
    if (_eatTimer >= EAT_TIME) {
        _eatTimer = 0;
        me.hunger = Math.min(100, me.hunger + (itemDef.hungerRestore ?? 0));
        me.energy = Math.min(100, me.energy + (itemDef.energyRestore ?? 0));
        if (itemDef.healthRestore) me.health = Math.min(100, me.health + itemDef.healthRestore);
        _inventory.removeItem(held.itemId, 1);
        window.dispatchEvent(new CustomEvent('ww_itemPickup'));
    }
}

// ── Bow mechanics ─────────────────────────────────────────────────────────────

function _bowItemSelected() {
    const held = _inventory?.getHotbar(_hotbarSlot);
    return held && held.itemId === 'bow';
}

function _handleBowDraw(dt) {
    if (!_bowDrawing) return;
    _bowCharge = Math.min(1, _bowCharge + dt * 0.8);
}

function _fireBow() {
    if (!_inventory || !_entities) return;
    // Creative: arrows are free and not required. Survival: must have an arrow.
    if (_gameMode !== 'CREATIVE') {
        const arrowSource = _inventory.takeArrow();
        if (!arrowSource) return;
        window.dispatchEvent(new CustomEvent('ww_itemPickup'));
    }

    const speed    = 20 + _bowCharge * 30;
    const dmg      = 3 + _bowCharge * 9;
    const shootPos = { x: me.position.x + _camFwd.x * 0.5, y: me.position.y + 1.2, z: me.position.z + _camFwd.z * 0.5 };
    // For now: immediate raycast hit (no projectile physics yet)
    const arrowHit = raycast(worldState, _blockReg, shootPos, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, 40);
    if (arrowHit) {
        _entities.hitNearest(
            { x: arrowHit.x, y: arrowHit.y, z: arrowHit.z }, dmg, 2
        );
    }
}

// ── Survival tick ─────────────────────────────────────────────────────────────

function _survivalTick(dt) {
    // Hunger / energy drain
    me.hunger = Math.max(0, me.hunger - 0.025 * dt);
    me.energy = Math.max(0, me.energy - 0.015 * dt);
    if (_physics?.vel && Math.abs(_physics.vel.x) + Math.abs(_physics.vel.z) > 6) {
        me.energy = Math.max(0, me.energy - 0.04 * dt);
    }

    // Passive regen when well-fed
    if (me.hunger > 80 && me.health < 100) me.health = Math.min(100, me.health + 0.2 * dt);

    // Starvation damage (never kills, bottoms at 1)
    if (me.hunger <= 0 && me.health > 1) me.health = Math.max(1, me.health - 1 * dt);

    if (me.health <= 0 && !_isDead) _handleDeath();
}

// Returns a break target for the block the player's head is inside, but only when
// it's actually mineable (solid, opaque, non-liquid). Leaves (transparent) and
// water (liquid) are excluded, so mining falls back to the normal raycast there.
function _mineableHeadBlock() {
    if (!worldState || _gameMode === 'SPECTATOR') return null;
    const hx = Math.floor(me.position.x);
    const hy = Math.floor(me.position.y + CAMERA_HEIGHT);
    const hz = Math.floor(me.position.z);
    const id = worldState.getBlock(hx, hy, hz);
    if (id <= 0) return null;
    if (_blockReg.isTransparent(id) || _blockReg.isLiquid(id)) return null;
    return { x: hx, y: hy, z: hz, blockId: id, face: { x: 0, y: 1, z: 0 } };
}

// ── Suffocation ───────────────────────────────────────────────────────────────

function _checkSuffocation(dt) {
    const overlayEl = document.getElementById('suffocateOverlay');

    // Spectators pass through blocks — never show the overlay or take damage.
    if (_gameMode === 'SPECTATOR') {
        _suffocateTimer = 0;
        if (overlayEl) overlayEl.classList.add('hidden');
        return;
    }

    const camX = Math.floor(me.position.x);
    const camY = Math.floor(me.position.y + CAMERA_HEIGHT);
    const camZ = Math.floor(me.position.z);
    const headId = worldState?.getBlock(camX, camY, camZ) ?? 0;

    const inSolid = headId > 0 && !_blockReg?.isTransparent(headId) && !_blockReg?.isLiquid(headId);

    if (inSolid) {
        if (overlayEl) {
            const layer = BLOCK_FACE_MAP[headId]?.side ?? BLOCK_FACE_MAP[headId]?.top;
            const path  = layer != null ? BLOCK_TEX_LAYERS[layer] : null;
            // Fully opaque texture fill of the block the head is inside.
            overlayEl.style.backgroundImage = path
                ? `url('${path}')`
                : `linear-gradient(${_blockColorCss(headId)}, ${_blockColorCss(headId)})`;
            overlayEl.classList.remove('hidden');
        }
        if (_gameMode === 'SURVIVAL') {
            _suffocateTimer += dt;
            if (_suffocateTimer >= 1.0) {
                _applyDamage(2);
                _suffocateTimer -= 1.0;
            }
        }
    } else {
        _suffocateTimer = 0;
        if (overlayEl) overlayEl.classList.add('hidden');
    }
}

// CSS rgb() string for a block's base colour (fallback when no texture exists).
function _blockColorCss(id) {
    const def = _blockReg.get(id);
    const [r, g, b] = def?.color ?? [0.1, 0.1, 0.1];
    return `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`;
}

// ── Damage + death ────────────────────────────────────────────────────────────

function _applyDamage(amount) {
    if (_isDead || _gameMode === 'CREATIVE' || _gameMode === 'SPECTATOR') return;
    const prot = (_inventory?.totalProtection ?? 0) / 100;
    const actual = Math.max(0, amount * (1 - prot));
    me.health = Math.max(0, me.health - actual);
    _damageFade = Math.min(1, _damageFade + actual / 20);
    if (me.health <= 0) _handleDeath();
    window.dispatchEvent(new CustomEvent('ww_damage', { detail: { amount: actual } }));
}

// ── Initial-load gate ───────────────────────────────────────────────────────
// Reports meshing progress around the player during the loading screen. "Ready"
// means the player's own chunk is rendered and at least 75% of the nearby chunks
// have meshed, so the world is presentable.
let _loadGateDone = false;

function _reportLoadGate() {
    const pcx = Math.floor(me.position.x) >> CHUNK_SHIFT;
    const pcz = Math.floor(me.position.z) >> CHUNK_SHIFT;
    const R   = Math.min(_renderDist, 4);

    let total = 0, meshed = 0;
    for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
            if (dx * dx + dz * dz > R * R + R) continue;   // roughly circular
            total++;
            if (worldState.getChunk(pcx + dx, pcz + dz)?.meshed) meshed++;
        }
    }

    const centerReady = !!worldState.getChunk(pcx, pcz)?.meshed;
    const progress    = total ? meshed / total : 0;
    const ready       = !_spawnPending && centerReady && progress >= 0.75;

    window.dispatchEvent(new CustomEvent('ww_loadProgress', { detail: { progress, ready } }));
    if (ready) _loadGateDone = true;
}

// ── Ground spawn ────────────────────────────────────────────────────────────

// Park the player above the spawn column and resolve a ground position once the
// terrain there has generated. Used on first spawn and on respawn so the player
// never appears in the air, in water, or buried in a hill.
function _beginGroundSpawn(x, z) {
    _spawnXZ      = { x, z };
    _spawnPending = true;
    _spawnStart   = performance.now();
    me.position   = { x: x + 0.5, y: SEA_LEVEL + 96, z: z + 0.5 };
    if (_physics?.vel) _physics.vel = { x: 0, y: 0, z: 0 };
}

// Y of the topmost solid (opaque, non-liquid) block in a generated column, or null.
function _columnGround(wx, wz) {
    const chunk = worldState.getChunk(wx >> CHUNK_SHIFT, wz >> CHUNK_SHIFT);
    if (!chunk?.generated) return null;
    for (let y = WORLD_MAX_Y; y > WORLD_MIN_Y; y--) {
        const id = worldState.getBlock(wx, y, wz);
        if (id !== 0 && _blockReg.isSolid(id)) return y;
    }
    return null;
}

function _tryGroundSpawn() {
    const sx = Math.floor(_spawnXZ.x);
    const sz = Math.floor(_spawnXZ.z);

    // Search outward in rings for the nearest column whose surface is open to the
    // sky (air directly above) — this skips ocean (water above seabed) and trees
    // (leaves above the trunk).
    const R = 24;
    for (let r = 0; r <= R; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;  // ring perimeter
                const wx = sx + dx, wz = sz + dz;
                const gy = _columnGround(wx, wz);
                if (gy === null) continue;
                if (worldState.getBlock(wx, gy + 1, wz) !== 0) continue;   // water/leaves above
                _finishGroundSpawn(wx + 0.5, gy + 1, wz + 0.5);
                return;
            }
        }
    }

    // Fallback: if nothing open turned up within a few seconds, drop onto whatever
    // ground exists at the spawn column (even if it's a shallow shore).
    if (performance.now() - _spawnStart > 6000) {
        const gy = _columnGround(sx, sz);
        if (gy !== null) _finishGroundSpawn(sx + 0.5, gy + 1, sz + 0.5);
    }
}

function _finishGroundSpawn(x, y, z) {
    me.position = { x, y, z };
    if (_physics?.vel) _physics.vel = { x: 0, y: 0, z: 0 };
    if (!_worldSpawn) _worldSpawn = { x: Math.floor(x), z: Math.floor(z) };  // lock world spawn
    _spawnPending = false;
}

function _handleDeath() {
    if (_isDead) return;
    _isDead = true;
    if (_entities) _entities.spawnDeathPack({ ...me.position }, _inventory);
    window.dispatchEvent(new CustomEvent('ww_playerDied'));
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));   // inventory was emptied
}

window.addEventListener('ww_mobAttack', (e) => {
    _applyDamage(e.detail?.damage ?? 4);
});

document.addEventListener('WorldJS_setGameMode', (e) => {
    const mode = e.data?.gameMode;
    if (mode && ['SURVIVAL','CREATIVE','SPECTATOR'].includes(mode)) {
        _gameMode = mode;
        if (_physics) { _physics.flying = false; _physics.vel = { x:0, y:0, z:0 }; }
        window.dispatchEvent(new CustomEvent('ww_gameModeChange', { detail: { gameMode: mode } }));
    }
});

document.addEventListener('WorldJS_respawn', () => {
    if (!_isDead) return;
    _isDead      = false;
    _damageFade  = 0;
    me.health    = 100;
    me.hunger    = 80;
    me.energy    = 80;
    _physics.vel = { x: 0, y: 0, z: 0 };
    // Respawn on the ground at the world spawn point.
    _beginGroundSpawn(_worldSpawn?.x ?? 0, _worldSpawn?.z ?? 0);
    if (_inventory) {
        _inventory.slots    = [];
        _inventory.hotbar   = new Array(10).fill(null);
        _inventory.offhand  = null;
        _inventory.equipment = { head:null,chest:null,legs:null,feet:null,ears:null,hands:null,arms:null,quiver:null };
        _inventory.quiverArrows = 0;
    }
    window.dispatchEvent(new CustomEvent('ww_respawned'));
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));   // hotbar cleared
});

// ── HUD updates ───────────────────────────────────────────────────────────────

function _updateHUD() {
    // Player coordinates — top-right, shown in every game mode.
    const coordEl = document.getElementById('playerCoords');
    if (coordEl) {
        coordEl.textContent =
            `X: ${Math.round(me.position.x)}  Y: ${Math.round(me.position.y)}  Z: ${Math.round(me.position.z)}`;
    }

    // Game-mode gating: hide survival stats in Creative/Spectator
    const showStats = _gameMode === 'SURVIVAL';
    const infoEl = document.getElementById('playerInfo');
    if (infoEl) infoEl.classList.toggle('hidden', !showStats);

    if (showStats) {
        _setInnerHTML('playerHealth', `<img src="./data/textures/UI/Heart.png" width="25"> Health: ${Math.ceil(me.health)} / 100`);
        _setInnerHTML('playerHunger', `<img src="./data/textures/UI/Bread.png" width="25"> Hunger: ${Math.ceil(me.hunger)} / 100`);
        _setInnerHTML('playerEnergy', `<img src="./data/textures/UI/Energy1.png" width="25"> Energy: ${Math.ceil(me.energy)} / 100`);
    }

    const protEl = document.getElementById('playerProtection');
    if (protEl) {
        const hasArmor = _inventory?.hasAnyArmor ?? false;
        protEl.classList.toggle('hidden', !hasArmor);
        if (hasArmor) protEl.textContent = `Protection: ${Math.round(_inventory.totalProtection)}%`;
    }

    const arrowEl = document.getElementById('playerArrows');
    if (arrowEl) {
        const hasQuiver = _inventory?.hasQuiver ?? false;
        arrowEl.classList.toggle('hidden', !hasQuiver);
        if (hasQuiver) arrowEl.textContent = `Arrows: ${_inventory.quiverArrows}`;
    }

    // Attack charge bar
    const barEl = document.getElementById('attackChargeFill');
    if (barEl) barEl.style.width = `${Math.round(_attackCharge * 100)}%`;

    // Mining progress bar — visible while breaking a block in survival
    const mineWrap = document.getElementById('mineProgressBar');
    const mineFill = document.getElementById('mineProgressFill');
    if (mineWrap && mineFill) {
        const mining = _breakProgress > 0 && _breakTarget !== null && _gameMode !== 'CREATIVE';
        mineWrap.style.display = mining ? 'block' : 'none';
        mineFill.style.width = `${Math.round(_breakProgress * 100)}%`;
    }

    // Eating progress bar — visible while consuming food
    const eatWrap = document.getElementById('eatProgressBar');
    const eatFill = document.getElementById('eatProgressFill');
    if (eatWrap && eatFill) {
        const eating = _eatTimer > 0;
        eatWrap.style.display = eating ? 'block' : 'none';
        eatFill.style.width = `${Math.round((_eatTimer / EAT_TIME) * 100)}%`;
    }

    // Damage vignette
    const vig = document.getElementById('damageVignette');
    if (vig) vig.style.opacity = String(_damageFade.toFixed(3));

    // Action lines: flash when freshly damaged
    const lines = document.getElementById('actionLines');
    if (lines) lines.classList.toggle('flash', _damageFade > 0.7);
}

function _setInnerHTML(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

// ── Camera + view ─────────────────────────────────────────────────────────────

function _updateCamera() {
    camera.position.set(me.position.x, me.position.y + CAMERA_HEIGHT, me.position.z);

    _camQ.identity();
    _camQ.multiply(_camQy.setFromAxisAngle(_axisY, yaw));
    _camQ.multiply(_camQx.setFromAxisAngle(_axisX, pitch));
    camera.quaternion.copy(_camQ);

    const targetFov = _bowZoom ? Math.min(30, _baseFov - 10) : _baseFov;
    camera.fov += (targetFov - camera.fov) * 0.2;
    camera.updateProjectionMatrix();
}

// ── Mesh callbacks ─────────────────────────────────────────────────────────────

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

function _onPartialMeshReady(cx, cz, xzGeo) {
    const key   = WorldState.key(cx, cz);
    const entry = chunkMeshes.get(key);
    if (!entry) return;
    const worldX = cx * CHUNK_SIZE;
    const worldZ = cz * CHUNK_SIZE;
    for (const m of [entry.opaqueXZ, entry.transpXZ]) {
        if (!m) continue;
        scene.remove(m);
        m.geometry.dispose();
    }
    entry.opaqueXZ = null;
    entry.transpXZ = null;
    _attachGeo(entry, xzGeo, worldX, worldZ, 'XZ');
}

function _onChunkUnload(key) { _removeMeshes(key); }

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
    const buf  = new THREE.BufferGeometry();
    const pos  = transparent ? geo.transparentPositions : geo.positions;
    const norm = transparent ? geo.transparentNormals   : geo.normals;
    const col  = transparent ? geo.transparentColors    : geo.colors;
    const idx  = transparent ? geo.transparentIndices   : geo.indices;
    const uvs  = transparent ? geo.transparentUVs       : geo.uvs;
    const lay  = transparent ? geo.transparentLayers    : geo.layers;
    buf.setAttribute('position', new THREE.BufferAttribute(pos,  3));
    buf.setAttribute('normal',   new THREE.BufferAttribute(norm, 3));
    buf.setAttribute('color',    new THREE.BufferAttribute(col,  3));
    buf.setAttribute('uv',       new THREE.BufferAttribute(uvs,  2));
    buf.setAttribute('layer',    new THREE.BufferAttribute(lay,  1));
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
    if (_selMesh) { scene.remove(_selMesh); }
    opaqueMaterial?.dispose();
    transparentMaterial?.dispose();
    opaqueMaterial = null;
    transparentMaterial = null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _saveAll() {
    if (!(chunkManager?.worldId && worldClient?.connected)) return;

    const client = worldClient;   // capture — quitWorld may null worldClient mid-save
    window.dispatchEvent(new CustomEvent('ww_saving', { detail: { active: true } }));

    chunkManager.saveAll();   // queues the batch onto the WebSocket send buffer
    _saveScreenshot(chunkManager.worldId);

    // Hide the indicator once the data has actually left the socket (buffer
    // drained), with a minimum visible time so fast saves still register, and a
    // hard timeout so a stalled socket never leaves the sign stuck on.
    const start = performance.now();
    const MIN_VISIBLE = 500;   // ms
    const MAX_WAIT    = 6000;  // ms
    const finish = () => window.dispatchEvent(new CustomEvent('ww_saving', { detail: { active: false } }));
    const poll = () => {
        const elapsed = performance.now() - start;
        const drained = !client.connected || client.bufferedAmount === 0;
        if ((drained && elapsed >= MIN_VISIBLE) || elapsed >= MAX_WAIT) { finish(); return; }
        setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
}

// Wait for a WorldClient's send buffer to drain, then close it. Used on quit so
// the final batch of edits actually reaches the server before we disconnect.
function _flushAndCloseClient(client) {
    const start = performance.now();
    const poll = () => {
        if (!client.connected || client.bufferedAmount === 0 || performance.now() - start > 5000) {
            client.close();
            return;
        }
        setTimeout(poll, 100);
    };
    poll();
}

// Grab the current frame, downscale it, and upload it as the world's thumbnail.
function _saveScreenshot(worldId) {
    if (!renderer || !worldId) return;
    try {
        const src = renderer.domElement;
        const w = 320;
        const h = Math.max(1, Math.round(w * (src.height / src.width)));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(src, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', 0.6);
        fetch(`${SERVER_URL}/api/worlds/${worldId}/screenshot`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl }),
        }).catch(() => { /* offline — ignore */ });
    } catch { /* canvas tainted or not ready — ignore */ }
}

async function _savePlayerState() {
    if (!chunkManager?.worldId) return;
    const state = {
        position: { ...me.position },
        rotation: { yaw, pitch },
        health:   me.health,
        hunger:   me.hunger,
        energy:   me.energy,
        inventory: _inventory?.toJSON() ?? null,
    };
    try {
        await fetch(`${SERVER_URL}/api/worlds/${chunkManager.worldId}/player-state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
        });
    } catch { /* offline */ }
}

// ── Direction helpers ─────────────────────────────────────────────────────────

function _horizontalForward() {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
