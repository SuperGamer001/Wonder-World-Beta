/* =========================================================
   CONFIGURATION
========================================================= */

const gamePacks = ["-**DEFAULT**-"];
// Served by the game server, so use whatever origin this page came from — the
// server binds an OS-assigned port rather than a fixed 3000. The literal is a
// fallback for loading the page straight off disk in development.
// Which screen of a split screen this page is — 0 the first, or the only one —
// and what it was opened with (index.js makes the others: `?pane=1&pad=…&world=…`;
// src/players.js is the rest of it).
const PARAMS = new URLSearchParams(location.search);
const PANE   = Math.max(0, parseInt(PARAMS.get('pane') ?? '0') || 0);

const SERVER_URL = (location.origin && location.origin !== 'null')
    ? location.origin
    : 'http://127.0.0.1:3000';

/* =========================================================
   GLOBAL STATE
========================================================= */

const textures = {};
const loadingTexts = [];
const KEYS = {};

const BLOCK_TYPES = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5,
    WOOD: 6, LEAVES: 7, GRAVEL: 8, COAL_ORE: 9, IRON_ORE: 10,
    GOLD_ORE: 11, SNOW: 12, ICE: 13, SANDSTONE: 14, CLAY: 15,
    SNOW_DIRT: 16, GRANITE: 17, DIORITE: 18, BEDROCK: 19,
    CRAFTING_TABLE: 20, OVEN: 21, SMELTER: 22, CHEST: 23, ANVIL: 24,
    WOODEN_PLANKS: 25, STONE_BRICKS: 26, BRICKS: 27, GLASS: 28,
    GOLD_BLOCK: 29, IRON_BLOCK: 30, COAL_BLOCK: 31, WOOL_BLOCK: 32,
    POLISHED_GRANITE: 33, POLISHED_DIORITE: 34, MOSSY_STONE: 35,
    TORCH: 36, WALL_TORCH_EAST: 37, WALL_TORCH_WEST: 38, WALL_TORCH_SOUTH: 39,
    WALL_TORCH_NORTH: 40, LANTERN: 41, HANGING_LANTERN: 42, LAMP: 43,
    ANDESITE: 44, SLATE: 45, LIMESTONE: 46, COARSE_DIRT: 47, PODZOL: 48, MUD: 49,
    MOSS: 50, RED_SAND: 51, RED_SANDSTONE: 52, TERRACOTTA: 53, WHITE_TERRACOTTA: 54,
    ORANGE_TERRACOTTA: 55, YELLOW_TERRACOTTA: 56, BROWN_TERRACOTTA: 57, RED_TERRACOTTA: 58,
    PACKED_ICE: 59, DRY_GRASS: 60, MYCELIUM: 61, SPRUCE_LOG: 62, SPRUCE_LEAVES: 63,
    BIRCH_LOG: 64, BIRCH_LEAVES: 65, JUNGLE_LEAVES: 66, ACACIA_LEAVES: 67, CACTUS: 68,
    MUSHROOM_STEM: 69, RED_MUSHROOM_BLOCK: 70, BROWN_MUSHROOM_BLOCK: 71,
};

let titleBG = null;
let packsLoaded = 0;
let safeToClose = true;

const mergedGamePackData = { blocks: [], biomes: [], items: [], entities: [], recipes: [], terrain: [] };

let paused = false;
let _menuOpen = false;   // true while inventory / interactive panel is open
let gameStarted = false;
let loadingTextInterval = null;
let currentLoadingTextIndex = -1;
let activeWorld = null;
let _settingsOrigin = 'title';   // 'title' | 'pause' — where to return from settings

/* =========================================================
   PLAYER STATE
========================================================= */

window.me = {
    health: 100,
    hunger: 100,
    energy: 100,
    inventory: null,
    equipment: {
        head: null, chest: null, legs: null, feet: null,
        ears: null, hands: null, arms: null, quiver: null,
    },
    position: { x: 0, y: 0, z: 0 },
};

/* =========================================================
   DOM REFERENCES
========================================================= */

const DOM = {};

/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener("DOMContentLoaded", async () => {
    cacheDOM();
    buildSegments();
    bindEvents();

    await Promise.all([loadAllGamePacks(), loadSettings()]);
    _buildBlockColorIcons();
    applyLoadedAssets();
    applyPlayerSettings(getSettings());   // apply accessibility/HUD prefs from the start

    DOM.appLoadingContainer.classList.add("hidden");
    // Who is playing, and where they go: the title screen, or — a further
    // player of a split screen, a guest from the network — straight into the
    // world (players.js).
    await enterGame();
});

/* =========================================================
   DOM SETUP
========================================================= */

function cacheDOM() {
    DOM.startButton      = document.querySelector("#startButton");

    DOM.confirmPopup     = document.querySelector("#confirmPopup");
    DOM.confirmTitle     = document.querySelector("#confirmTitle");
    DOM.confirmMessage   = document.querySelector("#confirmMessage");
    DOM.confirmYes       = document.querySelector("#confirmYes");
    DOM.confirmNo        = document.querySelector("#confirmNo");

    DOM.loadingContainer    = document.querySelector("#loadingContainer");
    DOM.loadingBar          = document.querySelector("#loadingContainer .progressBar");
    DOM.loadingText         = document.querySelector("#loadingTextEl");
    DOM.appLoadingContainer = document.querySelector("#appLoadingContainer");
    DOM.appProgressBar      = document.querySelector("#appProgressBar");

    DOM.packName   = document.querySelector("#packName");
    DOM.logo       = document.querySelector("#TitleLogo");
    DOM.pauseLogo  = document.querySelector("#PauseLogo");
    DOM.titleLogo  = document.querySelector("#TitleLogo");

    DOM.titleScreen      = document.querySelector("#TitleScreen");
    DOM.worldListScreen  = document.querySelector("#WorldListScreen");
    DOM.worldDetailModal = document.querySelector("#WorldDetailModal");
    DOM.worldSettingsModal = document.querySelector("#WorldSettingsModal");
    DOM.createWorldModal = document.querySelector("#CreateWorldModal");
    DOM.settingsScreen   = document.querySelector("#SettingsScreen");
    DOM.gameScreen       = document.querySelector("#GameScreen");
    DOM.pauseScreen      = document.querySelector("#PauseScreen");
    DOM.deathScreen      = document.querySelector("#DeathScreen");
    DOM.gameUI           = document.querySelector("#gameUI");
    DOM.interactivePanel = document.querySelector("#InteractivePanel");

    DOM.worldListContainer = document.querySelector("#worldListContainer");
    DOM.createWorldBtn     = document.querySelector("#createWorldBtn");
    DOM.worldListBackBtn   = document.querySelector("#worldListBackBtn");

    DOM.worldDetailName    = document.querySelector("#worldDetailName");
    DOM.worldDetailInfo    = document.querySelector("#worldDetailInfo");
    DOM.worldPlayBtn       = document.querySelector("#worldPlayBtn");
    DOM.worldSettingsBtn   = document.querySelector("#worldSettingsBtn");
    DOM.worldDuplicateBtn  = document.querySelector("#worldDuplicateBtn");
    DOM.worldDeleteBtn     = document.querySelector("#worldDeleteBtn");
    DOM.worldDetailCloseBtn = document.querySelector("#worldDetailCloseBtn");

    DOM.worldSettingsGameMode  = document.querySelector("#worldSettingsGameMode");
    DOM.worldSettingsDoneBtn   = document.querySelector("#worldSettingsDoneBtn");

    DOM.createWorldConfirmBtn = document.querySelector("#createWorldConfirmBtn");
    DOM.createWorldCancelBtn  = document.querySelector("#createWorldCancelBtn");
    DOM.newWorldName      = document.querySelector("#newWorldName");
    DOM.newWorldSeed      = document.querySelector("#newWorldSeed");
    DOM.newWorldGameMode  = document.querySelector("#newWorldGameMode");

    DOM.titleSettingsBtn  = document.querySelector("#titleSettingsBtn");
    DOM.pauseSettingsBtn  = document.querySelector("#pauseSettingsBtn");
    DOM.settingsBackBtn   = document.querySelector("#settingsBackBtn");
    DOM.settingGameMode   = document.querySelector("#settingGameMode");

    DOM.respawnBtn         = document.querySelector("#respawnBtn");
    DOM.interactivePanelTitle = document.querySelector("#interactivePanelTitle");
    DOM.interactivePanelClose = document.querySelector("#interactivePanelClose");
    DOM.recipeList         = document.querySelector("#recipeList");
    DOM.recipeDetail       = document.querySelector("#recipeDetailIngredients");
    DOM.recipeDetailName   = document.querySelector("#recipeDetailName");
    DOM.craftBtn           = document.querySelector("#craftBtn");

    DOM.inventoryScreen   = document.querySelector("#InventoryScreen");
    DOM.invCloseBtn       = document.querySelector("#invCloseBtn");
    DOM.invCraftBtn       = document.querySelector("#invCraftBtn");
    DOM.invSlots          = document.querySelector("#invSlots");
    DOM.invHotbarRow      = document.querySelector("#invHotbarRow");
    DOM.invEquip          = document.querySelector("#invEquip");
    DOM.invWeightLabel    = document.querySelector("#invWeightLabel");

    DOM.creativeInvPanel  = document.querySelector("#CreativeInventoryPanel");
    DOM.creativeInvGrid   = document.querySelector("#creativeInvGrid");
    DOM.creativeInvClose  = document.querySelector("#creativeInvClose");
    DOM.creativeInvFilter = document.querySelector("#creativeInvFilter");
}

function bindEvents() {
    DOM.startButton.addEventListener("click", goToWorlds);
    document.getElementById('titleCreditsBtn')?.addEventListener('click', () => document.getElementById('CreditsScreen')?.classList.remove('hidden'));
    document.getElementById('creditsBackBtn')?.addEventListener('click', () => document.getElementById('CreditsScreen')?.classList.add('hidden'));
    DOM.createWorldBtn.addEventListener("click", showCreateWorldModal);

    // Click the game to re-acquire the pointer if we're playing but somehow
    // unlocked (e.g. a re-lock was momentarily blocked after closing a menu).
    DOM.gameScreen?.addEventListener('mousedown', () => {
        if (gameStarted && !_menuOpen && !paused &&
            document.pointerLockElement !== DOM.gameScreen) {
            lockPointer(DOM.gameScreen);
        }
    });
    DOM.worldListBackBtn.addEventListener("click", backToTitle);

    DOM.worldDetailCloseBtn.addEventListener("click", () => DOM.worldDetailModal.classList.add("hidden"));
    DOM.worldPlayBtn.addEventListener("click", () => {
        if (activeWorld) { DOM.worldDetailModal.classList.add("hidden"); startWorld(activeWorld); }
    });
    DOM.worldSettingsBtn.addEventListener("click", openWorldSettingsModal);
    DOM.worldSettingsDoneBtn.addEventListener("click", closeWorldSettingsModal);

    DOM.worldDuplicateBtn.addEventListener("click", async () => {
        if (!activeWorld) return;
        DOM.worldDetailModal.classList.add("hidden");
        try {
            await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/duplicate`, { method: 'POST' });
            showWorldList();
        } catch (e) { console.error('Duplicate failed', e); }
    });

    DOM.worldDeleteBtn.addEventListener("click", () => {
        if (!activeWorld) return;
        openConfirm('Delete World', `Permanently delete "${activeWorld.name}"? This cannot be undone.`, async () => {
            try { await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}`, { method: 'DELETE' }); }
            catch (e) { console.error('Delete failed', e); }
            DOM.worldDetailModal.classList.add("hidden");
            showWorldList();
        });
    });

    DOM.createWorldConfirmBtn.addEventListener("click", createWorld);
    document.getElementById('newWorldType')?.addEventListener('change', updateFlatForm);
    document.getElementById('newFlatMode')?.addEventListener('change', updateFlatForm);
    document.getElementById('newFlatPreset')?.addEventListener('change', (e) => _setFlatPreset(e.target.value));
    document.getElementById('flatAddLayerBtn')?.addEventListener('click', () => {
        if (_flatLayers.length >= FLAT_MAX_LAYERS) return;
        // Above the last layer, which is usually the bedrock.
        _flatLayers.splice(Math.max(0, _flatLayers.length - 1), 0, { block: 'STONE', depth: 4 });
        _renderFlatLayers();
    });
    DOM.createWorldCancelBtn.addEventListener("click", () => DOM.createWorldModal.classList.add("hidden"));

    DOM.titleSettingsBtn.addEventListener("click", () => openSettings('title'));
    DOM.pauseSettingsBtn?.addEventListener("click", () => openSettings('pause'));
    DOM.settingsBackBtn.addEventListener("click", closeSettings);

    document.getElementById('titleCharacterBtn')?.addEventListener('click', () => openCharacter('title'));
    document.getElementById('pauseCharacterBtn')?.addEventListener('click', () => openCharacter('pause'));
    document.getElementById('characterDoneBtn')?.addEventListener('click', closeCharacter);
    document.getElementById('characterRandomBtn')?.addEventListener('click', () => {
        _showCharacter(window.__wwCharacter?.random() ?? {});
        commitCharacter();
    });
    for (const sel of document.querySelectorAll('.charLook')) sel.addEventListener('change', commitCharacter);
    // Drag across the figure to turn it.
    const stage = document.getElementById('characterCanvas');
    stage?.addEventListener('mousemove', (e) => { if (e.buttons & 1) window.__wwCharacter?.turn(e.movementX * 0.012); });
    document.getElementById('titleHowToBtn')?.addEventListener('click', () => openHowToPlay('title'));
    document.getElementById('pauseHowToBtn')?.addEventListener('click', () => openHowToPlay('pause'));
    document.getElementById('howToBackBtn')?.addEventListener('click', closeHowToPlay);

    DOM.respawnBtn?.addEventListener("click", () => {
        DOM.deathScreen.classList.add("hidden");
        callWorldJS("respawn");
    });

    DOM.interactivePanelClose?.addEventListener("click", closeInteractivePanel);

    // Settings — every control commits + applies live.
    const settingIds = [
        'settingSensitivity', 'settingInvertY', 'settingFov', 'settingRenderDist',
        'settingGraphics', ...Object.values(GRAPHICS_CONTROLS).map(c => c.id),
        'settingBrightness', ...AUDIO_SLIDERS.map(([id]) => id), 'settingShowCoords', 'settingCrosshair', 'settingShowFps',
        'settingColorblind', 'settingHighContrast', 'settingReduceMotion', 'settingLargeText',
    ];
    for (const id of settingIds) {
        document.getElementById(id)?.addEventListener('input', commitSettingsFromForm);
        document.getElementById(id)?.addEventListener('change', commitSettingsFromForm);
    }
    document.getElementById('settingsResetBtn')?.addEventListener('click', resetSettings);
    document.getElementById('settingCheckUpdates')?.addEventListener('click', checkForUpdatesNow);

    // Poll the launcher's update status. The first automatic check is deferred
    // by a few seconds on the launcher side, so this catches it once it lands,
    // and again when a background download finishes.
    fetchUpdateStatus();
    setInterval(() => {
        // Skip while actively playing — the banner is menu-only anyway — and in
        // someone else's game, which has no updates of its own to offer.
        if ((gameStarted && !paused && !_menuOpen) || isGuest()) return;
        fetchUpdateStatus();
    }, UPDATE_POLL_MS);

    // World events from world.js
    window.addEventListener('ww_playerDied', () => {
        DOM.deathScreen?.classList.remove("hidden");
        if (document.pointerLockElement) document.exitPointerLock();
    });

    window.addEventListener('ww_respawned', () => {
        DOM.deathScreen?.classList.add("hidden");
        lockPointer(DOM.gameScreen);
    });

    window.addEventListener('ww_hotbarChange', (e) => {
        updateHotbarSelection(e.detail.slot);
    });

    window.addEventListener('ww_itemPickup', () => {
        refreshHotbarUI();
        if (!DOM.inventoryScreen?.classList.contains('hidden')) _renderInventory();
    });

    window.addEventListener('ww_toggleInventory', () => {
        if (DOM.inventoryScreen?.classList.contains('hidden')) openInventory();
        else closeInventory();
    });

    DOM.invCloseBtn?.addEventListener('click', closeInventory);

    DOM.invCraftBtn?.addEventListener('click', () => {
        closeInventory(true);  // suppress pointer lock — the next panel takes over
        if (activeWorld?.gameMode === 'CREATIVE') openCreativeInventory();
        else openHandCraft();
    });

    DOM.creativeInvClose?.addEventListener('click', closeCreativeInventory);

    DOM.creativeInvFilter?.addEventListener('input', () => {
        _populateCreativeGrid(DOM.creativeInvFilter.value.trim().toLowerCase());
    });

    window.addEventListener('ww_openInteractive', (e) => {
        openInteractivePanel(e.detail);
    });

    window.addEventListener('ww_toggleCraftMenu', (e) => {
        const mode = e.detail?.gameMode ?? activeWorld?.gameMode ?? 'SURVIVAL';
        if (mode === 'CREATIVE') {
            if (DOM.creativeInvPanel?.classList.contains('hidden')) openCreativeInventory();
            else closeCreativeInventory();
        } else {
            openHandCraft();
        }
    });

    window.addEventListener('ww_gameModeChange', (e) => {
        if (activeWorld) activeWorld.gameMode = e.detail.gameMode;
        _updateInvCraftBtn();
    });
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

