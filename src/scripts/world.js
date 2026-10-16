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

import { buildRegistryFromGamePack, FLUID_SOURCE } from './engine/BlockRegistry.js';
import { facingOf, OPPOSITE, FACING_DIR, LEFT_OF } from './engine/BlockShapes.js';
import { treeBlocks, TREE_INTO_AIR }         from './workers/StructurePlacer.js';
import { REACH }                             from './engine/net/OnlineProtocol.js';
import { buildItemRegistryFromGamePack }     from './engine/ItemRegistry.js';
import { WorldState }                        from './engine/WorldState.js';
import { WorkerPool }                        from './engine/WorkerPool.js';
import { ChunkManager }                      from './engine/ChunkManager.js';
import { WorldClient }                       from './engine/WorldClient.js';
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, CHUNK_SHIFT } from './engine/ChunkData.js';
import { PlayerPhysics }                     from './engine/PlayerPhysics.js';
import { Inventory }                         from './engine/Inventory.js';
import { raycast }                           from './engine/Raycast.js';
import { WaterSimulator }                    from './engine/WaterSimulator.js';
import { EntityManager }                     from './engine/EntityManager.js';
import { CraftingSystem }                    from './engine/CraftingSystem.js';
import { SmoothTerrain }                     from './engine/SmoothShape.js';
import { Geography }                         from './workers/Geography.js';
import { BiomeSet }                          from './workers/Biomes.js';
import { normaliseFlat }                     from './engine/FlatWorld.js';
import { ShadowMapper, SHADOW_LAYER, SHADOW_GLSL } from './Shadows.js';
import { SKY_MAX, SKY_FALLOFF, SKY_MIN, SUN_AMBIENT, SUN_TOP } from './engine/Sun.js';
import { MESH_VERT_GLSL, NO_LAYER }          from './engine/MeshFormat.js';
import { Particles, PARTICLE_LEVELS }        from './Particles.js';
import { Atmosphere }                        from './Atmosphere.js';
import { ATMOS_GLSL, OUTPUT_GLSL, CLOUD_VEIL_GLSL } from './AtmosGLSL.js';
import { PostFX }                            from './PostFX.js';
import { FarTerrain, MASK as FAR_MASK }      from './FarTerrain.js';
import { SectionVisibility, sectionOf, SECTIONS, SECTION_SIZE } from './engine/Visibility.js';
import { EDIT_EMPTY }                        from './workers/FarTiles.js';
import { BLOCK_TEX_LAYERS, BLOCK_FACE_MAP, blockTextureLayers } from './engine/BlockTextures.js';
import { sound, blockSoundFamily }           from './Sound.js';
import { GameSounds }                        from './GameSounds.js';
import { PlayerModel, DEFAULT_SKIN }         from './PlayerModel.js';
import { Hands }                             from './Hands.js';
import { Multiplayer }                       from './engine/Multiplayer.js';
import { online }                            from './Online.js';
import { packChunk, packEdits }              from './engine/net/ChunkCodec.js';
import { ChunkStatus }                       from './engine/net/OnlineProtocol.js';
import { RemotePlayers, packState }          from './Players.js';
import { CommandRunner, cleanChat }          from './engine/Commands.js';
import { WEATHER_IDS }                       from './engine/Weather.js';
import { DAY_LENGTH }                        from './engine/DayCycle.js';

// The page is served by the game server itself, so derive both URLs from the
// current origin. The server now binds an OS-assigned port (a fixed 3000 meant
// the desktop app silently failed to launch whenever something else held it),
// so nothing may assume a port number. The literal is only a fallback for
// opening the page directly off disk during development.
const SERVER_URL   = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin
    : 'http://127.0.0.1:3000';
const WS_URL       = SERVER_URL.replace(/^http/, 'ws');
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
let _sounds      = null;   // GameSounds — per world
let _playerModel = null;   // PlayerModel — the player's own body, per world
let _hands = null;         // Hands — and its hands, seen in first person
const SHOW_HANDS = false;  // … not for now: they did not look right (the player's own word)
let _skin        = { ...DEFAULT_SKIN };   // the look the player chose (the Character screen)
let _playerName  = '';                    // … and their name, for other players to see
let _playerKey   = '';                    // … and who they are whatever they are called (main.js: the key of their name's hidden code)
let _mp          = null;   // Multiplayer — this world's session (a session of one, alone)
let _others      = null;   // RemotePlayers — the other players, as drawn here
let _loadToken   = 0;      // which load of a world is the one wanted (startWorldLoad)
let _warming     = 0;      // performance.now() when a world began to load and its shaders were not ready yet: nothing is drawn (_prepareShaders); 0 when they are
let _guest       = false;  // this world is someone else's: our own state file, and no say over the world
let _worldName   = '';     // what it is called (a screenshot is named after it)
let _stateKey    = '';     // … and which file that is (the server's ?player=)
let _remote      = false;  // … and on a machine this one cannot reach: an online game (see *Online*, below)
let _gamepack    = null;   // the gamepack data the world was loaded with (its fingerprint goes to the online server)
let _reader      = null;   // WorldClient — the host's own line for reading saved chunks for its online guests
let _pendingSig  = '';     // what of pendingChanges the server was last sent (see _savePendingEdits)
let _autoSaveTimer = null;
let _wasLocked     = false;

// Hidden per-world setting: 'smooth' (the default for new worlds) or 'blocky'.
// Read once from the world's metadata when the world starts loading and fixed
// for the session — it decides which mesher the workers build and which
// collision the player uses, neither of which can be swapped under a running
// world. 'blocky' below is only the no-world / unrecorded fallback; new worlds
// get their style from TERRAIN_STYLE in server/server.js.
let _terrainStyle  = 'blocky';
let _smooth        = null;   // SmoothTerrain collider — smooth worlds only
// The world generator version the world was made with (TerrainGenerator.js
// WORLD_GEN; 1 = workers/legacy/). From the world's world.json.
let _worldGen      = 1;

// ── Materials ─────────────────────────────────────────────────────────────────

const chunkMeshes = new Map();

// Every chunk mesh hangs under this group, not under the scene itself. Chunks
// never move, so each mesh's world matrix is set once when it is made
// (_addChunkMesh) and the group's updateMatrixWorld does nothing: Three.js
// otherwise walks every mesh in the scene on each render() — twice a frame
// with shadows on — to find that nothing changed.
const chunkGroup = new THREE.Group();
chunkGroup.matrixAutoUpdate = false;
chunkGroup.updateMatrixWorld = () => {};

// ── What a chunk draw does not need to repeat ────────────────────────────────
// Every chunk has its own materials (for its light textures), and Three.js
// uploads a material's whole uniform list whenever the material changes — so
// each chunk draw re-sent some eighty uniforms of fog, sky, weather and shadow
// state that are the same for all of them. That was the largest single cost
// of submitting a frame, ahead of the draw calls themselves.
//
// Uniforms belong to the GL program, and all chunk materials of one kind
// (opaque, transparent) run the same program. So a chunk's materials carry
// only what differs per chunk, plus the samplers (_chunkLight), and one
// "primer" mesh per kind — a single degenerate triangle with the full uniform
// set, sorted ahead of everything else — uploads the shared state once per
// render() before any chunk of its kind is drawn (_makePrimers).
//
// Samplers stay in every chunk material because a sampler takes its texture
// unit from its place in the material's upload: left out, the shared textures
// would keep the primer's units while a chunk's light textures took the same
// ones. _perDrawUniforms picks them out of chunkUniforms by value, so a
// sampler added to the shared GLSL later is covered without a change here.
let _perDraw     = null;   // the shared uniforms every chunk material still carries
let _primers     = [];     // the primer meshes, in the scene while a world is loaded
let _primerLight = null;   // a light texture for them to bind

/** The uniforms of `uniforms` that must be set on every draw: samplers (a texture, or not set yet). */
function _perDrawUniforms(uniforms) {
    const out = {};
    for (const [name, u] of Object.entries(uniforms)) {
        if (u.value == null || u.value.isTexture) out[name] = u;
    }
    return out;
}

function _opaqueChunkMaterial(uniforms) {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms,
        vertexShader: CHUNK_VERT, fragmentShader: CHUNK_FRAG,
    });
}

function _transparentChunkMaterial(uniforms) {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms,
        vertexShader: CHUNK_VERT, fragmentShader: CHUNK_TRANSP_FRAG,
        transparent: true, depthWrite: false,
        // Front faces only. The mesher puts every face of water and ice in
        // twice, once facing each way, so the surface is still there from
        // underneath — and culling the faces turned away is what lets it give
        // them an order that is back to front from any viewpoint
        // (GreedyMesher._orderTranslucent). Chunks are ordered in _cullChunks.
        side: THREE.FrontSide,
    });
}

/** A geometry with the chunk meshes' attributes and one triangle: all zeros (nothing drawn) unless `tri`. */
function _chunkTriangle(tri) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri ? [0, 0, 0, 1, 0, 0, 0, 0, 1] : 9), 3));
    geo.setAttribute('tint',     new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
    geo.setAttribute('uv',       new THREE.BufferAttribute(new Uint16Array(6), 2, true));
    geo.setAttribute('nrm',      new THREE.BufferAttribute(new Int8Array([0, 127, 0, 0, 0, 127, 0, 127, 0, 127, 0, 0]), 4, true));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return geo;
}

/** The primer meshes for the current chunkUniforms (see above). */
function _makePrimers() {
    _primerLight = _emptyLightTexture();
    const uniforms = {
        ...chunkUniforms,
        uLight:    { value: _primerLight },
        uBlock:    { value: _noBlockLight },
        uChunk:    { value: _chunkUniform() },
    };
    const geo = _chunkTriangle(false);
    for (const material of [_opaqueChunkMaterial(uniforms), _transparentChunkMaterial(uniforms)]) {
        const mesh = new THREE.Mesh(geo, material);
        mesh.frustumCulled = false;
        // First in its pass: both the opaque sort (see setOpaqueSort) and
        // Three.js's transparent sort order by renderOrder before depth.
        mesh.renderOrder = -1e9;
        scene.add(mesh);
        _primers.push(mesh);
    }
}

function _disposePrimers() {
    for (const mesh of _primers) { scene.remove(mesh); mesh.material.dispose(); }
    _primers[0]?.geometry.dispose();
    _primers = [];
    _primerLight?.dispose();
    _primerLight = null;
    _perDraw = null;
}

// True inside the main renderer.render() of _render().
let _viewPass = false;

// The chunk shaders read neither modelViewMatrix nor normalMatrix (CHUNK_VERT
// works from uChunkRel), but Three.js still composes both for every object it
// draws. In the view pass a chunk mesh's own two matrices skip that; the
// shadow pass, whose depth shader does use modelViewMatrix, gets the real ones.
const _mat4Multiply = THREE.Matrix4.prototype.multiplyMatrices;
const _mat3Normal   = THREE.Matrix3.prototype.getNormalMatrix;
function _chunkModelView(a, b) { return _viewPass ? this : _mat4Multiply.call(this, a, b); }
function _chunkNormalMatrix(m) { return _viewPass ? this : _mat3Normal.call(this, m); }

// ── Block texture atlas ───────────────────────────────────────────────────────

// The layers and face map in use for the loaded world (engine/BlockTextures.js:
// the built-in ones plus a layer for every texture a block's JSON names).
// Rebuilt at each world load from that world's registry.
let _texLayers = BLOCK_TEX_LAYERS.slice();
let _faceMap   = { ...BLOCK_FACE_MAP };
// Leaves sway in the wind: the built-in leaves layer (uSwayLayer), and the
// contiguous run of layers added for other blocks flagged `leaves`.
let _swayRange = [-10, -10];

function _extendBlockTextures(reg) {
    ({ layers: _texLayers, faceMap: _faceMap, swayRange: _swayRange } = blockTextureLayers(reg));
}

// GLSL 300 es shaders (Three.js injects the version + built-in uniforms automatically)
// Three.js automatically injects `position`, `normal`, `uv` before our code,
// so we only declare our custom attributes here. The surface normal comes in
// our own `nrm` (four signed bytes: the normal and the block's glow), not in
// Three.js's `normal`, which would be three floats.
//
// A custom ShaderMaterial gets no fog from Three.js automatically; the fragment
// stage applies it from vWorldPos (applyFog). Without it chunks pop in hard at
// the render-distance edge.
//
// Leaves sway in the wind (uWind, from the weather). The displacement depends
// only on world position, so corners shared by neighbouring quads move together
// and the canopy never cracks apart. The shadow depth pass does not sway —
// shadows of leaves stay put, which reads fine.
//
// Chunk meshes are only ever translated, so instead of Three.js's per-object
// matrices the shader takes uChunkRel: the chunk's origin relative to the
// camera, worked out in double precision on the CPU each frame (_viewChunks).
// The shader never reads modelMatrix or modelViewMatrix, so Three.js uploads
// neither — two 4×4 matrix uploads per draw were the single largest cost of
// submitting a frame. Positions stay camera-relative until projection, so this
// is as precise far from the origin as the matrices were.
// What differs from chunk to chunk, besides its two light textures, is one
// uniform: eight floats, one upload per draw. As three uniforms (a vec3 and two
// vec2) it was up to three GL calls for every chunk drawn. The names the
// shaders use are kept as macros.
//   uChunkRel  the chunk's origin relative to the camera (_viewChunks)
//   uChunkTile the chunk's place in a 64 × 64-chunk tile of the world, as
//              x + 64·z — see tilePos() in CHUNK_COMMON
//   uLightY    the sky-light volume's first level (chunk-local y) and height
//   uBlockY    the block-light volume's; height 0 = none reaches this chunk
const CHUNK_UNIFORM_GLSL = `
uniform vec4 uChunk[2];
#define uChunkRel  (uChunk[0].xyz)
#define uChunkTile (uChunk[0].w)
#define uLightY    (uChunk[1].xy)
#define uBlockY    (uChunk[1].zw)
`;
// Offsets into a chunk's uChunk array.
const U_REL = 0, U_TILE = 3, U_LIGHT_Y0 = 4, U_LIGHT_H = 5, U_BLOCK_Y0 = 6, U_BLOCK_H = 7;
const TILE_CHUNKS = 64;   // chunks along a side of the tile tilePos() repeats over

/** A uChunk value: no offset, a sky-light volume one level high, no block light. */
function _chunkUniform() {
    const u = new Float32Array(8);
    u[U_LIGHT_H] = 1;
    return u;
}

const CHUNK_VERT = MESH_VERT_GLSL + `
in vec4  nrm;          // xyz surface normal, w glow — signed bytes, normalised by the GPU
${CHUNK_UNIFORM_GLSL}
uniform vec4  uWind;
uniform float uTime;
uniform float uSwayLayer;      // the built-in leaves layer
uniform vec2  uSwayRange;      // … and the run of layers added for other leaves

out vec3  vColor;
out vec2  vUV;
out float vLayer;
out vec3  vWorldPos;
out vec3  vLocal;      // chunk-local position, for the light lookup
out vec4  vNormal;

void main() {
    vec3 rel = position + uChunkRel;
    vWorldPos = rel + cameraPosition;
    vLocal = position;
    float layer = tintLayer();
    if (abs(layer - uSwayLayer) < 0.5 || (layer > uSwayRange.x - 0.5 && layer < uSwayRange.y + 0.5)) {
        float s = length(uWind.xy);
        vec2 dir = s > 0.01 ? uWind.xy / s : vec2(0.7071);
        float lean = min(s / 10.0, 1.0);
        float ph = dot(vWorldPos, vec3(0.37, 0.21, 0.29));
        float amp = min(0.025 + 0.012 * s, 0.28) * (1.0 + uWind.z);
        float wave = sin(uTime * (1.5 + 0.07 * s) + ph) * 0.65 + sin(uTime * 3.3 + ph * 1.7) * 0.35;
        vec3 off = vec3(dir.x * (wave + 0.6 * lean), wave * 0.3, dir.y * (wave + 0.6 * lean)) * amp;
        rel += off;
        vWorldPos += off;
        vLocal += off;
    }
    vColor  = tint.rgb;
    vUV     = tileUV();
    vLayer  = layer;
    vNormal = nrm;
    vec3 mv = mat3(viewMatrix) * rel;
    gl_Position = projectionMatrix * vec4(mv, 1.0);
}
`;

// Shared fragment tail: lighting (Atmosphere/DayCycle, block light), weather on
// the surface, fog, then the display adjustments that used to be a CSS filter on
// <body>. Running those here costs a few ALU ops instead of forcing the whole
// page — canvas included — through an extra compositing pass every frame.
const CHUNK_COMMON = `
precision highp sampler2DArray;
precision highp sampler3D;
uniform sampler2DArray uTex;
uniform sampler3D uLight;        // this chunk's sky light (see _setChunkLight)
uniform sampler3D uBlock;        // this chunk's block light: torches, lanterns, lamps
${CHUNK_UNIFORM_GLSL}
uniform vec3  uTorchColor;       // block light at full strength
uniform float uTorchFlicker;     // 1 = steady
uniform vec4  uHandLight;        // light the player holds: xyz camera-relative, w its level (0 = none)
uniform float uGlowBoost;        // how far past white glowing texels go (above 1 with Eye Adaptation)
uniform vec4  uSelect;           // the block under the crosshair: xyz its low corner, camera-relative; w how brightly it glows (0 = none)
uniform float uFogNear;
uniform float uFogFar;
uniform float uBrightness;
uniform int   uColorMode;   // 0 none, 1 protanopia, 2 deuteranopia, 3 tritanopia
${ATMOS_GLSL}
${CLOUD_VEIL_GLSL}
${OUTPUT_GLSL}

in vec3  vColor;
in vec2  vUV;
in float vLayer;
in vec3  vWorldPos;
in vec3  vLocal;
in vec4  vNormal;

out vec4 fragColor;

// The surface normal: the mesher's per-vertex normal, interpolated, so smooth
// terrain is shaded smoothly across its triangles instead of facet by facet.
// It is never turned toward the camera: a smooth normal can lean slightly
// away from it near a silhouette, and flipping it there would blacken the
// edge. (Water and ice need no turning either: each of their faces is in the
// mesh once for each side, with that side's normal.)
vec3 surfaceNormal() {
    float len = length(vNormal.xyz);
    return len > 1e-4 ? vNormal.xyz / len : vec3(0.0, 1.0, 0.0);
}

// This fragment's position in the world, repeating every ${TILE_CHUNKS} chunks on x and z
// (y is chunk-local). For patterns laid over the ground: unlike vWorldPos it is
// exact however far from the origin the player has walked, because it is put
// together from the position inside the chunk and the chunk's small place in
// the tile. Anything read with it must repeat over ${TILE_CHUNKS * CHUNK_SIZE} blocks.
vec3 tilePos() {
    float tz = floor(uChunkTile / ${TILE_CHUNKS.toFixed(1)});
    return vec3(vLocal.x + (uChunkTile - tz * ${TILE_CHUNKS.toFixed(1)}) * ${CHUNK_SIZE.toFixed(1)}, vLocal.y, vLocal.z + tz * ${CHUNK_SIZE.toFixed(1)});
}

// Sky light level (engine/Sun.js), 0..15: read from the air half a block in
// front of the surface, interpolated between cells. The volume is the chunk
// plus a one-block border on x and z, over levels uLightY.x … +uLightY.y, so
// only that pair differs between chunks (one small upload per draw).
float skyLevel(vec3 n) {
    vec3 p = vLocal + n * 0.5 + vec3(1.0, -uLightY.x, 1.0);
    return texture(uLight, p / vec3(${(CHUNK_SIZE + 2).toFixed(1)}, uLightY.y, ${(CHUNK_SIZE + 2).toFixed(1)})).r * ${SKY_MAX.toFixed(1)};
}

// Block light level, 0..15 (workers/Blocklight.js): the same lookup, in this
// chunk's block-light volume, which only covers the levels light reaches.
float blockLevel(vec3 n) {
    if (uBlockY.y < 0.5) return 0.0;
    vec3 p = vLocal + n * 0.5 + vec3(1.0, -uBlockY.x, 1.0);
    if (p.y < 0.0 || p.y > uBlockY.y) return 0.0;
    return texture(uBlock, p / vec3(${(CHUNK_SIZE + 2).toFixed(1)}, uBlockY.y, ${(CHUNK_SIZE + 2).toFixed(1)})).r * ${SKY_MAX.toFixed(1)};
}

// A torch or lantern in the player's hand: its level, one less per block of
// distance. It sits at the camera, so every surface the player can see is one
// it can reach — no light through walls that anyone could notice.
float handLevel(vec3 n) {
    if (uHandLight.w <= 0.0) return 0.0;
    return uHandLight.w - length(vWorldPos - cameraPosition + n * 0.5 - uHandLight.xyz);
}

${SHADOW_GLSL}

// Shadows of the clouds: follow the light up to the cloud base and ask how
// much cloud is there — the same field the clouds are drawn from, so the
// shadows drift across the land under the clouds you can see.
float cloudShade() {
    // Peaks above the cloud base are above the clouds' shadow too.
    if (uCloudThresh > 1.5 || uSunDir.y < 0.05 || vWorldPos.y > uCloudBase) return 1.0;
    vec2 xz = vWorldPos.xz + uSunDir.xz * ((uCloudBase - vWorldPos.y) / uSunDir.y);
    float n = cloudNoise(xz);
    return 1.0 - cloudCover(n) * (0.55 + 0.4 * cloudThick(n));
}

// 0 under cover … 1 under open sky; set by lighting(), read by weatherSurface().
float gExposed = 1.0;

// The light on this fragment, from its normal: the sky (uAmbient, tinted by
// time of day and weather) and the sun or moon (uDirect along uSunDir, blocked
// by shadows and by clouds), scaled by the sky light that reaches it — so a
// flat top at noon under a clear sky is exactly 1 (engine/Sun.js SUN_TOP).
// Lightning brightens open ground.
//
// Block light — torches, lanterns, lamps and the light in the player's hand —
// is warm and does not care about the time of day. It is shaded a little by
// face direction so blocks keep their shape, and it adds into the headroom the
// sky leaves: all of it at night, nothing at noon. (A per-channel max of the
// two instead tinted the edge of every torch's pool lilac against moonlight.)
vec3 lighting(vec3 n) {
    float lvl = skyLevel(n);
    float sky = max(pow(${SKY_FALLOFF}, ${SKY_MAX.toFixed(1)} - lvl), ${SKY_MIN});
    gExposed = smoothstep(12.5, 15.0, lvl);
    float facing = max(dot(n, uSunDir), 0.0);
    float direct = facing > 0.0 ? facing * sunShadow(n) * cloudShade() : 0.0;
    vec3 L = (${SUN_AMBIENT.toFixed(4)} * uAmbient + ${(1 - SUN_AMBIENT).toFixed(4)} * direct * uDirect)
           * (sky / ${SUN_TOP.toFixed(6)}) + vec3(0.8, 0.85, 1.0) * uFlash * gExposed;
    float bl = max(blockLevel(n), handLevel(n));
    if (bl > 0.0) {
        float b = pow(${SKY_FALLOFF}, ${SKY_MAX.toFixed(1)} - bl) * min(bl, 1.0) * uTorchFlicker;
        float shade = 0.8 + 0.2 * n.y - 0.1 * n.x * n.x;
        float room = max(1.0 - dot(L, vec3(0.2126, 0.7152, 0.0722)), 0.0);
        L += uTorchColor * (b * shade * room);
    }
    return L;
}

// A glowing block (torch, lantern, lamp: the mesher puts its glow in the
// normal's w) ignores the light around it. With Eye Adaptation its bright texels
// go past white, so they bloom and pull the exposure down.
vec3 glow(vec3 c, vec3 n) {
    float hot = smoothstep(0.55, 0.9, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    vec3 full = vec3(1.0 + (uGlowBoost - 1.0) * hot);
    return c * (vNormal.w >= 0.99 ? full : mix(lighting(n), full, vNormal.w));
}

// The block under the crosshair glows: whatever is drawn of it — the cube, or
// in a smooth world the piece of ground it is — and a brighter line round each
// of its faces (round its footprint, for ground). A fragment is the block's
// when a point just under it is inside the block's voxel, which leaves out the
// face of a neighbour that lies against it. Chunks only: it is worked out from
// the position in the chunk, so it is exact however far out the player is.
vec3 selectGlow(vec3 c, vec3 n) {
    if (uSelect.w <= 0.0) return c;
    vec3 q = vLocal + uChunkRel - n * 0.02 - uSelect.xyz;
    // Ground on a diagonal slope dips under its own voxel, by a block at most
    // (SmoothShape.js): what faces up below the block, in its column, is its too.
    float lo = n.y > 0.35 ? -1.0 : 0.0;
    if (q.x < 0.0 || q.z < 0.0 || q.y < lo || any(greaterThan(q, vec3(1.0)))) return c;
    // How near the edge of the face: the two axes the face lies along.
    vec3 d = min(q, 1.0 - q), a = abs(n);
    float e = a.y >= a.x && a.y >= a.z ? min(d.x, d.z) : a.x >= a.z ? min(d.y, d.z) : min(d.x, d.y);
    float rim = 1.0 - smoothstep(0.0, 0.07, e);
    return c + vec3(1.0, 0.96, 0.82) * (uSelect.w * (0.10 + 0.34 * rim));
}

// Rain darkens open ground and makes it glint; freezing rain glazes it.
vec3 weatherSurface(vec3 c, vec3 n) {
    if (uWet <= 0.0 && uIce <= 0.0) return c;       // dry: nothing below changes it
    float wet = uWet * gExposed * (0.5 + 0.5 * smoothstep(-0.2, 0.6, n.y));
    float ice = uIce * gExposed;
    c *= 1.0 - 0.28 * wet;
    c = mix(c, c * 0.85 + vec3(0.10, 0.13, 0.17), ice * 0.6);
    if (wet + ice > 0.01) {
        vec3 h = normalize(normalize(cameraPosition - vWorldPos) + uSunDir);
        c += uDirect * pow(max(dot(n, h), 0.0), 60.0) * (wet * 0.35 + ice * 0.6);
    }
    return c;
}

// Render-distance fog (linear, hides the load edge) or weather fog, whichever
// is thicker, toward the horizon colour in that direction.
//
// The render-distance fog is measured horizontally, as (x⁴ + z⁴)^¼ from the
// camera: a rounded square, like the square of loaded chunks it hides the edge
// of. That distance is never less than the larger of |x| and |z|, and the
// loaded square reaches at least uFogFar that way in every direction, so fog
// is complete before the load edge whichever way the camera looks — while the
// corners of the square, which a circle would hide, stay visible. View depth
// (the old measure) also changed with where the camera pointed, so a turn of
// the head fogged or unfogged the same hillside.
float edgeDistance(vec3 r) {
    vec2 a = r.xz * r.xz;
    return sqrt(sqrt(dot(a, a)));
}
vec3 applyFog(vec3 c) {
    vec3 r = vWorldPos - cameraPosition;
    float f = clamp((edgeDistance(r) - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
    // In clear weather there is no weather fog to work out, and most of what
    // is on screen is nearer than the fog begins: for those pixels the fog
    // colour — a normalise and a power — is never needed. (Exactly what the
    // mix below gives for f = 0.)
    if (uHaze > 0.0 || uFogDensity > 0.0) f = max(f, weatherFog(cameraPosition, r));
    if (f <= 0.0) return c;
    return mix(c, fogColorFor(normalize(r)), f);
}

// Cheap saturate + hue-rotate, matching the previous CSS filter values.
vec3 applyColorMode(vec3 c) {
    if (uColorMode == 0) return c;
    float sat = uColorMode == 3 ? 1.30 : 1.25;
    float ang = uColorMode == 1 ? -0.3142 : uColorMode == 2 ? 0.3142 : 0.6981;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, sat);
    float cs = cos(ang), sn = sin(ang);
    mat3 hue = mat3(
        0.213 + cs * 0.787 - sn * 0.213, 0.213 - cs * 0.213 + sn * 0.143, 0.213 - cs * 0.213 - sn * 0.787,
        0.715 - cs * 0.715 - sn * 0.715, 0.715 + cs * 0.285 + sn * 0.140, 0.715 - cs * 0.715 + sn * 0.715,
        0.072 - cs * 0.072 + sn * 0.928, 0.072 - cs * 0.072 - sn * 0.283, 0.072 + cs * 0.928 + sn * 0.072
    );
    return max(hue * c, 0.0);   // no upper clamp: glowing texels stay bright for Eye Adaptation
}

// Fog, the display settings, and last whatever cloud lies between the camera
// and this surface (the sky's clouds get neither setting, so the two match).
vec3 grade(vec3 c) {
    return cloudVeil(applyColorMode(applyFog(c) * uBrightness), vWorldPos - cameraPosition);
}
`;

// How far the ground next door reaches onto this one, in blocks — and how far
// when it comes from opposite sides at once (a block or a strip of one ground
// alone among another). There it only frays the edges: the block keeps its own
// face, where the full reach from every side would leave nothing of it.
const BLEND_REACH = 0.7;
const BLEND_REACH_HEMMED = 0.2;

// An untextured face's vertex colour is the block's own; a textured face's
// colour is its texture, and the three bytes say how it blends with the ground
// around it instead (engine/MeshFormat.js). All of the light comes from
// lighting(). The block textures repeat (each is one tile of a layer), so vUV
// goes to the sampler as it is and picks its own mip level.
//
// Cutout blocks (leaves, glass) are in this mesh too: a texel is drawn or it
// is not, and what is drawn writes depth like any block.
const CHUNK_FRAG = CHUNK_COMMON + `
// Natural ground. In a smooth world the ground next to it spreads over its
// edges: bl.x is that ground's texture layer and bl.y a bit for each of the
// eight sides it lies on (GreedyMesher.blendCode). It reaches ${BLEND_REACH} of a
// block in, along a ragged line — a noise decides, not a fade, so it reads as
// one ground lying over the other — but only ${BLEND_REACH_HEMMED} where it lies on opposite
// sides, so a single block of another ground is still plainly that ground, with
// a frayed edge. And a little variation on a scale larger than a block, so a
// wide stretch of one ground does not look stamped out.
vec3 ground(vec3 c, vec3 bl, vec2 gx, vec2 gy) {
    vec3 p = tilePos();
    if (bl.y > 0.5) {
        // Where in the voxel: a top face's tile coordinates are (z, x). Pulled
        // in a hair, so a face one block wide never wraps round at its far edge.
        vec2 f = fract(vUV * 0.9995 + 0.00025);
        float x0 = f.y, x1 = 1.0 - f.y, z0 = f.x, z1 = 1.0 - f.x;
        int m = int(bl.y + 0.5);
        float d = 9.0;
        if ((m & 1) != 0)   d = min(d, x0);
        if ((m & 2) != 0)   d = min(d, x1);
        if ((m & 4) != 0)   d = min(d, z0);
        if ((m & 8) != 0)   d = min(d, z1);
        if ((m & 16) != 0)  d = min(d, length(vec2(x0, z0)));
        if ((m & 32) != 0)  d = min(d, length(vec2(x1, z0)));
        if ((m & 64) != 0)  d = min(d, length(vec2(x0, z1)));
        if ((m & 128) != 0) d = min(d, length(vec2(x1, z1)));
        // On two opposite sides, or two opposite corners: hemmed in.
        bool hemmed = (m & 3) == 3 || (m & 12) == 12 || (m & 144) == 144 || (m & 96) == 96;
        float e = 1.0 - d / (hemmed ? ${BLEND_REACH_HEMMED.toFixed(2)} : ${BLEND_REACH.toFixed(2)});
        if (e > 0.0) {
            float n = smoothstep(0.3, 0.7, textureLod(uCloudMap, p.xz * 0.125, 0.0).r);
            float k = smoothstep(0.42, 0.58, e * 1.25 + (n - 0.5) - 0.1);
            if (k > 0.0) c = mix(c, textureGrad(uTex, vec3(vUV, bl.x), gx, gy).rgb, k);
        }
    }
    float v = textureLod(uCloudMap, (p.xz + p.y * vec2(0.375, 0.625)) * ${(1 / 64).toFixed(6)}, 0.0).r;
    return c * (0.88 + 0.24 * v);
}

void main() {
    vec3 n = surfaceNormal();
    vec3 c;
    if (vLayer >= 0.0) {
        // Taken before anything can branch: later lookups use them.
        vec2 gx = dFdx(vUV), gy = dFdy(vUV);
        vec4 t = texture(uTex, vec3(vUV, floor(vLayer + 0.5)));
        if (t.a < 0.5) discard;
        c = t.rgb;
        vec3 bl = floor(vColor * 255.0 + 0.5);
        if (bl.z > 0.5) c = ground(c, bl, gx, gy);
    } else {
        c = vColor;
    }
    c = vNormal.w > 0.004 ? glow(c, n) : weatherSurface(c * lighting(n), n);
    fragColor = displayOut(vec4(grade(selectGlow(c, n)), 1.0));
}
`;

// Water and ice, blended over the scene at 0.72 of their texture's opacity.
const CHUNK_TRANSP_FRAG = CHUNK_COMMON + `
void main() {
    vec3 n = surfaceNormal();
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(vUV, floor(vLayer + 0.5)));
        if (t.a < 0.05) discard;
        fragColor = displayOut(vec4(grade(selectGlow(t.rgb * lighting(n), n)), t.a * 0.72));
    } else {
        fragColor = displayOut(vec4(grade(selectGlow(vColor * lighting(n), n)), 0.72));
    }
}
`;

