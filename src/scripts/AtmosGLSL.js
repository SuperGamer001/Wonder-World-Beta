/**
 * AtmosGLSL — uniforms and GLSL shared by everything the atmosphere touches:
 * the chunk shaders, the sky, the clouds and precipitation.
 *
 * makeAtmosUniforms() returns one object of uniform objects. Every material
 * spreads it into its own `uniforms` ({ ...atmos, … }), which copies references
 * to the same uniform objects — so Atmosphere.update() writes each value once
 * and every material sees it. Never clone these (see world.js chunk materials).
 *
 * ATMOS_GLSL declares them and provides:
 *   cloudNoise / cloudCover / cloudThick / rainMask — the cloud field. The CPU
 *     twin is engine/CloudField.js; keep the two identical.
 *   fogColorFor(dir)   — fog/horizon colour looking along dir (brighter toward
 *                        the sun at sunrise and sunset)
 *   weatherFog(o, r)   — how much weather fog lies along the ray o → o + r:
 *                        uniform haze (rain, snow, dust) plus exponential ground
 *                        fog that thins with height, so mist fills valleys and a
 *                        mountain top can look out over a sea of fog
 */

import * as THREE from 'three';
import {
    CLOUD_PERIOD_A, CLOUD_PERIOD_B, CLOUD_MIX_A, DETAIL_SHIFT, COVER_SOFT, THICK_GAIN,
} from './engine/CloudField.js';

export const CLOUD_BASE = 192;   // world Y of the cloud layer's underside
export const CLOUD_TOP  = 236;   // … and of the tallest cloud tops (Fancy)

const f = (x) => Number(x).toFixed(6);

export function makeAtmosUniforms() {
    return {
        uSkySunDir:   { value: new THREE.Vector3(0, 1, 0) },   // the real sun (sky, fog glow)
        uMoonDir:     { value: new THREE.Vector3(0, -1, 0) },
        uFogColor:    { value: new THREE.Vector3(0.53, 0.81, 0.92) },
        uFogSun:      { value: new THREE.Vector3() },           // glow added toward the sun
        uFogDensity:  { value: 0 },
        uFogBase:     { value: 64 },
        uFogScale:    { value: 60 },
        uHaze:        { value: 0 },
        uCloudMap:    { value: null },
        uCloudOffA:   { value: new THREE.Vector2() },
        uCloudOffB:   { value: new THREE.Vector2() },
        uCloudThresh: { value: 2 },
        uRainBase:    { value: 0 },
        uCloudBase:   { value: CLOUD_BASE },
        uCloudTop:    { value: CLOUD_TOP },
        uAmbient:     { value: new THREE.Vector3(1, 1, 1) },    // sky-light colour
        uDirect:      { value: new THREE.Vector3(1, 1, 1) },    // direct light colour × strength
        uFlash:       { value: 0 },                              // lightning on open ground
        uWet:         { value: 0 },
        uIce:         { value: 0 },
        uTime:        { value: 0 },                              // seconds, wrapped
        uWind:        { value: new THREE.Vector4() },            // xy wind (blocks/s), z gustiness
    };
}

export const ATMOS_GLSL = `
uniform vec3  uSkySunDir;
uniform vec3  uMoonDir;
uniform vec3  uFogColor;
uniform vec3  uFogSun;
uniform float uFogDensity;
uniform float uFogBase;
uniform float uFogScale;
uniform float uHaze;
uniform sampler2D uCloudMap;
uniform vec2  uCloudOffA;
uniform vec2  uCloudOffB;
uniform float uCloudThresh;
uniform float uRainBase;
uniform float uCloudBase;
uniform float uCloudTop;
uniform vec3  uAmbient;
uniform vec3  uDirect;
uniform float uFlash;
uniform float uWet;
uniform float uIce;
uniform float uTime;
uniform vec4  uWind;

float cloudNoise(vec2 xz) {
    float a = texture(uCloudMap, (xz + uCloudOffA) * ${f(1 / CLOUD_PERIOD_A)}).r;
    float b = texture(uCloudMap, (xz + uCloudOffB) * ${f(1 / CLOUD_PERIOD_B)} + vec2(${f(DETAIL_SHIFT[0])}, ${f(DETAIL_SHIFT[1])})).r;
    return a * ${f(CLOUD_MIX_A)} + b * ${f(1 - CLOUD_MIX_A)};
}
float cloudCover(float n) { return smoothstep(uCloudThresh, uCloudThresh + ${f(COVER_SOFT)}, n); }
float cloudThick(float n) { return clamp((n - uCloudThresh) * ${f(THICK_GAIN)}, 0.0, 1.0); }
float rainMask(float n) {
    return cloudCover(n) * clamp(uRainBase + (1.0 - uRainBase) * smoothstep(0.1, 0.55, cloudThick(n)), 0.0, 1.0);
}

vec3 fogColorFor(vec3 dir) {
    return uFogColor + uFogSun * pow(max(dot(dir, uSkySunDir), 0.0), 8.0);
}

// hazeLen caps how much of the ray passes through haze (rain, snow, dust).
float weatherFogHaze(vec3 o, vec3 r, float hazeLen) {
    float d = length(r);
    float od = uHaze * min(d, hazeLen);
    if (uFogDensity > 0.0) {
        float lo = -40.0;
        float y0 = max(o.y - uFogBase, lo);
        float y1 = max(o.y + r.y - uFogBase, lo);
        float dy = y1 - y0;
        float e0 = exp(-y0 / uFogScale);
        float integ = abs(dy) < 0.05 ? e0 * d : uFogScale * (e0 - exp(-y1 / uFogScale)) * d / dy;
        od += uFogDensity * integ;
    }
    return 1.0 - exp(-od);
}
float weatherFog(vec3 o, vec3 r) { return weatherFogHaze(o, r, 1e9); }
`;