window.addEventListener("blur", () => { if (gameStarted && !_menuOpen) paused = true; });
window.addEventListener("keydown", (e) => { KEYS[e.code] = true; });
window.addEventListener("keyup",   (e) => { KEYS[e.code] = false; });

// ── Pause / menu / pointer-lock coordination ──────────────────────────────────
// Pause is driven by pointer lock, not by polling. Losing the lock with no menu
// open means the player pressed Esc to leave gameplay → pause. Regaining the
// lock → resume. A menu being open suppresses the pause (it released the lock
// intentionally).
document.addEventListener('pointerlockchange', () => {
    if (!gameStarted) return;
    const locked = document.pointerLockElement === DOM.gameScreen;
    if (locked)            paused = false;
    else if (!_menuOpen)   paused = true;
});

// Re-acquiring pointer lock can fail if requested during the browser's brief
// post-Esc cooldown. Retry with backoff until it sticks (or we no longer want
// it), and also retry whenever a pointerlockerror fires.
/**
 * Acquire pointer lock with raw, unaccelerated mouse input.
 *
 * By default the browser feeds pointer-lock movement through the OS pointer
 * acceleration curve ("Enhance pointer precision" on Windows), so the same
 * physical motion produces different deltas depending how fast you move. That
 * is what makes a mouse-look camera feel jittery and unpredictable. Minecraft
 * and other first-person games read raw input instead; `unadjustedMovement`
 * asks the browser for the same thing.
 *
 * Falls back to a plain lock where the option is unsupported (it rejects on
 * some platforms), and swallows the throw that occurs when the element is not
 * in an active document.
 */
function lockPointer(el) {
    // A further pane of a split screen is its controller's: the mouse is the first player's.
    if (!el || PANE > 0 || document.pointerLockElement === el) return;

    // requestPointerLock may either throw synchronously or return a rejecting
    // promise depending on the browser and the failure, so both have to be
    // swallowed — an unhandled rejection here would surface as a page error
    // every time the lock is declined.
    const attempt = (opts) => {
        try {
            const p = opts ? el.requestPointerLock(opts) : el.requestPointerLock();
            return (p && typeof p.then === 'function') ? p : Promise.resolve();
        } catch (err) {
            return Promise.reject(err);
        }
    };

    attempt({ unadjustedMovement: true }).catch(() => {
        // Raw input is unsupported on this platform — fall back to an ordinary
        // lock rather than leaving the player unable to look around.
        if (document.pointerLockElement === el) return;
        attempt(null).catch(() => { /* not lockable right now; the retry loop handles it */ });
    });
}

let _lockRetryTimer = null;
function requestGameLock() {
    clearTimeout(_lockRetryTimer);
    // With a controller in use the game plays without the lock (gamepad.js),
    // and a page may not take the pointer on a controller button anyway: the
    // mouse is taken hold of again when it is next clicked on the game.
    if (window.__wwPad?.active) return;
    let attempts = 0;
    const tryLock = () => {
        if (!gameStarted || _menuOpen) return;                           // no longer wanted
        if (document.pointerLockElement === DOM.gameScreen) return;      // already locked
        lockPointer(DOM.gameScreen);
        if (++attempts < 15) _lockRetryTimer = setTimeout(tryLock, 250);
    };
    tryLock();
}
document.addEventListener('pointerlockerror', () => {
    if (gameStarted && !_menuOpen && !paused) {
        clearTimeout(_lockRetryTimer);
        _lockRetryTimer = setTimeout(requestGameLock, 300);
    }
});

// Escape: close an open menu (without opening pause); otherwise toggle pause.
// While the pointer is locked the browser swallows this keydown and exits lock
// itself — that case is handled by the pointerlockchange listener above.
window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !gameStarted) return;
    const howTo = document.getElementById('HowToPlayScreen');
    if (howTo && !howTo.classList.contains('hidden')) { e.preventDefault(); closeHowToPlay(); return; }
    if (DOM.settingsScreen && !DOM.settingsScreen.classList.contains('hidden')) {
        e.preventDefault(); closeSettings(); return;
    }
    if (_menuOpen)   { e.preventDefault(); closeAnyMenu(); return; }
    if (paused)      { resumeGame(); }
    // Playing without the lock (with a controller, gamepad.js): the browser
    // has no lock to take away, so the key has to pause by itself.
    else if (document.pointerLockElement !== DOM.gameScreen) paused = true;
});

// ── "Saving World..." indicator ───────────────────────────────────────────────
// Ref-counted so overlapping saves (autosave + unload, etc.) keep the sign up
// until the last one finishes. Driven by ww_saving events from world.js.
let _savingCount = 0;
window.addEventListener('ww_saving', (e) => {
    if (e.detail?.active) _savingCount++;
    else                  _savingCount = Math.max(0, _savingCount - 1);
    const el = document.getElementById('savingIndicator');
    if (el) el.classList.toggle('hidden', _savingCount === 0);
});

// ── Graphics capability reporting ─────────────────────────────────────────────
// world.js raises these when the renderer cannot start, or when it starts on a
// software rasteriser. Without surfacing them the player just sees a black
// screen or an unexplained single-digit frame rate.

window.addEventListener('ww_fatalError', (e) => {
    const { title = 'Error', message = '' } = e.detail ?? {};
    document.getElementById('appLoadingContainer')?.classList.add('hidden');
    document.getElementById('loadingContainer')?.classList.add('hidden');
    openConfirm(title, message, () => {});
    const yes = document.getElementById('confirmYes');
    if (yes) yes.textContent = 'OK';
    const no = document.getElementById('confirmNo');
    if (no) no.classList.add('hidden');
});

window.addEventListener('ww_gpuWarning', (e) => {
    const msg = e.detail?.message ?? '';
    console.warn('[main] GPU warning:', e.detail?.renderer ?? '');
    const el = document.getElementById('gpuWarning');
    if (el) {
        el.textContent = msg;
        el.classList.remove('hidden');
        // Self-dismiss — this is advisory, not something to block play on.
        setTimeout(() => el.classList.add('hidden'), 15000);
    }
});

/* =========================================================
   UPDATES
   The launcher publishes updater progress to the local server (the window has
   no IPC channel — contextIsolation and sandbox are on with no preload), so the
   UI reads it over HTTP like everything else.

   The banner only ever appears on the title and pause screens. An update is
   never worth interrupting play for, and it installs on quit regardless.
========================================================= */

const UPDATE_POLL_MS = 10000;
let _updateStatus = null;

async function fetchUpdateStatus() {
    try {
        const res = await fetch(`${SERVER_URL}/api/update-status`, { cache: 'no-store' });
        if (!res.ok) return;
        _updateStatus = await res.json();
        applyVersionLabel();
        renderUpdateBanner();
    } catch { /* server not reachable — nothing to show */ }
}

/** Show the real running version rather than a hardcoded string. */
function applyVersionLabel() {
    const el = document.getElementById('versionText');
    const v  = _updateStatus?.currentVersion;
    if (el && v) el.textContent = `Wonder World Beta v${v}`;
}

function renderUpdateBanner() {
    const el = document.getElementById('updateBanner');
    if (!el) return;

    const s = _updateStatus;
    // Menus only — never over live gameplay.
    const onMenu = !gameStarted || paused || _menuOpen;
    if (!s?.available || !onMenu) { el.classList.add('hidden'); return; }

    const ready = s.downloaded && s.canAutoInstall;
    el.innerHTML = '';

    const text = document.createElement('span');
    text.textContent = ready
        ? `Version ${s.newVersion} is ready to install.`
        : `Version ${s.newVersion} is available.`;
    el.appendChild(text);

    const btn = document.createElement('div');
    btn.className = 'menuButton small primary updateBannerBtn';
    btn.textContent = ready ? 'Restart & Install' : 'Download';
    btn.onclick = ready ? installUpdateNow : openUpdateDownload;
    el.appendChild(btn);

    el.classList.remove('hidden');
}

function openUpdateDownload() {
    const url = _updateStatus?.downloadUrl;
    if (!url) return;
    // The launcher's window-open handler routes this to the real browser.
    window.open(url, '_blank');
}

async function installUpdateNow() {
    try {
        await fetch(`${SERVER_URL}/api/update-install`, { method: 'POST' });
        // The app quits and relaunches into the installer from here.
    } catch { /* if it fails the update still installs on next quit */ }
}

/** Settings → Check for Updates. */
async function checkForUpdatesNow() {
    const btn = document.getElementById('settingCheckUpdates');
    const status = document.getElementById('updateCheckStatus');
    if (btn) btn.textContent = 'Checking…';
    if (status) status.textContent = '';
    try {
        const res = await fetch(`${SERVER_URL}/api/update-check`, { method: 'POST' });
        _updateStatus = await res.json();
    } catch { /* fall through to the message below */ }
    if (btn) btn.textContent = 'Check for Updates';
    if (status) {
        const s = _updateStatus;
        status.textContent =
            !s?.supported      ? 'Updates are only available in the desktop app.'
          : s.available        ? `Version ${s.newVersion} available`
          : s.error            ? 'Could not check right now'
          :                      'Up to date';
    }
    applyVersionLabel();
    renderUpdateBanner();
}

// Close whichever in-game menu is currently open and return to play.
function closeAnyMenu() {
    if (DOM.inventoryScreen && !DOM.inventoryScreen.classList.contains('hidden'))   { closeInventory();        return; }
    if (DOM.creativeInvPanel && !DOM.creativeInvPanel.classList.contains('hidden')) { closeCreativeInventory(); return; }
    if (DOM.interactivePanel && !DOM.interactivePanel.classList.contains('hidden')) { closeInteractivePanel();  return; }
    // Fallback — never leave the game stuck in a phantom "menu open" state.
    _menuOpen = false;
    requestGameLock();
}

window.addEventListener("beforeunload", (event) => {
    if (!safeToClose) {
        event.preventDefault();
        event.returnValue = "";
        closeGame();
    }
});

/* =========================================================
   SETTINGS
========================================================= */

// ── Player settings model ─────────────────────────────────────────────────────
// Player settings are cosmetic / quality-of-life only — they never change game
// mechanics (those live in per-world settings).

