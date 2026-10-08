/**
 * Clouds — the cloud layer (Graphics → Clouds). Driven by the weather: how
 * much of the sky is cloud, how thick and dark, and how fast it moves all come
 * from the shared cloud field (engine/CloudField.js via AtmosGLSL), the same one
 * rain and cloud shadows read. There is no "off": Fully Clear weather is how the
 * sky gets rid of them.
 *
 * The clouds are a slab of air from CLOUD_BASE to CLOUD_TOP with cloud in it:
 * flat bottoms, domed tops that rise with thickness. Each frame they are drawn
 * once, off screen, by following every line of sight through the slab:
 *
 *   fast  — 6 steps, shaded by thickness alone: thin edges bright, thick cores
 *           dark, thin edges glowing when backlit
 *   fancy — 14 steps, with the light falling off through the cloud above each
 *           point (bright tops, grey undersides) and forward scattering around
 *           the sun
 *
 * That picture (uCloudRT) is at half resolution — a soft cloud looks the same
 * from a quarter of the pixels, and the march was the most expensive thing on
 * screen — and it holds premultiplied colour, so upsampling does not darken
 * cloud edges. It is the cloud along the *whole* of each line of sight, from
 * wherever the camera is: below the layer, above it, or in it. Two things draw
 * from it:
 *
 *   • the backdrop, one full-screen triangle at the far plane, puts it on the
 *     sky — wherever no terrain was drawn;
 *   • every terrain surface (the chunk shaders, far terrain) takes the share of
 *     it that lies between the camera and itself (cloudVeil, AtmosGLSL.js).
 *
 * So nothing is a sheet at a fixed height any more. It used to be: one plane at
 * the layer's base or top, whichever side of its middle the camera was on,
 * drawn after everything else. Inside the layer that plane was on one side of
 * you and flipped to the other half way up, and it was painted over every piece
 * of water or ice whether or not the cloud was in front of it.
 *
 * Lightning lights the cloud around a strike from inside. Weather fog and haze
 * swallow distant clouds like everything else.
 */

import * as THREE from 'three';
import { ATMOS_GLSL } from './AtmosGLSL.js';
import { CLOUD_TEX } from './engine/CloudField.js';

export const CLOUD_LEVELS = ['fast', 'fancy'];
const STEPS = { fast: 6, fancy: 14 };
const MAX_STEPS = 14;

// One triangle over the whole screen, and the direction each pixel looks in.
const MARCH_VERT = `
uniform mat4 uProjInv;
out vec3 vRay;
void main() {
    gl_Position = vec4(position.xy, 1.0, 1.0);
    vec4 v = uProjInv * vec4(position.xy, 1.0, 1.0);
    vRay = transpose(mat3(viewMatrix)) * (v.xyz / v.w);
}
`;

