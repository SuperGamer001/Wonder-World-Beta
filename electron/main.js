/**
 * Wonder World — Electron launcher (main process).
 *
 * The game is a web app served by the bundled Express + WebSocket server.
 * This launcher:
 *   1. Points the server's writable data dir at the per-user app-data folder
 *      (the packaged app files are read-only).
 *   2. Boots the server in-process and waits until it is listening, then reads
 *      back the port the OS assigned it.
 *   3. Opens a window pointing at the local server, restoring its previous
 *      size and position.
 *
 * No Node integration is exposed to the page — the renderer is the plain web
 * game and talks to the server over HTTP/WebSocket like in a browser.
 *
 * Everything it does on the way up is written to launcher.log (below): a launch
 * that fails before the game's window has anything in it leaves nothing on
 * screen to go on, and on a Mac that was all a player had to report.
 */
import { app, BrowserWindow, shell, dialog, screen, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Route all writable game data (worlds, settings, screenshots) to a per-user
// writable location. Must be set BEFORE the server module is imported, because
// the server resolves its data paths at import time.
process.env.WONDER_DATA_DIR = app.getPath('userData');

// ── The launch log ────────────────────────────────────────────────────────────
// <data folder>/logs/launcher.log — on a Mac ~/Library/Application Support/
// Wonder World/logs, on Windows %APPDATA%\Wonder World\logs. Help → Show Launch
// Log (macOS) opens it in Finder, and every error box names it. Written as it
// happens, synchronously, so a launch that hangs or is killed still leaves what
// it got through. The one before is kept as launcher.old.log.
const LOG_DIR  = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'launcher.log');
function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch { /* the log is a help, never a reason to fail */ }
    console.log(line.trimEnd());
}
// A new log for each launch — once this copy is the one running (below): a
// second launch, which only hands over to the first, must not set its log aside.
function startLog() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'launcher.old.log'));
    } catch { /* as above */ }
    log(`Wonder World ${app.getVersion()} starting`, {
        platform: process.platform, os: `${os.type()} ${process.getSystemVersion?.() ?? os.release()}`,
        arch: process.arch, rosetta: app.runningUnderARM64Translation ?? false,
        electron: process.versions.electron, packaged: app.isPackaged, exe: app.getPath('exe'),
    });
}

// Render on the discrete GPU of a dual-GPU laptop. Chromium otherwise runs
// WebGL on the integrated GPU even though the game asks for 'high-performance'
// — measured on an Intel iGPU + RTX 2050 laptop, the discrete GPU ran the
// Normal preset at ~440 fps instead of ~160, and Pro at ~160 instead of ~105.
// Ignored on machines with one GPU. Must be set before the app is ready.
// Windows only: that is where it was measured, and a Mac picks its GPU itself —
// forcing the switch there gained nothing and was one more way for an older
// Mac's graphics to fail.
if (process.platform === 'win32') app.commandLine.appendSwitch('force_high_performance_gpu');

// The menu music starts with the game. A browser makes a page wait for a click
// before it may make a sound; this is the game's own window, so it need not.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow   = null;
let serverOrigin = null;

const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

// The embedded server now binds an OS-assigned port, so a second copy would not
// collide — but two instances would still fight over the same world save files.
// Allow only one and focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    log('another copy is already running: handing over to it');
    app.quit();
} else {
    startLog();
    app.on('second-instance', () => {
        log('opened again while running');
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        } else if (serverOrigin) {
            createWindow();
        }
    });

    app.whenReady().then(startApp).catch(handleStartupFailure);
}

/**
 * Surface startup failures. Previously any error here quit the app silently,
 * so a player whose launch failed saw the icon bounce and nothing else.
 */
// The embedded server's way of keeping a report of something gone wrong (server.js: addReport), once it is up.
let _addReport = null;
// The app's own process failing — not the page, which reports for itself — is kept the same way.
// (Only watched: what Electron does about it, a box saying so, it still does. A promise nobody
// caught arrives here as well.)
process.on('uncaughtExceptionMonitor', (err) => {
    log('app error:', String(err?.stack ?? err?.message ?? err));
    try { _addReport?.({ kind: 'app', message: 'The app hit an error: ' + (err?.message ?? err), stack: String(err?.stack ?? ''), where: 'the app itself' }); }
    catch { /* nothing more to be done about it here */ }
});

