// Frame-time benchmark of the real game on the real GPU.
//
//   npm run bench:render [-- scenario …]
//
// Boots the server, opens the game in headless Chrome/Edge with the GPU on and
// vsync and the frame-rate limit off (so a frame takes as long as it costs),
// starts a smooth world and measures, per scenario:
//
//   fps       frames per second over the measured window
//   p50/p95/p99/max   frame interval (ms)
//   >33ms     frames that would be visible hitches at 30 fps
//   tick      JS time inside the WorldJS_tick handler (game logic + render
//             submission), median / p95 — the main-thread share of a frame,
//             which also absorbs waiting on a GPU that has fallen behind
//   calls/tris, GPU geometry and texture counts, JS heap, and terrain shadow
//             redraws during the window (cached otherwise — see Shadows.js)
//
// Scenarios: the four graphics presets looking at the horizon, the Pro preset
// in a thunderstorm, and a fast fly-over that streams new chunks in (the
// hitch test). "preset+key=value" runs a preset with a setting changed.
//
//   BROWSER=<path>        browser to use (Chrome first: headless Edge can be
//                         marked hidden, and stop drawing, with the display off)
//   BENCH_W / BENCH_H     viewport, default 1920×1080
//   BENCH_MS              how long each preset is measured, default 5000 ms
//   BENCH_PROFILE=1       CPU profile of the main thread per scenario
//   BENCH_UNMIN=1         serve unminified three.js, so the profile names it
//   BENCH_PROGRAMS=1      list the shader programs after each scenario
//   BENCH_EVAL=<js>       evaluate an expression in the page after each scenario and print it
//   BENCH_JSON=<file>     also write the results as JSON
//   BENCH_GPU=discrete    run on the discrete GPU, as the desktop app does
//   BENCH_VSYNC=1         keep 60 Hz frame pacing (hitch test as a player sees it)
//   BENCH_NVSMI=1         also sample an NVIDIA GPU's load, power draw and
//                         temperature with nvidia-smi during each measurement.
//                         With BENCH_VSYNC=1 and BENCH_GPU=discrete this is what
//                         heats a laptop: the frame rate is fixed, so the watts
//                         are the cost of a frame
//   BENCH_GPU=swiftshader software rendering (useless for timing, checks the harness)
//
// A laptop's results move with its temperature and background load: compare
// runs made one after the other, and run a scenario twice before trusting it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BROWSER_CANDIDATES = [
    process.env.BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) { console.error('No Chromium-family browser found. Set BROWSER=<path>.'); process.exit(2); }

const DBG_PORT = 9900 + (process.pid % 90);
const W = +(process.env.BENCH_W ?? 1920), H = +(process.env.BENCH_H ?? 1080);
// BENCH_MS: how long each preset scenario is measured (ms).
const MEASURE_MS = +(process.env.BENCH_MS ?? 5000);

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-bench-'));
const { serverReady } = await import('../server/server.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

const gpuFlags = process.env.BENCH_GPU === 'swiftshader'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--ignore-gpu-blocklist'];
// BENCH_GPU=discrete: the switch the desktop app sets (electron/main.js) to
// run on the discrete GPU of a dual-GPU laptop.
if (process.env.BENCH_GPU === 'discrete') gpuFlags.push('--force_high_performance_gpu');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-bench-edge-'));
const browser = spawn(BROWSER, [
    '--headless=new',
    ...gpuFlags,
    // Uncapped by default, so a frame takes as long as it costs. BENCH_VSYNC=1
    // keeps Chrome's normal 60 Hz pacing instead — how a player sees it, and
    // the fair test for hitches.
    ...(process.env.BENCH_VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    // Windows otherwise decides the headless window is occluded now and then,
    // marks the page hidden and stops requestAnimationFrame mid-measurement.
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { browser.kill('SIGKILL'); } catch {} };
process.on('exit', kill);
process.on('uncaughtException', (e) => { console.error(e); kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); kill(); process.exit(1); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function targetWs() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('browser debugger never became reachable');
}
const ws = new WebSocket(await targetWs(), { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id != null) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push((m.params.args ?? []).map(a => a.value ?? a.description).join(' '));
    }
});
const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const dispatch = (name, data) => evalJs(`(() => { const e = new Event('WorldJS_${name}'); e.data = ${JSON.stringify(data)}; document.dispatchEvent(e); return 1; })()`);

await send('Runtime.enable');
await send('Page.enable');
// A page that believes it is in the background gets throttled.
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
// BENCH_UNMIN=1 serves the unminified three.js, so profiles name its functions.
if (process.env.BENCH_UNMIN) {
    const src = fs.readFileSync(new URL('../node_modules/three/build/three.module.js', import.meta.url));
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.method !== 'Fetch.requestPaused') return;
        send('Fetch.fulfillRequest', {
            requestId: m.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
            body: src.toString('base64'),
        });
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*three.module.min.js*' }] });
}
await send('Page.navigate', { url: `${base}/game.html` });
for (let i = 0; i < 80; i++) {
    await sleep(500);
    const up = await evalJs(`(() => { const t = document.getElementById('TitleScreen'); return !!t && !t.classList.contains('hidden'); })()`).catch(() => false);
    if (up) break;
}

