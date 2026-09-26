/**
 * Weather — the world's weather state: which weather it is, how it changes,
 * and the continuous parameters every weather effect reads.
 *
 * No Three.js and no DOM — tests import this directly. Atmosphere.js turns the
 * parameters into clouds, rain, fog, light and sound.
 *
 * ── Model ────────────────────────────────────────────────────────────────────
 * Each weather type is a set of target values (cloud cover, precipitation,
 * wind, fog …). The live parameters `P` ease toward the targets of the current
 * type, so a change of weather rolls in over tens of seconds instead of
 * switching: clouds build, then rain starts where they have thickened.
 *
 * In dynamic mode the weather moves through a Markov chain of generic types
 * (NEXT below) with realistic durations, and a time-of-day bias — fog forms
 * around dawn and burns off by midday, thunderstorms prefer the afternoon.
 * The generic type is then *localised* to the climate at the player
 * (Climate.js): rain becomes snow where it is cold, sleet or freezing rain at
 * the margin, and dry clouds (virga) over the desert, where strong wind raises
 * dust instead. Walking from one climate into another changes the precipitation
 * smoothly, because the form itself is an eased parameter.
 *
 * A fixed mode (World Settings → Weather) holds one type exactly as chosen,
 * with no localisation — pick Snow and it snows in the desert.
 *
 * Tornadoes are an event, not a sky state: a supercell sometimes spawns one.
 */

// ── Parameter vector ─────────────────────────────────────────────────────────
export const COVER = 0, DARK = 1, PRECIP = 2, RAIN_BASE = 3, SNOW = 4, PELLET = 5,
    PELLET_SIZE = 6, FREEZING = 7, WIND = 8, GUST = 9, FOG = 10, FOG_SCALE = 11,
    HAZE = 12, LIGHTNING = 13, DUST = 14, ASH = 15, TINT_R = 16, TINT_G = 17,
    TINT_B = 18, TINT = 19;
const NP = 20;

// Seconds for each parameter to close ~63% of the gap to its target.
const TAU = new Float64Array(NP).fill(24);
TAU[SNOW] = TAU[PELLET] = TAU[PELLET_SIZE] = TAU[FREEZING] = 10;
TAU[WIND] = TAU[GUST] = 15;
TAU[LIGHTNING] = 12;
TAU[FOG] = TAU[FOG_SCALE] = 30;

// Precipitation forms → [snow, pellet, pelletSize, freezing]
const FORMS = {
    rain:     [0,    0,    0,    0],
    snow:     [1,    0,    0,    0],
    sleet:    [0.2,  0.5,  0.2,  0],
    freezing: [0,    0,    0,    1],
    hail:     [0,    0.4,  1,    0],
};

const DUST_TINT = [0.80, 0.66, 0.45];
const ASH_TINT  = [0.44, 0.41, 0.40];

/**
 * Weather types. Fields (all optional):
 *   cover    cloud cover, 0 clear … 1 overcast; above 1 thickens a full overcast
 *   dark     how dark the clouds are (storm clouds)
 *   precip   precipitation intensity 0..1, and `form` what it is
 *   rainBase minimum rain under any cloud — 0 means thin cloud and gaps stay dry
 *   wind     wind speed in blocks/s, `gust` how much it gusts (0..1)
 *   fog      visibility in blocks inside ground fog (0 = none); `fogScale` is how
 *            high the fog reaches (blocks for it to thin by e) — low for valley mist
 *   haze     visibility in blocks through rain, snow or dust (0 = none)
 *   lightning strikes per minute
 *   dust, ash airborne particle density 0..1
 */