const LOG_NOTE = `\n\nWhat happened is written in:\n${LOG_FILE}`;

function handleStartupFailure(err) {
    const detail = String(err?.stack ?? err?.message ?? err);
    log('could not start:', detail);
    try {
        dialog.showErrorBox(
            'Wonder World could not start',
            'The game server failed to start.\n\n' + detail + LOG_NOTE,
        );
    } catch { /* dialog unavailable this early — the log stands */ }
    app.quit();
}

// How long the embedded server may take to come up before the player is asked
// whether to go on waiting. It is a second or two; the first launch of a new
// download on a Mac, while the system checks it, can take longer.
const SERVER_PATIENCE_MS = 45000;

async function startServer() {
    const server = await import('../server/server.js');
    _addReport = server.addReport ?? null;
    const { port, host } = await server.serverReady;
    return { server, port, host };
}

async function startApp() {
    log('ready; starting the game server');
    if (process.platform === 'darwin') setMacMenu();
    app.getGPUInfo('basic')
        .then(info => log('graphics:', { status: app.getGPUFeatureStatus(), gpus: info?.gpuDevice?.map(g => ({ vendor: g.vendorId, device: g.deviceId, active: g.active })) }))
        .catch(e => log('graphics: could not be read:', String(e?.message ?? e)));

    // Boot the embedded Express + WebSocket server and wait until it is
    // listening before loading the page, so the first request can't race it.
    // A start that neither finishes nor fails used to leave the app running
    // with no window, for ever: past SERVER_PATIENCE_MS the player is asked.
    const starting = startServer();
    let started = await Promise.race([starting, new Promise(r => setTimeout(r, SERVER_PATIENCE_MS, null))]);
    if (!started) {
        log(`the game server has not started after ${SERVER_PATIENCE_MS / 1000} s`);
        const { response } = await dialog.showMessageBox({
            type: 'warning', buttons: ['Keep Waiting', 'Quit'], defaultId: 0, cancelId: 1,
            message: 'Wonder World is taking a long time to start',
            detail: 'Its game server has not started yet.' + LOG_NOTE,
        });
        if (response === 1) { log('the player quit while waiting'); app.quit(); return; }
        started = await starting;
    }
    const { server, port, host } = started;
    serverOrigin = `http://${host}:${port}`;
    log('game server listening on', serverOrigin);

    createWindow();
    setupUpdates(server);
    // The screenshots folder, shown in the system's own file window.
    server.setShellHandlers?.({ openFolder: async (dir) => { const err = await shell.openPath(dir); if (err) throw new Error(err); } });

    app.on('activate', () => {
        // macOS: re-create a window when the dock icon is clicked and none open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

// ── Updates ───────────────────────────────────────────────────────────────────
//
// Two mechanisms, because only one of them can work everywhere:
//
//   1. electron-updater — downloads and installs silently, differentially (it
//      only fetches the blocks that changed, via the .blockmap published next to
//      the installer). Windows only in practice: Squirrel.Mac refuses to apply
//      an update unless the app is code signed, and this build is not.
//
//   2. The plain version manifest the website already serves. Works on every
//      platform and needs nothing installed, but can only *tell* the player —
//      they download and run the installer themselves.
//
// Where 1 is available it is preferred and 2 never runs. Where it is not, or
// where it fails, 2 is the fallback so the player still learns an update exists.

const UPDATE_MANIFEST_URL =
    'https://alex.planetkodiak.com/Interlinked-Creations/Library/src/data/wonderworld-app.json';
const UPDATE_LIBRARY_URL =
    'https://alex.planetkodiak.com/Interlinked-Creations/Library/';

// The first check is made as the app starts, with no wait: the game asks the
// player about an update before it shows its menu (src/main.js: UPDATES), and
// holds its loading card a few seconds for the answer. (It used to wait five
// seconds first, when all there was to show for an update was a banner.)
// A hung or slow host must cost the player nothing.
const UPDATE_FETCH_TIMEOUT_MS = 8000;

// Flip to true once the macOS build is signed and notarised. Squirrel.Mac
// validates the signature of the downloaded update against the running app, so
// enabling this while unsigned produces downloads that always fail to install.
// (An ad-hoc signature, which the build has, is not one it accepts.) Put the
// mac `zip` target back in electron-builder.yml then too: an update is
// installed from the zip, never the dmg, and only the dmg is built now.
const MAC_AUTO_UPDATE_SIGNED = false;

function canAutoInstall() {
    if (!app.isPackaged) return false;
    if (process.platform === 'darwin') return MAC_AUTO_UPDATE_SIGNED;
    return process.platform === 'win32';
}

/**
 * Semver precedence comparison, enough for "is `a` newer than `b`".
 *
 * Written out rather than pulled from electron-updater's transitive `semver`,
 * which is not a declared dependency here and could vanish on any install.
 * Follows semver.org precedence: numeric core first, then a release outranks a
 * prerelease, then prerelease identifiers compared field by field.
 */
function isNewerVersion(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
        if (!m) return null;
        return {
            core: [Number(m[1]), Number(m[2]), Number(m[3])],
            pre: m[4] ? m[4].split('.') : [],
        };
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return false;

    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i];
    }
    // Equal core: a release beats a prerelease.
    if (pa.pre.length === 0 && pb.pre.length === 0) return false;
    if (pa.pre.length === 0) return true;
    if (pb.pre.length === 0) return false;

    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i], y = pb.pre[i];
        if (x === undefined) return false;   // shorter set has lower precedence
        if (y === undefined) return true;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) { if (+x !== +y) return +x > +y; }
        else if (nx !== ny) return !nx;      // numeric identifiers rank lower
        else if (x !== y) return x > y;
    }
    return false;
}