const gpu = await evalJs(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
})()`);
console.log(`GPU: ${gpu}\nviewport: ${W}x${H}\n`);

// ── Instrumentation ──────────────────────────────────────────────────────────
// A capture listener on window runs before world.js's tick handler, and a
// document listener added now runs after it: the gap is the tick's JS time.
await evalJs(`(() => {
    const B = window.__bench = { on: false, frames: [], ticks: [], longTasks: [], last: 0, t0: 0, lost: 0 };
    const cv = document.getElementById('gameCanvas');
    cv?.addEventListener('webglcontextlost', () => { B.lost++; console.error('WebGL context lost'); });
    // Main-thread tasks over 50 ms: stalls that rAF intervals can miss.
    try {
        new PerformanceObserver((l) => { if (B.on) for (const e of l.getEntries()) B.longTasks.push(e.duration); })
            .observe({ type: 'longtask', buffered: false });
    } catch { /* unsupported */ }
    window.addEventListener('WorldJS_tick', () => { B.t0 = performance.now(); }, true);
    document.addEventListener('WorldJS_tick', () => { if (B.on) B.ticks.push(performance.now() - B.t0); });
    const loop = (t) => {
        if (B.on && B.last) B.frames.push(t - B.last);
        B.last = t;
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return 1;
})()`);

const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bench', seed: 2024, gameMode: 'CREATIVE' }),
})).json();
await evalJs(`startWorld(${JSON.stringify({ ...world, playerPos: { x: 0, y: 100, z: 0 } })}); 1`);
// Headless has no pointer lock, so the pause menu is up; hide it so only the
// game is measured.
await evalJs(`document.getElementById('PauseScreen').style.visibility = 'hidden'`).catch(() => {});

const PRESETS = {
    simple:  { renderDistance: 5,  farTerrain: 0,  resolutionScale: 0.75, fogStart: 0.65, shadows: 'off',    clouds: 'fast',  sky: 'simple', particles: 'low',    eyeAdaptation: 'off' },
    classic: { renderDistance: 8,  farTerrain: 0,  resolutionScale: 1.0,  fogStart: 0.75, shadows: 'off',    clouds: 'fast',  sky: 'simple', particles: 'medium', eyeAdaptation: 'off' },
    normal:  { renderDistance: 10, farTerrain: 16, resolutionScale: 1.0,  fogStart: 0.80, shadows: 'medium', clouds: 'fast',  sky: 'pretty', particles: 'medium', eyeAdaptation: 'on' },
    pro:     { renderDistance: 14, farTerrain: 32, resolutionScale: 1.0,  fogStart: 0.88, shadows: 'high',   clouds: 'fancy', sky: 'pretty', particles: 'high',   eyeAdaptation: 'on' },
};

async function settle(maxMs = 60000) {
    // Until the chunk count and mesh count stop changing for 2 s, with every
    // far-terrain tile built and shown.
    let prev = '', stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
        await sleep(500);
        const d = await evalJs(`(() => { const d = window.__wwDebug?.(); if (!d) return '';
            const f = d.far, farDone = !f || f.extra === 0 || (f.inflight === 0 && f.shown === f.wanted);
            return farDone ? d.meshes + '/' + d.chunks : 'far'; })()`);
        stable = d && d !== 'far' && d === prev ? stable + 1 : 0;
        prev = d;
        if (stable >= 4) return;
    }
}

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN;
// BENCH_PROFILE=1 samples the main thread during each measurement and prints
// the functions with the most self time.
const PROFILE = !!process.env.BENCH_PROFILE;
if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 250 }); }

function printProfile(profile, top = 30) {
    const self = new Map();
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
        const id = profile.samples[i];
        dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0));
    }
    let total = 0;
    for (const [id, us] of dt) {
        const n = byId.get(id);
        const cf = n.callFrame;
        const k = `${cf.functionName || '(anon)'}  ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
        self.set(k, (self.get(k) ?? 0) + us);
        total += us;
    }
    const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, top);
    for (const [k, us] of rows) console.log(`   ${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`);

    // The longest stretches without an idle sample — the hitches — and what
    // ran inside each.
    const label = (id) => {
        const cf = byId.get(id).callFrame;
        return `${cf.functionName || '(anon)'}  ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    };
    const runs = [];
    let start = 0, dur = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const d = profile.timeDeltas[i + 1] ?? 0;
        if (byId.get(profile.samples[i]).callFrame.functionName === '(idle)') {
            if (dur > 50000) runs.push({ start, end: i, dur });
            start = i + 1; dur = 0;
        } else dur += d;
    }
    runs.sort((a, b) => b.dur - a.dur);
    for (const r of runs.slice(0, 3)) {
        const m = new Map();
        for (let i = r.start; i < r.end; i++) {
            const k = label(profile.samples[i]);
            m.set(k, (m.get(k) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
        }
        console.log(`   busy stretch ${(r.dur / 1000).toFixed(0)} ms:`);
        for (const [k, us] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
            console.log(`      ${(us / 1000).toFixed(1).padStart(6)} ms  ${k}`);
        }
    }
}

// BENCH_TRACE=1 records a Chrome trace during each measurement and breaks every
// main-thread task over 50 ms into what ran inside it: the event that started
// it, the script functions it called, garbage collection.
const TRACE = !!process.env.BENCH_TRACE;
// BENCH_TRACE_MS: how long a task must be to be broken down (default 50 ms).
const TRACE_MS = +(process.env.BENCH_TRACE_MS ?? 50);
const traceEvents = [];
ws.on('message', (raw) => {
    if (!TRACE) return;
    const m = JSON.parse(raw.toString());
    if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value);
});
let traceDone = null;
ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Tracing.tracingComplete') traceDone?.();
});

function printTrace() {
    const main = traceEvents.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    if (!main) { console.log('   (no renderer main thread in trace)'); return; }
    const onMain = traceEvents.filter(e => e.pid === main.pid && e.tid === main.tid && e.ph === 'X');
    const t0 = Math.min(...onMain.map(e => e.ts));
    const tasks = onMain.filter(e => e.name === 'RunTask' && e.dur > TRACE_MS * 1000).sort((a, b) => b.dur - a.dur);
    console.log('   long tasks at: ' + tasks.slice().sort((a, b) => a.ts - b.ts)
        .map(t => `${((t.ts - t0) / 1e6).toFixed(2)}s (${(t.dur / 1000).toFixed(0)} ms)`).join(', '));
    for (const t of tasks.slice(0, 5)) {
        const inside = onMain.filter(e => e !== t && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur);
        const agg = new Map();
        for (const e of inside) {
            const d = e.args?.data ?? {};
            let k = null;
            if (e.name === 'FunctionCall') k = `call ${d.functionName || '(anon)'} ${String(d.url ?? '').split('/').pop()}:${d.lineNumber ?? ''}`;
            else if (/GC|Scavenge|MarkCompact/i.test(e.name)) k = `gc ${e.name}`;
            else if (e.name === 'EventDispatch') k = `event ${d.type}`;
            else if (['FireAnimationFrame', 'TimerFire', 'ParseHTML', 'CompileScript', 'EvaluateScript'].includes(e.name)) k = e.name;
            if (k) agg.set(k, (agg.get(k) ?? 0) + e.dur);
        }
        // With BENCH_PROFILE too, the samples taken inside this task (the
        // profile and the trace share a clock).
        if (lastProfile) {
            const p = lastProfile, byId = new Map(p.nodes.map(n => [n.id, n]));
            let ts = p.startTime;
            for (let i = 0; i < p.samples.length; i++) {
                ts += p.timeDeltas[i] ?? 0;
                if (ts < t.ts || ts > t.ts + t.dur) continue;
                const cf = byId.get(p.samples[i]).callFrame;
                const k = `  self ${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
                agg.set(k, (agg.get(k) ?? 0) + (p.timeDeltas[i + 1] ?? 0));
            }
        }
        console.log(`   task ${(t.dur / 1000).toFixed(0)} ms:`);
        for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, lastProfile ? 14 : 6)) {
            console.log(`      ${(us / 1000).toFixed(1).padStart(6)} ms  ${k}`);
        }
    }
    traceEvents.length = 0;
}
let lastProfile = null;

