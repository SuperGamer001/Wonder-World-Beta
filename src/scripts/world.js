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
import { sound }                             from './Sound.js';
import { GameSounds }                        from './GameSounds.js';
import { PlayerModel, DEFAULT_SKIN }         from './PlayerModel.js';
import { Multiplayer }                       from './engine/Multiplayer.js';
import { RemotePlayers, packState }          from './Players.js';

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
let _skin        = { ...DEFAULT_SKIN };   // the look the player chose (the Character screen)
let _playerName  = '';                    // … and their name, for other players to see
let _mp          = null;   // Multiplayer — this world's session (a session of one, alone)
let _others      = null;   // RemotePlayers — the other players, as drawn here
let _loadToken   = 0;      // which load of a world is the one wanted (startWorldLoad)
let _guest       = false;  // this world is someone else's: our own state file, and no say over the world
let _stateKey    = '';     // … and which file that is (the server's ?player=)
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

let selectionMaterial   = null;
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
    fragColor = displayOut(vec4(grade(c), 1.0));
}
`;

// Water and ice, blended over the scene at 0.72 of their texture's opacity.
const CHUNK_TRANSP_FRAG = CHUNK_COMMON + `
void main() {
    vec3 n = surfaceNormal();
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(vUV, floor(vLayer + 0.5)));
        if (t.a < 0.05) discard;
        fragColor = displayOut(vec4(grade(t.rgb * lighting(n)), t.a * 0.72));
    } else {
        fragColor = displayOut(vec4(grade(vColor * lighting(n)), 0.72));
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
    selectionMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });

    // Selection outline (block highlight box, hidden until targeting a block)
    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    _selMesh = new THREE.LineSegments(boxEdges, selectionMaterial);
    _selMesh.visible = false;
    scene.add(_selMesh);
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
        gamepackData = {}, worldId = null, worldSeed = null,
        playerPos = null, gameMode = 'SURVIVAL', terrainStyle = 'blocky',
        daylightCycle = true, weather = 'dynamic', worldGen = 1, flat = null,
        guest = false, stateKey = '', workers = 0,
    } = e.data ?? {};
    // A load takes a few seconds and waits on the network, the workers and the
    // textures; the world can be left, and another begun, while it does. Each
    // wait is followed by a look at whether this load is still the one wanted.
    const token = ++_loadToken, stale = () => token !== _loadToken;
    _guest = !!guest;
    _stateKey = _guest ? String(stateKey || 'guest') : '';

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
    _crafting = new CraftingSystem();
    _crafting.loadRecipes(gamepackData.recipes ?? []);

    _entities = new EntityManager(worldState, _blockReg, _itemReg, scene);
    // Mobs are lit by the sky light where they stand and by the time of day.
    _entities.lightAt = _lightAt;
    _entities.seen = _mobSeen;      // and only posed where they, or their shadows, can be seen
    _entities.onSound = (name, at, o) => sound.play(name, { at, ...o });
    _sounds = new GameSounds();
    _particles = new Particles(scene, (x, y, z) => {
        const id = worldState?.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) ?? 0;
        if (id === 0 || _blockReg.isNoCollision(id)) return false;
        return _smooth?.isMesh(id) ? _smooth.pointInMesh(x, y, z) : true;
    });
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
        if (stale()) return;

        // Load saved player state if available
        try {
            const res = await fetch(_stateUrl(worldId));
            if (res.ok) {
                const state = await res.json();
                if (state) _applyPlayerState(state);
                if (!_guest) _savedAtmos = state?.atmosphere ?? null;
            }
        } catch { /* server offline */ }
    }

    if (stale() || !_physics) return; // guard if quitWorld raced

    // Whoever else is playing this world (a second pane of a split screen, a
    // guest from the network): join them — or be the first, whom they join.
    // Before any chunk is asked for: what the others have built is put down
    // as each chunk arrives, and has to be known by then.
    let hostAt = null;
    if (worldId) {
        const welcome = await _joinSession(worldId);
        if (stale() || !_physics) return;
        if (welcome && !_mp.isHost) {
            if (welcome.atmos) _savedAtmos = welcome.atmos;
            const s = welcome.players?.find(p => p.id === welcome.hostId)?.state;
            if (Array.isArray(s)) hostAt = { x: s[0], y: s[1], z: s[2] };
        }
        if (!welcome && _guest) {
            // A guest has no game without the host's.
            window.dispatchEvent(new CustomEvent('ww_sessionClosed', { detail: { reason: 'unreachable' } }));
            return;
        }
    }

    // Low-detail land beyond the chunks (Graphics → Far Terrain).
    _far = new FarTerrain(scene, workerPool, _makeFarMaterial);
    _far.setDistance(_farExtra);
    _applyViewDistance();
    _farEditsOut = new Map();
    if (worldId) _loadFarEdits(worldId);

    // Time of day and weather: carried on from the save, with the world's
    // Daylight Cycle and Weather settings from its world.json.
    _atmos.startWorld({
        seed: worldState.seed, biomes: gamepackData.biomes ?? [], world: worldState,
        saved: _savedAtmos, daylightCycle, weather, worldGen: _worldGen, flat,
    });

    // _disposeAll() removes the selection mesh from the scene; re-add it here.
    if (_selMesh && !scene.children.includes(_selMesh)) scene.add(_selMesh);
    _warmShaders();
    _post?.resetAdaptation();

    // Someone new to a game under way starts beside whoever is hosting it.
    const spawnPos = hostAt ?? playerPos ?? { x: 0, y: 80, z: 0 };
    _worldSpawn   = null;
    _spawnPending = false;
    _loadGateDone = false;   // re-gate the loading screen for this world
    if (me.position && me.position.fromSave) {
        // Returning player — keep their saved position.
        me.position = { x: me.position.x, y: me.position.y, z: me.position.z };
    } else {
        // Fresh spawn — drop onto the ground once terrain loads. The current
        // generator has real oceans, so start from the nearest good land
        // rather than wherever (0, 0) happens to be (the ground search after
        // loading only looks a couple of dozen blocks around).
        let { x, z } = spawnPos;
        if (_worldGen >= 2 && !hostAt) {
            ({ x, z } = new Geography(worldState.seed, new BiomeSet(gamepackData.biomes ?? []), normaliseFlat(flat))
                .findSpawn(Math.floor(x), Math.floor(z)));
        }
        _beginGroundSpawn(x, z);
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
}

