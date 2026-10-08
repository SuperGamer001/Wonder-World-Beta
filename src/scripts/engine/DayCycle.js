/**
 * DayCycle — the world clock, and everything that follows from where the sun
 * is: sun and moon directions, the colour and strength of the light, and the
 * sky palette (Sky.js draws it, the chunk shaders are lit by it).
 *
 * No Three.js and no DOM — tests import this directly.
 *
 * Time is a fraction of a day, `time` in [0, 1), plus a day counter for the
 * moon's phase. Hour 6 is sunrise (the sun on the eastern, +X, horizon), 12 is
 * noon and 18 is sunset. The sun's path is tilted toward +Z so that at noon it
 * sits close to Sun.js's SUN_DIR — the direction the game was lit from before
 * the sun moved — which keeps midday looking exactly like the fixed-sun game did.
 *
 * Every colour here is a raw display value (what ends up on screen), not a
 * linear one: the chunk shaders write their output without colour-space
 * conversion, so the sky, fog and terrain all have to agree in that space.
 */

export const DAY_LENGTH     = 1200;   // real seconds per game day — 20 minutes, as in Minecraft
export const SUNRISE_HOUR   = 6;
export const MOON_CYCLE     = 8;      // days from one full moon to the next
export const SUN_TILT       = 0.44;   // radians the sun's path leans toward +Z (south)
export const START_HOUR     = 7.5;    // new worlds begin in the early morning

const TAU = Math.PI * 2;

// ── Palette keyframes ─────────────────────────────────────────────────────────
// Keyed on the sine of the sun's elevation (its direction's y). Between keys
// every colour is interpolated linearly. Columns:
//   zenith, horizon — the pretty sky's gradient (horizon is also the fog colour)
//   flat            — the simple sky's single colour (day is the original 0x87CEEB)
//   ambient         — sky-light colour on terrain (the part every surface gets)
//   sun             — colour of direct sunlight
const KEYS = [
    { s: -1.00, zenith: [0.006, 0.010, 0.030], horizon: [0.020, 0.030, 0.062], flat: [0.012, 0.018, 0.045], ambient: [0.150, 0.175, 0.260], sun: [1.00, 0.45, 0.18] },
    { s: -0.24, zenith: [0.006, 0.010, 0.030], horizon: [0.020, 0.030, 0.062], flat: [0.012, 0.018, 0.045], ambient: [0.150, 0.175, 0.260], sun: [1.00, 0.45, 0.18] },
    { s: -0.12, zenith: [0.030, 0.050, 0.140], horizon: [0.110, 0.100, 0.200], flat: [0.060, 0.070, 0.160], ambient: [0.210, 0.220, 0.330], sun: [1.00, 0.45, 0.18] },
    { s: -0.03, zenith: [0.100, 0.160, 0.360], horizon: [0.540, 0.320, 0.300], flat: [0.350, 0.300, 0.420], ambient: [0.360, 0.340, 0.430], sun: [1.00, 0.45, 0.18] },
    { s:  0.03, zenith: [0.180, 0.300, 0.580], horizon: [0.950, 0.560, 0.320], flat: [0.800, 0.540, 0.420], ambient: [0.620, 0.530, 0.500], sun: [1.00, 0.55, 0.26] },
    { s:  0.12, zenith: [0.250, 0.450, 0.800], horizon: [0.920, 0.760, 0.580], flat: [0.640, 0.720, 0.800], ambient: [0.860, 0.810, 0.770], sun: [1.00, 0.80, 0.56] },
    { s:  0.30, zenith: [0.290, 0.530, 0.900], horizon: [0.640, 0.800, 0.940], flat: [0.529, 0.808, 0.922], ambient: [1.000, 1.000, 1.000], sun: [1.00, 0.97, 0.92] },
    { s:  1.00, zenith: [0.270, 0.510, 0.900], horizon: [0.620, 0.790, 0.940], flat: [0.529, 0.808, 0.922], ambient: [1.000, 1.000, 1.000], sun: [1.00, 0.98, 0.94] },
];

const MOON_COLOR = [0.62, 0.70, 0.92];   // direct moonlight tint
const MOON_DIRECT = 0.32;                // moonlight strength relative to the sun's
const GLOW_COLOR = [1.00, 0.46, 0.16];   // sunrise / sunset glow

function lerp3(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
}

export function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/** Unit direction toward the sun at `time` (fraction of a day). */
export function sunDirection(time, out = [0, 0, 0]) {
    const a = (time * 24 - SUNRISE_HOUR) / 12 * Math.PI;   // 0 sunrise, π/2 noon, π sunset
    const up = Math.sin(a);
    out[0] = Math.cos(a);
    out[1] = up * Math.cos(SUN_TILT);
    out[2] = up * Math.sin(SUN_TILT);
    return out;
}

/**
 * Moon phase angle for a day number: π is full (the first night of a world, as
 * in Minecraft), 0 is new. Sky.js lights the moon's disc as a sphere with the
 * sun at this angle behind it, so the terminator is the real shape.
 */
