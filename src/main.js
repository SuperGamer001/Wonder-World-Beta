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
    applyLoadedAssets();

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
    DOM.invSlots          = document.querySelector("#invSlots");
    DOM.invHotbarRow      = document.querySelector("#invHotbarRow");
    DOM.invEquip          = document.querySelector("#invEquip");
    DOM.invWeightLabel    = document.querySelector("#invWeightLabel");
}

function bindEvents() {
    DOM.startButton.addEventListener("click", showWorldList);
    DOM.createWorldBtn.addEventListener("click", showCreateWorldModal);
    DOM.worldListBackBtn.addEventListener("click", () => {
        DOM.worldListScreen.classList.add("hidden");
        DOM.titleScreen.classList.remove("hidden");
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

    DOM.settingGameModeApply?.addEventListener("click", applyInGameModeChange);

    DOM.respawnBtn?.addEventListener("click", () => {
        DOM.deathScreen.classList.add("hidden");
        callWorldJS("respawn");
    });

    DOM.interactivePanelClose?.addEventListener("click", closeInteractivePanel);

    // Settings sliders — live preview
    document.getElementById('settingSensitivity')?.addEventListener('input', e => {
        document.getElementById('settingSensitivityVal').textContent = parseFloat(e.target.value).toFixed(1);
    });
    document.getElementById('settingRenderDist')?.addEventListener('input', e => {
        document.getElementById('settingRenderDistVal').textContent = e.target.value;
    });

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

    window.addEventListener('ww_itemPickup', () => { refreshHotbarUI(); });

    window.addEventListener('ww_toggleInventory', () => {
        if (DOM.inventoryScreen?.classList.contains('hidden')) openInventory();
        else closeInventory();
    });

    DOM.invCloseBtn?.addEventListener('click', closeInventory);

    window.addEventListener('ww_openInteractive', (e) => {
        openInteractivePanel(e.detail);
    });
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

window.addEventListener("blur", () => { paused = true; });
window.addEventListener("keydown", (e) => { KEYS[e.code] = true; });
window.addEventListener("keyup",   (e) => { KEYS[e.code] = false; });

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

function openSettings(origin) {
    _settingsOrigin = origin;

    const worldPanel  = document.getElementById('settingsPanelWorld');
    const tabWorld    = document.getElementById('tabWorld');
    const inGame      = origin === 'pause';

    // World settings tab only makes sense while in a game
    if (tabWorld) tabWorld.style.display = inGame ? '' : 'none';
    if (worldPanel) {
        if (!inGame) {
            worldPanel.classList.add('hidden');
            document.getElementById('settingsPanelPlayer')?.classList.remove('hidden');
            document.getElementById('tabPlayer')?.classList.add('active');
            tabWorld?.classList.remove('active');
        } else if (activeWorld) {
            DOM.settingGameMode.value = activeWorld.gameMode ?? 'SURVIVAL';
        }
    }

    loadPlayerSettings();

    if (origin === 'title') {
        DOM.titleScreen.classList.add("hidden");
    } else {
        DOM.pauseScreen.classList.add("hidden");
    }
    DOM.settingsScreen.classList.remove("hidden");
}

function closeSettings() {
    DOM.settingsScreen.classList.add("hidden");
    savePlayerSettings();
    if (_settingsOrigin === 'pause') {
        DOM.pauseScreen.classList.remove("hidden");
    } else {
        DOM.titleScreen.classList.remove("hidden");
    }
}

function loadPlayerSettings() {
    const sens   = parseFloat(localStorage.getItem('ww_sensitivity') ?? '1.0');
    const rDist  = parseInt(localStorage.getItem('ww_renderDist') ?? '12');
    const sensEl = document.getElementById('settingSensitivity');
    const distEl = document.getElementById('settingRenderDist');
    if (sensEl) { sensEl.value = sens; document.getElementById('settingSensitivityVal').textContent = sens.toFixed(1); }
    if (distEl) { distEl.value = rDist; document.getElementById('settingRenderDistVal').textContent = rDist; }
}

function savePlayerSettings() {
    const sens  = parseFloat(document.getElementById('settingSensitivity')?.value ?? '1');
    const rDist = parseInt(document.getElementById('settingRenderDist')?.value ?? '12');
    localStorage.setItem('ww_sensitivity', sens);
    localStorage.setItem('ww_renderDist', rDist);
}

async function applyInGameModeChange() {
    const mode = DOM.settingGameMode?.value ?? 'SURVIVAL';
    if (!activeWorld) return;
    activeWorld.gameMode = mode;
    try {
        await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameMode: mode }),
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
    DOM.worldDetailModal.classList.add("hidden");
    DOM.worldSettingsModal.classList.remove("hidden");
}

async function saveWorldSettings() {
    if (!activeWorld) return;
    const mode = DOM.worldSettingsGameMode.value;
    activeWorld.gameMode = mode;
    try {
        await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameMode: mode }),
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
        card.innerHTML = `
            <div class="worldCardInfo">
                <div class="worldCardName">${escapeHtml(world.name)}</div>
                <div class="worldCardMeta">Seed: ${world.seed}${mode} &nbsp;|&nbsp; Last played: ${lastPlayed}</div>
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
    const name     = DOM.newWorldName.value.trim() || 'New World';
    const seedRaw  = DOM.newWorldSeed.value.trim();
    const seed     = seedRaw !== '' ? (parseInt(seedRaw, 10) || hashString(seedRaw)) : undefined;
    const gameMode = DOM.newWorldGameMode.value || 'SURVIVAL';

    try {
        const res = await fetch(`${SERVER_URL}/api/worlds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, seed, gameMode }),
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
    setTimeout(() => finishGameStartup(), 2000);
}