// ── Quit event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_quitWorld', () => {
    _loadToken++;                 // a load still under way stops at its next step
    clearInterval(_autoSaveTimer);
    _autoSaveTimer = null;

    const client = worldClient;   // capture before nulling so we can flush + close it
    _saveAll();                   // queues the final chunk save onto the socket
    _savePlayerState();
    // Release mob geometries, sprite materials and item textures before the
    // scene is torn down; these are GPU-side and are not reclaimed by GC alone.
    _mp?.close();
    _mp = null;
    _others?.dispose();
    _others = null;
    _playerModel?.dispose();
    _playerModel = null;
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
    // With others in the world one player's pause menu does not stop its clock.
    _paused = !!e.data?.paused && (!_mp || _mp.alone);

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) { _saveAll(); _savePlayerState(); }
    _wasLocked = isLocked;

    if (_isDead) { _updatePlayerModel(dt); _mpTick(dt); _render(); return; }

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
        sneak:    controlsActive && (!!KEYS['ControlLeft'] || !!KEYS['KeyQ'] || (padPlay && pad.sneak)),
        sprint:   controlsActive && (!!KEYS['ShiftLeft'] || (padPlay && pad.sprint)),
        moveF:    padPlay ? pad.moveF : 0,
        moveR:    padPlay ? pad.moveR : 0,
        fwd,
        rightDir,
    };

    _applyWeatherToPlayer();
    const result = _physics.update(me.position, input, dt, _gameMode, {
        hunger: me.hunger, energy: me.energy,
    });

    if (result.fallDamage > 0) _applyDamage(result.fallDamage);
    if (result.fellIntoVoid)   _applyDamage(20);
    _tickSounds(dt, result, input.sneak);

    if (_gameMode === 'SURVIVAL') _survivalTick(dt);

    _checkSuffocation(dt);
    _water.tick(dt, (cx, cz) => chunkManager?.markDirty(cx, cz));
    _particles?.update(dt);
    // Mobs are shaded by the same sun or moon as the terrain.
    if (_atmos) _entities.lightDir = _atmos.state.lightDir;
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
    if (_rightJust && isBowSelected) { _bowDrawing = true; _bowCharge = 0; _rightJust = false; _sounds?.bowDraw(); }
    if (_bowDrawing) _handleBowDraw(dt);
    _bowZoom = _bowDrawing;

    // Block breaking only when no mob is targeted. If the head is buried inside a
    // mineable block, dig that block out first (lets you escape being stuck).
    const headHit = _mineableHeadBlock();
    _handleBreaking(dt, mobHit ? null : (headHit ?? hit));
    _handlePlacement(hit);
    _handleEating(dt);
    _handleAttackCharge(dt, mobHit, mobHit ? null : hit);

    // Where the player is looking at, for the third-person camera to aim at too.
    const aim = mobHit ? mobHit.t : hit ? Math.hypot(hit.x + 0.5 - origin.x, hit.y + 0.5 - origin.y, hit.z + 0.5 - origin.z) : AIM_FAR;
    _aimDist += (aim - _aimDist) * (1 - Math.exp(-dt * 10));
    _updatePlayerModel(dt);
    _mpTick(dt);

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
        _mp?.profile(_playerName, _skin);
    }
    if (typeof s.playerName === 'string' && s.playerName !== _playerName) { _playerName = s.playerName; _mp?.profile(_playerName, _skin); }
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
        _sounds?.miningStopped();
        if (MOUSE.left && _camMode !== 0) _swingArm();     // a swing at the air
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
    _sounds?.mining(dt, block, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
    _swingArm();

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
    // Debris takes the light of the air it flies into, so it is dark in a cave.
    const dl = _lightAt(hit.x + 0.5 + (hit.face?.x ?? 0), hit.y + 0.5 + (hit.face?.y ?? 1), hit.z + 0.5 + (hit.face?.z ?? 0));
    const rgb = block.topColor ?? block.color ?? [0.5, 0.5, 0.5];
    _particles?.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, [rgb[0] * dl, rgb[1] * dl, rgb[2] * dl]);
    _sounds?.blockBroken(block, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });
    worldState.setBlock(hit.x, hit.y, hit.z, 0);
    chunkManager.markEdited(hit.x, hit.z);
    _breakUnsupported(hit.x, hit.y, hit.z);

    // Creative players don't collect broken blocks.
    if (_gameMode === 'CREATIVE') return;

    // Blocks with requiresTool drop nothing if broken with the wrong tool
    if (block.requiresTool && !hasCorrectTool) return;

    _dropBlockItems(block, { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 });

    // Refresh the hotbar so collected blocks / updated stack counts show up.
    window.dispatchEvent(new CustomEvent('ww_itemPickup'));
}

