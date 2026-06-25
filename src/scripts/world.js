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
import { CHUNK_SIZE, WORLD_MIN_Y, CHUNK_SHIFT } from './engine/ChunkData.js';
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
            data.set(ctx.getImageData(0, 0, SIZE, SIZE).data, i * SIZE * SIZE * 4);
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
let _isDead      = false;
let _damageFade  = 0;     // 0..1, drives vignette
let _attackCharge = 0;   // 0..1

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

    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
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

    _blockReg = buildRegistryFromGamePack(gamepackData);
    _itemReg  = buildItemRegistryFromGamePack(gamepackData);

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
            _autoSaveTimer = setInterval(() => _saveAll(), AUTO_SAVE_MS);
        } catch {
            console.warn('[world] Save server unreachable — world will not be persisted');
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
    const spawnPos = playerPos ?? { x: 0, y: 80, z: 0 };
    if (!me.position || !me.position.fromSave) {
        me.position = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z };
    }
    camera.position.set(me.position.x, me.position.y + CAMERA_HEIGHT, me.position.z);
    camera.rotation.set(0, 0, 0);

    _isDead      = false;
    _damageFade  = 0;
    _attackCharge = 0;

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
    _saveAll();
    _savePlayerState();
    _disposeAll();

    chunkManager = null;
    worldClient  = null;
    workerPool?.clearQueue();
    renderer?.dispose();
    _blockReg = _itemReg = _physics = _inventory = _water = _entities = _crafting = null;
});

// ── Tick event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) { _saveAll(); _savePlayerState(); }
    _wasLocked = isLocked;

    if (_isDead) { renderer.render(scene, camera); return; }

    // Build input object for physics
    const fwd      = _horizontalForward();
    const rightDir = { x: fwd.z, z: -fwd.x };
    const input = {
        forward:  !!KEYS['KeyW'],
        backward: !!KEYS['KeyS'],
        left:     !!KEYS['KeyA'],
        right:    !!KEYS['KeyD'],
        jump:     !!KEYS['Space'],
        sneak:    !!KEYS['ControlLeft'] || !!KEYS['KeyQ'],
        sprint:   !!KEYS['ShiftLeft'],
        fwd,
        rightDir,
    };

    const result = _physics.update(me.position, input, dt, _gameMode, {
        hunger: me.hunger, energy: me.energy,
    });

    if (result.fallDamage > 0) _applyDamage(result.fallDamage);
    if (result.fellIntoVoid)   _applyDamage(20);

    if (_gameMode === 'SURVIVAL') _survivalTick(dt);

    _water.tick(dt, (cx, cz) => chunkManager?.markDirty(cx, cz));
    _entities.update(dt, me.position, _inventory, _gameMode);

    // Raycast for block targeting
    _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    const origin = { x: me.position.x, y: me.position.y + CAMERA_HEIGHT, z: me.position.z };
    const hit    = raycast(worldState, _blockReg, origin, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, INTERACT_REACH);

    // Mob targeting — check before block so mobs in front of walls are hit correctly
    const mobHit = _entities?.getClosestMobInRay(origin, _camFwd, INTERACT_REACH) ?? null;

    // Block breaking only when no mob is targeted
    _handleBreaking(dt, mobHit ? null : hit);
    _handlePlacement(hit);
    _handleAttackCharge(dt, mobHit, mobHit ? null : hit);

    // Selection outline: mob outline overrides block outline
    if (mobHit) {
        _updateMobOutline(mobHit.mob);
    } else if (hit) {
        _updateSelectionOutline(hit);
    } else if (_selMesh) {
        _selMesh.visible = false;
    }

    // Bow draw start / zoom
    const isBowSelected = _bowItemSelected();
    if (!isBowSelected && _bowDrawing) { _bowDrawing = false; _bowCharge = 0; }
    if (_rightJust && isBowSelected) { _bowDrawing = true; _bowCharge = 0; _rightJust = false; }
    if (_bowDrawing) _handleBowDraw(dt);
    _bowZoom = _bowDrawing;

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
    const sensitivity = 0.0018;
    yaw   -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
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

    // Creative: instant break
    if (_gameMode === 'CREATIVE') {
        _breakBlock(hit);
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
    if (!itemDef?.isBlock) return;

    const px = hit.x + hit.face.x;
    const py = hit.y + hit.face.y;
    const pz = hit.z + hit.face.z;

    // Don't place inside player
    const pw = 0.3;
    if (Math.abs(px + 0.5 - me.position.x) < pw &&
        py + 1 > me.position.y && py < me.position.y + 1.8 &&
        Math.abs(pz + 0.5 - me.position.z) < pw) return;

    const blockDef = _blockReg.getByName(held.itemId.toUpperCase());
    if (!blockDef) return;

    worldState.setBlock(px, py, pz, blockDef.id);
    chunkManager?.markDirty(px >> CHUNK_SHIFT, pz >> CHUNK_SHIFT);

    // Trigger water simulation if placing water
    if (blockDef.id === 5) _water?.addSource(px, py, pz);

    if (_gameMode !== 'CREATIVE') {
        _inventory.removeItem(held.itemId, 1);
    }
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
    const arrowSource = _inventory.takeArrow();
    if (!arrowSource) return;

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

function _handleDeath() {
    if (_isDead) return;
    _isDead = true;
    if (_entities) _entities.spawnDeathPack({ ...me.position }, _inventory);
    window.dispatchEvent(new CustomEvent('ww_playerDied'));
}

window.addEventListener('ww_mobAttack', (e) => {
    _applyDamage(e.detail?.damage ?? 4);
});

document.addEventListener('WorldJS_setGameMode', (e) => {
    const mode = e.data?.gameMode;
    if (mode && ['SURVIVAL','CREATIVE','SPECTATOR'].includes(mode)) {
        _gameMode = mode;
        if (_physics) { _physics.flying = false; _physics.vel = { x:0, y:0, z:0 }; }
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
    me.position  = { x: 0, y: 100, z: 0 };
    if (_inventory) {
        _inventory.slots    = [];
        _inventory.hotbar   = new Array(10).fill(null);
        _inventory.offhand  = null;
        _inventory.equipment = { head:null,chest:null,legs:null,feet:null,ears:null,hands:null,arms:null,quiver:null };
        _inventory.quiverArrows = 0;
    }
    window.dispatchEvent(new CustomEvent('ww_respawned'));
});

// ── HUD updates ───────────────────────────────────────────────────────────────

function _updateHUD() {
    _setInnerHTML('playerHealth', `<img src="./data/textures/UI/Heart.png" width="25"> Health: ${Math.ceil(me.health)} / 100`);
    _setInnerHTML('playerHunger', `<img src="./data/textures/UI/Bread.png" width="25"> Hunger: ${Math.ceil(me.hunger)} / 100`);
    _setInnerHTML('playerEnergy', `<img src="./data/textures/UI/Energy1.png" width="25"> Energy: ${Math.ceil(me.energy)} / 100`);

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

    const targetFov = _bowZoom ? 30 : 75;
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
    if (chunkManager?.worldId && worldClient?.connected) {
        chunkManager.saveAll();
    }
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