async function fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// electron-updater both rejects its checkForUpdates() promise and emits 'error'
// for the same failure, and either can reach the fallback. Collapse concurrent
// callers onto one in-flight request so a single failure cannot fire two
// manifest fetches.
let _manifestInFlight = null;

function checkManifest(setUpdateState) {
    if (_manifestInFlight) return _manifestInFlight;
    _manifestInFlight = _checkManifest(setUpdateState)
        .finally(() => { _manifestInFlight = null; });
    return _manifestInFlight;
}

/** Fallback path: ask the website what the latest version is. */
async function _checkManifest(setUpdateState) {
    const current = app.getVersion();
    const info = await fetchJson(UPDATE_MANIFEST_URL, UPDATE_FETCH_TIMEOUT_MS);
    const latest = info?.version;
    const newer = isNewerVersion(latest, current);

    const platformUrl = process.platform === 'darwin' ? info?.macOS : info?.windows;
    setUpdateState({
        checking:       false,
        available:      newer,
        canAutoInstall: false,
        newVersion:     newer ? latest : null,
        downloadUrl:    newer ? (platformUrl ?? UPDATE_LIBRARY_URL) : null,
        lastChecked:    Date.now(),
        error:          null,
    });
    console.log(newer
        ? `[updater] newer version available: ${latest} (manual download)`
        : `[updater] up to date (${current})`);
}

let _autoUpdater = null;

