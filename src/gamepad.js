/*
 * Controller support (the browser's Gamepad API; the standard layout: Xbox,
 * PlayStation, Switch Pro and the like).
 *
 * A classic script loaded after main.js, whose state it shares (paused,
 * _menuOpen, gameStarted, the menu functions). It does two jobs, and which one
 * depends only on whether the game is being played or a menu is up:
 *
 *   • In play it publishes what the sticks and buttons ask for in
 *     window.__wwPad. world.js reads that each tick beside the keyboard and
 *     the mouse: the left stick moves (as far as it is pushed), the right one
 *     turns the camera at a rate, the triggers are the two mouse buttons.
 *   • In a menu it moves a focus ring (.padFocus) from control to control by
 *     where they are on screen, presses the one it is on, and knows what
 *     "back" means on each screen. No screen had to be written for it: it
 *     finds the controls of whatever is on top.
 *
 * The game normally plays only while the pointer is locked to it, and a page
 * may lock the pointer only in answer to a click or a key — which a controller
 * button is not. So while the controller is the device in use (`active`: the
 * last input came from it), play does not wait for the lock: world.js takes
 * `__wwPad.play` as leave to run the controls, and pausing and resuming from
 * the controller set `paused` themselves instead of leaving it to the lock.
 * Touch the mouse or a key and the controller steps back until its next input.
 *
 * Nothing runs unless a controller is connected: the frame loop starts on
 * `gamepadconnected` and stops when the last one goes.
 */
