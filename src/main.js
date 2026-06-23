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

// Block IDs must match the "id" fields in data/gamepack.json
const BLOCK_TYPES = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5,
    WOOD: 6, LEAVES: 7, GRAVEL: 8, COAL_ORE: 9, IRON_ORE: 10,
    GOLD_ORE: 11, SNOW: 12, ICE: 13, SANDSTONE: 14, CLAY: 15,
    SNOW_DIRT: 16, GRANITE: 17, DIORITE: 18, BEDROCK: 19,
};

let titleBG = null;
let packsLoaded = 0;
let safeToClose = true;

const mergedGamePackData = { blocks: [], biomes: [] };

let paused = false;
let gameStarted = false;

let loadingTextInterval = null;
let currentLoadingTextIndex = -1;

// Currently active world metadata (set when entering a world)
let activeWorld = null;

/* =========================================================
   PLAYER
========================================================= */

window.me = {
    health: 100,
    hunger: 100,
    energy: 100,

    inventory: {
        hotbar: [],
        backpack: []
    },

    maxBackpackSize: 20,

    equipment: {
        head: null, chest: null, legs: null, feet: null,
        ears: null, hands: null, arms: null, quiver: null
    },

    position: { x: 0, y: 0, z: 0 }
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

    await loadAllGamePacks();

    applyLoadedAssets();

    // Hide initial loading bar, show title
    DOM.appLoadingContainer.classList.add("hidden");
    DOM.titleScreen.classList.remove("hidden");

    DOM.startButton.addEventListener("click", showWorldList);
    DOM.createWorldBtn.addEventListener("click", showCreateWorldModal);
    DOM.worldListBackBtn.addEventListener("click", () => {
        DOM.worldListScreen.classList.add("hidden");
        DOM.titleScreen.classList.remove("hidden");
    });

    DOM.worldDetailCloseBtn.addEventListener("click", () => {
        DOM.worldDetailModal.classList.add("hidden");
    });

    DOM.worldPlayBtn.addEventListener("click", () => {
        if (activeWorld) {
            DOM.worldDetailModal.classList.add("hidden");
            startWorld(activeWorld);
        }
    });

    DOM.worldDuplicateBtn.addEventListener("click", async () => {
        if (!activeWorld) return;
        DOM.worldDetailModal.classList.add("hidden");
        try {
            await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/duplicate`, { method: 'POST' });
            showWorldList();
        } catch (e) {
            console.error('Duplicate failed', e);
        }
    });

    DOM.worldDeleteBtn.addEventListener("click", () => {
        if (!activeWorld) return;
        openConfirm(
            'Delete World',
            `Permanently delete "${activeWorld.name}"? This cannot be undone.`,
            async () => {
                try {
                    await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}`, { method: 'DELETE' });
                } catch (e) { console.error('Delete failed', e); }
                DOM.worldDetailModal.classList.add("hidden");
                showWorldList();
            }
        );
    });

    DOM.createWorldConfirmBtn.addEventListener("click", createWorld);
    DOM.createWorldCancelBtn.addEventListener("click", () => {
        DOM.createWorldModal.classList.add("hidden");
    });
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

    DOM.packName         = document.querySelector("#packName");
    DOM.logo             = document.querySelector("#TitleLogo");
    DOM.pauseLogo        = document.querySelector("#PauseLogo");

    DOM.titleScreen      = document.querySelector("#TitleScreen");
    DOM.worldListScreen  = document.querySelector("#WorldListScreen");
    DOM.worldDetailModal = document.querySelector("#WorldDetailModal");
    DOM.createWorldModal = document.querySelector("#CreateWorldModal");
    DOM.gameScreen       = document.querySelector("#GameScreen");
    DOM.pauseScreen      = document.querySelector("#PauseScreen");
    DOM.gameUI           = document.querySelector("#gameUI");
    DOM.titleLogo        = document.querySelector("#TitleLogo");

    DOM.worldListContainer = document.querySelector("#worldListContainer");
    DOM.createWorldBtn     = document.querySelector("#createWorldBtn");
    DOM.worldListBackBtn   = document.querySelector("#worldListBackBtn");

    DOM.worldDetailName    = document.querySelector("#worldDetailName");
    DOM.worldDetailInfo    = document.querySelector("#worldDetailInfo");
    DOM.worldPlayBtn       = document.querySelector("#worldPlayBtn");
    DOM.worldDuplicateBtn  = document.querySelector("#worldDuplicateBtn");
    DOM.worldDeleteBtn     = document.querySelector("#worldDeleteBtn");
    DOM.worldDetailCloseBtn = document.querySelector("#worldDetailCloseBtn");

    DOM.createWorldConfirmBtn = document.querySelector("#createWorldConfirmBtn");
    DOM.createWorldCancelBtn  = document.querySelector("#createWorldCancelBtn");
    DOM.newWorldName  = document.querySelector("#newWorldName");
    DOM.newWorldSeed  = document.querySelector("#newWorldSeed");
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