async function runUpdateCheck(setUpdateState) {
    setUpdateState({ checking: true, error: null, currentVersion: app.getVersion() });

    if (canAutoInstall()) {
        try {
            if (!_autoUpdater) {
                // electron-updater is CommonJS and defines `autoUpdater` with a
                // getter, which Node cannot see as a named export: it has to be
                // read off the default export. (As a named import it was
                // undefined, and auto-update failed on its first line.)
                const updater = await import('electron-updater');
                const autoUpdater = (updater.default ?? updater).autoUpdater;
                _autoUpdater = autoUpdater;
                autoUpdater.autoDownload = true;
                // Let the player finish their session; apply on the next launch.
                autoUpdater.autoInstallOnAppQuit = true;
                autoUpdater.logger = null;

                autoUpdater.on('update-available', (info) => {
                    // Known now, though the download has only begun: the game is waiting to ask the player.
                    setUpdateState({ checking: false, available: true, canAutoInstall: true, downloaded: false, progress: 0,
                                     newVersion: info?.version, lastChecked: Date.now() });
                    console.log('[updater] downloading', info?.version);
                });
                autoUpdater.on('download-progress', (p) => {
                    setUpdateState({ progress: Math.round(p?.percent ?? 0) });
                });
                autoUpdater.on('update-not-available', () => {
                    setUpdateState({ checking: false, available: false, lastChecked: Date.now() });
                });
                autoUpdater.on('update-downloaded', (info) => {
                    setUpdateState({
                        checking: false, available: true, canAutoInstall: true, progress: 100,
                        downloaded: true, newVersion: info?.version, lastChecked: Date.now(),
                    });
                    console.log('[updater] update ready:', info?.version);
                });
                autoUpdater.on('error', (err) => {
                    // Offline, host down, or a malformed latest.yml. Never
                    // interrupt play — fall back to the manifest so the player
                    // at least finds out an update exists.
                    console.warn('[updater]', err?.message ?? err);
                    checkManifest(setUpdateState).catch(() => {
                        setUpdateState({ checking: false, error: String(err?.message ?? err), lastChecked: Date.now() });
                    });
                });
            }
            await _autoUpdater.checkForUpdates();
            return;
        } catch (err) {
            console.warn('[updater] auto-update unavailable:', err?.message ?? err);
        }
    }

    try {
        await checkManifest(setUpdateState);
    } catch (err) {
        // Offline is the common case here and is not worth reporting loudly.
        console.warn('[updater] version check failed:', err?.message ?? err);
        setUpdateState({ checking: false, error: String(err?.message ?? err), lastChecked: Date.now() });
    }
}

async function setupUpdates(server) {
    const { setUpdateState, setUpdateHandlers } = server;
    setUpdateState({
        supported:      true,
        currentVersion: app.getVersion(),
        canAutoInstall: canAutoInstall(),
    });

    setUpdateHandlers({
        onCheck:   () => runUpdateCheck(setUpdateState),
        onInstall: () => { if (_autoUpdater) _autoUpdater.quitAndInstall(false, true); },
    });

    // At once (it says "checking" before this returns): the page asks what was
    // found as soon as it has loaded.
    runUpdateCheck(setUpdateState).catch(err =>
        console.warn('[updater] initial check failed:', err?.message ?? err));
}

// ── Window state persistence ──────────────────────────────────────────────────

function loadWindowState() {
    const fallback = { width: 1280, height: 800, maximized: false };
    try {
        const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
        if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return fallback;

        // Discard a saved position that no longer lands on a connected display —
        // otherwise unplugging a second monitor opens the window off-screen.
        if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
            const onScreen = screen.getAllDisplays().some(d => {
                const b = d.workArea;
                return s.x < b.x + b.width && s.x + s.width > b.x &&
                       s.y < b.y + b.height && s.y + s.height > b.y;
            });
            if (!onScreen) { delete s.x; delete s.y; }
        }
        return { ...fallback, ...s };
    } catch {
        return fallback;
    }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const maximized = mainWindow.isMaximized();
        // Read the restored bounds so un-maximizing later returns to a sane size.
        const b = mainWindow.isNormal() ? mainWindow.getBounds() : mainWindow.getNormalBounds();
        fs.writeFileSync(windowStatePath(), JSON.stringify({
            x: b.x, y: b.y, width: b.width, height: b.height, maximized,
        }));
    } catch { /* non-fatal — the window just opens at its default next time */ }
}