// ── Graphics presets ─────────────────────────────────────────────────────────
// One choice that sets every graphics-quality option at once. Classic is the
// game's original look; Custom keeps whatever the player sets by hand, and
// moving any of these controls switches to it.
//   fogStart  - fraction of the render distance that stays clear before fog
//   shadows   - sun shadows: 'off' | 'low' | 'medium' | 'high'   (Shadows.js)
//   clouds    - 'fast' | 'fancy'                                   (Clouds.js)
//               No 'off': the weather decides how much cloud there is,
//               and Fully Clear weather is the cloudless sky.
//   sky       - 'simple' (flat colour, flat round sun and moon) | 'pretty' (Sky.js)
//   particles - 'off' | 'low' | 'medium' | 'high'; also the density of rain,
//               snow and other weather particles       (Particles.js, Precipitation.js)
//   eyeAdaptation - 'off' | 'on': auto-exposure with a little bloom (PostFX.js)
//   maxFps    - frame-rate cap; 0 = unlimited
//   farTerrain - chunks of low-detail land beyond the render distance; 0 = off (FarTerrain.js)
const GRAPHICS_PRESETS = {
    simple:  { renderDistance: 5,  farTerrain: 0,  resolutionScale: 0.75, fogStart: 0.72, shadows: 'off',    clouds: 'fast',  sky: 'simple', particles: 'low',    eyeAdaptation: 'off', maxFps: 60 },
    classic: { renderDistance: 8,  farTerrain: 0,  resolutionScale: 1.0,  fogStart: 0.82, shadows: 'off',    clouds: 'fast',  sky: 'simple', particles: 'medium', eyeAdaptation: 'off', maxFps: 0 },
    normal:  { renderDistance: 10, farTerrain: 16, resolutionScale: 1.0,  fogStart: 0.86, shadows: 'medium', clouds: 'fast',  sky: 'pretty', particles: 'medium', eyeAdaptation: 'on',  maxFps: 0 },
    pro:     { renderDistance: 14, farTerrain: 32, resolutionScale: 1.0,  fogStart: 0.90, shadows: 'high',   clouds: 'fancy', sky: 'pretty', particles: 'high',   eyeAdaptation: 'on',  maxFps: 0 },
};
// The form control for each graphics value, and how to read it. Touching any of
// them selects Custom. Add a row here (plus its markup) to add an option.
const GRAPHICS_CONTROLS = {
    renderDistance:  { id: 'settingRenderDist', type: 'int' },
    farTerrain:      { id: 'settingFarTerrain', type: 'int' },
    resolutionScale: { id: 'settingResScale',   type: 'num' },
    fogStart:        { id: 'settingFogDist',    type: 'num' },
    shadows:         { id: 'settingShadows',    type: 'text' },
    clouds:          { id: 'settingClouds',     type: 'text' },
    sky:             { id: 'settingSky',        type: 'text' },
    particles:       { id: 'settingParticles',  type: 'text' },
    eyeAdaptation:   { id: 'settingEyeAdapt',   type: 'text' },
    maxFps:          { id: 'settingMaxFps',     type: 'int' },
};
const GRAPHICS_IDS = Object.values(GRAPHICS_CONTROLS).map(c => c.id);

function readGraphicsForm() {
    const out = {};
    for (const [key, { id, type }] of Object.entries(GRAPHICS_CONTROLS)) {
        const raw = document.getElementById(id)?.value;
        out[key] = type === 'text' ? raw : type === 'int' ? Math.round(parseFloat(raw)) : parseFloat(raw);
    }
    return out;
}

/** The graphics values a settings object selects: a preset, or the custom ones. */
function resolveGraphics(s) {
    const g = s.graphics === 'custom'
        ? { ...GRAPHICS_PRESETS.classic, ...(s.graphicsCustom ?? {}) }
        : { ...(GRAPHICS_PRESETS[s.graphics] ?? GRAPHICS_PRESETS.classic) };
    // Custom sets saved while clouds could be turned off.
    if (g.clouds !== 'fast' && g.clouds !== 'fancy') g.clouds = 'fast';
    if (g.eyeAdaptation !== 'on') g.eyeAdaptation = 'off';
    return g;
}

const DEFAULT_SETTINGS = {
    sensitivity: 1.0,
    invertY: false,
    fov: 75,
    // Render distance and resolution scale now come from the Graphics preset
    // (GRAPHICS_PRESETS above). Classic keeps the original 8 chunks — fog scales
    // with render distance, so terrain fades out rather than ending in a hard
    // edge — and full resolution (below 1.0 renders fewer pixels and upscales,
    // the cheapest way to recover frame rate on a high-DPI display).
    brightness: 1.0,
    showCoords: true,
    crosshair: true,
    showFps: false,
    colorblind: 'none',
    highContrast: false,
    reduceMotion: false,
    largeText: false,
    graphics: 'classic',    // 'classic' | 'normal' | 'pro' | 'simple' | 'custom'
    graphicsCustom: null,   // one value per GRAPHICS_CONTROLS key
    weatherVolume: 0.8,     // rain, wind and thunder (WeatherAudio.js)
    skin: null,             // the player's Quiddle (Character screen); null = the default look
    playerName: '',         // what other players see over it
    masterVolume: 1,        // everything (Sound.js)
    musicVolume: 0.6,
    sfxVolume: 0.9,         // footsteps, blocks, animals
    ambienceVolume: 0.7,    // birds, crickets, caves, water
};

// The volume sliders: [control id, setting]. Each shows a percentage.
const AUDIO_SLIDERS = [
    ['settingMasterVolume', 'masterVolume'], ['settingMusicVolume', 'musicVolume'], ['settingSfxVolume', 'sfxVolume'],
    ['settingAmbienceVolume', 'ambienceVolume'], ['settingWeatherVolume', 'weatherVolume'],
];

// The place behind the menus (src/scripts/MenuScene.js draws it: a model baked
// from real terrain, with the player's figure in it). `view` is where its
// camera rests: 'title' behind the title screen, 'worlds' behind the list.
let _menuWorld = false;       // it is showing, or loading
let _menuWorldOff = false;    // a test has asked for the plain background (window.__wwMenuWorld(false))
let _menuTravel = false;      // its camera is on its way between views: the menu is hidden, and waits

function startMenuWorld(view = 'title') {
    if (gameStarted || _menuWorldOff || isGuest()) return;
    const scene = window.__wwMenuScene;
    if (!scene) return;
    _menuWorld = true;
    document.body.classList.add('menuWorld');
    scene.setSkin(getSettings().skin ?? null);
    scene.show(view).then((ok) => { if (ok && _menuWorld) document.body.classList.add('menuReady'); });
}

function stopMenuWorld() {
    if (!_menuWorld) return;
    _menuWorld = false;
    document.body.classList.remove('menuWorld', 'menuReady');
    window.__wwMenuScene?.hide();
}
window.__wwMenuWorld = (on) => { _menuWorldOff = !on; if (on) startMenuWorld(); else stopMenuWorld(); };

/**
 * Play: the menu is put away, the camera goes to another part of the place,
 * and the list of worlds comes up there. Back does the same the other way.
 */
async function goToWorlds() {
    if (_menuTravel) return;
    _menuTravel = true;
    DOM.titleScreen.classList.add("hidden");
    DOM.titleLogo?.classList.add("hidden");
    await (window.__wwMenuScene?.goto('worlds') ?? Promise.resolve());
    _menuTravel = false;
    if (!gameStarted) showWorldList();
}
async function backToTitle() {
    if (_menuTravel) return;
    _menuTravel = true;
    DOM.worldListScreen.classList.add("hidden");
    await (window.__wwMenuScene?.goto('title') ?? Promise.resolve());
    _menuTravel = false;
    if (gameStarted) return;
    DOM.titleScreen.classList.remove("hidden");
    DOM.titleLogo?.classList.remove("hidden");
}

// ── Sharing the screen ───────────────────────────────────────────────────────
// With two to four games drawn on one machine, each is kept light: a short
// view, and none of what costs most. How many are playing on this screen is
// index.js's to know; it tells every pane when it changes.
let _splitCount = PANE > 0 ? (parseInt(PARAMS.get('of')) || 2) : 1;
window.__wwSplitCount = (n) => {
    if (n === _splitCount) return;
    _splitCount = n;
    applyPlayerSettings(getSettings());
};
/** The graphics a player chose, as far as a shared screen allows them. */
function limitForSplit(g) {
    document.getElementById('splitGraphicsNote')?.classList.toggle('hidden', _splitCount < 2);
    if (_splitCount < 2) return g;
    const few = _splitCount === 2, order = ['off', 'low', 'medium', 'high'];
    return {
        ...g,
        renderDistance: Math.min(g.renderDistance ?? 8, few ? 6 : 4),
        farTerrain: 0, shadows: 'off', clouds: 'fast', eyeAdaptation: 'off',
        particles: order[Math.min(order.indexOf(g.particles ?? 'medium'), few ? 2 : 1)],
        maxFps: g.maxFps ? Math.min(g.maxFps, 60) : 60,
    };
}

// The music of the menus (data/sounds/music/). It starts with the game, gives
// way to the world's own sounds when one is entered, and is there again on
// the way out.
const MENU_MUSIC = 'Adventure Awaits';

// ── Where the settings are kept ──────────────────────────────────────────────
// With the game server, in user/settings.json (GET / PUT /api/settings), which
// is in the player's data folder. They used to live only in localStorage, and
// that belongs to the page's origin: the desktop app serves the game from a
// port the system picks afresh at every launch, so each launch was a new
// origin with empty storage and every setting went back to its default.
// localStorage is still written, as the fallback for a page with no server
// behind it, and read once to carry over settings saved before this.
let _settings = null;          // the saved settings, once loadSettings() has run
let _settingsPushTimer = null;
const SETTINGS_PUSH_MS = 250;  // a slider sends many changes; the server gets the last

function _localSettings() {
    try { return JSON.parse(localStorage.getItem('ww_settings') ?? 'null'); } catch { return null; }
}

/** Read the saved settings from the server. Call once, before anything applies them. */
async function loadSettings() {
    let saved = null;
    try {
        const res = await fetch(`${SERVER_URL}/api/settings`, { cache: 'no-store' });
        if (res.ok) saved = await res.json();
    } catch { /* no server: localStorage below */ }
    if (saved && Object.keys(saved).length > 0) { _settings = saved; return; }
    _settings = _localSettings() ?? {};
    // A guest in a game on the network brings their own settings with them
    // (index.js hands them over in the address): the host's are the host's.
    try {
        const me = /[#&]me=([^&]+)/.exec(location.hash);
        if (me) _settings = { ..._settings, ...JSON.parse(decodeURIComponent(me[1])) };
    } catch { /* not ours */ }
    // Nothing on the server yet: hand it what this browser had.
    if (saved && Object.keys(_settings).length > 0) _pushSettings();
}

function _pushSettings() {
    clearTimeout(_settingsPushTimer);
    _settingsPushTimer = null;
    // The settings on the server are the first player's own. A second pane's
    // are for as long as it plays, and a guest's are kept by their browser.
    if (!_settings || isGuest()) return;
    // keepalive: the request outlives the page, so a change made just before
    // the window closes still arrives.
    fetch(`${SERVER_URL}/api/settings`, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_settings),
    }).catch(() => { /* offline: localStorage has it */ });
}
window.addEventListener('pagehide', () => { if (_settingsPushTimer) _pushSettings(); });

