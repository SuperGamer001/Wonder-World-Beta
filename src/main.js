/* =========================================================
   CONFIGURATION
========================================================= */

const gamePacks = ["-**DEFAULT**-"];
const SERVER_URL = 'http://localhost:3000';

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
};

let titleBG = null;
let packsLoaded = 0;
let safeToClose = true;

const mergedGamePackData = { blocks: [], biomes: [], items: [], entities: [], recipes: [] };

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
    bindEvents();

    await loadAllGamePacks();
    _buildBlockColorIcons();
    applyLoadedAssets();
    applyPlayerSettings(getSettings());   // apply accessibility/HUD prefs from the start

    DOM.appLoadingContainer.classList.add("hidden");
    DOM.titleScreen.classList.remove("hidden");
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
    DOM.worldSettingsSaveBtn   = document.querySelector("#worldSettingsSaveBtn");
    DOM.worldSettingsCancelBtn = document.querySelector("#worldSettingsCancelBtn");

    DOM.createWorldConfirmBtn = document.querySelector("#createWorldConfirmBtn");
    DOM.createWorldCancelBtn  = document.querySelector("#createWorldCancelBtn");
    DOM.newWorldName      = document.querySelector("#newWorldName");
    DOM.newWorldSeed      = document.querySelector("#newWorldSeed");
    DOM.newWorldGameMode  = document.querySelector("#newWorldGameMode");

    DOM.titleSettingsBtn  = document.querySelector("#titleSettingsBtn");
    DOM.pauseSettingsBtn  = document.querySelector("#pauseSettingsBtn");
    DOM.settingsBackBtn   = document.querySelector("#settingsBackBtn");
    DOM.settingGameMode   = document.querySelector("#settingGameMode");
    DOM.settingGameModeApply = document.querySelector("#settingGameModeApply");

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
    DOM.startButton.addEventListener("click", showWorldList);
    DOM.createWorldBtn.addEventListener("click", showCreateWorldModal);

    // Click the game to re-acquire the pointer if we're playing but somehow
    // unlocked (e.g. a re-lock was momentarily blocked after closing a menu).
    DOM.gameScreen?.addEventListener('mousedown', () => {
        if (gameStarted && !_menuOpen && !paused &&
            document.pointerLockElement !== DOM.gameScreen) {
            DOM.gameScreen.requestPointerLock();
        }
    });
    DOM.worldListBackBtn.addEventListener("click", () => {
        DOM.worldListScreen.classList.add("hidden");
        DOM.titleScreen.classList.remove("hidden");
        DOM.titleLogo?.classList.remove("hidden");
    });

    DOM.worldDetailCloseBtn.addEventListener("click", () => DOM.worldDetailModal.classList.add("hidden"));
    DOM.worldPlayBtn.addEventListener("click", () => {
        if (activeWorld) { DOM.worldDetailModal.classList.add("hidden"); startWorld(activeWorld); }
    });
    DOM.worldSettingsBtn.addEventListener("click", openWorldSettingsModal);
    DOM.worldSettingsSaveBtn.addEventListener("click", saveWorldSettings);
    DOM.worldSettingsCancelBtn.addEventListener("click", () => DOM.worldSettingsModal.classList.add("hidden"));

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
    DOM.createWorldCancelBtn.addEventListener("click", () => DOM.createWorldModal.classList.add("hidden"));

    DOM.titleSettingsBtn.addEventListener("click", () => openSettings('title'));
    DOM.pauseSettingsBtn?.addEventListener("click", () => openSettings('pause'));
    DOM.settingsBackBtn.addEventListener("click", closeSettings);

    document.getElementById('titleHowToBtn')?.addEventListener('click', () => openHowToPlay('title'));
    document.getElementById('pauseHowToBtn')?.addEventListener('click', () => openHowToPlay('pause'));
    document.getElementById('howToBackBtn')?.addEventListener('click', closeHowToPlay);

    DOM.settingGameModeApply?.addEventListener("click", applyInGameModeChange);

    DOM.respawnBtn?.addEventListener("click", () => {
        DOM.deathScreen.classList.add("hidden");
        callWorldJS("respawn");
    });

    DOM.interactivePanelClose?.addEventListener("click", closeInteractivePanel);

    // Settings — every control commits + applies live.
    const settingIds = [
        'settingSensitivity', 'settingInvertY', 'settingFov', 'settingRenderDist',
        'settingBrightness', 'settingShowCoords', 'settingCrosshair', 'settingShowFps',
        'settingColorblind', 'settingHighContrast', 'settingReduceMotion', 'settingLargeText',
    ];
    for (const id of settingIds) {
        document.getElementById(id)?.addEventListener('input', commitSettingsFromForm);
        document.getElementById(id)?.addEventListener('change', commitSettingsFromForm);
    }
    document.getElementById('settingsResetBtn')?.addEventListener('click', resetSettings);

    // World events from world.js
    window.addEventListener('ww_playerDied', () => {
        DOM.deathScreen?.classList.remove("hidden");
        if (document.pointerLockElement) document.exitPointerLock();
    });

    window.addEventListener('ww_respawned', () => {
        DOM.deathScreen?.classList.add("hidden");
        DOM.gameScreen?.requestPointerLock();
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
let _lockRetryTimer = null;
function requestGameLock() {
    clearTimeout(_lockRetryTimer);
    let attempts = 0;
    const tryLock = () => {
        if (!gameStarted || _menuOpen) return;                           // no longer wanted
        if (document.pointerLockElement === DOM.gameScreen) return;      // already locked
        DOM.gameScreen?.requestPointerLock();
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

const DEFAULT_SETTINGS = {
    sensitivity: 1.0,
    invertY: false,
    fov: 75,
    renderDistance: 12,
    brightness: 1.0,
    showCoords: true,
    crosshair: true,
    showFps: false,
    colorblind: 'none',
    highContrast: false,
    reduceMotion: false,
    largeText: false,
};

function getSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ww_settings') ?? '{}'); } catch { /* corrupt */ }
    return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(s) {
    localStorage.setItem('ww_settings', JSON.stringify(s));
}

// Apply settings to the page (accessibility/HUD) and forward the gameplay-facing
// ones (sensitivity, FOV, render distance) to the engine.
function applyPlayerSettings(s) {
    const cb = {
        none:        'none',
        protanopia:  'saturate(1.25) hue-rotate(-18deg)',
        deuteranopia:'saturate(1.25) hue-rotate(18deg)',
        tritanopia:  'saturate(1.3) hue-rotate(40deg)',
    }[s.colorblind] ?? 'none';
    const filter = `brightness(${s.brightness})` + (cb !== 'none' ? ` ${cb}` : '');
    document.body.style.filter = filter === 'brightness(1)' ? '' : filter;

    document.body.classList.toggle('a11y-contrast',  !!s.highContrast);
    document.body.classList.toggle('a11y-reduce',    !!s.reduceMotion);
    document.body.classList.toggle('a11y-large-text',!!s.largeText);

    document.getElementById('playerCoords')?.classList.toggle('forceHidden', !s.showCoords);
    document.getElementById('crosshair')?.classList.toggle('forceHidden', !s.crosshair);
    const fpsEl = document.getElementById('fpsCounter');
    if (fpsEl) fpsEl.classList.toggle('hidden', !s.showFps);
    _fpsEnabled = !!s.showFps;

    callWorldJS('applySettings', {
        sensitivity:    s.sensitivity,
        invertY:        s.invertY,
        fov:            s.fov,
        renderDistance: s.renderDistance,
    });
}

function openSettings(origin) {
    _settingsOrigin = origin;

    const tabWorld = document.getElementById('tabWorld');
    const inGame   = origin === 'pause';

    // World tab only makes sense while in a game.
    if (tabWorld) tabWorld.style.display = inGame ? '' : 'none';
    switchSettingsTab('player');
    if (inGame && activeWorld) {
        if (DOM.settingGameMode)  DOM.settingGameMode.value  = activeWorld.gameMode  ?? 'SURVIVAL';
        const diffEl = document.getElementById('settingDifficulty');
        if (diffEl) diffEl.value = activeWorld.difficulty ?? 'NORMAL';
    }

    populateSettingsForm();

    if (origin === 'title') DOM.titleScreen.classList.add("hidden");
    else                    DOM.pauseScreen.classList.add("hidden");
    DOM.settingsScreen.classList.remove("hidden");
}

function closeSettings() {
    DOM.settingsScreen.classList.add("hidden");
    if (_settingsOrigin === 'pause') DOM.pauseScreen.classList.remove("hidden");
    else                             DOM.titleScreen.classList.remove("hidden");
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
    set('settingFov', s.fov);                 set('settingRenderDist', s.renderDistance);
    set('settingBrightness', s.brightness);
    chk('settingShowCoords', s.showCoords);   chk('settingCrosshair', s.crosshair);
    chk('settingShowFps', s.showFps);
    set('settingColorblind', s.colorblind);
    chk('settingHighContrast', s.highContrast);
    chk('settingReduceMotion', s.reduceMotion);
    chk('settingLargeText', s.largeText);
    _updateSettingLabels();
}

function _updateSettingLabels() {
    const v = id => document.getElementById(id)?.value;
    const t = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    t('settingSensitivityVal', parseFloat(v('settingSensitivity')).toFixed(1));
    t('settingFovVal', v('settingFov'));
    t('settingRenderDistVal', v('settingRenderDist'));
    t('settingBrightnessVal', `${Math.round(parseFloat(v('settingBrightness')) * 100)}%`);
}

// Read the form, persist, and apply live (called on every input change).
function commitSettingsFromForm() {
    const num = id => parseFloat(document.getElementById(id)?.value);
    const on  = id => !!document.getElementById(id)?.checked;
    const s = {
        sensitivity:    num('settingSensitivity'),
        invertY:        on('settingInvertY'),
        fov:            num('settingFov'),
        renderDistance: Math.round(num('settingRenderDist')),
        brightness:     num('settingBrightness'),
        showCoords:     on('settingShowCoords'),
        crosshair:      on('settingCrosshair'),
        showFps:        on('settingShowFps'),
        colorblind:     document.getElementById('settingColorblind')?.value ?? 'none',
        highContrast:   on('settingHighContrast'),
        reduceMotion:   on('settingReduceMotion'),
        largeText:      on('settingLargeText'),
    };
    saveSettings(s);
    _updateSettingLabels();
    applyPlayerSettings(s);
}

function resetSettings() {
    saveSettings({ ...DEFAULT_SETTINGS });
    populateSettingsForm();
    applyPlayerSettings(getSettings());
}

async function applyInGameModeChange() {
    if (!activeWorld) return;
    const mode = DOM.settingGameMode?.value ?? 'SURVIVAL';
    const difficulty = document.getElementById('settingDifficulty')?.value ?? 'NORMAL';
    activeWorld.gameMode   = mode;
    activeWorld.difficulty = difficulty;
    try {
        await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameMode: mode, difficulty }),
        });
    } catch { /* offline */ }
    callWorldJS("setGameMode", { gameMode: mode });
}

