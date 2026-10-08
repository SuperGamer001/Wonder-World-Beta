/**
 * Shadows — sun shadow mapping for the chunk shaders (Graphics → Shadows).
 *
 * The chunk materials are custom ShaderMaterials, so Three.js's built-in shadow
 * system does not apply to them. Instead this renders a depth map of the scene
 * from the sun (an orthographic box around the player) and the chunk fragment
 * shader samples it — see sunShadow() in world.js.
 *
 * What casts: chunk meshes (render layer SHADOW_LAYER) and mobs
 * (SHADOW_DYNAMIC_LAYER). Water and ice are skipped in the depth shader, and
 * textured surfaces are alpha-tested, so glass casts the shadow of its frame
 * and a torch that of its stick.
 *
 * The terrain's depth is not re-rendered every frame. It changes only when the
 * light moves, when the box moves, or when a chunk inside the box is re-meshed,
 * so it is kept in its own target (`terrain`) and redrawn only then:
 *   • the light is re-aimed in steps of about a third of a degree, not every
 *     frame — continuous re-aiming re-rasterises every shadow edge and makes
 *     them shimmer anyway
 *   • the box moves in steps of an eighth of its radius (BOX_STEPS), not with
 *     every texel the player walks — it is half a step larger to make up for
 *     it, and the fade at its edge follows the player (uShadowFocus), not the
 *     box, so a step is invisible
 *   • world.js calls invalidate() with the box of each chunk it installs or
 *     removes; only those inside the shadow box count
 * Mobs move every frame, so while there are any, each frame copies the terrain
 * depth into `target` on the GPU and draws just the mobs on top. Standing
 * still or looking around, the terrain pass — hundreds of draw calls and
 * millions of alpha-tested pixels — costs nothing.
 *
 * The light is the sun by day and the moon by night (DayCycle.lightDir, set
 * through setLightDir). sunShadow() returns how lit a fragment is (0 in
 * shadow … 1 lit); the chunk shader turns that into light, keeping only the
 * ambient part where it is shadowed.
 */

import * as THREE from 'three';
import { SUN_DIR as SUN } from './engine/Sun.js';
import { MESH_VERT_GLSL } from './engine/MeshFormat.js';

// Render layers that mark shadow casters: terrain (cached) and things that
// move every frame (mobs — EntityManager sets this layer by number).
export const SHADOW_LAYER = 1;
export const SHADOW_DYNAMIC_LAYER = 2;

// Direction toward the sun the meshers bake face shading for (engine/Sun.js).
export const SUN_DIR = new THREE.Vector3(...SUN);

// Re-aim the shadow camera once the light has moved this far (cosine of ~0.35°).
const LIGHT_STEP_COS = Math.cos(0.35 * Math.PI / 180);
// A shadow camera at a grazing angle smears shadows for hundreds of blocks; the
// light is nearly gone by then anyway, so the aim never drops below this.
const MIN_LIGHT_Y = 0.12;
// The box moves in steps of radius / BOX_STEPS (rounded to whole texels).
const BOX_STEPS = 8;
// Depth range along the light: the camera sits this far toward the light from
// the box centre, and sees twice as far.
const LIGHT_BACK = 250;
// Terrain changes redraw the map at most this often (seconds). While new
// terrain streams in, some chunk inside the box changes nearly every frame —
// the box reaches far along the light — and a new chunk's shadow a quarter of
// a second late is invisible. Moving the box or the light redraws at once.
const TERRAIN_REDRAW_MIN = 0.25;

// size: shadow map resolution. radius: shadowed distance around the player,
// in blocks. pcf: soft-edge kernel radius (0 = one hard tap, 1 = 3×3).
export const SHADOW_LEVELS = {
    off:    null,
    low:    { size: 1024, radius: 40, pcf: 0 },
    medium: { size: 2048, radius: 64, pcf: 1 },
    high:   { size: 3072, radius: 96, pcf: 1 },
};