export function moonPhaseAngle(day) {
    const p = ((day % MOON_CYCLE) + MOON_CYCLE) % MOON_CYCLE;
    return Math.PI - p * (TAU / MOON_CYCLE);
}

/** 0 (new) … 1 (full): the fraction of the disc that is lit. */
export function moonIllumination(day) {
    return (1 - Math.cos(moonPhaseAngle(day))) * 0.5;
}

/**
 * Output of DayCycle.sample(). One instance is reused every frame, so reading
 * it allocates nothing.
 */
export function newSkyState() {
    return {
        hours: 0,
        sunDir:  [0, 1, 0],
        moonDir: [0, -1, 0],
        lightDir: [0, 1, 0],   // the sun by day, the moon by night — shadows follow it
        sunHeight: 1,          // sunDir y: sine of the sun's elevation
        zenith:  [0, 0, 0],
        horizon: [0, 0, 0],
        flat:    [0, 0, 0],
        ambient: [0, 0, 0],    // sky-light colour
        direct:  [0, 0, 0],    // direct light colour × strength (sun or moon)
        directStrength: 1,
        sunColor: [1, 1, 1],
        glow:    [0, 0, 0],    // sunrise/sunset glow colour × strength
        stars: 0,              // 0 by day … 1 at full night
        moonPhase: Math.PI,
        moonLight: 1,          // 0.55 (new) … 1 (full)
        night: 0,              // 0 day … 1 night — for anything that wants a simple switch
    };
}

export class DayCycle {
    constructor() {
        this.time    = START_HOUR / 24;
        this.day     = 0;
        this.running = true;          // World Settings → Daylight Cycle
    }

    get hours() { return this.time * 24; }

    /** Jump to an hour of the current day (0–24). */
    setHours(h) {
        h = ((h % 24) + 24) % 24;
        this.time = h / 24;
    }

    /** Advance the clock by `dt` real seconds (no-op while the cycle is off). */
    advance(dt) {
        if (!this.running || !(dt > 0)) return;
        this.time += dt / DAY_LENGTH;
        if (this.time >= 1) {
            const whole = Math.floor(this.time);
            this.time -= whole;
            this.day  += whole;
        }
    }

    toJSON() { return { time: this.time, day: this.day }; }

    fromJSON(o) {
        if (!o) return;
        if (Number.isFinite(o.time)) { const t = o.time % 1; this.time = t < 0 ? t + 1 : t; }
        if (Number.isFinite(o.day))  this.day  = Math.max(0, Math.floor(o.day));
    }

    /** Fill `out` (a newSkyState()) for the current time. */
    sample(out) {
        out.hours = this.hours;
        const sun = sunDirection(this.time, out.sunDir);
        out.moonDir[0] = -sun[0]; out.moonDir[1] = -sun[1]; out.moonDir[2] = -sun[2];
        const s = sun[1];
        out.sunHeight = s;

        // Palette: find the keyframe pair around s.
        let i = 0;
        while (i < KEYS.length - 2 && KEYS[i + 1].s <= s) i++;
        const a = KEYS[i], b = KEYS[i + 1];
        const t = Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s)));
        lerp3(out.zenith,   a.zenith,  b.zenith,  t);
        lerp3(out.horizon,  a.horizon, b.horizon, t);
        lerp3(out.flat,     a.flat,    b.flat,    t);
        lerp3(out.ambient,  a.ambient, b.ambient, t);
        lerp3(out.sunColor, a.sun,     b.sun,     t);

        out.moonPhase = moonPhaseAngle(this.day);
        out.moonLight = 0.55 + 0.45 * moonIllumination(this.day);

        // Moonlight is a touch brighter under a full moon.
        const nightAmb = smoothstep(-0.02, -0.2, s) * (out.moonLight - 0.8) * 0.25;
        out.ambient[0] += nightAmb; out.ambient[1] += nightAmb; out.ambient[2] += nightAmb * 1.3;

        // Direct light: the sun above the horizon, the moon when the sun is well
        // below it. Both are zero where the source swaps (s = -0.02), so the
        // swap is invisible.
        const sunUp  = smoothstep(-0.02, 0.14, s);
        const moonUp = smoothstep(0.02, 0.18, -s) * MOON_DIRECT * out.moonLight;
        const useSun = s > -0.02;
        const src = useSun ? sun : out.moonDir;
        out.lightDir[0] = src[0]; out.lightDir[1] = src[1]; out.lightDir[2] = src[2];
        out.directStrength = useSun ? sunUp : moonUp;
        const col = useSun ? out.sunColor : MOON_COLOR;
        out.direct[0] = col[0] * out.directStrength;
        out.direct[1] = col[1] * out.directStrength;
        out.direct[2] = col[2] * out.directStrength;

        // Sunrise/sunset glow peaks as the sun crosses the horizon.
        const g = Math.exp(-(((s + 0.02) / 0.11) ** 2));
        out.glow[0] = GLOW_COLOR[0] * g; out.glow[1] = GLOW_COLOR[1] * g; out.glow[2] = GLOW_COLOR[2] * g;

        out.stars = 1 - smoothstep(-0.2, -0.03, s);
        out.night = 1 - smoothstep(-0.12, 0.05, s);
        return out;
    }
}