// Global settings tab switch
window.switchSettingsTab = function(tab) {
    document.getElementById('settingsPanelPlayer')?.classList.toggle('hidden', tab !== 'player');
    document.getElementById('settingsPanelWorld')?.classList.toggle('hidden', tab !== 'world');
    document.getElementById('tabPlayer')?.classList.toggle('active', tab === 'player');
    document.getElementById('tabWorld')?.classList.toggle('active', tab === 'world');
};

/* =========================================================
   WORLD SETTINGS MODAL
========================================================= */

function openWorldSettingsModal() {
    if (!activeWorld) return;
    DOM.worldSettingsGameMode.value = activeWorld.gameMode ?? 'SURVIVAL';
    const diffEl = document.getElementById('worldSettingsDifficulty');
    if (diffEl) diffEl.value = activeWorld.difficulty ?? 'NORMAL';
    DOM.worldDetailModal.classList.add("hidden");
    DOM.worldSettingsModal.classList.remove("hidden");
}

async function saveWorldSettings() {
    if (!activeWorld) return;
    const mode = DOM.worldSettingsGameMode.value;
    const difficulty = document.getElementById('worldSettingsDifficulty')?.value ?? 'NORMAL';
    activeWorld.gameMode   = mode;
    activeWorld.difficulty = difficulty;
    try {
        await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameMode: mode, difficulty }),
        });
    } catch { /* offline */ }
    DOM.worldSettingsModal.classList.add("hidden");
    DOM.worldDetailModal.classList.remove("hidden");
}

