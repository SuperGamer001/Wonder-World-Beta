/**
 * PostFX — eye adaptation (auto-exposure) with a little bloom
 * (Graphics → Eye Adaptation).
 *
 * The scene is drawn into a floating-point target instead of the canvas, in
 * linear light with nothing clipped (everything the game draws with its own
 * shaders converts through `displayOut`, AtmosGLSL.js), so a torch flame or the
 * sun can be many times brighter than white. The target is R11G11B10F — four
 * bytes a pixel, like the canvas — where the GPU can render to it, else RGBA
 * half float (eight). On integrated graphics the scene pass is limited by
 * memory bandwidth, so that halves what the effect adds to it. Then, all on
 * the GPU:
 *
 *   1. Downsample — five levels, 1/4 … 1/64 of the screen. The first averages
 *      each 4×4 block of the scene exactly (four bilinear taps); each later one
 *      is a 13-tap filter of the one above (Jimenez, "Next Generation Post
 *      Processing in Call of Duty: Advanced Warfare"). So small bright things
 *      are averaged in, not skipped. Starting at a quarter, not a half, is
 *      most of what keeps this cheap: a 1/2-resolution level with a 13-tap
 *      filter cost more than all the rest of the effect together.
 *   2. Meter — one pixel reads the smallest level all over (a 16×9 grid of
 *      cells, four bilinear taps each, so even a torch flame a few pixels
 *      across is counted), weighted toward the middle of the screen, and
 *      averages its luminance. The mean, not the log-mean, and light brighter
 *      than white (flames, lamps, the sun) counts GLARE times over: a bright
 *      light in view is meant to pull exposure down, so the dark around it
 *      looks darker and the light does not wash out the frame. The result is
 *      eased toward over time — quickly toward brighter
 *      (about a third of a second), slowly toward darker (a couple of
 *      seconds), as eyes do — in a 1×1 target that ping-pongs between frames.
 *      Nothing is read back to the CPU, so there is no stall.
 *   3. Exposure — normal daylight is left alone: between METER_LO and
 *      METER_HI the exposure is 1, so the game looks as it always has. Darker
 *      than that (night, caves) it rises, up to MAX_UP stops; brighter (the
 *      sun, a torch held close in the dark), it falls, down to MAX_DOWN stops.
 *   4. Bloom — the levels are added back up the chain (a 9-tap tent at each
 *      step) and a small share is mixed into the image. No threshold: every
 *      pixel spreads the same tiny fraction, so only very bright ones — flames,
 *      lamps, the sun — show a visible glow.
 *   5. Composite — scene + bloom, × exposure, a soft shoulder (identity below
 *      SHOULDER, then easing toward white so bright lights keep a hint of
 *      colour instead of clipping), sRGB, and a 1/255 dither so the brightened
 *      dark does not band.
 *
 * Exposure only changes how the frame is displayed. The game's light levels,
 * what mobs see and everything else read from the world are untouched.
 *
 * Needs a colour-renderable float format (EXT_color_buffer_float or
 * _half_float — virtually every WebGL 2 system). Without one it stays off.
 */

import * as THREE from 'three';

const LEVELS = 5;                // bloom / metering levels: 1/4 … 1/64
const BLOOM = 0.05;              // share of the bloom in the final image

// Exposure response, in stops of the metered (linear) average luminance.
const METER_LO = Math.log2(0.05);   // below this the scene is dark: brighten it
const METER_HI = Math.log2(0.45);   // above this it is glaring: darken it
const GAIN_UP   = 0.6;              // stops of brightening per stop below METER_LO
const GAIN_DOWN = 0.75;             // stops of darkening per stop above METER_HI
const MAX_UP    = 1.6;              // at most ×3 in the dark …
const MAX_DOWN  = 1.5;              // … and ÷2.8 in glare
const GLARE     = 2.0;              // extra weight of luminance above 1 (light sources)
const RATE_BRIGHTER = 3.0;          // 1/s — adapting to light
const RATE_DARKER   = 0.6;          // 1/s — adapting to the dark
const SHOULDER = 0.7;               // linear value where the highlight roll-off starts