const DEPTH_VERT = MESH_VERT_GLSL + `
out float vLayer;
out vec2  vUv;
void main() {
    vLayer = tintLayer();
    vUv    = tileUV();
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Geometry without a `tint` attribute (mobs) reads no layer here (MeshFormat.js), so it casts.
// Up to MAX_SKIP texture layers cast no shadow (water, ice); unused slots hold -1.
// A list of layer numbers rather than a flag per layer, so the texture array
// can grow per world (block JSON can add textures) without rebuilding this.
const MAX_SKIP = 8;
const DEPTH_FRAG = `
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uSkip[${MAX_SKIP}];
in float vLayer;
in vec2  vUv;
out vec4 fragColor;
void main() {
    if (vLayer >= 0.0) {
        float l = floor(vLayer + 0.5);
        for (int i = 0; i < ${MAX_SKIP}; i++) if (uSkip[i] == l) discard;
        if (texture(uTex, vec3(vUv, l)).a < 0.5) discard;
    }
    fragColor = vec4(1.0);
}
`;

// Only the depth is used; a one-byte red colour target keeps the colour
// attachment every render target has small (9 MB at 3072², not 36).
function depthTarget(size) {
    const t = new THREE.WebGLRenderTarget(size, size, {
        format: THREE.RedFormat,
        depthBuffer: true,
        depthTexture: new THREE.DepthTexture(size, size),
    });
    t.depthTexture.minFilter = THREE.NearestFilter;
    t.depthTexture.magFilter = THREE.NearestFilter;
    return t;
}

export class ShadowMapper {
    /** @param {THREE.WebGLRenderer} renderer */
    constructor(renderer) {
        this.renderer = renderer;
        this.level    = 'off';
        this.config   = null;
        this.terrain  = null;   // terrain depth, redrawn only when it changes
        this.target   = null;   // terrain + mobs, redrawn each frame there are mobs
        // (camera) => void, called with the aimed shadow camera just before the
        // terrain pass, to show only what it can see (world.js culls chunks).
        this.onCull   = null;

        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2 * LIGHT_BACK);

        // Direction toward the light and the light-space axes (see setLightDir).
        this.dir    = SUN_DIR.clone();
        this._right = new THREE.Vector3();
        this._up    = new THREE.Vector3();
        this._want  = new THREE.Vector3();
        this._axes();
        this._bias  = new THREE.Matrix4().set(
            0.5, 0,   0,   0.5,
            0,   0.5, 0,   0.5,
            0,   0,   0.5, 0.5,
            0,   0,   0,   1);
        this._c = new THREE.Vector3();

        // What the terrain map was drawn for; a change redraws it. Terrain
        // changes (_stale) wait for TERRAIN_REDRAW_MIN after the last redraw.
        this._dirty   = true;
        this._stale   = false;
        this._drawnAt = -Infinity;
        this._drawn   = { x: NaN, y: NaN, d: NaN };
        this._frustum = new THREE.Frustum();
        this._frustumValid = false;
        this._m = new THREE.Matrix4();
        this.redraws = 0;   // terrain passes drawn so far (diagnostics)

        // Shared with the chunk materials (spread into chunkUniforms).
        this.uniforms = {
            uShadowMap:        { value: null },
            uShadowMatrix:     { value: new THREE.Matrix4() },
            uShadowOn:         { value: 0 },
            uShadowTexel:      { value: 1 / 1024 },
            uShadowWorldTexel: { value: 0.1 },
            uShadowPcf:        { value: 0 },
            uShadowFocus:      { value: new THREE.Vector2(0.5, 0.5) },   // the player, in map coordinates
            uShadowFade:       { value: 2 },                              // map units → fractions of the radius
            uSunDir:           { value: SUN_DIR.clone() },
        };

        this.depthMaterial = new THREE.ShaderMaterial({
            glslVersion:    THREE.GLSL3,
            vertexShader:   DEPTH_VERT,
            fragmentShader: DEPTH_FRAG,
            uniforms: {
                uTex:  { value: null },
                uSkip: { value: new Float32Array(MAX_SKIP).fill(-1) },
            },
            side: THREE.DoubleSide,
        });
    }

    _axes() {
        this._right.crossVectors(new THREE.Vector3(0, 1, 0), this.dir).normalize();
        this._up.crossVectors(this.dir, this._right).normalize();
    }

    /** Point the light at [x, y, z] (unit, toward the sun or moon). Stepped — see top. */
    setLightDir(d) {
        const w = this._want.set(d[0], Math.max(d[1], MIN_LIGHT_Y), d[2]).normalize();
        if (w.dot(this.dir) > LIGHT_STEP_COS) return;
        this.dir.copy(w);
        this._axes();
        this.uniforms.uSunDir.value.copy(w);
        this._dirty = true;
    }

    /** Block texture array + the texture layers that never cast (water, ice). */
    setTextures(texArray, skipLayers) {
        this.depthMaterial.uniforms.uTex.value = texArray;
        const skip = this.depthMaterial.uniforms.uSkip.value;
        skip.fill(-1);
        let n = 0;
        for (const l of skipLayers) if (l >= 0 && n < MAX_SKIP) skip[n++] = l;
        this._dirty = true;
    }

    /**
     * Terrain changed inside `box` (a THREE.Box3 in world space): redraw the
     * terrain map if the shadow box reaches it — soon, or with `urgent` (an
     * edit next to the player) on the next frame. No box: redraw regardless
     * (a new world).
     */
    invalidate(box = null, urgent = false) {
        if (!box) { this._dirty = true; return; }
        if (this._dirty || (this._stale && !urgent)) return;
        if (!this._frustumValid || this._frustum.intersectsBox(box)) {
            if (urgent) this._dirty = true; else this._stale = true;
        }
    }

    setLevel(level) {
        const config = SHADOW_LEVELS[level] ?? null;
        this.level  = config ? level : 'off';
        this.config = config;
        if (this.terrain && (!config || this.terrain.width !== config.size)) {
            this.terrain.dispose();
            this.target?.dispose();
            this.terrain = this.target = null;
        }
        if (config && !this.terrain) this.terrain = depthTarget(config.size);
        this._dirty = true;

        const u = this.uniforms;
        u.uShadowOn.value  = config ? 1 : 0;
        u.uShadowMap.value = this.terrain?.depthTexture ?? null;
        if (config) {
            const { half } = this._box();
            u.uShadowTexel.value      = 1 / config.size;
            u.uShadowWorldTexel.value = (2 * half) / config.size;
            u.uShadowPcf.value        = config.pcf;
            u.uShadowFade.value       = (2 * half) / config.radius;
        }
    }

    get enabled() { return !!this.config; }

    /** Box geometry for the current level: half-width, texel and step, in blocks. */
    _box() {
        const { size, radius } = this.config;
        // Half a step wider than the radius, so wherever the player is inside
        // the step the full radius around them is covered.
        const approxStep = radius / BOX_STEPS;
        const half  = radius + approxStep / 2;
        const texel = (2 * half) / size;
        const step  = Math.max(1, Math.round(approxStep / texel)) * texel;
        return { half, texel, step };
    }

    /**
     * Update the shadow map for a player at `center` (world position). Call once
     * per frame. `dynamic`: there are mobs, which are redrawn every frame.
     */
    update(scene, center, dynamic = false) {
        if (!this.config || !this.depthMaterial.uniforms.uTex.value) return;
        const { half, step } = this._box();

        // The box centre, in light space, snapped to whole steps — which are
        // whole texels, so shadow edges do not crawl either.
        const px = center.dot(this._right), py = center.dot(this._up), pd = center.dot(this.dir);
        const x = Math.round(px / step) * step;
        const y = Math.round(py / step) * step;
        const d = Math.round(pd / step) * step;
        const drawn = this._drawn;
        if (x !== drawn.x || y !== drawn.y || d !== drawn.d) this._dirty = true;
        const now = performance.now() / 1000;
        if (this._stale && now - this._drawnAt >= TERRAIN_REDRAW_MIN) this._dirty = true;

        // Where the player is in the map, for the fade at the edge of the shadows.
        this.uniforms.uShadowFocus.value.set(0.5 + (px - x) / (2 * half), 0.5 + (py - y) / (2 * half));

        const r = this.renderer;
        const prevTarget = r.getRenderTarget();
        const prevBg = scene.background, prevFog = scene.fog, prevOverride = scene.overrideMaterial;
        const prevAutoClear = r.autoClear;
        scene.background = null;
        scene.fog = null;
        scene.overrideMaterial = this.depthMaterial;
        const cam = this.camera;

        if (this._dirty) {
            this._dirty = false;
            this._stale = false;
            this._drawnAt = now;
            this.redraws++;
            drawn.x = x; drawn.y = y; drawn.d = d;
            const c = this._c.copy(this._right).multiplyScalar(x)
                .addScaledVector(this._up, y).addScaledVector(this.dir, d);
            cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
            cam.near = 1; cam.far = 2 * LIGHT_BACK;
            cam.position.copy(c).addScaledVector(this.dir, LIGHT_BACK);
            cam.up.copy(this._up);
            cam.lookAt(c);
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld();

            this._m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            this._frustum.setFromProjectionMatrix(this._m, cam.coordinateSystem, cam.reversedDepth);
            this._frustumValid = true;
            this.uniforms.uShadowMatrix.value.copy(this._bias).multiply(this._m);

            this.onCull?.(cam);
            cam.layers.set(SHADOW_LAYER);
            r.setRenderTarget(this.terrain);
            r.clear();
            r.render(scene, cam);
        }

        if (dynamic) {
            this.target ??= depthTarget(this.config.size);
            // Make sure both targets exist on the GPU before copying between them.
            r.setRenderTarget(this.target);
            r.copyTextureToTexture(this.terrain.depthTexture, this.target.depthTexture);
            r.setRenderTarget(this.target);
            r.autoClear = false;
            cam.layers.set(SHADOW_DYNAMIC_LAYER);
            r.render(scene, cam);
            this.uniforms.uShadowMap.value = this.target.depthTexture;
        } else {
            this.uniforms.uShadowMap.value = this.terrain.depthTexture;
        }

        r.autoClear = prevAutoClear;
        r.setRenderTarget(prevTarget);
        scene.overrideMaterial = prevOverride;
        scene.background = prevBg;
        scene.fog = prevFog;
    }

    dispose() {
        this.terrain?.dispose();
        this.target?.dispose();
        this.terrain = this.target = null;
        this.depthMaterial.dispose();
    }
}

/**
 * GLSL for the chunk shaders: sunShadow() returns how lit this fragment is by
 * the current light, 0 (in shadow) … 1. Needs `in vec3 vWorldPos` and the
 * uniforms above. uSunDir is the current light direction (sun or moon).
 */
export const SHADOW_GLSL = `
uniform sampler2D uShadowMap;
uniform mat4  uShadowMatrix;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform float uShadowWorldTexel;
uniform int   uShadowPcf;
uniform vec2  uShadowFocus;
uniform float uShadowFade;
uniform vec3  uSunDir;

