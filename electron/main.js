/**
 * Wonder World — Electron launcher (main process).
 *
 * The game is a web app served by the bundled Express + WebSocket server.
 * This launcher:
 *   1. Points the server's writable data dir at the per-user app-data folder
 *      (the packaged app files are read-only).
 *   2. Boots the server in-process and waits until it is listening.
 *   3. Opens a window pointing at the local server.
 *
 * No Node integration is exposed to the page — the renderer is the plain web
 * game and talks to the server over HTTP/WebSocket like in a browser.
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Route all writable game data (worlds, settings, screenshots) to a per-user
// writable location. Must be set BEFORE the server module is imported, because
// the server resolves its data paths at import time.
process.env.WONDER_DATA_DIR = app.getPath('userData');

const SERVER_ORIGIN = 'http://localhost:3000';

let mainWindow = null;

// The embedded server binds a fixed port, so a second copy of the app would
// fail to start. Allow only one instance and focus the existing window instead.
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

    app.whenReady().then(startApp).catch((err) => {
        console.error('Failed to start Wonder World:', err);
        app.quit();
    });
}

async function startApp() {
    // Boot the embedded Express + WebSocket server and wait until it is
    // listening before loading the page, so the first request can't race it.
    const { serverReady } = await import('../server/server.js');
    await serverReady;

    createWindow();

    app.on('activate', () => {
        // macOS: re-create a window when the dock icon is clicked and none open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
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
        },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL(SERVER_ORIGIN);

    // Open any external (target=_blank) links in the user's real browser,
    // never as an in-app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('window-all-closed', () => {
    // Standard behaviour: quit on Windows/Linux, stay resident on macOS.
    if (process.platform !== 'darwin') app.quit();
});