function finishGameStartup() {
    stopLoadingTextRotation();
    DOM.loadingContainer.classList.add("hidden");
    DOM.gameScreen.classList.remove("hidden");
    DOM.titleLogo.classList.add("hidden");
    setTimeout(() => DOM.gameScreen.requestPointerLock(), 10);
    initializeHotbar();
    gameLoop();
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
    coal:         'data/textures/blocks/Coal_Ore.png',
    raw_iron:     'data/textures/blocks/Iron_Ore.png',
    raw_gold:     'data/textures/blocks/Gold_Ore.png',
};

function itemTextureSrc(itemId) {
    if (!itemId) return '';
    return ITEM_TEXTURES[itemId] ?? `data/textures/items/${itemId}.png`;
}
window._itemTextureSrc = itemTextureSrc;

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
        el.title = slot ? `${slot.itemId} ×${slot.count}` : '';
    });
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
        crafting: 'Crafting Table', oven: 'Oven',
        smelter: 'Smelter', chest: 'Chest', anvil: 'Anvil',
    }[interactType] ?? interactType;

    populateRecipeList(interactType);
    DOM.interactivePanel.classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
    _menuOpen = true;
}

function closeInteractivePanel() {
    DOM.interactivePanel.classList.add("hidden");
    _activeStation = null;
    _menuOpen = false;
    DOM.gameScreen.requestPointerLock();
}

/* =========================================================
   INVENTORY SCREEN
========================================================= */

function openInventory() {
    if (!DOM.inventoryScreen) return;
    if (document.pointerLockElement) document.exitPointerLock();
    _invCursor = null;
    _renderInventory();
    DOM.inventoryScreen.classList.remove('hidden');
    _menuOpen = true;
}

function closeInventory() {
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
    DOM.gameScreen?.requestPointerLock();
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
        // Empty placeholder slots (always show at least 10 blank slots)
        const shown = Math.max(inv.slots.length, 10);
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
        el.title = item.itemId.replace(/_/g, ' ') + (item.count > 1 ? ` ×${item.count}` : '');
    }

    if (keybind) {
        const kb = document.createElement('span');
        kb.className = 'invGridKeybind';
        kb.textContent = keybind;
        el.appendChild(kb);
    }

    el.addEventListener('click', (e) => { e.stopPropagation(); _onSlotClick(slotRef, item); });
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

function populateRecipeList(station) {
    const inv  = window.me.inventory;
    DOM.recipeList.innerHTML = '';
    DOM.recipeDetailName.textContent = '';
    DOM.recipeDetail.textContent = '';
    DOM.craftBtn.style.opacity = '0.4';
    DOM.craftBtn.onclick = null;

    const recipes = mergedGamePackData.recipes.filter(r => r.station === station);
    for (const recipe of recipes) {
        const canCraft = inv ? inv.hasIngredients(_ingredientMap(recipe)) : false;
        const item = document.createElement('div');
        item.className = 'recipeListItem' + (canCraft ? '' : ' locked');
        item.textContent = recipe.result.itemId.replace(/_/g, ' ');
        item.addEventListener('click', () => selectRecipe(recipe, canCraft));
        DOM.recipeList.appendChild(item);
    }
}

function selectRecipe(recipe, canCraft) {
    _selectedRecipeId = recipe.id;
    document.querySelectorAll('.recipeListItem').forEach(el => {
        el.classList.toggle('active', el.textContent === recipe.result.itemId.replace(/_/g, ' '));
    });
    DOM.recipeDetailName.textContent = recipe.result.itemId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    DOM.recipeDetail.innerHTML = recipe.ingredients.map(i => `${i.count}× ${i.itemId.replace(/_/g, ' ')}`).join('<br>');
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
    DOM.gameScreen.requestPointerLock();
    paused = false;
}

async function leaveWorld() {
    gameStarted = false;
    paused = false;
    activeWorld = null;
    stopLoadingTextRotation();
    if (document.pointerLockElement) document.exitPointerLock();
    callWorldJS("quitWorld");
    DOM.gameScreen.classList.add("hidden");
    DOM.pauseScreen.classList.add("hidden");
    DOM.deathScreen?.classList.add("hidden");
    DOM.interactivePanel?.classList.add("hidden");
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

function gameLoop(timestamp) {
    if (!gameStarted) return;
    const dt = _lastFrameTime ? Math.min((timestamp - _lastFrameTime) / 1000, 0.1) : 0.016;
    _lastFrameTime = timestamp;

    if (!paused) {
        handleHotbarKeys();
        if (!_menuOpen && document.pointerLockElement !== DOM.gameScreen) paused = true;
    } else {
        if (document.pointerLockElement === DOM.gameScreen) paused = false;
    }

    updateUIVisibility();
    worldTick(dt);
    requestAnimationFrame(gameLoop);
}

function handleHotbarKeys() {
    for (let i = 0; i < 10; i++) {
        if (KEYS[`Digit${i === 9 ? 0 : i + 1}`]) {
            updateHotbarSelection(i);
        }
    }
}

function updateUIVisibility() {
    DOM.pauseScreen.classList.toggle("hidden", !paused || _menuOpen);
    DOM.gameUI.classList.toggle("hidden", paused && !_menuOpen);
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
