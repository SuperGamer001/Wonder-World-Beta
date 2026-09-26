/**
 * Clouds — the cloud layer (Graphics → Clouds). Driven by the weather: how
 * much of the sky is cloud, how thick and dark, and how fast it moves all come
 * from the shared cloud field (engine/CloudField.js via AtmosGLSL), the same one
 * rain and cloud shadows read. There is no "off": Fully Clear weather is how the
 * sky gets rid of them.
 *
 *   fast  — one soft layer at the cloud base, shaded by thickness: thin edges
 *           bright, thick cores dark, thin edges glowing when backlit
 *   fancy — a volumetric slab from CLOUD_BASE to CLOUD_TOP, ray-marched in 14
 *           steps: flat bottoms, domed tops that rise with thickness, light
 *           falling off with the cloud above each point (bright tops, grey
 *           undersides) and forward scattering around the sun
 *
 * Either way it is one camera-following plane and one draw call; with a clear
 * sky it is hidden entirely. Lightning lights the cloud around a strike from
 * inside. Weather fog and haze swallow distant clouds like everything else.
 */

import * as THREE from 'three';
import { ATMOS_GLSL, CLOUD_BASE, CLOUD_TOP } from './AtmosGLSL.js';
import { CLOUD_TEX } from './engine/CloudField.js';

export const CLOUD_LEVELS = ['fast', 'fancy'];

const VERT = `
out vec3 vWorld;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = ATMOS_GLSL + `
uniform float uFade;
uniform int   uFancy;
uniform vec3  uCloudLit;      // sunlit cloud colour
uniform vec3  uCloudShade;    // shadowed underside colour
uniform float uCloudDark;     // 0 fair-weather … 1 storm
uniform vec3  uSilver;        // light scattered forward around the sun
uniform vec3  uFlashPos;
uniform float uFlashAmt;
in vec3 vWorld;
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
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);
    float edge = 1.0 - smoothstep(uFade * 0.55, uFade, length(vWorld.xz - ro.xz));
    if (edge <= 0.01) discard;

    vec3 col;
    float alpha;
    float mu = max(dot(rd, uSkySunDir), 0.0);
    if (uFancy == 0) {
        float n = cloudNoise(vWorld.xz);
        float c = cloudCover(n);
        if (c < 0.01) discard;
        float th = cloudThick(n);
        col = mix(uCloudLit, uCloudShade, clamp(th * (0.45 + 0.55 * uCloudDark), 0.0, 1.0));
        col += uSilver * pow(mu, 6.0) * (1.0 - th) * 1.4;
        col += flashGlow(vWorld);
        alpha = c * (0.62 + 0.38 * th);
    } else {
        if (abs(rd.y) < 1e-4) discard;
        float span = uCloudTop - uCloudBase;
        float ta = (uCloudBase - ro.y) / rd.y, tb = (uCloudTop - ro.y) / rd.y;
        float t0 = max(min(ta, tb), 0.0);
        float t1 = min(max(ta, tb), t0 + 360.0);
        if (t1 <= t0) discard;
        const int STEPS = 14;
        float dt = (t1 - t0) / float(STEPS);
        float jitter = hash12(gl_FragCoord.xy);      // dithered start hides banding
        float scatter = pow(mu, 8.0);
        float T = 1.0;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < STEPS; i++) {
            vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
            float n = cloudNoise(p.xz);
            float c = cloudCover(n);
            if (c < 0.01) continue;
            float th = cloudThick(n);
            float hgt = (p.y - uCloudBase) / span;
            float top = 0.22 + 0.78 * th;
            float bot = 0.06 * (1.0 - th);
            float dens = c * smoothstep(bot, bot + 0.1, hgt) * (1.0 - smoothstep(top - 0.3, top, hgt));
            if (dens <= 0.0) continue;
            // Light reaching p has come down through the cloud above it.
            float light = exp(-max(top - hgt, 0.0) * span * (0.05 + 0.05 * uCloudDark));
            vec3 lc = mix(uCloudShade, uCloudLit, light) + uSilver * scatter * light * 0.8 + flashGlow(p);
            float a = 1.0 - exp(-dens * dt * (0.09 + 0.06 * uCloudDark));
            acc += T * a * lc;
            T *= 1.0 - a;
            if (T < 0.02) break;
        }
        alpha = 1.0 - T;
        if (alpha < 0.005) discard;
        col = acc / alpha;
    }

    // Rain and snow haze hang below the cloud, not all the way up to it, so
    // only part of the path to the cloud counts: dark cloud stays visible
    // overhead in the rain while the horizon is swallowed.
    float fogA = weatherFogHaze(ro, vWorld - ro, 70.0);
    col = mix(col, fogColorFor(rd), max(fogA, (1.0 - edge) * 0.5));
    fragColor = vec4(col, alpha * edge * (1.0 - fogA * 0.6));
}
`;

export class Clouds {
    /**
     * @param {THREE.Scene} scene
     * @param {object} atmos      makeAtmosUniforms() — shared, spread in
     * @param {CloudField} field  its bytes become the cloud texture
     */
    constructor(scene, atmos, field) {
        this.scene = scene;
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
            uFade:       { value: 256 },
            uFancy:      { value: 0 },
            uCloudLit:   { value: new THREE.Vector3(1, 1, 1) },
            uCloudShade: { value: new THREE.Vector3(0.7, 0.72, 0.76) },
            uCloudDark:  { value: 0 },
            uSilver:     { value: new THREE.Vector3() },
            uFlashPos:   { value: new THREE.Vector3() },
            uFlashAmt:   { value: 0 },
        };
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: this.uniforms,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.renderOrder = 10;        // after the terrain, so it blends over it
        this.mesh.frustumCulled = false;   // the plane follows the camera anyway
        scene.add(this.mesh);
    }

    /** 'fast' | 'fancy'. Settings saved when clouds could be 'off' read as fast. */
    setLevel(level) {
        this.level = CLOUD_LEVELS.includes(level) ? level : 'fast';
        this.uniforms.uFancy.value = this.level === 'fancy' ? 1 : 0;
    }

    /** Follow the camera. `fade` is the distance the clouds fade out at. */
    update(cameraPos, fade) {
        const u = this.uniforms;
        // Threshold 2 means the weather has no cloud at all — skip the draw.
        this.mesh.visible = u.uCloudThresh.value < 1.5;
        if (!this.mesh.visible) return;
        // Below the layer, draw at its base and look up into it; above, at its
        // top looking down. Inside it the weather fog does the work.
        const mid = (CLOUD_BASE + CLOUD_TOP) * 0.5;
        const y = cameraPos.y < mid ? CLOUD_BASE : CLOUD_TOP;
        const size = fade * 2.2;
        this.mesh.position.set(cameraPos.x, y, cameraPos.z);
        this.mesh.scale.set(size, size, 1);
        u.uFade.value = fade;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}