// Far terrain (FarTerrain.js): heightfield tiles beyond the chunks. They share
// the chunk uniforms and fragment tail, so fog, the sun, clouds, weather and
// the display settings match the chunks exactly; they have no light volume
// (it is open sky out there) and no texture (the colour is the texture's
// average). uFarMask marks the chunks on screen: fragments inside them are
// dropped, and vertices touching them sink under the terrain, which closes the
// seam where the two meet (see FarTerrain.js). A vertex of a tree or a house
// asks about the chunk its foot is in (the offset to it is in the vertex's two
// spare bytes, FarTiles.js), so the whole shape goes when the real one comes.
const FAR_MASK_GLSL = `
uniform sampler2D uFarMask;
uniform vec2  uFarMaskOrigin;
uniform float uFarSink;
float farMeshed(vec2 xz) {
    vec2 c = floor(xz / ${CHUNK_SIZE.toFixed(1)}) - uFarMaskOrigin;
    if (c.x < 0.0 || c.y < 0.0 || c.x >= ${FAR_MASK.toFixed(1)} || c.y >= ${FAR_MASK.toFixed(1)}) return 0.0;
    return texelFetch(uFarMask, ivec2(c), 0).r;
}
`;

const FAR_VERT = FAR_MASK_GLSL + `
in vec4 fcol;
in vec4 nrm;
out vec3  vColor;
out vec2  vUV;
out float vLayer;
out vec3  vWorldPos;
out vec3  vLocal;
out vec4  vNormal;

void main() {
    // modelViewMatrix is camera-relative (composed in doubles on the CPU), so
    // this stays precise far from the origin; undo the rotation for the
    // offset from the camera in world axes.
    vec3 rel = transpose(mat3(viewMatrix)) * (modelViewMatrix * vec4(position, 1.0)).xyz;
    // The foot: the vertex itself on the ground (which may be the corner of
    // four chunks), the middle of its root block for a tree.
    vec2 xz = rel.xz + cameraPosition.xz + vec2(nrm.w * 127.0, fcol.a * 255.0 - 128.0) / 16.0;
    float m = max(max(farMeshed(xz + vec2(-0.45, -0.45)), farMeshed(xz + vec2(0.45, -0.45))),
                  max(farMeshed(xz + vec2(-0.45, 0.45)), farMeshed(xz + vec2(0.45, 0.45))));
    rel.y -= m * uFarSink;
    vWorldPos = rel + cameraPosition;
    vColor  = fcol.rgb;
    vNormal = vec4(nrm.xyz, 0.0);
    vUV     = vec2(0.0);
    vLayer  = -1.0;
    vLocal  = position;
    gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
}
`;

const FAR_FRAG = CHUNK_COMMON + FAR_MASK_GLSL + `
// lighting() without the light volume: open sky, no sun shadow this far out.
vec3 farLighting(vec3 n) {
    float facing = max(dot(n, uSunDir), 0.0);
    float direct = facing > 0.0 ? facing * cloudShade() : 0.0;
    return (${SUN_AMBIENT.toFixed(4)} * uAmbient + ${(1 - SUN_AMBIENT).toFixed(4)} * direct * uDirect) / ${SUN_TOP.toFixed(6)}
         + vec3(0.8, 0.85, 1.0) * uFlash;
}
void main() {
    if (farMeshed(vWorldPos.xz) > 0.5) discard;
    vec3 n = surfaceNormal();
    fragColor = displayOut(vec4(grade(weatherSurface(vColor * farLighting(n), n)), 1.0));
}
`;

// ── GPU capability checks ─────────────────────────────────────────────────────

/**
 * Verify WebGL2 before anything tries to compile a chunk shader. Without this a
 * machine with a blocklisted driver just shows a black screen and a console
 * error the player will never see.
 */
function _checkWebGL2(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl2'); } catch { /* fall through */ }
    if (gl) return true;

    window.dispatchEvent(new CustomEvent('ww_fatalError', {
        detail: {
            title: 'Graphics not supported',
            message: 'Wonder World needs WebGL 2, which this system did not provide.\n\n' +
                     'This usually means graphics drivers are out of date, or hardware ' +
                     'acceleration is disabled. Updating your graphics driver normally fixes it.',
        },
    }));
    console.error('[world] WebGL2 unavailable — cannot start renderer');
    return false;
}

/**
 * Chromium silently falls back to the SwiftShader software rasteriser when the
 * GPU is blocklisted. WebGL2 still works, but at a few frames per second, and
 * the player has no way to tell why. Surface it.
 */
function _warnIfSoftwareRenderer() {
    try {
        const gl   = renderer.getContext();
        const dbg  = gl.getExtension('WEBGL_debug_renderer_info');
        const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
        if (/swiftshader|software|llvmpipe|basic render/i.test(name)) {
            console.warn('[world] software renderer detected:', name);
            window.dispatchEvent(new CustomEvent('ww_gpuWarning', {
                detail: {
                    message: 'Hardware graphics acceleration is not active, so the game will ' +
                             'run very slowly. Updating your graphics driver, or enabling ' +
                             'hardware acceleration, will fix this.',
                    renderer: name,
                },
            }));
        }
    } catch { /* extension unavailable — nothing to report */ }
}

// Resolution scale. Rendering at native ratio on a high-DPI Windows laptop can
// mean 2.25x the pixels of a 1080p panel for no visual gain in a blocky game,
// so this is exposed as a setting and multiplied into the device pixel ratio.
let _resScale = 1.0;

function _applyPixelRatio() {
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(Math.max(0.3, dpr * _resScale));
}

