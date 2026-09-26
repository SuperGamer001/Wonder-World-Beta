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
import { ShadowMapper, SHADOW_LAYER, SHADOW_GLSL } from './Shadows.js';
import { SKY_MAX, SKY_FALLOFF, SKY_MIN, SUN_DIR, SUN_AMBIENT } from './engine/Sun.js';
import { Particles, PARTICLE_LEVELS }        from './Particles.js';
import { Atmosphere }                        from './Atmosphere.js';
import { ATMOS_GLSL }                        from './AtmosGLSL.js';

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
// The mesher does not emit a `normal` attribute — these shaders never read one,
// because directional brightness is baked into the vertex colour.
//
// vDepth carries view-space distance so the fragment stage can apply fog. A
// custom ShaderMaterial gets no fog from Three.js automatically, and without it
// chunks pop in hard at the render-distance edge, which is what forced the very
// long default view distance.
//
// Leaves sway in the wind (uWind, from the weather). The displacement depends
// only on world position, so corners shared by neighbouring quads move together
// and the canopy never cracks apart. Chunk meshes are only translated, so the
// offset can be added to the local position directly. The shadow depth pass
// does not sway — shadows of leaves stay put, which reads fine.
const CHUNK_VERT = `
in vec3  color;
in float layer;
uniform vec4  uWind;
uniform float uTime;
uniform float uSwayLayer;

out vec3  vColor;
out vec2  vUV;
out float vLayer;
out float vDepth;
out vec3  vWorldPos;

void main() {
    vec3 pos = position;
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    if (abs(layer - uSwayLayer) < 0.5) {
        float s = length(uWind.xy);
        vec2 dir = s > 0.01 ? uWind.xy / s : vec2(0.7071);
        float lean = min(s / 10.0, 1.0);
        float ph = dot(vWorldPos, vec3(0.37, 0.21, 0.29));
        float amp = min(0.025 + 0.012 * s, 0.28) * (1.0 + uWind.z);
        float wave = sin(uTime * (1.5 + 0.07 * s) + ph) * 0.65 + sin(uTime * 3.3 + ph * 1.7) * 0.35;
        vec3 off = vec3(dir.x * (wave + 0.6 * lean), wave * 0.3, dir.y * (wave + 0.6 * lean)) * amp;
        pos += off;
        vWorldPos += off;
    }
    vColor  = color;
    vUV     = uv;
    vLayer  = layer;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vDepth  = -mv.z;
    gl_Position = projectionMatrix * mv;
}
`;