// Load during a measurement. Always: the whole machine's CPU busy share (all
// cores, background programs included — on a laptop the CPU and GPU usually
// share one cooler, so CPU heat warms the GPU too). With BENCH_NVSMI=1, also
// nvidia-smi's GPU samples every 250 ms: busy share, power draw, graphics clock
// and the highest temperature. stop() returns the averages.
function cpuTimes() {
    let busy = 0, total = 0;
    for (const c of os.cpus()) {
        const t = c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
        total += t;
        busy += t - c.times.idle;
    }
    return { busy, total };
}
function loadSampler() {
    const cpu0 = cpuTimes();
    const rows = [];
    let p = null, buf = '';
    if (process.env.BENCH_NVSMI) {
        p = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,power.draw,clocks.gr,temperature.gpu',
            '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
        p.on('error', () => {});
        p.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const v = buf.slice(0, i).split(',').map(Number);
                buf = buf.slice(i + 1);
                if (v.length === 4 && v.every(Number.isFinite)) rows.push(v);
            }
        });
    }
    return () => {
        try { p?.kill(); } catch {}
        const cpu1 = cpuTimes();
        const out = { cpu: Math.round(100 * (cpu1.busy - cpu0.busy) / Math.max(1, cpu1.total - cpu0.total)) };
        // The first samples still see the load before the window began.
        const r = rows.slice(Math.min(2, Math.max(0, rows.length - 1)));
        if (r.length) {
            const avg = (k) => r.reduce((s, x) => s + x[k], 0) / r.length;
            out.gpu = { util: Math.round(avg(0)), watts: +avg(1).toFixed(1), mhz: Math.round(avg(2)),
                        temp: Math.max(...r.map(x => x[3])) };
        }
        return out;
    };
}