function _loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed: ${url}`));
        img.src = url;
    });
}

// Texels along a side of a block texture. Textures of another size (the
// model sheets, a pack's 16-pixel art) are scaled to it, without smoothing.
const BLOCK_TEX_SIZE = 32;

async function _buildBlockTextureArray() {
    const SIZE = BLOCK_TEX_SIZE;
    const N    = _texLayers.length;
    const data = new Uint8Array(N * SIZE * SIZE * 4);
    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    // getImageData runs once per texture layer; the hint keeps the canvas on a
    // CPU-readable backing so each readback isn't a GPU round trip.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < N; i++) {
        try {
            const img = await _loadImage(_texLayers[i]);
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
            console.warn('[world] Missing block texture:', _texLayers[i]);
        }
    }

    // Each layer's average colour (over its opaque texels), for far terrain.
    _texAverages = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        let r = 0, g = 0, b = 0, w = 0;
        for (let p = i * SIZE * SIZE * 4, end = p + SIZE * SIZE * 4; p < end; p += 4) {
            const a = data[p + 3] / 255;
            r += data[p] * a; g += data[p + 1] * a; b += data[p + 2] * a; w += a;
        }
        if (w > 0) { _texAverages[i * 3] = r / w / 255; _texAverages[i * 3 + 1] = g / w / 255; _texAverages[i * 3 + 2] = b / w / 255; }
        else _texAverages[i * 3] = _texAverages[i * 3 + 1] = _texAverages[i * 3 + 2] = -1;
    }

    // A vertex names its texture layer in one byte (engine/MeshFormat.js).
    if (N > NO_LAYER) {
        console.error(`[world] ${N} block texture layers; only the first ${NO_LAYER} can be drawn`);
    }

    // Each layer is one tile of a texture that repeats, so the sampler wraps
    // it and the shaders hand it tile coordinates as they are. That is what
    // makes mipmaps possible (wrapping the coordinate by hand, with fract(),
    // breaks the derivatives they are chosen from at every block edge), and
    // without them detailed textures crawl and sparkle in the distance. Up
    // close texels stay crisp (nearest); far off they are averaged.
    const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, N);
    tex.format     = THREE.RGBAFormat;
    tex.type       = THREE.UnsignedByteType;
    tex.wrapS      = THREE.RepeatWrapping;
    tex.wrapT      = THREE.RepeatWrapping;
    tex.minFilter  = THREE.LinearMipmapLinearFilter;
    tex.magFilter  = THREE.NearestFilter;
    tex.generateMipmaps = true;
    // Ground seen at a shallow angle — most of it — stays sharp further out.
    tex.anisotropy = Math.min(4, renderer?.capabilities.getMaxAnisotropy() ?? 1);
    tex.needsUpdate = true;
    return tex;
}

const SKY_COLOR = 0x87CEEB;

// Camera far plane, in blocks. Fixed rather than derived from render distance:
// the far plane should never be what removes geometry from view — fog is. This
// is generous enough for the maximum render distance (16 chunks = 256 blocks,
// ~362 diagonal) with a lot of headroom to spare.
//
// If you push this much further for a long-range view mode, watch depth
// precision: it is governed by the far/near ratio, and near is only 0.1 because
// the camera sits inside the player's own AABB. The lever at that point is
// `logarithmicDepthBuffer: true` on the WebGLRenderer, not a bigger far value.
const CAMERA_FAR = 4096;

// Fog range as a fraction of the render distance in blocks.
const FOG_START = 0.82;   // fully clear inside this (default; the Fog Distance graphics setting)
const FOG_END   = 1.00;   // fully fogged here — the nearest the load edge can be
const FOG_MIN_FADE = 12;  // blocks; any narrower and the fade reads as a hard edge
let _fogStart   = FOG_START;

// Shared by both chunk materials so a single write updates the whole terrain.
let chunkUniforms = null;
// Held so _disposeAll can release it — it is rebuilt on each world load.
let _blockTexArray = null;
// Average colour of each texture layer (r, g, b; −1 for an empty layer).
let _texAverages = null;

/**
 * The colour far terrain draws each block id with, 3 floats an id: its top
 * texture's average where it has one (a textured face is white × texture),
 * else its top colour. Leaves a little darker: a crown seen from afar is
 * mostly shade. Sent to the workers at init (farPalette).
 */
function _farPalette(reg) {
    const defs = reg.serialize();
    const max = defs.reduce((m, d) => Math.max(m, d.id), 0);
    const P = new Float32Array((max + 1) * 3);
    for (const d of defs) {
        const layer = _faceMap[d.id]?.top ?? -1;
        let c = d.topColor ?? d.color ?? [0.5, 0.5, 0.5];
        if (layer >= 0 && _texAverages && _texAverages[layer * 3] >= 0) {
            c = [_texAverages[layer * 3], _texAverages[layer * 3 + 1], _texAverages[layer * 3 + 2]];
        }
        const k = d.leaves || /LEAVES/.test(d.name) ? 0.8 : 1;
        P[d.id * 3] = c[0] * k; P[d.id * 3 + 1] = c[1] * k; P[d.id * 3 + 2] = c[2] * k;
    }
    return P;
}

/** The far-terrain material (FarTerrain.js), on the shared chunk uniforms. */
function _makeFarMaterial(farUniforms) {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { ...chunkUniforms, ...farUniforms },
        vertexShader: FAR_VERT, fragmentShader: FAR_FRAG,
    });
}

// Far terrain: how many chunks of it lie beyond the render distance (0 = off,
// the Far Terrain graphics setting), and the tiles for the current world.
let _farExtra = 0;
let _far = null;
// Block light for chunks that have none (almost all of them): never sampled,
// since uBlockY's height is 0, but a sampler3D needs something bound.
let _noBlockLight = null;

// Block light's colour at full strength: warm firelight.
const TORCH_COLOR = [1.0, 0.7, 0.4];
// With Eye Adaptation, how far past white the bright texels of glowing blocks
// go (display value) — a torch flame, a lantern's glass, a lamp's panes.
const GLOW_HDR = 2.6;

function _createChunkMaterials(texArray) {
    _blockTexArray = texArray;
    _noBlockLight = _emptyLightTexture(0);
    chunkUniforms = {
        uTex:        { value: texArray },
        uFogNear:    { value: 160 },
        uFogFar:     { value: 280 },
        uBrightness: { value: 1.0 },
        uColorMode:  { value: 0 },
        uTorchColor:   { value: new THREE.Vector3(...TORCH_COLOR) },
        uTorchFlicker: { value: 1 },
        uHandLight:    { value: new THREE.Vector4(0, 0, 0, 0) },
        uGlowBoost:    { value: 1 },
        uSelect:       { value: new THREE.Vector4(0, 0, 0, 0) },
        // Texture layer that sways in the wind (leaves).
        uSwayLayer:  { value: BLOCK_FACE_MAP[7]?.top ?? -10 },
        uSwayRange:  { value: new THREE.Vector2(_swayRange[0], _swayRange[1]) },
        // Shared with the shadow mapper, so a Shadows change reaches all terrain.
        ..._shadows.uniforms,
        // Shared with the atmosphere: time of day, weather, fog, clouds.
        ..._atmos.uniforms,
    };
    _perDraw = _perDrawUniforms(chunkUniforms);
    _makePrimers();
    // Water and ice never cast shadows.
    _shadows.setTextures(texArray, _blockReg.serialize().filter(b => b.render === 'translucent').map(b => _faceMap[b.id]?.top));
    // The materials themselves are per chunk (_chunkLight), built on these uniforms.

    _applyViewDistance();
}

/**
 * How far the view reaches, in chunks: the render distance, and the far
 * terrain beyond it while that is on. FarTerrain covers the square out to one
 * chunk past this from the player's chunk, so from anywhere in that chunk it
 * reaches at least this far along both axes — the same guarantee the chunks
 * give without it, which the fog below relies on.
 */
function _viewChunksOut() { return _renderDist + (_far?.active ? _farExtra : 0); }

/**
 * Derive fog and the camera far plane from the render distance.
 *
 * Fog previously ran from a fixed 160..280 while chunks loaded to 12 chunks
 * (192 blocks) and the camera clipped at 512, so terrain simply ended in mid-air
 * and the far plane was mostly wasted. Tying all three together means a lower
 * render distance fades out cleanly instead of showing a hard edge — which is
 * what makes a cheaper default viable.
 */
function _applyViewDistance() {
    // With far terrain the view reaches past the chunks, to the end of it.
    const blocks = _viewChunksOut() * CHUNK_SIZE;
    // ChunkManager loads every chunk within the render distance of the
    // player's chunk on both axes, so from anywhere inside that chunk the
    // loaded square reaches at least `blocks` along x and z. The chunk shader
    // measures fog so that it is complete by then in every direction
    // (edgeDistance), which shows everything loaded without ever showing its
    // edge. Only the last stretch fades: starting earlier hid world the player
    // had already paid to generate.
    const far  = blocks * FOG_END;
    const near = Math.min(blocks * _fogStart, far - FOG_MIN_FADE);

    if (chunkUniforms) {
        chunkUniforms.uFogNear.value = near;
        chunkUniforms.uFogFar.value  = far;
    }
    // Entities use Lambert materials and still read scene.fog. The atmosphere
    // pulls it in further each frame when the weather is foggy.
    if (scene?.fog) { scene.fog.near = near; scene.fog.far = far; }
    if (_atmos) { _atmos.baseFogNear = near; _atmos.baseFogFar = far; }

    // camera.far is deliberately NOT touched here. It is a fixed CAMERA_FAR set
    // once at camera creation. Scaling it with render distance clipped the far
    // corners of the outermost chunks — a chunk centred at the render radius
    // extends past it diagonally — and it would fight any future long-range
    // view mode. Fog, not the far plane, is what limits how far you can see.
}

/** Push the display settings that are now shader-side rather than CSS-side. */
function _applyDisplaySettings(brightness, colorblind) {
    if (!chunkUniforms) return;
    chunkUniforms.uBrightness.value = brightness ?? 1.0;
    chunkUniforms.uColorMode.value =
        colorblind === 'protanopia'   ? 1 :
        colorblind === 'deuteranopia' ? 2 :
        colorblind === 'tritanopia'   ? 3 : 0;
}

// ── Selection + break state ───────────────────────────────────────────────────

let _selBlock    = null;   // the block under the crosshair ({ x, y, z }), which glows (uSelect); null: none
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
let _spawnHome    = true;  // the ground spawn under way is at the world's spawn (not beside another player)
let _worldSpawn   = null;  // { x, z } — where this player first landed at the world's spawn; kept with their state

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
// The controller's two triggers stand in for the two mouse buttons (see _padButtons).
let _padBreak = false, _padUse = false;
// How fast the right stick turns the camera when pushed all the way, in
// radians a second, at Look Sensitivity 1.0.
const PAD_LOOK_RATE = 2.6;
let _bowDrawing = false;
let _bowCharge  = 0;      // 0..1, fills while holding right-click with bow

// ── Keyboard ──────────────────────────────────────────────────────────────────

const KEYS = {};

// ── Initialization ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');

    scene            = new THREE.Scene();
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog        = new THREE.Fog(0x87CEEB, 160, 280);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, CAMERA_FAR);

    // The chunk shaders are GLSL3 and sample a sampler2DArray, so WebGL2 is
    // required. Fail loudly here rather than rendering a black screen later.
    if (!_checkWebGL2(canvas)) return;

    // powerPreference matters a lot on Windows laptops with switchable graphics:
    // without it the browser may bind the integrated GPU for the whole session.
    //
    // preserveDrawingBuffer is deliberately NOT set. It forces the compositor to
    // retain the back buffer every frame on many drivers. World screenshots are
    // taken by capturing the canvas in the same task as the render instead —
    // see _render() / _capturePendingScreenshot().
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        powerPreference: 'high-performance',
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    _applyPixelRatio();
    _warnIfSoftwareRenderer();

    // Opaque objects front to back. Three.js sorts by material before depth, to
    // save material switches — but every chunk has its own material (for its
    // light texture), so that order was just the order chunks were created in.
    // Nearest first lets the GPU reject hidden fragments before shading them,
    // and the chunk fragment shader is the expensive part of a frame.
    renderer.setOpaqueSort((a, b) =>
        (a.groupOrder - b.groupOrder) || (a.renderOrder - b.renderOrder) || (a.z - b.z) || (a.id - b.id));

    ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xfffaed, 0.90);
    sunLight.position.set(0.6, 1.0, 0.4).normalize();
    scene.add(sunLight);

    // Chunk materials are created per chunk once the block texture atlas is
    // built (startWorldLoad → _createChunkMaterials, then _chunkLight).
    scene.add(chunkGroup);

    _shadows = new ShadowMapper(renderer);
    _shadows.setLevel(_gfx.shadows);
    _shadows.onCull = _cullChunks;   // chunks inside the shadow box, not the view
    _atmos = new Atmosphere(scene);
    _atmos.setSkyMode(_gfx.sky);
    _atmos.setCloudLevel(_gfx.clouds);
    _atmos.setParticleScale(PARTICLE_LEVELS[_gfx.particles] ?? 0.6);
    _atmos.setVolume(_gfx.weatherVolume);
    _atmos.setReduceMotion(_gfx.reduceMotion);
    _atmos.onStrike = _onLightningStrike;
    _post = new PostFX(renderer);
    _post.setEnabled(_gfx.eyeAdaptation);
    if (_gfx.eyeAdaptation && !_post.supported) console.warn('[world] Eye Adaptation needs float render targets; off');
});

// ── World load event ──────────────────────────────────────────────────────────

document.addEventListener('WorldJS_startWorldLoad', async (e) => {
    const {
        gamepackData = {}, worldId = null, worldSeed = null, worldName = '',
        playerPos = null, gameMode = 'SURVIVAL', terrainStyle = 'blocky',
        daylightCycle = true, weather = 'dynamic', worldGen = 1, flat = null,
        guest = false, stateKey = '', stateKeyOld = '', workers = 0, online: viaOnline = false, pvp = true,
    } = e.data ?? {};
    // A load takes a few seconds and waits on the network, the workers and the
    // textures; the world can be left, and another begun, while it does. Each
    // wait is followed by a look at whether this load is still the one wanted.
    const token = ++_loadToken, stale = () => token !== _loadToken;
    _warming = performance.now();   // nothing is drawn until the shaders are ready (_prepareShaders)
    _guest = !!guest;
    _worldName = String(worldName || '');
    _stateKey = _guest ? String(stateKey || 'guest') : '';
    _pvp = pvp !== false;
    _lanOpen = false;
    // An online game somebody else hosts: the room is in hand already (Online.js), and it is the only way to the world.
    _remote = !!viaOnline && !!online.session && online.remote;
    _gamepack = gamepackData;
    _pendingSig = '';
    _chests = new Map();
    _chestsDirty = false;
    _otherPos.length = 0;
    // Where this world's players start, and come back to (see _worldHome).
    _homeFlat = flat;
    _home = null;
    _worldSpawn = null;      // (the saved state, read below, says where it is if it was ever found)

    _gameMode = gameMode;
    _terrainStyle = terrainStyle === 'smooth' ? 'smooth' : 'blocky';
    _worldGen = worldGen;

    // Reset survivals stats to safe defaults; will be overwritten by saved state below.
    me.health = 100;
    me.hunger = 100;
    me.energy = 100;

    _blockReg = buildRegistryFromGamePack(gamepackData);
    _extendBlockTextures(_blockReg);
    _itemReg  = buildItemRegistryFromGamePack(gamepackData);
    _itemToBlock = _buildItemToBlock(gamepackData.blocks ?? []);

    worldState = new WorldState();
    if (worldSeed != null) worldState.seed = worldSeed;

    _smooth    = _terrainStyle === 'smooth' ? new SmoothTerrain(worldState, _blockReg) : null;
    _physics   = new PlayerPhysics(worldState, _blockReg);
    _physics.smooth = _smooth;
    _inventory = new Inventory(100);
    _inventory.setItemRegistry(_itemReg);

    _water    = new WaterSimulator(worldState, _blockReg);
    _water.onChange = _waterChanged;
    // What water takes away is left lying — in the world's own game: every game works the water out, and one flower is one flower.
    _water.onWash = (x, y, z, id) => { if (!_guest) _dropItems(_blockReg.get(id), { x: x + 0.5, y: y + 0.4, z: z + 0.5 }); };
    _shapes   = _blockReg.shapes;
    _ticking.clear(); _waterDirty.clear(); _sleepers.clear();
    _bedSpawn = null; _burnT = 0; _rest = null; _sleepT = 0;
    worldState.onEdit = _onBlockEdit;
    _crafting = new CraftingSystem();
    _crafting.loadRecipes(gamepackData.recipes ?? []);

    _entities = new EntityManager(worldState, _blockReg, _itemReg, scene);
    // Mobs are lit by the sky light where they stand and by the time of day.
    _entities.lightAt = _lightAt;
    _entities.seen = _mobSeen;      // and only posed where they, or their shadows, can be seen
    _entities.keeper = !_guest;     // the owner's game keeps the mobs that are left behind, with the world
    _entities.onSound = (name, at, o) => (name === 'step' ? _mobStep(at, o) : sound.play(name, { at, ...o }));
    _sounds = new GameSounds();
    _particles = new Particles(scene, (x, y, z) => !!worldState && _pointBlocked(x, y, z));
    _particles.setLevel(_gfx.particles);
    _particles.wind = _atmos.wind;      // debris blows in the weather's wind
    _savedAtmos = null;
    _entities.smooth = _smooth;
    await _entities.loadModels();   // mob textures, so the first mob of a kind does not wait for them
    if (stale()) return;
    _entities.loadEntityTypes(gamepackData.entities ?? []);
    if (!_physics) return;          // quitWorld raced the textures
    _playerModel = new PlayerModel(_entities.models, _skin);
    scene.add(_playerModel.mesh);
    // The hands in first person (Hands.js) are put away for now: they did not look right.
    if (SHOW_HANDS) { _hands = new Hands(_entities.models); _hands.setSkin(_skin); }
    _entities.extraCasters.push((out, o) => _playerModel.caster(out, o));
    _camDist = 0;
    _entities.setBiomeData(gamepackData.biomes ?? []);

    // Expose inventory on window.me so main.js can read it
    window.me.inventory = _inventory;

    // Build block texture atlas and create shader materials before workers start
    const texArray = await _buildBlockTextureArray();
    if (stale()) return;
    _createChunkMaterials(texArray);

    const workerUrl = new URL('./workers/worldWorker.js', import.meta.url);
    // A further pane of a split screen shares the machine's cores with the others.
    workerPool = new WorkerPool(workerUrl, workers > 0 ? workers : undefined);
    await workerPool.init({
        seed:          worldState.seed,
        blockRegistry: _blockReg.serialize(),
        biomes:        gamepackData.biomes ?? [],
        blockFaceMap:  _faceMap,
        terrainStyle:  _terrainStyle,
        terrain:       gamepackData.terrain ?? [],
        worldGen:      _worldGen,
        farPalette:    _farPalette(_blockReg),
        flat,                                    // a Flat world's settings, or null
    });
    if (stale()) return;

    chunkManager = new ChunkManager(worldState, workerPool, _renderDist);
    chunkManager.worldId = worldId;
    chunkManager.smooth  = _terrainStyle === 'smooth';
    chunkManager.onMeshReady        = _onMeshReady;
    chunkManager.onLightReady       = _onLightReady;
    chunkManager.onChunkUnload      = _onChunkUnload;
    chunkManager.onChunkLoaded      = _onChunkLoaded;

    if (worldId && _remote) {
        // The host's world: its chunks, and this player's place in it, come through the room.
        worldClient = online.worldClient(worldState);
        await worldClient.fetchManifest();
        if (stale()) return;
        chunkManager.worldClient = worldClient;
        _autoSaveTimer = setInterval(() => { _saveAll(); _savePlayerState(); }, AUTO_SAVE_MS);
        const state = await online.session?.loadState();
        if (stale()) return;
        if (state) _applyPlayerState(state);
    } else if (worldId) {
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
        if (stale()) return;

        // Load saved player state if available
        try {
            const res = await fetch(_stateUrl(worldId));
            if (res.ok) {
                let state = await res.json();
                // Nothing under who this player is: their place may be kept under what they were called (it was, once).
                if (!state && _guest && stateKeyOld && stateKeyOld !== _stateKey) {
                    state = await (await fetch(`${SERVER_URL}/api/worlds/${worldId}/player-state?player=${encodeURIComponent(stateKeyOld)}`)).json().catch(() => null);
                }
                if (state) _applyPlayerState(state);
                if (!_guest) _savedAtmos = state?.atmosphere ?? null;
            }
        } catch { /* server offline */ }
        // What other players changed in chunks this game never had loaded, last time.
        if (!_guest) await _loadPendingEdits(worldId);
        // What is in the world's chests (its owner's game keeps them).
        if (!_guest) await _loadChests(worldId);
        if (!_guest) await _loadOps(worldId);
        // … and its mobs, where they were when it was last left.
        if (!_guest) await _loadMobs(worldId);
    }

    if (stale() || !_physics) return; // guard if quitWorld raced

    // Whoever else is playing this world (a second pane of a split screen, a
    // guest from the network): join them — or be the first, whom they join.
    // Before any chunk is asked for: what the others have built is put down
    // as each chunk arrives, and has to be known by then.
    let hostAt = null;
    if (worldId) {
        const welcome = await _joinSession(worldId, viaOnline ? online.session : null);
        if (stale() || !_physics) return;
        if (welcome && !_mp.isHost) {
            if (welcome.atmos) _savedAtmos = welcome.atmos;
            const s = welcome.players?.find(p => p.id === welcome.hostId)?.state;
            if (Array.isArray(s)) hostAt = { x: s[0], y: s[1], z: s[2] };
        }
        if (!welcome && _guest) {
            // A guest has no game without the host's. (Turned away — sent off earlier, or the game is full — they are told which.)
            window.dispatchEvent(new CustomEvent('ww_sessionClosed', { detail: { reason: ['kicked', 'full'].includes(_joinRefused) ? _joinRefused : 'unreachable' } }));
            return;
        }
    }

    // Low-detail land beyond the chunks (Graphics → Far Terrain).
    _far = new FarTerrain(scene, workerPool, _makeFarMaterial);
    _far.setDistance(_farExtra);
    _applyViewDistance();
    _farEditsOut = new Map();
    if (worldId && !_remote) _loadFarEdits(worldId);

    // Time of day and weather: carried on from the save, with the world's
    // Daylight Cycle and Weather settings from its world.json.
    _atmos.startWorld({
        seed: worldState.seed, biomes: gamepackData.biomes ?? [], world: worldState,
        saved: _savedAtmos, daylightCycle, weather, worldGen: _worldGen, flat,
    });

    await _prepareShaders();
    if (stale()) return;
    _warmShaders();
    _warming = 0;
    _post?.resetAdaptation();

    _spawnPending = false;
    _loadGateDone = false;   // re-gate the loading screen for this world
    if (me.position && me.position.fromSave) {
        // Returning player — keep their saved position.
        me.position = { x: me.position.x, y: me.position.y, z: me.position.z };
    } else if (hostAt) {
        // Someone new to a game under way starts beside whoever is hosting it
        // (which is not where they come back to if they die: that is the world's).
        _beginGroundSpawn(hostAt.x, hostAt.z, false);
    } else if (_guest && (playerPos?.x || playerPos?.z)) {
        // … or, with no word yet of where the host is, on good land near
        // where the world's owner last was (`playerPos`: the world's record of it).
        const near = _goodLandNear(playerPos.x, playerPos.z);
        _beginGroundSpawn(near.x, near.z, false);
    } else {
        // Fresh spawn — drop onto the ground once terrain loads, at the
        // world's spawn (_worldHome).
        const home = _worldHome();
        _beginGroundSpawn(home.x, home.z);
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
                '— terrain:', _terrainStyle, '— workers:', workerPool.workerCount);
});

/**
 * Draw, while the loading screen is up, everything the world can show later,
 * so every shader is ready before it is needed. A shader is only finished —
 * ANGLE turns it into a Direct3D shader — on the first draw that uses it, and
 * that took 100–550 ms on integrated graphics: a frozen frame the first time
 * the player looked at a block (the selection outline), a mob appeared, an
 * item dropped, or it rained, struck lightning or formed a tornado. Compiling
 * ahead (renderer.compile) is not enough; it has to be a real draw. Hidden
 * objects are shown and empty instanced ones given one instance for a single
 * render clipped to one pixel, then everything is put back.
 */
/**
 * A world's shaders, made ready in the background while it loads
 * (KHR_parallel_shader_compile, through compileAsync), before anything of it
 * is drawn: the frames drawn behind the loading screen used to compile each
 * as they first met it, the page waiting on every one — the terrain's two
 * half a second each, the clouds and the shadows a few tenths more, about
 * three seconds of a page that did not move. `_warmShaders` then draws them
 * once (ANGLE finishes a shader on its first draw), with nothing left to wait for.
 */
async function _prepareShaders() {
    if (!renderer) return;
    const extra = [...(_entities?.warmupObjects() ?? []), ..._warmChunkMeshes(), ...(_far?.warmupObjects() ?? [])];
    for (const o of extra) scene.add(o);
    const jobs = [];
    try {
        // For the target they will really draw into (see _warmShaders).
        const post = !!_post?.active;
        if (post) _post.begin();
        jobs.push(renderer.compileAsync(scene, camera));
        if (_hands) jobs.push(renderer.compileAsync(_hands.scene, _hands.camera));
        renderer.setRenderTarget(null);
        if (_atmos) jobs.push(_atmos.compileAsync(renderer, camera));
        if (_post) jobs.push(_post.compileAsync());
        if (_shadows) jobs.push(_shadows.compileAsync());
    } catch (e) {
        console.warn('[world] shaders not made ready in the background:', e?.message ?? e);
    } finally {
        renderer.setRenderTarget(null);
        for (const o of extra) {
            scene.remove(o);
            if (o.userData.warmupGeometry) o.geometry.dispose();
        }
    }
    // Never a load held up for good by one that does not say it is done.
    await Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, 8000))]);
}

function _warmShaders() {
    if (!renderer) return;
    const undo = [];
    const set = (obj, prop, value) => { undo.push([obj, prop, obj[prop]]); obj[prop] = value; };
    const extra = [...(_entities?.warmupObjects() ?? []), ..._warmChunkMeshes(), ...(_far?.warmupObjects() ?? [])];
    for (const o of extra) scene.add(o);
    scene.traverse((o) => {
        if (!o.material) return;
        if (!o.visible) set(o, 'visible', true);
        if (o.frustumCulled) set(o, 'frustumCulled', false);   // wherever it is, draw it
        // Nothing is drawn for zero instances, which would leave the shader cold.
        if (o.isInstancedMesh && o.count === 0) set(o, 'count', 1);
        if (o.geometry?.isInstancedBufferGeometry && o.geometry.instanceCount === 0) set(o.geometry, 'instanceCount', 1);
    });
    // With Eye Adaptation the scene is drawn into PostFX's linear target, and
    // Three.js's own materials compile differently for a target than for the
    // canvas — so warm them for the one they will really draw into.
    const post = !!_post?.active;
    try {
        if (post) {
            _post.begin();
            _post.target.scissor.set(0, 0, 1, 1);
            _post.target.scissorTest = true;
            renderer.setRenderTarget(_post.target);   // picks up the target's scissor
        }
        if (_atmos) _atmos.uniforms.uLinearOut.value = post;
        renderer.setScissorTest(true);
        renderer.setScissor(0, 0, 1, 1);
        renderer.render(scene, camera);
    } finally {
        renderer.setScissorTest(false);
        if (post) { _post.target.scissorTest = false; renderer.setRenderTarget(null); }
        if (_atmos) _atmos.uniforms.uLinearOut.value = false;
        for (let i = undo.length - 1; i >= 0; i--) { const [obj, prop, value] = undo[i]; obj[prop] = value; }
        for (const o of extra) {
            scene.remove(o);
            if (o.userData.warmupGeometry) o.geometry.dispose();
        }
    }
    _atmos?.warm(renderer, camera);
    _post?.warm();
}

/**
 * One triangle each with the opaque and transparent chunk materials, laid out
 * like a real chunk mesh, so the chunk shaders are warmed too — the transparent
 * one in particular would otherwise first draw whenever
 * water or leaves first come into view. The materials are kept in chunkLights
 * under a private key, so they live until the world is left and Three.js never
 * drops the programs in between.
 */
function _warmChunkMeshes() {
    if (!chunkUniforms) return [];
    const mats = _chunkLight('__warmup');
    const geo = _chunkTriangle(true);
    const meshes = [new THREE.Mesh(geo, mats.opaque), new THREE.Mesh(geo, mats.transparent)];
    for (const m of meshes) m.userData.warmupGeometry = true;   // freed after the warm-up draw
    return meshes;
}

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
    // Where they first stood in this world, which is where dying brings them back to.
    if (Number.isFinite(state.spawn?.x) && Number.isFinite(state.spawn?.z)) {
        _worldSpawn = { x: Math.floor(state.spawn.x), z: Math.floor(state.spawn.z) };
    }
    const b = state.bed;
    if (b && [b.x, b.y, b.z].every(Number.isInteger)) _bedSpawn = { x: b.x, y: b.y, z: b.z };
}

// ── Quit event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_quitWorld', () => {
    _loadToken++;                 // a load still under way stops at its next step
    _warming = 0;
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;

    const client = worldClient;   // capture before nulling so we can flush + close it
    _saveAll();                   // queues the final chunk save onto the socket
    _savePlayerState();
    _saveChests();
    _saveMobs();
    for (const done of [..._chestWaits.values()]) done(null);
    _chatShow({ kind: 'clear' });                 // what was said in this world stays in it
    _otherPos.length = 0;
    // Release mob geometries, sprite materials and item textures before the
    // scene is torn down; these are GPU-side and are not reclaimed by GC alone.
    _mp?.close();
    if (_mp && _mp === online.session) online.release();
    _mp = null;
    _reader?.close();
    _reader = null;
    _others?.dispose();
    _others = null;
    _playerModel?.dispose();
    _playerModel = null;
    _hands?.dispose();
    _hands = null;
    _entities?.dispose();
    _sounds?.end();
    _sounds = null;
    _particles?.dispose();
    _particles = null;
    _atmos?.endWorld();
    _far?.dispose();
    _far = null;
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
    _smooth = null;
    _terrainStyle = 'blocky';
    _worldGen = 1;

    // Drop the HUD's cached handles and last-written values so the next world
    // starts from a clean slate rather than skipping writes that look unchanged.
    _hud.ready = false;
    _loadGateDone = false;
    _viewFrustumValid = false;
    _visDirty = true; _visUrgent = false; _visAt = -1;
    _visCx = _visCz = _visSec = NaN;
});

// ── Tick event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    // While the loading screen is up, report how much of the area around the
    // player has finished meshing so main.js can gate the reveal + drive the bar.
    if (!_loadGateDone) _reportLoadGate();

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);
    // The pause menu stops the world — when it is this player's alone. With
    // others in it, or open for others to come into (the network, online), one
    // player's pause menu stops nothing.
    _paused = !!e.data?.paused && !_shared();

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) { _saveAll(); _savePlayerState(); }
    _wasLocked = isLocked;

    if (_isDead) {
        // The mobs go on (the ones this game runs are other players' to meet
        // too): as for a spectator — nobody for them to mind here, nothing
        // spawned, nothing picked up, and those beside another player handed over.
        if (_atmos) _entities.lightDir = _atmos.state.lightDir;
        _entities.update(dt, me.position, _inventory, 'SPECTATOR');
        _updatePlayerModel(dt); _mpTick(dt); _render();
        return;
    }

    // Waiting for a ground spawn: keep loading terrain around the spawn column and
    // hold the player frozen above it until a surface is found.
    if (_spawnPending) {
        _tryGroundSpawn();
        _mpTick(dt);
        _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
        _updateCamera();
        chunkManager.update(me.position, _camFwd, { x: 0, z: 0 });
        _updateHUD();
        _render();
        return;
    }

    // Paused, alone: nothing moves. Not the player, the mobs, the water, the
    // clock or the weather (_render gives the atmosphere no time), and nothing
    // is mined, eaten or hungered for. The land goes on loading, and the frame
    // is drawn. (Only the clock used to stop: a player in the pause menu could
    // drown, be struck by a mob, or come back to night.)
    if (_paused) {
        _sounds?.miningStopped();
        _updateCamera();
        chunkManager.update(me.position, _camFwd, { x: 0, z: 0 });
        _updateHUD();
        _render();
        return;
    }

    // Build input object for physics. Movement keys are only honoured while the
    // pointer is locked to the game — when paused or in a menu the character
    // must not respond to WASD / Space. A controller needs no lock: while it
    // is the device in use and the game is being played, gamepad.js says so
    // (`play`) and gives what its sticks and buttons ask for.
    const pad = window.__wwPad;
    const padPlay = !!pad?.play;
    const controlsActive = padPlay || document.pointerLockElement === document.getElementById('GameScreen');
    if (padPlay) {
        // The right stick turns at a rate, so unlike the mouse it is scaled by dt.
        const rate = PAD_LOOK_RATE * _sensMult * dt;
        yaw   -= pad.lookX * rate;
        pitch -= pad.lookY * rate * (_invertY ? -1 : 1);
        pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    }
    _padButtons(padPlay && pad.breakHeld, padPlay && pad.useHeld);
    const fwd      = _horizontalForward();
    const rightDir = { x: fwd.z, z: -fwd.x };
    const input = {
        forward:  controlsActive && !!KEYS['KeyW'],
        backward: controlsActive && !!KEYS['KeyS'],
        left:     controlsActive && !!KEYS['KeyA'],
        right:    controlsActive && !!KEYS['KeyD'],
        jump:     controlsActive && (!!KEYS['Space'] || (padPlay && pad.jump)),
        // Shift, either one: crouch, and go down when flying. (It was Ctrl, and
        // Ctrl with W held — walking forward — is what closes a window.)
        sneak:    controlsActive && (!!KEYS['ShiftLeft'] || !!KEYS['ShiftRight'] || !!KEYS['KeyQ'] || (padPlay && pad.sneak)),
        // Sprinting: the movement key that is held was tapped twice (_sprintKey).
        sprint:   controlsActive && ((_sprintKey && _moveKeyHeld()) || (padPlay && pad.sprint)),
        moveF:    padPlay ? pad.moveF : 0,
        moveR:    padPlay ? pad.moveR : 0,
        fwd,
        rightDir,
    };

    _applyWeatherToPlayer();
    _pushPlayer();
    // Sitting or lying down nothing moves the player but getting up (_restTick).
    const result = _rest ? (_restTick(input), RESTING) : _physics.update(me.position, input, dt, _gameMode, {
        hunger: me.hunger, energy: me.energy,
    });
    const lying = _rest?.kind === 'lie';

    // The feet go up a slope's edge, or down onto one, in no time; the eyes
    // follow over a tenth of a second or so.
    _crouch += ((_physics.crouching ? 1 : 0) - _crouch) * (1 - Math.exp(-dt * 14));
    _eyeEase = Math.max(-0.7, Math.min(0.7, _eyeEase - _physics.stepped)) * Math.exp(-dt * EYE_EASE);
    if (Math.abs(_eyeEase) < 0.002) _eyeEase = 0;

    if (result.fallDamage > 0) _applyDamage(result.fallDamage);
    if (result.fellIntoVoid)   _applyDamage(20);
    _tickSounds(dt, result, _physics.crouching);

    if (_gameMode === 'SURVIVAL') { _survivalTick(dt); _restRegen(dt); }
    _sleepTick(dt);

    if (!_rest) _checkSuffocation(dt);
    _sneakHeld = input.sneak;
    _tickWater(dt);
    _tickBlocks(dt);
    _burn(dt);
    _particles?.update(dt);
    // Mobs are shaded by the same sun or moon as the terrain.
    if (_atmos) _entities.lightDir = _atmos.state.lightDir;
    _entities.update(dt, me.position, _inventory, _gameMode);

    // Raycast for block targeting
    _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    const origin = _rest ? { ..._rest.eye } : { x: me.position.x, y: _eyeY(), z: me.position.z };
    // Against the ground as it is drawn: in a smooth world the look passes
    // over the part of a voxel that is cut away, to what is behind it.
    const hit    = raycast(worldState, _blockReg, origin, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, INTERACT_REACH, _inDrawn);
    // A block that is not a cube is met on one of its own faces, which need
    // not be a side of its voxel: the top of a slab, the leaf of a door. What
    // is put down against it goes by that face.
    if (hit) {
        const sh = _shapes.of(hit.blockId);
        if (sh) {
            const hx = origin.x + _camFwd.x * hit.t, hy = origin.y + _camFwd.y * hit.t, hz = origin.z + _camFwd.z * hit.t;
            const lift = sh.soft && _smooth && _smooth.isMesh(worldState.getBlock(hit.x, hit.y - 1, hit.z)) ? _smooth.topAt(hit.x, hit.y - 1, hit.z) - 1 : 0;
            const n = _shapes.faceAt(sh, worldState, hx, hy, hz, _camFwd.x, _camFwd.y, _camFwd.z, lift);
            if (n) hit.face = { x: n[0], y: n[1], z: n[2] };
        }
    }
    // Ground met from above, under ground: the look went through the open part
    // of the voxel over it and came to that voxel's own surface, which on a
    // diagonal slope lies a little under it. It is that block that is looked at.
    if (hit && _smooth && hit.face.y === 1) {
        const over = worldState.getBlock(hit.x, hit.y + 1, hit.z);
        if (_smooth.isMesh(over)) { hit.y += 1; hit.blockId = over; }
    }

    // Mob targeting — check before block so mobs in front of walls are hit correctly.
    // One behind a wall is not in reach at all: the wall is. (The ray to the
    // mob took no notice of blocks, so a mob could be struck through them.)
    let mobHit = _entities?.getClosestMobInRay(origin, _camFwd, INTERACT_REACH) ?? null;
    if (mobHit && !_clearSight(origin.x, origin.y, origin.z, _camFwd.x, _camFwd.y, _camFwd.z, mobHit.t)) mobHit = null;
    // Another player, where players can hurt each other: the same rules — in reach, in plain sight, nearer than any mob.
    let foe = _pvp && _gameMode !== 'SPECTATOR' ? _otherInRay(origin, _camFwd, INTERACT_REACH) : null;
    if (foe && ((mobHit && mobHit.t <= foe.t) || !_clearSight(origin.x, origin.y, origin.z, _camFwd.x, _camFwd.y, _camFwd.z, foe.t))) foe = null;
    if (foe) mobHit = null;
    if (_strikeHold > 0) _strikeHold = Math.max(0, _strikeHold - dt);

    // Bow draw start / zoom — must run before placement so the bow has first
    // priority on _rightJust (placement would otherwise always consume it).
    const isBowSelected = _bowItemSelected();
    if (!isBowSelected && _bowDrawing) { _bowDrawing = false; _bowCharge = 0; }
    if (_rightJust && isBowSelected) { _bowDrawing = true; _bowCharge = 0; _rightJust = false; _sounds?.bowDraw(); }
    if (_bowDrawing) _handleBowDraw(dt);
    _bowZoom = _bowDrawing;

    // Block breaking only when no mob is targeted — nor for a moment after a
    // blow has landed on one: with the button still down, the block behind a
    // mob that had just fallen was being mined before the player had let go.
    // If the head is buried inside a mineable block, dig that block out first
    // (lets you escape being stuck).
    // (Lying in bed, nothing is mined or put down: the eyes are not over the feet, and the hands are under the blanket.)
    const headHit = _rest ? null : _mineableHeadBlock();
    _handleBreaking(dt, mobHit || foe || _strikeHold > 0 || lying ? null : (headHit ?? hit));
    _handlePlacement(lying ? null : hit);
    _handleEating(dt);
    _handleAttackCharge(dt, mobHit, mobHit || foe ? null : hit, foe);

    // Where the player is looking at, for the third-person camera to aim at too.
    const aim = mobHit ? mobHit.t : foe ? foe.t : hit ? hit.t : AIM_FAR;
    _aimDist += (aim - _aimDist) * (1 - Math.exp(-dt * 10));
    _updatePlayerModel(dt);
    _mpTick(dt);

    // What is under the crosshair glows: the mob, or else the block.
    _entities.highlight = mobHit ? mobHit.mob : null;
    _selBlock = !mobHit && !foe && hit ? hit : null;

    _updateCamera();
    chunkManager.update(me.position, _camFwd, { x: fwd.x, z: fwd.z });
    _updateHUD();

    // Fade vignette
    if (_damageFade > 0) _damageFade = Math.max(0, _damageFade - dt * 1.5);

    _render();
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

// Radians of rotation per unit of mouse movement at slider position 1.0.
// Minecraft's equivalent is 0.15 degrees per count; this is a little slower.
const BASE_RAD_PER_COUNT = 0.0018;

// Mouse look.
//
// Rotation is applied as events arrive rather than accumulated and flushed per
// frame: the renderer reads yaw/pitch at draw time, so everything since the last
// frame is already integrated, and deferring would only add latency. Nothing
// here is scaled by dt — camera movement should track the mouse exactly, not the
// frame clock, which is what keeps it stable when frame times vary.
//
// The mapping from slider to radians is deliberately linear. Minecraft applies a
// cubic response curve, which does give nicer fine control at low settings, but
// adding one would silently change what every existing saved sensitivity value
// means — and would make a raised setting *faster*, not calmer.
document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== document.getElementById('GameScreen')) return;
    const sensitivity = BASE_RAD_PER_COUNT * _sensMult;
    yaw   -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity * (_invertY ? -1 : 1);
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
});

// Player display/control settings pushed from main.js (cosmetic + control only).
let _sensMult  = 1.0;
let _invertY   = false;
let _baseFov   = 75;
let _renderDist = 8;

// Graphics settings for the effect modules (Shadows.js, Atmosphere.js, Particles.js).
// Kept here because the modules are created later than settings first arrive.
const _gfx = {
    shadows: 'off', clouds: 'fast', particles: 'medium', sky: 'simple',
    weatherVolume: 0.8, reduceMotion: false, eyeAdaptation: false,
};
let _shadows   = null;   // ShadowMapper — lives as long as the renderer
let _atmos     = null;   // Atmosphere (day cycle, weather, sky, clouds) — likewise
let _post      = null;   // PostFX (Eye Adaptation + bloom) — likewise
let _particles = null;   // Particles — per world
let _savedAtmos = null;  // the atmosphere part of the loaded player state
let _paused    = false;  // the pause menu is up: the clock and the weather stand still


document.addEventListener('WorldJS_applySettings', (e) => {
    const s = e.data ?? {};
    if (s.sensitivity != null) _sensMult = s.sensitivity;
    if (s.invertY     != null) _invertY  = !!s.invertY;
    if (s.fov         != null) _baseFov  = s.fov;
    if (s.renderDistance != null) {
        _renderDist = s.renderDistance;
        if (chunkManager) chunkManager.renderDistance = _renderDist;
        _applyViewDistance();
    }
    if (s.farTerrain != null) {
        _farExtra = Math.max(0, s.farTerrain | 0);
        _far?.setDistance(_farExtra);
        _applyViewDistance();
    }
    if (s.resolutionScale != null) {
        _resScale = s.resolutionScale;
        _applyPixelRatio();
    }
    if (s.brightness != null || s.colorblind != null) {
        _applyDisplaySettings(s.brightness, s.colorblind);
    }
    if (s.shadows != null)   { _gfx.shadows = s.shadows;     _shadows?.setLevel(s.shadows); }
    if (s.clouds != null)    { _gfx.clouds = s.clouds;       _atmos?.setCloudLevel(s.clouds); }
    if (s.sky != null)       { _gfx.sky = s.sky;             _atmos?.setSkyMode(s.sky); }
    if (s.particles != null) {
        _gfx.particles = s.particles;
        _particles?.setLevel(s.particles);
        _atmos?.setParticleScale(PARTICLE_LEVELS[s.particles] ?? PARTICLE_LEVELS.medium);
    }
    if (s.weatherVolume != null) { _gfx.weatherVolume = s.weatherVolume; _atmos?.setVolume(s.weatherVolume); }
    sound.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, ambience: s.ambienceVolume });
    // Every change of any setting comes through here: only a new look is a new body.
    if (s.skin && JSON.stringify(s.skin) !== JSON.stringify(_skin)) {
        _skin = { ...s.skin };
        if (_playerModel) scene.add(_playerModel.setSkin(_skin));
        _hands?.setSkin(_skin);
        _mp?.profile(_playerName, _skin, _playerKey);
    }
    if (typeof s.playerKey === 'string') _playerKey = s.playerKey;
    if (typeof s.playerName === 'string' && s.playerName !== _playerName) { _playerName = s.playerName; _mp?.profile(_playerName, _skin, _playerKey); }
    if (s.reduceMotion != null)  { _gfx.reduceMotion = !!s.reduceMotion; _atmos?.setReduceMotion(s.reduceMotion); }
    if (s.fogStart != null) {
        _fogStart = s.fogStart;
        _applyViewDistance();
    }
    if (s.eyeAdaptation != null) {
        const on = s.eyeAdaptation === true || s.eyeAdaptation === 'on';
        if (on !== _gfx.eyeAdaptation) {
            _gfx.eyeAdaptation = on;
            _post?.setEnabled(on);
            // Materials now draw into a different kind of target: compile them
            // for it now rather than on the first frame.
            if (worldState && chunkUniforms) _warmShaders();
        }
    }
});

// World Settings → Daylight Cycle / Weather / Time of Day, applied live.
document.addEventListener('WorldJS_setAtmosphere', (e) => {
    const d = e.data ?? {};
    if (!_atmos) return;
    if (d.daylightCycle != null) _atmos.setDaylightCycle(d.daylightCycle);
    if (d.weather != null)       _atmos.setWeatherMode(d.weather, !!d.immediate);
    if (Number.isFinite(d.hours)) _atmos.setHours(d.hours);
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

/**
 * The controller's triggers as the mouse buttons: the right one breaks and
 * attacks, the left one places, uses, eats and draws a bow. Called every tick
 * with whether each is held; a change does what the mouse button going down or
 * coming up does above.
 */
function _padButtons(breakHeld, useHeld) {
    if (breakHeld !== _padBreak) {
        _padBreak = breakHeld;
        MOUSE.left = breakHeld;
        if (!breakHeld) { _breakTarget = null; _breakProgress = 0; }
    }
    if (useHeld !== _padUse) {
        _padUse = useHeld;
        MOUSE.right = useHeld;
        if (useHeld) _rightJust = true;
        else {
            if (_bowDrawing) _fireBow();
            _bowDrawing = false;
            _bowCharge  = 0;
        }
    }
}

// The controller's shoulder buttons: one hotbar slot along, either way.
window.addEventListener('ww_padHotbar', (e) => {
    _hotbarSlot = (_hotbarSlot + (e.detail?.step ?? 1) + 10) % 10;
    window.dispatchEvent(new CustomEvent('ww_hotbarChange', { detail: { slot: _hotbarSlot } }));
});

// ── Keyboard ──────────────────────────────────────────────────────────────────

// Sprinting is a movement key tapped twice — whichever one is walked on — and
// lasts until every movement key is let go. (It was Left Shift; Shift is now
// only crouching.)
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
const SPRINT_TAP_MS = 300;       // the second press within this of the first
let _sprintKey = false;
const _lastTap = {};             // movement key → when it last went down (ms)
const _moveKeyHeld = () => MOVE_KEYS.some(k => KEYS[k]);

document.addEventListener('keydown', (e) => {
    if (MOVE_KEYS.includes(e.code) && !e.repeat && !e.target?.closest?.('input, textarea')) {
        const now = performance.now();
        if (now - (_lastTap[e.code] ?? -1e9) < SPRINT_TAP_MS) _sprintKey = true;
        _lastTap[e.code] = now;
    }
    KEYS[e.code] = true;
    // Hotbar number keys (1–0 for slots 0–9)
    // (Not while a number is being typed somewhere: the chat, a search box.)
    const digit = e.target?.closest?.('input, textarea') ? null : e.code.match(/^Digit(\d)$/);
    if (digit) {
        const n = parseInt(digit[1]);
        _hotbarSlot = n === 0 ? 9 : n - 1;
        window.dispatchEvent(new CustomEvent('ww_hotbarChange', { detail: { slot: _hotbarSlot } }));
    }
    // A screenshot (F2): the frame as it is, without the menus and the HUD.
    if (e.code === 'F2' && !e.repeat && worldState) { e.preventDefault(); _takeScreenshot(); }
    // Inventory toggle
    // The view: first person, from behind, from in front.
    if ((e.code === 'F5' || e.code === 'KeyV') && !e.repeat && worldState &&
        (e.code === 'F5' || document.pointerLockElement === document.getElementById('GameScreen'))) {
        e.preventDefault();
        _cycleCamera();
    }
    if (e.code === 'KeyE' && document.pointerLockElement === document.getElementById('GameScreen')) {
        window.dispatchEvent(new CustomEvent('ww_toggleInventory'));
    }
    // Craft menu / creative inventory
    if (e.code === 'KeyC' && document.pointerLockElement === document.getElementById('GameScreen')) {
        window.dispatchEvent(new CustomEvent('ww_toggleCraftMenu', { detail: { gameMode: _gameMode } }));
    }
});

document.addEventListener('keyup', (e) => {
    KEYS[e.code] = false;
    if (!_moveKeyHeld()) _sprintKey = false;
});

// ── Block / mob selection outlines ───────────────────────────────────────────

// The block under the crosshair has no outline: it glows, in the chunk shader
// (selectGlow), so what lights up is the block as it is drawn — in a smooth
// world a piece of ground, not the cube round it. (It was a black wire box,
// which on a slope stood half in the air.) Brighter as the block is mined.
const SELECT_GLOW = 1;          // at rest
const SELECT_GLOW_MINED = 1.6;  // more, by the time it breaks
let _selPulse = 0;

/** Tell the chunk shaders which block glows, from where the camera now is. Called once a frame, before drawing. */
function _updateSelectUniform(dt) {
    if (!chunkUniforms) return;
    const u = chunkUniforms.uSelect.value, s = _isDead || _shooting ? null : _selBlock;
    if (!s) { u.w = 0; return; }
    _selPulse += dt;
    const mined = _breakTarget && _breakTarget.x === s.x && _breakTarget.y === s.y && _breakTarget.z === s.z ? _breakProgress : 0;
    // A slow breath, so it reads as a light and not as paint; steady with Reduce Motion.
    const breath = _gfx.reduceMotion ? 1 : 0.88 + 0.12 * Math.sin(_selPulse * 3.2);
    u.set(s.x - camera.position.x, s.y - camera.position.y, s.z - camera.position.z,
        (SELECT_GLOW + SELECT_GLOW_MINED * mined) * breath);
}

/**
 * Is the point inside what is drawn of the block it is in? A Mesh voxel of a
 * smooth world is cut to a shape; a block with a model (a slab, a door, a
 * flower) is the boxes its model says the crosshair meets.
 */
function _inDrawn(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const id = worldState.getBlock(bx, by, bz);
    const sh = _shapes?.of(id);
    if (sh) {
        // A plant on smooth ground stands on the ground's surface, a little under its own voxel.
        const lift = sh.soft && _smooth && _smooth.isMesh(worldState.getBlock(bx, by - 1, bz)) ? _smooth.topAt(bx, by - 1, bz) - 1 : 0;
        return _shapes.pointIn(sh, worldState, x, y, z, false, lift);
    }
    return _smooth?.isMesh(id) ? _smooth.pointInMesh(x, y, z) : true;
}

// ── Block breaking ────────────────────────────────────────────────────────────

function _handleBreaking(dt, hit) {
    // Count down the creative mining cooldown regardless of target state.
    if (_creativeMineCD > 0) _creativeMineCD = Math.max(0, _creativeMineCD - dt);

    if (!MOUSE.left || !hit) {
        _sounds?.miningStopped();
        if (MOUSE.left && _camMode !== 0) _swingArm();     // a swing at the air
        if (_breakTarget) {
            _breakTarget   = null;
            _breakProgress = 0;
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

    // A tool is quick at what it is for and no better than a hand at the
    // rest: a pickaxe at stone, an axe at wood, a shovel at earth (the block's
    // `tool`). Its speed used to count on every block, so a gold pickaxe went
    // through logs and dirt twelve times as fast as a hand.
    let miningSpeed = block.tool && heldDef?.subtype === block.tool ? (heldDef.miningSpeed ?? 1.0) : 1.0;
    if (needsTool && !hasCorrectTool) miningSpeed = 0.3;  // penalty for wrong/no tool

    _breakProgress += dt * miningSpeed / Math.max(hardness, 0.05);
    _sounds?.mining(dt, block, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
    _swingArm();

    if (_breakProgress >= 1.0) {
        _breakBlock(hit, hasCorrectTool);
        _breakTarget   = null;
        _breakProgress = 0;
    }
}

function _breakBlock(hit, hasCorrectTool = true) {
    if (!worldState || !chunkManager) return;
    const block = _blockReg.get(hit.blockId);
    // Debris takes the light of the air it flies into, so it is dark in a cave.
    const dl = _lightAt(hit.x + 0.5 + (hit.face?.x ?? 0), hit.y + 0.5 + (hit.face?.y ?? 1), hit.z + 0.5 + (hit.face?.z ?? 0));
    const rgb = block.topColor ?? block.color ?? [0.5, 0.5, 0.5];
    _particles?.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, [rgb[0] * dl, rgb[1] * dl, rgb[2] * dl]);
    _sounds?.blockBroken(block, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
    // A bomb whose fuse is lit goes off in the hand that breaks it.
    if (block.tick === 'bomb') { _explode(hit.x, hit.y, hit.z); return; }
    const withIt = _clearBlock(hit.x, hit.y, hit.z);

    // Creative players don't collect broken blocks.
    if (_gameMode === 'CREATIVE') return;

    // Blocks with requiresTool drop nothing if broken with the wrong tool
    if (block.requiresTool && !hasCorrectTool) return;

    const at = { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 };
    _dropBlockItems(block, at);
    // What went with it (a door's other half, the rest of a painting) gives what it holds: a door
    // mined at its top is the door, and a painting is had by mining any piece of it.
    for (const d of withIt) if (d.drops?.length) _dropBlockItems(d, at);

    // Refresh the hotbar so collected blocks / updated stack counts show up.
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));
}

/**
 * Take the block at (x, y, z) away, with what goes with it: what was in it (a
 * chest spills, whoever breaks it and however), its other half (a door's top,
 * a bed's head — BlockRegistry `twin`; the other pieces of a painting several
 * blocks across — `group`), and whatever rested on any of them.
 * `byWorld`: it is the world's doing (a fire, a blast), not this player's hand.
 * Returns the definitions of what went with it (its other half, its other pieces).
 */
function _clearBlock(x, y, z, byWorld = false) {
    const id = worldState.getBlock(x, y, z);
    if (id === 0) return [];
    const def = _blockReg.get(id);
    _put(x, y, z, 0, byWorld);
    if (def.interactType === 'chest') _chestBroken(x, y, z);
    const withIt = [], also = [];
    if (def.twin) {
        const tx = x + def.twin[0], ty = y + def.twin[1], tz = z + def.twin[2];
        const t = _blockReg.get(worldState.getBlock(tx, ty, tz));
        if (t.twin && tx + t.twin[0] === x && ty + t.twin[1] === y && tz + t.twin[2] === z) { _put(tx, ty, tz, 0, byWorld); withIt.push(t); also.push([tx, ty, tz]); }
    }
    for (const o of def.group ?? []) {
        const px = x + o[0], py = y + o[1], pz = z + o[2], t = _blockReg.get(worldState.getBlock(px, py, pz));
        if (t.id !== 0 && t.piece === def.piece) { _put(px, py, pz, 0, byWorld); withIt.push(t); also.push([px, py, pz]); }
    }
    for (const [px, py, pz] of also) _breakUnsupported(px, py, pz, byWorld);
    _breakUnsupported(x, y, z, byWorld);
    return withIt;
}

/** Set one block and have its chunk drawn again. `byWorld`: see _worldSet. */
function _put(x, y, z, id, byWorld = false) {
    if (byWorld) { _worldSet([x, y, z, id]); return; }
    worldState.setBlock(x, y, z, id);
    chunkManager?.markEdited(x, z);
}

/**
 * The block at (x, y, z) is gone: anything resting on it or hanging from it
 * (BlockRegistry `support` — torches, plants, ladders, a door) comes down too,
 * and drops.
 */
function _breakUnsupported(x, y, z, byWorld = false) {
    for (const [dx, dy, dz] of NEIGHBOURS_6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const id = worldState.getBlock(nx, ny, nz);
        const sup = id > 0 ? _blockReg.get(id).support : null;
        if (!sup || nx + sup[0] !== x || ny + sup[1] !== y || nz + sup[2] !== z) continue;
        const def = _blockReg.get(id);
        const withIt = _clearBlock(nx, ny, nz, byWorld);
        if (_gameMode === 'CREATIVE') continue;
        const at = { x: nx + 0.5, y: ny + 0.3, z: nz + 0.5 };
        _dropItems(def, at);
        for (const d of withIt) if (d.drops?.length) _dropItems(d, at);
    }
}
const NEIGHBOURS_6 = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/** A broken block's drops, as dropped items in the world (they are not collected). */
function _dropItems(block, pos) {
    const drops = block.drops?.length ? block.drops
        : (_itemReg?.hasItem(block.name.toLowerCase()) ? [{ itemId: block.name.toLowerCase(), count: 1 }] : []);
    for (const drop of drops) {
        if (Math.random() > (drop.chance ?? 1)) continue;
        const itemId = drop.itemId ?? drop.item;
        if (itemId) _entities?.dropItem(pos, itemId, drop.count ?? 1);
    }
}

/** A mined block's drops, into the inventory (overflow is dropped at `dropPos`). */
function _dropBlockItems(block, dropPos) {
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
    if (!_inventory) return;
    const held = _inventory.getHotbar(_hotbarSlot);
    const itemDef = held ? _itemReg?.getItem(held.itemId) ?? null : null;

    // What is looked at is used, before anything is put down against it —
    // unless the player sneaks, which is how a torch goes on a door.
    if (hit && !_sneakHeld) {
        // Interactive block: open UI instead of placing
        if (_blockReg.isInteractable(hit.blockId)) {
            const block = _blockReg.get(hit.blockId);
            window.dispatchEvent(new CustomEvent('ww_openInteractive', {
                detail: { interactType: block.interactType, x: hit.x, y: hit.y, z: hit.z },
            }));
            return;
        }
        const target = _blockReg.get(hit.blockId);
        if (target.use && _useBlock(target, hit, held, itemDef)) { window.dispatchEvent(new CustomEvent('ww_itemPickup')); return; }
    }
    // What is held does what it is for (a bucket, a map, flint and steel).
    if (itemDef?.use && _useItem(itemDef, hit)) { window.dispatchEvent(new CustomEvent('ww_itemPickup')); return; }
    if (!hit || !held) return;

    // Food is consumed via hold — don't place anything on right-press
    if (itemDef?.type === 'food') return;

    // Resolve which block this item places (by block name, then reverse of the
    // block's drop list). Returns null for non-block items (tools, ingots, …).
    // Then which of its kind goes down, and where: a torch for the face
    // clicked, a stair turned the way the player looks, a door and its top.
    const put = _placementFor(_itemToBlock.get(held.itemId), hit);
    if (!put) return;
    for (const b of put) {
        if (!b?.def) return;
        const there = worldState.getBlock(b.x, b.y, b.z);
        // Only where there is room: air, water, or what water would take (a flower).
        if (!b.merge && !_replaceable(there)) return;
        // What water takes cannot go into water: a torch, a plant.
        if (b.def.wash && _blockReg.isLiquid(there)) return;
        // What rests on a block, or hangs on one, needs one that can hold it.
        const sup = b.def.support;
        if (sup && !_holds(worldState.getBlock(b.x + sup[0], b.y + sup[1], b.z + sup[2]))) return;
        // Not where somebody is standing: this player, another, or a mob. (Only
        // this player was looked for, and only their middle: a block could be
        // put down round a mob or another player, shutting them in it.) A torch,
        // a lantern or water fills no space, and may go anywhere.
        if (!_blockReg.isNoCollision(b.def.id) && _someoneIn(b.x, b.y, b.z)) return;
    }

    for (const b of put) {
        worldState.setBlock(b.x, b.y, b.z, b.def.id);
        // A chest put down is an empty one, whatever stood here before.
        if (b.def.interactType === 'chest') _chestPlaced(b.x, b.y, b.z);
        chunkManager?.markEdited(b.x, b.z);
    }
    _sounds?.blockPlaced(put[0].def, { x: put[0].x + 0.5, y: put[0].y + 0.5, z: put[0].z + 0.5 });
    _swingArm();

    if (_gameMode !== 'CREATIVE') {
        _inventory.removeItem(held.itemId, 1);
        window.dispatchEvent(new CustomEvent('ww_itemPickup'));
    }
}

/** Can a new block go where this one is: air, water, or what water would take (a flower, a torch)? */
function _replaceable(id) { return id === 0 || _blockReg.isLiquid(id) || _blockReg.get(id).wash; }
/** Can this block hold up what stands on it or hangs from it: anything with a body? */
function _holds(id) { return id !== 0 && !_blockReg.isNoCollision(id); }
/** Where the look met the block it is on. */
function _hitPoint(hit) {
    return { x: me.position.x + _camFwd.x * hit.t, y: _eyeY() + _camFwd.y * hit.t, z: me.position.z + _camFwd.z * hit.t };
}

/**
 * Which blocks go down, and where, when `def` is placed against `hit`'s face:
 * a list of { def, x, y, z } — the first is the block itself — or null if it
 * cannot go there. `merge` on one says it takes the place of what is there
 * (the other half of a slab).
 *
 * A block with no say in it is itself, in the block the face looks into. One
 * with a `placement` table (a torch, a ladder, a painting) is the entry for
 * the face clicked, and needs something there that can hold it. One with
 * `place` (BlockRegistry) goes by its mode:
 *   slab      the lower half on a floor, the upper under a ceiling, and on a
 *             wall whichever the look landed on; against its other half, a
 *             whole block
 *   wallslab  against the wall clicked; on a floor, the half looked at
 *   stairs    up the way the player looks; upside down under a ceiling or on
 *             the upper part of a wall
 *   look      turned the way the player looks (`back`: toward them)
 *   door      and its top, in the block above
 *   bed       its foot here and its head a block further on
 */
function _placementFor(def, hit) {
    if (!def || hit.within) return null;
    const f = hit.face;
    const x = hit.x + f.x, y = hit.y + f.y, z = hit.z + f.z;
    const side = f.y > 0 ? 'floor' : f.y < 0 ? 'ceiling' : f.x > 0 ? 'east' : f.x < 0 ? 'west' : f.z > 0 ? 'south' : 'north';
    const named = (n) => (n ? _blockReg.getByName(n) ?? null : null);
    const at = (d, px = x, py = y, pz = z, merge = false) => ({ def: d, x: px, y: py, z: pz, merge });
    const p = def.place;
    if (!p) {
        if (!def.placement) return [at(def)];
        if (!_holds(hit.blockId)) return null;
        return [at(named(def.placement[side]))];
    }
    const hp = _hitPoint(hit), look = facingOf(_camFwd.x, _camFwd.z);
    const hitDef = _blockReg.get(hit.blockId), thereDef = _blockReg.get(worldState.getBlock(x, y, z));
    switch (p.mode) {
        case 'slab': {
            const upper = side === 'ceiling' || (side !== 'floor' && hp.y - y > 0.5);
            const half = (d) => (d.name === p.bottom ? 1 : d.name === p.top ? 2 : 0);
            // On the open face of its other half, or into the block that half is in: a whole block.
            if ((side === 'floor' && half(hitDef) === 1) || (side === 'ceiling' && half(hitDef) === 2)) return [at(named(p.full), hit.x, hit.y, hit.z, true)];
            if (half(thereDef) === (upper ? 1 : 2)) return [at(named(p.full), x, y, z, true)];
            return [at(named(upper ? p.top : p.bottom))];
        }
        case 'wallslab': {
            const facing = f.y === 0 ? OPPOSITE[side] : facingOf(hp.x - (x + 0.5), hp.z - (z + 0.5));
            const mine = (d) => Object.values(p.names).includes(d.name);
            if (f.y === 0 && mine(hitDef) && hitDef.facing === OPPOSITE[side]) return [at(named(p.full), hit.x, hit.y, hit.z, true)];
            if (mine(thereDef) && thereDef.facing === OPPOSITE[facing]) return [at(named(p.full), x, y, z, true)];
            return [at(named(p.names[facing]))];
        }
        case 'stairs': {
            const down = side === 'ceiling' || (side !== 'floor' && hp.y - y > 0.5);
            return [at(named((down ? p.down : p.up)[look]))];
        }
        case 'look':
            return [at(named(p.names[p.back ? OPPOSITE[look] : look]))];
        case 'door': {
            if (!_replaceable(worldState.getBlock(x, y + 1, z))) return null;
            // Which side it is hung on: away from a door beside it the same way
            // round, so the two open as a pair; else the side of the block the
            // look landed on. (Its hinge is on its left — BlockShapes LEFT_OF —
            // unless it is hung on the right.)
            const left = FACING_DIR[LEFT_OF[look]];
            const doorAt = (dx, dz) => { const o = _blockReg.get(worldState.getBlock(x + dx, y, z + dz)); return o.model === 'door' && o.facing === look; };
            const right = doorAt(left[0], left[1]) ? true : doorAt(-left[0], -left[1]) ? false
                : (hp.x - (x + 0.5)) * left[0] + (hp.z - (z + 0.5)) * left[1] < 0;
            if (right && p.lowerRight) return [at(named(p.lowerRight[look])), at(named(p.upperRight[look]), x, y + 1, z)];
            return [at(named(p.lower[look])), at(named(p.upper[look]), x, y + 1, z)];
        }
        case 'painting': {
            // On a wall, facing out of it: a picture of the size, chosen at
            // random, its pieces to the right of the block clicked and up from
            // it as whoever looks at it sees them (centred on it, the bigger ones).
            if (f.y !== 0 || !p.pictures?.length) return null;
            const names = p.pictures[Math.floor(Math.random() * p.pictures.length)][side];
            const r = FACING_DIR[LEFT_OF[side]], i0 = Math.floor((p.w - 1) / 2), j0 = Math.floor((p.h - 1) / 2);
            const out = [];
            for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
                out.push(at(named(names?.[j * p.w + i]), x + r[0] * (i - i0), y + j - j0, z + r[1] * (i - i0)));
            }
            return out;
        }
        case 'bed': {
            const d = FACING_DIR[look], hx = x + d[0], hz = z + d[1];
            if (!_holds(worldState.getBlock(x, y - 1, z)) || !_holds(worldState.getBlock(hx, y - 1, hz))) return null;
            return [at(named(p.foot[look])), at(named(p.head[look]), hx, y, hz)];
        }
    }
    return [at(def)];
}

/**
 * The player uses the block they are looking at (BlockRegistry `use`): a door
 * opens, a cake is eaten, a bed is slept in. `held` is what is in their hand.
 * Returns whether that was the end of it; false leaves the click to whatever
 * else it could mean (putting down what is held).
 */
/**
 * Something that is opened and shut — a door, a gate, a curtain, a painting
 * turned to its next picture — has just become `to`. A door or a gate has a
 * sound of its own each way (`use.sound`: door_open, gate_close …, made by
 * tools/gen_sounds.mjs); anything else knocks as what it is made of does.
 */
let _toggleHeard = 0;
function _toggleSound(def, to, at, volume) {
    const now = performance.now();
    if (now - _toggleHeard < 60) return;           // a door's other half, a painting's other pieces: one sound
    _toggleHeard = now;
    const name = def.use?.sound ? `${def.use.sound}_${to?.shape?.open ? 'open' : 'close'}` : '';
    if (name && sound.has(name)) sound.play(name, { at, volume, vary: 0.05 });
    else sound.play(`${blockSoundFamily(def)}_place`, { at, volume: volume * 0.7, pitch: to?.shape?.open ? 0.9 : 1.1 });
}

function _useBlock(def, hit, held, itemDef) {
    const u = def.use, { x, y, z } = hit;
    const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const set = (px, py, pz, name) => {
        const d = name === 'AIR' ? { id: 0 } : _blockReg.getByName(name);
        if (!d) return false;
        _put(px, py, pz, d.id);
        return true;
    };
    const give = (itemId) => {
        const over = _inventory.addItem(itemId, 1) ?? 1;
        if (over > 0) _entities?.dropItem(at, itemId, over);
    };
    const survival = _gameMode !== 'CREATIVE';
    // Something that starts a fire: flint and steel, or a torch.
    const lights = itemDef?.use === 'ignite' || held?.itemId === 'torch';

    if (u.toggle) {
        // A door, a gate, a curtain; and its other half with it. A gate swings
        // away from whoever opens it (`away`: opened toward its back).
        let to = u.toggle;
        if (u.away && def.facing) {
            const d = FACING_DIR[def.facing];
            if ((me.position.x - (x + 0.5)) * d[0] + (me.position.z - (z + 0.5)) * d[1] > 0) to = u.away;
        }
        if (!set(x, y, z, to)) return false;
        if (def.twin) {
            const tx = x + def.twin[0], ty = y + def.twin[1], tz = z + def.twin[2];
            const t = _blockReg.get(worldState.getBlock(tx, ty, tz));
            if (t.twin && t.use?.toggle) set(tx, ty, tz, t.use.toggle);
        }
        // The other pieces of a thing of several blocks (a painting): each to its own next.
        for (const o of def.group ?? []) {
            const px = x + o[0], py = y + o[1], pz = z + o[2], t = _blockReg.get(worldState.getBlock(px, py, pz));
            if (t.piece === def.piece && t.use?.toggle) set(px, py, pz, t.use.toggle);
        }
        _toggleSound(def, _blockReg.getByName(to), at, 0.8);
        _swingArm();
        return true;
    }
    if (u.eat) {
        // A piece of it — if there is room for it.
        const more = me.hunger < 100 || (u.eat.health && me.health < 100);
        if (survival && !more) return true;
        me.hunger = Math.min(100, me.hunger + (u.eat.hunger ?? 0));
        me.energy = Math.min(100, me.energy + (u.eat.energy ?? 0));
        if (u.eat.health) me.health = Math.min(100, me.health + u.eat.health);
        set(x, y, z, u.eat.to ?? 'AIR');
        sound.play('eat', { volume: 0.8 });
        return true;
    }
    if (u.sleep) { _lieDown(def, hit); return true; }
    if (u.sit) { _sitDown(def, hit); return true; }
    if (u.plate) {
        // Food, put on a plate.
        const name = held ? u.plate[held.itemId] : null;
        if (!name || !set(x, y, z, name)) return false;
        if (survival) _inventory.removeItem(held.itemId, 1);
        _eatHold = true;                     // the button is still down: that is not a bite of the next one
        sound.play('glass_place', { at, volume: 0.45 });
        return true;
    }
    if (u.unplate) {
        // … and taken off it again.
        if (!set(x, y, z, u.to)) return false;
        if (survival) give(u.unplate);
        sound.play('glass_place', { at, volume: 0.35, pitch: 1.2 });
        return true;
    }
    if (u.pot) {
        // Something to plant in it.
        const name = held ? u.pot[held.itemId] : null;
        if (!name || !set(x, y, z, name)) return false;
        if (survival) _inventory.removeItem(held.itemId, 1);
        sound.play('grass_place', { at, volume: 0.5 });
        return true;
    }
    if (u.unpot) {
        if (!set(x, y, z, u.to)) return false;
        if (survival) give(u.unpot);
        return true;
    }
    if (u.light || u.ignite) {
        if (!lights || !set(x, y, z, u.light ?? u.ignite)) return false;
        sound.play('stone_hit', { at, volume: 0.6, pitch: 1.5 });
        _swingArm();
        return true;
    }
    if (u.cook) {
        // Raw meat held over the fire comes back cooked.
        const raw = held?.itemId ?? '', cooked = raw.startsWith('raw_') ? `cooked_${raw.slice(4)}` : '';
        if (!cooked || !_itemReg.hasItem(cooked)) return false;
        if (survival) _inventory.removeItem(raw, 1);
        give(cooked);
        sound.play('sand_step', { at, volume: 0.7, pitch: 1.6 });
        return true;
    }
    return false;
}

/**
 * What the item in hand does by itself (an item's `use`), wherever it is
 * pointed. Returns whether it did anything.
 */
function _useItem(itemDef, hit) {
    const survival = _gameMode !== 'CREATIVE';
    const swap = (from, to) => {
        if (!survival) return;
        _inventory.removeItem(from, 1);
        const over = _inventory.addItem(to, 1) ?? 1;
        if (over > 0) _entities?.dropItem({ ...me.position, y: me.position.y + 1 }, to, over);
    };
    switch (itemDef.use) {
        case 'map':
            window.dispatchEvent(new CustomEvent('ww_openMap'));
            return true;
        case 'bucket': {
            // Standing water under the crosshair is taken up. (The look goes through water otherwise.)
            const w = _lookAtWater();
            if (!w) return false;
            _put(w.x, w.y, w.z, 0);
            sound.play('water_swim', { at: { x: w.x + 0.5, y: w.y + 0.5, z: w.z + 0.5 }, volume: 0.7 });
            swap('bucket', 'water_bucket');
            _swingArm();
            return true;
        }
        case 'pour': {
            const src = _blockReg.getByName('WATER');
            if (!hit || hit.within || !src) return false;
            const x = hit.x + hit.face.x, y = hit.y + hit.face.y, z = hit.z + hit.face.z, there = worldState.getBlock(x, y, z);
            if (!_replaceable(there) || there === src.id) return false;
            _put(x, y, z, src.id);
            sound.play('water_splash', { at: { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, volume: 0.5 });
            swap('water_bucket', 'bucket');
            _swingArm();
            return true;
        }
        case 'ignite': {
            const fire = _blockReg.getByName('FIRE');
            if (!hit || hit.within || !fire) return false;
            const x = hit.x + hit.face.x, y = hit.y + hit.face.y, z = hit.z + hit.face.z, there = worldState.getBlock(x, y, z);
            if (!_replaceable(there) || _blockReg.isLiquid(there)) return false;
            // On something that will hold a flame: ground under it, or something beside it that burns.
            if (!_holds(worldState.getBlock(x, y - 1, z)) && !(_blockReg.get(hit.blockId).flammable > 0)) return false;
            _put(x, y, z, fire.id);
            sound.play('stone_hit', { at: { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, volume: 0.6, pitch: 1.5 });
            _swingArm();
            return true;
        }
    }
    return false;
}

/** The block of standing water the player is looking at, within reach, or null. */
function _lookAtWater() {
    const water = (id) => _blockReg.fluidOf(id) === FLUID_SOURCE;
    const reg = { isTargetable: (id) => water(id) || _blockReg.isTargetable(id), hasModel: (id) => _blockReg.hasModel(id) };
    const hit = raycast(worldState, reg, { x: me.position.x, y: _eyeY(), z: me.position.z }, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, INTERACT_REACH,
        (x, y, z) => water(worldState.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))) || _inDrawn(x, y, z));
    return hit && water(hit.blockId) ? hit : null;
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
    // Pass 2: reverse drops, without overriding a canonical name mapping —
    // nor for an item that is not put down (`placeable: false`: a ball of clay is not clay).
    for (const b of blocks) {
        const def = _blockReg.getByName(b.name);
        if (!def) continue;
        for (const drop of (b.drops ?? [])) {
            const id = drop.itemId ?? drop.item;
            if (id && !map.has(id) && _itemReg?.getItem(id)?.placeable !== false) map.set(id, def);
        }
    }
    return map;
}

// ── What the world does by itself ─────────────────────────────────────────────
//
// Water runs, fire spreads and burns out, a sapling becomes a tree, a lit bomb
// goes off. Three ways of sharing that between the games of one world:
//
//   Water     every game works it out for itself, from the same rules and the
//             same changes (WaterSimulator.js), and says nothing of it.
//   The rest  is run by ONE game — that of the player nearest the place — and
//             what it changes is told like any change to a block (_worldSet).
//             A game whose player is not the nearest only keeps track.
//
// What goes on is found by keeping track of the blocks that do something in
// time (BlockRegistry `tick`): they are noted as they are put down or come
// with a chunk, and forgotten as they go.

let _shapes = null;              // BlockShapes.ShapeSet: the blocks that are not cubes
let _sneakHeld = false;          // the sneak key is down (a click then puts down, and does not use)
let _burnT = 0;                  // seconds the player has stood in fire since it last hurt them
let _bedSpawn = null;            // { x, y, z }: the bed this player last lay in, where dying brings them back to
const _sleepers = new Map();     // the host's: player id → when they lay down (ms)
const _waterDirty = new Set();   // chunks the water changed in this frame
const _ticking = new Map();      // "x,y,z" → { x, y, z, id, kind, t }: blocks that do something in time
let _nextFuse = 0;               // the fuse of the next bomb lit, if not the usual (one set off by another)

const TICK_REACH   = 56;         // blocks from the player within which this game runs what goes on
const BOMB_FUSE    = 3.2;        // seconds
const BLAST_RADIUS = 3.4;        // blocks
const FIRE_MOST    = 140;        // fires burning at once near one player; past it, what burns just goes
const SAPLING_MEAN = 110;        // seconds a sapling takes, on average

/** The water has changed a block: its chunk is drawn again — and the one beside it, at an edge. */
function _waterChanged(x, y, z) {
    const cx = x >> CHUNK_SHIFT, cz = z >> CHUNK_SHIFT, lx = x & 15, lz = z & 15;
    const ex = lx === 0 ? -1 : lx === 15 ? 1 : 0, ez = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    _waterDirty.add(`${cx},${cz}`);
    if (ex) _waterDirty.add(`${cx + ex},${cz}`);
    if (ez) _waterDirty.add(`${cx},${cz + ez}`);
    if (ex && ez) _waterDirty.add(`${cx + ex},${cz + ez}`);
}

function _tickWater(dt, steps = 0) {
    if (!_water) return;
    const quiet = _mpApplying;
    _mpApplying = true;                  // not told: every game works the water out
    if (steps > 0) for (let i = 0; i < steps && _water.pending > 0; i++) _water.step();
    else _water.tick(dt);
    _mpApplying = quiet;
    if (_waterDirty.size === 0) return;
    for (const k of _waterDirty) {
        const c = k.indexOf(',');
        chunkManager?.markDirty(Number(k.slice(0, c)), Number(k.slice(c + 1)));
    }
    _waterDirty.clear();
}

/**
 * Run the water on by up to `steps` steps at once — for tests, and for looking
 * at it while the game is paused (when it stands still). Returns how many
 * blocks are still waiting to be looked at.
 */
window.__wwWaterRun = (steps = 1) => { _tickWater(0, steps); return _water?.pending ?? 0; };
/** What is being kept track of because it does something in time (fires, saplings, lit bombs) — for tests. */
window.__wwTicking = () => [..._ticking.values()].map(e => ({ x: e.x, y: e.y, z: e.z, kind: e.kind, t: Math.round(e.t * 100) / 100 }));

/** Have the sapling at (x, y, z) grow now, if there is room — for tests. Returns whether one is there. */
window.__wwGrow = (x, y, z) => { const e = _ticking.get(`${x},${y},${z}`); if (e?.kind !== 'sapling') return false; _grow(e); return true; };

/** A block changed, here, by anyone's doing (WorldState.onEdit). */
function _onBlockEdit(x, y, z, id) {
    _water?.touch(x, y, z);
    const kind = id ? _blockReg.get(id).tick : null;
    const k = `${x},${y},${z}`;
    if (kind) _ticking.set(k, { x, y, z, id, kind, t: kind === 'bomb' ? (_nextFuse || BOMB_FUSE) : 0.4 + Math.random() });
    else if (_ticking.size) _ticking.delete(k);
}

/** A chunk has come: its water goes on from where it was, and what does something in time is noted. */
function _onChunkLoaded(cx, cz, chunk) {
    _water?.scanChunk(chunk, cx, cz);
    if (!chunk.paletteHas((id) => !!_blockReg.get(id).tick)) return;
    const lo = Math.max(0, chunk.minFilledY | 0), hi = Math.min(CHUNK_SIZE_Y - 1, chunk.maxFilledY | 0);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let ly = lo; ly <= hi; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = chunk.getVoxel(lx, ly, lz);
        const kind = id ? _blockReg.get(id).tick : null;
        if (!kind) continue;
        const x = (cx << CHUNK_SHIFT) + lx, y = ly + WORLD_MIN_Y, z = (cz << CHUNK_SHIFT) + lz;
        _ticking.set(`${x},${y},${z}`, { x, y, z, id, kind, t: kind === 'bomb' ? BOMB_FUSE : 1 + Math.random() * 2 });
    }
}

/** Is this the game that runs what goes on at (x, z): its player the nearest to it, and near? */
function _mine(x, z) {
    const p = me.position, d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d > TICK_REACH * TICK_REACH) return false;
    const my = _myId();
    for (const o of _otherPos) {
        const od = (o.x - x) ** 2 + (o.z - z) ** 2;
        if (od < d || (od === d && o.id < my)) return false;
    }
    return true;
}

/**
 * Blocks the world itself changes — a fire, a blast, a tree grown — in the
 * game that runs it: [x, y, z, id, …]. They are told to the others like any
 * change. In an online game a guest's reach is judged by the host (a block a
 * guest changes must be near its player), and these are not near: a guest
 * sends them to the host's game in one piece, which does them and tells
 * everyone.
 */
function _worldSet(list) {
    const viaHost = _remote && _sessionUp() && !_mp.isHost;
    const quiet = _mpApplying;
    if (viaHost) _mpApplying = true;
    for (let i = 0; i + 3 < list.length; i += 4) {
        worldState.setBlock(list[i], list[i + 1], list[i + 2], list[i + 3]);
        chunkManager?.markEdited(list[i], list[i + 2]);
    }
    _mpApplying = quiet;
    if (viaHost) for (let i = 0; i < list.length; i += 800) _sayTo(_mp, _mp.hostId, { t: 'wset', c: list.slice(i, i + 800) });
}

/** The host's: a guest's game says what the world did near its player. */
function _worldSetFrom(from, d) {
    const o = _others?.map.get(from), c = d?.c;
    if (_guest || !o || !Array.isArray(c) || c.length > 800 || c.length % 4 !== 0 || !c.every(Number.isInteger)) return;
    for (let i = 0; i < c.length; i += 4) {
        const x = c[i], y = c[i + 1], z = c[i + 2], id = c[i + 3];
        if (Math.hypot(x - o.x, y - o.y, z - o.z) > REACH.FLUID || (id !== 0 && _blockReg.get(id).id !== id)) continue;
        worldState.setBlock(x, y, z, id);
        chunkManager?.markEdited(x, z);
    }
}

/** Once a frame: whatever is due among the blocks that do something in time. */
function _tickBlocks(dt) {
    if (_ticking.size === 0) return;
    for (const [k, e] of _ticking) {
        e.t -= dt;
        if (e.t > 0) continue;
        if (worldState.getBlock(e.x, e.y, e.z) !== e.id) { _ticking.delete(k); continue; }
        const mine = _mine(e.x, e.z);
        if (e.kind === 'bomb') {
            // Its fuse has run out: it goes off in the game that runs it — or in any, if that one has gone.
            if (mine || e.t < -3) { _ticking.delete(k); _explode(e.x, e.y, e.z); }
            continue;
        }
        if (!mine) { e.t = 1; continue; }
        if (e.kind === 'fire') { e.t = 0.5 + Math.random() * 0.5; _fireStep(e); }
        else if (e.kind === 'sapling') { e.t = 4 + Math.random() * 4; if (Math.random() < 6 / SAPLING_MEAN) _grow(e); }
        else if (e.kind === 'campfire') {
            // Heavy rain puts a fire in the open out.
            e.t = 3 + Math.random() * 2;
            if (_rainOn(e.x, e.y + 1, e.z) > 0.5 && Math.random() < 0.3) _put(e.x, e.y, e.z, _blockReg.getByName(_blockReg.get(e.id).use?.douse ?? '')?.id ?? e.id, true);
        } else e.t = 5;
    }
}

/** How hard it is raining on (x, y, z): 0 under a roof, or where it is dry. */
function _rainOn(x, y, z) {
    if (!_atmos || !(_atmos.rainHere > 0)) return 0;
    return _skyBrightnessAt(x + 0.5, y + 0.5, z + 0.5) >= 0.99 ? _atmos.rainHere : 0;
}

/** A fire, a moment on: it catches what will burn beside it, and in the end goes out. */
function _fireStep(e) {
    const { x, y, z } = e, fire = e.id, out = [];
    let fuel = false, wet = _rainOn(x, y, z) > 0.2;
    let fires = 0;
    for (const t of _ticking.values()) if (t.kind === 'fire') fires++;
    for (const [dx, dy, dz] of NEIGHBOURS_6) {
        const nx = x + dx, ny = y + dy, nz = z + dz, nid = worldState.getBlock(nx, ny, nz);
        if (nid === 0) continue;
        const nd = _blockReg.get(nid);
        if (nd.fluid) { wet = true; continue; }
        if (!(nd.flammable > 0)) continue;
        fuel = true;
        // Flames go up more readily than down.
        if (Math.random() >= nd.flammable / 100 * (dy > 0 ? 0.5 : dy < 0 ? 0.15 : 0.3)) continue;
        if (nd.use?.ignite) {                                  // a bomb: its fuse is lit
            const lit = _blockReg.getByName(nd.use.ignite);
            if (lit) out.push(nx, ny, nz, lit.id);
            continue;
        }
        // It burns: fire where it was — and its other half goes with it (a door).
        if (nd.interactType === 'chest') continue;
        if (nd.twin) out.push(nx + nd.twin[0], ny + nd.twin[1], nz + nd.twin[2], 0);
        out.push(nx, ny, nz, fires + out.length / 4 < FIRE_MOST ? fire : 0);
    }
    // Out: put out by water or rain, with nothing left to stand on, or burnt down.
    const stands = _holds(worldState.getBlock(x, y - 1, z));
    if (wet || (!stands && !fuel) || Math.random() < (fuel ? 0.05 : 0.28)) out.push(x, y, z, 0);
    if (out.length) _worldSet(out);
}

/** A sapling's time has come: a tree where it stood, if there is room for one. */
function _grow(e) {
    const def = _blockReg.get(e.id);
    const tree = treeBlocks(def.grows ?? '', _blockReg, (Math.imul(e.x, 73856093) ^ Math.imul(e.z, 19349663) ^ Math.imul(e.y, 83492791)) >>> 0);
    if (!tree || !_holds(worldState.getBlock(e.x, e.y - 1, e.z))) return;
    const leafy = (id) => id === 0 || _blockReg.get(id).leaves || _blockReg.get(id).wash;
    const out = [];
    for (let i = 0; i + 4 < tree.length; i += 5) {
        const x = e.x + tree[i], y = e.y + tree[i + 1], z = e.z + tree[i + 2], id = tree[i + 3], rule = tree[i + 4];
        const there = worldState.getBlock(x, y, z), self = x === e.x && y === e.y && z === e.z;
        if (rule === TREE_INTO_AIR) { if (there === 0) out.push(x, y, z, id); continue; }
        // The trunk: through air and leaves. Anything else in its way, and the tree waits.
        if (!self && !leafy(there)) { if (tree[i] === 0 && tree[i + 2] === 0) return; continue; }
        out.push(x, y, z, id);
    }
    if (out.length) _worldSet(out);
}

/** A bomb goes off at (x, y, z), in the game that runs it. */
function _explode(x, y, z, r = BLAST_RADIUS) {
    const out = [x, y, z, 0], chain = [], lost = [];
    const R = Math.ceil(r);
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
        if (!dx && !dy && !dz) continue;
        const px = x + dx, py = y + dy, pz = z + dz;
        // A ragged ball: the same one every time for one place.
        const rag = ((Math.imul(px, 374761393) ^ Math.imul(py, 668265263) ^ Math.imul(pz, 2147483647)) >>> 0) / 4294967296;
        if (Math.hypot(dx, dy, dz) > r - rag * 0.9) continue;
        const id = worldState.getBlock(px, py, pz);
        if (id === 0) continue;
        const def = _blockReg.get(id);
        if (def.fluid || def.name === 'BEDROCK' || def.tick === 'bomb') continue;
        if (def.use?.ignite) { chain.push(px, py, pz, def.use.ignite); continue; }      // another bomb: it goes off next
        if (def.interactType === 'chest') _chestBroken(px, py, pz);
        out.push(px, py, pz, 0);
        if (Math.random() < 0.25) lost.push(def, px, py, pz);
    }
    _worldSet(out);
    for (let i = 0; i < chain.length; i += 4) {
        const lit = _blockReg.getByName(chain[i + 3]);
        if (!lit) continue;
        _nextFuse = 0.25 + Math.random() * 0.45;
        _worldSet([chain[i], chain[i + 1], chain[i + 2], lit.id]);
        _nextFuse = 0;
    }
    // What stood on what is gone comes down; a few of the blocks are left lying.
    for (let i = 0; i < out.length; i += 4) _breakUnsupported(out[i], out[i + 1], out[i + 2], true);
    if (_gameMode !== 'CREATIVE') for (let i = 0; i < lost.length; i += 4) _dropItems(lost[i], { x: lost[i + 1] + 0.5, y: lost[i + 2] + 0.5, z: lost[i + 3] + 0.5 });
    // The mobs caught in it (a blow on one another game runs goes to that game).
    const c = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    for (const m of [...(_entities?._mobs.values() ?? [])]) {
        const d = Math.hypot(m.pos.x - c.x, m.pos.y + 0.6 - c.y, m.pos.z - c.z);
        if (d < r * 2) _entities.hitMob(m, 4 + 46 * (1 - d / (r * 2)) ** 1.5, c);
    }
    if (_sessionUp() && !_mp.alone) _mp.all({ t: 'boom', x, y, z, r });
    _boom(c.x, c.y, c.z, r);
}

/** A blast at (x, y, z), as every game has it: the noise, the dust, and what it does to this player. */
function _boom(x, y, z, r) {
    if (!worldState || ![x, y, z, r].every(Number.isFinite) || r > 16) return;
    const p = me.position, d = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
    // No recording of it: the weather's own thunder, made as it happens, for a strike this far off.
    if (!sound.play('explosion', { at: { x, y, z }, reach: 120 })) _atmos?.audio?.thunder(Math.max(4, d));
    const dl = _lightAt(x, y + 1, z);
    for (let k = 0; k < 7; k++) {
        const g = 0.2 + Math.random() * 0.25;
        _particles?.burst(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r, z + (Math.random() - 0.5) * r, [g * dl * 1.2, g * dl * 1.1, g * dl]);
    }
    const reach = r * 2.2;
    if (d >= reach || _isDead || _spawnPending) return;
    const k = 1 - d / reach;
    _applyDamage(70 * k ** 1.5);
    if (_physics && _gameMode === 'SURVIVAL' && !_isDead) {
        const h = Math.hypot(p.x - x, p.z - z) || 1;
        _physics.vel.x += (p.x - x) / h * 11 * k; _physics.vel.z += (p.z - z) / h * 11 * k;
        _physics.vel.y = Math.max(_physics.vel.y, 7 * k);
    }
}

/** Fire hurts whoever stands in it. */
function _burn(dt) {
    if (_gameMode !== 'SURVIVAL' || !worldState) { _burnT = 0; return; }
    const p = me.position, fx = Math.floor(p.x), fz = Math.floor(p.z);
    const tick = (y) => _blockReg.get(worldState.getBlock(fx, Math.floor(y), fz)).tick;
    const hot = (k) => k === 'fire' || k === 'campfire';
    if (!hot(tick(p.y + 0.2)) && !hot(tick(p.y - 0.1)) && tick(p.y + 1) !== 'fire') { _burnT = 0.35; return; }
    _burnT += dt;
    if (_burnT >= 0.5) { _burnT = 0; _applyDamage(5); }
}

// ── Sitting, and lying down ──────────────────────────────────────────────────
// A chair, a stool or a sofa is sat in, and a bed lain in, for real: the player
// is put there — on the seat, facing the way the chair does; on their back,
// their head on the pillow — and stays there, whatever the movement keys say,
// until they get up (Shift, or jump) or what they are on is taken away. They
// can look about meanwhile, and the others see them sitting or lying there
// (Players.js). (A bed used to pass the night with the player standing beside
// it, and a chair did nothing at all.)
//
// A bed is also where dying brings a player back to, from the moment they lie
// in it. And it is slept in, at any hour: once everybody in the world is lying
// in one, the clock cuts forward an hour every few seconds — the world going
// on meanwhile as it would have (_cut) — resting them, until sunrise or
// sunset wakes them, or they get up. The clock is the host's, so the host's
// game counts who is in bed (`_sleepers`: a guest says when it lies down and
// when it gets up) and says when it cuts forward (`cut`). A chair rests a
// sitter a little, a sofa more (_restRegen).

const SIT_HIP = 9.5 / 16;       // blocks from a sitter's feet (the model's root) up to the seat (PlayerModel's sitting pose)
const SIT_EYE = 1.5;            // … and up to their eyes
const LIE_BACK = 2.5 / 16;      // a body lying on its back is this far above what it lies on
const LIE_EYE = 1.62;           // the eyes, along the body from the feet
// Sleep (_sleepTick, _cut): with everyone in bed, every SLEEP_STEP seconds the
// clock cuts forward SLEEP_HOURS; sunrise or sunset (SLEEP_EDGES) wakes them,
// once they have slept SLEEP_LEAST. Each hour slept: SLEEP_ENERGY energy,
// SLEEP_HEAL health (SLEEP_HEAL_FED with hunger at SLEEP_FED or more), and
// SLEEP_HUNGER hunger gone.
const SLEEP_STEP = 3, SLEEP_HOURS = 1, SLEEP_LEAST = 1, SLEEP_EDGES = [6, 18];
const SLEEP_ENERGY = 12, SLEEP_HEAL = 1.5, SLEEP_HEAL_FED = 6, SLEEP_FED = 60, SLEEP_HUNGER = 1.5;
// Sitting (_restRegen), a second: a chair's energy; a sofa's, and its health for its first SOFA_HEAL_TIME seconds.
const CHAIR_ENERGY = 0.05, SOFA_ENERGY = 0.1, SOFA_HEAL = 0.6, SOFA_HEAL_TIME = 8;
// What a cut brings forward at most (_fastForward): steps of water; seconds of the mobs' lives.
const WATER_FAST = 600;
let _rest = null;               // { kind: 'sit' | 'lie', x, y, z, id, root, bodyYaw, eye, head: [hx, hz], since | slept }
let _restKeys = true;           // the keys that get up were down as this began: they count once they have come up
let _sleepT = 0;                // the host: how long since everyone was in bed, or since the clock last cut forward

function _sitDown(def, hit) {
    if (_rest || _gameMode === 'SPECTATOR' || _isDead || !def.seat) return;
    const f = def.facing ? FACING_DIR[def.facing] : null;
    const root = { x: hit.x + 0.5, y: hit.y + def.seat / 16 - SIT_HIP, z: hit.z + 0.5 };
    // A chair is sat in facing the way it does; a stool whichever way the sitter was.
    if (f) yaw = Math.atan2(-f[0], -f[1]);
    _rest = {
        kind: 'sit', x: hit.x, y: hit.y, z: hit.z, id: hit.blockId, root, since: 0,
        bodyYaw: f ? Math.atan2(f[0], f[1]) : yaw + Math.PI,
        eye: { x: root.x, y: root.y + SIT_EYE, z: root.z }, head: null,
    };
    _beginRest();
    _notice('Press Shift to get up');
}

function _lieDown(def, hit) {
    if (_rest || _gameMode === 'SPECTATOR' || _isDead || !def.lie) return;
    const H = FACING_DIR[def.facing ?? 'east'];
    // The foot of the bed, whichever half was used.
    const head = def.shape?.part === 'head', t = def.twin ?? [0, 0, 0];
    const fx = head ? hit.x + t[0] : hit.x, fz = head ? hit.z + t[2] : hit.z;
    const root = { x: fx + 0.5 - 0.45 * H[0], y: hit.y + def.lie / 16 + LIE_BACK, z: fz + 0.5 - 0.45 * H[1] };
    _bedSpawn = { x: fx, y: hit.y, z: fz };
    // On their back, looking up, their feet the way they would look down.
    yaw = Math.atan2(H[0], H[1]);
    pitch = 0.9;
    _rest = {
        kind: 'lie', x: fx, y: hit.y, z: fz, id: worldState.getBlock(fx, hit.y, fz), root,
        bodyYaw: Math.atan2(H[0], H[1]),
        eye: { x: root.x + H[0] * LIE_EYE, y: root.y + 0.22, z: root.z + H[1] * LIE_EYE }, head: H,
    };
    _rest.slept = 0;                // hours slept, as the clock has cut forward (_cut)
    _beginRest();
    _notice('Sleeping… Press Shift to get up');
    window.dispatchEvent(new CustomEvent('ww_drowsy', { detail: { on: true } }));
    if (_guest && _sessionUp()) _sayTo(_mp, _mp.hostId, { t: 'sleep' });
    else _sleeper(_myId());
}

function _beginRest() {
    _restKeys = true;
    _physics.vel.x = _physics.vel.y = _physics.vel.z = 0;
    me.position.x = _rest.root.x; me.position.y = _rest.root.y; me.position.z = _rest.root.z;
    _camDist = 0;
}

/**
 * Get up: stand beside what was sat or lain on, on the floor it stands on —
 * in front of a chair first, at the side of a bed — or, with no room anywhere
 * round it, on top of it.
 */
function _getUp() {
    const r = _rest;
    if (!r) return;
    _rest = null;
    window.dispatchEvent(new CustomEvent('ww_drowsy', { detail: { on: false } }));
    if (r.kind === 'lie') {
        if (_guest && _sessionUp()) _sayTo(_mp, _mp.hostId, { t: 'wake' });
        else _sleepers.delete(_myId());
    }
    let ways;
    if (r.kind === 'sit') {
        // The way the sitter faces (the model faces +z, turned by bodyYaw), then to either side, then behind.
        const front = facingOf(Math.sin(r.bodyYaw), Math.cos(r.bodyYaw));
        ways = [front, LEFT_OF[front], OPPOSITE[LEFT_OF[front]], OPPOSITE[front]].map(f => [r.x + FACING_DIR[f][0], r.z + FACING_DIR[f][1]]);
    } else {
        const H = r.head, L = [H[1], -H[0]];
        ways = [];
        for (const k of [0, 1]) for (const s of [1, -1]) ways.push([r.x + H[0] * k + L[0] * s, r.z + H[1] * k + L[1] * s]);
        ways.push([r.x - H[0], r.z - H[1]], [r.x + 2 * H[0], r.z + 2 * H[1]]);
    }
    for (const [bx, bz] of ways) {
        for (const dy of [0, 1, -1]) {
            const y = r.y + dy;
            if (_holds(worldState.getBlock(bx, y - 1, bz)) && _physics.fits(bx + 0.5, y, bz + 0.5)) {
                me.position.x = bx + 0.5; me.position.y = y; me.position.z = bz + 0.5;
                return;
            }
        }
    }
    me.position.x = r.x + 0.5; me.position.y = r.y + 1; me.position.z = r.z + 0.5;
}

/** Each frame while sitting or lying: stay put, and get up when asked — or when what is under them has gone. */
function _restTick(input) {
    const r = _rest;
    me.position.x = r.root.x; me.position.y = r.root.y; me.position.z = r.root.z;
    _physics.vel.x = _physics.vel.y = _physics.vel.z = 0;
    _physics.onGround = true;
    const wants = input.sneak || input.jump;
    if (!wants) _restKeys = false;
    if ((wants && !_restKeys) || worldState.getBlock(r.x, r.y, r.z) !== r.id || _gameMode === 'SPECTATOR') _getUp();
}

/** The host's: a player has lain down. */
function _sleeper(id) {
    if (_guest) return;
    _sleepers.set(id, performance.now());
    if (!_sessionUp() || _mp.alone) return;
    const all = [_myId(), ..._mp.players.keys()];
    const asleep = all.filter(p => _inBed(p)).length;
    if (asleep < all.length) _announce(`${id === _myId() ? _myLabel() : _labelOf(id)} is in bed (${asleep} of ${all.length}).`);
}
const _inBed = (id) => (id === _myId() ? _rest?.kind === 'lie' : _sleepers.has(id));

/**
 * The host's, every frame. Once everybody in the world is lying in bed, every
 * SLEEP_STEP seconds the clock cuts forward SLEEP_HOURS — any time of day or
 * night — and the world with it (_cut). A cut that comes to sunrise or sunset
 * stops there, if it would wake the sleepers (they have slept an hour).
 */
function _sleepTick(dt) {
    if (_guest) return;
    // Everybody means this player too: while they are up, there is nothing to count.
    if (_rest?.kind !== 'lie') { _sleepT = 0; return; }
    const all = [_myId(), ...(_sessionUp() ? _mp.players.keys() : [])];
    if (!all.every(_inBed)) { _sleepT = 0; return; }
    if ((_sleepT += dt) < SLEEP_STEP) return;
    _sleepT = 0;
    let hours = SLEEP_HOURS;
    const h = _atmos?.day.hours ?? 12, slept = _rest.slept ?? 0;
    if (_atmos?.day.running !== false) {
        for (const edge of SLEEP_EDGES) {
            const to = ((edge - h) % 24 + 24) % 24;
            if (to > 1e-6 && to <= hours && slept + to >= SLEEP_LEAST) hours = to;
        }
    }
    const at = ((h + (_atmos?.day.running !== false ? hours : 0)) % 24 + 24) % 24;
    if (_sessionUp() && !_mp.alone) _mp.all({ t: 'cut', h: hours, at });
    _cut(hours, at);
}

/**
 * The clock has cut forward `hours`, to `at` o'clock (every game: the host's
 * said so). Everything that goes on in time goes on as far as it would have
 * meanwhile (_fastForward) — the host's clock and weather with it — and
 * whoever is asleep here has slept those hours: rested, healed a little (more
 * on a full stomach), a little hungrier. Sunrise or sunset wakes them, once
 * they have slept an hour; with the clock stopped (Daylight Cycle off), half
 * a day does.
 */
function _cut(hours, at) {
    if (!worldState || !(hours > 0)) return;
    const seconds = hours * DAY_LENGTH / 24;
    if (!_guest) { _atmos?.skip(seconds); _mpAtmosT = 0; }
    else _atmos?.setHours(at);
    _fastForward(seconds);
    window.dispatchEvent(new CustomEvent('ww_sleepCut'));
    if (_rest?.kind !== 'lie') return;
    _rest.slept = (_rest.slept ?? 0) + hours;
    if (_gameMode === 'SURVIVAL') {
        me.energy = Math.min(100, me.energy + SLEEP_ENERGY * hours);
        me.health = Math.min(100, me.health + (me.hunger >= SLEEP_FED ? SLEEP_HEAL_FED : SLEEP_HEAL) * hours);
        me.hunger = Math.max(0, me.hunger - SLEEP_HUNGER * hours);
    }
    const running = _atmos?.day.running !== false;
    const edge = SLEEP_EDGES.some(e => Math.abs(((at - e) % 24 + 24 + 12) % 24 - 12) < 1e-3);
    if (_rest.slept >= SLEEP_LEAST && (running ? edge : _rest.slept >= 12)) {
        _getUp();
        _chatShow({ kind: 'sys', text: !running ? 'You wake up.' : at < 12 ? 'Morning: you wake with the sun.' : 'Evening: you wake as the sun goes down.' });
        return;
    }
    const hh = Math.floor(at), mm = Math.floor((at - hh) * 60);
    _notice(`Sleeping… ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}. Press Shift to get up`);
}

/**
 * `seconds` of the world's time pass at once (the clock cut forward while
 * players slept): the water runs on and settles, fires burn, saplings grow,
 * lit bombs go off, and the mobs live through it — wander, graze, appear —
 * as they would have with the player awake and waiting. Each in steps of the
 * length it is used to, up to a limit a cut: water to where it settles (or
 * WATER_FAST steps), the blocks that do something in time in half-second
 * steps, the mobs for at most MOB_FAST seconds of it (they are not drawn
 * meanwhile).
 */
function _fastForward(seconds) {
    _tickWater(0, Math.min(WATER_FAST, Math.ceil(seconds / 0.2)));
    for (let t = 0; t < seconds; t += 0.5) _tickBlocks(Math.min(0.5, seconds - t));
    _entities?.fastForward(seconds, me.position, _inventory, _gameMode);
}

/** The chair or the sofa they sit on, each frame (Survival): a chair rests them a little; a sofa more, and heals them for the first moment. */
function _restRegen(dt) {
    const r = _rest;
    if (r?.kind !== 'sit') return;
    r.since = (r.since ?? 0) + dt;
    const sofa = _blockReg.get(r.id)?.model === 'sofa';
    me.energy = Math.min(100, me.energy + (sofa ? SOFA_ENERGY : CHAIR_ENERGY) * dt);
    if (sofa && r.since < SOFA_HEAL_TIME) me.health = Math.min(100, me.health + SOFA_HEAL * dt);
}

// ── The map ──────────────────────────────────────────────────────────────────
// main.js draws it; the land comes from here: a square of the world as the
// generator has it, sampled the way a far-terrain tile is (64 × 64, `step`
// blocks apart), by a worker. Nothing has to be loaded for it.

document.addEventListener('WorldJS_mapTile', (e) => {
    const { x0, z0, step } = e.data ?? {};
    if (!workerPool || ![x0, z0, step].every(Number.isFinite) || step < 1 || step > 64) return;
    workerPool.dispatch({ type: 'farTile', x0, z0, step, cells: 64 }, (r) => {
        if (r?.type !== 'farTileBuilt') return;
        window.dispatchEvent(new CustomEvent('ww_mapTile', { detail: { x0, z0, step, positions: r.positions, colors: r.colors } }));
    }, [], 1.5);
});

/** Who is where, for the map. */
window.__wwMapInfo = () => (!worldState ? null : {
    x: me.position.x, z: me.position.z, yaw,
    others: _otherPos.map(o => ({ x: o.x, z: o.z, name: _labelOf(o.id) })),
    spawn: _worldSpawn ?? null, bed: _bedSpawn,
});

// ── Attack charge ─────────────────────────────────────────────────────────────

function _handleAttackCharge(dt, mobHit, hit, foe = null) {
    const held  = _inventory?.getHotbar(_hotbarSlot);
    const def   = held ? _itemReg?.getItem(held.itemId) : null;
    const speed = def?.attackChargeSpeed ?? 1.5;

    if (MOUSE.left && foe) {
        // Another player (PvP): the blow lands in their game, which takes what it does to them.
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            _sounds?.swing();
            _swingArm();
            _strikePlayer(foe, dmg, false);
            _strikeHold = STRIKE_HOLD;
        }
        _attackCharge = 0;
    } else if (MOUSE.left && mobHit) {
        // Directly targeting a mob — attack it (that one, not whichever stands nearest it)
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            const at = { x: mobHit.mob.pos.x, y: mobHit.mob.pos.y + 0.7, z: mobHit.mob.pos.z };
            _sounds?.swing();
            _swingArm();
            if ((_entities?.hitMob(mobHit.mob, dmg, me.position) ?? 0) > 0) { _sounds?.struck(at); _strikeHold = STRIKE_HOLD; }
        }
        _attackCharge = 0;
    } else if (MOUSE.left && !hit) {
        // Swinging at air — try nearby mobs with wider radius (those in plain sight)
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            const at = { x: me.position.x + _camFwd.x * 2.5, y: me.position.y + 1, z: me.position.z + _camFwd.z * 2.5 };
            if (_attackCharge >= 0.5) _sounds?.swing();
            if (_hitMob(at, dmg, 3) > 0) { _sounds?.struck(at); _strikeHold = STRIKE_HOLD; }
        }
        _attackCharge = 0;
    } else {
        _attackCharge = Math.min(1, _attackCharge + dt * speed);
    }
}

// ── Food eating ───────────────────────────────────────────────────────────────

let _eatHold = false;            // the button that put food on a plate is still down: no eating till it is let go
function _handleEating(dt) {
    if (!MOUSE.right) _eatHold = false;
    const held = MOUSE.right && !_eatHold ? _inventory?.getHotbar(_hotbarSlot) : null;
    const itemDef = held ? _itemReg?.getItem(held.itemId) : null;
    // Don't eat if hunger is full and item provides no health
    const eating = itemDef?.type === 'food' && !(me.hunger >= 100 && !itemDef.healthRestore);
    _sounds?.eating(dt, eating);
    if (!eating) { _eatTimer = 0; return; }

    _eatTimer += dt;
    if (_eatTimer >= EAT_TIME) {
        _eatTimer = 0;
        me.hunger = Math.min(100, me.hunger + (itemDef.hungerRestore ?? 0));
        me.energy = Math.min(100, me.energy + (itemDef.energyRestore ?? 0));
        if (itemDef.healthRestore) me.health = Math.min(100, me.health + itemDef.healthRestore);
        // Creative food is free — gain the effects but don't consume the stack.
        if (_gameMode !== 'CREATIVE') {
            _inventory.removeItem(held.itemId, 1);
            window.dispatchEvent(new CustomEvent('ww_itemPickup'));
        }
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

    _sounds?.bowShoot();
    const speed    = 20 + _bowCharge * 30;
    const dmg      = 3 + _bowCharge * 9;
    const shootPos = { x: me.position.x + _camFwd.x * 0.5, y: me.position.y + 1.2, z: me.position.z + _camFwd.z * 0.5 };
    // For now: immediate raycast hit (no projectile physics yet). The arrow
    // stops in the first mob on its way, if nothing stands between; else in
    // the first block, where it still catches a mob right beside the spot —
    // one the archer can see, not one on the far side of the wall it struck.
    const flying = _entities.getClosestMobInRay(shootPos, _camFwd, 40);
    // Another player in the arrow's way, before any mob (PvP).
    const foe = _pvp ? _otherInRay(shootPos, _camFwd, 40) : null;
    if (foe && (!flying || foe.t < flying.t) && _clearSight(shootPos.x, shootPos.y, shootPos.z, _camFwd.x, _camFwd.y, _camFwd.z, foe.t)) {
        _sounds?.arrowHit({ x: foe.x, y: foe.y + 1, z: foe.z });
        _strikePlayer(foe, dmg, true);
        return;
    }
    if (flying && _clearSight(shootPos.x, shootPos.y, shootPos.z, _camFwd.x, _camFwd.y, _camFwd.z, flying.t)) {
        const at = { x: flying.mob.pos.x, y: flying.mob.pos.y + 0.7, z: flying.mob.pos.z };
        _sounds?.arrowHit(at);
        _entities.hitMob(flying.mob, dmg, me.position);
        return;
    }
    const arrowHit = raycast(worldState, _blockReg, shootPos, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, 40);
    if (arrowHit) {
        _sounds?.arrowHit({ x: arrowHit.x + 0.5, y: arrowHit.y + 0.5, z: arrowHit.z + 0.5 });
        _hitMob({ x: arrowHit.x + 0.5, y: arrowHit.y + 0.5, z: arrowHit.z + 0.5 }, dmg, 2);
    }
}

// ── Sight, and standing room ──────────────────────────────────────────────────

/** Is the point inside something that stops a blow or an arrow: any block one cannot walk through? */
function _pointBlocked(x, y, z) {
    const id = worldState.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (id === 0 || _blockReg.isNoCollision(id)) return false;      // air, water, a torch
    const sh = _shapes?.of(id);                                     // a slab, a fence: where its boxes are
    if (sh) return _shapes.pointIn(sh, worldState, x, y, z, true);
    return _smooth?.isMesh(id) ? _smooth.pointInMesh(x, y, z) : true;
}

/**
 * Whether the line from (x, y, z) along the unit vector (dx, dy, dz) is clear
 * of blocks for `dist` blocks. Against the ground as it is drawn, so a mob on
 * a smooth slope is not hidden by the voxel of the slope in front of it.
 */
function _clearSight(x, y, z, dx, dy, dz, dist) {
    for (let t = 0.1; t < dist - 0.05; t += 0.12) {
        if (_pointBlocked(x + dx * t, y + dy * t, z + dz * t)) return false;
    }
    return true;
}

// ── Players against players (PvP) ─────────────────────────────────────────────
// Where the world allows it (World Settings → PvP, or /pvp; the host's word, sent
// with its clock), a blow or an arrow that meets another player hurts them.
// The striker's game only says so: the blow lands in the game of whoever was
// struck ('pvp'), which is the one that has their health and their armor — and
// which does not take a blow from further off than a blow can come, nor any at
// all in a world where players cannot hurt each other.

let _pvp = true;                 // players can hurt each other here
let _hurtBy = null;              // { id, at }: the player who last struck this one (for saying who killed them)
const PVP_MELEE = 8, PVP_ARROW = 48;     // blocks: the furthest a blow, and an arrow, is believed to have come from
const PVP_MOST = 30;                     // the most one blow does

/** The other player the ray meets first, by their box: { id, t, x, y, z }, or null. */
function _otherInRay(origin, dir, max) {
    if (!_entities || !_otherPos.length) return null;
    let best = null, bestT = max;
    for (const o of _otherPos) {
        const t = _entities._rayAABB(origin, dir, o.x - PLAYER_HALF, o.y, o.z - PLAYER_HALF, o.x + PLAYER_HALF, o.y + PLAYER_TALL, o.z + PLAYER_HALF);
        if (t !== null && t < bestT) { bestT = t; best = o; }
    }
    return best ? { id: best.id, t: bestT, x: best.x, y: best.y, z: best.z } : null;
}

/** This player's blow (or arrow: `far`) has met another player. */
function _strikePlayer(foe, dmg, far) {
    if (!_mp || _mp.id === 0) return;
    _sounds?.struck({ x: foe.x, y: foe.y + 1, z: foe.z });
    _sayTo(_mp, foe.id, { t: 'pvp', dmg: Math.round(dmg * 10) / 10, far: far ? 1 : 0 });
}

/** Another player's blow has landed on this one. */
function _struckBy(from, d) {
    const o = _others?.map.get(from);
    if (!_pvp || !o || _isDead || !(d.dmg > 0) || !_physics) return;
    const dx = me.position.x - o.x, dz = me.position.z - o.z, dist = Math.hypot(dx, me.position.y - o.y, dz);
    if (dist > (d.far ? PVP_ARROW : PVP_MELEE)) return;
    _hurtBy = { id: from, at: performance.now() };
    _applyDamage(Math.min(PVP_MOST, d.dmg));
    // Knocked back, away from whoever struck (not by an arrow).
    if (!d.far && !_isDead && _gameMode === 'SURVIVAL') {
        const h = Math.hypot(dx, dz) || 1;
        _physics.vel.x += dx / h * 5; _physics.vel.z += dz / h * 5;
        if (_physics.onGround) _physics.vel.y = Math.max(_physics.vel.y, 4);
    }
}

/** Can the player see this mob: its middle, or else its head, from their eyes? */
function _seesMob(mob) {
    const ex = me.position.x, ey = _eyeY(), ez = me.position.z;
    const h = mob.def.height ?? 1.4;
    for (const f of [0.5, 0.9]) {
        const dx = mob.pos.x - ex, dy = mob.pos.y + h * f - ey, dz = mob.pos.z - ez;
        const d = Math.hypot(dx, dy, dz);
        if (d < 0.3 || _clearSight(ex, ey, ez, dx / d, dy / d, dz / d, d - (mob.def.width ?? 0.8) / 2)) return true;
    }
    return false;
}

/** Does the voxel (px, py, pz) cut into a body `half` wide each way and `h` tall, standing at (x, y, z)? */
function _boxInVoxel(px, py, pz, x, y, z, half, h) {
    const e = 0.02;      // touching is not inside
    return x + half > px + e && x - half < px + 1 - e && y + h > py + e && y < py + 1 - e &&
           z + half > pz + e && z - half < pz + 1 - e;
}

/** Is somebody standing where the voxel (px, py, pz) is: this player, another, or a mob? */
function _someoneIn(px, py, pz) {
    const p = me.position;
    if (_gameMode !== 'SPECTATOR' && _boxInVoxel(px, py, pz, p.x, p.y, p.z, PLAYER_HALF, PLAYER_TALL)) return true;
    for (const o of _otherPos) if (_boxInVoxel(px, py, pz, o.x, o.y, o.z, PLAYER_HALF, PLAYER_TALL)) return true;
    return _entities?.mobIn((x, y, z, half, h, along, yaw) => _bodyInVoxel(px, py, pz, x, y, z, half, h, along, yaw)) ?? false;
}

/**
 * The same for a body that is longer than it is wide — a cow, nose to tail:
 * `half` each side and `along` fore and aft of (x, z), facing `yaw` (+Z turned
 * about Y). Two rectangles overlap unless one of their four edge directions
 * separates them.
 */
function _bodyInVoxel(px, py, pz, x, y, z, half, h, along, yaw) {
    const e = 0.02;
    if (!(y + h > py + e && y < py + 1 - e)) return false;
    if (along <= half + 1e-6) return _boxInVoxel(px, py, pz, x, y, z, half, h);
    const s = Math.sin(yaw), c = Math.cos(yaw), as = Math.abs(s), ac = Math.abs(c);
    const dx = px + 0.5 - x, dz = pz + 0.5 - z, v = 0.5 - e;
    // The world's axes: the body's reach along each.
    if (Math.abs(dx) >= v + along * as + half * ac || Math.abs(dz) >= v + along * ac + half * as) return false;
    // The body's own: the voxel's reach along each.
    const reach = v * (as + ac);
    return Math.abs(dx * s + dz * c) < along + reach && Math.abs(dx * c - dz * s) < half + reach;
}
const PLAYER_HALF = 0.3, PLAYER_TALL = 1.8;     // the player's box (PlayerPhysics.js)
const STRIKE_HOLD = 0.4;                        // seconds after a blow on a mob before a block can be mined
let _strikeHold = 0;

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
    if (!_headInside(id)) return null;
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

    const inSolid = headId > 0 && !_blockReg?.isTransparent(headId) && !_blockReg?.isLiquid(headId)
                 && _headInside(headId);

    if (inSolid) {
        if (overlayEl) {
            const layer = _faceMap[headId]?.side ?? _faceMap[headId]?.top;
            const path  = layer != null ? _texLayers[layer] : null;
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

// In a smooth world the head can be in a Mesh block's voxel yet above its
// sloped surface — only count it when the eye point is inside the shape.
function _headInside(id) {
    if (!_smooth?.isMesh(id)) return true;
    return _smooth.pointInMesh(me.position.x, me.position.y + CAMERA_HEIGHT, me.position.z);
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
    if (actual > 0.5) _sounds?.hurt(actual);
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

/**
 * The world's spawn: where its players start, and where dying brings them
 * back to. The nearest good land to where the world begins — the current
 * generator has real oceans, and the search for open ground that follows
 * (_tryGroundSpawn) only looks a couple of dozen blocks around. From the seed
 * alone, so it is the same place in every session and for every player.
 *
 * (It used to be known only in the session that had set a new player down
 * there: `_worldSpawn` was filled in by that first landing and not kept. In a
 * world loaded from a save nobody lands, so it was empty — and dying sent the
 * player to (0, 0), wherever that is: often the sea.)
 */
function _worldHome() {
    return _home ??= _goodLandNear(0, 0);
}
/** The nearest land fit to stand a new player on near (x, z), as the seed has it (worlds of the old generator: the place itself). */
function _goodLandNear(x, z) {
    x = Math.floor(x) || 0; z = Math.floor(z) || 0;
    if (_worldGen < 2 || !worldState) return { x, z };
    return new Geography(worldState.seed, new BiomeSet(_gamepack?.biomes ?? []), normaliseFlat(_homeFlat)).findSpawn(x, z);
}
let _homeFlat = null;             // the world's Flat settings, which the search needs
let _home = null;                 // the world's spawn, once it has been asked for

// Park the player above the spawn column and resolve a ground position once the
// terrain there has generated. Used on first spawn and on respawn so the player
// never appears in the air, in water, or buried in a hill.
// `home`: this is the world's spawn (not a place beside another player), so
// where the player lands is theirs to come back to.
function _beginGroundSpawn(x, z, home = true) {
    _spawnXZ      = { x, z };
    _spawnHome    = home;
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
    _post?.resetAdaptation();
    me.position = { x, y, z };
    if (_physics?.vel) _physics.vel = { x: 0, y: 0, z: 0 };
    // The first landing at the world's spawn is the spot this player comes back
    // to (kept with their state: _savePlayerState).
    if (_spawnHome && !_worldSpawn) _worldSpawn = { x: Math.floor(x), z: Math.floor(z) };
    _spawnPending = false;
}

function _handleDeath() {
    if (_isDead) return;
    if (_rest) _getUp();
    _isDead = true;
    // The others are told, and by whom if another player's blow was the last thing that happened to them.
    const by = _hurtBy && performance.now() - _hurtBy.at < 6000 ? _hurtBy.id : 0;
    _hurtBy = null;
    if (_sessionUp() && !_mp.alone) {
        _mp.all({ t: 'died', by });
        _chatShow({ kind: 'sys', text: by ? `${_myLabel()} was slain by ${_labelOf(by)}.` : `${_myLabel()} died.` });
    }
    if (_entities) _entities.spawnDeathPack({ ...me.position }, _inventory);
    window.dispatchEvent(new CustomEvent('ww_playerDied'));
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));   // inventory was emptied
}

window.addEventListener('ww_mobAttack', (e) => {
    _applyDamage(e.detail?.damage ?? 4);
});

function _setGameMode(mode) {
    if (!mode || !['SURVIVAL','CREATIVE','SPECTATOR'].includes(mode)) return;
    _gameMode = mode;
    if (_physics) { _physics.flying = false; _physics.vel = { x:0, y:0, z:0 }; }
    window.dispatchEvent(new CustomEvent('ww_gameModeChange', { detail: { gameMode: mode } }));
}
document.addEventListener('WorldJS_setGameMode', (e) => _setGameMode(e.data?.gameMode));

document.addEventListener('WorldJS_respawn', () => {
    if (!_isDead) return;
    _isDead      = false;
    _damageFade  = 0;
    me.health    = 100;
    me.hunger    = 80;
    me.energy    = 80;
    _physics.vel = { x: 0, y: 0, z: 0 };
    // Respawn on the ground at the world spawn point: the spot this player
    // first landed on there, or — never having landed there in a session that
    // kept it — the world's spawn itself.
    // In their bed, if they have one and it still stands (where its land is not
    // loaded just now, they are taken at their word).
    const bed = _bedSpawn;
    const made = bed && (!worldState.getChunk(bed.x >> CHUNK_SHIFT, bed.z >> CHUNK_SHIFT)?.generated || !!_blockReg.get(worldState.getBlock(bed.x, bed.y, bed.z)).use?.sleep);
    if (bed && !made) _bedSpawn = null;
    if (made) {
        _post?.resetAdaptation();
        me.position = { x: bed.x + 0.5, y: bed.y + 0.6, z: bed.z + 0.5 };
    } else {
        const home = _worldSpawn ?? _worldHome();
        _beginGroundSpawn(home.x, home.z);
    }
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

// ── HUD ───────────────────────────────────────────────────────────────────────
// _updateHUD runs once per frame, so it does no getElementById lookups and no
// innerHTML writes. Element handles are resolved once and every value is
// compared against the last one written — an unchanged HUD touches the DOM zero
// times, where the previous version rebuilt three <img> elements 60x a second.

const _hud = { ready: false, el: {}, last: {} };

function _hudInit() {
    const ids = [
        'playerCoords', 'playerInfo', 'playerHealthVal', 'playerHungerVal', 'playerEnergyVal',
        'playerHealthFill', 'playerHungerFill', 'playerEnergyFill',
        'playerProtection', 'playerArrows', 'attackChargeFill', 'mineProgressBar',
        'mineProgressFill', 'eatProgressBar', 'eatProgressFill', 'damageVignette', 'actionLines',
    ];
    for (const id of ids) _hud.el[id] = document.getElementById(id);
    _hud.last = {};
    _hud.ready = true;
}

/** Write `value` to the element only when it differs from the last write. */
function _hudText(id, value) {
    if (_hud.last[id] === value) return;
    _hud.last[id] = value;
    const el = _hud.el[id];
    if (el) el.textContent = value;
}

function _hudStyle(id, prop, value) {
    const k = id + '.' + prop;
    if (_hud.last[k] === value) return;
    _hud.last[k] = value;
    const el = _hud.el[id];
    if (el) el.style[prop] = value;
}

/** A status bar: its number and how full it is, out of 100. */
function _hudMeter(valId, fillId, value) {
    const v = Math.max(0, Math.min(100, Math.ceil(value)));
    if (_hud.last[valId] === v) return;
    _hud.last[valId] = v;
    if (_hud.el[valId]) _hud.el[valId].textContent = String(v);
    if (_hud.el[fillId]) _hud.el[fillId].style.width = v + '%';
}

function _hudClass(id, cls, on) {
    const k = id + '#' + cls;
    if (_hud.last[k] === on) return;
    _hud.last[k] = on;
    const el = _hud.el[id];
    if (el) el.classList.toggle(cls, on);
}

function _updateHUD() {
    if (!_hud.ready) _hudInit();

    // Player coordinates — top-right, shown in every game mode.
    _hudText('playerCoords',
        `X: ${Math.round(me.position.x)}  Y: ${Math.round(me.position.y)}  Z: ${Math.round(me.position.z)}`);

    // Game-mode gating: hide survival stats in Creative/Spectator
    const showStats = _gameMode === 'SURVIVAL';
    _hudClass('playerInfo', 'hidden', !showStats);

    if (showStats) {
        // A bar each, out of 100, and the number beside it.
        _hudMeter('playerHealthVal', 'playerHealthFill', me.health);
        _hudMeter('playerHungerVal', 'playerHungerFill', me.hunger);
        _hudMeter('playerEnergyVal', 'playerEnergyFill', me.energy);
    }

    const hasArmor = _inventory?.hasAnyArmor ?? false;
    _hudClass('playerProtection', 'hidden', !hasArmor);
    if (hasArmor) _hudText('playerProtection', `Protection: ${Math.round(_inventory.totalProtection)}%`);

    const hasQuiver = _inventory?.hasQuiver ?? false;
    _hudClass('playerArrows', 'hidden', !hasQuiver);
    if (hasQuiver) _hudText('playerArrows', `Arrows: ${_inventory.quiverArrows}`);

    // Attack charge bar
    _hudStyle('attackChargeFill', 'width', `${Math.round(_attackCharge * 100)}%`);

    // Mining progress bar — visible while breaking a block in survival
    const mining = _breakProgress > 0 && _breakTarget !== null && _gameMode !== 'CREATIVE';
    _hudStyle('mineProgressBar', 'display', mining ? 'block' : 'none');
    _hudStyle('mineProgressFill', 'width', `${Math.round(_breakProgress * 100)}%`);

    // Eating progress bar — visible while consuming food
    _hudStyle('eatProgressBar', 'display', _eatTimer > 0 ? 'block' : 'none');
    _hudStyle('eatProgressFill', 'width', `${Math.round((_eatTimer / EAT_TIME) * 100)}%`);

    // Damage vignette
    _hudStyle('damageVignette', 'opacity', _damageFade.toFixed(3));

    // Action lines: flash when freshly damaged
    _hudClass('actionLines', 'flash', _damageFade > 0.7);
}

// ── Camera + view ─────────────────────────────────────────────────────────────

// ── The view: first person, or the player seen from outside ──────────────────
//
// _camMode 0 is the player's own eyes. 1 is over the right shoulder from
// behind, 2 from in front, looking back (F5 or V, or a controller's right
// stick pressed in). What the player does is the same in all three: blocks are
// aimed at, mined and placed from the eyes, along the look. So in the shoulder
// view the camera is turned to look at the very point the eyes are aimed at
// (`_aimDist` along the look), and the crosshair lies on the block that will
// be hit, though the camera is half a block to one side.
//
// The camera never goes through the ground: the line from the head out to
// where it would be is walked, and the camera stops short of the first thing
// in the way. It comes in at once and goes back out slowly, so passing a tree
// does not make it lurch.
const CAM_BACK = 4.2, CAM_SIDE = 0.6, CAM_UP = 0.4;   // blocks: how far out, to the right and up it sits
const CAM_CLEAR = 0.3;      // blocks kept between the camera and what stopped it
const CAM_HEAD = 0.9;       // nearer the head than this, the body is not drawn (the camera would be inside it)
const AIM_FAR = 24;         // blocks: where the camera aims when nothing is aimed at
let _camMode = 0;
let _camDist = 0;           // how far out the camera is now, of CAM_BACK
let _aimDist = AIM_FAR;
const _camAim = new THREE.Vector3();

function _cycleCamera() {
    if (_gameMode === 'SPECTATOR') return;
    _camMode = (_camMode + 1) % 3;
    window.dispatchEvent(new CustomEvent('ww_cameraMode', { detail: { mode: _camMode } }));
}
window.addEventListener('ww_toggleCamera', _cycleCamera);

/**
 * How far along (dx, dy, dz) — a unit vector — from the eye the way is clear,
 * up to `max`. Clear for a camera, not for a point: there has to be room
 * either side of the line and above and below it (`CAM_ROOM`), or a wall the
 * camera only just misses would fill half the screen.
 */
const CAM_ROOM = 0.38;
function _clearAlong(ex, ey, ez, dx, dy, dz, max) {
    const rx = Math.cos(yaw) * CAM_ROOM, rz = -Math.sin(yaw) * CAM_ROOM;
    for (let t = 0.2; t <= max; t += 0.2) {
        const x = ex + dx * t, y = ey + dy * t, z = ez + dz * t;
        // Close to the head there is only the line: the player's own cover
        // (a wall beside them, a low roof) is not in the camera's way yet.
        const room = t > 1.2;
        if (_pointInRock(x, y, z) || (room && (_pointInRock(x + rx, y, z + rz) || _pointInRock(x - rx, y, z - rz) ||
                                               _pointInRock(x, y + CAM_ROOM, z) || _pointInRock(x, y - CAM_ROOM, z)))) {
            return Math.max(0, t - CAM_CLEAR);
        }
    }
    return max;
}

/** The player's body: where they are, what they are doing, and whether it is drawn at all. */
function _updatePlayerModel(dt) {
    if (!_playerModel || !_physics) return;
    const p = me.position, ghost = _gameMode === 'SPECTATOR';
    // (`_camDist` is how far out the camera is, of CAM_BACK; CAM_HEAD is in blocks.)
    const outside = _camMode !== 0 && !ghost && _camDist * CAM_BACK > CAM_HEAD;
    _playerModel.show(outside, !ghost && !!_shadows?.enabled);
    _playerModel.update(dt, {
        x: p.x, y: p.y, z: p.z, yaw, pitch,
        speed: Math.hypot(_physics.vel.x, _physics.vel.z),
        onGround: _physics.onGround, inWater: _physics.inWater,
        hurt: Math.min(1, _damageFade * 1.5), dead: _isDead,
        crouch: _physics.crouching, sit: _rest?.kind === 'sit', lie: _rest?.kind === 'lie', body: _rest?.bodyYaw,
        light: _lightAt(p.x, p.y + 1, p.z), lightDir: _atmos?.state.lightDir ?? null, still: _paused && !_isDead,
    });
    // The hands, in first person — not lying in bed (they are under the blanket), nor as a ghost.
    if (_hands) {
        _hands.visible = _camMode === 0 && !ghost && !_isDead && _rest?.kind !== 'lie';
        if (_hands.visible) _hands.update(dt, {
            speed: _rest ? 0 : Math.hypot(_physics.vel.x, _physics.vel.z), crouch: _physics.crouching, yaw,
            light: _lightAt(p.x, _eyeY(), p.z), lightDir: _atmos?.state.lightDir ?? null, still: _paused,
        });
    }
}

const CROUCH_EYES = 0.3;    // blocks the eyes come down when crouching
let _crouch = 0;            // 0 standing … 1 crouched, eased
/** How high the player's eyes are: what is looked from, aimed from and drawn from. (Sitting or lying, where the body puts them.) */
const _eyeY = () => (_rest ? _rest.eye.y : me.position.y + CAMERA_HEIGHT - CROUCH_EYES * _crouch);
const RESTING = { onGround: true, inWater: false, fallDamage: 0, fellIntoVoid: false };
const EYE_EASE = 16;        // 1/s: how fast the eyes catch up with feet that stepped (PlayerPhysics.stepped)
let _eyeEase = 0;           // how far the camera is still off where the feet put it, blocks

function _updateCamera() {
    const ex = _rest ? _rest.eye.x : me.position.x, ey = _eyeY() + (_rest ? 0 : _eyeEase), ez = _rest ? _rest.eye.z : me.position.z;
    const third = _camMode !== 0 && _gameMode !== 'SPECTATOR';
    if (!third) {
        _camDist = 0;
        camera.position.set(ex, ey, ez);
        _camQ.identity();
        _camQ.multiply(_camQy.setFromAxisAngle(_axisY, yaw));
        _camQ.multiply(_camQx.setFromAxisAngle(_axisX, pitch));
        camera.quaternion.copy(_camQ);
    } else {
        const f = _camFwd, front = _camMode === 2;
        // Out from the head: back along the look and over the right shoulder —
        // or forward of the face, square on.
        let ox, oy, oz;
        if (front) { ox = f.x * CAM_BACK; oy = f.y * CAM_BACK + 0.15; oz = f.z * CAM_BACK; }
        else {
            ox = -f.x * CAM_BACK + Math.cos(yaw) * CAM_SIDE;
            oy = -f.y * CAM_BACK + CAM_UP;
            oz = -f.z * CAM_BACK - Math.sin(yaw) * CAM_SIDE;
        }
        const len = Math.hypot(ox, oy, oz);
        const free = worldState ? _clearAlong(ex, ey, ez, ox / len, oy / len, oz / len, len) / len : 1;
        _camDist = free < _camDist ? free : Math.min(free, _camDist + (free - _camDist) * 0.12 + 0.004);
        camera.position.set(ex + ox * _camDist, ey + oy * _camDist, ez + oz * _camDist);
        if (front) _camAim.set(ex, ey - 0.15, ez);
        else _camAim.set(ex + f.x * _aimDist, ey + f.y * _aimDist, ez + f.z * _aimDist);
        camera.up.set(0, 1, 0);
        camera.lookAt(_camAim);
    }

    // The FOV lerp converges asymptotically and never lands exactly on target,
    // so snap once it is visually there. Otherwise updateProjectionMatrix() —
    // which also recomputes the inverse — would run on every frame forever.
    const targetFov = _bowZoom ? Math.min(30, _baseFov - 10) : _baseFov;
    const delta = targetFov - camera.fov;
    if (Math.abs(delta) > 0.01) {
        camera.fov += delta * 0.2;
        camera.updateProjectionMatrix();
    } else if (camera.fov !== targetFov) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
    }
}

// ── Mesh callbacks ─────────────────────────────────────────────────────────────

// ── Sky light ────────────────────────────────────────────────────────────────
// Each chunk's light (workers/Skylight.js) is a small 3D texture, so each chunk
// has its own pair of materials. They share every other uniform object with
// chunkUniforms, so fog, brightness and shadows still update all terrain at once.
const chunkLights = new Map();   // key → { data, y0, h, tex, uniforms, opaque, transparent }
const LIGHT_W = CHUNK_SIZE + 2;  // the light volume has a one-block border

// Until a chunk's light arrives it is treated as open sky (255); a chunk with
// no block light binds a 0.
function _emptyLightTexture(v = 255) {
    const tex = new THREE.Data3DTexture(new Uint8Array([v]), 1, 1, 1);
    tex.format = THREE.RedFormat;
    tex.needsUpdate = true;
    return tex;
}

/** A light volume (sky or block: the same layout) as a filtered R8 texture. */
function _lightTexture(light) {
    const tex = new THREE.Data3DTexture(light.data, LIGHT_W, light.h, LIGHT_W);
    tex.format    = THREE.RedFormat;
    tex.type      = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
}

function _chunkLight(key) {
    let e = chunkLights.get(key);
    if (e) return e;
    // Only what differs per chunk, and the samplers: the rest of chunkUniforms
    // reaches the program through the primers.
    const uniforms = {
        ..._perDraw,
        uLight:       { value: _emptyLightTexture() },
        uBlock:       { value: _noBlockLight },
        uChunk:       { value: _chunkUniform() },       // its offset is set each frame by _viewChunks
    };
    e = {
        data: null, y0: 0, h: 0, tex: uniforms.uLight.value, uniforms,
        block: null, blockTex: null,   // block light (torches), when any reaches this chunk
        opaque:      _opaqueChunkMaterial(uniforms),
        transparent: _transparentChunkMaterial(uniforms),
    };
    chunkLights.set(key, e);
    _lightAtCx = NaN;
    return e;
}

// The chunk light last looked up by position (_chunkLightAt). The light where
// something stands is asked for in runs — the camera, the player, each mob,
// sky then block — and building the "cx,cz" key was most of each lookup.
let _lightAtCx = NaN, _lightAtCz = NaN, _lightAtEntry = null;

/** The light entry of chunk (cx, cz), or undefined. */
function _chunkLightAt(cx, cz) {
    if (cx === _lightAtCx && cz === _lightAtCz) return _lightAtEntry;
    _lightAtCx = cx; _lightAtCz = cz;
    return (_lightAtEntry = chunkLights.get(WorldState.key(cx, cz)));
}

function _setChunkLight(key, light) {
    if (!light) return;
    const e = _chunkLight(key);
    const tex = _lightTexture(light);
    e.tex.dispose();
    e.tex = tex;
    e.data = light.data; e.y0 = light.y0; e.h = light.h;
    e.uniforms.uLight.value = tex;
    const u = e.uniforms.uChunk.value;
    u[U_LIGHT_Y0] = light.y0; u[U_LIGHT_H] = light.h;

    // Block light rides along; null means none reaches this chunk.
    e.blockTex?.dispose();
    const b = light.block ?? null;
    e.block = b;
    e.blockTex = b ? _lightTexture(b) : null;
    e.uniforms.uBlock.value = e.blockTex ?? _noBlockLight;
    u[U_BLOCK_Y0] = b ? b.y0 : 0; u[U_BLOCK_H] = b ? b.h : 0;
}

function _disposeChunkLight(key) {
    const e = chunkLights.get(key);
    if (!e) return;
    e.tex.dispose(); e.blockTex?.dispose(); e.opaque.dispose(); e.transparent.dispose();
    chunkLights.delete(key);
    _lightAtCx = NaN;
}

/**
 * Brightness of sky light at a world point, 0..1 — for things drawn without the
 * chunk shader (mobs, debris). Open sky where no light has arrived yet.
 */
function _skyBrightnessAt(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const cx = bx >> 4, cz = bz >> 4;
    const e = _chunkLightAt(cx, cz);
    if (!e?.data) return 1;
    const ly = by - WORLD_MIN_Y - e.y0;
    if (ly >= e.h) return 1;
    if (ly < 0) return SKY_MIN;
    const lx = bx - cx * CHUNK_SIZE + 1, lz = bz - cz * CHUNK_SIZE + 1;
    const level = e.data[lx + ly * LIGHT_W + lz * LIGHT_W * e.h] / 255 * SKY_MAX;
    return Math.max(Math.pow(SKY_FALLOFF, SKY_MAX - level), SKY_MIN);
}

/** Block light level (0..15) at a world point, from the chunk's block-light volume. */
function _blockLevelAt(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const cx = bx >> 4, cz = bz >> 4;
    const b = _chunkLightAt(cx, cz)?.block;
    if (!b) return 0;
    const ly = by - WORLD_MIN_Y - b.y0;
    if (ly < 0 || ly >= b.h) return 0;
    const lx = bx - cx * CHUNK_SIZE + 1, lz = bz - cz * CHUNK_SIZE + 1;
    return b.data[lx + ly * LIGHT_W + lz * LIGHT_W * b.h] / 255 * SKY_MAX;
}

/**
 * How lit a world point is, 0..1+, for things drawn without the chunk shader
 * (mobs, debris): the sky (by time of day and weather), plus block light —
 * including the light in the player's hand — in the room the sky leaves.
 */
function _lightAt(x, y, z) {
    const sky = _skyBrightnessAt(x, y, z) * (_atmos?.mobLight ?? 1);
    let lvl = _blockLevelAt(x, y, z);
    if (_handLevel > 0) {
        const c = camera.position;
        lvl = Math.max(lvl, _handLevel - Math.hypot(x - c.x, y - c.y - HAND_OFFSET_Y, z - c.z));
    }
    if (lvl <= 0) return sky;
    // As the chunk shader: block light fills the headroom the sky leaves.
    return sky + Math.pow(SKY_FALLOFF, SKY_MAX - lvl) * Math.min(lvl, 1) * _torchFlicker * Math.max(1 - sky, 0);
}

function _onLightReady(cx, cz, light) {
    const key = WorldState.key(cx, cz);
    _setChunkLight(key, light);
    // A mesh still waiting in the upload queue carries an older light than this.
    const queued = _meshQueue.get(key);
    if (queued) queued.light = null;
}

// ── Mesh upload queue ────────────────────────────────────────────────────────
// Worker results arrive in bursts — several chunks can finish in the same
// frame while new terrain streams in — and each one is a geometry upload, a
// light texture upload and, for a new chunk, two new materials. Installing
// them all at once turned a burst into a visible hitch. Results wait here and
// are installed a few per frame, nearest first (_drainMeshQueue). Chunks right
// around the player skip the queue, so a block edit shows at once.
const _meshQueue = new Map();       // key → { cx, cz, geo, light }
const MESH_UPLOADS_PER_FRAME = 4;   // at least this many; more when a backlog builds
const MESH_IMMEDIATE_CHUNKS  = 2;   // chunks this close to the player are never queued

function _onMeshReady(cx, cz, geo, light) {
    const key  = WorldState.key(cx, cz);
    // A newer result for a chunk still in the queue replaces it. ChunkManager
    // passes null light when a newer light has already gone out; if that was the
    // queued result's, it is still the newest, so it is kept.
    const item = { cx, cz, geo, light: light ?? _meshQueue.get(key)?.light ?? null };
    const pcx = Math.floor(me.position.x) >> CHUNK_SHIFT, pcz = Math.floor(me.position.z) >> CHUNK_SHIFT;
    if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) <= MESH_IMMEDIATE_CHUNKS) {
        _meshQueue.delete(key);
        _installMesh(key, item, true);
    } else {
        _meshQueue.set(key, item);
    }
}

/** Install queued meshes: all of them while the loading screen is up, else a few, nearest first. */
function _drainMeshQueue() {
    const n = _meshQueue.size;
    if (n === 0) return;
    const budget = _loadGateDone ? Math.max(MESH_UPLOADS_PER_FRAME, Math.ceil(n / 8)) : n;
    if (budget >= n) {
        for (const [key, item] of _meshQueue) _installMesh(key, item);
        _meshQueue.clear();
        return;
    }
    const px = me.position.x / CHUNK_SIZE, pz = me.position.z / CHUNK_SIZE;
    const order = [..._meshQueue].sort(([, a], [, b]) =>
        ((a.cx + 0.5 - px) ** 2 + (a.cz + 0.5 - pz) ** 2) - ((b.cx + 0.5 - px) ** 2 + (b.cz + 0.5 - pz) ** 2));
    for (let i = 0; i < budget; i++) {
        const [key, item] = order[i];
        _meshQueue.delete(key);
        _installMesh(key, item);
    }
}

// A chunk is one opaque and one transparent mesh (either may be absent), so it
// costs at most two draw calls — two more with shadows on. `urgent`: next to
// the player (an edit, most likely), so its shadow updates on the next frame.
function _installMesh(key, { cx, cz, geo, light }, urgent = false) {
    _atmos?.setColumnHeights(cx, cz, geo.rain);   // blocks changed: where rain stops has too
    _removeMeshes(key);
    _setChunkLight(key, light);
    const mats  = _chunkLight(key);
    // Where the chunk is in the tile tilePos() repeats over (CHUNK_COMMON).
    const wrap = (c) => ((c % TILE_CHUNKS) + TILE_CHUNKS) % TILE_CHUNKS;
    mats.uniforms.uChunk.value[U_TILE] = wrap(cx) + wrap(cz) * TILE_CHUNKS;
    const box = _chunkBox(cx, cz, geo);
    const entry = {
        opaque: null, transparent: null, key, cx, cz,
        box, rel: mats.uniforms.uChunk.value,
        bytes: _geoBytes(geo),   // on the GPU (diagnostics)
        // What of it the camera could see (engine/Visibility.js, _updateVisibility):
        // where each section's triangles are, which of its faces open space
        // joins, the sections it has triangles in, the ones to draw — all of
        // them until the next search — and the box round those.
        sections: geo.sections ?? null, conn: geo.conn ?? null,
        secLo: 0, secHi: SECTIONS - 1, drawLo: 0, drawHi: SECTIONS - 1,
        drawStart: 0, drawCount: Infinity, viewBox: box.clone(),
    };
    _sectionRange(entry);
    if (geo.positions.length > 0) {
        entry.opaque = _addChunkMesh(_buildGeometry(geo, false), mats.opaque, cx, cz);
    }
    if (geo.transparentPositions.length > 0) {
        // Water and ice: skipped in the shadow depth pass by their texture.
        entry.transparent = _addChunkMesh(_buildGeometry(geo, true), mats.transparent, cx, cz);
    }
    _applyDrawRange(entry);
    chunkMeshes.set(key, entry);
    _visDirty = true;
    if (urgent) _visUrgent = true;      // an edit beside the player may have opened a cave
    _shadows?.invalidate(entry.box, urgent);
    _far?.chunksChanged();
}

/** Bytes of vertex and index data in a worker's geometry result. */
function _geoBytes(geo) {
    let n = 0;
    for (const k in geo) if (geo[k]?.byteLength && k !== 'rain' && k !== 'sections' && k !== 'conn') n += geo[k].byteLength;
    return n;
}

// ── What the camera cannot see ───────────────────────────────────────────────
// Most of a chunk's triangles are cave walls, and from the surface none of
// them show — but a chunk is one mesh from its cave floors to its peaks, so
// all of them were drawn whenever the column was in view: well over half the
// triangles of every frame. engine/Visibility.js works out which sixteen-level
// sections of each chunk the camera could see at all, from what the mesh
// workers found open inside each (geo.conn), and the mesher puts a chunk's
// triangles in order of section (geo.sections) — so what is left out is a
// range of indices, and a chunk is still one draw.
//
// The search depends on where the camera is, not on where it looks: it runs
// when the camera moves into another section, and when a chunk's mesh comes
// or goes (at most every VIS_INTERVAL seconds for that, since while terrain
// streams in one does every frame; an edit next to the player counts at
// once). A chunk meshed since the last search is drawn whole until the next.
//
// It only holds while the camera is in the open: sight is followed through
// open cells. A spectator flying through rock looks out through it, so then
// everything is drawn (_cameraInRock).
//
// Only the view is narrowed. The shadow pass draws every chunk whole, as it
// always has: what casts a shadow into view need not be in view itself.
const _secVis = new SectionVisibility();
const VIS_INTERVAL = 0.15;
let _visDirty  = true;     // a mesh came or went since the last search
let _visUrgent = false;    // … next to the player
let _visAt     = -1;       // when the last search ran (seconds)
let _visCx = NaN, _visCz = NaN, _visSec = NaN;   // the camera's section then
let _visOff    = false;    // everything was drawn then (camera in rock, or switched off)
let _visRuns   = 0;        // searches so far (diagnostics)
let _caveCull  = true;     // window.__wwCaveCull(false) draws everything, to compare

/** The sections `entry` has triangles in (secHi < secLo: none). */
function _sectionRange(entry) {
    const s = entry.sections;
    if (!s) return;
    let lo = SECTIONS, hi = -1;
    for (let i = 0; i < SECTIONS; i++) if (s[i + 1] > s[i]) { if (i < lo) lo = i; hi = i; }
    entry.secLo = lo; entry.secHi = hi;
    entry.drawLo = lo; entry.drawHi = hi;
}

/**
 * Turn `entry`'s sections to draw (drawLo … drawHi) into the range of indices
 * that is, and the box round it — which is what the view frustum is tested
 * against, so a chunk whose only part in view is caves nobody can see is not
 * drawn at all.
 */
function _applyDrawRange(entry) {
    const s = entry.sections, box = entry.box, vb = entry.viewBox;
    vb.min.y = box.min.y; vb.max.y = box.max.y;
    if (!s) { entry.drawStart = 0; entry.drawCount = Infinity; return; }
    if (entry.drawHi < entry.drawLo) { entry.drawStart = 0; entry.drawCount = 0; return; }
    entry.drawStart = s[entry.drawLo];
    entry.drawCount = s[entry.drawHi + 1] - entry.drawStart;
    // A smooth surface may dip a block and a half under its own voxel.
    vb.min.y = Math.max(box.min.y, WORLD_MIN_Y + entry.drawLo * SECTION_SIZE - 2 - CULL_MARGIN);
    vb.max.y = Math.min(box.max.y, WORLD_MIN_Y + (entry.drawHi + 1) * SECTION_SIZE + CULL_MARGIN);
}

/** Is the point inside a block sight does not pass through? */
function _pointInRock(x, y, z) {
    const id = worldState.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (id === 0 || !_blockReg.isSolid(id)) return false;     // air, water, leaves, glass, a torch
    return _smooth?.isMesh(id) ? _smooth.pointInMesh(x, y, z) : true;
}

// The camera, and as far round it as the near plane reaches.
const ROCK_PROBE = 0.15;
function _cameraInRock() {
    if (!worldState || !_blockReg) return false;
    const p = camera.position;
    for (let k = 0; k < 8; k++) {
        if (_pointInRock(p.x + (k & 1 ? ROCK_PROBE : -ROCK_PROBE), p.y + (k & 2 ? ROCK_PROBE : -ROCK_PROBE),
                         p.z + (k & 4 ? ROCK_PROBE : -ROCK_PROBE))) return true;
    }
    return false;
}

/** Once a frame, before the view is culled: search again if anything it depends on changed. */
function _updateVisibility(now) {
    if (chunkMeshes.size === 0) return;
    const p = camera.position;
    const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
    const sec = sectionOf(p.y - WORLD_MIN_Y);
    const off = !_caveCull || _cameraInRock();
    const moved = cx !== _visCx || cz !== _visCz || sec !== _visSec || off !== _visOff;
    if (!moved && !_visDirty) return;
    if (!moved && !_visUrgent && now - _visAt < VIS_INTERVAL) return;
    _visDirty = false; _visUrgent = false; _visAt = now;
    _visCx = cx; _visCz = cz; _visSec = sec; _visOff = off;
    _visRuns++;
    if (off) {
        for (const e of chunkMeshes.values()) { e.drawLo = e.secLo; e.drawHi = e.secHi; }
    } else {
        _secVis.compute(chunkMeshes.values(), cx, cz, sec);
    }
    for (const e of chunkMeshes.values()) _applyDrawRange(e);
}

/** Draw everything (false) or only what the camera could see (true): for comparing the two. */
window.__wwCaveCull = (on) => { _caveCull = !!on; _visDirty = true; _visUrgent = true; return _caveCull; };

// ── What far terrain shows of land the player has changed ───────────────────
// Far terrain is drawn from the generator, which knows nothing of what has
// been built or dug. So a chunk that has been changed leaves a summary of its
// surface behind — the highest block of each column, and which block it is —
// when it is saved or unloaded: FarTerrain lays those over its tiles
// (setEdit), and the server keeps them with the world (far-edits.json), so
// they are there the next time the world is opened, from however far away.
const FAR_EDIT_BYTES = CHUNK_SIZE * CHUNK_SIZE * 4;
let _farEditsOut = new Map();   // summaries not sent to the server yet: key → bytes

/** Summarise chunk `key` for far terrain, if it was edited since its last summary. */
function _summariseEdited(key) {
    if (!worldState?.edited.delete(key)) return;
    const chunk = worldState.chunks.get(key);
    if (!chunk?.generated) return;
    const bytes = new Uint8Array(FAR_EDIT_BYTES);
    const heights = new Int16Array(bytes.buffer, 0, CHUNK_SIZE * CHUNK_SIZE);
    const ids = new Uint16Array(bytes.buffer, CHUNK_SIZE * CHUNK_SIZE * 2, CHUNK_SIZE * CHUNK_SIZE);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            // (The highest block that is one: not a flower or a torch, which rain falls past.)
            let ly = chunk.columnTop(lx, lz), id = 0;
            while (ly >= 0 && ((id = chunk.getVoxel(lx, ly, lz)) === 0 || _blockReg.get(id).rain === 0)) ly--;
            const k = lx + lz * CHUNK_SIZE;
            heights[k] = ly < 0 ? EDIT_EMPTY : WORLD_MIN_Y + ly;
            ids[k] = ly < 0 ? 0 : id;
        }
    }
    _far?.setEdit(chunk.cx, chunk.cz, heights, ids);
    _farEditsOut.set(key, bytes);
}

/** Send the summaries made since the last save to the server. */
function _saveFarEdits() {
    if (!chunkManager?.worldId || _remote || _farEditsOut.size === 0) return;
    const body = {};
    for (const [key, bytes] of _farEditsOut) body[key] = btoa(String.fromCharCode(...bytes));
    _farEditsOut = new Map();
    fetch(`${SERVER_URL}/api/worlds/${chunkManager.worldId}/far-edits`, {
        method: 'PUT', keepalive: JSON.stringify(body).length < 60000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).catch(() => { /* offline */ });
}

/** The summaries the server holds for this world, into far terrain. */
async function _loadFarEdits(worldId) {
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/far-edits`);
        if (!res.ok || !_far) return;
        for (const [key, b64] of Object.entries(await res.json())) {
            const [cx, cz] = key.split(',').map(Number);
            const raw = atob(b64);
            if (raw.length !== FAR_EDIT_BYTES || !Number.isInteger(cx) || !Number.isInteger(cz)) continue;
            const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            _far?.setEdit(cx, cz, new Int16Array(bytes.buffer, 0, CHUNK_SIZE * CHUNK_SIZE),
                          new Uint16Array(bytes.buffer, CHUNK_SIZE * CHUNK_SIZE * 2, CHUNK_SIZE * CHUNK_SIZE));
        }
    } catch { /* offline, or a world from before this */ }
}