// Shared fragment tail: lighting (Atmosphere/DayCycle), weather on the surface,
// fog, then the display adjustments that used to be a CSS filter on <body>.
// Running those here costs a few ALU ops instead of forcing the whole page —
// canvas included — through an extra compositing pass every frame.
const _v3 = (v) => `vec3(${v.map(x => x.toFixed(6)).join(', ')})`;
const CHUNK_COMMON = `
precision highp sampler2DArray;
precision highp sampler3D;
uniform sampler2DArray uTex;
uniform sampler3D uLight;        // this chunk's sky light (see _setChunkLight)
uniform vec3  uLightOrigin;      // world position of the light volume's corner
uniform vec3  uLightSize;        // its size in blocks
uniform float uFogNear;
uniform float uFogFar;
uniform float uBrightness;
uniform int   uColorMode;   // 0 none, 1 protanopia, 2 deuteranopia, 3 tritanopia
${ATMOS_GLSL}

in vec3  vColor;
in vec2  vUV;
in float vLayer;
in float vDepth;
in vec3  vWorldPos;

out vec4 fragColor;

// Normal of the visible side of the surface, from screen-space derivatives (the
// chunk meshes carry no normals). Flipped toward the camera, so on double-sided
// water and leaves it still points into the air the viewer is looking through.
vec3 surfaceNormal() {
    vec3 c = cross(dFdx(vWorldPos), dFdy(vWorldPos));
    // Degenerate at some triangle edges; a NaN here would read garbage light.
    float len = length(c);
    vec3 n = len > 1e-10 ? c / len : vec3(0.0, 1.0, 0.0);
    return dot(n, cameraPosition - vWorldPos) < 0.0 ? -n : n;
}

// Sky light level (engine/Sun.js), 0..15: read from the air half a block in
// front of the surface, interpolated between cells.
float skyLevel(vec3 n) {
    return texture(uLight, (vWorldPos + n * 0.5 - uLightOrigin) / uLightSize).r * ${SKY_MAX.toFixed(1)};
}

${SHADOW_GLSL}

// Shadows of the clouds: follow the light up to the cloud base and ask how
// much cloud is there — the same field the clouds are drawn from, so the
// shadows drift across the land under the clouds you can see.
float cloudShade() {
    if (uCloudThresh > 1.5 || uSunDir.y < 0.05) return 1.0;
    vec2 xz = vWorldPos.xz + uSunDir.xz * ((uCloudBase - vWorldPos.y) / uSunDir.y);
    float n = cloudNoise(xz);
    return 1.0 - cloudCover(n) * (0.55 + 0.4 * cloudThick(n));
}

// 0 under cover … 1 under open sky; set by lighting(), read by weatherSurface().
float gExposed = 1.0;

// The light on this fragment. The meshers baked sunBrightness(n) for the fixed
// sun in engine/Sun.js into the vertex colour; that is divided back out here and
// the surface is lit by the real light instead: the sky (uAmbient, tinted by
// time of day and weather) and the sun or moon (uDirect along uSunDir, blocked
// by shadows and by clouds). At noon under a clear sky this matches the baked
// shading. Lightning brightens open ground.
vec3 lighting(vec3 n) {
    float lvl = skyLevel(n);
    float sky = max(pow(${SKY_FALLOFF}, ${SKY_MAX.toFixed(1)} - lvl), ${SKY_MIN});
    gExposed = smoothstep(12.5, 15.0, lvl);
    float baked = ${SUN_AMBIENT.toFixed(4)} + ${(1 - SUN_AMBIENT).toFixed(4)} * max(dot(n, ${_v3(SUN_DIR)}), 0.0);
    float facing = max(dot(n, uSunDir), 0.0);
    float direct = facing > 0.0 ? facing * sunShadow(n) * cloudShade() : 0.0;
    vec3 L = (${SUN_AMBIENT.toFixed(4)} * uAmbient + ${(1 - SUN_AMBIENT).toFixed(4)} * direct * uDirect) / baked;
    return L * sky + vec3(0.8, 0.85, 1.0) * uFlash * gExposed;
}

// Rain darkens open ground and makes it glint; freezing rain glazes it.
vec3 weatherSurface(vec3 c, vec3 n) {
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
vec3 applyFog(vec3 c) {
    vec3 r = vWorldPos - cameraPosition;
    float f = clamp((vDepth - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
    f = max(f, weatherFog(cameraPosition, r));
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
    return clamp(hue * c, 0.0, 1.0);
}

vec3 grade(vec3 c) { return applyColorMode(applyFog(c) * uBrightness); }
`;

const CHUNK_FRAG = CHUNK_COMMON + `
void main() {
    vec3 n = surfaceNormal();
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(fract(vUV.x), fract(vUV.y), floor(vLayer + 0.5)));
        if (t.a < 0.1) discard;
        fragColor = vec4(grade(weatherSurface(t.rgb * vColor.r * lighting(n), n)), t.a);
    } else {
        fragColor = vec4(grade(weatherSurface(vColor * lighting(n), n)), 1.0);
    }
}
`;