window.addEventListener("blur", () => { paused = true; });

window.addEventListener("keydown", (event) => { KEYS[event.code] = true; });
window.addEventListener("keyup",   (event) => { KEYS[event.code] = false; });

window.addEventListener("beforeunload", (event) => {
    if (!safeToClose) {
        event.preventDefault();
        event.returnValue = "";
        closeGame();
    }
});

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
    } catch (e) {
        console.warn('Server not reachable — no saved worlds available.', e);
    }

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
        const lastPlayed = world.lastPlayed
            ? new Date(world.lastPlayed).toLocaleDateString()
            : 'Never';
        card.innerHTML = `
            <div class="worldCardInfo">
                <div class="worldCardName">${escapeHtml(world.name)}</div>
                <div class="worldCardMeta">Seed: ${world.seed} &nbsp;|&nbsp; Last played: ${lastPlayed}</div>
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
    DOM.worldDetailInfo.textContent = `Seed: ${world.seed}`;
    DOM.worldDetailModal.classList.remove("hidden");
}

/* =========================================================
   CREATE WORLD
========================================================= */

function showCreateWorldModal() {
    DOM.newWorldName.value = '';
    DOM.newWorldSeed.value = '';
    DOM.createWorldModal.classList.remove("hidden");
}

async function createWorld() {
    const name = DOM.newWorldName.value.trim() || 'New World';
    const seedRaw = DOM.newWorldSeed.value.trim();
    const seed = seedRaw !== '' ? (parseInt(seedRaw, 10) || hashString(seedRaw)) : undefined;

    try {
        const res = await fetch(`${SERVER_URL}/api/worlds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, seed }),
        });
        if (!res.ok) throw new Error('Server error');
        const newWorld = await res.json();

        DOM.createWorldModal.classList.add("hidden");
        // Immediately play the new world
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

    // Signal world.js to begin generation, passing gamepack data + world metadata
    callWorldJS("startWorldLoad", {
        gamepackData: mergedGamePackData,
        worldId:   world.id,
        worldSeed: world.seed,
        playerPos: world.playerPos ?? { x: 0, y: 100, z: 0 },
    });

    startLoadingTextRotation();

    setTimeout(() => {
        finishGameStartup();
    }, 2000);
}

