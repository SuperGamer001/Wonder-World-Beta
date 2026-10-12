/*
 * Who is playing: names, and playing together.
 *
 * A classic script loaded after main.js, whose state it shares (the settings,
 * the screens, startWorld). Three things live here:
 *
 *   • Names. A player has a name, and the names used on this machine are kept
 *     in a list with the look that goes with each (the server's profiles:
 *     settings.json `profiles`, `[{ name, skin }]`). The first time the game
 *     is opened it asks for one; after that the name last chosen is the one
 *     it starts with. A keyboard just types it. A controller has no letters,
 *     so it gets a telephone keypad — press 2 once for a, twice for b — which
 *     is twelve big keys to move between instead of forty small ones.
 *   • Split screen. Another controller joins from the Players panel of the
 *     pause menu: index.js opens a second copy of the game beside the first
 *     (a pane: `?pane=1&pad=<controller>&world=<id>`), which asks who is
 *     playing and then joins the same world as its own player. Each pane is a
 *     whole game — its own screen, camera, inventory and menus.
 *   • The network. The same panel opens the world to other machines; the
 *     world list has "Join a game" for the other end. A guest's page is this
 *     game served by the host (server.js, *On the network*), so it is told it
 *     is a guest (`/api/lan/info`) and goes straight into the host's world.
 *   • Online. The same panel opens the world to players anywhere, through
 *     Ably (src/scripts/Online.js is this page's end of it),
 *     and shows the code they join with; "Join a game" takes a code. A guest
 *     of an online game plays in their own copy of the game, from their own
 *     menu, and goes back to it afterwards.
 *
 * Every player after the first — a pane or a guest — is a **guest** of the
 * world: their place and inventory in it are kept in a file of their own (by
 * name), and the world's own settings are not theirs to change.
 */