async function measure(ms, perFrameJs = null) {
    if (perFrameJs) await evalJs(`window.__benchStep = ${perFrameJs}; 1`);
    const stopLoad = loadSampler();
    if (PROFILE) await send('Profiler.start');
    if (TRACE) await send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute'] },
    });
    await evalJs(`(() => {
        const B = window.__bench; B.frames = []; B.ticks = []; B.last = 0; B.on = true;
        B.sr0 = window.__wwDebug()?.shadowRedraws ?? 0;
        if (window.__benchStep) {
            const step = (t) => { if (!B.on) return; window.__benchStep(t); requestAnimationFrame(step); };
            requestAnimationFrame(step);
        }
        return 1;
    })()`);
    await sleep(ms);
    const load = stopLoad();
    const r = await evalJs(`(() => { const B = window.__bench; B.on = false; window.__benchStep = null;
        const lt = B.longTasks; B.longTasks = [];
        const dbg = window.__wwDebug();
        return { frames: B.frames, ticks: B.ticks, longTasks: lt, dbg, shadowRedraws: (dbg.shadowRedraws ?? 0) - B.sr0 }; })()`);
    if (PROFILE) {
        lastProfile = (await send('Profiler.stop')).profile;
        if (!TRACE) printProfile(lastProfile);
    }
    if (TRACE) {
        const done = new Promise(res => { traceDone = res; });
        await send('Tracing.end');
        await done;
        printTrace();
    }
    if (r.frames.length === 0) {
        const diag = await evalJs(`(async () => {
            const gl = document.getElementById('gameCanvas').getContext('webgl2');
            const raf = await Promise.race([
                new Promise(res => requestAnimationFrame(() => res('fired'))),
                new Promise(res => setTimeout(() => res('timeout'), 2000)),
            ]);
            return { lost: gl?.isContextLost(), lostEvents: window.__bench.lost, raf,
                     vis: document.visibilityState, gameStarted: typeof gameStarted !== 'undefined' ? gameStarted : '?' };
        })()`, true);
        console.log('   no frames:', JSON.stringify(diag));
    }
    const lt = r.longTasks.sort((a, b) => b - a);
    if (lt.length) console.log(`   long tasks: ${lt.length}, longest ${lt.slice(0, 5).map(x => x.toFixed(0)).join(', ')} ms`);
    const f = r.frames.slice().sort((a, b) => a - b);
    const t = r.ticks.slice().sort((a, b) => a - b);
    const total = r.frames.reduce((s, x) => s + x, 0);
    if (f.length === 0) f.push(ms);   // not one frame completed in the window
    return {
        far: r.dbg.far?.extra ? r.dbg.far.shown : 0,
        fps: +(r.frames.length / (Math.max(total, ms) / 1000)).toFixed(1),
        p50: +pct(f, 0.5).toFixed(2), p95: +pct(f, 0.95).toFixed(2), p99: +pct(f, 0.99).toFixed(2),
        max: +f[f.length - 1].toFixed(1),
        hitches: r.frames.filter(x => x > 33.4).length,
        tick50: +(pct(t, 0.5) || 0).toFixed(2), tick95: +(pct(t, 0.95) || 0).toFixed(2),
        drawCalls: r.dbg.drawCalls, tris: r.dbg.tris, meshes: r.dbg.meshes, programTypes: r.dbg.programTypes,
        geometries: r.dbg.geometries, textures: r.dbg.textures, programs: r.dbg.programs,
        shadowRedraws: r.shadowRedraws, mobs: r.dbg.mobs, load,
        heapMB:await evalJs(`Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)`),
        evaluated: process.env.BENCH_EVAL ? await evalJs(process.env.BENCH_EVAL).catch(e => String(e)) : undefined,
    };
}

