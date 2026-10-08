// Day cycle and weather (engine/DayCycle.js, CloudField.js, Weather.js,
// Climate.js): the clock and the sun's path, the cloud field's coverage and
// where it rains, the weather chain and its climate localisation, lightning
// placement, and save round-trips. Pure modules — no browser.
import {
    DayCycle, newSkyState, sunDirection, moonIllumination, DAY_LENGTH,
} from '../src/scripts/engine/DayCycle.js';
import { CloudField, CLOUD_PERIOD_A, CLOUD_MIX_A, THICK_GAIN, COVER_SOFT } from '../src/scripts/engine/CloudField.js';
import {
    WeatherSystem, WEATHER, WEATHER_IDS, COVER, PRECIP, SNOW, FREEZING, LIGHTNING, FOG,
} from '../src/scripts/engine/Weather.js';
import { Climate, newClimate } from '../src/scripts/engine/Climate.js';
import { SUN_DIR } from '../src/scripts/engine/Sun.js';
import { ATMOS_GLSL } from '../src/scripts/AtmosGLSL.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}
const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const deg = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180 / Math.PI;

// ── Day cycle ────────────────────────────────────────────────────────────────
{
    const rise = sunDirection(6 / 24), noon = sunDirection(0.5), set = sunDirection(18 / 24);
    check('sun rises in the east at 6:00', Math.abs(rise[1]) < 1e-9 && rise[0] > 0.99);
    check('sun sets in the west at 18:00', Math.abs(set[1]) < 1e-9 && set[0] < -0.99);
    check('sun at noon is close to the baked SUN_DIR', deg(noon, SUN_DIR) < 20, `${deg(noon, SUN_DIR).toFixed(1)}°`);
    check('sun is below the horizon at midnight', sunDirection(0)[1] < -0.8);

    const d = new DayCycle();
    d.setHours(23);
    d.advance(DAY_LENGTH / 24 * 2);          // two game hours
    check('the clock wraps past midnight into the next day', d.day === 1 && Math.abs(d.hours - 1) < 1e-6, `day ${d.day} ${d.hours.toFixed(3)}h`);
    d.running = false;
    const before = d.time;
    d.advance(100);
    check('a stopped daylight cycle does not advance', d.time === before);

    check('the first night has a full moon', Math.abs(moonIllumination(0) - 1) < 1e-9);
    check('four days later the moon is new', moonIllumination(4) < 1e-9);

    // Every colour finite; night still playable; direct light fades out at the horizon.
    // Sampled every ~4 game seconds: a smooth change moves lum(direct) by well
    // under 0.005 per step, so anything bigger is a discontinuity.
    const s = newSkyState();
    let finite = true, nightMin = Infinity, dayMax = 0, jump = 0, prev = null;
    for (let i = 0; i <= 24000; i++) {
        d.time = i / 24000;
        d.sample(s);
        for (const k of ['zenith', 'horizon', 'flat', 'ambient', 'direct', 'glow']) {
            if (!s[k].every(Number.isFinite) || s[k].some(v => v < 0)) finite = false;
        }
        const l = lum(s.ambient);
        if (s.sunHeight < -0.3) nightMin = Math.min(nightMin, l);
        dayMax = Math.max(dayMax, l);
        const dl = lum(s.direct);
        if (prev !== null) jump = Math.max(jump, Math.abs(dl - prev));
        prev = dl;
    }
    check('sky colours are finite and non-negative all day', finite);
    check('noon is full brightness', Math.abs(dayMax - 1) < 0.02, dayMax.toFixed(3));
    check('night is dark but playable', nightMin > 0.12 && nightMin < 0.3, nightMin.toFixed(3));
    check('direct light never jumps (sun/moon handover is invisible)', jump < 0.005, jump.toFixed(4));
    d.time = 5.9 / 24; d.sample(s);
    check('the moon lights the world before dawn', s.lightDir[1] > 0 && s.directStrength >= 0);

    const j = new DayCycle(); j.fromJSON({ time: 0.3, day: 5 });
    check('clock round-trips through JSON', j.time === 0.3 && j.day === 5);
    j.fromJSON({ time: 'x', day: NaN });
    check('corrupt saved time is ignored', j.time === 0.3 && j.day === 5);
}