const MAX_NAME = 16;
const NAME_OK = /[^A-Za-z0-9 ._'-]/g;       // what a name may not contain

let _lanGuest = false;                       // this page is a guest's view of someone's open world
const isGuest = () => PANE > 0 || _lanGuest;
// This player, from their own menu, is in an online game somebody else hosts.
// (Not `isGuest`: they have a menu, settings and worlds of their own to go back to.)
let _onlineGuest = false;
// Which player of this machine this page is, to the online server: 0 the first.
const SLOT = PANE > 0 ? Math.max(1, Math.min(3, parseInt(PARAMS.get('slot')) || PANE)) : 0;
/** The split-screen manager in the page round this one (index.js), if there is one. */
const splitManager = () => { try { return window.parent !== window ? window.parent.__wwSplit ?? null : null; } catch { return null; } };

// ── Names ────────────────────────────────────────────────────────────────────

const cleanName = (s) => String(s ?? '').replace(NAME_OK, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

function getProfiles() {
    return (_settings?.profiles ?? []).filter(p => p && typeof p.name === 'string' && p.name);
}
function _setProfiles(list) {
    _settings = { ...(_settings ?? {}), profiles: list };
    try { localStorage.setItem('ww_settings', JSON.stringify(_settings)); } catch { /* storage unavailable */ }
}
/** Add a name to the list, or change the look kept with it. */
function saveProfile(name, skin = undefined) {
    const list = getProfiles().map(p => ({ ...p }));
    let p = list.find(q => q.name === name);
    if (!p) list.push(p = { name, skin: null });
    if (skin !== undefined) p.skin = skin;
    _setProfiles(list);
    if (_lanGuest) return;                   // a guest's names are kept by their own browser
    fetch(`${SERVER_URL}/api/profiles`, {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, skin: p.skin }),
    }).catch(() => { /* offline: localStorage has it */ });
}
function removeProfile(name) {
    _setProfiles(getProfiles().filter(p => p.name !== name));
    if (!_lanGuest) fetch(`${SERVER_URL}/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
}
/** The names again from the server: another pane may have added one. */
async function refreshProfiles() {
    if (_lanGuest) return;
    try {
        const res = await fetch(`${SERVER_URL}/api/settings`, { cache: 'no-store' });
        if (res.ok) { const s = await res.json(); if (Array.isArray(s.profiles)) _setProfiles(s.profiles); }
    } catch { /* keep what we have */ }
}

/** Play as `name`: its look with it. Remembered as the name to start with next time. */
function selectProfile(name) {
    const s = getSettings(), p = getProfiles().find(q => q.name === name);
    const next = { ...s, playerName: name, skin: p?.skin ?? s.skin ?? null };
    saveSettings(next);
    applyPlayerSettings(next);
    _showPlayerName();
}
function _showPlayerName() {
    const name = getSettings().playerName || 'Player';
    const btn = document.getElementById('titlePlayerBtn');
    if (btn) btn.textContent = `Playing as ${name}`;
    const title = document.getElementById('characterTitle');
    if (title) title.textContent = name;
}

// ── The name screen ──────────────────────────────────────────────────────────
// Two views: the list of names to pick from, and the entry of a new one.

const _name = { resolve: null, required: false, taken: [], view: 'pick' };

/**
 * Ask who is playing. Resolves with the name chosen (already selected), or
 * null if the player backed out — which `required` does not allow.
 *   title     the heading
 *   taken     names someone else on this screen is already playing as
 */
function pickName({ title = "Who's playing?", required = false, taken = [] } = {}) {
    return new Promise(async (resolve) => {
        await refreshProfiles();
        Object.assign(_name, { resolve, required, taken });
        document.getElementById('nameTitle').textContent = title;
        document.getElementById('NameScreen').classList.remove('hidden');
        // Nothing to pick from (no names yet, or every one in use on this screen): straight to a new one.
        if (getProfiles().some(p => !taken.includes(p.name))) _nameView('pick'); else _nameView('entry');
    });
}

function _nameView(view) {
    _name.view = view;
    document.getElementById('namePick').classList.toggle('hidden', view !== 'pick');
    document.getElementById('nameEntry').classList.toggle('hidden', view !== 'entry');
    if (view === 'pick') {
        const list = document.getElementById('nameList');
        list.innerHTML = '';
        const current = getSettings().playerName;
        for (const p of getProfiles()) {
            const used = _name.taken.includes(p.name);
            const row = document.createElement('div');
            row.className = 'nameRow';
            const pick = document.createElement('div');
            pick.className = 'menuButton nameItem' + (p.name === current && PANE === 0 ? ' primary' : '') + (used ? ' cannot' : '');
            pick.textContent = used ? `${p.name} — playing` : p.name;
            if (!used) pick.addEventListener('click', () => _nameDone(p.name));
            row.appendChild(pick);
            // A name can be taken off the list, but not the one in use.
            if (!used && p.name !== current) {
                const del = document.createElement('div');
                del.className = 'menuButton small quiet';
                del.textContent = 'Remove';
                del.addEventListener('click', () => { removeProfile(p.name); _nameView('pick'); });
                row.appendChild(del);
            }
            list.appendChild(row);
        }
        document.getElementById('nameBackBtn').classList.toggle('hidden', _name.required);
    } else {
        const input = document.getElementById('nameInput');
        input.value = '';
        _t9.key = null; _t9.shift = false;
        _nameCheck();
        // Nothing to go back to when there is no name yet.
        document.getElementById('nameCancelBtn').classList.toggle('hidden', _name.required && !getProfiles().some(p => !_name.taken.includes(p.name)));
        // A keyboard types straight into the box; a controller uses the keypad under it.
        if (!window.__wwPad?.active) setTimeout(() => input.focus(), 30);
    }
}

function _nameCheck() {
    const input = document.getElementById('nameInput'), name = cleanName(input.value);
    const taken = _name.taken.includes(name);
    document.getElementById('nameDoneBtn').classList.toggle('cannot', !name || taken);
    document.getElementById('nameHint').textContent = taken ? 'Someone is already playing as that.'
        : 'Up to 16 letters. On a controller: press a key again for its next letter.';
    return name && !taken ? name : '';
}

function _nameDone(name) {
    name = cleanName(name);
    if (!name || _name.taken.includes(name)) return;
    // A new name: the first keeps the look there is; any other begins with a look of its own.
    if (!getProfiles().some(p => p.name === name)) {
        saveProfile(name, getProfiles().length === 0 ? getSettings().skin ?? null : window.__wwCharacter?.random() ?? null);
    }
    selectProfile(name);
    document.getElementById('NameScreen').classList.add('hidden');
    document.getElementById('nameInput').blur();
    const done = _name.resolve;
    _name.resolve = null;
    done?.(name);
}

function _nameCancel() {
    if (_name.view === 'entry' && getProfiles().some(p => !_name.taken.includes(p.name))) return _nameView('pick');
    if (_name.required) return;
    document.getElementById('NameScreen').classList.add('hidden');
    const done = _name.resolve;
    _name.resolve = null;
    done?.(null);
}

// ── The keypad ───────────────────────────────────────────────────────────────
// A telephone's: each key is a few letters and its digit, and pressing it
// again within a second goes on to the next of them. ⇧ changes the case of the
// letter just typed (or of the next one); names begin with a capital anyway.

const T9_KEYS = { 1: ".-_'1", 2: 'abc2', 3: 'def3', 4: 'ghi4', 5: 'jkl5', 6: 'mno6', 7: 'pqrs7', 8: 'tuv8', 9: 'wxyz9', 0: ' 0' };
const T9_AGAIN = 1000;        // ms: a press of the same key within this goes on to its next letter
const _t9 = { key: null, i: 0, at: 0, shift: false, upper: false };
const cased = (c) => _t9.upper ? c.toUpperCase() : c;

function t9Press(k) {
    const input = document.getElementById('nameInput');
    let v = input.value;
    const now = performance.now();
    if (k === 'back') { v = v.slice(0, -1); _t9.key = null; }
    else if (k === 'shift') {
        // The letter still being chosen changes case; otherwise the next one will.
        if (_t9.key !== null && now - _t9.at < T9_AGAIN && v) {
            _t9.upper = !_t9.upper;
            v = v.slice(0, -1) + cased(T9_KEYS[_t9.key][_t9.i]);
            _t9.at = now;
        } else _t9.shift = !_t9.shift;
    } else if (k === 'done') return _nameDone(_nameCheck());
    else if (T9_KEYS[k]) {
        const letters = T9_KEYS[k], again = _t9.key === k && now - _t9.at < T9_AGAIN && v.length > 0;
        if (again) {
            _t9.i = (_t9.i + 1) % letters.length;
            v = v.slice(0, -1) + cased(letters[_t9.i]);
        } else if (v.length < MAX_NAME) {
            _t9.i = 0;
            // A capital to begin a name and after a space, unless ⇧ says otherwise.
            _t9.upper = (v.length === 0 || v.endsWith(' ')) !== _t9.shift;
            _t9.shift = false;
            v += cased(letters[0]);
        }
        _t9.key = k; _t9.at = now;
    }
    input.value = v;
    document.getElementById('t9Shift')?.classList.toggle('on', _t9.shift);
    _nameCheck();
}

// What a controller's other buttons do on the name screen (gamepad.js): X rubs out, Y is a space, Start is Done.
window.__wwName = { pad: t9Press, cancel: _nameCancel, entering: () => _name.view === 'entry' };

// ── Notices ──────────────────────────────────────────────────────────────────

let _noticeTimer = 0;
function showNotice(text) {
    const el = document.getElementById('padNotice');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(_noticeTimer);
    _noticeTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
window.addEventListener('ww_notice', (e) => showNotice(e.detail?.text ?? ''));

// ── Starting up ──────────────────────────────────────────────────────────────

/** Where this player's place in someone else's world is kept: by name (and, from another machine, by machine). */
function guestStateKey() {
    const s = getSettings(), name = (s.playerName || 'player').replace(/[^A-Za-z0-9]/g, '_');
    return PANE > 0 ? `p-${name}` : `${String(s.clientId ?? 'guest').slice(0, 40)}-${name}`;
}

/**
 * The game is loaded: who is playing, and where do they go? Called once by
 * main.js. The first player goes to the title screen (after saying who they
 * are, the first time); a split-screen pane or a guest from the network says
 * who they are and goes straight into the world.
 */
async function enterGame() {
    const sound = window.__wwSound;
    if (PANE > 0 && sound) { sound.shared = false; sound._applyVolumes?.(); }   // the first screen plays what everyone hears
    if (PANE === 0) {
        try { _lanGuest = !!(await (await fetch(`${SERVER_URL}/api/lan/info`)).json()).guest; } catch { _lanGuest = false; }
    }
    // A machine keeps one id, so its player finds their things again in a world they have been a guest in.
    if (!getSettings().clientId) saveSettings({ ...getSettings(), clientId: (crypto.randomUUID?.() ?? String(Math.random()).slice(2)) });

    if (isGuest()) {
        document.body.classList.add('isGuest');
        DOM.titleLogo?.classList.add('hidden');
        // Each new player says who they are; the others play on meanwhile.
        const taken = (PARAMS.get('taken') ?? '').split('|').filter(Boolean);
        // A guest who came from their own game brought their name with them.
        const known = _lanGuest && getProfiles().some(p => p.name === getSettings().playerName) ? getSettings().playerName : null;
        const name = known ?? await pickName({ title: PANE > 0 ? `Player ${PANE + 1}: who's playing?` : "Who's playing?", required: PANE === 0, taken });
        if (known) selectProfile(known);
        if (!name) return splitManager()?.close(PANE);       // backed out: the pane goes away again
        splitManager()?.named(PANE, name);
        let world = null;
        // The first player's game is online: this pane joins the same room, as a further player of this machine.
        const code = PANE > 0 ? PARAMS.get('online') : null, theirs = PARAMS.get('world') === 'online';
        if (code) {
            try {
                await window.__wwOnline.join(code, { name, skin: getSettings().skin, slot: SLOT, gamepack: mergedGamePackData }, !theirs);
            } catch (e) { return sessionOver(e?.reason ?? 'unreachable'); }
        }
        try {
            world = code && theirs ? window.__wwOnline.world()
                  : PANE > 0 ? await (await fetch(`${SERVER_URL}/api/worlds/${encodeURIComponent(PARAMS.get('world') ?? '')}`)).json()
                             : (await (await fetch(`${SERVER_URL}/api/lan/info`)).json()).world;
        } catch { /* below */ }
        if (!world?.id) return sessionOver('unreachable');
        if (code) world = { ...world, online: true };
        DOM.titleLogo?.classList.remove('hidden');
        return startWorld(world);
    }

    // The first time: a name. After that, the one chosen last.
    const s = getSettings();
    if (getProfiles().length === 0) {
        if (s.playerName) { saveProfile(s.playerName, s.skin ?? null); }        // a name from before there was a list
        else await pickName({ title: 'Welcome! What shall we call you?', required: true });
    } else if (!getProfiles().some(p => p.name === s.playerName)) selectProfile(getProfiles()[0].name);
    _showPlayerName();
    DOM.titleScreen.classList.remove("hidden");
    sound?.playMusic(MENU_MUSIC);
    startMenuWorld();
}