(() => {
    'use strict';

    // Button numbers of the standard layout.
    const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, START = 9, L3 = 10;
    const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

    const DEAD         = 0.2;    // a stick this near its centre is at rest
    const NAV_PUSH     = 0.6;    // how far the left stick goes to count as a direction in a menu
    const TRIGGER      = 0.35;   // how far a trigger goes to count as held
    const REPEAT_FIRST = 380;    // ms before a held direction repeats in a menu…
    const REPEAT_NEXT  = 120;    // …and between repeats

    // What the game reads. `active`: the controller is the device in use.
    // `play`: it is driving the game right now (so no pointer lock is needed).
    const pad = window.__wwPad = {
        active: false, play: false,
        moveF: 0, moveR: 0,          // forward and right, −1 … 1
        lookX: 0, lookY: 0,          // turn rate right and down, −1 … 1
        jump: false, sneak: false, sprint: false,
        breakHeld: false, useHeld: false,
    };

    let running = false;
    let prev = [];                   // which buttons were down last frame
    let sprintOn = false;            // L3 toggles it; letting the stick go ends it
    let focus = null, scopeEl = null;
    let settled = false;             // the player has moved the ring since this screen came up
    let navDir = 0, navAt = 0;       // the direction being held in a menu, and when it next repeats

    // ── Which device is in use ───────────────────────────────────────────────

    function setActive(on) {
        if (pad.active === on) return;
        pad.active = on;
        document.body.classList.toggle('usingPad', on);
        scopeEl = null;                      // look for something to focus afresh
        if (!on) { setFocus(null); release(); }
    }
    function release() {
        pad.play = false;
        pad.moveF = pad.moveR = pad.lookX = pad.lookY = 0;
        pad.jump = pad.sneak = pad.sprint = pad.breakHeld = pad.useHeld = false;
        sprintOn = false;
    }
    window.addEventListener('mousemove', (e) => {
        if (pad.active && Math.abs(e.movementX) + Math.abs(e.movementY) > 3) setActive(false);
    });
    window.addEventListener('mousedown', () => setActive(false));
    window.addEventListener('keydown',   () => setActive(false));

    // ── Connecting ───────────────────────────────────────────────────────────

    function current() {
        const list = navigator.getGamepads ? navigator.getGamepads() : [];
        let any = null;
        for (const gp of list) {
            if (!gp || !gp.connected) continue;
            if (gp.mapping === 'standard') return gp;
            any ??= gp;
        }
        return any;
    }

    let noticeTimer = 0;
    function notice(text) {
        const el = document.getElementById('padNotice');
        if (!el) return;
        el.textContent = text;
        el.classList.add('show');
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => el.classList.remove('show'), 2600);
    }

    window.addEventListener('gamepadconnected', () => {
        notice('Controller connected');
        if (!running) { running = true; prev = []; requestAnimationFrame(frame); }
    });
    window.addEventListener('gamepaddisconnected', () => {
        if (!current()) { notice('Controller disconnected'); setActive(false); }
    });

    // ── Reading it ───────────────────────────────────────────────────────────

    /** A stick's two axes, with the dead zone taken out of the middle: [x, y, how far]. */
    function stick(x = 0, y = 0) {
        const m = Math.hypot(x, y);
        if (m < DEAD) return [0, 0, 0];
        const k = Math.min(1, (m - DEAD) / (1 - DEAD));
        return [x / m * k, y / m * k, k];
    }

    function frame(now) {
        const gp = current();
        if (!gp) { running = false; release(); return; }
        requestAnimationFrame(frame);

        const down = (i) => { const b = gp.buttons[i]; return !!b && (b.pressed || b.value > 0.5); };
        const held = (i) => { const b = gp.buttons[i]; return !!b && (b.pressed || b.value > TRIGGER); };
        const hit  = (i) => down(i) && !prev[i];

        // Any real input makes the controller the device in use.
        if (!pad.active) {
            let used = Math.abs(gp.axes[0] ?? 0) > 0.5 || Math.abs(gp.axes[1] ?? 0) > 0.5 ||
                       Math.abs(gp.axes[2] ?? 0) > 0.5 || Math.abs(gp.axes[3] ?? 0) > 0.5;
            for (let i = 0; i < gp.buttons.length && !used; i++) used = down(i);
            if (used) setActive(true);
        }

        if (pad.active) {
            const playing = gameStarted && !paused && !_menuOpen && !_loadingActive &&
                !!DOM.deathScreen?.classList.contains('hidden');
            if (playing) play(gp, down, held, hit);
            else { release(); menu(gp, down, hit, now); }
        }
        for (let i = 0; i < gp.buttons.length; i++) prev[i] = down(i);
    }

    // ── In play ──────────────────────────────────────────────────────────────

    function play(gp, down, held, hit) {
        if (focus) setFocus(null);
        scopeEl = null;

        const [mx, my, mm] = stick(gp.axes[0], gp.axes[1]);
        const [lx, ly, lm] = stick(gp.axes[2], gp.axes[3]);
        pad.moveR = mx;
        pad.moveF = -my;
        // Squared: fine aim near the middle, a quick turn at the rim.
        pad.lookX = lx * lm;
        pad.lookY = ly * lm;

        if (hit(L3)) sprintOn = !sprintOn;
        if (mm < 0.25) sprintOn = false;
        pad.sprint = sprintOn;
        pad.jump   = down(A);
        pad.sneak  = down(B);
        pad.breakHeld = held(RT);
        pad.useHeld   = held(LT);
        pad.play = true;

        if (hit(RB) || hit(RIGHT)) window.dispatchEvent(new CustomEvent('ww_padHotbar', { detail: { step: 1 } }));
        if (hit(LB) || hit(LEFT))  window.dispatchEvent(new CustomEvent('ww_padHotbar', { detail: { step: -1 } }));
        if (hit(Y)) { release(); window.dispatchEvent(new CustomEvent('ww_toggleInventory')); }
        if (hit(X)) { release(); window.dispatchEvent(new CustomEvent('ww_toggleCraftMenu', { detail: {} })); }
        if (hit(START)) pauseGame();
    }

    function pauseGame() {
        release();
        paused = true;
        if (document.pointerLockElement) document.exitPointerLock();
    }
    function resume() {
        paused = false;         // no pointer lock to wait for: see the top of the file
    }

    // ── In a menu ────────────────────────────────────────────────────────────

    // The screens, topmost first, and what "back" does on each.
    const click = (sel) => () => document.querySelector(sel)?.click();
    const SCOPES = [
        ['#confirmPopup',           click('#confirmNo')],
        ['#HowToPlayScreen',        click('#howToBackBtn')],
        ['#SettingsScreen',         click('#settingsBackBtn')],
        ['#WorldSettingsModal',     click('#worldSettingsDoneBtn')],
        ['#CreateWorldModal',       click('#createWorldCancelBtn')],
        ['#WorldDetailModal',       click('#worldDetailCloseBtn')],
        ['#InventoryScreen',        () => closeInventory()],
        ['#InteractivePanel',       () => closeInteractivePanel()],
        ['#CreativeInventoryPanel', () => closeCreativeInventory()],
        ['#PauseScreen',            resume],
        ['#DeathScreen',            null],
        ['#WorldListScreen',        click('#worldListBackBtn')],
        ['#TitleScreen',            null],
    ];
    const FOCUSABLE = '.menuButton, .segBtn, .settingsTab, .settingsToggle, .settingsSlider, ' +
        'select.settingsSelect:not(.seg), .invGridSlot, .recipeListItem, .worldFormInput';

    const shown = (el) => !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0;

    function topScope() {
        for (const [sel, back] of SCOPES) {
            const el = document.querySelector(sel);
            if (shown(el)) return { el, back };
        }
        return null;
    }
    function focusables(el) {
        return [...el.querySelectorAll(FOCUSABLE)].filter(e => e.getClientRects().length > 0 && !e.classList.contains('cannot'));
    }
    function firstFocus(el) {
        const list = focusables(el);
        const pick = (sel) => list.find(e => e.matches(sel));
        return (el.id === 'SettingsScreen'  && pick('.settingsTab.active')) ||
               (el.id === 'WorldListScreen' && pick('.worldCard [data-act="play"]')) ||
               (el.id === 'InventoryScreen' && pick('.invGridSlot[data-slot-type="hotbar"]')) ||
               (el.id === 'InventoryScreen' && pick('.invGridSlot')) ||
               pick('.menuButton.primary') || pick('.invGridSlot') || pick('.recipeListItem') || list[0] || null;
    }

    function setFocus(el) {
        if (focus === el) return;
        focus?.classList.remove('padFocus');
        focus = el;
        if (!el) return;
        el.classList.add('padFocus');
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        carry();
    }
    /** An item picked up in the inventory rides on the slot the ring is on. */
    function carry() {
        if (!focus?.classList.contains('invGridSlot') || typeof _moveCursor !== 'function') return;
        const r = focus.getBoundingClientRect();
        _moveCursor({ clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 });
    }
    /** The same control after the screen was drawn again (the inventory rebuilds its slots on every change). */
    function again(old, el) {
        const d = old.dataset;
        if (d?.slotType != null) return el.querySelector(`.invGridSlot[data-slot-type="${d.slotType}"][data-slot-index="${d.slotIndex}"]`);
        if (old.id) return document.getElementById(old.id);
        return null;
    }

    const span = (a0, a1, b0, b1) => b0 > a1 ? b0 - a1 : a0 > b1 ? a0 - b1 : 0;   // gap between two stretches

    /** The control nearest the focused one in a direction: 1 up, 2 down, 3 left, 4 right. */
    function toward(dir, el) {
        const a = focus.getBoundingClientRect();
        const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
        let best = null, bestScore = Infinity;
        for (const e of focusables(el)) {
            if (e === focus) continue;
            const r = e.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            let along, off;
            if (dir === 1)      { if (cy >= ay - 1) continue; along = Math.max(0, a.top - r.bottom);  off = span(a.left, a.right, r.left, r.right); }
            else if (dir === 2) { if (cy <= ay + 1) continue; along = Math.max(0, r.top - a.bottom);  off = span(a.left, a.right, r.left, r.right); }
            else if (dir === 3) { if (cx >= ax - 1) continue; along = Math.max(0, a.left - r.right);  off = span(a.top, a.bottom, r.top, r.bottom); }
            else                { if (cx <= ax + 1) continue; along = Math.max(0, r.left - a.right);  off = span(a.top, a.bottom, r.top, r.bottom); }
            // Mostly "straight on": something off to the side has to be a good deal nearer to win.
            const score = along + off * 3 + (Math.abs(cx - ax) + Math.abs(cy - ay)) * 0.02;
            if (score < bestScore) { bestScore = score; best = e; }
        }
        return best;
    }

    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

    /** Left or right on a slider or a list: change it. False if the control is neither. */
    function nudge(el, step) {
        if (el.matches('.settingsSlider')) {
            const n = Math.max(1, Math.round((Number(el.max) - Number(el.min)) / (Number(el.step) || 1) / 25));
            if (step > 0) el.stepUp(n); else el.stepDown(n);
            fire(el, 'input'); fire(el, 'change');
            return true;
        }
        if (el.matches('select')) {
            const i = el.selectedIndex + step;
            if (i >= 0 && i < el.options.length) { el.selectedIndex = i; fire(el, 'input'); fire(el, 'change'); }
            return true;
        }
        return false;
    }

    function press(el) {
        if (el.matches('.settingsToggle')) el.querySelector('input')?.click();
        else if (el.matches('.settingsSlider, select')) return;          // left and right change these
        else if (el.matches('.worldFormInput')) el.focus();
        else el.click();
    }

    function menu(gp, down, hit, now) {
        const scope = topScope();
        if (!scope) { setFocus(null); scopeEl = null; return; }
        if (scope.el !== scopeEl) { scopeEl = scope.el; settled = false; setFocus(firstFocus(scope.el)); }
        // Until the player moves it the ring keeps to the best place to start,
        // which can change after the screen comes up (the world list fills in
        // when the server answers).
        else if (!settled) setFocus(firstFocus(scope.el));
        if (focus && (!focus.isConnected || focus.getClientRects().length === 0)) {
            const old = focus;
            focus = null;
            setFocus(again(old, scope.el) ?? firstFocus(scope.el));
        }

        // A direction, from the D-pad or the left stick; held, it repeats.
        const sx = gp.axes[0] ?? 0, sy = gp.axes[1] ?? 0;
        const dir = down(UP) || sy < -NAV_PUSH ? 1 : down(DOWN) || sy > NAV_PUSH ? 2
                  : down(LEFT) || sx < -NAV_PUSH ? 3 : down(RIGHT) || sx > NAV_PUSH ? 4 : 0;
        let go = 0;
        if (dir !== navDir) { navDir = dir; navAt = now + REPEAT_FIRST; go = dir; }
        else if (dir !== 0 && now >= navAt) { navAt = now + REPEAT_NEXT; go = dir; }
        if (go !== 0) {
            settled = true;
            if (!focus) setFocus(firstFocus(scope.el));
            else if (!(go >= 3 && nudge(focus, go === 4 ? 1 : -1))) {
                const next = toward(go, scope.el);
                if (next) setFocus(next);
            }
        }

        if (hit(A) && focus) { settled = true; press(focus); carry(); }
        else if (hit(B) && scope.back) scope.back();
        else if (hit(X) && focus?.classList.contains('invGridSlot')) {
            // The right mouse button on a slot: take half, or put one down.
            focus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        }
        else if (hit(Y) && scope.el.id === 'InventoryScreen') closeInventory();
        else if (hit(START) && gameStarted) {
            if (_menuOpen) closeAnyMenu();
            else if (scope.el.id === 'PauseScreen') resume();
            else if (scope.back) scope.back();
        }
        else if ((hit(LB) || hit(RB)) && scope.el.id === 'SettingsScreen') {
            // The shoulder buttons step through the sections.
            const tabs = [...scope.el.querySelectorAll('.settingsTab')].filter(t => t.getClientRects().length > 0);
            const i = tabs.findIndex(t => t.classList.contains('active'));
            const t = tabs[(i + (hit(RB) ? 1 : tabs.length - 1)) % tabs.length];
            if (t) { t.click(); setFocus(t); }
        }
    }

    // A controller that was already in use when the page loaded shows up on
    // its next button press (the browser announces it then), so nothing more
    // is needed here.
})();
