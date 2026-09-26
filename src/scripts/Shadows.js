/**
 * Shadows — sun shadow mapping for the chunk shaders (Graphics → Shadows).
 *
 * The chunk materials are custom ShaderMaterials, so Three.js's built-in shadow
 * system does not apply to them. Instead this renders a depth map of the scene
 * from the sun each frame (an orthographic box centred on the player) and the
 * chunk fragment shader samples it — see sunShadow() in world.js.
 *
 * What casts: every object with render layer SHADOW_LAYER enabled — chunk
 * meshes and mobs. Water and ice are skipped in the depth shader, and textured
 * surfaces are alpha-tested, so trees cast dappled shadows through their leaves.
 *
 * The light is the sun by day and the moon by night (DayCycle.lightDir, set
 * through setLightDir). It moves in steps of about a third of a degree rather
 * than every frame: re-aiming the shadow camera re-rasterises every shadow
 * edge, and continuous re-aiming makes them shimmer. sunShadow() returns how
 * lit a fragment is (0 in shadow … 1 lit); the chunk shader turns that into
 * light, keeping only the ambient part where it is shadowed.
 */

import * as THREE from 'three';
import { SUN_DIR as SUN } from './engine/Sun.js';

// Render layer that marks shadow casters.
export const SHADOW_LAYER = 1;

// Direction toward the sun the meshers bake face shading for (engine/Sun.js).
export const SUN_DIR = new THREE.Vector3(...SUN);

// Re-aim the shadow camera once the light has moved this far (cosine of ~0.35°).
const LIGHT_STEP_COS = Math.cos(0.35 * Math.PI / 180);
// A shadow camera at a grazing angle smears shadows for hundreds of blocks; the
// light is nearly gone by then anyway, so the aim never drops below this.
const MIN_LIGHT_Y = 0.12;

// size: shadow map resolution. radius: half-width of the shadowed area around
// the player, in blocks. pcf: soft-edge kernel radius (0 = one hard tap, 1 = 3×3).
export const SHADOW_LEVELS = {
    off:    null,
    low:    { size: 1024, radius: 40, pcf: 0 },
    medium: { size: 2048, radius: 64, pcf: 1 },
    high:   { size: 3072, radius: 96, pcf: 1 },
};

const DEPTH_VERT = `
in float layer;
out float vLayer;
out vec2  vUv;
void main() {
    vLayer = layer;
    vUv    = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Geometry without a `layer` attribute (mobs) reads 0 here: an opaque layer, so it casts.
const depthFrag = (layers) => `
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uSkip[${layers}];
in float vLayer;
in vec2  vUv;
out vec4 fragColor;
void main() {
    if (vLayer >= 0.0) {
        int l = int(floor(vLayer + 0.5));
        if (uSkip[l] > 0.5) discard;
        if (texture(uTex, vec3(fract(vUv), float(l))).a < 0.5) discard;
    }
    fragColor = vec4(1.0);
}
`;

export class ShadowMapper {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {number} layerCount  texture layers in the block texture array
     */
    constructor(renderer, layerCount) {
        this.renderer = renderer;
        this.level    = 'off';
        this.config   = null;
        this.target   = null;

        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 500);
        this.camera.layers.set(SHADOW_LAYER);

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

        // Shared with the chunk materials (spread into chunkUniforms).
        this.uniforms = {
            uShadowMap:        { value: null },
            uShadowMatrix:     { value: new THREE.Matrix4() },
            uShadowOn:         { value: 0 },
            uShadowTexel:      { value: 1 / 1024 },
            uShadowWorldTexel: { value: 0.1 },
            uShadowPcf:        { value: 0 },
            uSunDir:           { value: SUN_DIR.clone() },
        };

        this.depthMaterial = new THREE.ShaderMaterial({
            glslVersion:    THREE.GLSL3,
            vertexShader:   DEPTH_VERT,
            fragmentShader: depthFrag(layerCount),
            uniforms: {
                uTex:  { value: null },
                uSkip: { value: new Float32Array(layerCount) },
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
    }

    /** Block texture array + the texture layers that never cast (water, ice). */
    setTextures(texArray, skipLayers) {
        this.depthMaterial.uniforms.uTex.value = texArray;
        const skip = this.depthMaterial.uniforms.uSkip.value;
        skip.fill(0);
        for (const l of skipLayers) if (l >= 0 && l < skip.length) skip[l] = 1;
    }

    setLevel(level) {
        const config = SHADOW_LEVELS[level] ?? null;
        this.level  = config ? level : 'off';
        this.config = config;
        if (this.target && (!config || this.target.width !== config.size)) {
            this.target.dispose();
            this.target = null;
        }
        if (config && !this.target) {
            // Only the depth is used; a one-byte red colour target keeps the
            // unavoidable colour attachment small (9 MB at 3072², not 36).
            this.target = new THREE.WebGLRenderTarget(config.size, config.size, {
                format: THREE.RedFormat,
                depthBuffer: true,
                depthTexture: new THREE.DepthTexture(config.size, config.size),
            });
            this.target.depthTexture.minFilter = THREE.NearestFilter;
            this.target.depthTexture.magFilter = THREE.NearestFilter;
        }
        const u = this.uniforms;
        u.uShadowOn.value  = config ? 1 : 0;
        u.uShadowMap.value = this.target?.depthTexture ?? null;
        if (config) {
            u.uShadowTexel.value      = 1 / config.size;
            u.uShadowWorldTexel.value = (2 * config.radius) / config.size;
            u.uShadowPcf.value        = config.pcf;
        }
    }

    get enabled() { return !!this.config; }

    /** Render the depth map around `center` (world position). Call once per frame. */
    update(scene, center) {
        if (!this.config || !this.depthMaterial.uniforms.uTex.value) return;
        const { size, radius } = this.config;

        // Snap the box to whole shadow-map texels in light space, so the shadow
        // edges do not crawl as the player moves.
        const texel = (2 * radius) / size;
        const x = Math.round(center.dot(this._right) / texel) * texel;
        const y = Math.round(center.dot(this._up)    / texel) * texel;
        const d = center.dot(this.dir);
        const c = this._c.copy(this._right).multiplyScalar(x)
            .addScaledVector(this._up, y).addScaledVector(this.dir, d);

        const cam = this.camera;
        cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
        cam.near = 1; cam.far = 500;
        cam.position.copy(c).addScaledVector(this.dir, 250);
        cam.up.copy(this._up);
        cam.lookAt(c);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();

        this.uniforms.uShadowMatrix.value
            .copy(this._bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

        const r = this.renderer;
        const prevTarget = r.getRenderTarget();
        const prevBg = scene.background, prevFog = scene.fog, prevOverride = scene.overrideMaterial;
        scene.background = null;
        scene.fog = null;
        scene.overrideMaterial = this.depthMaterial;
        r.setRenderTarget(this.target);
        r.clear();
        r.render(scene, cam);
        r.setRenderTarget(prevTarget);
        scene.overrideMaterial = prevOverride;
        scene.background = prevBg;
        scene.fog = prevFog;
    }

    dispose() {
        this.target?.dispose();
        this.target = null;
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
    // Fade out toward the edge of the shadowed area instead of stopping at a line.
    vec2 e = abs(p.xy - 0.5) * 2.0;
    return mix(lit, 1.0, smoothstep(0.8, 1.0, max(e.x, e.y)));
}
`;