/** The world this player was in has gone (the host left, the network closed) or could not be reached. */
/** Why a game ended or could not be joined, as the player is told it. */
const SESSION_WHY = {
    left: 'You have left the game.', host: 'The host has left the game.', closed: 'The game was closed to the network.',
    lost: 'The connection to the game was lost.', unreachable: 'The game could not be reached.', full: 'The game is full.',
    // Online (the reasons of OnlineError, src/scripts/engine/net/OnlineSession.js).
    code: 'No game has that code. Check it with the host — a code is only good while their game is open.',
    kicked: 'The host removed you from the game.', locked: 'The host is not letting anyone else in just now.',
    update: 'That game is on a newer version. Update the game to join it.', content: 'That game uses different game packs from yours.',
    busy: 'Too many attempts. Wait a minute and try again.', auth: 'The online service would not let this game in.',
    unavailable: 'This copy of the game has no online play set up.', world: "This world's seed cannot be shared online.",
};
const sessionWhy = (reason) => SESSION_WHY[reason] ?? 'The game has ended.';

function sessionOver(reason) {
    const why = sessionWhy(reason);
    if (gameStarted) leaveWorld(true);
    if (PANE > 0) return splitManager()?.close(PANE);
    if (_lanGuest) {
        document.getElementById('guestOverText').textContent = why;
        document.getElementById('GuestOverScreen').classList.remove('hidden');
        return;
    }
    showNotice(why);
}
window.addEventListener('ww_sessionClosed', (e) => {
    // The host's own session ending (the server went away) leaves the host playing alone.
    if (!isGuest() && !_onlineGuest) return showNotice('Other players can no longer join: the connection to the server was lost.');
    sessionOver(e.detail?.reason);
});
// The host's online room has gone; the world plays on (world.js has gone back to the game's own server).
window.addEventListener('ww_onlineEnded', (e) => {
    showNotice('The online game has ended: the connection was lost. You can open it again from the Players panel.');
    if (_playersTimer) _refreshPlayers();
});