const TYPES = [
    // id                label                          group
    ['clear',           'Fully Clear',                  'Clear',     { cover: 0,    wind: 1.5, gust: 0.15 }, [300, 900]],
    ['sunny',           'Sunny',                        'Clear',     { cover: 0.16, wind: 2.5 }, [300, 900]],
    ['mostly_sunny',    'Mostly Sunny',                 'Clear',     { cover: 0.40, dark: 0.08, wind: 3.5 }, [240, 720]],
    ['cloudy',          'Cloudy',                       'Clear',     { cover: 0.84, dark: 0.30, wind: 4.5 }, [240, 720]],
    ['misty',           'Misty',                        'Fog',       { cover: 0.30, dark: 0.10, wind: 1.0, gust: 0.1, fog: 170, fogScale: 34 }, [180, 480]],
    ['foggy',           'Foggy',                        'Fog',       { cover: 0.50, dark: 0.15, wind: 0.8, gust: 0.1, fog: 60, fogScale: 55 }, [180, 420]],
    ['dense_fog',       'Dense Fog',                    'Fog',       { cover: 0.70, dark: 0.20, wind: 0.5, gust: 0.05, fog: 16, fogScale: 110 }, [150, 360]],
    ['rain',            'Rain',                         'Rain',      { cover: 0.78, dark: 0.50, precip: 0.45, wind: 4.5, haze: 260 }, [240, 600]],
    ['heavy_rain',      'Heavy Rain',                   'Rain',      { cover: 1.08, dark: 0.70, precip: 0.85, rainBase: 0.45, wind: 6, gust: 0.35, haze: 120 }, [180, 420]],
    ['stormy',          'Stormy',                       'Rain',      { cover: 1.12, dark: 0.80, precip: 1.00, rainBase: 0.55, wind: 13, gust: 0.6, haze: 85 }, [150, 360]],
    ['rain_lightning',  'Lightning (Calm Rainstorm)',   'Lightning', { cover: 1.08, dark: 0.75, precip: 0.85, rainBase: 0.45, wind: 4, gust: 0.25, haze: 120, lightning: 2.2 }, [150, 360]],
    ['lightning_storm', 'Lightning Storm',              'Lightning', { cover: 1.10, dark: 0.82, precip: 0.90, rainBase: 0.5, wind: 7, gust: 0.4, haze: 105, lightning: 6 }, [120, 300]],
    ['dry_lightning',   'Lightning (No Rain)',          'Lightning', { cover: 1.02, dark: 0.72, wind: 5, gust: 0.35, lightning: 1.2 }, [120, 300]],
    ['snow',            'Snow',                         'Cold',      { cover: 0.85, dark: 0.35, precip: 0.45, form: 'snow', wind: 3, haze: 170 }, [240, 600]],
    ['heavy_snow',      'Heavy Snow',                   'Cold',      { cover: 1.06, dark: 0.50, precip: 0.90, rainBase: 0.5, form: 'snow', wind: 4, gust: 0.3, haze: 45 }, [180, 420]],
    ['snowstorm',       'Snowstorm',                    'Cold',      { cover: 1.12, dark: 0.60, precip: 1.00, rainBase: 0.6, form: 'snow', wind: 15, gust: 0.7, haze: 24 }, [150, 360]],
    ['sleet',           'Sleet',                        'Cold',      { cover: 0.95, dark: 0.55, precip: 0.60, rainBase: 0.2, form: 'sleet', wind: 5, haze: 150 }, [180, 420]],
    ['freezing_rain',   'Freezing Rain',                'Cold',      { cover: 1.00, dark: 0.55, precip: 0.55, rainBase: 0.3, form: 'freezing', wind: 3.5, haze: 180 }, [180, 420]],
    ['windy',           'Windy',                        'Extreme',   { cover: 0.40, dark: 0.10, wind: 11, gust: 0.6 }, [180, 480]],
    ['gale',            'Gale',                         'Extreme',   { cover: 0.65, dark: 0.35, precip: 0.3, wind: 20, gust: 0.8, haze: 240 }, [120, 300]],
    ['hailstorm',       'Hailstorm',                    'Extreme',   { cover: 1.12, dark: 0.82, precip: 0.90, rainBase: 0.5, form: 'hail', wind: 9, gust: 0.5, haze: 90, lightning: 1.5 }, [90, 240]],
    ['tornado',         'Tornado',                      'Extreme',   { cover: 1.15, dark: 0.92, precip: 1.00, rainBase: 0.55, wind: 18, gust: 0.8, haze: 75, lightning: 8, tornado: true }, [150, 300]],
    ['thunderstorm',    'Thunderstorm',                 'Extreme',   { cover: 1.10, dark: 0.85, precip: 0.95, rainBase: 0.5, wind: 11, gust: 0.6, haze: 100, lightning: 3 }, [150, 360]],
    ['supercell',       'Supercell',                    'Extreme',   { cover: 1.15, dark: 0.92, precip: 1.00, rainBase: 0.55, wind: 18, gust: 0.8, haze: 75, lightning: 10 }, [150, 300]],
    ['dusty',           'Dusty',                        'Biome',     { cover: 0.10, dark: 0.10, wind: 10, gust: 0.6, haze: 70, dust: 0.85, tint: DUST_TINT }, [180, 480]],
    ['ashy',            'Ashy',                         'Biome',     { cover: 0.60, dark: 0.50, wind: 2, gust: 0.2, haze: 90, ash: 0.75, tint: ASH_TINT }, [180, 480]],
];