function _onChunkUnload(key) {
    _summariseEdited(key);
    if (_ticking.size) {
        const c = key.indexOf(','), cx = Number(key.slice(0, c)), cz = Number(key.slice(c + 1));
        for (const [k, e] of _ticking) if ((e.x >> CHUNK_SHIFT) === cx && (e.z >> CHUNK_SHIFT) === cz) _ticking.delete(k);
    }
    _meshQueue.delete(key);
    _atmos?.dropColumns(key);
    _removeMeshes(key);
    _disposeChunkLight(key);
}

function _addChunkMesh(geometry, material, cx, cz) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * CHUNK_SIZE, WORLD_MIN_Y, cz * CHUNK_SIZE);
    // Chunks never move: compose the matrices once, here. Nothing updates them
    // afterwards (chunkGroup).
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
    // Culled by _cullChunks against the chunk's box instead of Three.js's test
    // against the bounding sphere (see there).
    mesh.frustumCulled = false;
    mesh.layers.enable(SHADOW_LAYER);
    // Not composed in the view pass (_chunkModelView).
    mesh.modelViewMatrix.multiplyMatrices = _chunkModelView;
    mesh.normalMatrix.getNormalMatrix     = _chunkNormalMatrix;
    chunkGroup.add(mesh);
    return mesh;
}