/**
 * The block at (x, y, z) is gone: anything resting on it or hanging from it
 * (BlockRegistry `support` — torches, lanterns) comes down too, and drops.
 */
function _breakUnsupported(x, y, z) {
    for (const [dx, dy, dz] of NEIGHBOURS_6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const id = worldState.getBlock(nx, ny, nz);
        const sup = id > 0 ? _blockReg.get(id).support : null;
        if (!sup || nx + sup[0] !== x || ny + sup[1] !== y || nz + sup[2] !== z) continue;
        const def = _blockReg.get(id);
        worldState.setBlock(nx, ny, nz, 0);
        chunkManager.markEdited(nx, nz);
        if (_gameMode !== 'CREATIVE') _dropItems(def, { x: nx + 0.5, y: ny + 0.3, z: nz + 0.5 });
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
    // Torches and lanterns then pick a variant by the face clicked.
    const blockDef = _placementFor(_itemToBlock.get(held.itemId), hit);
    if (!blockDef) return;

    const px = hit.x + hit.face.x;
    const py = hit.y + hit.face.y;
    const pz = hit.z + hit.face.z;
    // A torch or lantern cannot go into water (or lava, one day).
    if (blockDef.model && _blockReg.isLiquid(worldState.getBlock(px, py, pz))) return;

    // Don't place inside player
    const pw = 0.3;
    if (Math.abs(px + 0.5 - me.position.x) < pw &&
        py + 1 > me.position.y && py < me.position.y + 1.8 &&
        Math.abs(pz + 0.5 - me.position.z) < pw) return;

    worldState.setBlock(px, py, pz, blockDef.id);
    chunkManager?.markEdited(px, pz);
    _sounds?.blockPlaced(blockDef, { x: px + 0.5, y: py + 0.5, z: pz + 0.5 });
    _swingArm();

    // Trigger water simulation if placing water
    if (blockDef.id === 5) _water?.addSource(px, py, pz);

    if (_gameMode !== 'CREATIVE') {
        _inventory.removeItem(held.itemId, 1);
        window.dispatchEvent(new CustomEvent('ww_itemPickup'));
    }
}

/**
 * Which block actually goes down when `def` is placed against `hit`'s face:
 * itself, unless it has a `placement` table (BlockRegistry) — then the entry for
 * that face (a wall torch facing away from the wall, a hanging lantern under a
 * ceiling), or null if it cannot go there. It must hang on something that
 * can hold it: not a liquid, not another torch or lantern.
 */
function _placementFor(def, hit) {
    if (!def?.placement) return def ?? null;
    const f = hit.face;
    const side = f.y > 0 ? 'floor' : f.y < 0 ? 'ceiling' : f.x > 0 ? 'east' : f.x < 0 ? 'west' : f.z > 0 ? 'south' : 'north';
    const name = def.placement[side];
    if (!name || _blockReg.hasModel(hit.blockId) || _blockReg.isLiquid(hit.blockId)) return null;
    return _blockReg.getByName(name) ?? null;
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
            const at = { x: mobHit.mob.pos.x, y: mobHit.mob.pos.y + 0.7, z: mobHit.mob.pos.z };
            _sounds?.swing();
            _swingArm();
            if (_hitMob(at, dmg, 2) > 0) _sounds?.struck(at);
        }
        _attackCharge = 0;
    } else if (MOUSE.left && !hit) {
        // Swinging at air — try nearby mobs with wider radius
        if (_attackCharge >= 0.1) {
            const dmg = 1 + (def?.damage ?? 1) * (0.3 + _attackCharge * 0.7);
            const at = { x: me.position.x + _camFwd.x * 2.5, y: me.position.y + 1, z: me.position.z + _camFwd.z * 2.5 };
            if (_attackCharge >= 0.5) _sounds?.swing();
            if (_hitMob(at, dmg, 3) > 0) _sounds?.struck(at);
        }
        _attackCharge = 0;
    } else {
        _attackCharge = Math.min(1, _attackCharge + dt * speed);
    }
}