function createWindow() {
    const state = loadWindowState();

    mainWindow = new BrowserWindow({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        minWidth: 960,
        minHeight: 600,
        backgroundColor: '#000000',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            // Secure defaults — the page needs no privileged access.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Keep the render loop running at full rate when the window is not
            // focused but still visible (e.g. on a second monitor).
            backgroundThrottling: false,
        },
    });

    if (state.maximized) mainWindow.maximize();

    // No application menu on Windows and Linux. Its bar was hidden already, but
    // its shortcuts were not: Ctrl+W closed the window — in the middle of a
    // game, for anyone holding Ctrl and walking forward — and Ctrl+R reloaded
    // it. (macOS keeps its menu: an app without one cannot be quit from the bar.)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    // Shown when the page has drawn something — or after SHOW_WITHIN_MS
    // whatever it has done. It used to wait for 'ready-to-show' alone, and a
    // page that never got that far (its process failing to start, a load that
    // never came) left the app running with no window at all.
    const win = mainWindow;
    let shown = false;
    const reveal = (why) => {
        if (shown || win.isDestroyed()) return;
        shown = true;
        log('window shown:', why);
        win.show();
    };
    win.once('ready-to-show', () => reveal('the page is ready'));
    setTimeout(() => reveal(`not ready after ${SHOW_WITHIN_MS / 1000} s`), SHOW_WITHIN_MS);

    const wc = win.webContents;
    wc.on('did-finish-load', () => log('page loaded'));
    // The page is the game's own server on this machine, so a failed load is
    // something in between — security software that blocks this machine's own
    // addresses, most likely. Tried again a few times, then said.
    let loadTries = 0;
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
        if (!isMainFrame || code === -3) return;   // -3: a load replaced by another, not a failure
        log('page failed to load:', { code, description, url, tries: loadTries });
        if (++loadTries <= LOAD_RETRIES) { setTimeout(() => { if (!win.isDestroyed()) win.loadURL(serverOrigin); }, 1000); return; }
        reveal('the page failed to load');
        dialog.showMessageBox(win, {
            type: 'error', buttons: ['OK'],
            message: 'The game could not be loaded',
            detail: `The window could not reach the game's own server on this computer (${description}). Security software that blocks connections to this computer itself can cause this.` + LOG_NOTE,
        });
    });
    wc.on('unresponsive', () => log('the page stopped responding'));
    wc.on('responsive', () => log('the page responds again'));
    // Errors in the page while it starts are kept here too: if the game never
    // reaches its menus, they are what there is to read.
    let pageErrors = 0;
    wc.on('console-message', (e, ...old) => {
        const level = e?.level ?? old[0];
        if (level !== 'error' && level !== 3) return;
        if (++pageErrors > PAGE_ERRORS_LOGGED) return;
        log('page error:', String(e?.message ?? old[1]).slice(0, 600), String(e?.sourceId ?? old[3] ?? '').split('/').pop());
    });

    log('loading the game from', serverOrigin);
    mainWindow.loadURL(serverOrigin);

    // F11 toggles fullscreen; Escape leaves it. Escape is also the in-game pause
    // key, so only consume it when actually fullscreen.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        // The developer tools went with the menu; an unpackaged run keeps a way in.
        if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
            event.preventDefault();
            mainWindow.webContents.toggleDevTools();
            return;
        }
        if (input.key === 'F11') {
            event.preventDefault();
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
        } else if (input.key === 'Escape' && mainWindow.isFullScreen()) {
            event.preventDefault();
            mainWindow.setFullScreen(false);
        }
    });

    // If the renderer process dies, say so instead of leaving a blank window.
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        log('the game window\'s process is gone:', details);
        // Kept, to be read afterwards under Settings → Game → Error Reports.
        _addReport?.({ kind: 'crash', message: `The game window stopped (${details.reason})`, stack: `exit code ${details.exitCode}`, where: 'the game window' });
        reveal('its process is gone');
        dialog.showErrorBox(
            'Wonder World stopped responding',
            `The game window crashed (${details.reason}). Restart the app to continue.` + LOG_NOTE,
        );
    });

    // Open any external (target=_blank) links in the user's real browser,
    // never as an in-app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Persist geometry on close rather than on every resize event.
    mainWindow.on('close', saveWindowState);
    mainWindow.on('closed', () => { mainWindow = null; });
}

const SHOW_WITHIN_MS = 5000;     // the window is shown by then, ready or not
const LOAD_RETRIES = 3;          // a failed page load is tried again this many times
const PAGE_ERRORS_LOGGED = 40;   // page errors written to the launch log, at most

// The other processes the game runs on: a graphics process that fails to start
// or keeps failing is what a machine whose game "opens and shows nothing" has.
app.on('child-process-gone', (_e, details) => log('a process of the game is gone:', details));

// macOS: the usual menu, and in Help a way to the launch log.
function setMacMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
        { role: 'help', submenu: [{ label: 'Show Launch Log', click: () => shell.showItemInFolder(LOG_FILE) }] },
    ]));
}

// Closing the game's window quits it, on a Mac too. Staying open in the Dock
// with no window, as a Mac app with documents does, left a game that looked
// running and was not playable — and its server holding the world files.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => log('quitting'));
