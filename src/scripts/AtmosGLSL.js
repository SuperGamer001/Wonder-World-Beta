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
 *   cloudSpan(o, d)    — the stretch of a ray that lies inside the cloud layer
 *
 * CLOUD_VEIL_GLSL (fragment shaders that draw surfaces: the chunks, far
 * terrain) provides cloudVeil(c, r): the colour c of a surface r away from the
 * camera, with whatever cloud lies in between drawn over it. The clouds are
 * drawn once a frame into a picture (Clouds.js, uCloudRT) that holds, for each
 * pixel, the cloud along the whole of that line of sight; the sky shows it as
 * it is, and a surface takes the share of it that is in front of it. So a
 * mountain top standing in the cloud fades into it, water is behind or in
 * front of cloud as it should be, and nothing depends on the order things are
 * drawn in — which is what used to go wrong with a cloud layer drawn as one
 * sheet after everything else.
 *
 * OUTPUT_GLSL (fragment shaders only) is how every shader the game writes itself
 * hands over its colour: displayOut(c). The game's colours are display values;
 * that is what the canvas wants. With Eye Adaptation on (PostFX.js) the scene
 * goes to a linear half-float target instead, and uLinearOut — set by world.js
 * around that one render — converts them. Three.js's own materials (mobs,
 * dropped items) make the same switch themselves.
 */

import * as THREE from 'three';
import {
    CLOUD_PERIOD_A, CLOUD_PERIOD_B, CLOUD_MIX_A, DETAIL_SHIFT, COVER_SOFT, THICK_GAIN,
} from './engine/CloudField.js';

export const CLOUD_BASE = 192;   // world Y of the cloud layer's underside
export const CLOUD_TOP  = 236;   // … and of the tallest cloud tops
export const CLOUD_REACH = 360;  // furthest a line of sight is followed through the layer, blocks

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
        // The clouds as drawn this frame (Clouds.js): whether there are any,
        // the picture, and one over its size on screen in pixels.
        uCloudOn:     { value: 0 },
        uCloudRT:     { value: null },
        uCloudPx:     { value: new THREE.Vector2(1, 1) },
        uAmbient:     { value: new THREE.Vector3(1, 1, 1) },    // sky-light colour
        uDirect:      { value: new THREE.Vector3(1, 1, 1) },    // direct light colour × strength
        uFlash:       { value: 0 },                              // lightning on open ground
        uWet:         { value: 0 },
        uIce:         { value: 0 },
        uTime:        { value: 0 },                              // seconds, wrapped
        uWind:        { value: new THREE.Vector4() },            // xy wind (blocks/s), z gustiness
        uLinearOut:   { value: false },                          // drawing into PostFX's linear target
    };
}

// Fragment shaders only: sRGBTransferEOTF comes from Three.js's fragment prefix.
export const OUTPUT_GLSL = `
uniform bool uLinearOut;
vec4 displayOut(vec4 c) {
    return uLinearOut ? sRGBTransferEOTF(vec4(max(c.rgb, 0.0), c.a)) : c;
}
`;

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

// textureLod: the map has one level, and this is read inside loops and
// branches, where a lookup that needs screen derivatives is not allowed.
float cloudNoise(vec2 xz) {
    float a = textureLod(uCloudMap, (xz + uCloudOffA) * ${f(1 / CLOUD_PERIOD_A)}, 0.0).r;
    float b = textureLod(uCloudMap, (xz + uCloudOffB) * ${f(1 / CLOUD_PERIOD_B)} + vec2(${f(DETAIL_SHIFT[0])}, ${f(DETAIL_SHIFT[1])}), 0.0).r;
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

// The stretch of the ray o + d·t (d a unit vector) that lies in the cloud
// layer, at most ${CLOUD_REACH} blocks of it: x where it begins, y where it ends.
// None when y <= x.
vec2 cloudSpan(vec3 o, vec3 d) {
    float t0 = 0.0, t1 = 0.0;
    if (abs(d.y) < 1e-4) {
        if (o.y > uCloudBase && o.y < uCloudTop) t1 = ${f(CLOUD_REACH)};
    } else {
        float a = (uCloudBase - o.y) / d.y, b = (uCloudTop - o.y) / d.y;
        t0 = max(min(a, b), 0.0);
        t1 = max(a, b);
    }
    return vec2(t0, min(t1, t0 + ${f(CLOUD_REACH)}));
}
`;

// Needs ATMOS_GLSL. Fragment shaders only.
export const CLOUD_VEIL_GLSL = `
uniform float uCloudOn;
uniform sampler2D uCloudRT;
uniform vec2  uCloudPx;

// Colour c of a surface r away from the camera, behind the cloud between them.
vec3 cloudVeil(vec3 c, vec3 r) {
    if (uCloudOn < 0.5) return c;
    float y0 = cameraPosition.y, y1 = y0 + r.y;
    // Both ends on one side of the layer: nothing in between.
    if (max(y0, y1) <= uCloudBase || min(y0, y1) >= uCloudTop) return c;
    float d = length(r);
    vec2 s = cloudSpan(cameraPosition, r / max(d, 1e-4));
    if (s.y <= s.x || d <= s.x) return c;
    vec4 cl = textureLod(uCloudRT, gl_FragCoord.xy * uCloudPx, 0.0);
    if (cl.a < 0.002) return c;
    // The picture is the cloud all the way through the layer. A surface part
    // of the way in is behind that share of it, as if the cloud were even
    // along the way — which is exact once the surface is beyond the layer.
    float part = min((d - s.x) / (s.y - s.x), 1.0);
    float a = 1.0 - pow(1.0 - min(cl.a, 0.9999), part);
    return c * (1.0 - a) + cl.rgb * (a / cl.a);
}
`;