// ── Food eating ───────────────────────────────────────────────────────────────

function _handleEating(dt) {
    const held = MOUSE.right ? _inventory?.getHotbar(_hotbarSlot) : null;
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
    // For now: immediate raycast hit (no projectile physics yet)
    const arrowHit = raycast(worldState, _blockReg, shootPos, { x: _camFwd.x, y: _camFwd.y, z: _camFwd.z }, 40);
    if (arrowHit) {
        _sounds?.arrowHit({ x: arrowHit.x + 0.5, y: arrowHit.y + 0.5, z: arrowHit.z + 0.5 });
        _hitMob({ x: arrowHit.x, y: arrowHit.y, z: arrowHit.z }, dmg, 2);
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
    _post?.resetAdaptation();
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
    const outside = _camMode !== 0 && !ghost && _camDist > CAM_HEAD;
    _playerModel.show(outside, !ghost);
    _playerModel.update(dt, {
        x: p.x, y: p.y, z: p.z, yaw, pitch,
        speed: Math.hypot(_physics.vel.x, _physics.vel.z),
        onGround: _physics.onGround, inWater: _physics.inWater,
        hurt: Math.min(1, _damageFade * 1.5), dead: _isDead,
        light: _lightAt(p.x, p.y + 1, p.z), lightDir: _atmos?.state.lightDir ?? null, still: _paused && !_isDead,
    });
}

function _updateCamera() {
    const ex = me.position.x, ey = me.position.y + CAMERA_HEIGHT, ez = me.position.z;
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
            const ly = chunk.columnTop(lx, lz), k = lx + lz * CHUNK_SIZE;
            heights[k] = ly < 0 ? EDIT_EMPTY : WORLD_MIN_Y + ly;
            ids[k] = ly < 0 ? 0 : chunk.getVoxel(lx, ly, lz);
        }
    }
    _far?.setEdit(chunk.cx, chunk.cz, heights, ids);
    _farEditsOut.set(key, bytes);
}