// ── Chunk culling ────────────────────────────────────────────────────────────
// A chunk column's geometry runs from its cave floors to its peaks — often two
// hundred blocks for a sixteen-block footprint — so its bounding sphere is
// about a hundred blocks across. Three.js culls with that sphere, which let
// through most chunks beside and behind the camera and most of the world
// outside the shadow box, each costing a draw call and its vertices. Testing
// the chunk's actual box is exact and cheap, and runs once per pass: for the
// shadow camera (ShadowMapper.onCull) and then the view.
const _cullFrustum = new THREE.Frustum();
const _cullMatrix  = new THREE.Matrix4();
const CULL_MARGIN  = 1;   // blocks; covers leaves swaying in the wind (CHUNK_VERT)

function _chunkBox(cx, cz, geo) {
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const y0 = WORLD_MIN_Y + (geo.yMin ?? 0);
    const y1 = WORLD_MIN_Y + (geo.yMax ?? (CHUNK_SIZE_Y - 1)) + 1;
    return new THREE.Box3(
        new THREE.Vector3(x0 - CULL_MARGIN, y0 - CULL_MARGIN, z0 - CULL_MARGIN),
        new THREE.Vector3(x0 + CHUNK_SIZE + CULL_MARGIN, y1 + CULL_MARGIN, z0 + CHUNK_SIZE + CULL_MARGIN));
}