// ── The Players panel (pause menu) ───────────────────────────────────────────

let _playersTimer = 0;
const _padWasDown = [];

function openPlayers() {
    DOM.pauseScreen.classList.add('hidden');
    document.getElementById('PlayersScreen').classList.remove('hidden');
    _refreshPlayers();
    // A button held as the panel opens is not a press.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) _padWasDown[i] = !!pads[i]?.buttons[0]?.pressed;
    clearInterval(_playersTimer);
    _playersTimer = setInterval(_refreshPlayers, 500);
    requestAnimationFrame(_watchForJoiners);
}
function closePlayers() {
    clearInterval(_playersTimer);
    _playersTimer = 0;
    document.getElementById('PlayersScreen').classList.add('hidden');
    DOM.pauseScreen.classList.remove('hidden');
}

async function _refreshPlayers() {
    // The world was left with the panel up: there is nothing more to show.
    if (!gameStarted) { clearInterval(_playersTimer); _playersTimer = 0; return; }
    const list = document.getElementById('playersList');
    const players = window.__wwPlayers?.() ?? [];
    const net = window.__wwWorld?.online?.() ?? null;       // this world's online room, if it is in one
    // Online, the host can send a player away (and their game is not let back in).
    const removable = (p) => net?.host && !p.you ? `<span class="menuButton small quiet playerKick" data-kick="${p.id}">Remove</span>` : '';
    const html = players.map(p =>
        `<div class="playerRow"><span class="playerName">${escapeHtml(p.name)}</span>` +
        `<span class="playerNote">${p.you ? 'you' : ''}${p.you && p.host ? ' · ' : ''}${p.host ? 'host' : ''}</span>${removable(p)}</div>`).join('') ||
        '<div class="formNote">Only you, so far.</div>';
    // Only when it has changed: the list is rebuilt twice a second, and a button rebuilt under a press is not pressed.
    if (list.dataset.html !== html) {
        list.dataset.html = html;
        list.innerHTML = html;
        for (const b of list.querySelectorAll('[data-kick]')) b.addEventListener('click', () => { window.__wwWorld?.kick(Number(b.dataset.kick)); });
    }

    const split = splitManager(), own = !isGuest() && !_onlineGuest;
    // Split screen: for the first screen to start, on a page that can show more than one.
    const mine = own || (_onlineGuest && PANE === 0);       // the first screen of this machine, in whoever's game
    document.getElementById('splitSection').classList.toggle('hidden', !mine || !split);
    if (mine && split) {
        const n = split.count();
        document.getElementById('splitNote').textContent = n >= split.max ? 'The screen is full: four players.'
            : 'To join on this screen, press  A  on another controller.';
    }
    // The network: the host's to open.
    document.getElementById('lanSection').classList.toggle('hidden', !own);
    if (own) {
        let st = null;
        try { st = await (await fetch(`${SERVER_URL}/api/lan/status`)).json(); } catch { /* no server */ }
        const open = !!st?.open && st.worldId === activeWorld?.id;
        const toggle = document.getElementById('lanOpenToggle');
        if (toggle && document.activeElement !== toggle) toggle.checked = open;
        if (toggle) toggle.disabled = !!net;                   // a world is in one session: the network's, or the online room's
        document.getElementById('lanNote').innerHTML = !st ? 'There is no game server to open.'
            : net ? 'This world is online. Close it there to open it to your network instead.'
            : !open ? 'Lets other computers on your network join this world.'
            : !st.addresses.length ? 'Open — but this computer is not on a network.'
            : 'Open. Others on your network can join from <b>Play → Join a game → On your network</b>.';
    }
    // Online: the host's to open, where this copy of the game has an online server to open it on.
    const available = !!(await window.__wwOnline?.available().catch(() => false));
    document.getElementById('onlineSection').classList.toggle('hidden', !available || !(own || net));
    if (available && (own || net)) {
        const toggle = document.getElementById('onlineOpenToggle');
        document.getElementById('onlineRow').classList.toggle('hidden', !own);
        if (toggle && document.activeElement !== toggle && !_onlineBusy) toggle.checked = !!net;
        // Who can join is chosen before the game is opened; open, it is what it was opened as.
        document.getElementById('onlineWhoRow').classList.toggle('hidden', !own || !!net || _onlineBusy);
        const open = document.getElementById('onlineVisibility').value === 'public';
        const note = document.getElementById('onlineNote');
        if (_onlineBusy) note.textContent = 'One moment…';
        else if (!net) note.textContent = open ? 'Lists this world under Play → Join a game → Online, for anyone to join.'
                                               : 'Lets anyone you give the code to join this world over the internet.';
        else {
            const code = window.__wwOnline.showCode(net.code);
            note.innerHTML = (!net.host ? 'You are in an online game. Its code:'
                    : net.visibility === 'public' ? 'This game is public: anyone can join it from <b>Play → Join a game → Online</b>. A friend can also use its code:'
                    : 'Others can join from <b>Play → Join a game → Online</b> with this code:') +
                `<br><span class="lanAddress" id="onlineCode">${escapeHtml(code)}</span>` +
                (net.down ? '<br>The connection was lost: reconnecting…' : '');
        }
    }
}

