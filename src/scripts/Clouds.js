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
 *   fast  — "Simple": 8 steps through the cloud field as it is, shaded by
 *           thickness alone: thin edges bright, thick cores dark, thin edges
 *           glowing when backlit
 *   fancy — "Detailed": 18 steps through heaps with a shape — the field read
 *           soft, domed, and eaten into by billows that change with height —
 *           lit from the side the sun is on as well as from above (bright
 *           sunward sides, grey hollows and undersides), with forward
 *           scattering around the sun
 *
 * Neither is grainy: where a pixel samples along its steps comes from a
 * pattern that neighbouring pixels share out evenly, and the backdrop reads
 * the picture through a small blur. (It was a random number a pixel, shown as
 * it fell: the sky looked like a noisy photograph.)
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
import { CLOUD_TEX, CLOUD_PERIOD_A, CLOUD_PERIOD_B, CLOUD_MIX_A, DETAIL_SHIFT, COVER_SOFT, THICK_GAIN } from './engine/CloudField.js';

export const CLOUD_LEVELS = ['fast', 'fancy'];
const STEPS = { fast: 8, fancy: 16 };
const MAX_STEPS = 18;

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

// Where along its step each pixel samples. Not a random number a pixel (that
// is grain, and at half resolution it is coarse grain: the clouds looked like
// a noisy photograph): a pattern in which any few neighbouring pixels between
// them cover the step evenly, so the backdrop's small blur takes it out.
float stepOffset(vec2 px) {
    return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

vec3 flashGlow(vec3 p) {
    vec2 d = p.xz - uFlashPos.xz;
    return vec3(0.75, 0.8, 1.0) * uFlashAmt * exp(-dot(d, d) / 30000.0);
}

// ── Fancy ────────────────────────────────────────────────────────────────────
// The cloud field read soft (the map's smaller levels): the same clouds in
// the same places as cloudNoise() — the ones that rain and cast the shadows —
// without the finest of its grain, which on a cloud's edge is a ragged line.
float softNoise(vec2 xz) {
    float a = textureLod(uCloudMap, (xz + uCloudOffA) * ${(1 / CLOUD_PERIOD_A).toFixed(8)}, 1.6).r;
    float b = textureLod(uCloudMap, (xz + uCloudOffB) * ${(1 / CLOUD_PERIOD_B).toFixed(8)} + vec2(${DETAIL_SHIFT[0].toFixed(4)}, ${DETAIL_SHIFT[1].toFixed(4)}), 3.4).r;
    return a * ${CLOUD_MIX_A.toFixed(4)} + b * ${(1 - CLOUD_MIX_A).toFixed(4)};
}

// How much cloud is at p, and (top) how high the cloud over p's column stands,
// as a share of the layer. A cloud is a flat-bottomed heap: tall where the
// field is thick and rounded off toward its edges. With detail it billows:
// the map again, small, and slid sideways with height so that it differs from
// level to level, pushes the field about (so the outline of a heap is lobes,
// and a different outline higher up — its side is not a wall) and eats into
// it, most near its top, where a real one is wispy. Without, it is the plain
// heap: enough to ask how much cloud the light has come through.
float fancyDensity(vec3 p, float height, bool detail, out float top) {
    top = 0.0;
    float nz = softNoise(p.xz);
    // Nowhere near a cloud: most of the sky, most of the time.
    if (nz < uCloudThresh - 0.11) return 0.0;
    float eat = 0.0;
    if (detail) {
        vec2 q = (p.xz + uCloudOffB) * ${(1 / 170).toFixed(6)} + p.y * vec2(0.0113, 0.0071);
        vec2 w = vec2(textureLod(uCloudMap, q, 1.0).r, textureLod(uCloudMap, q + vec2(0.37, 0.59), 1.0).r);
        nz = softNoise(p.xz + (w - 0.5) * 70.0);
        eat = 1.0 - smoothstep(0.3, 0.7, textureLod(uCloudMap, q * 2.9 + 0.31, 0.0).r * 0.5 + w.y * 0.5);
    }
    float c = smoothstep(uCloudThresh - 0.03, uCloudThresh + ${(COVER_SOFT * 1.4).toFixed(4)}, nz);
    if (c < 0.004) return 0.0;
    float th = clamp((nz - uCloudThresh + 0.02) * ${THICK_GAIN.toFixed(3)}, 0.0, 1.0);
    float hgt = (p.y - uCloudBase) / height;
    top = 0.16 + 0.84 * sqrt(th);                       // a dome: steep at the rim, level on top
    float bot = 0.05 * (1.0 - th);
    float d = c * smoothstep(bot, bot + 0.07, hgt) * smoothstep(0.0, 0.04 + 0.3 * top, top - hgt);
    if (d <= 0.0 || !detail) return d;
    float e = eat * (0.14 + 0.6 * hgt / max(top, 0.2)) * (1.0 - 0.45 * uCloudDark);
    return clamp((d - e) / (1.0 - e), 0.0, 1.0);
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
    float jitter = stepOffset(gl_FragCoord.xy);
    // What lights the cloud: the sun, or by night the moon.
    vec3 L = uSkySunDir.y > -0.05 ? uSkySunDir : uMoonDir;
    L = normalize(vec3(L.x, max(L.y, 0.12), L.z));
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
        float dens;
        vec3 lc;
        if (uFancy == 1) {
            float top, topL;
            dens = fancyDensity(p, height, true, top) * fade;
            if (dens <= 0.0) continue;
            float hgt = (p.y - uCloudBase) / height;
            // The light has come down through the cloud above p, and in from
            // the side the sun is on: one look that way says how much cloud it
            // crossed. So the sunward side of a heap is bright and its far
            // side and its hollows are grey — which is what gives it a shape.
            float above = exp(-max(top - hgt, 0.0) * height * (0.016 + 0.05 * uCloudDark));
            float toward = fancyDensity(p + L * 30.0, height, false, topL);
            float light = above * mix(1.0, 0.45 - 0.15 * uCloudDark, toward);
            // Thin cloud at an edge lets more through than the middle of a heap.
            light = mix(light, 1.0, (1.0 - dens) * 0.22 * (1.0 - uCloudDark));
            vec3 under = uCloudShade * (0.86 + 0.14 * hgt);
            lc = mix(under, uCloudLit, light) + uSilver * scatter * light * (0.5 + 0.9 * (1.0 - dens));
        } else {
            float nz = cloudNoise(p.xz);
            float c = cloudCover(nz);
            if (c < 0.01) continue;
            float th = cloudThick(nz);
            float hgt = (p.y - uCloudBase) / height;
            float top = 0.22 + 0.78 * th;
            float bot = 0.06 * (1.0 - th);
            dens = c * fade * smoothstep(bot, bot + 0.1, hgt) * (1.0 - smoothstep(top - 0.3, top, hgt));
            if (dens <= 0.0) continue;
            lc = mix(uCloudLit, uCloudShade, clamp(th * (0.45 + 0.55 * uCloudDark), 0.0, 1.0))
               + uSilver * scatter * (1.0 - th) * 1.4;
        }
        lc += flashGlow(p);
        float a = 1.0 - exp(-dens * dt * (uFancy == 1 ? 0.3 + 0.1 * uCloudDark : 0.09 + 0.06 * uCloudDark));
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
    // Eight reads round the pixel, in two rings (the picture is at half
    // resolution, and each read is already the mean of four of its pixels):
    // together they even out the pattern the march sampled along its steps
    // with, which at a low angle — long steps — is otherwise a hatching.
    vec2 uv = gl_FragCoord.xy * uCloudPx, o = uCloudPx * 2.0, w = uCloudPx * 6.0;
    fragColor = 0.125 * (
        texture(uCloudRT, uv + vec2(o.x, o.y * 0.4)) + texture(uCloudRT, uv + vec2(-o.x * 0.4, o.y)) +
        texture(uCloudRT, uv - vec2(o.x, o.y * 0.4)) + texture(uCloudRT, uv - vec2(-o.x * 0.4, o.y)) +
        texture(uCloudRT, uv + vec2(w.x * 0.7, -w.y * 0.7)) + texture(uCloudRT, uv + vec2(w.x * 0.7, w.y * 0.7)) +
        texture(uCloudRT, uv - vec2(w.x * 0.7, -w.y * 0.7)) + texture(uCloudRT, uv - vec2(w.x * 0.7, w.y * 0.7)));
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
        // Smaller levels too: the fancy march reads the field soft (softNoise).
        // Everything else names level 0 (textureLod), which is the field itself.
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.texture.generateMipmaps = true;
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
    /** The march's shader made ready in the background (world load): warm() then has nothing to wait for. */
    compileAsync(renderer, camera) {
        this._fitTarget(renderer);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(this._target);
        const p = renderer.compileAsync(this._marchScene, camera);
        renderer.setRenderTarget(prev);
        return p;
    }

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