function getSettings() {
    const saved = { ...(_settings ?? _localSettings() ?? {}) };
    // Settings saved before the Graphics preset existed: anyone who had changed
    // render distance or resolution keeps those values, as Custom.
    if (saved.graphics == null && ((saved.renderDistance != null && saved.renderDistance !== 8) ||
                                   (saved.resolutionScale != null && saved.resolutionScale !== 1))) {
        saved.graphics = 'custom';
        saved.graphicsCustom = { ...GRAPHICS_PRESETS.classic,
            renderDistance: saved.renderDistance ?? 8, resolutionScale: saved.resolutionScale ?? 1 };
    }
    return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(s) {
    _settings = { ...s, profiles: _settings?.profiles ?? s.profiles };
    if (PANE === 0) try { localStorage.setItem('ww_settings', JSON.stringify(_settings)); } catch { /* storage unavailable */ }
    clearTimeout(_settingsPushTimer);
    _settingsPushTimer = setTimeout(_pushSettings, SETTINGS_PUSH_MS);
}

// Frame-rate cap from the Graphics settings (0 = unlimited); read by gameLoop.
let _maxFps = 0;

// Apply settings to the page (accessibility/HUD) and forward the gameplay-facing
// ones (sensitivity, FOV, render distance) to the engine.
function applyPlayerSettings(s) {
    // Brightness and the colourblind transforms are applied inside the chunk
    // shader, not as a CSS filter on <body>. A filter on the body forces the
    // entire page — the WebGL canvas included — through an extra full-screen
    // compositing pass every frame, so enabling an accessibility option used to
    // cost frame rate. The UI layer is unaffected either way.
    document.body.style.filter = '';

    document.body.classList.toggle('a11y-contrast',  !!s.highContrast);
    document.body.classList.toggle('a11y-reduce',    !!s.reduceMotion);
    document.body.classList.toggle('a11y-large-text',!!s.largeText);

    document.getElementById('playerCoords')?.classList.toggle('forceHidden', !s.showCoords);
    document.getElementById('crosshair')?.classList.toggle('forceHidden', !s.crosshair);
    const fpsEl = document.getElementById('fpsCounter');
    if (fpsEl) fpsEl.classList.toggle('hidden', !s.showFps);
    _fpsEnabled = !!s.showFps;

    const graphics = limitForSplit(resolveGraphics(s));
    _maxFps = graphics.maxFps || 0;
    window.__wwMenuScene?.setSkin(s.skin ?? null);

    callWorldJS('applySettings', {
        sensitivity:     s.sensitivity,
        invertY:         s.invertY,
        fov:             s.fov,
        ...graphics,             // every GRAPHICS_CONTROLS value, as far as a shared screen allows
        brightness:      s.brightness,
        colorblind:      s.colorblind,
        weatherVolume:   s.weatherVolume,
        masterVolume:    s.masterVolume,
        musicVolume:     s.musicVolume,
        sfxVolume:       s.sfxVolume,
        ambienceVolume:  s.ambienceVolume,
        skin:            s.skin ?? null,
        playerName:      s.playerName ?? '',
        // Also damps lightning flashes — rapid bright flicker is a
        // photosensitivity trigger.
        reduceMotion:    !!s.reduceMotion,
    });
}

function openSettings(origin) {
    _settingsOrigin = origin;

    const tabWorld = document.getElementById('tabWorld');
    const inGame   = origin === 'pause';

    // "This World" only makes sense while in a game. Otherwise the screen
    // opens on the section it was last left at.
    if (tabWorld) tabWorld.style.display = inGame ? '' : 'none';
    switchSettingsTab(!inGame && _settingsSection === 'world' ? 'video' : _settingsSection);
    if (inGame && activeWorld) {
        if (DOM.settingGameMode)  DOM.settingGameMode.value  = activeWorld.gameMode  ?? 'SURVIVAL';
        const diffEl = document.getElementById('settingDifficulty');
        if (diffEl) diffEl.value = activeWorld.difficulty ?? 'NORMAL';
        _populateAtmosphereControls('setting', activeWorld);
    }

    populateSettingsForm();

    if (origin === 'title') DOM.titleScreen.classList.add("hidden");
    else                    DOM.pauseScreen.classList.add("hidden");
    DOM.settingsScreen.classList.remove("hidden");
}

function closeSettings() {
    DOM.settingsScreen.classList.add("hidden");
    if (_settingsOrigin === 'pause') {
        DOM.pauseScreen.classList.remove("hidden");
        // The World tab has no Apply button: its settings take effect here.
        applyWorldSettings();
    } else {
        DOM.titleScreen.classList.remove("hidden");
    }
}

// ── Character ─────────────────────────────────────────────────────────────────
// The player's own Quiddle (settings: `skin`, a choice for each of the model's
// looks; `playerName`). Each control is one look; the figure beside them shows
// the result (Character.js), and a change is kept and sent to the game at once.
let _characterOrigin = 'title';

function _showCharacter(skin) {
    const clean = window.__wwCharacter?.clean(skin) ?? skin ?? {};
    for (const sel of document.querySelectorAll('.charLook')) sel.value = String(clean[sel.dataset.look] ?? 0);
    syncSegments();
    return clean;
}

function openCharacter(origin) {
    _characterOrigin = origin;
    const s = getSettings();
    const skin = _showCharacter(s.skin ?? window.__wwCharacter?.defaultSkin());
    _showPlayerName();
    if (origin === 'title') DOM.titleScreen.classList.add("hidden");
    else                    DOM.pauseScreen.classList.add("hidden");
    document.getElementById('CharacterScreen')?.classList.remove("hidden");
    window.__wwCharacter?.show(document.getElementById('characterCanvas'), skin);
}

function commitCharacter() {
    const skin = {};
    for (const sel of document.querySelectorAll('.charLook')) skin[sel.dataset.look] = parseInt(sel.value) || 0;
    const s = { ...getSettings(), skin };
    saveSettings(s);
    if (s.playerName) saveProfile(s.playerName, skin);       // the look is kept with the name
    window.__wwCharacter?.set(skin);
    applyPlayerSettings(s);
}

function closeCharacter() {
    commitCharacter();
    document.getElementById('CharacterScreen')?.classList.add("hidden");
    window.__wwCharacter?.hide();
    if (_characterOrigin === 'pause') DOM.pauseScreen.classList.remove("hidden");
    else                              DOM.titleScreen.classList.remove("hidden");
}

// ── How To Play ───────────────────────────────────────────────────────────────
let _howToOrigin = 'title';
function openHowToPlay(origin) {
    _howToOrigin = origin;
    if (origin === 'title') DOM.titleScreen.classList.add("hidden");
    else                    DOM.pauseScreen.classList.add("hidden");
    document.getElementById('HowToPlayScreen')?.classList.remove("hidden");
}
function closeHowToPlay() {
    document.getElementById('HowToPlayScreen')?.classList.add("hidden");
    if (_howToOrigin === 'pause') DOM.pauseScreen.classList.remove("hidden");
    else                          DOM.titleScreen.classList.remove("hidden");
}

// Push current settings values into the form controls.
function populateSettingsForm() {
    const s = getSettings();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    set('settingSensitivity', s.sensitivity); chk('settingInvertY', s.invertY);
    set('settingFov', s.fov);
    const g = resolveGraphics(s);
    set('settingGraphics', s.graphics);
    for (const [key, { id }] of Object.entries(GRAPHICS_CONTROLS)) set(id, g[key]);
    set('settingBrightness', s.brightness);
    for (const [id, key] of AUDIO_SLIDERS) set(id, s[key]);
    chk('settingShowCoords', s.showCoords);   chk('settingCrosshair', s.crosshair);
    chk('settingShowFps', s.showFps);
    set('settingColorblind', s.colorblind);
    chk('settingHighContrast', s.highContrast);
    chk('settingReduceMotion', s.reduceMotion);
    chk('settingLargeText', s.largeText);
    _updateSettingLabels();
    syncSegments();
}

function _updateSettingLabels() {
    const v = id => document.getElementById(id)?.value;
    const t = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    t('settingSensitivityVal', parseFloat(v('settingSensitivity')).toFixed(1));
    t('settingFovVal', v('settingFov'));
    t('settingRenderDistVal', v('settingRenderDist'));
    t('settingResScaleVal', `${Math.round(parseFloat(v('settingResScale')) * 100)}%`);
    t('settingFogDistVal', `${Math.round(parseFloat(v('settingFogDist')) * 100)}%`);
    t('settingBrightnessVal', `${Math.round(parseFloat(v('settingBrightness')) * 100)}%`);
    for (const [id] of AUDIO_SLIDERS) t(`${id}Val`, `${Math.round(parseFloat(v(id)) * 100)}%`);
    // Each slider is filled up to its handle (--fill, game.css).
    document.querySelectorAll('.settingsSlider').forEach(el => {
        const lo = parseFloat(el.min), hi = parseFloat(el.max);
        el.style.setProperty('--fill', `${((parseFloat(el.value) - lo) / (hi - lo)) * 100}%`);
    });
}

// Read the form, persist, and apply live (called on every input change).
function commitSettingsFromForm(e) {
    const num = id => parseFloat(document.getElementById(id)?.value);
    const on  = id => !!document.getElementById(id)?.checked;
    const s = {
        // What no control here shows — the character, the player's name — stays as it is.
        ...getSettings(),
        ...Object.fromEntries(AUDIO_SLIDERS.map(([id, key]) => [key, num(id)])),
        sensitivity:    num('settingSensitivity'),
        invertY:        on('settingInvertY'),
        fov:            num('settingFov'),
        graphics:        document.getElementById('settingGraphics')?.value ?? 'classic',
        graphicsCustom:  getSettings().graphicsCustom,
        brightness:      num('settingBrightness'),
        showCoords:     on('settingShowCoords'),
        crosshair:      on('settingCrosshair'),
        showFps:        on('settingShowFps'),
        colorblind:     document.getElementById('settingColorblind')?.value ?? 'none',
        highContrast:   on('settingHighContrast'),
        reduceMotion:   on('settingReduceMotion'),
        largeText:      on('settingLargeText'),
    };
    // Graphics: adjusting any quality control means Custom; choosing Custom keeps
    // what the controls currently show (so it starts from the previous preset);
    // choosing a preset moves the controls to its values.
    const id = e?.target?.id;
    if (GRAPHICS_IDS.includes(id)) s.graphics = 'custom';
    if (s.graphics === 'custom' && (GRAPHICS_IDS.includes(id) || id === 'settingGraphics' || !s.graphicsCustom)) {
        s.graphicsCustom = readGraphicsForm();
    }
    saveSettings(s);
    if (id === 'settingGraphics' || GRAPHICS_IDS.includes(id)) populateSettingsForm();
    _updateSettingLabels();
    applyPlayerSettings(s);
}

function resetSettings() {
    // Who the player is — their character, their name — is not a setting to put back.
    const { skin, playerName, clientId, profiles, onlineCredential } = getSettings();
    saveSettings({ ...DEFAULT_SETTINGS, skin, playerName, clientId, profiles, onlineCredential });
    populateSettingsForm();
    applyPlayerSettings(getSettings());
}

// ── Time and weather (per world) ──────────────────────────────────────────────
// Daylight Cycle and Weather are stored in the world's world.json. Time of Day
// is a one-shot jump applied when the settings are applied; the clock itself is
// saved with the player state (world.js / Atmosphere.toJSON).

/** Fill the Daylight Cycle / Weather controls (prefix 'setting' or 'worldSettings'). */
function _populateAtmosphereControls(prefix, world) {
    const cycle = document.getElementById(prefix + 'DaylightCycle');
    if (cycle) cycle.checked = world.daylightCycle !== false;
    const weather = document.getElementById(prefix + 'Weather');
    if (weather) weather.value = world.weather ?? 'dynamic';
    const time = document.getElementById(prefix + 'TimeOfDay');
    if (time) time.value = '';
    syncSegments();
}

function _readAtmosphereControls(prefix) {
    return {
        daylightCycle: document.getElementById(prefix + 'DaylightCycle')?.checked ?? true,
        weather: document.getElementById(prefix + 'Weather')?.value || 'dynamic',
    };
}

/**
 * Save a world's settings (world.json on the server) and update our copy.
 * `changes`: { gameMode, difficulty, daylightCycle, weather }. Returns the keys
 * that actually changed, so nothing is sent or re-applied for an untouched form.
 */
async function saveWorldSettingsFor(world, changes) {
    const changed = Object.keys(changes).filter(k => (world[k] ?? WORLD_SETTING_DEFAULTS[k]) !== changes[k]);
    if (changed.length === 0) return changed;
    Object.assign(world, changes);
    try {
        await fetch(`${SERVER_URL}/api/worlds/${world.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes),
        });
    } catch { /* offline */ }
    return changed;
}
const WORLD_SETTING_DEFAULTS = { gameMode: 'SURVIVAL', difficulty: 'NORMAL', daylightCycle: true, weather: 'dynamic' };

/**
 * The World tab of the in-game settings, applied to the running world. There
 * is no Apply button: this runs when the settings screen closes (closeSettings).
 */
async function applyWorldSettings() {
    const world = activeWorld;
    if (!world || !gameStarted) return;
    const changes = {
        gameMode:   DOM.settingGameMode?.value ?? 'SURVIVAL',
        difficulty: document.getElementById('settingDifficulty')?.value ?? 'NORMAL',
        ..._readAtmosphereControls('setting'),
    };
    const time = document.getElementById('settingTimeOfDay');
    const timeRaw = time?.value ?? '';
    if (time) time.value = '';   // a one-shot jump, not a setting
    const changed = await saveWorldSettingsFor(world, changes);
    if (changed.includes('gameMode')) callWorldJS("setGameMode", { gameMode: changes.gameMode });
    if (timeRaw !== '' || changed.includes('daylightCycle') || changed.includes('weather')) {
        callWorldJS("setAtmosphere", {
            daylightCycle: changes.daylightCycle,
            // Only a new choice starts a change of weather; re-sending the same
            // one would restart it.
            weather: changed.includes('weather') ? changes.weather : null,
            hours: timeRaw === '' ? null : parseFloat(timeRaw),
        });
    }
}

// The settings screen shows one section at a time, picked from the list down
// its left side: each .settingsPanel and its .settingsTab share a data-section.
let _settingsSection = 'video';
window.switchSettingsTab = function (section) {
    _settingsSection = section;
    document.querySelectorAll('.settingsPanel[data-section]').forEach(el =>
        el.classList.toggle('hidden', el.dataset.section !== section));
    document.querySelectorAll('.settingsTab[data-section]').forEach(el =>
        el.classList.toggle('active', el.dataset.section === section));
    const scroll = document.querySelector('.settingsScroll');
    if (scroll) scroll.scrollTop = 0;
};

// ── Segmented choices ────────────────────────────────────────────────────────
// A <select class="seg"> with a handful of options is shown as a row of
// buttons, all of them in view and one click each, instead of a list to open.
// The select stays in the page, hidden, and keeps the value: everything that
// reads or sets it works as before. A click sets it and fires the events a
// real choice would; after code sets a value, syncSegments() moves the
// highlight to match.
function buildSegments() {
    document.querySelectorAll('select.seg').forEach(sel => {
        const group = document.createElement('div');
        group.className = 'segGroup';
        for (const opt of sel.options) {
            const b = document.createElement('div');
            b.className = 'segBtn';
            b.textContent = opt.textContent;
            b.dataset.value = opt.value;
            // A colour is a patch of it; its name is the tooltip.
            if (opt.dataset.swatch) {
                b.classList.add('swatch');
                b.style.setProperty('--swatch', opt.dataset.swatch);
                b.title = opt.textContent;
                b.textContent = '';
            }
            b.addEventListener('click', () => {
                if (sel.value === opt.value) return;
                sel.value = opt.value;
                syncSegments(sel);
                sel.dispatchEvent(new Event('input', { bubbles: true }));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            });
            group.appendChild(b);
        }
        sel.insertAdjacentElement('afterend', group);
        sel._segGroup = group;
    });
    syncSegments();
}

/** Move each segmented control's highlight to its select's value (all of them, or one). */
function syncSegments(only = null) {
    for (const sel of only ? [only] : document.querySelectorAll('select.seg')) {
        sel._segGroup?.querySelectorAll('.segBtn').forEach(b => b.classList.toggle('on', b.dataset.value === sel.value));
    }
}

/* =========================================================
   WORLD SETTINGS MODAL
========================================================= */

function openWorldSettingsModal() {
    if (!activeWorld) return;
    DOM.worldSettingsGameMode.value = activeWorld.gameMode ?? 'SURVIVAL';
    const diffEl = document.getElementById('worldSettingsDifficulty');
    if (diffEl) diffEl.value = activeWorld.difficulty ?? 'NORMAL';
    _populateAtmosphereControls('worldSettings', activeWorld);
    DOM.worldDetailModal.classList.add("hidden");
    DOM.worldSettingsModal.classList.remove("hidden");
}

/** Close the world settings window (from the world list); what it shows is saved as it closes. */
async function closeWorldSettingsModal() {
    DOM.worldSettingsModal.classList.add("hidden");
    if (!activeWorld) return;
    const world = activeWorld;
    await saveWorldSettingsFor(world, {
        gameMode:   DOM.worldSettingsGameMode.value,
        difficulty: document.getElementById('worldSettingsDifficulty')?.value ?? 'NORMAL',
        ..._readAtmosphereControls('worldSettings'),
    });
    if (activeWorld === world) showWorldDetail(world);
}

/* =========================================================
   WORLD LIST
========================================================= */

async function showWorldList() {
    DOM.titleScreen.classList.add("hidden");
    DOM.titleLogo?.classList.add("hidden");   // hide the big logo behind the world list
    DOM.worldListScreen.classList.remove("hidden");
    DOM.worldListContainer.innerHTML = '<div class="listNote">Looking for your worlds…</div>';

    let worlds = [];
    try {
        const res = await fetch(`${SERVER_URL}/api/worlds`);
        if (res.ok) worlds = await res.json();
    } catch (e) { console.warn('Server not reachable', e); }

    renderWorldList(worlds);
}

function renderWorldList(worlds) {
    if (worlds.length === 0) {
        DOM.worldListContainer.innerHTML =
            '<div class="listNote">No worlds yet.<br>Press <strong>+ New World</strong> to make your first.</div>';
        return;
    }
    DOM.worldListContainer.innerHTML = '';
    for (const world of worlds) {
        const card = document.createElement('div');
        card.className = 'worldCard';
        const lastPlayed = world.lastPlayed ? new Date(world.lastPlayed).toLocaleDateString() : 'never';
        // Cache-busted thumbnail; a patch of sky and grass if the world has no screenshot yet.
        const thumb = `${SERVER_URL}/user/worlds/${world.id}/screenshot.jpg?t=${world.lastPlayed ?? 0}`;
        card.innerHTML = `
            <div class="worldCardLeft">
                <img class="worldCardThumb" src="${thumb}" alt=""
                     onerror="this.onerror=null; this.src='data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; this.classList.add('noThumb')">
                <div class="worldCardInfo">
                    <div class="worldCardName">${escapeHtml(world.name)}</div>
                    <div class="worldCardMeta">
                        <span class="tag mode">${_titleCaseName(world.gameMode ?? 'SURVIVAL')}</span>
                        ${world.worldType === 'flat' ? '<span class="tag">Flat</span>' : ''}
                        <span class="tag">Played ${lastPlayed}</span>
                        <span class="tag">Seed ${world.seed}</span>
                    </div>
                </div>
            </div>
            <div class="worldCardBtns">
                <div class="menuButton small" data-act="more">Options</div>
                <div class="menuButton small primary" data-act="play">Play</div>
            </div>
        `;
        // Straight in with Play; anywhere else on the card opens its options.
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-act="play"]')) startWorld(world);
            else showWorldDetail(world);
        });
        DOM.worldListContainer.appendChild(card);
    }
}

function showWorldDetail(world) {
    activeWorld = world;
    DOM.worldDetailName.textContent = world.name;
    DOM.worldDetailInfo.textContent =
        `${_titleCaseName(world.gameMode ?? 'SURVIVAL')}  ·  ${_titleCaseName(world.difficulty ?? 'NORMAL')}\nSeed ${world.seed}`;
    DOM.worldDetailModal.classList.remove("hidden");
}

/* =========================================================
   CREATE WORLD
========================================================= */

// ── Flat worlds (New World → World Type) ─────────────────────────────────────
// Level ground with no terrain generated: either the player's own stack of
// layers with one biome, or biomes by climate, each with its own ground
// (src/scripts/engine/FlatWorld.js). The stacks a player can start from:
const FLAT_PRESETS = {
    classic:  { label: 'Classic',       biome: 'PLAINS', layers: [['GRASS', 1], ['DIRT', 3], ['BEDROCK', 1]] },
    deep:     { label: 'Deep ground',   biome: 'PLAINS', layers: [['GRASS', 1], ['DIRT', 3], ['STONE', 56], ['BEDROCK', 1]] },
    desert:   { label: 'Desert',        biome: 'DESERT', layers: [['SAND', 4], ['SANDSTONE', 8], ['STONE', 16], ['BEDROCK', 1]] },
    snow:     { label: 'Snowfield',     biome: 'SNOWY_PLAINS', layers: [['SNOW', 2], ['SNOW_DIRT', 1], ['DIRT', 3], ['STONE', 16], ['BEDROCK', 1]] },
    quarry:   { label: 'Stone floor',   biome: 'PLAINS', layers: [['STONE', 8], ['BEDROCK', 1]] },
    planks:   { label: "Builder's floor", biome: 'PLAINS', layers: [['WOODEN_PLANKS', 1], ['STONE', 4], ['BEDROCK', 1]] },
};
const FLAT_DEPTHS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, 48, 64];
const FLAT_MAX_LAYERS = 16;
let _flatLayers = [];      // [{ block, depth }], top first

/** The blocks a layer can be: every whole block of the loaded packs. */
function _flatBlockChoices() {
    return (mergedGamePackData.blocks ?? [])
        .filter(b => b.id !== 0 && b.name && !b.model)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function _setFlatPreset(key) {
    const p = FLAT_PRESETS[key] ?? FLAT_PRESETS.classic;
    const have = new Set(_flatBlockChoices().map(b => b.name));
    _flatLayers = p.layers.filter(([b]) => have.has(b)).map(([block, depth]) => ({ block, depth }));
    const biome = document.getElementById('newFlatBiome');
    if (biome && [...biome.options].some(o => o.value === p.biome)) biome.value = p.biome;
    _renderFlatLayers();
}

function _renderFlatLayers() {
    const list = document.getElementById('flatLayerList');
    if (!list) return;
    const blocks = _flatBlockChoices();
    list.innerHTML = '';
    _flatLayers.forEach((layer, i) => {
        const row = document.createElement('div');
        row.className = 'layerRow';
        const def = blocks.find(b => b.name === layer.block);
        // Its picture: the block's own texture, or failing that its colour.
        const file = def?.textures?.top ?? def?.texture;
        const tex = file ? `data/textures/blocks/${file}` : (ITEM_TEXTURES[layer.block.toLowerCase()] ?? '');
        const rgb = (def?.topColor ?? def?.color ?? [0.4, 0.4, 0.4]).map(v => Math.round(v * 255)).join(',');
        const depths = FLAT_DEPTHS.includes(layer.depth) ? FLAT_DEPTHS : [...FLAT_DEPTHS, layer.depth].sort((a, b) => a - b);
        row.innerHTML = `
            <span class="layerSwatch" style="background-color:rgb(${rgb});${tex ? `background-image:url('${tex}')` : ''}"></span>
            <select class="settingsSelect layerBlock">${blocks.map(b =>
                `<option value="${b.name}"${b.name === layer.block ? ' selected' : ''}>${_titleCaseName(b.name)}</option>`).join('')}</select>
            <select class="settingsSelect layerDepth">${depths.map(d =>
                `<option value="${d}"${d === layer.depth ? ' selected' : ''}>${d} ${d === 1 ? 'block' : 'blocks'}</option>`).join('')}</select>
            <div class="menuButton small${i === 0 ? ' off' : ''}" data-act="up" title="Move up">&#9650;</div>
            <div class="menuButton small${i === _flatLayers.length - 1 ? ' off' : ''}" data-act="down" title="Move down">&#9660;</div>
            <div class="menuButton small danger${_flatLayers.length === 1 ? ' off' : ''}" data-act="remove" title="Remove">&#10005;</div>`;
        row.querySelector('.layerBlock').addEventListener('change', (e) => { layer.block = e.target.value; _renderFlatLayers(); });
        row.querySelector('.layerDepth').addEventListener('change', (e) => { layer.depth = Number(e.target.value); _renderFlatLayers(); });
        row.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'up' && i > 0) [_flatLayers[i - 1], _flatLayers[i]] = [_flatLayers[i], _flatLayers[i - 1]];
            else if (act === 'down' && i < _flatLayers.length - 1) [_flatLayers[i + 1], _flatLayers[i]] = [_flatLayers[i], _flatLayers[i + 1]];
            else if (act === 'remove' && _flatLayers.length > 1) _flatLayers.splice(i, 1);
            else return;
            _renderFlatLayers();
        });
        list.appendChild(row);
    });
    const total = _flatLayers.reduce((n, l) => n + l.depth, 0);
    const note = document.getElementById('flatLayerNote');
    if (note) note.textContent = `${total} ${total === 1 ? 'block' : 'blocks'} deep, with nothing underneath`;
    document.getElementById('flatAddLayerBtn')?.classList.toggle('cannot', _flatLayers.length >= FLAT_MAX_LAYERS);
}