function report(name, m) {
    console.log(`${name.padEnd(22)} ${String(m.fps).padStart(6)} fps  p50 ${String(m.p50).padStart(6)}  p95 ${String(m.p95).padStart(6)}  p99 ${String(m.p99).padStart(6)}  max ${String(m.max).padStart(6)}  >33ms ${String(m.hitches).padStart(3)}  tick ${m.tick50}/${m.tick95} ms  calls ${m.drawCalls}  tris ${m.tris}  [geo ${m.geometries} tex ${m.textures} prog ${m.programs} heap ${m.heapMB}MB]  shadow redraws ${m.shadowRedraws} mobs ${m.mobs}${m.far ? `  far tiles ${m.far}` : ''}  CPU ${m.load.cpu}%${m.load.gpu ? `  GPU ${m.load.gpu.util}% ${m.load.gpu.mhz} MHz ${m.load.gpu.watts} W ${m.load.gpu.temp}°C` : ''}`);
    if (process.env.BENCH_PROGRAMS) console.log('   programs:', (m.programTypes ?? []).join(', '));
    if (m.evaluated !== undefined) console.log('   eval:', JSON.stringify(m.evaluated));
}

const want = process.argv.slice(2);
const run = (n) => want.length === 0 || want.includes(n);

// "preset+key=value+…" runs a preset with some settings changed, e.g.
// normal+shadows=off or pro+clouds=fast+resolutionScale=0.5 — for pricing one
// effect at a time.
for (const w of want) {
    if (!w.includes('+')) continue;
    const [base, ...mods] = w.split('+');
    if (!PRESETS[base]) continue;
    const p = { ...PRESETS[base] };
    for (const m of mods) {
        const [k, v] = m.split('=');
        p[k] = v === undefined ? true : isNaN(+v) ? v : +v;
    }
    PRESETS[w] = p;
}

// Noon, sunny, spectator (free flight, no physics pulling the camera around).
await dispatch('setGameMode', { gameMode: 'SPECTATOR' });
await dispatch('setAtmosphere', { hours: 12, weather: 'sunny', immediate: true, daylightCycle: false });

// Look out over the land from a little above the spawn surface.
const spawnY = await evalJs(`(async () => {
    for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 250)); if (window.__wwDebug()?.meshes > 20) break; }
    return window.me.position.y;
})()`, true);
await evalJs(`window.me.position = { x: 0.5, y: ${spawnY} + 12, z: 0.5 }; 1`);

const results = {};
for (const [name, preset] of Object.entries(PRESETS)) {
    if (!run(name)) continue;
    await dispatch('applySettings', preset);
    await settle();
    await sleep(1000);
    results[name] = await measure(MEASURE_MS);
    report(name, results[name]);
}

if (run('storm')) {
    await dispatch('applySettings', PRESETS.pro);
    await dispatch('setAtmosphere', { hours: 16, weather: 'thunderstorm', immediate: true });
    await settle();
    await sleep(1500);
    results.storm = await measure(5000);
    report('pro-thunderstorm', results.storm);
    await dispatch('setAtmosphere', { hours: 12, weather: 'sunny', immediate: true });
}

// Stream new terrain in: fly along +X at 40 blocks/s at the Normal preset.
// "fly+key=value" changes a setting for it, as for the presets.
for (const w of want.length ? want.filter(w => w === 'fly' || w.startsWith('fly+')) : ['fly']) {
    const p = { ...PRESETS.normal };
    for (const m of w.split('+').slice(1)) {
        const [k, v] = m.split('=');
        p[k] = v === undefined ? true : isNaN(+v) ? v : +v;
    }
    await dispatch('applySettings', p);
    await settle();
    results[w] = await measure(10000, `(() => { let last = 0; return (t) => {
        const dt = last ? Math.min((t - last) / 1000, 0.1) : 0; last = t;
        window.me.position.x += 40 * dt;
    }; })()`);
    report(w.replace(/^fly/, 'fly-normal'), results[w]);
}

console.log(`\nerrors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('   ', String(e).slice(0, 300));
if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify({ gpu, W, H, results }, null, 2));

try { ws.close(); } catch {}
kill();
await sleep(300);
process.exit(0);