/* =========================================================
   WORLD LIST
========================================================= */

async function showWorldList() {
    DOM.titleScreen.classList.add("hidden");
    DOM.titleLogo?.classList.add("hidden");   // hide the big logo behind the world list
    DOM.worldListScreen.classList.remove("hidden");
    DOM.worldListContainer.innerHTML = '<div style="color:#aaa;font-size:1.2vw;text-align:center;padding:2vw;">Loading worlds...</div>';

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
            '<div style="color:#aaa;font-size:1.2vw;text-align:center;padding:3vw;">No saved worlds. Click <strong>+ Create World</strong> to get started.</div>';
        return;
    }
    DOM.worldListContainer.innerHTML = '';
    for (const world of worlds) {
        const card = document.createElement('div');
        card.className = 'worldCard';
        const lastPlayed = world.lastPlayed ? new Date(world.lastPlayed).toLocaleDateString() : 'Never';
        const mode = world.gameMode ? ` &nbsp;|&nbsp; ${world.gameMode.charAt(0) + world.gameMode.slice(1).toLowerCase()}` : '';
        // Cache-busted thumbnail; hidden if the world has no screenshot yet.
        const thumb = `${SERVER_URL}/user/worlds/${world.id}/screenshot.jpg?t=${world.lastPlayed ?? 0}`;
        card.innerHTML = `
            <div class="worldCardLeft">
                <img class="worldCardThumb" src="${thumb}" alt="" onerror="this.classList.add('noThumb')">
                <div class="worldCardInfo">
                    <div class="worldCardName">${escapeHtml(world.name)}</div>
                    <div class="worldCardMeta">Seed: ${world.seed}${mode} &nbsp;|&nbsp; Last played: ${lastPlayed}</div>
                </div>
            </div>
            <div class="worldCardPlay">▶ Play</div>
        `;
        card.addEventListener('click', () => showWorldDetail(world));
        DOM.worldListContainer.appendChild(card);
    }
}