export const WEATHER = {};
export const WEATHER_IDS = [];
for (const [id, label, group, p, dur] of TYPES) {
    WEATHER[id] = { id, label, group, dur, ...p, target: targetOf(p) };
    WEATHER_IDS.push(id);
}

function targetOf(p) {
    const t = new Float64Array(NP);
    const f = FORMS[p.form ?? 'rain'];
    t[COVER] = p.cover ?? 0;
    t[DARK] = p.dark ?? 0;
    t[PRECIP] = p.precip ?? 0;
    t[RAIN_BASE] = p.rainBase ?? 0;
    t[SNOW] = f[0]; t[PELLET] = f[1]; t[PELLET_SIZE] = f[2]; t[FREEZING] = f[3];
    t[WIND] = p.wind ?? 2.5;
    t[GUST] = p.gust ?? 0.25;
    t[FOG] = p.fog ? 3 / p.fog : 0;           // density reaching 95% at that distance
    t[FOG_SCALE] = p.fogScale ?? 60;
    t[HAZE] = p.haze ? 3 / p.haze : 0;
    t[LIGHTNING] = p.lightning ?? 0;
    t[DUST] = p.dust ?? 0;
    t[ASH] = p.ash ?? 0;
    const tint = p.tint ?? [1, 1, 1];
    t[TINT_R] = tint[0]; t[TINT_G] = tint[1]; t[TINT_B] = tint[2];
    t[TINT] = p.tint ? 0.7 * Math.max(p.dust ?? 0, p.ash ?? 0) : 0;
    return t;
}

// ── Dynamic weather ──────────────────────────────────────────────────────────
// Transition weights between generic types. Localised-only types (snow family,
// sleet, tornado) never appear here; GENERIC maps them back when the chain
// resumes from one of them.
const NEXT = {
    clear:           { sunny: 6, misty: 1, windy: 0.6 },
    sunny:           { clear: 2, mostly_sunny: 5, windy: 1, misty: 0.6 },
    mostly_sunny:    { sunny: 4, cloudy: 4, windy: 1 },
    cloudy:          { mostly_sunny: 4, rain: 4, foggy: 0.8, heavy_rain: 0.6, dry_lightning: 0.4, gale: 0.3, windy: 0.6 },
    rain:            { cloudy: 4, heavy_rain: 2, rain_lightning: 0.8, misty: 1, thunderstorm: 0.5 },
    heavy_rain:      { rain: 4, stormy: 1.5, thunderstorm: 1.5, rain_lightning: 1, hailstorm: 0.3 },
    stormy:          { heavy_rain: 3, thunderstorm: 1, gale: 1 },
    rain_lightning:  { heavy_rain: 2, lightning_storm: 1.5, rain: 1 },
    lightning_storm: { rain_lightning: 2, thunderstorm: 1.5, heavy_rain: 1 },
    dry_lightning:   { cloudy: 3, thunderstorm: 0.5 },
    thunderstorm:    { heavy_rain: 3, rain: 1, lightning_storm: 1, supercell: 0.45, hailstorm: 0.6 },
    supercell:       { thunderstorm: 3, hailstorm: 1 },
    hailstorm:       { thunderstorm: 2, heavy_rain: 2 },
    misty:           { sunny: 3, foggy: 1, clear: 1, cloudy: 1 },
    foggy:           { misty: 3, dense_fog: 1, cloudy: 1 },
    dense_fog:       { foggy: 3 },
    windy:           { sunny: 2, mostly_sunny: 2, gale: 0.6, cloudy: 1 },
    gale:            { windy: 3, stormy: 1 },
    dusty:           { windy: 2, sunny: 2 },
    ashy:            { cloudy: 2, mostly_sunny: 1 },
};
const GENERIC = {
    snow: 'rain', heavy_snow: 'heavy_rain', snowstorm: 'stormy', sleet: 'rain',
    freezing_rain: 'rain', tornado: 'supercell',
};
const FAIR   = new Set(['clear', 'sunny', 'mostly_sunny', 'windy']);
const FOGGY  = new Set(['misty', 'foggy', 'dense_fog']);
const CONVECTIVE = new Set(['thunderstorm', 'supercell', 'hailstorm', 'lightning_storm', 'rain_lightning']);