const f = (x) => Number(x).toFixed(6);

const VERT = `
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Scene → 1/4: the mean of the 4×4 texels under each output pixel. Each tap
// lands on a texel corner, so bilinear filtering averages a 2×2 block.
const DOWN_FIRST_FRAG = `
uniform sampler2D uSrc;
uniform vec2 uTexel;            // source texel size
in vec2 vUv;
out vec4 fragColor;
vec3 tap(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
    vec3 col = (tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0)) * 0.25;
    // A lone pixel far brighter than anything real (a NaN, a specular spike)
    // would otherwise flicker the bloom and the exposure.
    col = min(col, vec3(64.0));
    if (any(isnan(col))) col = vec3(0.0);
    fragColor = vec4(col, 1.0);
}
`;

// 13 taps in a 4×4-texel footprint: five overlapping 2×2 boxes, weighted.
const DOWN_FRAG = `
uniform sampler2D uSrc;
uniform vec2 uTexel;            // source texel size
in vec2 vUv;
out vec4 fragColor;
vec3 tap(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
    vec3 a = tap(-2.0,  2.0), b = tap(0.0,  2.0), c = tap(2.0,  2.0);
    vec3 d = tap(-2.0,  0.0), e = tap(0.0,  0.0), g = tap(2.0,  0.0);
    vec3 h = tap(-2.0, -2.0), i = tap(0.0, -2.0), j = tap(2.0, -2.0);
    vec3 k = tap(-1.0,  1.0), l = tap(1.0,  1.0), m = tap(-1.0, -1.0), n = tap(1.0, -1.0);
    vec3 col = e * 0.125 + (a + c + h + j) * 0.03125 + (b + d + g + i) * 0.0625 + (k + l + m + n) * 0.125;
    fragColor = vec4(col, 1.0);
}
`;

// 3×3 tent, added (AdditiveBlending) onto the next level up.
const UP_FRAG = `
uniform sampler2D uSrc;
uniform vec2 uTexel;            // source texel size
in vec2 vUv;
out vec4 fragColor;
vec3 tap(float x, float y) { return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
    vec3 s = tap(0.0, 0.0) * 4.0
           + (tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, -1.0) + tap(0.0, 1.0)) * 2.0
           + tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0);
    fragColor = vec4(s / 16.0, 1.0);
}
`;

// One pixel: r = adapted log2 luminance, g = exposure.
const METER_FRAG = `
uniform sampler2D uSrc;         // the smallest downsample level
uniform sampler2D uPrev;        // last frame's result
uniform float uDt;
uniform float uReset;
out vec4 fragColor;
float lum(vec2 uv) {
    float l = min(dot(texture(uSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), 48.0);
    return l + ${f(GLARE)} * max(l - 1.0, 0.0);
}
void main() {
    float sum = 0.0, wsum = 0.0;
    for (int j = 0; j < 9; j++) {
        for (int i = 0; i < 16; i++) {
            vec2 cell = vec2(float(i), float(j));
            vec2 uv = (cell + 0.5) / vec2(16.0, 9.0);
            vec2 q = 0.25 / vec2(16.0, 9.0);
            float l = 0.25 * (lum(uv + vec2(-q.x, -q.y)) + lum(uv + vec2(q.x, -q.y)) +
                              lum(uv + vec2(-q.x,  q.y)) + lum(uv + vec2(q.x,  q.y)));
            vec2 d = (uv - 0.5) * vec2(1.6, 1.0);
            float w = 0.25 + exp(-dot(d, d) * 8.0);       // centre-weighted
            sum += l * w;
            wsum += w;
        }
    }
    float ev = log2(max(sum / wsum, 1e-4));
    float prev = texelFetch(uPrev, ivec2(0), 0).r;
    if (uReset > 0.5 || isnan(prev) || isinf(prev)) prev = ev;
    float rate = ev > prev ? ${f(RATE_BRIGHTER)} : ${f(RATE_DARKER)};
    float a = mix(prev, ev, 1.0 - exp(-uDt * rate));
    float stops = max(${f(METER_LO)} - a, 0.0) * ${f(GAIN_UP)} - max(a - ${f(METER_HI)}, 0.0) * ${f(GAIN_DOWN)};
    fragColor = vec4(a, exp2(clamp(stops, -${f(MAX_DOWN)}, ${f(MAX_UP)})), 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D uScene;
uniform sampler2D uBloom;       // the top bloom level: LEVELS levels summed
uniform sampler2D uLum;
in vec2 vUv;
out vec4 fragColor;
float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
vec3 shoulder(vec3 x) {
    const float k = ${f(SHOULDER)};
    return mix(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), step(k, x));
}
void main() {
    vec3 c = texture(uScene, vUv).rgb;
    vec3 b = texture(uBloom, vUv).rgb * ${f(1 / LEVELS)};
    c = mix(c, b, ${f(BLOOM)});
    c *= texelFetch(uLum, ivec2(0), 0).g;
    vec4 o = linearToOutputTexel(vec4(shoulder(max(c, 0.0)), 1.0));
    o.rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
    fragColor = o;
}
`;

/** `fmt`: { type, format } — see PostFX._formats. */
function hdrTarget(w, h, fmt, depth = false) {
    return new THREE.WebGLRenderTarget(w, h, {
        type: fmt.type,
        format: fmt.format,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: depth,
        stencilBuffer: false,
    });
}

export class PostFX {
    constructor(renderer) {
        this.renderer = renderer;
        this.enabled = false;
        const ext = renderer.extensions;
        const full = ext.has('EXT_color_buffer_float');
        this.supported = renderer.capabilities.isWebGL2 && (full || ext.has('EXT_color_buffer_half_float'));
        // Colour: R11G11B10F (no alpha, no negatives, 4 bytes) where renderable,
        // else RGBA half float. The 1×1 adaptation targets hold a log value,
        // which is negative, so they are always half float.
        const half = { type: THREE.HalfFloatType, format: THREE.RGBAFormat };
        this._color = full ? { type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat } : half;
        this._half = half;

        // One full-screen triangle, drawn with each pass's material in turn.
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
        this._quad = new THREE.Mesh(geo);
        this._quad.frustumCulled = false;
        this._scene = new THREE.Scene();
        this._scene.add(this._quad);
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms,
            depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...extra,
        });
        const src = () => ({ uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
        this._downFirst = mat(DOWN_FIRST_FRAG, src());
        this._down = mat(DOWN_FRAG, src());
        this._up = mat(UP_FRAG, src(), { blending: THREE.AdditiveBlending });
        this._meter = mat(METER_FRAG, {
            uSrc: { value: null }, uPrev: { value: null }, uDt: { value: 0 }, uReset: { value: 1 },
        });
        this._composite = mat(COMPOSITE_FRAG, {
            uScene: { value: null }, uBloom: { value: null }, uLum: { value: null },
        });

        this.target = null;      // the scene, full resolution
        this._mips = [];
        this._lum = [];
        this._cur = 0;
        this._reset = true;
        this._size = new THREE.Vector2();
        this._w = this._h = 0;   // size the targets were last fitted to
    }

    /** Drawing the scene through this frame's post-processing. */
    get active() { return this.enabled && this.supported; }

    setEnabled(on) {
        this.enabled = !!on;
        if (!this.active) this._freeTargets();
        this._reset = true;
    }

    /** Jump straight to the right exposure next frame (world load, respawn). */
    resetAdaptation() { this._reset = true; }

    /** Point the renderer at the scene target. Draw the scene, then call end(). */
    begin() {
        this._fit();
        this.renderer.setRenderTarget(this.target);
    }

    /** Meter, adapt, bloom and put the frame on the canvas. `dt` in seconds. */
    end(dt) {
        const r = this.renderer;
        const autoClear = r.autoClear;
        r.autoClear = false;     // every pass covers its whole target

        // 1. Down the chain.
        let src = this.target;
        for (let i = 0; i < LEVELS; i++) {
            const m = i === 0 ? this._downFirst : this._down;
            m.uniforms.uSrc.value = src.texture;
            m.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
            this._pass(m, this._mips[i]);
            src = this._mips[i];
        }

        // 2–3. Meter the smallest level and adapt toward it.
        const prev = this._lum[this._cur];
        this._cur ^= 1;
        const mt = this._meter.uniforms;
        mt.uSrc.value = this._mips[LEVELS - 1].texture;
        mt.uPrev.value = prev.texture;
        mt.uDt.value = Math.min(Math.max(dt, 0), 0.25);
        mt.uReset.value = this._reset ? 1 : 0;
        this._reset = false;
        this._pass(this._meter, this._lum[this._cur]);

        // 4. Back up the chain, each level adding the one below it.
        for (let i = LEVELS - 2; i >= 0; i--) {
            const s = this._mips[i + 1];
            this._up.uniforms.uSrc.value = s.texture;
            this._up.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
            this._pass(this._up, this._mips[i]);
        }

        // 5. Onto the canvas.
        const c = this._composite.uniforms;
        c.uScene.value = this.target.texture;
        c.uBloom.value = this._mips[0].texture;
        c.uLum.value = this._lum[this._cur].texture;
        this._pass(this._composite, null);

        r.autoClear = autoClear;
    }

    /**
     * The adapted luminance and exposure, read back from the GPU — for
     * diagnostics (__wwDebug) only: a read stalls the pipeline, so never per frame.
     */
    readback() {
        const t = this._lum[this._cur];
        if (!this.active || !t) return null;
        const px = new Uint16Array(4);
        this.renderer.readRenderTargetPixels(t, 0, 0, 1, 1, px);
        const f = THREE.DataUtils.fromHalfFloat;
        return { luminance: +Math.pow(2, f(px[0])).toFixed(5), exposure: +f(px[1]).toFixed(3) };
    }

    /** Run every pass once while the loading screen is up, so no shader compiles mid-game. */
    warm() {
        if (!this.active) return;
        this.begin();
        this.renderer.clear();
        this.end(0);
        this._reset = true;
    }

    dispose() {
        this._freeTargets();
        this._quad.geometry.dispose();
        for (const m of [this._downFirst, this._down, this._up, this._meter, this._composite]) m.dispose();
    }

    _pass(material, target) {
        this._quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this._scene, this._camera);
    }

    /** (Re)size the targets to the drawing buffer. */
    _fit() {
        const full = this.renderer.getDrawingBufferSize(this._size);
        const w = Math.max(1, full.x), h = Math.max(1, full.y);
        if (!this.target) {
            this.target = hdrTarget(w, h, this._color, true);
            for (let i = 0; i < LEVELS; i++) this._mips.push(hdrTarget(1, 1, this._color));
            this._lum = [hdrTarget(1, 1, this._half), hdrTarget(1, 1, this._half)];
            for (const t of this._lum) { t.texture.minFilter = t.texture.magFilter = THREE.NearestFilter; }
            this._w = this._h = 0;
            this._reset = true;
        }
        if (this._w !== w || this._h !== h) {
            this._w = w; this._h = h;
            this.target.setSize(w, h);
            for (let i = 0; i < LEVELS; i++) {
                this._mips[i].setSize(Math.max(1, w >> (i + 2)), Math.max(1, h >> (i + 2)));
            }
        }
    }

    _freeTargets() {
        this.target?.dispose();
        for (const t of this._mips) t.dispose();
        for (const t of this._lum) t.dispose();
        this.target = null;
        this._mips = [];
        this._lum = [];
    }
}