/** Send the summaries made since the last save to the server. */
function _saveFarEdits() {
    if (!chunkManager?.worldId || _farEditsOut.size === 0) return;
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
    if (_selMesh) { scene.remove(_selMesh); }

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

    const client = worldClient;   // capture — quitWorld may null worldClient mid-save
    window.dispatchEvent(new CustomEvent('ww_saving', { detail: { active: true } }));

    chunkManager.saveAll();   // queues the batch onto the WebSocket send buffer
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
window.__wwSpawnMob = (type, x, y, z) => _entities?._spawnMob(type, { x, y, z }) ?? null;
/** Strike the mob nearest a point, as a blow from the player would — for tests. */
window.__wwHitMob = (x, y, z, damage) => _entities?.hitNearest({ x, y, z }, damage, 2) ?? 0;
/** What the mobs are doing (diagnostics): [{ id, type, state, x, y, z, health, onGround }]. */
window.__wwMobs = () => [...(_entities?._mobs.values() ?? [])].map(m => ({
    id: m.id, type: m.typeId, state: m.dying > 0 ? 'DYING' : m.state, health: m.health, onGround: m.onGround,
    x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2), model: !!m.inst,
}));
/** The block id at a world position (0 = air or no world). */
window.__wwBlockAt = (x, y, z) => worldState?.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) ?? 0;
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
    const now = performance.now();
    const dt  = _lastRenderMs ? Math.min((now - _lastRenderMs) / 1000, 0.1) : 0;
    _lastRenderMs = now;
    _updateBlockLightUniforms(dt);
    if (_atmos) {
        // Sky and fog follow the sky light where the camera is (eased inside the
        // atmosphere). Underground the sky cannot be seen, and a bright sky
        // colour would show through the tiniest gap between triangles and fade
        // distant tunnels to blue instead of into the dark.
        _atmos.update(dt, {
            camera, paused: _paused,
            px: me.position.x, py: me.position.y, pz: me.position.z,
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
    if (post) {
        if (_atmos) _atmos.uniforms.uLinearOut.value = false;
        _post.end(dt);
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
        // The clock and the weather are the world's, kept with its owner.
        atmosphere: !_guest && _atmos?.active ? _atmos.toJSON() : null,
    };
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
    _physics.slip = 0;
    if (!_atmos || _gameMode === 'SPECTATOR') return;
    const p = me.position;
    const open = _skyBrightnessAt(p.x, p.y + 1, p.z) >= 0.99;
    if (!open) return;
    const w = _atmos.wind, ws = Math.hypot(w[0], w[1]);
    if (ws > 12) {
        const k = (ws - 12) / ws * 0.35;
        ext.x += w[0] * k; ext.z += w[1] * k;
    }
    _physics.slip = _atmos.ice;
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

const STATE_HZ = 15, MOB_SEND = 0.1, ATMOS_SEND = 2;
let _mpStateT = 0, _mpMobT = 0, _mpAtmosT = 0;
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
    if (b === 0 && was > 0) _sounds?.blockBroken(_blockReg.get(was), at, 0.7);
    else if (b > 0 && !_blockReg.isLiquid(b)) _sounds?.blockPlaced(_blockReg.get(b), at, 0.6);
}

function _playerCasters() {
    if (!_entities) return;
    _entities.extraCasters = [(out, o) => _playerModel?.caster(out, o), ...(_others?.casters() ?? [])];
}

/** Join the world's session; resolves with the server's welcome, or null (no server: playing alone and unseen). */
async function _joinSession(worldId) {
    const mp = _mp = new Multiplayer(WS_URL);
    mp.onJoined = (p) => {
        _others?.add(p);
        _playerCasters();
        _mobFull = true; _mpStateT = _mpMobT = _mpAtmosT = 0;      // tell the newcomer everything now
        _notice(`${p.name} joined`);
    };
    mp.onLeft = (id) => {
        const name = _others?.map.get(id)?.name;
        _others?.remove(id);
        _playerCasters();
        if (name) _notice(`${name} left`);
    };
    mp.onState = (id, s) => _others?.state(id, s);
    mp.onProfile = (p) => _others?.profile(p);
    mp.onBlock = (x, y, z, b) => _applyRemoteBlock(x, y, z, b);
    mp.onAtmos = (a) => { if (!mp.isHost) _atmos?.sync(a); };
    mp.onMsg = (from, d) => {
        switch (d?.t) {
            case 'mobs':                                   // the host's mobs, to a guest
                if (_entities?.replica) _entities.applySnapshot(d, MOB_SEND);
                break;
            case 'hit': {                                  // a guest's blow, to the host
                if (!mp.isHost) break;
                const o = _others?.map.get(from);
                if (o) _entities?.hitById(d.id, d.dmg, { id: from, x: o.x, y: o.y, z: o.z });
                break;
            }
            case 'attack':                                 // a mob's blow, to the player it fell on
                window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage: d.dmg } }));
                break;
            case 'drops':                                  // what a mob this player killed left behind
                for (const [itemId, n] of d.items ?? []) _entities?.dropItem(d.pos, itemId, n);
                break;
        }
    };
    mp.onClosed = (reason) => {
        if (_mp !== mp) return;
        window.dispatchEvent(new CustomEvent('ww_sessionClosed', { detail: { reason } }));
    };

    const welcome = await mp.join({ worldId, clientId: _stateKey || 'owner', name: _playerName, skin: _skin });
    if (_mp !== mp) return null;                           // the world was left meanwhile
    if (!welcome) { _mp = null; return null; }
    if (!_entities || !worldState) return welcome;

    worldState.onSet = (x, y, z, id) => { if (!_mpApplying) mp.block(x, y, z, id); };
    for (let i = 0, e = welcome.edits ?? []; i + 3 < e.length; i += 4) _applyRemoteBlock(e[i], e[i + 1], e[i + 2], e[i + 3], true);
    _others = new RemotePlayers(scene, _entities.models);
    for (const p of welcome.players ?? []) _others.add(p);
    _playerCasters();
    // The host's game runs the mobs; a guest's shows them.
    _entities.replica = !mp.isHost;
    _entities.onRemoteHit = (id, dmg) => mp.host({ t: 'hit', id, dmg });
    _entities.onRemoteAttack = (pid, dmg) => mp.to(pid, { t: 'attack', dmg });
    _entities.onRemoteDrops = (pid, pos, items) => mp.to(pid, { t: 'drops', pos, items });
    return welcome;
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
        }));
    }
    if (!mp.isHost || !_entities) return;
    _mpMobT -= dt;
    if (_mpMobT <= 0) {
        _mpMobT = MOB_SEND;
        mp.all({ t: 'mobs', ..._entities.snapshot(_mobFull) });
        _mobFull = false;
    }
    _mpAtmosT -= dt;
    if (_mpAtmosT <= 0 && _atmos?.active) {
        _mpAtmosT = ATMOS_SEND;
        mp.atmos({ ..._atmos.toJSON(), running: _atmos.day.running });
    }
}

