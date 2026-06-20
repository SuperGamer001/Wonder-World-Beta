/* =========================================================
   CONFIGURATION
========================================================= */

const gamePacks = ["-**DEFAULT**-"];

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

// Merged data from all loaded game packs — passed to world.js on game start
const mergedGamePackData = { blocks: [], biomes: [] };

let paused = false;
let gameStarted = false;

let loadingTextInterval = null;
let currentLoadingTextIndex = -1;

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
        head: null,
        chest: null,
        legs: null,
        feet: null,
        ears: null,
        hands: null,
        arms: null,
        quiver: null
    },

    position: {
        x: 0,
        y: 0,
        z: 0
    },

    entity: null
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

    DOM.loadingText.textContent = "Loading GamePacks...";

    await loadAllGamePacks();

    applyLoadedAssets();

    DOM.loadingContainer.classList.add("hidden");
    DOM.titleScreen.classList.remove("hidden");

    DOM.startButton.addEventListener("click", startGame);
});

/* =========================================================
   DOM SETUP
========================================================= */

function cacheDOM() {
    DOM.startButton = document.querySelector("#startButton");

    DOM.confirmPopup = document.querySelector("#confirmPopup");
    DOM.confirmTitle = document.querySelector("#confirmTitle");
    DOM.confirmMessage = document.querySelector("#confirmMessage");
    DOM.confirmYes = document.querySelector("#confirmYes");
    DOM.confirmNo = document.querySelector("#confirmNo");

    DOM.loadingBar = document.querySelector(".progressBar");
    DOM.loadingContainer = document.querySelector(".loadingContainer");
    DOM.loadingText = document.querySelector(".loadingText");

    DOM.packName = document.querySelector("#packName");

    DOM.logo = document.querySelector(".logo");
    DOM.pauseLogo = document.querySelector("#PauseLogo");

    DOM.titleScreen = document.querySelector("#TitleScreen");
    DOM.gameScreen = document.querySelector("#GameScreen");
    DOM.pauseScreen = document.querySelector("#PauseScreen");
    DOM.gameUI = document.querySelector("#gameUI");
    DOM.titleLogo = document.querySelector("#TitleLogo");
}

/* =========================================================
   EVENT LISTENERS
========================================================= */

window.addEventListener("blur", () => {
    paused = true;
});

window.addEventListener("keydown", (event) => {
    KEYS[event.code] = true;
});

window.addEventListener("keyup", (event) => {
    KEYS[event.code] = false;
});

window.addEventListener("beforeunload", (event) => {
    if (!safeToClose) {
        event.preventDefault();
        event.returnValue = "";
        closeGame();
    }
});

/* =========================================================
   GAME STARTUP
========================================================= */

function startGame() {
    gameStarted = true;

    DOM.titleScreen.classList.add("hidden");

    DOM.packName.style.display =
        packsLoaded === 1 ? "none" : "block";

    DOM.loadingBar.style.width = "0%";

    DOM.loadingText.textContent = "Loading World...";
    DOM.packName.textContent =
        `${packsLoaded} Gamepacks Successfully Loaded`;

    DOM.logo.classList.add("Loading");

    DOM.loadingContainer.classList.remove("hidden");

    // Signal world.js to begin generation, passing all loaded game pack data
    callWorldJS("startWorldLoad", { gamepackData: mergedGamePackData });

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

    // Quick buffer to ensure the game screen is fully visible before requesting pointer lock
    setTimeout(() => {
        DOM.gameScreen.requestPointerLock();
    }, 10)

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
    const hotbarSlots =
        document.getElementsByClassName("hotbarSlot");

    // for (
    //     let i = 0;
    //     i < Math.min(5, hotbarSlots.length);
    //     i++
    // ) {
    //     if (
    //         textures.item &&
    //         hotbarSlots[i].firstElementChild
    //     ) {
    //         hotbarSlots[i].firstElementChild.src =
    //             textures.item;
    //     }
    // }
}

function selectHotbarSlot(slotIndex) {
    document
        .querySelector(".selected")
        ?.classList.remove("selected");

    const hotbarSlots =
        document.getElementsByClassName("hotbarSlot");

    hotbarSlots[slotIndex]?.classList.add("selected");
}

/* =========================================================
   LOADING SCREEN TEXTS
========================================================= */