// n: the surface normal (surfaceNormal() in the chunk shader).
float sunShadow(vec3 n) {
    if (uShadowOn < 0.5) return 1.0;
    float facing = dot(n, uSunDir);
    // Faces turned away from the light get no direct light to lose.
    if (facing <= 0.0) return 1.0;
    // Normal offset keeps a surface from shadowing itself (acne).
    vec4 sp = uShadowMatrix * vec4(vWorldPos + n * uShadowWorldTexel * 1.5, 1.0);
    vec3 p = sp.xyz / sp.w;
    if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
    // Fade out toward the edge of the shadowed distance around the player
    // instead of stopping at a line; beyond it there is nothing to sample.
    vec2 e = abs(p.xy - uShadowFocus) * uShadowFade;
    float fade = smoothstep(0.8, 1.0, max(e.x, e.y));
    if (fade >= 1.0) return 1.0;
    float lit = 0.0, taps = 0.0;
    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            if (abs(i) > uShadowPcf || abs(j) > uShadowPcf) continue;
            float d = texture(uShadowMap, p.xy + vec2(float(i), float(j)) * uShadowTexel).r;
            lit += p.z - 0.0005 <= d ? 1.0 : 0.0;
            taps += 1.0;
        }
    }
    lit /= taps;
    return mix(lit, 1.0, fade);
}
`;