/**
 * Show exactly the chunks whose box `cam` can see. `cam`'s matrices must be
 * current. With `relTo` (the view camera's position) this is the view: each
 * visible chunk also gets its origin relative to it — see _viewChunks — its
 * water its place in the draw order, and its opaque mesh only the sections
 * the camera could see (_updateVisibility), tested against the box round
 * those. Without it (the shadow camera) a chunk is drawn whole.
 *
 * Water and ice are blended, so chunks of them must be drawn far to near.
 * Three.js would order them by the depth of each mesh's origin, which for a
 * chunk is a corner at the bottom of the world: looking down, that puts them
 * in the wrong order. Chunks are columns on a grid, and for those the right
 * order is simply by how many chunks away they are, counted along x plus
 * along z — a line of sight from the camera's chunk never comes back toward
 * it on either axis. renderOrder carries it (lower is drawn first); within a
 * chunk the mesher has ordered the faces (GreedyMesher._orderTranslucent).
 */
function _cullChunks(cam, relTo = null) {
    _cullMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _cullFrustum.setFromProjectionMatrix(_cullMatrix, cam.coordinateSystem, cam.reversedDepth);
    const pcx = relTo ? Math.floor(relTo.x / CHUNK_SIZE) : 0, pcz = relTo ? Math.floor(relTo.z / CHUNK_SIZE) : 0;
    if (!relTo) {
        for (const e of chunkMeshes.values()) {
            const vis = _cullFrustum.intersectsBox(e.box);
            if (e.opaque) {
                e.opaque.visible = vis;
                if (vis) e.opaque.geometry.setDrawRange(0, Infinity);
            }
            if (e.transparent) e.transparent.visible = vis;
        }
        return;
    }
    for (const e of chunkMeshes.values()) {
        const vis = e.opaque !== null && e.drawCount !== 0 && _cullFrustum.intersectsBox(e.viewBox);
        // Water is drawn wherever the chunk is in view.
        const visT = e.transparent !== null && _cullFrustum.intersectsBox(e.box);
        if (e.opaque) {
            e.opaque.visible = vis;
            if (vis) e.opaque.geometry.setDrawRange(e.drawStart, e.drawCount);
        }
        if (e.transparent) e.transparent.visible = visT;
        if (vis || visT) {
            const r = e.rel;
            r[U_REL]     = e.cx * CHUNK_SIZE - relTo.x;
            r[U_REL + 1] = WORLD_MIN_Y - relTo.y;
            r[U_REL + 2] = e.cz * CHUNK_SIZE - relTo.z;
            if (visT) e.transparent.renderOrder = -1 - Math.abs(e.cx - pcx) - Math.abs(e.cz - pcz);
        }
    }
}

/**
 * Cull for the view camera, and give each visible chunk its origin relative to
 * the camera (uChunkRel, see CHUNK_VERT) — in doubles here, so the shader only
 * ever sees small numbers.
 */
function _viewChunks(cam) {
    _cullChunks(cam, cam.position);
    _viewFrustum.copy(_cullFrustum);
    _viewFrustumValid = true;
}

// What the view camera could see when the last frame was drawn, for deciding
// which mobs are worth posing (EntityManager.seen). Mobs are updated before
// the camera is, so this is a frame old; _mobSeen allows for that.
const _viewFrustum = new THREE.Frustum();
let _viewFrustumValid = false;
const _seenSphere = new THREE.Sphere();
const MOB_SEEN_MARGIN = 2;      // blocks the camera can move in a frame, and to spare
const MOB_SHADOW_REACH = 24;    // blocks: the longest shadow of a mob that is looked for

/**
 * Can anything in the sphere (x, y, z, r) be seen — a mob there, or the shadow
 * it casts? A shadow lies away from the light, longer the lower the light is.
 */
function _mobSeen(x, y, z, r) {
    if (!_viewFrustumValid) return true;
    let reach = r + MOB_SEEN_MARGIN;
    if (_shadows?.enabled && _atmos && _atmos.state.directStrength > 0.01) {
        const l = _atmos.state.lightDir;
        reach += Math.min(2 * r * Math.hypot(l[0], l[2]) / Math.max(l[1], 0.12), MOB_SHADOW_REACH);
    }
    _seenSphere.center.set(x, y, z);
    _seenSphere.radius = reach;
    return _viewFrustum.intersectsSphere(_seenSphere);
}

// Reused scratch so the bounding sphere below allocates nothing per chunk.
const _bsCenter = new THREE.Vector3();

// BufferAttribute.onUpload callback (`this` is the attribute): the GPU has the
// data, so the CPU copy can go.
function _releaseArray() { this.array = null; }

function _buildGeometry(geo, transparent) {
    const buf  = new THREE.BufferGeometry();
    const pos  = transparent ? geo.transparentPositions : geo.positions;
    const tint = transparent ? geo.transparentTints     : geo.tints;
    const idx  = transparent ? geo.transparentIndices   : geo.indices;
    const uvs  = transparent ? geo.transparentUVs       : geo.uvs;
    const nrm  = transparent ? geo.transparentNormals   : geo.normals;

    // 24 bytes a vertex, packed by the mesher (engine/MeshFormat.js): the
    // colour and texture layer as four bytes, the uv as two shorts, and the
    // normal as four signed bytes (xyz, glow), all read normalised. Four bytes,
    // not three: Direct3D (ANGLE) has no three-byte vertex format, so three
    // would be converted on the CPU at every upload.
    //
    // Once on the GPU the arrays are dropped (_releaseArray). Nothing reads a
    // chunk's vertices on the CPU — collision and raycasts use the voxels, and
    // the bounds are set below — so keeping them doubled every chunk's memory
    // in the JavaScript heap, over a hundred megabytes at a long render
    // distance, and made every garbage collection longer.
    buf.setAttribute('position', new THREE.BufferAttribute(pos,  3).onUpload(_releaseArray));
    buf.setAttribute('tint',     new THREE.BufferAttribute(tint, 4, true).onUpload(_releaseArray));
    buf.setAttribute('uv',       new THREE.BufferAttribute(uvs,  2, true).onUpload(_releaseArray));
    buf.setAttribute('nrm',      new THREE.BufferAttribute(nrm,  4, true).onUpload(_releaseArray));
    buf.setIndex(new THREE.BufferAttribute(idx, 1).onUpload(_releaseArray));

    // Set the bounding sphere from the chunk's known extent instead of letting
    // Three.js derive it lazily, which would scan every position on the main
    // thread the first time the chunk is considered for frustum culling.
    const yMin = geo.yMin ?? 0;
    const yMax = (geo.yMax ?? (CHUNK_SIZE_Y - 1)) + 1;
    const halfY = (yMax - yMin) * 0.5;
    _bsCenter.set(CHUNK_SIZE * 0.5, yMin + halfY, CHUNK_SIZE * 0.5);
    const halfXZ = CHUNK_SIZE * 0.5;
    buf.boundingSphere = new THREE.Sphere(
        _bsCenter.clone(),
        Math.sqrt(halfXZ * halfXZ * 2 + halfY * halfY),
    );

    return buf;
}