/** Who is here, for the pause menu: this player first. */
window.__wwPlayers = () => !_mp || _mp.id === 0 ? [] : [
    { id: _mp.id, name: _playerName || 'You', you: true, host: _mp.isHost },
    ...[..._mp.players.values()].map(p => ({ id: p.id, name: p.name, you: false, host: p.id === _mp.hostId })),
];

// ── Sounds ────────────────────────────────────────────────────────────────────

/** A blow of the player lands on the mob nearest `at`. Returns the damage done. */
function _hitMob(at, damage, radius) {
    return _entities?.hitNearest(at, damage, radius) ?? 0;
}

let _nearWater = 0, _nearWaterT = 0;

/** How much open water is within a few blocks, 0 … 1 — for the sound of it. */
function _waterNearby(p) {
    let wet = 0;
    const y = Math.floor(p.y);
    for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6, r = i & 1 ? 3 : 6;
        const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
        for (let dy = 0; dy >= -2; dy--) {
            if (_blockReg.isLiquid(worldState.getBlock(x, y + dy, z))) { wet += worldState.getBlock(x, y + dy + 1, z) === 0 ? 1 : 0; break; }
        }
    }
    return Math.min(1, wet / 5);
}

/** What the player is doing, for GameSounds: footsteps, splashes and the ambience. */
function _tickSounds(dt, result, sneaking) {
    if (!_sounds || !worldState) return;
    const p = me.position, eye = p.y + CAMERA_HEIGHT;
    const fx = Math.floor(p.x), fz = Math.floor(p.z);
    _nearWaterT -= dt;
    if (_nearWaterT <= 0) { _nearWaterT = 0.5; _nearWater = _waterNearby(p); }
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