// ── Cloud field ──────────────────────────────────────────────────────────────
{
    const f = new CloudField(7);
    const pts = [];
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 4000; i++) pts.push([rnd() * CLOUD_PERIOD_A * 3 - 3000, rnd() * CLOUD_PERIOD_A * 3 - 3000]);

    let worst = 0;
    for (const c of [0.15, 0.4, 0.6, 0.85]) {
        f.setCoverage(c);
        let n = 0;
        for (const [x, z] of pts) if (f.noise(x, z) > f.threshold) n++;
        worst = Math.max(worst, Math.abs(n / pts.length - c));
    }
    check('coverage fraction means what it says', worst < 0.06, `worst error ${worst.toFixed(3)}`);

    f.setCoverage(0);
    check('fully clear has no cloud anywhere', pts.every(([x, z]) => f.cover(f.noise(x, z)) === 0 && f.rainMask(x, z) === 0));

    f.setCoverage(1.08);
    check('full overcast has no gaps', pts.every(([x, z]) => f.cover(f.noise(x, z)) === 1));
    f.rainBase = 0.45;
    const masks = pts.map(([x, z]) => f.rainMask(x, z));
    check('heavy rain falls everywhere, lighter in thinner cloud',
        Math.min(...masks) >= 0.45 - 1e-9 && Math.max(...masks) > 0.9,
        `min ${Math.min(...masks).toFixed(2)} max ${Math.max(...masks).toFixed(2)}`);

    // Rain: open patches stay dry, darker cloud rains more.
    f.setCoverage(0.78); f.rainBase = 0;
    let dryOpen = true, monotone = true;
    for (const [x, z] of pts) {
        const n = f.noise(x, z);
        if (f.cover(n) === 0 && f.rainMask(x, z) !== 0) dryOpen = false;
    }
    const byThick = pts.map(([x, z]) => [f.thicknessAt(x, z), f.rainMask(x, z)]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < byThick.length; i++) if (byThick[i][1] < byThick[i - 1][1] - 1e-9 && byThick[i][0] > byThick[i - 1][0]) {
        // Mask depends on cover × thickness; both rise with the noise, so rain rises with thickness.
        monotone = false;
    }
    check('rain: open patches stay dry', dryOpen);
    check('rain: thicker (darker) cloud rains more', monotone);

    // Drift: the broad layer moves exactly with the wind, and wraps seamlessly.
    const g = new CloudField(7);
    const a = g._tex((100 + g.offA[0]) / CLOUD_PERIOD_A, (50 + g.offA[1]) / CLOUD_PERIOD_A);
    g.drift(30, -12);
    const b = g._tex((130 + g.offA[0]) / CLOUD_PERIOD_A, (38 + g.offA[1]) / CLOUD_PERIOD_A);
    check('clouds drift with the wind', Math.abs(a - b) < 1e-6);
    for (let i = 0; i < 5000; i++) g.drift(9.3, 4.1, 0.1);
    check('drift offsets stay wrapped', g.offA.every(v => v >= 0 && v < CLOUD_PERIOD_A) && g.offB.every(v => v >= 0 && v < 512));

    // The GPU twin uses the same constants.
    const has = (x) => ATMOS_GLSL.includes(Number(x).toFixed(6));
    check('GLSL cloud field matches CloudField constants',
        has(1 / CLOUD_PERIOD_A) && has(CLOUD_MIX_A) && has(THICK_GAIN) && has(COVER_SOFT));
}

// ── Weather ──────────────────────────────────────────────────────────────────
const TEMPERATE = { temp: 0.6, humidity: 0.5, precipitation: 1, affinity: {} };
const COLD      = { temp: 0.08, humidity: 0.3, precipitation: 1, affinity: {} };
const MARGINAL  = { temp: 0.24, humidity: 0.4, precipitation: 1, affinity: {} };
const DESERT    = { temp: 0.9, humidity: 0.1, precipitation: 0.12, affinity: { dusty: 1 } };

function simulate(climate, seconds, seed = 1, field = null) {
    const w = new WeatherSystem(seed);
    const seen = {}, generic = new Set();
    let maxPrecip = 0, t = 0;
    for (; t < seconds; t += 1) {
        w.update(1, { hours: (t / 50) % 24, climate, field, px: 0, pz: 0 });
        seen[w.local] = (seen[w.local] ?? 0) + 1;
        generic.add(w.current);
        maxPrecip = Math.max(maxPrecip, w.P[PRECIP]);
    }
    return { w, seen, generic, maxPrecip };
}