function _removeMeshes(key) {
    const entry = chunkMeshes.get(key);
    if (!entry) return;
    for (const mesh of [entry.opaque, entry.transparent]) {
        if (!mesh) continue;
        chunkGroup.remove(mesh);
        mesh.geometry.dispose();
    }
    chunkMeshes.delete(key);
    _visDirty = true;       // what it hid may show now
    _shadows?.invalidate(entry.box);
    _far?.chunksChanged();
}

function _disposeAll() {
    _meshQueue.clear();
    _shadows?.invalidate();   // the next world starts from fresh shadows
    for (const key of [...chunkMeshes.keys()]) _removeMeshes(key);
    for (const key of [...chunkLights.keys()]) _disposeChunkLight(key);
    _selBlock = null;

    // The block atlas is rebuilt on every world load, so it has to be released
    // on every unload too — otherwise each world entered in a session leaves
    // another DataArrayTexture resident on the GPU.
    _blockTexArray?.dispose();
    _blockTexArray = null;
    _disposePrimers();
    _noBlockLight?.dispose();
    _noBlockLight  = null;
    chunkUniforms  = null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _saveAll() {
    if (!(chunkManager?.worldId && worldClient?.connected)) return;
    // Someone else's world, online: the host's game keeps it. This only notes which chunks to ask the host for again.
    if (_remote) { chunkManager.saveAll(); return; }

    const client = worldClient;   // capture — quitWorld may null worldClient mid-save
    window.dispatchEvent(new CustomEvent('ww_saving', { detail: { active: true } }));

    chunkManager.saveAll();   // queues the batch onto the WebSocket send buffer
    if (!_guest) _savePendingEdits();
    _saveChests();
    _saveMobs();
    for (const key of [...worldState.edited]) _summariseEdited(key);
    _saveFarEdits();
    if (!_guest) _saveScreenshot(chunkManager.worldId);

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
/**
 * Request a world thumbnail.
 *
 * The capture itself has to happen in the same task as a render, because the
 * renderer no longer sets preserveDrawingBuffer (it costs a full-framebuffer
 * copy every frame). So this only flags the request; _render() performs the
 * capture immediately after the next draw, while the buffer is still valid.
 */
function _saveScreenshot(worldId) {
    if (!renderer || !worldId) return;
    _pendingScreenshotWorldId = worldId;
}

let _pendingScreenshotWorldId = null;

// Live render stats, for the in-game FPS overlay and for automated smoke tests.
// Reading renderer.info is free — Three.js maintains it regardless.
window.__wwDebug = () => {
    if (!renderer) return null;
    const i = renderer.info;
    return {
        meshes:     chunkMeshes.size,
        // Chunk work outstanding: generation and mesh jobs in flight or held,
        // and finished meshes waiting to be installed. All zero once an area
        // has fully loaded.
        pending:    chunkManager ? chunkManager._pendingGen.size + chunkManager._pendingMesh.size + chunkManager._gated.size : 0,
        queued:     _meshQueue.size,
        player:     me?.position ? { x: +me.position.x.toFixed(1), y: +me.position.y.toFixed(1), z: +me.position.z.toFixed(1) } : null,
        // The scene pass alone, not the shadow, cloud or post-processing passes
        // (renderer.info resets on every render() call).
        drawCalls:  _frameStats.calls,
        tris:       _frameStats.tris,
        geometries: i.memory.geometries,
        textures:   i.memory.textures,
        programs:   i.programs?.length ?? 0,
        programTypes: i.programs?.map(p => `${p.type}#${p.id}`) ?? [],
        chunks:     worldState?.chunks.size ?? 0,
        renderDist: _renderDist,
        far:        _far?.info() ?? null,
        shadows:    _shadows?.level ?? 'off',
        shadowRedraws: _shadows?.redraws ?? 0,
        shadowCopies: _shadows?.copies ?? 0,
        mobs:       _entities?.mobCount ?? 0,
        mobsPosed:  _entities?.posed ?? 0,
        clouds:     _atmos?.clouds.level ?? _gfx.clouds,
        sky:        _atmos?.skyMode ?? _gfx.sky,
        atmosphere: _atmos?.info() ?? null,
        particles:  _particles?.level ?? _gfx.particles,
        terrainStyle: _terrainStyle,
        worldGen:   _worldGen,
        pixelRatio: renderer.getPixelRatio(),
        cameraFar:  camera?.far ?? null,
        fogNear:    chunkUniforms?.uFogNear.value ?? null,
        fogFar:     chunkUniforms?.uFogFar.value ?? null,
        eyeAdaptation: !!_post?.active,
        eyeAdaptationSupported: _post?.supported ?? null,
        handLight:  +_handLevel.toFixed(2),
        blockLitChunks: [...chunkLights.values()].filter(e => e.block).length,
        // What the camera cannot see (engine/Visibility.js): whether it is being
        // left out, the sections the last search reached, how many searches
        // there have been, and the share of the chunks' opaque triangles that
        // their draw ranges take in (before the view frustum).
        visibility: _visibilityInfo(),
    };
};

function _visibilityInfo() {
    let all = 0, drawn = 0, hidden = 0;
    for (const e of chunkMeshes.values()) {
        const s = e.sections;
        if (!s || !e.opaque) continue;
        all += s[SECTIONS];
        if (e.drawCount === 0) hidden++;
        else drawn += e.drawCount === Infinity ? s[SECTIONS] : e.drawCount;
    }
    return { on: _caveCull && !_visOff, reached: _secVis.reached, searches: _visRuns,
             hiddenChunks: hidden, drawnShare: all ? +(drawn / all).toFixed(3) : 1 };
}

/**
 * Where the memory of the loaded world is, in MB (diagnostics): voxels, the
 * CPU copies of the light volumes (the GPU holds each once more as a texture),
 * the chunk geometry on the GPU, and how many chunk meshes the last frame's
 * culling left visible.
 */
window.__wwMemory = () => {
    let voxels = 0, sky = 0, block = 0, opaque = 0, transparent = 0, geometry = 0;
    for (const c of worldState?.chunks.values() ?? []) voxels += c.byteLength;
    for (const e of chunkLights.values()) { sky += e.data?.byteLength ?? 0; block += e.block?.data.byteLength ?? 0; }
    for (const e of chunkMeshes.values()) {
        geometry += e.bytes;
        if (e.opaque?.visible) opaque++;
        if (e.transparent?.visible) transparent++;
    }
    const mb = (b) => +(b / 1048576).toFixed(1);
    return { chunks: worldState?.chunks.size ?? 0, voxelsMB: mb(voxels), skyLightMB: mb(sky), blockLightMB: mb(block),
             geometryMB: mb(geometry),
             visibleOpaque: opaque, visibleTransparent: transparent };
};

// The atmosphere, for poking at weather from the console and in diagnostics.
window.__wwAtmos = () => _atmos;

/**
 * Put a block (by name) at a world position, as an edit would — for the smoke
 * test and the console. Returns false with no world or an unknown name.
 */
window.__wwSetBlock = (x, y, z, name) => {
    const def = name === 'AIR' ? { id: 0 } : _blockReg?.getByName(name);
    if (!worldState || !chunkManager || !def) return false;
    worldState.setBlock(Math.floor(x), Math.floor(y), Math.floor(z), def.id);
    chunkManager.markEdited(Math.floor(x), Math.floor(z));
    return true;
};
/**
 * Put a mob (an entity id: 'cow', 'quiddle', …) at a world position — for
 * tests and the console. Returns its id, or null.
 */
window.__wwSpawnMob = (type, x, y, z, still = false) => {
    const id = _entities?._spawnMob(type, { x, y, z }) ?? null;
    // `still`: it stays where it is put, whatever it decides to do (a test that needs it there).
    if (still && id != null) { const mob = _entities._mobs.get(id); mob.def = { ...mob.def, speed: 1e-4 }; }
    return id;
};
/** Strike the mob nearest a point, as a blow from the player would — for tests. */
window.__wwHitMob = (x, y, z, damage) => _entities?.hitNearest({ x, y, z }, damage, 2) ?? 0;
/** Strike another player as a blow from this one would (PvP) — for tests. Returns whether there was anyone to strike. */
window.__wwStrike = (id, damage, far = false) => {
    const o = _otherPos.find(q => q.id === id);
    if (!o || !_pvp) return false;
    _strikePlayer({ id, x: o.x, y: o.y, z: o.z }, damage, far);
    return true;
};
/** What the mobs are doing (diagnostics): [{ id, type, state, x, y, z, health, onGround, aimed }]. */
window.__wwMobs = () => [...(_entities?._mobs.values() ?? [])].map(m => ({
    id: m.id, type: m.typeId, state: m.dying > 0 ? 'DYING' : m.state, health: m.health, onGround: m.onGround,
    x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2), model: !!m.inst,
    aimed: m === _entities.highlight,       // under the player's crosshair, in reach and in plain sight
}));
/** The block id at a world position (0 = air or no world). */
// Sitting or lying down (test hooks): where, or null; and the view (0 the eyes, 1 behind, 2 in front).
window.__wwRest = () => (_rest ? { kind: _rest.kind, x: _rest.x, y: _rest.y, z: _rest.z } : null);
window.__wwHands = () => _hands;
window.__wwView = (m) => { if (Number.isInteger(m)) _camMode = Math.max(0, Math.min(2, m)); return _camMode; };
window.__wwBlockAt = (x, y, z) => worldState?.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) ?? 0;
/** Break the block at a world position as the player would, with what that brings (drops, a chest's contents) — for tests. */
window.__wwBreak = (x, y, z) => {
    const p = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, blockId = worldState?.getBlock(p.x, p.y, p.z) ?? 0;
    if (!blockId) return false;
    _breakBlock({ ...p, blockId, face: { x: 0, y: 1, z: 0 } });
    return true;
};
/** What is lying on the ground (diagnostics): [{ itemId, count }]. */
window.__wwDrops = () => (_entities?._drops ?? []).map(d => ({ itemId: d.itemId, count: d.count }));
/** Sky and block light levels (0..15) at a world position, as the CPU sees them. */
window.__wwLightAt = (x, y, z) => ({
    sky: +(Math.log(Math.max(_skyBrightnessAt(x, y, z), SKY_MIN)) / Math.log(SKY_FALLOFF)).toFixed(2),
    block: +_blockLevelAt(x, y, z).toFixed(2),
});
/** Eye Adaptation's current exposure (a GPU read: diagnostics only). */
window.__wwExposure = () => _post?.readback() ?? null;
/** Where the camera points (radians): for tests. */
window.__wwPadLook = () => ({ yaw, pitch });
/** Point the camera (radians): for screenshots in tests. */
window.__wwLook = (y, p) => { yaw = y; pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p)); };
/** Move the player (creative: hovering there) — for tests and the console. */
window.__wwTeleport = (x, y, z) => {
    if (!me?.position) return false;
    if (_rest) _getUp();
    me.position = { x, y, z };
    if (_physics) { _physics.vel = { x: 0, y: 0, z: 0 }; if (_gameMode === 'CREATIVE') _physics.flying = true; }
    return true;
};

/** Draw the scene, then service a pending screenshot request in the same task. */
let _lastRenderMs = 0;
const _frameStats = { calls: 0, tris: 0 };

// The light the player holds (items' `heldLight`), eased as it changes hands.
let _handLevel = 0;
let _torchFlicker = 1;
let _flickerT = 0;
const HAND_OFFSET_Y = -0.25;   // a little below the eye

function _updateBlockLightUniforms(dt) {
    let want = 0;
    if (_inventory && _itemReg && !_isDead) {
        for (const s of [_inventory.getHotbar(_hotbarSlot), _inventory.offhand]) {
            const lvl = s ? (_itemReg.getItem(s.itemId)?.heldLight ?? 0) : 0;
            if (lvl > want) want = lvl;
        }
    }
    _handLevel += (want - _handLevel) * (1 - Math.exp(-dt * 10));
    if (_handLevel < 0.01) _handLevel = 0;
    // A gentle, uneven flicker; steady with Reduce Motion.
    _flickerT += dt;
    const t = _flickerT;
    _torchFlicker = _gfx.reduceMotion ? 1
        : 1 - 0.035 * (0.5 + 0.5 * (Math.sin(t * 7.3) * 0.5 + Math.sin(t * 11.9 + 1.3) * 0.3 + Math.sin(t * 23.1 + 2.1) * 0.2));
    if (!chunkUniforms) return;
    chunkUniforms.uHandLight.value.set(0, HAND_OFFSET_Y, 0, _handLevel);
    chunkUniforms.uTorchFlicker.value = _torchFlicker;
    chunkUniforms.uGlowBoost.value = _post?.active ? GLOW_HDR : 1;
}

function _render() {
    // Its shaders are still being made ready (the loading screen is up): drawn now, it would wait on each.
    // (For 20 s at most: never a world left undrawn by a load that went wrong on the way.)
    if (_warming && performance.now() - _warming < 20000) return;
    // A screenshot is drawn at the screen's own resolution, whatever Resolution
    // says (and without the hands and the glow on the block looked at).
    if (_shotWanted && renderer) {
        _shotWanted = false;
        _shooting = true;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }
    const now = performance.now();
    const dt  = _lastRenderMs ? Math.min((now - _lastRenderMs) / 1000, 0.1) : 0;
    _lastRenderMs = now;
    _updateBlockLightUniforms(dt);
    _updateSelectUniform(dt);
    if (_atmos) {
        // Sky and fog follow the sky light where the camera is (eased inside the
        // atmosphere). Underground the sky cannot be seen, and a bright sky
        // colour would show through the tiniest gap between triangles and fade
        // distant tunnels to blue instead of into the dark.
        // (Paused, the storm stands still with the rest: no time passes for it.)
        const strikeAt = _strikeTarget();
        _atmos.update(_paused ? 0 : dt, {
            camera, paused: _paused,
            px: me.position.x, py: me.position.y, pz: me.position.z,
            strikeX: strikeAt?.x, strikeZ: strikeAt?.z,
            skyLight: worldState ? _skyBrightnessAt(camera.position.x, camera.position.y, camera.position.z) : 1,
            // Clouds fade out a little beyond the terrain fog, never before it.
            fade: Math.max(_viewChunksOut() * CHUNK_SIZE * 1.6, 160),
            fog: scene.fog, background: scene.background,
        });
        _shadows?.setLightDir(_atmos.state.lightDir);
    }
    // No direct light (night between moonrise and moonset, or twilight): no
    // shadow to cast, so skip the depth pass.
    const directLight = _atmos ? _atmos.state.directStrength > 0.01 : true;
    _drainMeshQueue();
    _far?.update(camera.position.x, camera.position.z, _renderDist, chunkMeshes, !_loadGateDone);
    if (_shadows?.enabled && chunkUniforms && directLight) {
        _shadows.update(scene, camera.position, _entities?.shadowCasters() ?? null);
    }
    camera.updateMatrixWorld();
    _atmos?.prerender(renderer, camera);
    _updateVisibility(now / 1000);
    _viewChunks(camera);
    // Eye Adaptation: the scene goes into PostFX's linear half-float target,
    // which then meters, adapts, blooms and puts the frame on the canvas.
    const post = !!_post?.active;
    if (_atmos) _atmos.uniforms.uLinearOut.value = post;
    if (post) _post.begin();
    _viewPass = true;
    try { renderer.render(scene, camera); }
    finally { _viewPass = false; }
    _frameStats.calls = renderer.info.render.calls;
    _frameStats.tris  = renderer.info.render.triangles;
    // The player's hands, over everything (their own camera; not in a screenshot).
    if (!_shooting) _hands?.render(renderer, camera.aspect);
    if (post) {
        if (_atmos) _atmos.uniforms.uLinearOut.value = false;
        _post.end(dt);
    }
    if (_shooting) {
        _shooting = false;
        _saveScreenshotFile();
        _applyPixelRatio();
    }
    if (_pendingScreenshotWorldId !== null) {
        const worldId = _pendingScreenshotWorldId;
        _pendingScreenshotWorldId = null;
        _capturePendingScreenshot(worldId);
    }
    if (_grabFrame !== null) {
        const resolve = _grabFrame;
        _grabFrame = null;
        try {
            const src = renderer.domElement, c = document.createElement('canvas');
            c.width = src.width; c.height = src.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(src, 0, 0);
            resolve(ctx.getImageData(0, 0, c.width, c.height));
        } catch { resolve(null); }
    }
}

// ── Screenshots ──────────────────────────────────────────────────────────────
// F2, the pause menu's Screenshot, or a controller's View button: the next
// frame is drawn at full resolution and kept as a PNG — by the game's own
// server, in its screenshots folder; where there is none to keep it (a guest
// from the network: the server is someone else's), handed over as a download.
let _shotWanted = false, _shooting = false;
function _takeScreenshot() { if (renderer && worldState) _shotWanted = true; }
window.addEventListener('ww_screenshot', _takeScreenshot);

function _saveScreenshotFile() {
    let copy;
    try {
        // Copied now: the canvas does not keep its picture past this task.
        const src = renderer.domElement;
        copy = document.createElement('canvas');
        copy.width = src.width; copy.height = src.height;
        copy.getContext('2d').drawImage(src, 0, 0);
    } catch { _notice('The screenshot could not be taken'); return; }
    const world = String(_worldName || 'Wonder World');
    copy.toBlob(async (blob) => {
        if (!blob) { _notice('The screenshot could not be taken'); return; }
        window.dispatchEvent(new CustomEvent('ww_screenshotTaken'));
        try {
            if (window.__wwLanGuest) throw new Error('not ours');
            const res = await fetch(`${SERVER_URL}/api/screenshots?world=${encodeURIComponent(world)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
            if (!res.ok) throw new Error(String(res.status));
            const r = await res.json();
            _notice(`Screenshot saved: ${r.file}`);
            return;
        } catch { /* given as a download instead */ }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${world} screenshot.png`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        _notice('Screenshot saved');
    }, 'image/png');
}

/**
 * The next frame drawn, as ImageData (a Promise) — for tests that compare
 * frames in the page. Read in the task that draws it, as the thumbnail is:
 * the canvas does not keep its picture.
 */
let _grabFrame = null;
window.__wwGrabFrame = () => new Promise((resolve) => { _grabFrame = resolve; });

function _capturePendingScreenshot(worldId) {
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
        // Where dying brings this player back to (null: not found yet — the world's spawn, worked out when wanted).
        spawn: _worldSpawn,
        // The bed they last lay in: where dying brings them back to while it stands.
        bed: _bedSpawn,
        // The clock and the weather are the world's, kept with its owner.
        atmosphere: !_guest && _atmos?.active ? _atmos.toJSON() : null,
    };
    if (_remote) { online.session?.saveState(state); return; }
    try {
        await fetch(_stateUrl(chunkManager.worldId), {
            // It must outlive the page: a split screen's pane is taken away as its player leaves.
            method: 'PUT', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
        });
    } catch { /* offline */ }
}

// ── Weather on the player ─────────────────────────────────────────────────────

/**
 * What the weather does to the player's movement: a tornado's pull, a gale
 * leaning on them, and ice from freezing rain underfoot. Only out in the open —
 * shelter (anything overhead) cuts the wind and keeps the ground dry.
 */
function _applyWeatherToPlayer() {
    const ext = _physics.external, pu = _atmos?.push;
    ext.x = pu?.x ?? 0; ext.y = pu?.y ?? 0; ext.z = pu?.z ?? 0;
    // Ice underfoot is slippery whatever the weather (a block's `slippery`).
    const p = me.position, fx = Math.floor(p.x), fz = Math.floor(p.z);
    const under = worldState.getBlock(fx, Math.floor(p.y - 0.2), fz) || worldState.getBlock(fx, Math.floor(p.y - 1.2), fz);
    const icy = under > 0 ? _blockReg.get(under).slippery ?? 0 : 0;
    _physics.slip = icy;
    if (!_atmos || _gameMode === 'SPECTATOR') return;
    const open = _skyBrightnessAt(p.x, p.y + 1, p.z) >= 0.99;
    if (!open) return;
    const w = _atmos.wind, ws = Math.hypot(w[0], w[1]);
    if (ws > 12) {
        const k = (ws - 12) / ws * 0.35;
        ext.x += w[0] * k; ext.z += w[1] * k;
    }
    _physics.slip = Math.max(icy, _atmos.ice);
}

/**
 * Mobs and the other players push the player out of where they stand, as the
 * player pushes them (EntityManager._push): it joins the walking target, so a
 * player walking into a cow slows and squeezes past, and one standing still
 * is moved aside.
 */
function _pushPlayer() {
    if (!_entities || _rest || _isDead || _gameMode === 'SPECTATOR') return;
    const p = me.position, v = _entities.pushOn(p.x, p.y, p.z, _otherPos), ext = _physics.external;
    ext.x += v.x; ext.z += v.z;
}

/** A lightning strike landed at (x, y, z): hurt what is standing next to it. */
function _onLightningStrike(x, y, z) {
    if (!worldState || _spawnPending) return;
    const p = me.position;
    const d = Math.hypot(p.x - x, (p.y - y) * 0.5, p.z - z);
    if (d < 4) _applyDamage(4 + Math.round(12 * (1 - d / 4)));
    _entities?.hitNearest({ x, y, z }, 15, 3);
}

// ── Other players ─────────────────────────────────────────────────────────────
//
// Every world played through the server is a session there (engine/
// Multiplayer.js, server/multiplayer.js). Each game holds the whole world and
// runs its own player. What it tells the rest: where its player is (fifteen
// times a second), every block it changes, and — the host's only — the mobs,
// the clock and the weather. What it hears, it shows: the other players
// (Players.js), their blocks, the host's mobs. Alone, nothing is sent but the
// blocks, which the session keeps for whoever joins later.

const STATE_HZ = 15, MOB_SEND = 0.1, MOB_LOOKS = 2, ATMOS_SEND = 2;
let _mpStateT = 0, _mpMobT = 0, _mpLookT = 0, _mpAtmosT = 0, _mpAtmosWall = 0;
let _mobFull = false;          // someone has just joined: the next mob snapshot says what every mob looks like
let _mpApplying = false;       // a block is being put down because another game said so: do not say it back
let _swings = 0;               // blows begun, for the others to see each one
const _otherPos = [];

/** Where this player's state in this world is kept: the owner's file, or a guest's own. */
function _stateUrl(worldId) {
    return `${SERVER_URL}/api/worlds/${worldId}/player-state${_guest ? `?player=${encodeURIComponent(_stateKey)}` : ''}`;
}

/** The player's arm swings, here and on everyone else's screen. */
function _swingArm() {
    if (_playerModel?.swing()) _swings++;
    _hands?.swing();
}

function _notice(text) {
    window.dispatchEvent(new CustomEvent('ww_notice', { detail: { text } }));
}

/** Another game changed a block. */
function _applyRemoteBlock(x, y, z, b, quiet = false) {
    if (!worldState) return;
    const was = quiet ? 0 : worldState.getBlock(x, y, z);
    _mpApplying = true;
    const here = worldState.setBlock(x, y, z, b);       // not loaded here: kept, and put down when the chunk comes
    _mpApplying = false;
    if (!here) return;
    chunkManager?.markEdited(x, z);
    if (quiet) return;
    const at = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const from = was > 0 ? _blockReg.get(was) : null, to = b > 0 ? _blockReg.get(b) : null;
    // Opened or shut by them: the door's own sound, as they hear it.
    if (from?.use && to && (from.use.toggle === to.name || from.use.away === to.name)) _toggleSound(from, to, at, 0.7);
    else if (b === 0 && was > 0) _sounds?.blockBroken(from, at, 0.7);
    else if (b > 0 && !_blockReg.isLiquid(b)) _sounds?.blockPlaced(to, at, 0.6);
}

function _playerCasters() {
    if (!_entities) return;
    _entities.extraCasters = [(out, o) => _playerModel?.caster(out, o), ...(_others?.casters() ?? [])];
}

/**
 * Join the world's session; resolves with the server's welcome, or null (no server: playing alone and unseen).
 * `session`: an online room already in hand (Online.js) instead of the game's own server — see *Online*, below.
 */
async function _joinSession(worldId, session = null) {
    const mp = _mp = session ?? new Multiplayer(WS_URL);
    mp.onJoined = (p) => {
        _others?.add(p);
        _playerCasters();
        _mobFull = true; _mpStateT = _mpMobT = _mpAtmosT = 0;      // tell the newcomer everything now
        _notice(`${_label(p)} joined`);
        _chatShow({ kind: 'sys', text: `${_label(p)} joined.` });
        if (_ops.has(p.key)) _ops.set(p.key, p.name);          // an operator, under whatever name they have now
        if (!_guest && _opKeys.size) _sayTo(mp, p.id, { t: 'ops', keys: [..._opKeys] });
    };
    mp.onLeft = (id) => {
        const gone = _others?.map.get(id), name = gone ? _label(gone) : '';
        _others?.remove(id);
        _sleepers.delete(id);
        _entities?.dropOwner(id);                          // the mobs their game was running went with it
        _playerCasters();
        if (name) { _notice(`${name} left`); _chatShow({ kind: 'sys', text: `${name} left.` }); }
    };
    mp.onState = (id, s) => _others?.state(id, s);
    mp.onProfile = (p) => _others?.profile(p);
    mp.onBlock = (x, y, z, b) => _applyRemoteBlock(x, y, z, b);
    // Online, the host's game settles what a block is when players disagree: what this block is here, or null where no chunk is loaded.
    mp.blockAt = (x, y, z) => worldState?.chunks.has(`${x >> 4},${z >> 4}`) ? worldState.getBlock(x, y, z) : null;
    mp.onDown = (down) => _notice(down ? 'Connection lost — reconnecting…' : 'Reconnected');
    mp.onAtmos = (a) => {
        if (mp.isHost) return;
        _atmos?.sync(a);
        // The rules of the world come with its clock: whether players can hurt each other.
        if (typeof a?.pvp === 'boolean' && a.pvp !== _pvp) { _pvp = a.pvp; window.dispatchEvent(new CustomEvent('ww_rules', { detail: { pvp: _pvp } })); }
    };
    mp.onMsg = (from, d) => {
        // Said to one player, on a line everyone hears (OnlineSession: a guest to another guest).
        if (d?.to !== undefined && d.to !== mp.id) return;
        switch (d?.t) {
            case 'mobs':                                   // the mobs another game runs
                _entities?.applySnapshot(from, d);
                break;
            case 'mobgive':                                // a mob that is nearer this player now: this game's to run
                _entities?.adopt(d.m);
                break;
            case 'mobsleep':                               // a mob another game's player has left behind: the owner's game keeps it
                if (!_guest) _entities?.store(d.m);
                break;
            case 'hit': {                                  // another player's blow on a mob this game runs
                const o = _others?.map.get(from);
                if (o) _entities?.hitById(d.id, d.dmg, { id: from, x: o.x, y: o.y, z: o.z });
                break;
            }
            case 'attack':                                 // a mob's blow, to the player it fell on
                window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage: d.dmg } }));
                break;
            case 'drops':                                  // what a mob this player killed left behind
                if (d.pos && [d.pos.x, d.pos.y, d.pos.z].every(Number.isFinite)) {
                    for (const [itemId, n] of Array.isArray(d.items) ? d.items.slice(0, 16) : []) {
                        if (_itemReg?.hasItem(itemId) && n > 0 && n <= 64) _entities?.dropItem(d.pos, itemId, n | 0);
                    }
                }
                break;
            case 'chest': case 'chest?': case 'chestTake': case 'chestTaken':
                _chestMsg(mp, from, d);
                break;
            case 'chat': case 'cmd': case 'sys': case 'act': case 'ops':
                _chatMsg(mp, from, d);
                break;
            case 'bolt':                                   // the host's lightning: the same bolt, here
                if (from === mp.hostId) _atmos?.bolt(d.x, d.z, d.c, d.s);
                break;
            case 'pvp':                                    // another player's blow, on this one
                _struckBy(from, d);
                break;
            case 'wset':                                   // what the world did near a guest's player (the host's to do)
                _worldSetFrom(from, d);
                break;
            case 'boom':                                   // a bomb went off
                _boom(d.x + 0.5, d.y + 0.5, d.z + 0.5, d.r);
                break;
            case 'sleep':                                  // a player has gone to bed (the host counts them)
                if (mp.players.has(from)) _sleeper(from);
                break;
            case 'wake':                                   // … and has got up again
                if (!_guest) _sleepers.delete(from);
                break;
            case 'cut':                                    // everyone is in bed: the clock cuts forward (the host says so)
                if (from === mp.hostId && d.h > 0 && d.h <= 24 && Number.isFinite(d.at)) _cut(d.h, d.at);
                break;
            case 'died':                                   // somebody died; by whose hand, if by anyone's
                if (mp.players.has(from)) {
                    const by = d.by === mp.id ? _myLabel() : mp.players.has(d.by) ? _labelOf(d.by) : '';
                    _chatShow({ kind: 'sys', text: by ? `${_labelOf(from)} was slain by ${by}.` : `${_labelOf(from)} died.` });
                }
                break;
        }
    };
    mp.onClosed = (reason) => {
        if (_mp !== mp) return;
        if (mp.online && !_guest) {
            // The host's own online room has gone (the line was lost for good):
            // the world is here and plays on, back on the game's own server.
            goOffline().catch(() => { /* playing alone and unseen */ });
            window.dispatchEvent(new CustomEvent('ww_onlineEnded', { detail: { reason } }));
            return;
        }
        window.dispatchEvent(new CustomEvent('ww_sessionClosed', { detail: { reason } }));
    };

    const welcome = await mp.join({ worldId, clientId: _stateKey || 'owner', name: _playerName, skin: _skin, key: _playerKey });
    if (_mp !== mp) return null;                           // the world was left meanwhile
    _joinRefused = welcome ? '' : String(mp.refused ?? '');
    if (!welcome) { _mp = null; return null; }
    if (!_entities || !worldState) return welcome;

    // (onSet is called before the block is changed, so getBlock still says what it was.)
    worldState.onSet = (x, y, z, id) => { if (!_mpApplying) mp.block(x, y, z, id, worldState.getBlock(x, y, z)); };
    for (let i = 0, e = welcome.edits ?? []; i + 3 < e.length; i += 4) _applyRemoteBlock(e[i], e[i + 1], e[i + 2], e[i + 3], true);
    _others?.dispose();
    _others = new RemotePlayers(scene, _entities.models);
    _others.onStep = _otherStep;
    for (const p of welcome.players ?? []) _others.add(p);
    _playerCasters();
    // Each game runs the mobs nearest its own player and shows the rest
    // (EntityManager: *With other players*). What crosses goes to one player.
    _entities.owner = mp.id;
    _entities.onRemoteHit = (pid, id, dmg) => _sayTo(mp, pid, { t: 'hit', id, dmg });
    _entities.onRemoteAttack = (pid, dmg) => _sayTo(mp, pid, { t: 'attack', dmg });
    _entities.onRemoteDrops = (pid, pos, items) => _sayTo(mp, pid, { t: 'drops', pos, items });
    _entities.onGive = (pid, m) => _sayTo(mp, pid, { t: 'mobgive', m });
    _entities.onSleep = (m) => { if (mp.hostId && mp.hostId !== mp.id) _sayTo(mp, mp.hostId, { t: 'mobsleep', m }); };
    // The storm is the host's: its lightning is told to everyone, and a guest's game makes none.
    if (_atmos) {
        _atmos.guest = !mp.isHost;
        _atmos.onBolt = mp.isHost ? (x, z, cloud, seed) => { if (!mp.alone) mp.all({ t: 'bolt', x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, c: cloud ? 1 : 0, s: seed }); } : null;
    }
    if (mp.online && mp.isHost) _serveGuests(mp);
    return welcome;
}

/**
 * Say something to one player. The game's own server carries it between any
 * two (Multiplayer.to); an online room has a line from each guest to the host
 * and from the host to each guest, and none between two guests — that goes on
 * the line everyone hears, marked for whom (`to`), and the rest let it pass.
 */
function _sayTo(mp, pid, d) {
    if (!mp.online || mp.isHost) mp.to(pid, d);
    else if (pid === mp.hostId) mp.host(d);
    else mp.all({ ...d, to: pid });
}

/** Once a frame: show the others, and tell them what is new here. */
function _mpTick(dt) {
    const mp = _mp;
    if (!mp || mp.id === 0 || !_physics) return;
    if (_others) {
        _others.update(dt, _lightAt, _atmos?.state.lightDir ?? null, _gfx.shadows !== 'off');
        if (_entities) _entities.others = _others.positions(_otherPos);
    }
    if (mp.alone) return;
    _mpStateT -= dt;
    if (_mpStateT <= 0) {
        _mpStateT = 1 / STATE_HZ;
        mp.state(packState(me.position, yaw, pitch, Math.hypot(_physics.vel.x, _physics.vel.z), {
            onGround: _physics.onGround, inWater: _physics.inWater, dead: _isDead,
            hidden: _gameMode === 'SPECTATOR' || _spawnPending, swings: _swings, hurt: Math.min(1, _damageFade * 1.5),
            sneak: _physics.crouching, sit: _rest?.kind === 'sit', lie: _rest?.kind === 'lie', body: _rest?.bodyYaw ?? 0,
        }));
    }
    if (mp.alone || !_entities) return;
    // The mobs this game runs, to the games near enough to see them. What
    // each looks like goes with the first word of it, and with all of them
    // every so often: a player who has only just come near has not been told.
    _mpMobT -= dt;
    _mpLookT -= dt;
    if (_mpMobT <= 0 && _entities.hasWord) {
        _mpMobT = MOB_SEND;
        if (_mpLookT <= 0) { _mobFull = true; _mpLookT = MOB_LOOKS; }
        mp.all({ t: 'mobs', ..._entities.snapshot(_mobFull) });
        _mobFull = false;
    }
    if (!mp.isHost) return;
    // By the clock on the wall, not by the frames drawn: `dt` is at most a tenth of a second a frame, and a
    // host whose window is in the background draws a frame a second — its guests heard of its weather, and
    // of its tornado, once in twenty seconds.
    const wall = performance.now();
    _mpAtmosT -= Math.min(5, (wall - (_mpAtmosWall || wall)) / 1000);
    _mpAtmosWall = wall;
    if (_mpAtmosT <= 0 && _atmos?.active) {
        _mpAtmosT = ATMOS_SEND;
        mp.atmos({ ..._atmos.toJSON(), running: _atmos.day.running, tor: _atmos.tornadoState(), pvp: _pvp });
    }
}