const CHUNK_TRANSP_FRAG = CHUNK_COMMON + `
void main() {
    vec3 n = surfaceNormal();
    if (vLayer >= 0.0) {
        vec4 t = texture(uTex, vec3(fract(vUV.x), fract(vUV.y), floor(vLayer + 0.5)));
        if (t.a < 0.05) discard;
        fragColor = vec4(grade(t.rgb * vColor.r * lighting(n)), t.a * 0.72);
    } else {
        fragColor = vec4(grade(vColor * lighting(n)), 0.72);
    }
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

async function _buildBlockTextureArray() {
    const SIZE = 16;
    const N    = BLOCK_TEX_LAYERS.length;
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

// Fog range as a fraction of the loaded radius.
const FOG_START = 0.75;   // fully clear inside this (default; the Fog Distance graphics setting)
const FOG_END   = 1.00;   // fully fogged at the edge of the loaded area
let _fogStart   = FOG_START;

// Shared by both chunk materials so a single write updates the whole terrain.
let chunkUniforms = null;
// Held so _disposeAll can release it — it is rebuilt on each world load.
let _blockTexArray = null;

function _createChunkMaterials(texArray) {
    _blockTexArray = texArray;
    chunkUniforms = {
        uTex:        { value: texArray },
        uFogNear:    { value: 160 },
        uFogFar:     { value: 280 },
        uBrightness: { value: 1.0 },
        uColorMode:  { value: 0 },
        // Texture layer that sways in the wind (leaves).
        uSwayLayer:  { value: BLOCK_FACE_MAP[7]?.top ?? -10 },
        // Shared with the shadow mapper, so a Shadows change reaches all terrain.
        ..._shadows.uniforms,
        // Shared with the atmosphere: time of day, weather, fog, clouds.
        ..._atmos.uniforms,
    };
    // Water and ice never cast shadows.
    _shadows.setTextures(texArray, [BLOCK_FACE_MAP[5]?.top, BLOCK_FACE_MAP[13]?.top]);

    opaqueMaterial = new THREE.ShaderMaterial({
        glslVersion:  THREE.GLSL3,
        uniforms:     chunkUniforms,
        vertexShader:   CHUNK_VERT,
        fragmentShader: CHUNK_FRAG,
    });

    transparentMaterial = new THREE.ShaderMaterial({
        glslVersion:  THREE.GLSL3,
        uniforms:     chunkUniforms,
        vertexShader:   CHUNK_VERT,
        fragmentShader: CHUNK_TRANSP_FRAG,
        transparent:  true,
        depthWrite:   false,
        // Must stay DoubleSide: the mesher only emits the outward-facing shell of
        // a transparent volume, so culling backfaces would make the water surface
        // vanish when the camera is underneath it.
        side:         THREE.DoubleSide,
    });

    _applyViewDistance();
}

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
    const blocks = _renderDist * CHUNK_SIZE;
    // Fade only across the outermost quarter of the loaded area. Starting the
    // fade earlier hid a lot of world the player had already paid to generate.
    // Ending it exactly at `blocks` still covers the load boundary, because a
    // chunk's far corners sit past its centre distance.
    const near = blocks * Math.min(_fogStart, FOG_END - 0.02);
    const far  = blocks * FOG_END;

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

    _shadows = new ShadowMapper(renderer, BLOCK_TEX_LAYERS.length);
    _shadows.setLevel(_gfx.shadows);
    _atmos = new Atmosphere(scene);
    _atmos.setSkyMode(_gfx.sky);
    _atmos.setCloudLevel(_gfx.clouds);
    _atmos.setParticleScale(PARTICLE_LEVELS[_gfx.particles] ?? 0.6);
    _atmos.setVolume(_gfx.weatherVolume);
    _atmos.setReduceMotion(_gfx.reduceMotion);
    _atmos.onStrike = _onLightningStrike;
});

// ── World load event ──────────────────────────────────────────────────────────

document.addEventListener('WorldJS_startWorldLoad', async (e) => {
    const {
        gamepackData = {}, worldId = null, worldSeed = null,
        playerPos = null, gameMode = 'SURVIVAL', terrainStyle = 'blocky',
        daylightCycle = true, weather = 'dynamic',
    } = e.data ?? {};

    _gameMode = gameMode;
    _terrainStyle = terrainStyle === 'smooth' ? 'smooth' : 'blocky';

    // Reset survivals stats to safe defaults; will be overwritten by saved state below.
    me.health = 100;
    me.hunger = 100;
    me.energy = 100;

    _blockReg = buildRegistryFromGamePack(gamepackData);
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
    _entities.lightAt = (x, y, z) => _skyBrightnessAt(x, y, z) * (_atmos?.mobLight ?? 1);
    _particles = new Particles(scene, (x, y, z) => {
        const id = worldState?.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) ?? 0;
        if (id === 0 || _blockReg.isNoCollision(id)) return false;
        return _smooth?.isMesh(id) ? _smooth.pointInMesh(x, y, z) : true;
    });
    _particles.setLevel(_gfx.particles);
    _particles.wind = _atmos.wind;      // debris blows in the weather's wind
    _savedAtmos = null;
    _entities.smooth = _smooth;
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
        terrainStyle:  _terrainStyle,
    });

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

        // Load saved player state if available
        try {
            const res = await fetch(`${SERVER_URL}/api/worlds/${worldId}/player-state`);
            if (res.ok) {
                const state = await res.json();
                if (state) _applyPlayerState(state);
                _savedAtmos = state?.atmosphere ?? null;
            }
        } catch { /* server offline */ }
    }

    if (!_physics) return; // guard if quitWorld raced

    // Time of day and weather: carried on from the save, with the world's
    // Daylight Cycle and Weather settings from its world.json.
    _atmos.startWorld({
        seed: worldState.seed, biomes: gamepackData.biomes ?? [], world: worldState, smooth: _smooth,
        saved: _savedAtmos, daylightCycle, weather,
    });

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
                '— terrain:', _terrainStyle, '— workers:', workerPool.workerCount);
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
    // Release mob geometries, sprite materials and item textures before the
    // scene is torn down; these are GPU-side and are not reclaimed by GC alone.
    _entities?.dispose();
    _particles?.dispose();
    _particles = null;
    _atmos?.endWorld();
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

    // Drop the HUD's cached handles and last-written values so the next world
    // starts from a clean slate rather than skipping writes that look unchanged.
    _hud.ready = false;
    _loadGateDone = false;
});

// ── Tick event ────────────────────────────────────────────────────────────────

document.addEventListener('WorldJS_tick', (e) => {
    if (!chunkManager) return;

    // While the loading screen is up, report how much of the area around the
    // player has finished meshing so main.js can gate the reveal + drive the bar.
    if (!_loadGateDone) _reportLoadGate();

    const dt = Math.min(e.data?.dt ?? 0.016, 0.1);
    _paused = !!e.data?.paused;

    const isLocked = !!document.pointerLockElement;
    if (_wasLocked && !isLocked) { _saveAll(); _savePlayerState(); }
    _wasLocked = isLocked;

    if (_isDead) { _render(); return; }

    // Waiting for a ground spawn: keep loading terrain around the spawn column and
    // hold the player frozen above it until a surface is found.
    if (_spawnPending) {
        _tryGroundSpawn();
        _camFwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
        _updateCamera();
        chunkManager.update(me.position, _camFwd, { x: 0, z: 0 });
        _updateHUD();
        _render();
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

    _applyWeatherToPlayer();
    const result = _physics.update(me.position, input, dt, _gameMode, {
        hunger: me.hunger, energy: me.energy,
    });

    if (result.fallDamage > 0) _applyDamage(result.fallDamage);
    if (result.fellIntoVoid)   _applyDamage(20);

    if (_gameMode === 'SURVIVAL') _survivalTick(dt);

    _checkSuffocation(dt);
    _water.tick(dt, (cx, cz) => chunkManager?.markDirty(cx, cz));
    _particles?.update(dt);
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
    weatherVolume: 0.8, reduceMotion: false,
};
let _shadows   = null;   // ShadowMapper — lives as long as the renderer
let _atmos     = null;   // Atmosphere (day cycle, weather, sky, clouds) — likewise
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
    if (s.reduceMotion != null)  { _gfx.reduceMotion = !!s.reduceMotion; _atmos?.setReduceMotion(s.reduceMotion); }
    if (s.fogStart != null) {
        _fogStart = s.fogStart;
        _applyViewDistance();
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
    // Debris takes the light of the air it flies into, so it is dark in a cave.
    const lit = _skyBrightnessAt(hit.x + 0.5 + (hit.face?.x ?? 0), hit.y + 0.5 + (hit.face?.y ?? 1), hit.z + 0.5 + (hit.face?.z ?? 0));
    const rgb = block.topColor ?? block.color ?? [0.5, 0.5, 0.5];
    const dl = lit * (_atmos?.mobLight ?? 1);
    _particles?.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, [rgb[0] * dl, rgb[1] * dl, rgb[2] * dl]);
    worldState.setBlock(hit.x, hit.y, hit.z, 0);
    chunkManager.markEdited(hit.x, hit.z);

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
    chunkManager?.markEdited(px, pz);

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

// ── HUD ───────────────────────────────────────────────────────────────────────
// _updateHUD runs once per frame, so it does no getElementById lookups and no
// innerHTML writes. Element handles are resolved once and every value is
// compared against the last one written — an unchanged HUD touches the DOM zero
// times, where the previous version rebuilt three <img> elements 60x a second.

const _hud = { ready: false, el: {}, last: {} };

function _hudInit() {
    const ids = [
        'playerCoords', 'playerInfo', 'playerHealthVal', 'playerHungerVal', 'playerEnergyVal',
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
        _hudText('playerHealthVal', `Health: ${Math.ceil(me.health)} / 100`);
        _hudText('playerHungerVal', `Hunger: ${Math.ceil(me.hunger)} / 100`);
        _hudText('playerEnergyVal', `Energy: ${Math.ceil(me.energy)} / 100`);
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

function _updateCamera() {
    camera.position.set(me.position.x, me.position.y + CAMERA_HEIGHT, me.position.z);

    _camQ.identity();
    _camQ.multiply(_camQy.setFromAxisAngle(_axisY, yaw));
    _camQ.multiply(_camQx.setFromAxisAngle(_axisX, pitch));
    camera.quaternion.copy(_camQ);

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

// Until a chunk's light arrives it is treated as open sky.
function _fullLightTexture() {
    const tex = new THREE.Data3DTexture(new Uint8Array([255]), 1, 1, 1);
    tex.format = THREE.RedFormat;
    tex.needsUpdate = true;
    return tex;
}

function _chunkLight(key, cx, cz) {
    let e = chunkLights.get(key);
    if (e) return e;
    const uniforms = {
        ...chunkUniforms,
        uLight:       { value: _fullLightTexture() },
        uLightOrigin: { value: new THREE.Vector3(cx * CHUNK_SIZE - 1, WORLD_MIN_Y, cz * CHUNK_SIZE - 1) },
        uLightSize:   { value: new THREE.Vector3(1, 1, 1) },
    };
    e = {
        data: null, y0: 0, h: 0, tex: uniforms.uLight.value, uniforms,
        opaque: new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, uniforms,
            vertexShader: CHUNK_VERT, fragmentShader: CHUNK_FRAG,
        }),
        transparent: new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, uniforms,
            vertexShader: CHUNK_VERT, fragmentShader: CHUNK_TRANSP_FRAG,
            transparent: true, depthWrite: false, side: THREE.DoubleSide,   // see _createChunkMaterials
        }),
    };
    chunkLights.set(key, e);
    return e;
}

function _setChunkLight(key, cx, cz, light) {
    if (!light) return;
    const e = _chunkLight(key, cx, cz);
    const tex = new THREE.Data3DTexture(light.data, LIGHT_W, light.h, LIGHT_W);
    tex.format    = THREE.RedFormat;
    tex.type      = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    e.tex.dispose();
    e.tex = tex;
    e.data = light.data; e.y0 = light.y0; e.h = light.h;
    e.uniforms.uLight.value = tex;
    e.uniforms.uLightOrigin.value.y = WORLD_MIN_Y + light.y0;
    e.uniforms.uLightSize.value.set(LIGHT_W, light.h, LIGHT_W);
}

function _disposeChunkLight(key) {
    const e = chunkLights.get(key);
    if (!e) return;
    e.tex.dispose(); e.opaque.dispose(); e.transparent.dispose();
    chunkLights.delete(key);
}

/**
 * Brightness of sky light at a world point, 0..1 — for things drawn without the
 * chunk shader (mobs, debris). Open sky where no light has arrived yet.
 */
function _skyBrightnessAt(x, y, z) {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const cx = bx >> 4, cz = bz >> 4;
    const e = chunkLights.get(WorldState.key(cx, cz));
    if (!e?.data) return 1;
    const ly = by - WORLD_MIN_Y - e.y0;
    if (ly >= e.h) return 1;
    if (ly < 0) return SKY_MIN;
    const lx = bx - cx * CHUNK_SIZE + 1, lz = bz - cz * CHUNK_SIZE + 1;
    const level = e.data[lx + ly * LIGHT_W + lz * LIGHT_W * e.h] / 255 * SKY_MAX;
    return Math.max(Math.pow(SKY_FALLOFF, SKY_MAX - level), SKY_MIN);
}

function _onLightReady(cx, cz, light) {
    _setChunkLight(WorldState.key(cx, cz), cx, cz, light);
}

// A chunk is one opaque and one transparent mesh (either may be absent), so it
// costs at most two draw calls — two more with shadows on.
function _onMeshReady(cx, cz, geo, light) {
    const key    = WorldState.key(cx, cz);
    _atmos?.invalidateColumn(cx, cz);   // blocks changed: where rain stops has too
    _removeMeshes(key);
    _setChunkLight(key, cx, cz, light);
    const entry = { opaque: null, transparent: null, key, cx, cz };
    const mats  = _chunkLight(key, cx, cz);
    if (geo.positions.length > 0) {
        entry.opaque = _addChunkMesh(_buildGeometry(geo, false), mats.opaque, cx, cz);
    }
    if (geo.transparentPositions.length > 0) {
        // Leaves cast shadows; water and ice are skipped in the depth pass.
        entry.transparent = _addChunkMesh(_buildGeometry(geo, true), mats.transparent, cx, cz);
    }
    chunkMeshes.set(key, entry);
}

function _onChunkUnload(key) { _removeMeshes(key); _disposeChunkLight(key); }

function _addChunkMesh(geometry, material, cx, cz) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * CHUNK_SIZE, WORLD_MIN_Y, cz * CHUNK_SIZE);
    mesh.layers.enable(SHADOW_LAYER);
    scene.add(mesh);
    return mesh;
}

// Reused scratch so the bounding sphere below allocates nothing per chunk.
const _bsCenter = new THREE.Vector3();

function _buildGeometry(geo, transparent) {
    const buf  = new THREE.BufferGeometry();
    const pos  = transparent ? geo.transparentPositions : geo.positions;
    const col  = transparent ? geo.transparentColors    : geo.colors;
    const idx  = transparent ? geo.transparentIndices   : geo.indices;
    const uvs  = transparent ? geo.transparentUVs       : geo.uvs;
    const lay  = transparent ? geo.transparentLayers    : geo.layers;

    // No 'normal' attribute — the chunk shaders bake lighting into vertex colour
    // and never read one, so uploading it would be 12 bytes per vertex of waste.
    buf.setAttribute('position', new THREE.BufferAttribute(pos,  3));
    buf.setAttribute('color',    new THREE.BufferAttribute(col,  3));
    buf.setAttribute('uv',       new THREE.BufferAttribute(uvs,  2));
    buf.setAttribute('layer',    new THREE.BufferAttribute(lay,  1));
    buf.setIndex(new THREE.BufferAttribute(idx, 1));

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
        scene.remove(mesh);
        mesh.geometry.dispose();
    }
    chunkMeshes.delete(key);
}

function _disposeAll() {
    for (const key of [...chunkMeshes.keys()]) _removeMeshes(key);
    for (const key of [...chunkLights.keys()]) _disposeChunkLight(key);
    if (_selMesh) { scene.remove(_selMesh); }
    opaqueMaterial?.dispose();
    transparentMaterial?.dispose();
    opaqueMaterial = null;
    transparentMaterial = null;

    // The block atlas is rebuilt on every world load, so it has to be released
    // on every unload too — otherwise each world entered in a session leaves
    // another DataArrayTexture resident on the GPU.
    _blockTexArray?.dispose();
    _blockTexArray = null;
    chunkUniforms  = null;
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
        drawCalls:  i.render.calls,
        tris:       i.render.triangles,
        geometries: i.memory.geometries,
        textures:   i.memory.textures,
        programs:   i.programs?.length ?? 0,
        chunks:     worldState?.chunks.size ?? 0,
        renderDist: _renderDist,
        shadows:    _shadows?.level ?? 'off',
        clouds:     _atmos?.clouds.level ?? _gfx.clouds,
        sky:        _atmos?.skyMode ?? _gfx.sky,
        atmosphere: _atmos?.info() ?? null,
        particles:  _particles?.level ?? _gfx.particles,
        terrainStyle: _terrainStyle,
        pixelRatio: renderer.getPixelRatio(),
        cameraFar:  camera?.far ?? null,
        fogNear:    chunkUniforms?.uFogNear.value ?? null,
        fogFar:     chunkUniforms?.uFogFar.value ?? null,
    };
};

// The atmosphere, for poking at weather from the console and in diagnostics.
window.__wwAtmos = () => _atmos;

/** Draw the scene, then service a pending screenshot request in the same task. */
let _lastRenderMs = 0;

function _render() {
    const now = performance.now();
    const dt  = _lastRenderMs ? Math.min((now - _lastRenderMs) / 1000, 0.1) : 0;
    _lastRenderMs = now;
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
            fade: Math.max(_renderDist * CHUNK_SIZE * 1.6, 160),
            fog: scene.fog, background: scene.background,
        });
        _shadows?.setLightDir(_atmos.state.lightDir);
    }
    // No direct light (night between moonrise and moonset, or twilight): no
    // shadow to cast, so skip the depth pass.
    const directLight = _atmos ? _atmos.state.directStrength > 0.01 : true;
    if (_shadows?.enabled && chunkUniforms && directLight) _shadows.update(scene, camera.position);
    renderer.render(scene, camera);
    if (_pendingScreenshotWorldId !== null) {
        const worldId = _pendingScreenshotWorldId;
        _pendingScreenshotWorldId = null;
        _capturePendingScreenshot(worldId);
    }
}

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
        atmosphere: _atmos?.active ? _atmos.toJSON() : null,
    };
    try {
        await fetch(`${SERVER_URL}/api/worlds/${chunkManager.worldId}/player-state`, {
            method: 'PUT',
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

// ── Direction helpers ─────────────────────────────────────────────────────────

function _horizontalForward() {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