/** Show the rows that go with the chosen world type and kind of ground. */
function updateFlatForm() {
    const flat = document.getElementById('newWorldType')?.value === 'flat';
    const layers = document.getElementById('newFlatMode')?.value !== 'biomes';
    document.querySelectorAll('#CreateWorldModal .flatRow').forEach(el => {
        el.classList.toggle('hidden', !flat || (el.classList.contains('layersRow') && !layers));
    });
}

/** Fill the form's lists (once the packs are loaded) and put it back to a normal world. */
function resetFlatForm() {
    const preset = document.getElementById('newFlatPreset');
    const biome  = document.getElementById('newFlatBiome');
    if (!preset || !biome) return;
    preset.innerHTML = Object.entries(FLAT_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
    const land = (mergedGamePackData.biomes ?? []).filter(b => b.name && (b.category ?? 'land') === 'land');
    biome.innerHTML = land.sort((a, b) => a.name.localeCompare(b.name))
        .map(b => `<option value="${b.name}">${_titleCaseName(b.name)}</option>`).join('');
    document.getElementById('newWorldType').value = 'normal';
    document.getElementById('newFlatMode').value = 'layers';
    document.getElementById('newFlatDecor').checked = true;
    document.getElementById('newFlatStruct').checked = false;
    _setFlatPreset('classic');
    updateFlatForm();
}

/** What the form says a new Flat world is made of (the server checks it again). */
function readFlatForm() {
    const mode = document.getElementById('newFlatMode').value === 'biomes' ? 'biomes' : 'layers';
    return {
        mode,
        layers: mode === 'layers' ? _flatLayers.map(l => ({ block: l.block, depth: l.depth })) : [],
        biome: mode === 'layers' ? document.getElementById('newFlatBiome').value : null,
        decorations: document.getElementById('newFlatDecor').checked,
        structures: document.getElementById('newFlatStruct').checked,
    };
}

function showCreateWorldModal() {
    DOM.newWorldName.value = '';
    DOM.newWorldSeed.value = '';
    DOM.newWorldGameMode.value = 'SURVIVAL';
    resetFlatForm();
    syncSegments();
    DOM.createWorldModal.classList.remove("hidden");
    DOM.newWorldName.focus();
}

async function createWorld() {
    const name       = DOM.newWorldName.value.trim() || 'New World';
    const seedRaw    = DOM.newWorldSeed.value.trim();
    const seed       = seedRaw !== '' ? (parseInt(seedRaw, 10) || hashString(seedRaw)) : undefined;
    const gameMode   = DOM.newWorldGameMode.value || 'SURVIVAL';
    const difficulty = document.getElementById('newWorldDifficulty')?.value || 'NORMAL';
    const flat       = document.getElementById('newWorldType')?.value === 'flat';

    try {
        const res = await fetch(`${SERVER_URL}/api/worlds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, seed, gameMode, difficulty,
                                   ...(flat ? { worldType: 'flat', flat: readFlatForm() } : {}) }),
        });
        if (!res.ok) throw new Error('Server error');
        const newWorld = await res.json();
        DOM.createWorldModal.classList.add("hidden");
        startWorld(newWorld);
    } catch (e) {
        console.error('Failed to create world:', e);
        alert('Could not create world — is the server running?');
    }
}

/* =========================================================
   GAME STARTUP
========================================================= */

function startWorld(world) {
    stopMenuWorld();
    activeWorld = world;
    gameStarted = true;
    paused      = false;
    _menuOpen   = false;
    // Reset the frame clock so the first gameLoop() of this world starts fresh.
    // Otherwise the leftover timestamp from a previous world makes the first dt
    // compute as NaN (undefined - oldTimestamp), which corrupts player physics
    // into NaN positions and stalls chunk generation until a page refresh.
    _lastFrameTime = 0;
    _nextFrameAt = 0;

    DOM.worldListScreen.classList.add("hidden");
    DOM.titleScreen.classList.add("hidden");

    DOM.packName.style.display = packsLoaded === 1 ? "none" : "block";
    DOM.loadingBar.style.width = "0%";
    DOM.loadingText.textContent = "Loading World...";
    DOM.packName.textContent = `${packsLoaded} Gamepacks Successfully Loaded`;
    // The logo waits with the loading card (the world list had put it away).
    DOM.titleLogo.classList.remove("hidden");
    DOM.logo.classList.add("Loading");
    DOM.loadingContainer.classList.remove("hidden");

    callWorldJS("startWorldLoad", {
        gamepackData: mergedGamePackData,
        worldId:   world.id,
        worldSeed: world.seed,
        playerPos: world.playerPos ?? { x: 0, y: 100, z: 0 },
        gameMode:  world.gameMode  ?? 'SURVIVAL',
        // Hidden world setting — not on any settings screen. Lives in the
        // world's world.json; new worlds get TERRAIN_STYLE from server/server.js.
        // A world with no value predates the setting and was built blocky.
        terrainStyle: world.terrainStyle ?? 'blocky',
        // The generator the world was made with (server.js WORLD_GEN); worlds
        // from before the field keep the old one (workers/legacy/).
        worldGen: world.worldGen ?? 1,
        // A Flat world's settings (what it is made of), or null for a normal one.
        flat: world.worldType === 'flat' ? (world.flat ?? {}) : null,
        // Not this player's world (a further pane, a guest from the network):
        // their place in it is kept under their own name.
        guest: isGuest() || _onlineGuest, stateKey: isGuest() ? guestStateKey() : '',
        // An online game (src/scripts/Online.js holds its room): the session, and for a guest the world itself, come through it.
        online: !!world.online,
        workers: PANE > 0 ? Math.max(2, Math.floor(((navigator.hardwareConcurrency || 4) - 1) / (parseInt(PARAMS.get('of')) || 2))) : 0,
        // World Settings → Daylight Cycle and Weather ('dynamic' or a held type).
        daylightCycle: world.daylightCycle !== false,
        weather: world.weather ?? 'dynamic',
    });

    startLoadingTextRotation();
    const quit = document.getElementById('pauseQuitBtn');
    if (quit) quit.textContent = isGuest() || _onlineGuest ? 'Leave Game' : 'Save & Quit';
    // Someone else's world: its settings are not this player's to change (game.css hides them).
    document.body.classList.toggle('isGuest', isGuest() || _onlineGuest);

    // Start ticking now so terrain generates/meshes *behind* the loading screen.
    // We reveal the world from ww_loadProgress once enough chunks have rendered;
    // the fallback timer guarantees we never hang on the loading screen.
    _loadingActive = true;
    clearTimeout(_loadFallbackTimer);
    _loadFallbackTimer = setTimeout(finishGameStartup, 30000);
    startLoop();
}

// Called repeatedly from world.js (ww_loadProgress) while the loading screen is up.
window.addEventListener('ww_loadProgress', (e) => {
    if (!_loadingActive) return;
    const progress = e.detail?.progress ?? 0;
    if (DOM.loadingBar) DOM.loadingBar.style.width = `${Math.round(progress * 100)}%`;
    if (e.detail?.ready) finishGameStartup();
});

function finishGameStartup() {
    if (!_loadingActive) return;   // guard against the fallback + ready both firing
    _loadingActive = false;
    window.__wwSound?.stopMusic();
    clearTimeout(_loadFallbackTimer);

    if (DOM.loadingBar) DOM.loadingBar.style.width = "100%";
    stopLoadingTextRotation();
    DOM.loadingContainer.classList.add("hidden");
    DOM.gameScreen.classList.remove("hidden");
    DOM.titleLogo.classList.add("hidden");
    setTimeout(requestGameLock, 10);
    initializeHotbar();
    // gameLoop is already running (started in startWorld via startLoop()).
}

/* =========================================================
   ASSET APPLICATION
========================================================= */

function applyLoadedAssets() {
    if (textures.logo) {
        DOM.logo.src = textures.logo;
        DOM.pauseLogo.src = textures.logo;
    }
}

/* =========================================================
   HOTBAR
========================================================= */

function initializeHotbar() {
    updateHotbarSelection(0);
    refreshHotbarUI();
}

function updateHotbarSelection(slot) {
    document.querySelectorAll('.hotbarSlot[data-slot]').forEach(el => {
        el.classList.toggle('selected', parseInt(el.dataset.slot) === slot);
    });
}

const ITEM_TEXTURES = {
    // Block-derived items — use block face textures
    grass:        'data/textures/blocks/Grass.png',
    dirt:         'data/textures/blocks/Dirt.png',
    stone:        'data/textures/blocks/Stone.png',
    sand:         'data/textures/blocks/Sand.png',
    gravel:       'data/textures/blocks/gravel.png',
    wood_log:     'data/textures/blocks/Log_Side.png',
    leaves:       'data/textures/blocks/leaves.png',
    sandstone:    'data/textures/blocks/Sandstone.png',
    clay_ball:    'data/textures/blocks/Clay.png',
    granite:      'data/textures/blocks/Granite.png',
    diorite:      'data/textures/blocks/Diorite.png',
    bedrock:      'data/textures/blocks/Bedrock.png',
    ice:          'data/textures/blocks/Ice.png',
    snow:         'data/textures/blocks/snow.png',
    snow_dirt:    'data/textures/blocks/SnowDirt.png',
    water_bucket: 'data/textures/blocks/Water.png',
    water:        'data/textures/blocks/Water.png',
    coal:         'data/textures/blocks/Coal_Ore.png',
    raw_iron:     'data/textures/blocks/Iron_Ore.png',
    raw_gold:     'data/textures/blocks/Gold_Ore.png',
};

function itemTextureSrc(itemId) {
    if (!itemId) return '';
    if (_itemIcons[itemId]) return _itemIcons[itemId];
    if (_blockColorIcons[itemId]) return _blockColorIcons[itemId];
    return ITEM_TEXTURES[itemId] ?? `data/textures/items/${itemId}.png`;
}
window._itemTextureSrc = itemTextureSrc;

// Items can name their own icon ("icon" in the item JSON): it wins over
// everything below. A block that names its texture ("texture" / "textures")
// shows that; other coloured blocks (ids ≥ 25) have no PNG, so get a swatch
// icon from their colour to show up in the hotbar / inventory / creative grid.
const _itemIcons = {};
const _blockColorIcons = {};
function _buildBlockColorIcons() {
    for (const it of (mergedGamePackData.items ?? [])) if (it.icon) _itemIcons[it.id] = it.icon;
    for (const def of (mergedGamePackData.blocks ?? [])) {
        const tex = def.texture ?? def.textures?.side ?? def.textures?.top;
        if (tex) { _blockColorIcons[def.name.toLowerCase()] = `data/textures/blocks/${tex}`; continue; }
        if ((def.id ?? 0) < 25 || !def.color) continue;
        _blockColorIcons[def.name.toLowerCase()] = _makeColorSwatch(def.color);
    }
}
function _makeColorSwatch([r, g, b]) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`;
    ctx.fillRect(0, 0, 16, 16);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 14, 14);
    return c.toDataURL();
}

function refreshHotbarUI() {
    const inv = window.me.inventory;
    if (!inv) return;
    document.querySelectorAll('.hotbarSlot[data-slot]').forEach(el => {
        const i    = parseInt(el.dataset.slot);
        const slot = inv.hotbar?.[i];
        const img  = el.querySelector('img');
        if (img) {
            img.src   = slot ? itemTextureSrc(slot.itemId) : '';
            img.style.display = slot ? 'block' : 'none';
        }
        _setSlotCount(el, slot);
        el.title = slot ? `${slot.itemId} ×${slot.count}` : '';
    });
    // Offhand slot
    const offEl = document.querySelector('.hotbarSlot.offhand');
    if (offEl) {
        const offImg = offEl.querySelector('img');
        const offItem = inv.offhand;
        if (offImg) {
            offImg.src = offItem ? itemTextureSrc(offItem.itemId) : '';
            offImg.style.display = offItem ? 'block' : 'none';
        }
        _setSlotCount(offEl, offItem);
        offEl.title = offItem ? offItem.itemId.replace(/_/g, ' ') : '';
    }
}

// Show the stack count in a hotbar slot (hidden for empty slots or single items).
function _setSlotCount(el, slot) {
    let countEl = el.querySelector('.hotbarCount');
    if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'hotbarCount';
        el.appendChild(countEl);
    }
    const n = slot?.count ?? 0;
    if (n > 1) {
        countEl.textContent = String(n);
        countEl.style.display = 'block';
    } else {
        countEl.style.display = 'none';
    }
}

/* =========================================================
   INTERACTIVE BLOCK UI (crafting, oven, smelter, etc.)
========================================================= */

let _activeStation = null;
let _selectedRecipeId = null;

function openInteractivePanel({ interactType, x, y, z }) {
    _activeStation = interactType;
    _selectedRecipeId = null;

    DOM.interactivePanelTitle.textContent = {
        hand: 'Hand Crafting', crafting: 'Crafting Table', oven: 'Oven',
        smelter: 'Smelter', chest: 'Chest', anvil: 'Anvil',
    }[interactType] ?? interactType;

    populateRecipeList(interactType);
    DOM.interactivePanel.classList.remove("hidden");
    _menuOpen = true;   // set before releasing the pointer so pointerlockchange won't pause
    if (document.pointerLockElement) document.exitPointerLock();
}

function closeInteractivePanel() {
    DOM.interactivePanel.classList.add("hidden");
    _activeStation = null;
    _menuOpen = false;
    requestGameLock();
}

/* =========================================================
   INVENTORY SCREEN
========================================================= */

function openInventory() {
    if (!DOM.inventoryScreen) return;
    _menuOpen = true;   // set before releasing the pointer so pointerlockchange won't pause
    if (document.pointerLockElement) document.exitPointerLock();
    _invCursor = null;
    _updateInvCraftBtn();
    _renderInventory();
    DOM.inventoryScreen.classList.remove('hidden');
}

function closeInventory(suppressLock = false) {
    // Return any held cursor item to inventory before closing
    if (_invCursor) {
        const inv = window.me?.inventory;
        if (inv) inv.addItem(_invCursor.itemId, _invCursor.count);
        _invCursor = null;
        _hideCursorItem();
    }
    DOM.inventoryScreen?.classList.add('hidden');
    _menuOpen = false;
    refreshHotbarUI();
    if (!suppressLock) requestGameLock();
}

// ── Inventory craft button label ─────────────────────────────────────────────

function _updateInvCraftBtn() {
    if (!DOM.invCraftBtn) return;
    const mode = activeWorld?.gameMode ?? 'SURVIVAL';
    if (mode === 'SPECTATOR') {
        DOM.invCraftBtn.style.display = 'none';
        return;
    }
    DOM.invCraftBtn.style.display = '';
    DOM.invCraftBtn.textContent = mode === 'CREATIVE' ? 'Creative Inventory' : 'Crafting';
}

// ── Hand crafting (Survival) ─────────────────────────────────────────────────

function openHandCraft() {
    openInteractivePanel({ interactType: 'hand', x: 0, y: 0, z: 0 });
}

// ── Creative inventory ────────────────────────────────────────────────────────

function openCreativeInventory() {
    if (!DOM.creativeInvPanel) return;
    if (DOM.creativeInvFilter) DOM.creativeInvFilter.value = '';
    _populateCreativeGrid('');
    DOM.creativeInvPanel.classList.remove('hidden');
    _menuOpen = true;   // set before releasing the pointer so pointerlockchange won't pause
    if (document.pointerLockElement) document.exitPointerLock();
}

function closeCreativeInventory() {
    DOM.creativeInvPanel?.classList.add('hidden');
    _menuOpen = false;
    requestGameLock();
}

// Creative inventory entries: every item, plus a placeable entry for any block
// that has no (non-food) item representing it — so grass, snow, ice, leaves,
// bedrock, water, etc. can still be placed. Block entries use the block's
// lowercased name as their id, which the placement resolver maps back to it.
function _creativeEntries() {
    const items  = mergedGamePackData.items  ?? [];
    const blocks = mergedGamePackData.blocks ?? [];
    const byNameLower = new Map(blocks.map(b => [b.name.toLowerCase(), b]));

    const covered = new Set();   // block ids already reachable via a non-food item
    for (const it of items) {
        if (it.type === 'food') continue;
        let blk = byNameLower.get(it.id);
        if (!blk) blk = blocks.find(b => (b.drops || []).some(d => (d.itemId ?? d.item) === it.id));
        if (blk) covered.add(blk.id);
    }

    // A block another one places for a particular face (a wall torch, a hanging
    // lantern) comes from that block's item; it is not an entry of its own.
    const variants = new Set();
    for (const b of blocks) {
        for (const name of Object.values(b.placement ?? {})) if (name && name !== b.name) variants.add(name);
    }

    const blockEntries = blocks
        .filter(b => b.id !== 0 && !covered.has(b.id) && !variants.has(b.name))
        .map(b => ({ id: b.name.toLowerCase(), name: _titleCaseName(b.name) }));

    return [...items, ...blockEntries];
}

function _titleCaseName(s) {
    return String(s).toLowerCase().split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _populateCreativeGrid(filter) {
    if (!DOM.creativeInvGrid) return;
    DOM.creativeInvGrid.innerHTML = '';

    const allItems = _creativeEntries();
    const shown = filter
        ? allItems.filter(it => it.id.toLowerCase().includes(filter) || (it.name ?? '').toLowerCase().includes(filter))
        : allItems;

    for (const itemDef of shown) {
        const el = document.createElement('div');
        el.className = 'invGridSlot';
        el.title = itemDef.id.replace(/_/g, ' ');

        const img = document.createElement('img');
        img.src = itemTextureSrc(itemDef.id);
        img.alt = '';
        el.appendChild(img);

        const lbl = document.createElement('span');
        lbl.className = 'invGridKeybind name';
        lbl.textContent = (itemDef.name ?? itemDef.id).replace(/_/g, ' ').slice(0, 9);
        el.appendChild(lbl);

        el.addEventListener('click', () => {
            const inv = window.me?.inventory;
            if (!inv) return;
            // Stack onto an existing stack of the same item first (addItem fills
            // matching stacks, then empty hotbar slots, then general inventory).
            inv.addItem(itemDef.id, 1);
            refreshHotbarUI();
        });

        DOM.creativeInvGrid.appendChild(el);
    }
}

// ── Inventory interaction state ──────────────────────────────────────────────

let _invCursor = null;  // { type, index, itemId, count } — item "held" on cursor

function _renderInventory() {
    const inv = window.me?.inventory;
    if (!inv) return;

    // Weight: hotbar + slots + equipment all count
    const w   = inv.currentWeight ?? 0;
    const max = inv.maxWeight ?? 100;
    if (DOM.invWeightLabel) DOM.invWeightLabel.textContent = `Weight: ${w} / ${max}`;

    // Equipment column
    if (DOM.invEquip) {
        const EQUIP_SLOTS = [
            ['head',   'Helmet'],
            ['chest',  'Chest'],
            ['legs',   'Legs'],
            ['feet',   'Boots'],
            ['quiver', 'Quiver'],
        ];
        DOM.invEquip.innerHTML = '';
        for (const [key, label] of EQUIP_SLOTS) {
            const item = inv.equipment?.[key] ?? null;
            const el   = _makeSlotEl({ type: 'equip', index: key }, item, label);
            DOM.invEquip.appendChild(el);
        }
    }

    // Hotbar row
    if (DOM.invHotbarRow) {
        DOM.invHotbarRow.innerHTML = '';
        const label = document.createElement('div');
        label.className = 'invSectionTitle';
        label.textContent = 'Hotbar';
        DOM.invHotbarRow.appendChild(label);

        // The ten hotbar slots, then the off hand, set a little apart.
        const row = document.createElement('div');
        row.className = 'invRow';
        for (let i = 0; i < 10; i++) {
            const slot = inv.hotbar?.[i] ?? null;
            const el   = _makeSlotEl({ type: 'hotbar', index: i }, slot, `${i === 9 ? 0 : i + 1}`);
            row.appendChild(el);
        }
        const offLabel = document.createElement('span');
        offLabel.className = 'invRowLabel';
        offLabel.style.marginLeft = '1.2vw';
        offLabel.textContent = 'Off hand';
        row.appendChild(offLabel);
        row.appendChild(_makeSlotEl({ type: 'offhand', index: 0 }, inv.offhand ?? null, ''));
        DOM.invHotbarRow.appendChild(row);
    }

    // General inventory grid
    if (DOM.invSlots) {
        DOM.invSlots.innerHTML = '';
        for (let i = 0; i < inv.slots.length; i++) {
            DOM.invSlots.appendChild(_makeSlotEl({ type: 'general', index: i }, inv.slots[i], ''));
        }
        // Always show at least 10 slots, plus one trailing empty slot for new items
        const shown = Math.max(inv.slots.length + 1, 10);
        for (let i = inv.slots.length; i < shown; i++) {
            DOM.invSlots.appendChild(_makeSlotEl({ type: 'general', index: i }, null, ''));
        }
    }

    // Highlight cursor slot
    _highlightCursorSlot();
}

function _makeSlotEl(slotRef, item, keybind) {
    const el = document.createElement('div');
    el.className = 'invGridSlot' + (_invCursor ? ' inv-can-drop' : '');
    el.dataset.slotType  = slotRef.type;
    el.dataset.slotIndex = slotRef.index;

    if (item) {
        const img = document.createElement('img');
        img.src = itemTextureSrc(item.itemId);
        img.alt = '';
        el.appendChild(img);
        if (item.count > 1) {
            const cnt = document.createElement('span');
            cnt.className = 'invGridCount';
            cnt.textContent = item.count;
            el.appendChild(cnt);
        }
    }

    if (keybind) {
        const kb = document.createElement('span');
        kb.className = 'invGridKeybind';
        kb.textContent = keybind;
        el.appendChild(kb);
    }

    el.addEventListener('click', (e) => { e.stopPropagation(); _onSlotClick(slotRef, item); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); _onSlotRightClick(slotRef, item); });
    el.addEventListener('mouseenter', () => _showInvTooltip(el, slotRef, item));
    el.addEventListener('mouseleave', _hideInvTooltip);
    return el;
}

function _onSlotClick(slotRef, item) {
    const inv = window.me?.inventory;
    if (!inv) return;

    if (!_invCursor) {
        // Pick up: only if the slot has an item
        if (!item) return;
        _invCursor = { ...slotRef, itemId: item.itemId, count: item.count };
        _clearSlot(inv, slotRef);
        _renderInventory();
        _showCursorItem();
    } else {
        // Put down into this slot
        const targetItem = _getSlot(inv, slotRef);

        if (!targetItem) {
            // Empty target: place cursor item here
            _setSlot(inv, slotRef, { itemId: _invCursor.itemId, count: _invCursor.count });
            _invCursor = null;
        } else if (targetItem.itemId === _invCursor.itemId) {
            // Same item: stack up to maxStack
            const maxStack = inv._maxStack?.(_invCursor.itemId) ?? 64;
            const space = maxStack - targetItem.count;
            if (space > 0) {
                const add = Math.min(space, _invCursor.count);
                targetItem.count += add;
                _invCursor.count -= add;
                if (_invCursor.count <= 0) _invCursor = null;
            } else {
                // Full stack: swap
                const held = { ..._invCursor };
                _invCursor = { ...slotRef, itemId: targetItem.itemId, count: targetItem.count };
                _setSlot(inv, slotRef, { itemId: held.itemId, count: held.count });
            }
        } else {
            // Different item: swap
            const held = { ..._invCursor };
            _invCursor = { ...slotRef, itemId: targetItem.itemId, count: targetItem.count };
            _setSlot(inv, slotRef, { itemId: held.itemId, count: held.count });
        }

        refreshHotbarUI();
        _renderInventory();
        if (_invCursor) _showCursorItem(); else _hideCursorItem();
    }
}

function _onSlotRightClick(slotRef, item) {
    const inv = window.me?.inventory;
    if (!inv) return;

    // Quiver slot: deposit arrows from cursor, or take arrows empty-handed
    if (slotRef.type === 'equip' && slotRef.index === 'quiver' && item) {
        const itemDef = mergedGamePackData.items?.find(it => it.id === item.itemId);
        const maxArrows = itemDef?.maxArrows ?? 64;
        if (_invCursor?.itemId === 'arrow') {
            const space = maxArrows - (inv.quiverArrows ?? 0);
            if (space > 0) {
                const add = Math.min(space, _invCursor.count);
                inv.quiverArrows = (inv.quiverArrows ?? 0) + add;
                _invCursor.count -= add;
                if (_invCursor.count <= 0) { _invCursor = null; _hideCursorItem(); }
                else _showCursorItem();
                refreshHotbarUI();
                _renderInventory();
            }
            return;
        }
        if (!_invCursor) {
            const arrows = inv.quiverArrows ?? 0;
            if (arrows <= 0) return;
            const arrowDef = mergedGamePackData.items?.find(it => it.id === 'arrow');
            const maxStack = arrowDef?.maxStack ?? 64;
            const take = Math.min(arrows, maxStack);
            inv.quiverArrows -= take;
            _invCursor = { type: 'cursor', index: -1, itemId: 'arrow', count: take };
            refreshHotbarUI();
            _renderInventory();
            _showCursorItem();
            return;
        }
        return;
    }

    // With cursor held + empty target slot: place one item
    if (_invCursor && !item) {
        const maxStack = inv._maxStack?.(_invCursor.itemId) ?? 64;
        const existing = _getSlot(inv, slotRef);
        if (!existing) {
            _setSlot(inv, slotRef, { itemId: _invCursor.itemId, count: 1 });
            _invCursor.count -= 1;
            if (_invCursor.count <= 0) { _invCursor = null; _hideCursorItem(); }
            else _showCursorItem();
            refreshHotbarUI();
            _renderInventory();
        } else if (existing.itemId === _invCursor.itemId && existing.count < maxStack) {
            existing.count += 1;
            _invCursor.count -= 1;
            if (_invCursor.count <= 0) { _invCursor = null; _hideCursorItem(); }
            else _showCursorItem();
            refreshHotbarUI();
            _renderInventory();
        }
        return;
    }

    // No cursor + occupied slot: take half (round up)
    if (!_invCursor && item) {
        const take = Math.ceil(item.count / 2);
        const remain = item.count - take;
        _setSlot(inv, slotRef, remain > 0 ? { itemId: item.itemId, count: remain } : null);
        _invCursor = { type: 'cursor', index: -1, itemId: item.itemId, count: take };
        refreshHotbarUI();
        _renderInventory();
        _showCursorItem();
        return;
    }
}

// ── Inventory tooltip ─────────────────────────────────────────────────────────

let _tooltipEl = null;

function _showInvTooltip(anchorEl, slotRef, item) {
    if (!item) return;
    if (!_tooltipEl) {
        _tooltipEl = document.createElement('div');
        _tooltipEl.id = 'invTooltip';
        document.body.appendChild(_tooltipEl);
    }

    const itemDef = mergedGamePackData.items?.find(it => it.id === item.itemId);
    const displayName = (itemDef?.name ?? item.itemId).replace(/_/g, ' ');
    let text = displayName;

    // Quiver: show arrow count
    if (itemDef?.type === 'quiver' && slotRef.type === 'equip' && slotRef.index === 'quiver') {
        const inv = window.me?.inventory;
        const arrows = inv?.quiverArrows ?? 0;
        const max = itemDef.maxArrows ?? 64;
        text += `\nArrows: ${arrows} / ${max}`;
    }

    _tooltipEl.textContent = text;  // textContent handles newlines in CSS white-space:pre
    _tooltipEl.style.display = 'block';

    const rect = anchorEl.getBoundingClientRect();
    _tooltipEl.style.left = (rect.right + 8) + 'px';
    _tooltipEl.style.top  = rect.top + 'px';

    // Keep inside viewport
    requestAnimationFrame(() => {
        if (!_tooltipEl) return;
        const tr = _tooltipEl.getBoundingClientRect();
        if (tr.right > window.innerWidth) _tooltipEl.style.left = (rect.left - tr.width - 8) + 'px';
        if (tr.bottom > window.innerHeight) _tooltipEl.style.top = (window.innerHeight - tr.height - 4) + 'px';
    });
}

function _hideInvTooltip() {
    if (_tooltipEl) _tooltipEl.style.display = 'none';
}

function _getSlot(inv, ref) {
    if (ref.type === 'hotbar')  return inv.hotbar[ref.index] ?? null;
    if (ref.type === 'offhand') return inv.offhand ?? null;
    if (ref.type === 'equip')   return inv.equipment[ref.index] ?? null;
    return inv.slots[ref.index] ?? null;
}

function _setSlot(inv, ref, item) {
    if (ref.type === 'hotbar')  { inv.hotbar[ref.index] = item; return; }
    if (ref.type === 'offhand') { inv.offhand = item; return; }
    if (ref.type === 'equip')   { inv.equipment[ref.index] = item; return; }
    // General slot — avoid sparse arrays
    if (item) {
        if (ref.index < inv.slots.length) inv.slots[ref.index] = item;
        else inv.slots.push(item);
    } else {
        if (ref.index < inv.slots.length) inv.slots.splice(ref.index, 1);
    }
}

function _clearSlot(inv, ref) { _setSlot(inv, ref, null); }

function _highlightCursorSlot() {
    document.querySelectorAll('.invGridSlot.inv-held').forEach(el => el.classList.remove('inv-held'));
    if (!_invCursor) return;
    const sel = document.querySelector(
        `.invGridSlot[data-slot-type="${_invCursor.type}"][data-slot-index="${_invCursor.index}"]`
    );
    if (sel) sel.classList.add('inv-held');
}

// Floating cursor item element
let _cursorEl = null;
function _showCursorItem() {
    if (!_cursorEl) {
        _cursorEl = document.createElement('div');
        _cursorEl.id = 'invCursorItem';
        document.body.appendChild(_cursorEl);
        document.addEventListener('mousemove', _moveCursor);
    }
    if (_invCursor) {
        _cursorEl.innerHTML = `<img src="${itemTextureSrc(_invCursor.itemId)}" alt=""><span>${_invCursor.count > 1 ? _invCursor.count : ''}</span>`;
        _cursorEl.style.display = 'flex';
    }
}
function _hideCursorItem() {
    if (_cursorEl) _cursorEl.style.display = 'none';
}
function _moveCursor(e) {
    if (_cursorEl) {
        _cursorEl.style.left = (e.clientX + 4) + 'px';
        _cursorEl.style.top  = (e.clientY + 4) + 'px';
    }
}

// Click outside any slot = drop cursor item back (return to source)
document.addEventListener('click', (e) => {
    if (!_invCursor) return;
    if (e.target.closest('#InventoryScreen')) return;
    // Return item to first available hotbar/inventory slot
    const inv = window.me?.inventory;
    if (inv) inv.addItem(_invCursor.itemId, _invCursor.count);
    _invCursor = null;
    _hideCursorItem();
    refreshHotbarUI();
    _renderInventory();
});

const STATION_ALIASES = { crafting: 'crafting_table' };

function populateRecipeList(rawStation) {
    const inv  = window.me.inventory;
    DOM.recipeList.innerHTML = '';
    DOM.recipeDetailName.textContent = '';
    DOM.recipeDetail.innerHTML = '';
    DOM.craftBtn.classList.add('cannot');
    DOM.craftBtn.onclick = null;

    // A block's interactType ("crafting") doesn't always equal the recipe station
    // name ("crafting_table") — normalize so the table actually lists its recipes.
    const station = STATION_ALIASES[rawStation] ?? rawStation;
    const recipes = mergedGamePackData.recipes.filter(r => r.station === station);
    for (const recipe of recipes) {
        const canCraft = inv ? inv.hasIngredients(_ingredientMap(recipe)) : false;
        const itemEl = document.createElement('div');
        itemEl.className = 'recipeListItem' + (canCraft ? '' : ' locked');

        const icon = document.createElement('img');
        icon.src = itemTextureSrc(recipe.result.itemId);
        itemEl.appendChild(icon);

        const lbl = document.createElement('span');
        lbl.textContent = recipe.result.itemId.replace(/_/g, ' ');
        itemEl.appendChild(lbl);

        itemEl.addEventListener('click', () => selectRecipe(recipe, canCraft));
        DOM.recipeList.appendChild(itemEl);
    }
}

function selectRecipe(recipe, canCraft) {
    _selectedRecipeId = recipe.id;
    document.querySelectorAll('.recipeListItem').forEach(el => {
        const span = el.querySelector('span');
        el.classList.toggle('active', span?.textContent === recipe.result.itemId.replace(/_/g, ' '));
    });

    // Result header with icon
    const resultName = recipe.result.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    DOM.recipeDetailName.innerHTML =
        `<img src="${itemTextureSrc(recipe.result.itemId)}" alt="">${resultName}` +
        (recipe.result.count > 1 ? ` <span class="count">×${recipe.result.count}</span>` : '');

    // Ingredient list with icons
    const inv = window.me.inventory;
    DOM.recipeDetail.innerHTML = recipe.ingredients.map(i => {
        const have = inv ? (inv.countItem?.(i.itemId) ?? 0) : 0;
        const ok   = have >= i.count;
        // Green for what you have enough of, red for what you are short of.
        return `<div class="ingredient ${ok ? 'have' : 'need'}">` +
               `<img src="${itemTextureSrc(i.itemId)}" alt="">` +
               `<span>${i.count}× ${i.itemId.replace(/_/g, ' ')} <span class="owned">you have ${have}</span></span>` +
               `</div>`;
    }).join('');

    DOM.craftBtn.classList.toggle('cannot', !canCraft);
    DOM.craftBtn.onclick = canCraft ? () => executeCraft(recipe) : null;
}

function executeCraft(recipe) {
    const inv = window.me.inventory;
    if (!inv) return;
    const needs = _ingredientMap(recipe);
    if (!inv.hasIngredients(needs)) return;
    for (const [id, cnt] of Object.entries(needs)) inv.removeItem(id, cnt);
    const overflow = inv.addItem(recipe.result.itemId, recipe.result.count);
    if (overflow > 0) callWorldJS("dropItem", { itemId: recipe.result.itemId, count: overflow });
    populateRecipeList(_activeStation);
    refreshHotbarUI();
    if (!DOM.inventoryScreen?.classList.contains('hidden')) _renderInventory();
}

function _ingredientMap(recipe) {
    const map = {};
    for (const ing of recipe.ingredients) map[ing.itemId] = (map[ing.itemId] ?? 0) + ing.count;
    return map;
}

/* =========================================================
   LOADING SCREEN TEXTS
========================================================= */

function startLoadingTextRotation() {
    if (loadingTexts.length === 0) return;
    loadingTextInterval = setInterval(() => {
        DOM.loadingText.classList.add("fade-out");
        setTimeout(() => {
            let next = currentLoadingTextIndex;
            while (loadingTexts.length > 1 && next === currentLoadingTextIndex)
                next = Math.floor(Math.random() * loadingTexts.length);
            currentLoadingTextIndex = next;
            const entry = loadingTexts[currentLoadingTextIndex];
            DOM.loadingText.textContent = entry.text;
            DOM.packName.textContent = `${entry.packName} Gamepack`;
            DOM.loadingText.classList.remove("fade-out");
        }, 500);
    }, 4000);
}

function stopLoadingTextRotation() {
    clearInterval(loadingTextInterval);
    loadingTextInterval = null;
}

/* =========================================================
   GAMEPACK LOADING — manifest-based folder structure
========================================================= */

async function loadAllGamePacks() {
    let manifest = null;
    try {
        const res = await fetch(`${SERVER_URL}/api/data/manifest`);
        if (res.ok) manifest = await res.json();
    } catch { /* server offline */ }

    if (manifest) {
        await loadFromManifest(manifest);
    } else {
        // Fall back to legacy gamepack.json
        for (const [i, pack] of gamePacks.entries()) {
            await loadGamePack(pack);
            DOM.appProgressBar.style.width = `${Math.round(((i + 1) / gamePacks.length) * 100)}%`;
        }
    }
}

async function loadFromManifest(manifest) {
    const categories = ['blocks', 'items', 'biomes', 'entities', 'recipes', 'terrain'];
    const total = categories.reduce((s, c) => s + (manifest[c]?.length ?? 0), 0) || 1;
    let loaded = 0;

    for (const cat of categories) {
        for (const filePath of (manifest[cat] ?? [])) {
            try {
                const res = await fetch(filePath);
                if (!res.ok) continue;
                const def = await res.json();
                _mergeDefinition(cat, def);
            } catch { /* skip bad file */ }
            loaded++;
            DOM.appProgressBar.style.width = `${Math.round((loaded / total) * 100)}%`;
        }
    }

    // Also load textures and loading texts from legacy gamepack.json if present
    try {
        const res = await fetch('data/gamepack.json');
        if (res.ok) {
            const gp = await res.json();
            loadTextures('-**DEFAULT**-', gp);
            loadLoadingTexts('Vanilla', gp);
            loadTitleBackground(gp);
        }
    } catch { /* fine */ }

    packsLoaded = 1;
}

function _mergeDefinition(category, def) {
    if (category === 'blocks') {
        if (!mergedGamePackData.blocks.find(b => b.id === def.id)) mergedGamePackData.blocks.push(def);
    } else if (category === 'items') {
        if (!mergedGamePackData.items.find(i => i.id === def.id)) mergedGamePackData.items.push(def);
    } else if (category === 'biomes') {
        if (!mergedGamePackData.biomes.find(b => b.name === def.name)) mergedGamePackData.biomes.push(def);
    } else if (category === 'entities') {
        if (!mergedGamePackData.entities.find(e => e.id === def.id)) mergedGamePackData.entities.push(def);
    } else if (category === 'recipes') {
        if (!mergedGamePackData.recipes.find(r => r.id === def.id)) mergedGamePackData.recipes.push(def);
    } else if (category === 'terrain') {
        // World-generation settings (TerrainGenerator); the first of a name wins.
        if (!mergedGamePackData.terrain.find(t => t.name === def.name)) mergedGamePackData.terrain.push(def);
    }
}

// Legacy full-gamepack loader (fallback)
async function loadGamePack(packName) {
    try {
        const path = packName === "-**DEFAULT**-" ? "data/gamepack.json" : `gamepacks/${packName}/gamepack.json`;
        const res  = await fetch(path);
        if (!res.ok) throw new Error(`Failed to load ${packName}`);
        const data = await res.json();
        loadTextures(packName, data);
        loadLoadingTexts(packName === "-**DEFAULT**-" ? 'Vanilla' : packName, data);
        loadTitleBackground(data);
        mergeGamePackWorldData(data);
        packsLoaded++;
    } catch (err) {
        console.error(`GamePack "${packName}" failed to load`, err);
    }
}

function loadTextures(packName, data) {
    if (!data.textures) return;
    for (const [name, p] of Object.entries(data.textures)) {
        if (textures[name]) continue;
        textures[name] = packName === "-**DEFAULT**-" ? `data/${p}` : `gamepacks/${packName}/${p}`;
    }
}

function loadLoadingTexts(displayName, data) {
    if (!Array.isArray(data.loadingText)) return;
    for (const text of data.loadingText) loadingTexts.push({ text, packName: displayName });
}

function mergeGamePackWorldData(data) {
    for (const block  of (data.blocks   ?? [])) _mergeDefinition('blocks',   block);
    for (const biome  of (data.biomes   ?? [])) _mergeDefinition('biomes',   biome);
    for (const item   of (data.items    ?? [])) _mergeDefinition('items',    item);
    for (const entity of (data.entities ?? [])) _mergeDefinition('entities', entity);
    for (const recipe of (data.recipes  ?? [])) _mergeDefinition('recipes',  recipe);
}

function loadTitleBackground(data) {
    if (titleBG !== null || !data.titleScreenBG) return;
    titleBG = data.titleScreenBG;
    document.body.style.background =
        `linear-gradient(${titleBG.angle}deg, ${titleBG.colors.join(", ")})`;
}

/* =========================================================
   GAME CONTROL
========================================================= */

function resumeGame() {
    // Don't clear `paused` here — let pointerlockchange do it once the lock is
    // actually re-acquired. requestGameLock retries through the post-Esc cooldown,
    // and the pause screen stays up until the lock truly sticks (no limbo state).
    requestGameLock();
    // With a controller there is no lock to wait for (a page can only take
    // the pointer in answer to a click or a key), and play does not need one.
    if (window.__wwPad?.active) paused = false;
}

async function leaveWorld(over = false) {
    const wasIn = gameStarted;
    gameStarted = false;
    paused = false;
    activeWorld = null;
    _loadingActive = false;            // cancel any in-progress load reveal
    clearTimeout(_loadFallbackTimer);
    stopLoadingTextRotation();
    if (document.pointerLockElement) document.exitPointerLock();
    callWorldJS("quitWorld");
    // Out of an online game somebody else hosted: this player is their own again.
    _onlineGuest = false;
    document.body.classList.toggle('isGuest', isGuest());
    DOM.gameScreen.classList.add("hidden");
    DOM.pauseScreen.classList.add("hidden");
    DOM.deathScreen?.classList.add("hidden");
    DOM.interactivePanel?.classList.add("hidden");
    DOM.inventoryScreen?.classList.add("hidden");
    DOM.creativeInvPanel?.classList.add("hidden");
    _menuOpen = false;
    DOM.loadingContainer.classList.add("hidden");
    DOM.titleLogo.classList.remove("hidden");
    DOM.logo.classList.remove("Loading");
    DOM.loadingBar.style.width = "0%";
    document.getElementById('PlayersScreen')?.classList.add('hidden');
    document.getElementById('CharacterScreen')?.classList.add('hidden');
    window.__wwCharacter?.hide();
    if (isGuest()) {
        // Someone else's world: there is no menu of this player's to go back to.
        DOM.titleLogo.classList.add("hidden");
        if (!over && wasIn) sessionOver('left');
        return;
    }
    splitManager()?.closeAll();              // the other players on this screen were in this world
    window.__wwSound?.playMusic(MENU_MUSIC);
    showWorldList();
    startMenuWorld('worlds');
}

/* =========================================================
   MAIN LOOP
========================================================= */

let _lastFrameTime = 0;
let _nextFrameAt = 0;      // when the next frame is due under a frame-rate cap (0 = now)
let _fpsEnabled = false;
let _fpsAccum = 0, _fpsFrames = 0, _fpsTimer = 0;
let _loadingActive = false;
let _loadFallbackTimer = null;
let _loopActive = false;   // prevents two animation loops running after a world switch

// Frame-rate limits while nobody is playing. The world behind the pause
// screen, a menu or the death screen is dimmed and nearly still, and a window
// in the background is not being looked at — but without these the GPU draws
// it as often, and runs as hot, as in play. Never while the loading screen is
// up: new terrain is installed a frame at a time.
const MENU_FPS       = 30;   // pause screen (and settings from it), inventory, crafting, death
const BACKGROUND_FPS = 15;   // the game window does not have focus, or is hidden
// "Has focus" is the whole window's: of a split screen's frames only one has
// the keyboard, and the others are being played all the same.
function appFocused() {
    try { return window.top.document.hasFocus(); } catch { return document.hasFocus(); }
}

/** The frame-rate cap right now (0 = none): the player's, or lower while idle. */
function frameCap() {
    // __wwNoIdleCap: the render benchmark measures play, where headless has no
    // pointer lock and so sits on the pause screen.
    if (_loadingActive || window.__wwNoIdleCap) return _maxFps;
    const idle = (document.hidden || !appFocused()) ? BACKGROUND_FPS
               : (paused || _menuOpen) ? MENU_FPS : 0;
    return idle && (_maxFps === 0 || idle < _maxFps) ? idle : _maxFps;
}

function startLoop() {
    if (_loopActive) return;
    _loopActive = true;
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    if (!gameStarted) { _loopActive = false; return; }
    // Frame-rate cap: skip display refreshes until the next frame is due. Each
    // frame is due one interval after the last one was due, not after it ran,
    // so a cap that does not divide the display's refresh rate (60 on 144 Hz)
    // still averages out to the cap rather than to the next lower divisor (48).
    // The 2 ms of slack stops a 60 cap on a 60 Hz display from dropping every
    // other frame. dt below is measured from the last frame actually run.
    const cap = frameCap();
    if (cap > 0 && _nextFrameAt && timestamp && timestamp < _nextFrameAt - 2) {
        requestAnimationFrame(gameLoop);
        return;
    }
    if (cap > 0 && timestamp) {
        const interval = 1000 / cap;
        // Behind by a whole frame (a stall, or the cap just changed): restart
        // the schedule from now instead of rushing frames to catch up.
        _nextFrameAt = _nextFrameAt && timestamp - _nextFrameAt < interval
            ? _nextFrameAt + interval : timestamp + interval;
    } else {
        _nextFrameAt = 0;
    }
    // `timestamp` is undefined on the first (manual) call and when _lastFrameTime
    // was reset; in both cases fall back to a nominal frame so dt is never NaN.
    const dt = (_lastFrameTime && timestamp)
        ? Math.min((timestamp - _lastFrameTime) / 1000, 0.1)
        : 0.016;
    _lastFrameTime = timestamp ?? 0;

    if (_fpsEnabled) _updateFps(dt);

    // Pause/resume is handled by the pointerlockchange + Escape listeners — the
    // loop only reads the state. Hotbar number keys only while actively playing.
    if (!paused && !_menuOpen) handleHotbarKeys();

    updateUIVisibility();
    worldTick(dt);
    requestAnimationFrame(gameLoop);
}

function _updateFps(dt) {
    _fpsAccum += dt; _fpsFrames++; _fpsTimer += dt;
    if (_fpsTimer >= 0.5) {
        const fps = Math.round(_fpsFrames / _fpsAccum);
        const el = document.getElementById('fpsCounter');
        if (el) el.textContent = `FPS: ${fps}`;
        _fpsAccum = 0; _fpsFrames = 0; _fpsTimer = 0;
    }
}

function handleHotbarKeys() {
    for (let i = 0; i < 10; i++) {
        if (KEYS[`Digit${i === 9 ? 0 : i + 1}`]) {
            updateHotbarSelection(i);
        }
    }
}

function updateUIVisibility() {
    const isSpectator = activeWorld?.gameMode === 'SPECTATOR';
    DOM.pauseScreen.classList.toggle("hidden", !paused || _menuOpen);
    DOM.gameUI.classList.toggle("hidden", (paused && !_menuOpen) || isSpectator);
}

// A button says so when it is pressed (the mouse, or a controller's A).
document.addEventListener('click', (e) => {
    if (e.target.closest?.('.menuButton, .segBtn, .settingsTab, .worldCard, .recipeListItem, .settingsToggle, .invGridSlot')) {
        window.__wwSound?.play('click', { volume: 0.5, vary: 0.03 });
    }
}, true);

/* =========================================================
   CONFIRM DIALOG
========================================================= */

function openConfirm(title, message, task) {
    DOM.confirmMessage.textContent = message;
    DOM.confirmTitle.textContent = title;
    DOM.confirmYes.onclick = () => { task(); DOM.confirmPopup.classList.add("hidden"); };
    DOM.confirmPopup.classList.remove("hidden");
}

function closeGame() {
    openConfirm("Quit Game", "Would you like to close Wonder World?", () => {
        safeToClose = true;
        if (window.parent) window.parent.postMessage("closeGame", "*");
        window.close();
    });
}

/* =========================================================
   WORLD / ENGINE BRIDGE
========================================================= */

// `paused`: the pause menu is up, so the clock and the weather stand still.
function worldTick(dt) { callWorldJS("tick", { dt, paused }); }

function callWorldJS(eventName, data = {}) {
    const event = new Event("WorldJS_" + eventName);
    event.data = data;
    document.dispatchEvent(event);
}

/* =========================================================
   UTILITIES
========================================================= */

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h & 0x7FFFFFFF;
}