{
    check('every weather type has finite targets', WEATHER_IDS.every(id => WEATHER[id].target.every(Number.isFinite)));
    check('all 26 requested weather types exist', WEATHER_IDS.length === 26, `${WEATHER_IDS.length}`);

    const t = simulate(TEMPERATE, 400000, 3);
    const kinds = Object.keys(t.seen);
    check('dynamic weather wanders through many types', kinds.length >= 12, kinds.join(' '));
    check('the chain never holds a snow/sleet/tornado type directly',
        ![...t.generic].some(id => ['snow', 'heavy_snow', 'snowstorm', 'sleet', 'freezing_rain', 'tornado'].includes(id)));
    const fair = ['clear', 'sunny', 'mostly_sunny', 'cloudy', 'windy'].reduce((a, k) => a + (t.seen[k] ?? 0), 0);
    check('fair weather is the most common', fair / 400000 > 0.45, `${(fair / 4000).toFixed(1)}%`);
    check('no snow in a temperate climate', !t.seen.snow && !t.seen.heavy_snow);

    const c = simulate(COLD, 200000, 3);
    check('it snows where it is cold', (c.seen.snow ?? 0) + (c.seen.heavy_snow ?? 0) + (c.seen.snowstorm ?? 0) > 0);
    check('no rain types where it is cold', !c.seen.rain && !c.seen.heavy_rain && !c.seen.thunderstorm);

    const m = simulate(MARGINAL, 200000, 5);
    check('sleet and freezing rain at the freezing line', (m.seen.sleet ?? 0) > 0 && (m.seen.freezing_rain ?? 0) > 0);

    const d = simulate(DESERT, 200000, 3);
    check('the desert never gets rain', !d.seen.rain && !d.seen.heavy_rain && d.maxPrecip < 0.05, `max precip ${d.maxPrecip.toFixed(3)}`);
    check('the desert gets dust', (d.seen.dusty ?? 0) > 0);
    check('ash only where a biome allows it', !t.seen.ashy && !d.seen.ashy);
    const ash = simulate({ ...TEMPERATE, affinity: { ashy: 2 } }, 200000, 3);
    check('an ashy biome gets ash', (ash.seen.ashy ?? 0) > 0);

    // Fog forms around dawn more than at midday.
    const fogStarts = { dawn: 0, midday: 0 };
    for (let seed = 1; seed <= 6; seed++) {
        const w = new WeatherSystem(seed);
        let prev = w.current;
        for (let s = 0; s < 150000; s++) {
            const hours = (s / 50) % 24;
            w.update(1, { hours, climate: TEMPERATE });
            if (w.current !== prev && ['misty', 'foggy', 'dense_fog'].includes(w.current) && !['misty', 'foggy', 'dense_fog'].includes(prev)) {
                if (hours >= 3 && hours <= 9) fogStarts.dawn++;
                if (hours >= 11 && hours <= 17) fogStarts.midday++;
            }
            prev = w.current;
        }
    }
    check('fog forms around dawn, not midday', fogStarts.dawn > fogStarts.midday * 3, `${fogStarts.dawn} vs ${fogStarts.midday}`);

    // Fixed mode holds exactly the chosen type, with no localisation.
    const f = new WeatherSystem(2);
    f.setMode('snow', true);
    for (let s = 0; s < 20000; s++) f.update(1, { hours: 12, climate: DESERT });
    check('fixed weather holds (snow in the desert if you ask for it)', f.local === 'snow' && f.P[SNOW] > 0.99 && f.P[PRECIP] > 0.4);
    f.setMode('freezing_rain');
    for (let s = 0; s < 600; s++) f.update(1, { hours: 12, climate: TEMPERATE });
    check('freezing rain glazes surfaces', f.P[FREEZING] > 0.99 && f.ice > 0.9, `ice ${f.ice.toFixed(2)}`);
    f.setMode('dense_fog');
    for (let s = 0; s < 300; s++) f.update(1, { hours: 12 });
    check('dense fog is denser than fog, which is denser than mist',
        WEATHER.dense_fog.target[FOG] > WEATHER.foggy.target[FOG] && WEATHER.foggy.target[FOG] > WEATHER.misty.target[FOG] && f.P[FOG] > 0.15);
    check('a changed weather rolls in rather than switching', (() => {
        const w = new WeatherSystem(4); w.setMode('clear', true);
        w.setMode('heavy_rain');
        w.update(1, { hours: 12 });
        return w.P[COVER] > 0 && w.P[COVER] < 1;
    })());

    // Paused: nothing advances.
    const p = new WeatherSystem(9);
    const timer = p.timer;
    for (let s = 0; s < 1000; s++) p.update(1, { hours: 12, climate: TEMPERATE, paused: true });
    check('paused weather stands still', p.timer === timer && p.events.length === 0);

    // Lightning: only in lightning weather, under thick cloud.
    const field = new CloudField(3);
    const L = new WeatherSystem(11);
    L.setMode('lightning_storm', true);
    let strikes = 0, underCloud = 0, dry = 0;
    for (let s = 0; s < 3000; s++) {
        field.setCoverage(L.P[COVER]);
        L.update(1, { hours: 15, field, px: 0, pz: 0 });
        for (const e of L.events) {
            strikes++;
            if (field.thicknessAt(e.x, e.z) > 0.35) underCloud++;
        }
    }
    const perMin = strikes / 50;
    check('lightning storm strikes at about its rate', perMin > 3.5 && perMin < 9, `${perMin.toFixed(1)}/min`);
    check('lightning strikes under thick cloud', underCloud / Math.max(1, strikes) > 0.9, `${underCloud}/${strikes}`);
    const S = new WeatherSystem(11); S.setMode('sunny', true);
    for (let s = 0; s < 3000; s++) { S.update(1, { hours: 12 }); dry += S.events.length; }
    check('no lightning on a sunny day', dry === 0 && S.P[LIGHTNING] < 0.01);

    // Tornado: fixed tornado weather is always active; supercells sometimes spawn one.
    const T = new WeatherSystem(1); T.setMode('tornado', true); T.update(1, { hours: 16 });
    check('tornado weather has a tornado', T.tornadoActive);

    // Save/load.
    const w = t.w;
    const r = new WeatherSystem(99);
    r.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
    check('weather round-trips through JSON', r.current === w.current && r.P.every((v, i) => v === w.P[i]) && r.wet === w.wet);
    r.fromJSON({ current: 'volcano', P: [1, 2] });
    check('corrupt saved weather is ignored', r.current === w.current);
}