let _onlineBusy = false;
/** Open this world to players over the internet, or close it again. */
async function setOnlineOpen(on) {
    if (!activeWorld || _onlineBusy || isGuest() || _onlineGuest) return;
    _onlineBusy = true;
    _refreshPlayers();
    try {
        if (on) await window.__wwWorld.goOnline(activeWorld, { visibility: document.getElementById('onlineVisibility').value });
        else await window.__wwWorld.goOffline();
        // Done (had it failed, nothing would have changed). The players who were in this game through this
        // machine — a split screen, the network — were in its old session, which is over: they join again.
        splitManager()?.closeAll();
        if (on) await fetch(`${SERVER_URL}/api/lan/close`, { method: 'POST' }).catch(() => {});
    } catch (e) {
        showNotice(e?.reason ? sessionWhy(e.reason) : 'The game could not be opened online.');
    }
    _onlineBusy = false;
    _refreshPlayers();
}

async function setLanOpen(on) {
    if (!activeWorld) return;
    try {
        await fetch(`${SERVER_URL}/api/lan/${on ? 'open' : 'close'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worldId: activeWorld.id }),
        });
    } catch { /* shown as closed by the next refresh */ }
    _refreshPlayers();
}

/** While the Players panel is up: a controller nobody is using that presses A joins on this screen. */
function _watchForJoiners() {
    if (!_playersTimer) return;
    requestAnimationFrame(_watchForJoiners);
    const split = splitManager();
    if (!split || isGuest() || !activeWorld || split.count() >= split.max) return;
    if (_onlineBusy) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
        const gp = pads[i], down = !!gp?.connected && !!gp.buttons[0]?.pressed;
        const hit = down && !_padWasDown[i];
        _padWasDown[i] = down;
        // Not the controller this player is using, nor one that already has a screen.
        if (!hit || split.padTaken(i) || (window.__wwPad?.active && window.__wwPad.index === i)) continue;
        const taken = [getSettings().playerName, ...split.names()].filter(Boolean);
        // Online, the new player joins the room this one is in; otherwise the world on this machine's own server.
        split.add(i, activeWorld.id, taken, window.__wwWorld?.online?.()?.code ?? '');
        showNotice(`Player ${split.count()} is joining`);
        closePlayers();
        resumeGame();
        return;
    }
}

// ── Joining a game (world list): where it is, then which ──────────────────────

const ONLINE_ROOMS_MS = 8000;        // how often the list of public games is asked for while it is on screen
const MODE_NAMES = { SURVIVAL: 'Survival', CREATIVE: 'Creative', SPECTATOR: 'Spectator' };
let _lanGamesTimer = 0, _onlineRoomsTimer = 0, _onlineRoomsAsk = 0, _joinView = 'choose';

function openLanJoin() {
    document.getElementById('LanJoinModal').classList.remove('hidden');
    document.getElementById('onlineJoinCode').value = '';
    // Online is there to choose where this copy of the game has online play.
    const way = document.getElementById('joinOnlineWayBtn'), wayNote = document.getElementById('joinOnlineWayNote');
    const set = (yes) => {
        way.classList.toggle('cannot', !yes);
        wayNote.textContent = yes ? 'A public game, or a friend’s game with its code' : 'This copy of the game has no online play set up';
    };
    set(false);
    window.__wwOnline?.available().then(set, () => set(false));
    _showJoin('choose');
}
/** One of the Join screen's three views: 'choose' (where the game is), 'lan', 'online'. */
function _showJoin(view) {
    _joinView = view;
    document.getElementById('joinChoose').classList.toggle('hidden', view !== 'choose');
    document.getElementById('joinLanView').classList.toggle('hidden', view !== 'lan');
    document.getElementById('joinOnlineView').classList.toggle('hidden', view !== 'online');
    document.getElementById('joinTitle').textContent = view === 'lan' ? 'Games on your network' : view === 'online' ? 'Online games' : 'Join a game';
    document.getElementById('lanJoinNote').textContent = '';
    clearInterval(_lanGamesTimer); clearInterval(_onlineRoomsTimer);
    _lanGamesTimer = _onlineRoomsTimer = 0;
    if (view === 'lan') { _refreshLanGames(); _lanGamesTimer = setInterval(_refreshLanGames, 2000); }
    if (view === 'online') { refreshOnlineRooms(); _onlineRoomsTimer = setInterval(refreshOnlineRooms, ONLINE_ROOMS_MS); }
}
function closeLanJoin() {
    clearInterval(_lanGamesTimer); clearInterval(_onlineRoomsTimer);
    _lanGamesTimer = _onlineRoomsTimer = 0;
    _onlineRoomsAsk++;                              // an answer still on its way is for a screen that has gone
    document.getElementById('LanJoinModal').classList.add('hidden');
}
/** Back: from a list to the choice, from the choice to the menu. */
function backFromJoin() { if (_joinView === 'choose') closeLanJoin(); else _showJoin('choose'); }

async function _refreshLanGames() {
    let games = [];
    try { games = await (await fetch(`${SERVER_URL}/api/lan/games`)).json(); } catch { /* none */ }
    if (_joinView !== 'lan') return;
    const list = document.getElementById('lanGameList');
    list.innerHTML = '';
    for (const g of games) {
        const b = document.createElement('div');
        b.className = 'menuButton nameItem roomItem';
        const name = document.createElement('span');
        name.className = 'roomName';
        name.textContent = String(g.name ?? 'World');
        const about = document.createElement('span');
        about.className = 'roomAbout';
        about.textContent = `${g.host || 'someone'} · ${g.players | 0} playing`;
        b.append(name, about);
        b.addEventListener('click', () => joinLan(g.address));
        list.appendChild(b);
    }
    if (games.length === 0) list.innerHTML = '<div class="formNote">Looking for games on your network…<br>A game shows here when its host has turned on <b>Open to the network</b> in their Players panel.</div>';
}

/** The public games open now: asked of the online service, and asked again every few seconds while they are on screen. */
async function refreshOnlineRooms() {
    const list = document.getElementById('onlineRoomList');
    if (!list || !window.__wwOnline || _joiningOnline) return;
    const ask = ++_onlineRoomsAsk;
    let rooms = null, why = '';
    try { rooms = await window.__wwOnline.rooms({ gamepack: mergedGamePackData }); }
    catch (e) { why = e?.reason === 'busy' ? sessionWhy('busy') : 'The list of public games could not be reached.'; }
    if (ask !== _onlineRoomsAsk || _joinView !== 'online') return;      // a newer asking has been answered, or the screen has gone
    list.innerHTML = '';
    if (!rooms) { const n = document.createElement('div'); n.className = 'formNote'; n.textContent = why; list.appendChild(n); return; }
    for (const r of rooms) {
        const b = document.createElement('div');
        b.className = 'menuButton nameItem roomItem';
        // Everything here was typed by a stranger: it goes in as text, never as markup.
        const name = document.createElement('span');
        name.className = 'roomName';
        name.textContent = String(r.name ?? '').slice(0, 32);
        const about = document.createElement('span');
        about.className = 'roomAbout';
        about.textContent = `${String(r.host ?? '').slice(0, 16) || 'someone'} · ${MODE_NAMES[r.mode] ?? 'Survival'}${r.flat ? ' · flat' : ''} · ${r.players | 0}/${r.max | 0}`;
        b.append(name, about);
        b.addEventListener('click', () => joinOnline(r.code, true));
        list.appendChild(b);
    }
    if (rooms.length === 0) list.innerHTML = '<div class="formNote">No public games are open just now. To open your own: in a world, <b>pause → Players → Open online</b>, with <b>Anyone</b>.</div>';
}

/** Go to a host's game on the network: `address` is "192.168.1.20:25599", as the list of games gives it. */
async function joinLan(address) {
    const note = document.getElementById('lanJoinNote');
    address = String(address ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z0-9.\-]+:\d{1,5}$/.test(address)) return;
    const url = `http://${address}`;
    note.textContent = 'Joining…';
    // Is the game still there? (A guest's page tells us; nothing else answers like it.)
    try { await fetch(`${url}/api/lan/info`, { mode: 'no-cors', signal: AbortSignal.timeout(4000) }); }
    catch { note.textContent = 'That game is no longer there.'; return; }
    closeLanJoin();
    // The host serves the game to its guests. In the app, and from the game's own
    // page, the frame round this one swaps to it; a bare page just goes there.
    // What is handed over is the player's settings — not who they are online, which is nobody else's to hold.
    const { onlineCredential: _mine, ...me } = getSettings();
    if (window.parent !== window) window.parent.postMessage({ type: 'ww_joinLan', url, me }, '*');
    else location.href = `${url}/`;
}

let _joiningOnline = false;
/** Go to an online game: `text` is its code, as the host's Players panel shows it — or, `listed`, as the list of public games gave it. */
async function joinOnline(text, listed = false) {
    const note = document.getElementById('lanJoinNote');
    const code = window.__wwOnline?.cleanCode(text);
    if (!code) { note.textContent = 'A game code is eight letters and digits, like ABCD-EFGH. It is on the host\'s Players panel.'; return; }
    if (_joiningOnline) return;
    _joiningOnline = true;
    note.textContent = 'Joining…';
    try {
        const s = getSettings();
        await window.__wwOnline.join(code, { name: s.playerName, skin: s.skin, slot: 0, gamepack: mergedGamePackData });
    } catch (e) {
        _joiningOnline = false;
        // A public game that has gone or filled since the list was drawn: say so, and draw the list again.
        note.textContent = listed && e?.reason === 'code' ? 'That game has just ended.' : sessionWhy(e?.reason ?? 'unreachable');
        if (listed) refreshOnlineRooms();
        return;
    }
    _joiningOnline = false;
    closeLanJoin();
    _onlineGuest = true;
    startWorld(window.__wwOnline.world());
}

// ── Wiring ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const on = (id, fn, ev = 'click') => document.getElementById(id)?.addEventListener(ev, fn);
    on('titlePlayerBtn', () => pickName());
    on('nameNewBtn', () => _nameView('entry'));
    on('nameBackBtn', _nameCancel);
    on('nameCancelBtn', _nameCancel);
    on('nameDoneBtn', () => _nameDone(_nameCheck()));
    on('nameInput', () => {
        const input = document.getElementById('nameInput'), clean = input.value.replace(NAME_OK, '').slice(0, MAX_NAME);
        if (clean !== input.value) input.value = clean;
        _t9.key = null;
        _nameCheck();
    }, 'input');
    on('nameInput', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _nameDone(_nameCheck()); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _nameCancel(); }
    }, 'keydown');
    for (const key of document.querySelectorAll('.t9Key')) key.addEventListener('click', () => t9Press(key.dataset.k));

    on('pausePlayersBtn', openPlayers);
    on('playersBackBtn', closePlayers);
    on('lanOpenToggle', (e) => setLanOpen(e.target.checked), 'change');
    on('joinLanBtn', openLanJoin);
    on('lanJoinCloseBtn', backFromJoin);
    on('joinLanWayBtn', () => _showJoin('lan'));
    on('joinOnlineWayBtn', () => _showJoin('online'));
    on('onlineRoomsRefresh', refreshOnlineRooms);
    on('onlineJoinGoBtn', () => joinOnline(document.getElementById('onlineJoinCode').value));
    on('onlineJoinCode', (e) => { if (e.key === 'Enter') joinOnline(e.target.value); }, 'keydown');
    on('onlineVisibility', () => _refreshPlayers(), 'change');
    on('onlineOpenToggle', (e) => setOnlineOpen(e.target.checked), 'change');
    on('guestOverBtn', () => {
        // Back to this player's own game, if the page round this one is theirs; else try the host again.
        if (window.parent !== window) window.parent.postMessage({ type: 'ww_leaveLan' }, '*');
        else location.reload();
    });
}, { once: true });