function showWorldDetail(world) {
    activeWorld = world;
    DOM.worldDetailName.textContent = world.name;
    DOM.worldDetailInfo.textContent = `Seed: ${world.seed}  |  Mode: ${world.gameMode ?? 'SURVIVAL'}`;
    DOM.worldDetailModal.classList.remove("hidden");
}

/* =========================================================
   CREATE WORLD
========================================================= */

function showCreateWorldModal() {
    DOM.newWorldName.value = '';
    DOM.newWorldSeed.value = '';
    DOM.newWorldGameMode.value = 'SURVIVAL';
    DOM.createWorldModal.classList.remove("hidden");
}

async function createWorld() {
    const name       = DOM.newWorldName.value.trim() || 'New World';
    const seedRaw    = DOM.newWorldSeed.value.trim();
    const seed       = seedRaw !== '' ? (parseInt(seedRaw, 10) || hashString(seedRaw)) : undefined;
    const gameMode   = DOM.newWorldGameMode.value || 'SURVIVAL';
    const difficulty = document.getElementById('newWorldDifficulty')?.value || 'NORMAL';

    try {
        const res = await fetch(`${SERVER_URL}/api/worlds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, seed, gameMode, difficulty }),
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
    activeWorld = world;
    gameStarted = true;
    paused      = false;
    _menuOpen   = false;
    // Reset the frame clock so the first gameLoop() of this world starts fresh.
    // Otherwise the leftover timestamp from a previous world makes the first dt
    // compute as NaN (undefined - oldTimestamp), which corrupts player physics
    // into NaN positions and stalls chunk generation until a page refresh.
    _lastFrameTime = 0;

    DOM.worldListScreen.classList.add("hidden");
    DOM.titleScreen.classList.add("hidden");

    DOM.packName.style.display = packsLoaded === 1 ? "none" : "block";
    DOM.loadingBar.style.width = "0%";
    DOM.loadingText.textContent = "Loading World...";
    DOM.packName.textContent = `${packsLoaded} Gamepacks Successfully Loaded`;
    DOM.logo.classList.add("Loading");
    DOM.loadingContainer.classList.remove("hidden");

    callWorldJS("startWorldLoad", {
        gamepackData: mergedGamePackData,
        worldId:   world.id,
        worldSeed: world.seed,
        playerPos: world.playerPos ?? { x: 0, y: 100, z: 0 },
        gameMode:  world.gameMode  ?? 'SURVIVAL',
    });

    startLoadingTextRotation();

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
    DOM.logo.style.width = "40%";
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
    if (_blockColorIcons[itemId]) return _blockColorIcons[itemId];
    return ITEM_TEXTURES[itemId] ?? `data/textures/items/${itemId}.png`;
}
window._itemTextureSrc = itemTextureSrc;

// Colored blocks (ids ≥ 25) have no PNG — generate a swatch icon from their colour
// so they show up in the hotbar / inventory / creative grid.
const _blockColorIcons = {};
function _buildBlockColorIcons() {
    for (const def of (mergedGamePackData.blocks ?? [])) {
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
    const isCreative = mode === 'CREATIVE';
    DOM.invCraftBtn.textContent = isCreative ? 'Creative Inventory' : 'Open Craft';
    DOM.invCraftBtn.style.width = isCreative ? '14vw' : '11vw';
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

    const blockEntries = blocks
        .filter(b => b.id !== 0 && !covered.has(b.id))
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
        lbl.className = 'invGridKeybind';
        lbl.textContent = (itemDef.name ?? itemDef.id).replace(/_/g, ' ').slice(0, 8);
        lbl.style.cssText = 'font-size:0.55vw;bottom:0;top:auto;left:0;right:0;text-align:center;overflow:hidden;white-space:nowrap;';
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
        label.style.cssText = 'margin-bottom:0.3vw;';
        label.textContent = 'Hotbar';
        DOM.invHotbarRow.appendChild(label);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:0.3vw;flex-wrap:wrap;';
        for (let i = 0; i < 10; i++) {
            const slot = inv.hotbar?.[i] ?? null;
            const el   = _makeSlotEl({ type: 'hotbar', index: i }, slot, `${i === 9 ? 0 : i + 1}`);
            row.appendChild(el);
        }
        DOM.invHotbarRow.appendChild(row);

        // Offhand slot
        const offRow = document.createElement('div');
        offRow.style.cssText = 'display:flex;align-items:center;gap:0.4vw;margin-top:0.3vw;';
        const offLabel = document.createElement('span');
        offLabel.style.cssText = 'color:#888;font-size:0.85vw;';
        offLabel.textContent = 'Offhand:';
        offRow.appendChild(offLabel);
        offRow.appendChild(_makeSlotEl({ type: 'offhand', index: 0 }, inv.offhand ?? null, ''));
        DOM.invHotbarRow.appendChild(offRow);
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
        _cursorEl.innerHTML = `<img src="${itemTextureSrc(_invCursor.itemId)}" alt="" style="width:2.5vw;height:2.5vw;image-rendering:pixelated;"><span style="font-size:0.8vw;color:#fff;position:absolute;bottom:0;right:0;">${_invCursor.count > 1 ? _invCursor.count : ''}</span>`;
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
    DOM.craftBtn.style.opacity = '0.4';
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
        icon.style.cssText = 'width:1.6vw;height:1.6vw;image-rendering:pixelated;vertical-align:middle;margin-right:0.4vw;';
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
        `<img src="${itemTextureSrc(recipe.result.itemId)}" style="width:2vw;height:2vw;image-rendering:pixelated;vertical-align:middle;margin-right:0.4vw;">${resultName}` +
        (recipe.result.count > 1 ? ` <span style="color:#aaa;font-size:1.1vw;">×${recipe.result.count}</span>` : '');

    // Ingredient list with icons
    const inv = window.me.inventory;
    DOM.recipeDetail.innerHTML = recipe.ingredients.map(i => {
        const have = inv ? (inv.countItem?.(i.itemId) ?? 0) : 0;
        const ok   = have >= i.count;
        const col  = ok ? '#88cc88' : '#cc6666';
        return `<div style="display:flex;align-items:center;gap:0.4vw;margin-bottom:0.25vw;">` +
               `<img src="${itemTextureSrc(i.itemId)}" style="width:1.6vw;height:1.6vw;image-rendering:pixelated;">` +
               `<span style="color:${col};">${i.count}× ${i.itemId.replace(/_/g, ' ')} <span style="color:#777;font-size:0.85vw;">(${have})</span></span>` +
               `</div>`;
    }).join('');

    DOM.craftBtn.style.opacity = canCraft ? '1' : '0.4';
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
    const categories = ['blocks', 'items', 'biomes', 'entities', 'recipes'];
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
}

async function leaveWorld() {
    gameStarted = false;
    paused = false;
    activeWorld = null;
    _loadingActive = false;            // cancel any in-progress load reveal
    clearTimeout(_loadFallbackTimer);
    stopLoadingTextRotation();
    if (document.pointerLockElement) document.exitPointerLock();
    callWorldJS("quitWorld");
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
    showWorldList();
}

/* =========================================================
   MAIN LOOP
========================================================= */

let _lastFrameTime = 0;
let _fpsEnabled = false;
let _fpsAccum = 0, _fpsFrames = 0, _fpsTimer = 0;
let _loadingActive = false;
let _loadFallbackTimer = null;
let _loopActive = false;   // prevents two animation loops running after a world switch

function startLoop() {
    if (_loopActive) return;
    _loopActive = true;
    requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
    if (!gameStarted) { _loopActive = false; return; }
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

function worldTick(dt) { callWorldJS("tick", { dt }); }

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