// Climate localisation of generic types.
const COLD_MAP = {
    rain: 'snow', heavy_rain: 'heavy_snow', stormy: 'snowstorm', rain_lightning: 'heavy_snow',
    lightning_storm: 'snowstorm', thunderstorm: 'snowstorm', supercell: 'snowstorm',
    hailstorm: 'snowstorm', gale: 'snowstorm',
};
const DRY_MAP = {
    rain: 'cloudy', heavy_rain: 'cloudy', stormy: 'dusty', rain_lightning: 'dry_lightning',
    lightning_storm: 'dry_lightning', thunderstorm: 'dry_lightning', supercell: 'dry_lightning',
    hailstorm: 'dry_lightning', windy: 'dusty', gale: 'dusty', misty: 'clear', foggy: 'sunny',
    dense_fog: 'sunny',
};
export const COLD_TEMP     = 0.20;   // below: snow
export const MARGINAL_TEMP = 0.27;   // below: sleet / freezing rain
export const DRY_PRECIP    = 0.40;   // biome precipitation below which rain dries up

/** Deterministic PRNG (mulberry32), so a seeded WeatherSystem is reproducible. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class WeatherSystem {
    constructor(seed = 1) {
        this.rand     = rng(seed ^ 0x5eed);
        this.mode     = 'dynamic';     // or a WEATHER id held fixed
        this.current  = 'sunny';       // generic type (dynamic) or the fixed type
        this.local    = 'sunny';       // what it actually is here, after localisation
        this.timer    = 600;           // seconds until the next dynamic change
        this.roll     = 0.5;           // per-event random: sleet vs freezing rain
        this.P        = new Float64Array(WEATHER.sunny.target);
        this.T        = new Float64Array(NP);
        this.tornado  = 0;             // seconds of tornado left (dynamic supercells)
        this.wet      = 0;             // 0..1 surface wetness
        this.ice      = 0;             // 0..1 glaze from freezing rain
        this.windAngle  = this.rand() * Math.PI * 2;
        this.windTarget = this.windAngle;
        this.wind     = [0, 0];        // current wind vector, blocks/s
        this.windSpeed = 0;
        this.time     = 0;             // seconds simulated (gust phase)
        this._gustPh  = [this.rand() * 6.3, this.rand() * 6.3, this.rand() * 6.3];
        this._fast    = 0;             // seconds of quickened easing after a manual change
        this.events   = [];            // lightning this update (reused)
        this._pool    = [];
    }

    get type() { return WEATHER[this.local]; }
    get label() { return this.type.label; }
    get tornadoActive() { return this.local === 'tornado'; }

    /** 'dynamic' or a WEATHER id. `immediate` snaps the parameters (world load). */
    setMode(mode, immediate = false) {
        if (mode !== 'dynamic' && !WEATHER[mode]) mode = 'dynamic';
        this.mode = mode;
        if (mode === 'dynamic') {
            this.current = GENERIC[this.current] ?? this.current;
            this.timer = this._duration(this.current);
        } else {
            this.current = mode;
            this.local = mode;
        }
        if (immediate) this.P.set(WEATHER[this.local].target);
        else this._fast = 20;
    }

    _duration(id) {
        const [a, b] = WEATHER[id]?.dur ?? [240, 600];
        return a + (b - a) * this.rand();
    }

    /** Pick the next generic type from the chain, weighted by time and climate. */
    _next(hours, climate) {
        const from = NEXT[this.current] ?? NEXT.sunny;
        const aff = climate?.affinity ?? {};
        const w = { ...from };
        if (FAIR.has(this.current) && aff.dusty > 0) w.dusty = (w.dusty ?? 0) + 3 * aff.dusty;
        if ((FAIR.has(this.current) || this.current === 'cloudy') && aff.ashy > 0) w.ashy = (w.ashy ?? 0) + 1.5 * aff.ashy;
        const dawn = hours >= 3 && hours <= 9, midday = hours >= 11 && hours <= 17;
        const afternoon = hours >= 13 && hours <= 19;
        let total = 0;
        for (const id in w) {
            if (FOGGY.has(id)) w[id] *= dawn ? 3 : midday ? 0.25 : 1;
            if (CONVECTIVE.has(id) && afternoon) w[id] *= 1.5;
            total += w[id];
        }
        let r = this.rand() * total;
        for (const id in w) { r -= w[id]; if (r <= 0) return id; }
        return Object.keys(w)[0];
    }

    /** The generic type as it is at this climate. */
    localise(id, climate) {
        if (this.mode !== 'dynamic' || !climate) return id;
        if (climate.temp < COLD_TEMP) return COLD_MAP[id] ?? id;
        if (climate.precipitation < DRY_PRECIP) return DRY_MAP[id] ?? id;
        if (climate.temp < MARGINAL_TEMP && (id === 'rain' || id === 'heavy_rain' || id === 'rain_lightning')) {
            return this.roll < 0.5 ? 'sleet' : 'freezing_rain';
        }
        if (id === 'supercell' && this.tornado > 0) return 'tornado';
        return id;
    }

    /**
     * Advance the weather.
     * @param {number} dt  seconds
     * @param {object} ctx { hours, climate, field (CloudField), px, pz, paused }
     *   While paused only the easing runs (so a change made from the pause menu
     *   still shows); the clock, the chain and lightning stand still.
     */
    update(dt, ctx = {}) {
        this.events.length = 0;
        const paused = !!ctx.paused;
        const hours = ctx.hours ?? 12;

        if (!paused) {
            this.time += dt;
            if (this.mode === 'dynamic') {
                // Fog burns off in the middle of the day.
                const burn = FOGGY.has(this.current) && hours >= 10 && hours <= 17 ? 3 : 1;
                this.timer -= dt * burn;
                if (this.tornado > 0) this.tornado -= dt;
                if (this.timer <= 0) {
                    const prev = this.current;
                    this.current = this._next(hours, ctx.climate);
                    this.timer = this._duration(this.current);
                    this.roll = this.rand();
                    this.windTarget += (this.rand() - 0.5) * 1.4;   // fronts shift the wind
                    if (this.current === 'supercell' && prev !== 'supercell' && this.rand() < 0.22) {
                        this.tornado = 150 + this.rand() * 130;
                    }
                }
            }
        }

        this.local = this.localise(this.current, ctx.climate);
        const T = this.T;
        T.set(WEATHER[this.local].target);
        if (this.mode === 'dynamic' && ctx.climate) {
            T[PRECIP] *= Math.min(1, Math.max(0, ctx.climate.precipitation));
            // Thundersnow: a thunderstorm that turned to snow keeps some lightning.
            if (this.local !== this.current && ctx.climate.temp < COLD_TEMP) {
                T[LIGHTNING] = Math.max(T[LIGHTNING], WEATHER[this.current].target[LIGHTNING] * 0.3);
            }
        }

        // Ease every parameter toward its target.
        const fast = this._fast > 0;
        if (fast) this._fast -= dt;
        for (let i = 0; i < NP; i++) {
            const tau = fast ? Math.min(TAU[i], 4) : TAU[i];
            this.P[i] += (T[i] - this.P[i]) * (1 - Math.exp(-dt / tau));
        }

        // Wind: direction drifts toward the front's, speed gusts.
        this.windTarget += (this.rand() - 0.5) * 0.02 * dt;
        this.windAngle += (this.windTarget - this.windAngle) * (1 - Math.exp(-dt / 60));
        const g = this._gustPh, t = this.time;
        const n = 0.5 * Math.sin(0.23 * t + g[0]) + 0.3 * Math.sin(0.61 * t + g[1]) + 0.2 * Math.sin(1.7 * t + g[2]);
        const gust = 1 + this.P[GUST] * (n > 0 ? n : n * 0.3);
        this.windSpeed = this.P[WIND] * gust;
        this.wind[0] = Math.cos(this.windAngle) * this.windSpeed;
        this.wind[1] = Math.sin(this.windAngle) * this.windSpeed;

        if (paused) return;

        // Surfaces get wet in rain and dry out slowly; freezing rain glazes them.
        const liquid = this.P[PRECIP] * (1 - this.P[SNOW]) * (1 - this.P[PELLET] * 0.5);
        const wetTarget = liquid > 0.05 ? 1 : 0;
        this.wet += (wetTarget - this.wet) * (1 - Math.exp(-dt / (wetTarget > this.wet ? 40 : 240)));
        const icing = this.P[FREEZING] > 0.5 && this.P[PRECIP] > 0.1;
        const warm = (ctx.climate?.temp ?? 0.5) > MARGINAL_TEMP && this.P[FREEZING] < 0.2;
        this.ice += ((icing ? 1 : 0) - this.ice) * (1 - Math.exp(-dt / (icing ? 90 : warm ? 180 : 600)));

        this._lightning(dt, ctx);
    }

    /** Poisson lightning, placed under thick cloud near the player. */
    _lightning(dt, ctx) {
        const rate = this.P[LIGHTNING];
        if (rate < 0.05) return;
        if (this.rand() >= rate / 60 * dt) return;
        const field = ctx.field, px = ctx.px ?? 0, pz = ctx.pz ?? 0;
        const ev = this._pool[this.events.length] ?? (this._pool[this.events.length] = {});
        ev.cloud = this.rand() < 0.35;      // cloud-to-cloud: a flash with no bolt
        ev.x = px; ev.z = pz; ev.dist = 0;
        for (let tries = 0; tries < 8; tries++) {
            const a = this.rand() * Math.PI * 2;
            // Now and then one lands close — that is what makes a storm frightening.
            const d = this.rand() < 0.04 ? 14 + this.rand() * 26 : 40 + 300 * Math.pow(this.rand(), 0.7);
            const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
            if (!field || field.thicknessAt(x, z) > 0.35 || tries === 7) {
                ev.x = x; ev.z = z; ev.dist = d;
                break;
            }
        }
        this.events.push(ev);
    }

    /** Precipitation reaching the ground at (x, z), 0..1. */
    precipAt(field, x, z) {
        if (this.P[PRECIP] < 0.005) return 0;
        return this.P[PRECIP] * field.rainMask(x, z);
    }

    toJSON() {
        return {
            mode: this.mode, current: this.current, timer: this.timer, roll: this.roll,
            tornado: this.tornado, wet: this.wet, ice: this.ice,
            windAngle: this.windAngle, windTarget: this.windTarget, P: Array.from(this.P),
        };
    }

    fromJSON(o) {
        if (!o) return;
        if (WEATHER[o.current]) this.current = o.current;
        if (Number.isFinite(o.timer)) this.timer = o.timer;
        if (Number.isFinite(o.roll)) this.roll = o.roll;
        if (Number.isFinite(o.tornado)) this.tornado = o.tornado;
        if (Number.isFinite(o.wet)) this.wet = o.wet;
        if (Number.isFinite(o.ice)) this.ice = o.ice;
        if (Number.isFinite(o.windAngle)) this.windAngle = o.windAngle;
        if (Number.isFinite(o.windTarget)) this.windTarget = o.windTarget;
        if (Array.isArray(o.P) && o.P.length === NP && o.P.every(Number.isFinite)) this.P.set(o.P);
        this.local = this.current;
    }
}

/** Snow/rain/pellet shares of the current precipitation (sums to 1). */
export function precipShares(P, out = [0, 0, 0]) {
    const snow = Math.min(1, Math.max(0, P[SNOW]));
    const pellet = Math.min(1 - snow, Math.max(0, P[PELLET]));
    out[0] = 1 - snow - pellet;   // rain
    out[1] = snow;
    out[2] = pellet;
    return out;
}