// ── Who a player is, and what they are called ─────────────────────────────────
// A player has a name, which is theirs to choose and which another player may
// have too; and a **key** (`p.key`), which is who they are whatever they are
// called — made from the hidden code kept with the name on their own machine
// (main.js: playerKeyOf), and passed on by the session. Operator status goes by
// the key. Two players of one name are told apart by a number the session
// gives the later one (`p.dup`): "Alex" and "Alex #2", the number in grey.

/** A player as they are called in a line of text: "Alex", or "Alex #2". */
const _label = (p) => (p ? (p.dup ? `${p.name} #${p.dup}` : p.name || 'Player') : 'Player');
const _labelOf = (id) => _label(_mp?.players.get(id));
const _myLabel = () => _label({ name: _playerName || 'Player', dup: _mp?.dup | 0 });
let _joinRefused = '';           // why the session would not have this game, if it would not

/** Others in the world, or the world open for others to come into: one player's pause menu then stops nothing. */
let _lanOpen = false;
const _shared = () => _lanOpen || (!!_mp && _mp.id !== 0 && (!_mp.alone || !!_mp.online));
document.addEventListener('WorldJS_setShared', (e) => { _lanOpen = !!e.data?.lan; });

/** Where the next bolt of lightning should come down near: one of the players, turn and turn about (the host's game asks). */
function _strikeTarget() {
    if (!_otherPos.length || !_mp?.isHost) return null;
    const i = Math.floor(Math.random() * (_otherPos.length + 1));
    return i < _otherPos.length ? _otherPos[i] : null;
}

/** Whether players can hurt each other here: the owner's game says, and keeps it with the world. */
function _setPvp(on, keep = true) {
    _pvp = !!on;
    _mpAtmosT = 0;                                          // the others are told at once
    window.dispatchEvent(new CustomEvent('ww_rules', { detail: { pvp: _pvp } }));
    const worldId = chunkManager?.worldId;
    if (keep && worldId && !_guest) {
        fetch(`${SERVER_URL}/api/worlds/${worldId}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pvp: _pvp }) }).catch(() => {});
    }
}
document.addEventListener('WorldJS_setRules', (e) => { if (!_guest && typeof e.data?.pvp === 'boolean') _setPvp(e.data.pvp, false); });

/** The host sends a player away (the Players panel, /kick). Returns whether it could. */
function _kick(id) {
    if (!_sessionUp() || !_mp.isHost || !_mp.players.has(id) || typeof _mp.kick !== 'function') return false;
    _mp.kick(id);
    return true;
}

/** Who is here, for the pause menu: this player first. `op`: an operator (the world's owner always is). */
window.__wwPlayers = () => !_mp || _mp.id === 0 ? [] : [
    { id: _mp.id, name: _playerName || 'You', dup: _mp.dup | 0, you: true, host: _mp.isHost, op: _mp.isHost || _opKeys.has(_mp.key) },
    ...[..._mp.players.values()].map(p => ({ id: p.id, name: p.name, dup: p.dup | 0, you: false, host: p.id === _mp.hostId, op: p.id === _mp.hostId || _opKeys.has(p.key) })),
];

// ── Online ────────────────────────────────────────────────────────────────────
//
// A world can be opened to players over the internet (the Players panel). Then
// its session is a room on the online server (online/, Colyseus) instead of on
// the game's own: `_mp` is an OnlineSession (engine/net/), which world.js uses
// exactly as it does Multiplayer. Three things differ, and they are all here:
//
//   • Going online and coming back are a change of session in a world that is
//     already running (`goOnline` / `goOffline`): the host stays the host.
//   • A guest's machine cannot reach the host's, so the host's game answers
//     for its world (`_serveGuests`): which chunks it has data for, each of
//     them, and each guest's saved place — kept on this machine, with the
//     world, under a key the server gives.
//   • Blocks other players change in chunks this game never loads are kept
//     with the world (`_savePendingEdits`) until it does: a guest of an online
//     game cannot save a chunk here itself, as a guest on the network does.

/** Answer the room for this world: the host's game, for its guests. */
function _serveGuests(session) {
    const worldId = chunkManager?.worldId;
    const stateUrl = (key) => `${SERVER_URL}/api/worlds/${worldId}/player-state?player=online-${key}`;
    const KEY = /^[A-Za-z0-9_-]{8,40}$/;
    const reading = new Map();

    /** A saved chunk, read on a line of its own (worldClient's is the game's, one request a chunk). */
    function readSaved(cx, cz) {
        const key = `${cx},${cz}`;
        let job = reading.get(key);
        if (!job) {
            job = (async () => {
                if (!_reader) { _reader = new WorldClient(WS_URL); await _reader.connect(); }
                return _reader.loadChunk(worldId, cx, cz);
            })().catch(() => null).finally(() => reading.delete(key));
            reading.set(key, job);
        }
        return job;
    }

    session.serve.manifest = async () => {
        // Every chunk this game has anything for: saved, or changed and not saved yet. All others are as the seed makes them.
        const keys = new Set(worldState.pendingChanges.keys());
        for (const key of worldClient?._savedChunks ?? []) keys.add(key);
        if (!worldClient?.savedKeys) for (const key of worldState.chunks.keys()) keys.add(key);     // not sure what is saved: say all
        return { keys: [...keys].slice(0, 60000) };
    };

    session.serve.chunk = async ({ cx, cz }) => {
        if (!worldState || !Number.isInteger(cx) || !Number.isInteger(cz)) return { s: ChunkStatus.NONE };
        const key = `${cx},${cz}`;
        const live = worldState.chunks.get(key);
        if (live?.generated) return { s: ChunkStatus.DATA, d: await packChunk(live) };
        const pending = worldState.pendingChanges.get(key);
        const saved = worldClient?._savedChunks?.has(key) !== false ? await readSaved(cx, cz) : null;
        if (saved && pending?.size) {
            // Saved, and changed since by someone while it was not loaded here: both.
            const chunk = ChunkData.deserialize(cx, cz, saved);
            chunkManager?._applyPendingChanges(chunk, cx, cz);
            return { s: ChunkStatus.DATA, d: await packChunk(chunk) };
        }
        if (saved) return { s: ChunkStatus.DATA, d: await packChunk(saved) };
        if (pending?.size) return { s: ChunkStatus.EDITS, d: packEdits(pending) };
        return { s: ChunkStatus.NONE };
    };

    session.serve.pload = async ({ key }) => {
        if (!KEY.test(key ?? '')) return { state: null };
        const res = await fetch(stateUrl(key));
        return { state: res.ok ? await res.json() : null };
    };

    session.serve.psave = async ({ key, state }) => {
        if (!KEY.test(key ?? '') || !state || typeof state !== 'object') return {};
        await fetch(stateUrl(key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
        return {};
    };
}

/** The changes waiting for chunks that are not loaded here, to the server — when they have changed. */
function _savePendingEdits() {
    const worldId = chunkManager?.worldId;
    if (!worldId || !worldState) return;
    const body = {};
    let n = 0;
    for (const [key, changes] of worldState.pendingChanges) {
        if (changes.size === 0 || worldState.chunks.has(key)) continue;       // loaded: it is saved as a chunk
        body[key] = [...changes];
        n += changes.size;
    }
    const sig = `${Object.keys(body).length}:${n}`;
    if (sig === _pendingSig || (sig === '0:0' && _pendingSig === '')) return;
    _pendingSig = sig;
    const text = JSON.stringify(body);
    fetch(`${SERVER_URL}/api/worlds/${worldId}/pending-edits`, {
        method: 'PUT', keepalive: text.length < 60000, headers: { 'Content-Type': 'application/json' }, body: text,
    }).catch(() => { /* offline */ });
}

/** … and back, when the world is next loaded: they are put down as each chunk arrives. */
async function _loadPendingEdits(worldId) {
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/pending-edits`);
        if (!res.ok || !worldState) return;
        let chunks = 0, n = 0;
        for (const [key, list] of Object.entries(await res.json())) {
            if (!Array.isArray(list) || worldState.pendingChanges.has(key)) continue;
            worldState.pendingChanges.set(key, new Map(list));
            chunks++; n += list.length;
        }
        _pendingSig = chunks ? `${chunks}:${n}` : '';
    } catch { /* offline, or a world from before this */ }
}

/**
 * Open this world to players over the internet: the session moves from the
 * game's own server to a room on the online one, and this game hosts it.
 * Resolves with the room's code. Throws OnlineError (its `reason` is why).
 * @param {object} world  the world's world.json (main.js: activeWorld)
 * @param {{ visibility?: 'private'|'public' }} [o]  public: listed for anyone to join
 */
async function goOnline(world, { visibility = 'private' } = {}) {
    if (!worldState || !chunkManager?.worldId || _guest || !_entities) throw new Error('no world to open');
    if (_mp?.online) return _mp.code;
    const session = await online.host(world, { name: _playerName, skin: _skin, slot: 0, gamepack: _gamepack, key: _playerKey }, { visibility });
    if (!worldState) { online.release(); throw new Error('the world was left'); }
    // Whoever was in the game through this machine's own server (a split screen, the network) is told it is over there.
    const old = _mp;
    _mp = null;
    old?.close();
    await _joinSession(chunkManager.worldId, session);
    _mpStateT = _mpMobT = _mpAtmosT = 0;
    return session.code;
}

/** Close the room and go back to the game's own server. */
async function goOffline() {
    if (!_mp?.online) return;
    const worldId = chunkManager?.worldId;
    _mp = null;
    online.release();
    _others?.dispose();
    _others = null;
    _otherPos.length = 0;
    _playerCasters();
    if (worldId && worldState && !_remote) await _joinSession(worldId);
}

window.__wwWorld = {
    goOnline, goOffline,
    /** What the Players panel shows: whether this world is online, its code, and whose it is. */
    online: () => _mp?.online ? { code: _mp.code, host: _mp.isHost, down: _mp.down, players: _mp.players.size + 1, visibility: _mp.visibility } : null,
    /** The host: send a player away, and say so. */
    kick: (id) => {
        const who = _labelOf(id);
        if (_kick(id)) _announce(`${_myLabel()} removed ${who} from the game.`);
    },
    /** Whether players can hurt each other here. */
    pvp: () => _pvp,
    lock: (locked) => _mp?.online && _mp.lock(locked),
};

// ── Chat and commands ─────────────────────────────────────────────────────────
//
// A line a player types (src/chat.js: T, or / to begin a command) is said to
// everyone in the world and shown as "(Name) text". A line beginning with "/"
// is a command (engine/Commands.js), and commands are run in one game, the
// world's owner's: here if this is it, and otherwise the line goes there as it
// was typed. That game checks who sent it — most commands need operator status,
// which the owner has and gives by name (/op), kept with the world — and does
// it. What a command does to the world the others see as they see anything the
// owner's game does; what it does to a player ('act': their mode, their place,
// what they are handed) that player's own game does, on the owner's word alone.
// What came of it is said to everyone ('sys').

let _ops = new Map();           // who has operator status besides the owner: key → the name they had (the owner's game keeps them)
let _opKeys = new Set();        // … the same, as every game knows it (the owner's game says: 'ops'), for showing who is one
let _commands = null;

/** Say something to everyone, this game included, as the game itself (the owner's game's word). */
function _announce(text) {
    _chatShow({ kind: 'sys', text });
    if (_sessionUp() && !_mp.alone) _mp.all({ t: 'sys', text });
}

/** The operators have changed: kept with the world, and the other games told who they are. */
function _opsChanged() {
    _opKeys = new Set(_ops.keys());
    _saveOps();
    if (_sessionUp() && !_mp.alone) _mp.all({ t: 'ops', keys: [..._opKeys] });
}

/** A line for the chat on this screen. `kind`: 'say' (a player: `name`), or 'sys' (the game). */
function _chatShow(line) {
    window.dispatchEvent(new CustomEvent('ww_chat', { detail: line }));
}

const _sessionUp = () => !!_mp && _mp.id !== 0;
const _myId = () => (_sessionUp() ? _mp.id : 0);

/** Everyone in the world, this player first, as a command sees them. */
function _chatPlayers() {
    // (A name with a number after it is written without the space, so that it can be typed: Alex#2.)
    const called = (name, dup) => (dup ? `${name || 'Player'}#${dup}` : name || 'Player');
    const out = [{ id: _myId(), name: called(_playerName, _mp?.dup | 0), key: _playerKey || 'me', x: me.position.x, y: me.position.y, z: me.position.z, owner: !_guest }];
    if (_sessionUp()) for (const p of _mp.players.values()) {
        const o = _others?.map.get(p.id);
        out.push({ id: p.id, name: called(p.name, p.dup | 0), key: p.key || '', x: o?.x ?? 0, y: o?.y ?? 0, z: o?.z ?? 0, owner: p.id === _mp.hostId });
    }
    return out;
}

/** What the commands can do to this world (see engine/Commands.js). Only the owner's game makes one. */
function _commandRunner() {
    return _commands ??= new CommandRunner({
        players: _chatPlayers,
        isOp: (p) => !!p?.key && _ops.has(p.key),
        setOp: (p, on) => {
            if (on) { if (p.key) _ops.set(p.key, String(p.name).replace(/#\d+$/, '')); }
            else if (p.key) _ops.delete(p.key);
            // Somebody who is not here: by the name they had when it was given.
            else for (const [key, name] of [..._ops]) if (name.toLowerCase() === String(p.name).toLowerCase()) _ops.delete(key);
            _opsChanged();
        },
        ops: () => [..._ops.values()],
        kick: _kick,
        pvp: () => _pvp,
        setPvp: (on) => _setPvp(on),
        act: (pid, a) => { if (pid === _myId()) _chatAct(a); else if (_sessionUp()) _sayTo(_mp, pid, { t: 'act', a }); },
        hours: () => _atmos?.day.hours ?? 12,
        setHours: (h) => { _atmos?.setHours(h); _mpAtmosT = 0; },
        weathers: () => ['dynamic', ...WEATHER_IDS],
        setWeather: (id) => { _atmos?.setWeatherMode(id); _mpAtmosT = 0; },
        mobs: () => [...(_entities?._types.keys() ?? [])],
        summon: (type, x, y, z) => _entities?._spawnMob(type, { x, y, z }) != null,
        hasItem: (id) => !!_itemReg?.hasItem(id) || (/^[a-z0-9_]+$/.test(id) && !!_blockReg?.getByName(id.toUpperCase())),
        setBlock: (x, y, z, name) => worldState?.chunks.has(`${x >> 4},${z >> 4}`) ? window.__wwSetBlock(x, y, z, name) : false,
        seed: () => worldState?.seed ?? 0,
        reply: (actor, text) => { if (actor.id === _myId()) _chatShow({ kind: 'sys', text }); else if (_sessionUp()) _sayTo(_mp, actor.id, { t: 'sys', text }); },
        announce: _announce,
    });
}

/** This player typed a line. */
function _chatSend(text) {
    text = cleanChat(text);
    if (!text || !worldState) return;
    if (text[0] !== '/') {
        _chatShow({ kind: 'say', name: _playerName || 'Player', dup: _mp?.dup | 0, text, you: true });
        if (_sessionUp() && !_mp.alone) _mp.all({ t: 'chat', text });
        return;
    }
    if (!_guest) _commandRunner().run(_chatPlayers()[0], text);
    else if (_sessionUp()) _sayTo(_mp, _mp.hostId, { t: 'cmd', text });
    else _chatShow({ kind: 'sys', text: 'Commands are run by the game of the world\'s owner, which is not there.' });
}

/** Something about the chat from another game. */
function _chatMsg(mp, from, d) {
    const text = cleanChat(d.text);
    switch (d.t) {
        case 'chat':                  // a player said something
            if (text && text[0] !== '/') _chatShow({ kind: 'say', name: mp.players.get(from)?.name || 'Player', dup: mp.players.get(from)?.dup | 0, text });
            break;
        case 'cmd': {                 // a guest's command: this game, the owner's, runs it — as them
            if (_guest || !text) break;
            const actor = _chatPlayers().find(p => p.id === from);
            if (actor) _commandRunner().run(actor, text);
            break;
        }
        case 'sys':                   // what came of a command: the owner's game's word
            if (from === mp.hostId && text) _chatShow({ kind: 'sys', text });
            break;
        case 'act':                   // … and this player's part in it
            if (from === mp.hostId) _chatAct(d.a);
            break;
        case 'ops':                   // who the operators are (the owner's game says), for showing it
            if (from === mp.hostId && Array.isArray(d.keys)) _opKeys = new Set(d.keys.filter(k => typeof k === 'string').slice(0, 64));
            break;
    }
}

/** Do to this player what a command asked (the owner's game checked who asked). */
function _chatAct(a) {
    if (!a || !me?.position || !_physics) return;
    switch (a.k) {
        case 'mode':
            _setGameMode(a.mode);
            break;
        case 'tp':
            if (![a.x, a.y, a.z].every(Number.isFinite)) break;
            if (_rest) _getUp();
            me.position = { x: a.x, y: a.y, z: a.z };
            _physics.vel = { x: 0, y: 0, z: 0 };
            _eyeEase = 0;
            break;
        case 'give': {
            const n = Math.min(640, Math.max(0, a.n | 0));
            if (!n || typeof a.item !== 'string' || !_inventory) break;
            if (!_itemReg?.hasItem(a.item) && !_blockReg?.getByName(a.item.toUpperCase())) break;
            const left = _inventory.addItem(a.item, n);
            // What there is no room for lies at their feet.
            if (left > 0 && _itemReg?.hasItem(a.item)) _entities?.dropItem({ ...me.position }, a.item, left);
            window.dispatchEvent(new CustomEvent('ww_itemPickup', { detail: { itemId: a.item, count: n - left } }));
            break;
        }
        case 'heal':
            if (_isDead) break;
            me.health = 100; me.hunger = 100; me.energy = 100;
            break;
        case 'kill':
            if (_isDead) break;
            me.health = 0;
            _handleDeath();
            break;
    }
}

function _saveOps() {
    const worldId = chunkManager?.worldId;
    if (!worldId || _guest) return;
    fetch(`${SERVER_URL}/api/worlds/${worldId}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [..._ops].map(([key, name]) => ({ key, name })) }),
    }).catch(() => { /* kept for this session at least */ });
}

async function _loadOps(worldId) {
    _ops = new Map();
    _commands = null;
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}`);
        const ops = res.ok ? (await res.json())?.ops : null;
        if (Array.isArray(ops)) for (const o of ops) if (o && typeof o.key === 'string' && o.key) _ops.set(o.key, String(o.name ?? ''));
    } catch { /* none kept */ }
    _opKeys = new Set(_ops.keys());
}

/** The chat, for the page (src/chat.js) and for tests. */
window.__wwChat = {
    send: _chatSend,
    /** Names a line could be completing: the commands' and the players'. */
    players: () => (worldState ? _chatPlayers().map(p => p.name) : []),
    ops: () => [..._ops.values()],
    /** The world's owner, from the Players panel: make a player an operator, or no longer one. */
    setOp(id, on) {
        const p = _guest ? null : _chatPlayers().find(q => q.id === id && !q.owner);
        if (!p || !p.key) return false;
        _commandRunner().api.setOp(p, !!on);
        _announce(on ? `${_myLabel()} made ${p.name} an operator.` : `${_myLabel()} took operator status from ${p.name}.`);
        return true;
    },
};

// ── Chests ────────────────────────────────────────────────────────────────────
//
// What is in each chest: twenty-seven slots, by where the chest stands. The
// world's owner keeps them, with the world (containers.json on the server);
// anyone else in the world asks the owner's game, and holds only the chests
// they have opened, as last heard of. A chest that is changed is said whole to
// everyone — it is small — so whoever has it open sees it change. (Two players
// moving things in one chest in the same instant can still cross: the later
// word stands.) main.js shows a chest and changes its slots in place
// (`window.__wwChests`); broken, a chest spills what was in it.

const CHEST_SLOTS = 27;
let _chests = new Map();              // "x,y,z" → [{ itemId, count } | null × 27]
let _chestsDirty = false, _chestSaveTimer = null;
const _chestWaits = new Map();        // "x,y,z" → what a guest's open() is waiting on (the owner's answer)
const CHEST_KEY = /^-?\d{1,8},-?\d{1,4},-?\d{1,8}$/;
const chestKey = (x, y, z) => `${x},${y},${z}`;

/** Slots as they may be kept: the right number of them, plain item names, sane counts. */
function _cleanSlots(s) {
    if (!Array.isArray(s)) return null;
    const out = new Array(CHEST_SLOTS).fill(null);
    for (let i = 0; i < CHEST_SLOTS; i++) {
        const e = s[i];
        if (!e || typeof e.itemId !== 'string' || !/^[A-Za-z0-9_]{1,48}$/.test(e.itemId)) continue;
        const n = e.count | 0, max = _itemReg?.getItem(e.itemId)?.maxStack ?? 64;
        if (n > 0) out[i] = { itemId: e.itemId, count: Math.min(n, max) };
    }
    return out;
}

/** A chest is now this (null: there is none any more). Whoever has it open is shown; the owner's game keeps it. */
function _setChest(key, slots) {
    if (slots) _chests.set(key, slots); else _chests.delete(key);
    if (!_guest) _chestsChanged();
    window.dispatchEvent(new CustomEvent('ww_chestChanged', { detail: { key, slots } }));
}

function _chestsChanged() {
    _chestsDirty = true;
    clearTimeout(_chestSaveTimer);
    _chestSaveTimer = setTimeout(_saveChests, 1500);
}

/** The owner's game: every chest with something in it, to the server — when any has changed. */
function _saveChests() {
    clearTimeout(_chestSaveTimer);
    _chestSaveTimer = null;
    const worldId = chunkManager?.worldId;
    if (!_chestsDirty || !worldId || _guest) return;
    _chestsDirty = false;
    const body = {};
    for (const [key, s] of _chests) if (s.some(Boolean)) body[key] = s;
    const text = JSON.stringify(body);
    fetch(`${SERVER_URL}/api/worlds/${worldId}/containers`, {
        method: 'PUT', keepalive: text.length < 60000, headers: { 'Content-Type': 'application/json' }, body: text,
    }).catch(() => { _chestsDirty = true; });
}

async function _loadChests(worldId) {
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/containers`);
        if (!res.ok) return;
        for (const [key, s] of Object.entries(await res.json())) {
            const slots = CHEST_KEY.test(key) ? _cleanSlots(s) : null;
            if (slots) _chests.set(key, slots);
        }
    } catch { /* offline, or a world from before chests held anything */ }
}

// ── The world's mobs ──────────────────────────────────────────────────────────
// Kept with the world by its owner's game (mobs.json on the server): the ones
// asleep where the players left them and the ones about when it was saved
// (EntityManager: *Mobs that are left behind*). All of them come back asleep,
// and wake as a player comes near.

let _mobsSaved = null;      // what the server was last sent

function _saveMobs() {
    const worldId = chunkManager?.worldId;
    if (!worldId || _guest || !_entities) return;
    const text = JSON.stringify(_entities.serialize());
    if (text === _mobsSaved) return;
    _mobsSaved = text;
    fetch(`${SERVER_URL}/api/worlds/${worldId}/mobs`, {
        method: 'PUT', keepalive: text.length < 60000, headers: { 'Content-Type': 'application/json' }, body: text,
    }).catch(() => { _mobsSaved = null; });
}

async function _loadMobs(worldId) {
    _mobsSaved = null;
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/mobs`);
        if (res.ok) _entities?.loadAsleep(await res.json());
    } catch { /* offline, or a world from before its mobs were kept */ }
}

/** In someone else's world, with its owner's game to ask. */
const _chestsElsewhere = () => _guest && !!_mp && _mp.id !== 0;

window.__wwChests = {
    /** The slots of the chest at (x, y, z) — an array to show and to change in place — or null if they cannot be had. */
    open(x, y, z) {
        const key = chestKey(x, y, z);
        if (!_chestsElsewhere()) {
            let s = _chests.get(key);
            if (!s) _chests.set(key, s = new Array(CHEST_SLOTS).fill(null));
            return Promise.resolve(s);
        }
        // As the owner's game has it now: nothing is shown until it has answered,
        // or a thing put into a chest not yet heard of would be put into an empty one.
        _chestWaits.get(key)?.(null);
        return new Promise((resolve) => {
            const done = (s) => { clearTimeout(timer); if (_chestWaits.get(key) === done) _chestWaits.delete(key); resolve(s); };
            const timer = setTimeout(() => done(null), 4000);
            _chestWaits.set(key, done);
            _mp.host({ t: 'chest?', k: key });
        });
    },
    /** main.js has changed what is in it. */
    changed(x, y, z) {
        const key = chestKey(x, y, z), s = _chests.get(key);
        if (!s) return;
        if (!_guest) _chestsChanged();
        if (_mp && _mp.id !== 0 && !_mp.alone) _mp.all({ t: 'chest', k: key, s });
    },
};

/** What other games say about chests. */
function _chestMsg(mp, from, d) {
    const key = typeof d.k === 'string' && CHEST_KEY.test(d.k) ? d.k : null;
    if (!key) return;
    switch (d.t) {
        case 'chest?':                // someone wants to open one: the owner's game says what is in it
            if (!_guest) _sayTo(mp, from, { t: 'chest', k: key, s: _chests.get(key) ?? [] });
            break;
        case 'chest': {               // a chest as it is now (null: gone)
            const slots = d.s === null ? null : _cleanSlots(d.s);
            if (d.s !== null && !slots) break;
            _setChest(key, slots);
            _chestWaits.get(key)?.(slots);
            break;
        }
        case 'chestTake':             // a guest broke one: the owner's game hands over what was in it, and forgets it
            if (_guest) break;
            _sayTo(mp, from, { t: 'chestTaken', k: key, s: _chests.get(key) ?? [] });
            _setChest(key, null);
            mp.all({ t: 'chest', k: key, s: null });
            break;
        case 'chestTaken':            // … which spills out here, where the chest stood
            _spillChest(key, _cleanSlots(d.s));
            break;
    }
}

function _spillChest(key, slots) {
    if (!slots || !_entities) return;
    const [x, y, z] = key.split(',').map(Number);
    for (const s of slots) if (s) _entities.dropItem({ x: x + 0.5, y: y + 0.2, z: z + 0.5 }, s.itemId, s.count);
}

/** The chest at (x, y, z) was broken by this player. */
function _chestBroken(x, y, z) {
    const key = chestKey(x, y, z);
    if (_chestsElsewhere()) {
        // Its owner's game knows what was in it: that is asked for, and spills here when it comes.
        _chests.delete(key);
        _mp.host({ t: 'chestTake', k: key });
        return;
    }
    _spillChest(key, _chests.get(key) ?? null);
    _setChest(key, null);
    if (_mp && _mp.id !== 0 && !_mp.alone) _mp.all({ t: 'chest', k: key, s: null });
}

/** A chest was put down at (x, y, z) by this player: an empty one, whatever was kept for that place. */
function _chestPlaced(x, y, z) {
    const key = chestKey(x, y, z);
    if (!_guest && _chests.has(key)) _setChest(key, null);
}

// Something the player could not keep — no room for what was made, or for what
// was in hand when a menu closed — falls at their feet. (main.js has always
// asked for this; nothing was listening, and the things were simply gone.)
document.addEventListener('WorldJS_dropItem', (e) => {
    const { itemId, count } = e.data ?? {};
    if (!_entities || !me?.position || typeof itemId !== 'string' || !(count > 0)) return;
    _entities.dropItem({ x: me.position.x, y: me.position.y + 0.6, z: me.position.z }, itemId, count);
});

// ── Sounds ────────────────────────────────────────────────────────────────────

/** A blow of the player lands on the mob nearest `at` that they can see. Returns the damage done. */
function _hitMob(at, damage, radius) {
    return _entities?.hitNearest(at, damage, radius, _seesMob) ?? 0;
}

let _nearWater = 0, _nearWaterT = 0;

// Waves are heard from a long way off, and only from a large body of water.
// Rings of sixteen places round the player are looked at, out to WAVE_REACH.
const WAVE_RINGS = [8, 16, 26, 38, 52, 68];
const WAVE_REACH = WAVE_RINGS[WAVE_RINGS.length - 1];
const WAVE_DIRS = 16;
const WAVE_AREA = [1400, 3400];     // open water in sight, blocks²: none of the sound below, all of it above

/** Is the first thing under the open air at (x, z), looking down from y, water? */
function _openWaterAt(x, y, z) {
    for (let dy = 0; dy < 64; dy++) {
        const id = worldState.getBlock(x, y - dy, z);
        if (id === 0) continue;
        if (_blockReg.isLiquid(id)) return true;
        if (!_blockReg.isTransparent(id)) return false;      // ground; leaves and glass are looked through
    }
    return false;
}

/**
 * How much of the sound of waves there should be, 0 … 1. It is there when a
 * lot of open water lies within WAVE_REACH blocks — the sea, a lake; a pond or
 * a stream across the path does not add up to enough (WAVE_AREA: each place
 * looked at stands for the piece of ground round it) — and it is only a little
 * quieter for being far: at the very edge of that reach, still more than half.
 * (It used to be heard within six blocks of any water at all, a puddle included.)
 */
function _waterNearby(p) {
    const y = Math.floor(p.y) + 6;
    let area = 0, nearest = Infinity;
    for (let k = 0; k < WAVE_RINGS.length; k++) {
        const r = WAVE_RINGS[k];
        const inner = k ? (WAVE_RINGS[k - 1] + r) / 2 : 0, outer = k + 1 < WAVE_RINGS.length ? (r + WAVE_RINGS[k + 1]) / 2 : r + 8;
        const piece = Math.PI * (outer * outer - inner * inner) / WAVE_DIRS;
        for (let i = 0; i < WAVE_DIRS; i++) {
            const a = (i + (k & 1) * 0.5) * 2 * Math.PI / WAVE_DIRS;
            if (!_openWaterAt(Math.floor(p.x + Math.cos(a) * r), y, Math.floor(p.z + Math.sin(a) * r))) continue;
            area += piece;
            if (r < nearest) nearest = r;
        }
    }
    if (area <= WAVE_AREA[0]) return 0;
    const big = Math.min(1, (area - WAVE_AREA[0]) / (WAVE_AREA[1] - WAVE_AREA[0]));
    return big * (1 - 0.4 * Math.max(0, nearest - WAVE_RINGS[0]) / (WAVE_REACH - WAVE_RINGS[0]));
}

/**
 * A mob's foot comes down. An animal with feet of its own kind (`footstep`
 * in its JSON) makes their sound — a hoof, a trotter, a hen's claws — with a
 * little of the ground under it; anything else, a Quiddle in boots, sounds of
 * the ground alone, as the player does.
 */
function _mobStep(at, o) {
    const family = blockSoundFamily(o.ground > 0 ? _blockReg.get(o.ground) : null);
    const own = o.footstep ? `${o.footstep}_step` : null;
    if (own && sound.has(own)) {
        sound.play(own, { at, volume: o.volume, reach: o.reach, vary: 0.1 });
        sound.play(`${family}_step`, { at, volume: o.volume * 0.35, reach: o.reach });
    } else sound.play(`${family}_step`, { at, volume: o.volume, reach: o.reach });
}

/**
 * Another player's foot comes down (Players.js). Not for players on this
 * same screen: their own pane plays their footsteps, through the same speakers.
 * Crouching, they creep: a fraction as loud, and not heard beyond a few blocks.
 */
const SNEAK_STEP = 0.22, SNEAK_REACH = 6;
function _otherStep(e, run, landing) {
    if ((window.__wwSplitN ?? 1) > 1 || !worldState) return;
    const x = Math.floor(e.x), z = Math.floor(e.z);
    const ground = worldState.getBlock(x, Math.floor(e.y - 0.2), z) || worldState.getBlock(x, Math.floor(e.y - 1.2), z);
    const family = blockSoundFamily(ground > 0 ? _blockReg.get(ground) : null);
    const quiet = e.sneak && !landing;
    sound.play(`${family}_step`, { at: { x: e.x, y: e.y, z: e.z }, volume: ((landing ? 0.6 : 0.42) + 0.22 * run) * (quiet ? SNEAK_STEP : 1), reach: quiet ? SNEAK_REACH : 24 });
}

/** What the player is doing, for GameSounds: footsteps, splashes and the ambience. */
function _tickSounds(dt, result, sneaking) {
    if (!_sounds || !worldState) return;
    const p = me.position, eye = p.y + CAMERA_HEIGHT;
    const fx = Math.floor(p.x), fz = Math.floor(p.z);
    _nearWaterT -= dt;
    if (_nearWaterT <= 0) { _nearWaterT = 0.75; _nearWater = _waterNearby(p); }
    let ground = 0;
    if (result.onGround) {
        ground = worldState.getBlock(fx, Math.floor(p.y - 0.2), fz) || worldState.getBlock(fx, Math.floor(p.y - 1.2), fz);
    }
    _sounds.tick(dt, {
        x: p.x, y: p.y, z: p.z, eyeY: CAMERA_HEIGHT, yaw,
        speed: Math.hypot(_physics.vel.x, _physics.vel.z), vy: _physics.vel.y,
        onGround: result.onGround, inWater: result.inWater,
        headInWater: _blockReg.isLiquid(worldState.getBlock(fx, Math.floor(eye), fz)),
        silent: _gameMode === 'SPECTATOR' || _physics.flying, sneaking,
        ground: ground > 0 ? _blockReg.get(ground) : null,
        skyLight: _skyBrightnessAt(p.x, eye, p.z), sun: _atmos?.state.sunHeight ?? 1,
        rain: _atmos?.rainHere ?? 0, nearWater: _nearWater, paused: _paused,
    });
}

// ── Direction helpers ─────────────────────────────────────────────────────────

function _horizontalForward() {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
