/**
 * Tornado — the funnel and its debris cloud. A rare event from a supercell, or
 * the Tornado weather held from World Settings.
 *
 * The funnel is one open cylinder reshaped in the vertex shader: narrow at the
 * ground, flaring into the wall cloud at the cloud base, bent like a rope that
 * sways over time. Its surface is the cloud texture wound around it and
 * scrolled, so bands of condensation spiral up it; it is denser at its
 * silhouette, which is what makes a thin shell read as a volume. At the base a
 * ring of dust and debris orbits and rises (one instanced draw).
 *
 * Atmosphere moves it across the land and decides where it is; this only draws.
 */

import * as THREE from 'three';
import { ATMOS_GLSL } from './AtmosGLSL.js';

const DEBRIS = 1600;

const FUNNEL_VERT = ATMOS_GLSL + `
uniform vec3  uBaseP;
out vec2  vUv;
out float vH;
out vec3  vN;
out vec3  vW;
void main() {
    float h = position.y + 0.5;
    float height = uCloudBase - uBaseP.y;
    float r = mix(3.5, 46.0, pow(h, 2.4)) * (1.0 + 0.08 * sin(h * 11.0 - uTime * 2.5));
    vec2 bend = vec2(sin(h * 2.6 + uTime * 0.4), cos(h * 2.1 + uTime * 0.33)) * (1.0 - h) * h * 24.0;
    vec3 p = vec3(uBaseP.x + bend.x + position.x * r, uBaseP.y + h * height, uBaseP.z + bend.y + position.z * r);
    vUv = uv; vH = h; vW = p;
    vN = normalize(vec3(position.x, 0.0, position.z));
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FUNNEL_FRAG = ATMOS_GLSL + `
uniform float uAlpha;
uniform vec3  uLight;
in vec2  vUv;
in float vH;
in vec3  vN;
in vec3  vW;
out vec4 fragColor;
void main() {
    // x wraps once around the funnel: keep texture periods whole so there is no seam.
    vec2 q = vec2(vUv.x * 4.0 + uTime * 0.35 + vH * 1.5, vH * 3.0 - uTime * 0.12);
    float n = texture(uCloudMap, q * 0.5).r * 0.6 + texture(uCloudMap, vec2(q.x * 2.0, q.y * 1.7)).r * 0.4;
    vec3 v = normalize(cameraPosition - vW);
    float rim = 1.0 - abs(dot(vN, v));
    float a = smoothstep(0.28, 0.66, n) * (0.35 + 0.65 * rim);
    a *= smoothstep(0.0, 0.03, vH) * (1.0 - smoothstep(0.82, 1.0, vH)) * uAlpha;
    if (a < 0.01) discard;
    vec3 col = mix(vec3(0.40, 0.34, 0.28), vec3(0.34, 0.35, 0.38), smoothstep(0.0, 0.25, vH)) * uLight;
    col *= 0.8 + 0.3 * n;
    float f = weatherFog(cameraPosition, vW - cameraPosition);
    fragColor = vec4(mix(col, fogColorFor(-v), f), a * (1.0 - f * 0.8));
}
`;

const DEBRIS_VERT = ATMOS_GLSL + `
in vec4 aSeed;
uniform vec3  uBaseP;
out vec2  vUv;
out float vA;
void main() {
    float rr = aSeed.y;
    float radius = 3.0 + rr * 20.0;
    float th = aSeed.x * 6.2832 + uTime * (3.0 / (0.4 + rr));
    float rise = fract(aSeed.z + uTime * 0.28 * (0.5 + aSeed.w));
    vec3 p = uBaseP + vec3(cos(th) * radius, rise * (5.0 + (1.0 - rr) * 30.0), sin(th) * radius);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * (0.25 + 0.45 * aSeed.w);
    vUv = uv;
    vA = (1.0 - rise) * smoothstep(0.0, 0.08, rise);
    gl_Position = projectionMatrix * mv;
}
`;

const DEBRIS_FRAG = `
uniform float uAlpha;
uniform vec3  uLight;
in vec2  vUv;
in float vA;
out vec4 fragColor;
void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float a = (1.0 - smoothstep(0.4, 1.0, length(c))) * vA * uAlpha * 0.8;
    if (a < 0.01) discard;
    fragColor = vec4(vec3(0.36, 0.30, 0.24) * uLight, a);
}
`;

export class Tornado {
    constructor(scene, atmos) {
        this.scene = scene;
        this.base = new THREE.Vector3();
        this.uniforms = {
            ...atmos,
            uBaseP: { value: this.base },
            uAlpha: { value: 0 },
            uLight: { value: new THREE.Vector3(1, 1, 1) },
        };
        this.funnel = new THREE.Mesh(
            new THREE.CylinderGeometry(1, 1, 1, 40, 36, true),
            new THREE.ShaderMaterial({
                glslVersion: THREE.GLSL3, vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG,
                uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
            }));

        const quad = new THREE.PlaneGeometry(1, 1);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        geo.setAttribute('uv', quad.getAttribute('uv'));
        const seeds = new Float32Array(DEBRIS * 4);
        for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
        geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
        geo.instanceCount = DEBRIS;
        this.debris = new THREE.Mesh(geo, new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: DEBRIS_VERT, fragmentShader: DEBRIS_FRAG,
            uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        }));

        for (const m of [this.funnel, this.debris]) {
            m.frustumCulled = false;
            m.renderOrder = 11;
            m.visible = false;
            scene.add(m);
        }
    }

    /** Draw at ground position (x, y, z) with opacity `alpha`, lit by `light` (RGB). */
    update(x, y, z, alpha, light, debrisScale = 1) {
        const on = alpha > 0.005;
        this.funnel.visible = on;
        this.debris.visible = on && debrisScale > 0;
        if (!on) return;
        this.base.set(x, y, z);
        this.uniforms.uAlpha.value = alpha;
        this.uniforms.uLight.value.set(light[0], light[1], light[2]);
        this.debris.geometry.instanceCount = Math.round(DEBRIS * Math.max(0.2, debrisScale));
    }

    dispose() {
        for (const m of [this.funnel, this.debris]) {
            this.scene.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        }
    }
}