const MARCH_FRAG = ATMOS_GLSL + `
uniform float uCloudFade;     // clouds fade out this far away, measured along the ground
uniform int   uFancy;
uniform int   uSteps;
uniform vec3  uCloudLit;      // sunlit cloud colour
uniform vec3  uCloudShade;    // shadowed underside colour
uniform float uCloudDark;     // 0 fair-weather … 1 storm
uniform vec3  uSilver;        // light scattered forward around the sun
uniform vec3  uFlashPos;
uniform float uFlashAmt;
in vec3 vRay;
out vec4 fragColor;

float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

vec3 flashGlow(vec3 p) {
    vec2 d = p.xz - uFlashPos.xz;
    return vec3(0.75, 0.8, 1.0) * uFlashAmt * exp(-dot(d, d) / 30000.0);
}

void main() {
    fragColor = vec4(0.0);
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vRay);
    vec2 span = cloudSpan(ro, rd);
    float len = span.y - span.x;
    if (len <= 0.0) return;

    float height = uCloudTop - uCloudBase;
    float mu = max(dot(rd, uSkySunDir), 0.0);
    float scatter = pow(mu, uFancy == 1 ? 8.0 : 6.0);
    float jitter = hash12(gl_FragCoord.xy);      // dithered steps hide banding
    // From inside the layer the cloud begins at the camera, and what is near
    // matters most: the steps start short and lengthen. The change-over is
    // gradual, so flying into the layer shifts nothing.
    float bend = mix(2.0, 1.0, clamp(span.x / 48.0, 0.0, 1.0));
    float n = float(uSteps);
    float T = 1.0, tSum = 0.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${MAX_STEPS}; i++) {
        if (i >= uSteps) break;
        float a0 = pow(float(i) / n, bend), a1 = pow(float(i + 1) / n, bend);
        float dt = (a1 - a0) * len;
        float t = span.x + (a0 + (a1 - a0) * jitter) * len;
        vec3 p = ro + rd * t;
        float fade = 1.0 - smoothstep(uCloudFade * 0.55, uCloudFade, length(p.xz - ro.xz));
        if (fade <= 0.0) break;
        float nz = cloudNoise(p.xz);
        float c = cloudCover(nz);
        if (c < 0.01) continue;
        float th = cloudThick(nz);
        float hgt = (p.y - uCloudBase) / height;
        float top = 0.22 + 0.78 * th;
        float bot = 0.06 * (1.0 - th);
        float dens = c * fade * smoothstep(bot, bot + 0.1, hgt) * (1.0 - smoothstep(top - 0.3, top, hgt));
        if (dens <= 0.0) continue;
        vec3 lc;
        if (uFancy == 1) {
            // Light reaching p has come down through the cloud above it.
            float light = exp(-max(top - hgt, 0.0) * height * (0.05 + 0.05 * uCloudDark));
            lc = mix(uCloudShade, uCloudLit, light) + uSilver * scatter * light * 0.8;
        } else {
            lc = mix(uCloudLit, uCloudShade, clamp(th * (0.45 + 0.55 * uCloudDark), 0.0, 1.0))
               + uSilver * scatter * (1.0 - th) * 1.4;
        }
        lc += flashGlow(p);
        float a = 1.0 - exp(-dens * dt * (0.09 + 0.06 * uCloudDark));
        acc += T * a * lc;
        tSum += T * a * t;
        T *= 1.0 - a;
        if (T < 0.02) break;
    }
    float alpha = 1.0 - T;
    if (alpha < 0.004) return;
    vec3 col = acc / alpha;

    // Rain and snow haze hang below the cloud, not all the way up to it, so
    // only part of the path to the cloud counts: dark cloud stays visible
    // overhead in the rain while the horizon is swallowed.
    float fogA = weatherFogHaze(ro, rd * (tSum / alpha), 70.0);
    col = mix(col, fogColorFor(rd), fogA);
    float a = alpha * (1.0 - fogA * 0.6);
    fragColor = vec4(col * a, a);      // premultiplied, so upsampling does not fringe
}
`;

// The backdrop: the picture on the sky. It is drawn at the far plane and depth
// tested, so it lands only where no terrain was drawn — terrain shows its own
// share of the cloud (cloudVeil). The picture holds premultiplied display
// values: un-premultiply to convert for a linear target (Eye Adaptation), then
// premultiply again.
const BACKDROP_VERT = `
void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }
`;
const BACKDROP_FRAG = `
uniform sampler2D uCloudRT;
uniform vec2 uCloudPx;
uniform bool uLinearOut;
out vec4 fragColor;
void main() {
    fragColor = texture(uCloudRT, gl_FragCoord.xy * uCloudPx);
    if (fragColor.a < 0.002) discard;
    if (uLinearOut) fragColor.rgb = sRGBTransferEOTF(vec4(fragColor.rgb / fragColor.a, 1.0)).rgb * fragColor.a;
}
`;

function screenTriangle() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return g;
}

