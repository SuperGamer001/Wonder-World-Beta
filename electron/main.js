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
 */
import { app, BrowserWindow, shell, dialog, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Route all writable game data (worlds, settings, screenshots) to a per-user
// writable location. Must be set BEFORE the server module is imported, because
// the server resolves its data paths at import time.
process.env.WONDER_DATA_DIR = app.getPath('userData');

let mainWindow   = null;
let serverOrigin = null;

const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

// The embedded server now binds an OS-assigned port, so a second copy would not
// collide — but two instances would still fight over the same world save files.
// Allow only one and focus the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(startApp).catch(handleStartupFailure);
}

/**
 * Surface startup failures. Previously any error here quit the app silently,
 * so a player whose launch failed saw the icon bounce and nothing else.
 */
function handleStartupFailure(err) {
    console.error('Failed to start Wonder World:', err);
    const detail = String(err?.stack ?? err?.message ?? err);
    try {
        dialog.showErrorBox(
            'Wonder World could not start',
            'The game server failed to start.\n\n' + detail,
        );
    } catch { /* dialog unavailable this early — the console log stands */ }
    app.quit();
}

async function startApp() {
    // Boot the embedded Express + WebSocket server and wait until it is
    // listening before loading the page, so the first request can't race it.
    const server = await import('../server/server.js');
    const { port, host } = await server.serverReady;
    serverOrigin = `http://${host}:${port}`;

    createWindow();
    setupUpdates(server);

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

// Delay before the first check. The window is already up by then, so this never
// competes with gamepack loading or the first world generation for bandwidth.
const UPDATE_CHECK_DELAY_MS   = 5000;
// A hung or slow host must cost the player nothing.
const UPDATE_FETCH_TIMEOUT_MS = 8000;

// Flip to true once the macOS build is signed and notarised. Squirrel.Mac
// validates the signature of the downloaded update against the running app, so
// enabling this while unsigned produces downloads that always fail to install.
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
                const { autoUpdater } = await import('electron-updater');
                _autoUpdater = autoUpdater;
                autoUpdater.autoDownload = true;
                // Let the player finish their session; apply on the next launch.
                autoUpdater.autoInstallOnAppQuit = true;
                autoUpdater.logger = null;

                autoUpdater.on('update-available', (info) => {
                    setUpdateState({ available: true, canAutoInstall: true, newVersion: info?.version });
                    console.log('[updater] downloading', info?.version);
                });
                autoUpdater.on('update-not-available', () => {
                    setUpdateState({ checking: false, available: false, lastChecked: Date.now() });
                });
                autoUpdater.on('update-downloaded', (info) => {
                    setUpdateState({
                        checking: false, available: true, canAutoInstall: true,
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

    // Deferred so the first check never competes with startup.
    setTimeout(() => {
        runUpdateCheck(setUpdateState).catch(err =>
            console.warn('[updater] initial check failed:', err?.message ?? err));
    }, UPDATE_CHECK_DELAY_MS);
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

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL(serverOrigin);

    // F11 toggles fullscreen; Escape leaves it. Escape is also the in-game pause
    // key, so only consume it when actually fullscreen.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
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
        console.error('Renderer process gone:', details);
        dialog.showErrorBox(
            'Wonder World stopped responding',
            `The game window crashed (${details.reason}). Restart the app to continue.`,
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

app.on('window-all-closed', () => {
    // Standard behaviour: quit on Windows/Linux, stay resident on macOS.
    if (process.platform !== 'darwin') app.quit();
});