// ── Climate ──────────────────────────────────────────────────────────────────
{
    const biomes = [
        { name: 'PLAINS', temperature: 0.6, humidity: 0.5 },
        { name: 'DESERT', temperature: 0.9, humidity: 0.1, weather: { precipitation: 0.12, dusty: 1 } },
        { name: 'SNOWY_PLAINS', temperature: 0.1, humidity: 0.3 },
        { name: 'OCEAN', temperature: 0.5, humidity: 1.0 },
    ];
    const cl = new Climate(1234, biomes);
    const out = newClimate();
    let finite = true, sawDry = false, sawCold = false;
    for (let i = 0; i < 400; i++) {
        cl.at(i * 997 - 200000, 70, i * 613 - 120000, out);
        if (![out.temp, out.humidity, out.precipitation].every(Number.isFinite)) finite = false;
        if (out.precipitation < 0.4) sawDry = true;
        if (out.temp < 0.2) sawCold = true;
    }
    check('climate is finite everywhere', finite);
    check('the world has dry and cold places', sawDry && sawCold);
    const low = cl.at(500, 70, 500, newClimate()).temp;
    const high = cl.at(500, 220, 500, newClimate()).temp;
    check('it is colder higher up', high < low - 0.25, `${low.toFixed(2)} → ${high.toFixed(2)}`);
}

// Worlds from the current generator (worldGen 2): the climate is the column's
// own, from the same geography the terrain comes from, and its biome's weather.
{
    const { Geography, LAPSE_START, LAPSE_RATE } = await import('../src/scripts/workers/Geography.js');
    const above = (y) => Math.max(0, y - LAPSE_START);
    const { BiomeSet } = await import('../src/scripts/workers/Biomes.js');
    const fs = await import('node:fs');
    const dir = new URL('../data/biomes/', import.meta.url);
    const biomes = fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
    const cl = new Climate(1234, biomes, 2);
    const geo = new Geography(1234, new BiomeSet(biomes));
    const out = newClimate();
    let finite = true, sawDry = false, sawCold = false, matches = true, deserts = 0, dustyDeserts = 0;
    for (let i = 0; i < 300; i++) {
        const x = i * 997 - 150000, z = i * 613 - 90000;
        const c = geo.column(x, z);
        const b = geo.biomes.list[c.biome];
        cl.at(x + 0.5, c.top + 1, z + 0.5, out);
        if (![out.temp, out.humidity, out.precipitation].every(Number.isFinite)) finite = false;
        if (out.precipitation < 0.4) sawDry = true;
        if (out.temp < 0.2) sawCold = true;
        // Standing on the ground (one block above the top), the climate is the
        // column's, cooled for that one block.
        const want = c.temp - (above(c.top + 1) - above(c.top)) * LAPSE_RATE;
        if (Math.abs(out.temp - want) > 1e-9) matches = false;
        if (b.name === 'DESERT') { deserts++; if (out.affinity.dusty > 0 && out.precipitation < 0.2) dustyDeserts++; }
    }
    check('current worlds: climate is finite everywhere', finite);
    check('current worlds: there are dry and cold places', sawDry && sawCold);
    check('current worlds: on the ground, the climate is the column\'s own', matches);
    check('current worlds: a desert brings its own weather', deserts === 0 || dustyDeserts === deserts, `${dustyDeserts}/${deserts}`);
    const c = geo.column(500, 500);
    const low = cl.at(500, c.top + 1, 500, newClimate()).temp;
    const high = cl.at(500, c.top + 150, 500, newClimate()).temp;
    check('current worlds: it is colder higher up', high < low - 0.25, `${low.toFixed(2)} → ${high.toFixed(2)}`);
}

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall weather checks passed');
