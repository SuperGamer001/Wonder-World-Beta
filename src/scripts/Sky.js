/**
 * Sky — the sky dome, sun, moon and stars (Graphics → Sky).
 *
 *   simple — one flat sky colour that follows the time of day (the original
 *            look), a flat round sun with a faint glow, a flat round moon with
 *            its phase, round stars
 *   pretty — a zenith-to-horizon gradient, sunrise/sunset glow toward the sun,
 *            a round sun with a halo, a moon lit as a sphere (real phase
 *            terminator, darker maria, faint earthshine), twinkling stars that
 *            wheel across the sky with the time of day
 *
 * One camera-centred sphere, put at the far plane and drawn after the terrain,
 * so it is only worked out for the pixels no land covers. (It used to be drawn
 * first, without depth, over the whole screen: every pixel of terrain was
 * shaded as sky first — about a tenth of a frame on integrated graphics — and
 * then painted over.) Everything blended — clouds, water, rain — is drawn
 * after it, as before. Both modes are one shader (a uniform branch), so
 * switching is free. Colours come from DayCycle via Atmosphere.
 *
 * The horizon is always fogColorFor(dir) — exactly what the terrain fades into —
 * so distant land never shows a seam against the sky.
 */

import * as THREE from 'three';
import { ATMOS_GLSL, OUTPUT_GLSL } from './AtmosGLSL.js';
import { SUN_TILT } from './engine/DayCycle.js';

export const SKY_MODES = ['simple', 'pretty'];

const VERT = `
out vec3 vDir;
void main() {
    vDir = position;
    gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(position, 1.0));
    gl_Position.z = gl_Position.w;     // at the far plane: behind everything that was drawn
}
`;

const FRAG = ATMOS_GLSL + OUTPUT_GLSL + `
uniform int   uSkyMode;          // 0 simple, 1 pretty
uniform vec3  uZenith;
uniform vec3  uOvercast;         // colour of a fully overcast sky
uniform float uOvercastAmt;
uniform float uSkyLit;           // underground darkening
uniform vec3  uSunColor;
uniform float uSunVis;           // 0..1 — clouds, fog and dust hide the sun
uniform float uMoonPhase;        // π full … 0 new
uniform float uMoonVis;
uniform float uStars;
uniform mat3  uStarRot;
uniform vec3  uPathAxis;         // axis the sun and moon turn about
uniform vec3  uSkyFlash;         // lightning

in vec3 vDir;
out vec4 fragColor;

float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

// Weather fog of the sky itself: haze to the edge of the air, plus ground fog
// integrated up and out of the fog layer.
float skyFog(vec3 d) {
    float od = uHaze * 700.0;
    if (uFogDensity > 0.0) {
        float y0 = max(cameraPosition.y - uFogBase, -40.0);
        od += uFogDensity * uFogScale * exp(-y0 / uFogScale) / max(d.y, 0.015);
    }
    return 1.0 - exp(-od);
}

// Disc coordinates around direction c: x along the path axis, y across it.
vec2 discCoords(vec3 d, vec3 c) {
    vec3 up = cross(c, uPathAxis);
    return vec2(dot(d, uPathAxis), dot(d, up)) / max(dot(d, c), 1e-4);
}

void main() {
    vec3 d = normalize(vDir);
    // One pixel as an angle (radians): the width of the anti-aliased rim of the
    // sun and moon. Taken here, in uniform control flow, where derivatives are
    // defined.
    float px = max(length(fwidth(d)), 1e-5);
    float h = d.y;
    vec3 col = fogColorFor(d);
    if (uSkyMode == 1) {
        float t = pow(1.0 - clamp(h, 0.0, 1.0), 2.6);
        vec3 zen = mix(uZenith, uOvercast, uOvercastAmt) * uSkyLit;
        col = mix(zen, col, t);
    }

    float above = smoothstep(-0.03, 0.02, h);
    float fogA = skyFog(d);
    col = mix(col, fogColorFor(d), fogA);          // in fog the sky is the fog
    float clearSky = above * (1.0 - fogA);
    bool pretty = uSkyMode == 1;

    // Stars — fixed to the sky, which turns with the time of day.
    if (uStars > 0.002 && clearSky > 0.01) {
        vec3 p = (uStarRot * d) * 220.0;
        vec3 c = floor(p);
        float r = hash13(c);
        if (r > 0.9968) {
            vec3 sp = c + 0.5 + (vec3(hash13(c + 1.7), hash13(c + 3.1), hash13(c + 5.3)) - 0.5) * 0.6;
            float mag = (r - 0.9968) / 0.0032;
            float s = smoothstep(0.32, 0.0, length(p - sp));
            float tw = pretty ? 0.7 + 0.3 * sin(uTime * (1.5 + mag * 4.0) + r * 400.0) : 1.0;
            vec3 sc = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.9, 0.75), hash13(c + 9.0));
            col += sc * s * (0.35 + 0.65 * mag) * tw * uStars * clearSky;
        }
    }

    // Sun
    float mu = dot(d, uSkySunDir);
    if (mu > 0.0 && uSunVis > 0.001) {
        if (pretty) {
            float disc = smoothstep(0.99952, 0.99962, mu);
            float halo = pow(mu, 1400.0) * 0.8 + pow(mu, 90.0) * 0.18 + pow(mu, 12.0) * 0.05;
            col += uSunColor * (disc * 2.5 + halo) * uSunVis * clearSky;
        } else {
            // A flat disc (the same area the old square had) with a one-pixel
            // soft rim, and a faint glow so it does not look cut out.
            float r = length(discCoords(d, uSkySunDir));
            float disc = 1.0 - smoothstep(0.079 - px, 0.079 + px, r);
            col = mix(col, uSunColor * 1.15, disc * uSunVis * clearSky);
            col += uSunColor * (pow(mu, 220.0) * 0.25 * (1.0 - disc) * uSunVis * clearSky);
        }
    }

    // Moon — a sphere lit from uMoonPhase, so the terminator has its real shape.
    vec3 md = uMoonDir;
    float mm = dot(d, md);
    if (mm > 0.0 && uMoonVis > 0.001) {
        float size = pretty ? 0.026 : 0.055;
        vec2 q = discCoords(d, md) / size;
        float r2 = dot(q, q);
        float rim = px / size;                    // one pixel, in moon radii
        if (r2 < (1.0 + rim) * (1.0 + rim)) {
            vec3 n = vec3(q, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
            // The sun lies along the moon's path, so the lit limb faces that way.
            vec3 ls = vec3(0.0, sin(uMoonPhase), -cos(uMoonPhase));
            float lit = smoothstep(-0.06, 0.08, dot(n, ls));
            float maria = pretty ? 0.72 + 0.28 * texture(uCloudMap, q * 0.09 + 0.3).r : 0.9;
            vec3 moon = vec3(0.92, 0.93, 0.98) * (lit * maria + 0.035);
            float edge = pretty ? smoothstep(1.0, 0.9, r2) : 1.0 - smoothstep(1.0 - rim, 1.0 + rim, sqrt(r2));
            col = mix(col, moon, edge * uMoonVis * clearSky);
        }
        if (pretty) col += vec3(0.6, 0.65, 0.8) * pow(mm, 3000.0) * 0.15 * uMoonVis * clearSky * (0.5 + 0.5 * -cos(uMoonPhase));
    }

    col += uSkyFlash * above;
    fragColor = displayOut(vec4(col, 1.0));
}
`;