function startLoadingTextRotation() {
    if (loadingTexts.length === 0) {
        return;
    }

    loadingTextInterval = setInterval(() => {
        DOM.loadingText.classList.add("fade-out");

        setTimeout(() => {
            let nextIndex = currentLoadingTextIndex;

            while (
                loadingTexts.length > 1 &&
                nextIndex === currentLoadingTextIndex
            ) {
                nextIndex = Math.floor(
                    Math.random() * loadingTexts.length
                );
            }

            currentLoadingTextIndex = nextIndex;

            const entry =
                loadingTexts[currentLoadingTextIndex];

            DOM.loadingText.textContent = entry.text;
            DOM.packName.textContent =
                `${entry.packName} Gamepack`;

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
        const gamepackPath =
            packName === "-**DEFAULT**-"
                ? "data/gamepack.json"
                : `gamepacks/${packName}/gamepack.json`;

        const response = await fetch(gamepackPath);

        if (!response.ok) {
            throw new Error(
                `Failed to load ${packName}`
            );
        }

        const gamepackData =
            await response.json();

        loadTextures(packName, gamepackData);
        loadLoadingTexts(packName, gamepackData);
        loadTitleBackground(gamepackData);
        mergeGamePackWorldData(gamepackData);

        packsLoaded++;

        console.log(
            `Loaded GamePack: ${packName}`
        );
    }
    catch (error) {
        console.error(
            `GamePack "${packName}" failed to load`,
            error
        );
    }
}

async function loadAllGamePacks() {
    const totalPacks = gamePacks.length;

    for (const [index, pack] of gamePacks.entries()) {
        await loadGamePack(pack);

        const percent = Math.round(
            ((index + 1) / totalPacks) * 100
        );

        DOM.loadingBar.style.width =
            `${percent}%`;
    }
}

function loadTextures(packName, data) {
    if (!data.textures) {
        return;
    }

    for (const [name, path] of Object.entries(
        data.textures
    )) {
        if (textures[name]) {
            continue;
        }

        textures[name] =
            packName === "-**DEFAULT**-"
                ? `data/${path}`
                : `gamepacks/${packName}/${path}`;
    }
}

function loadLoadingTexts(packName, data) {
    if (!Array.isArray(data.loadingText)) {
        return;
    }

    const displayName =
        packName === "-**DEFAULT**-"
            ? "Vanilla"
            : packName;

    for (const text of data.loadingText) {
        loadingTexts.push({
            text,
            packName: displayName
        });
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
    if (
        titleBG !== null ||
        !data.titleScreenBG
    ) {
        return;
    }

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

function leaveWorld() {
    // Stop gameplay
    gameStarted = false;
    paused = false;

    // Stop any active loading screen animations
    stopLoadingTextRotation();

    // Exit mouse capture
    if (document.pointerLockElement) {
        document.exitPointerLock();
    }

    // Hide game-related screens
    DOM.gameScreen.classList.add("hidden");
    DOM.pauseScreen.classList.add("hidden");
    DOM.loadingContainer.classList.add("hidden");

    // Show title screen again
    DOM.titleScreen.classList.remove("hidden");
    DOM.titleLogo.classList.remove("hidden");

    // Reset loading bar
    DOM.loadingBar.style.width = "0%";

    // Reset title screen logo animation
    DOM.logo.classList.remove("Loading");
    

    console.log("Returned to Title Screen");
}

/* =========================================================
   MAIN LOOP
========================================================= */

let _lastFrameTime = 0;

function gameLoop(timestamp) {
    if (!gameStarted) {
        return;
    }

    const dt = _lastFrameTime ? Math.min((timestamp - _lastFrameTime) / 1000, 0.1) : 0.016;
    _lastFrameTime = timestamp;

    if (!paused) {
        handleHotbarKeys();

        if (
            document.pointerLockElement !==
            DOM.gameScreen
        ) {
            paused = true;
        }
    }
    else {
        if (
            document.pointerLockElement ===
            DOM.gameScreen
        ) {
            paused = false;
        }
    }

    updateUIVisibility();

    worldTick(dt);

    requestAnimationFrame(gameLoop);
}

function handleHotbarKeys() {
    for (let i = 0; i < 10; i++) {
        const key =
            `Digit${i === 9 ? 0 : i + 1}`;

        if (KEYS[key]) {
            selectHotbarSlot(i);
        }
    }
}

function updateUIVisibility() {
    DOM.pauseScreen.classList.toggle(
        "hidden",
        !paused
    );

    DOM.gameUI.classList.toggle(
        "hidden",
        paused
    );
}

function openConfirm(title, message, task) {
    DOM.confirmMessage.textContent = message;

    DOM.confirmYes.onclick = () => {
        task();
        DOM.confirmPopup.classList.add("hidden");
    };

    DOM.confirmPopup.classList.remove("hidden");

    DOM.confirmTitle.textContent = title;
}

function closeGame() {
    openConfirm(
        "Quit Game",
        "Would you like to close Wonder World?",
        () => {
            safeToClose = true;
            // Send a message to the parent window (if applicable) to indicate the game is closing
            if (window.parent) {
                window.parent.postMessage("closeGame", "*");
            }
            window.close();
        }
    );
}

function worldTick(dt) {
    callWorldJS("tick", { dt });
}

function callWorldJS(eventName, data = {}) {
    const event = new Event("WorldJS_" + eventName);
    event.data = data;
    document.dispatchEvent(event);
}