export class Clouds {
    /**
     * @param {THREE.Scene} scene
     * @param {object} atmos      makeAtmosUniforms() — shared, spread in
     * @param {CloudField} field  its bytes become the cloud texture
     */
    constructor(scene, atmos, field) {
        this.scene = scene;
        this.atmos = atmos;
        this.level = 'fast';

        this.texture = new THREE.DataTexture(field.data, CLOUD_TEX, CLOUD_TEX, THREE.RedFormat, THREE.UnsignedByteType);
        this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
        this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
        this.texture.generateMipmaps = false;
        this.texture.unpackAlignment = 1;
        this.texture.needsUpdate = true;
        atmos.uCloudMap.value = this.texture;

        this.uniforms = {
            ...atmos,
            uProjInv:    { value: new THREE.Matrix4() },
            uCloudFade:  { value: 256 },
            uFancy:      { value: 0 },
            uSteps:      { value: STEPS.fast },
            uCloudLit:   { value: new THREE.Vector3(1, 1, 1) },
            uCloudShade: { value: new THREE.Vector3(0.7, 0.72, 0.76) },
            uCloudDark:  { value: 0 },
            uSilver:     { value: new THREE.Vector3() },
            uFlashPos:   { value: new THREE.Vector3() },
            uFlashAmt:   { value: 0 },
        };
        // The march reads the cloud map, never the picture it is drawing.
        delete this.uniforms.uCloudRT;
        const geometry = screenTriangle();
        this._marchMaterial = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: MARCH_VERT,
            fragmentShader: MARCH_FRAG,
            uniforms: this.uniforms,
            depthTest: false,
            depthWrite: false,
            blending: THREE.NoBlending,
        });
        this._marchScene = new THREE.Scene();
        this._marchMesh = new THREE.Mesh(geometry, this._marchMaterial);
        this._marchMesh.frustumCulled = false;
        this._marchScene.add(this._marchMesh);

        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: BACKDROP_VERT,
            fragmentShader: BACKDROP_FRAG,
            uniforms: { uCloudRT: atmos.uCloudRT, uCloudPx: atmos.uCloudPx, uLinearOut: atmos.uLinearOut },
            transparent: true,
            premultipliedAlpha: true,
            depthWrite: false,
        });
        this.mesh = new THREE.Mesh(geometry, this.material);
        // First of the blended things (after the chunk primer, which is at
        // -1e9): water and everything else transparent is drawn over it.
        this.mesh.renderOrder = -1e8;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);

        this._target = null;
        this._size = new THREE.Vector2();
        this._clear = new THREE.Color();
    }

    /** 'fast' | 'fancy'. Settings saved when clouds could be 'off' read as fast. */
    setLevel(level) {
        this.level = CLOUD_LEVELS.includes(level) ? level : 'fast';
        this.uniforms.uFancy.value = this.level === 'fancy' ? 1 : 0;
        this.uniforms.uSteps.value = STEPS[this.level];
    }

    /** Once a frame. `fade` is the distance the clouds fade out at. */
    update(cameraPos, fade) {
        // Threshold 2 means the weather has no cloud at all — nothing to draw.
        this.mesh.visible = this.atmos.uCloudThresh.value < 1.5;
        this.uniforms.uCloudFade.value = fade;
        if (!this.mesh.visible) this.atmos.uCloudOn.value = 0;
    }

    /**
     * Draw this frame's clouds, off screen, for the backdrop and the terrain
     * to show. Call each frame after update(), before rendering the scene.
     */
    prerender(renderer, camera) {
        if (!this.mesh.visible) return;
        this._fitTarget(renderer);
        this.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
        const prevTarget = renderer.getRenderTarget();
        const prevAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this._clear);
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(this._target);
        renderer.render(this._marchScene, camera);
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(this._clear, prevAlpha);
        this.atmos.uCloudOn.value = 1;
    }

    /** The half-resolution target, (re)sized to the drawing buffer. */
    _fitTarget(renderer) {
        const full = renderer.getDrawingBufferSize(this._size);
        const w = Math.max(1, Math.ceil(full.x / 2)), h = Math.max(1, Math.ceil(full.y / 2));
        if (!this._target) {
            // Half float keeps dim night cloud from banding once premultiplied.
            const half = renderer.extensions.has('EXT_color_buffer_float') ||
                         renderer.extensions.has('EXT_color_buffer_half_float');
            this._target = new THREE.WebGLRenderTarget(w, h, {
                type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
                depthBuffer: false,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                generateMipmaps: false,
            });
            this.atmos.uCloudRT.value = this._target.texture;
        } else if (this._target.width !== w || this._target.height !== h) {
            this._target.setSize(w, h);
        }
        this.atmos.uCloudPx.value.set(1 / full.x, 1 / full.y);
    }

    /**
     * Draw the march once now (world.js _warmShaders), so its shader is ready
     * before the first cloudy frame. It draws into its own target, so it is
     * not covered by the scene's warm-up render. The backdrop is.
     */
    warm(renderer, camera) {
        this._fitTarget(renderer);
        this.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(this._target);
        renderer.render(this._marchScene, camera);
        renderer.setRenderTarget(prev);
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this._marchMaterial.dispose();
        this._target?.dispose();
        this.atmos.uCloudRT.value = null;
        this.atmos.uCloudOn.value = 0;
        this.texture.dispose();
    }
}