function finishGameStartup() {
    stopLoadingTextRotation();

    DOM.loadingContainer.classList.add("hidden");
    DOM.gameScreen.classList.remove("hidden");
    DOM.titleLogo.classList.add("hidden");

    setTimeout(() => {
        DOM.gameScreen.requestPointerLock();
    }, 10);

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

function initializeHotbar() {}

function selectHotbarSlot(slotIndex) {
    document.querySelector(".selected")?.classList.remove("selected");
    const hotbarSlots = document.getElementsByClassName("hotbarSlot");
    hotbarSlots[slotIndex]?.classList.add("selected");
}

/* =========================================================
   LOADING SCREEN TEXTS
========================================================= */

function startLoadingTextRotation() {
    if (loadingTexts.length === 0) return;

    loadingTextInterval = setInterval(() => {
        DOM.loadingText.classList.add("fade-out");

        setTimeout(() => {
            let nextIndex = currentLoadingTextIndex;
            while (loadingTexts.length > 1 && nextIndex === currentLoadingTextIndex) {
                nextIndex = Math.floor(Math.random() * loadingTexts.length);
            }
            currentLoadingTextIndex = nextIndex;
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
   GAMEPACK LOADING
========================================================= */

async function loadGamePack(packName) {
    try {
        const gamepackPath = packName === "-**DEFAULT**-"
            ? "data/gamepack.json"
            : `gamepacks/${packName}/gamepack.json`;

        const response = await fetch(gamepackPath);
        if (!response.ok) throw new Error(`Failed to load ${packName}`);

        const gamepackData = await response.json();

        loadTextures(packName, gamepackData);
        loadLoadingTexts(packName, gamepackData);
        loadTitleBackground(gamepackData);
        mergeGamePackWorldData(gamepackData);

        packsLoaded++;
        console.log(`Loaded GamePack: ${packName}`);
    } catch (error) {
        console.error(`GamePack "${packName}" failed to load`, error);
    }
}

async function loadAllGamePacks() {
    const totalPacks = gamePacks.length;

    for (const [index, pack] of gamePacks.entries()) {
        await loadGamePack(pack);
        const percent = Math.round(((index + 1) / totalPacks) * 100);
        DOM.appProgressBar.style.width = `${percent}%`;
    }
}

function loadTextures(packName, data) {
    if (!data.textures) return;
    for (const [name, path] of Object.entries(data.textures)) {
        if (textures[name]) continue;
        textures[name] = packName === "-**DEFAULT**-"
            ? `data/${path}`
            : `gamepacks/${packName}/${path}`;
    }
}

function loadLoadingTexts(packName, data) {
    if (!Array.isArray(data.loadingText)) return;
    const displayName = packName === "-**DEFAULT**-" ? "Vanilla" : packName;
    for (const text of data.loadingText) {
        loadingTexts.push({ text, packName: displayName });
    }
}

function mergeGamePackWorldData(data) {
    if (Array.isArray(data.blocks)) {
        for (const block of data.blocks) {
            if (!mergedGamePackData.blocks.find(b => b.id === block.id)) {
                mergedGamePackData.blocks.push(block);
            }
        }
    }
    if (Array.isArray(data.biomes)) {
        for (const biome of data.biomes) {
            if (!mergedGamePackData.biomes.find(b => b.name === biome.name)) {
                mergedGamePackData.biomes.push(biome);
            }
        }
    }
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
    // Save player position before quitting
    if (activeWorld) {
        try {
            await fetch(`${SERVER_URL}/api/worlds/${activeWorld.id}/player-pos`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(window.me.position),
            });
        } catch (e) { /* server may be offline */ }
    }

    gameStarted = false;
    paused = false;
    activeWorld = null;

    stopLoadingTextRotation();

    if (document.pointerLockElement) document.exitPointerLock();

    callWorldJS("quitWorld");

    DOM.gameScreen.classList.add("hidden");
    DOM.pauseScreen.classList.add("hidden");
    DOM.loadingContainer.classList.add("hidden");
    DOM.titleLogo.classList.remove("hidden");
    DOM.logo.classList.remove("Loading");
    DOM.loadingBar.style.width = "0%";

    // Return to world list, not title
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
        if (document.pointerLockElement !== DOM.gameScreen) paused = true;
    } else {
        if (document.pointerLockElement === DOM.gameScreen) paused = false;
    }

    updateUIVisibility();
    worldTick(dt);
    requestAnimationFrame(gameLoop);
}

function handleHotbarKeys() {
    for (let i = 0; i < 10; i++) {
        if (KEYS[`Digit${i === 9 ? 0 : i + 1}`]) selectHotbarSlot(i);
    }
}

function updateUIVisibility() {
    DOM.pauseScreen.classList.toggle("hidden", !paused);
    DOM.gameUI.classList.toggle("hidden", paused);
}

/* =========================================================
   CONFIRM DIALOG
========================================================= */

function openConfirm(title, message, task) {
    DOM.confirmMessage.textContent = message;
    DOM.confirmTitle.textContent = title;
    DOM.confirmYes.onclick = () => {
        task();
        DOM.confirmPopup.classList.add("hidden");
    };
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

function worldTick(dt) {
    callWorldJS("tick", { dt });
}

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
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Simple string → integer hash (for text seeds). */
function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h & 0x7FFFFFFF;
}