export class Sky {
    /**
     * @param {THREE.Scene} scene
     * @param {object} atmos  makeAtmosUniforms() — shared, spread in
     */
    constructor(scene, atmos) {
        this.scene = scene;
        this.mode  = 'simple';
        this.uniforms = {
            ...atmos,
            uSkyMode:     { value: 0 },
            uZenith:      { value: new THREE.Vector3() },
            uOvercast:    { value: new THREE.Vector3() },
            uOvercastAmt: { value: 0 },
            uSkyLit:      { value: 1 },
            uSunColor:    { value: new THREE.Vector3(1, 1, 1) },
            uSunVis:      { value: 1 },
            uMoonPhase:   { value: Math.PI },
            uMoonVis:     { value: 1 },
            uStars:       { value: 0 },
            uStarRot:     { value: new THREE.Matrix3() },
            uPathAxis:    { value: new THREE.Vector3(0, -Math.sin(SUN_TILT), Math.cos(SUN_TILT)) },
            uSkyFlash:    { value: new THREE.Vector3() },
        };
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: this.uniforms,
            side: THREE.BackSide,
            depthWrite: false,
        });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), this.material);
        // Last of the opaque things (chunks are 0, far terrain 1): by then the
        // depth buffer says which pixels are still sky.
        this.mesh.renderOrder = 1000;
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
        this._m4 = new THREE.Matrix4();
    }

    setMode(mode) {
        this.mode = SKY_MODES.includes(mode) ? mode : 'simple';
        this.uniforms.uSkyMode.value = this.mode === 'pretty' ? 1 : 0;
    }

    /** Follow the camera and turn the stars. `sunAngle` is the sun's angle along its path. */
    update(cameraPos, sunAngle) {
        this.mesh.position.copy(cameraPos);
        this._m4.makeRotationAxis(this.uniforms.uPathAxis.value, -sunAngle);
        this.uniforms.uStarRot.value.setFromMatrix4(this._m4);
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
