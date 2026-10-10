/*
 * The page round the game: one 16:9 stage, with the game in it.
 *
 * Usually that is one frame, game.html. This script is what makes it more:
 *
 *   • Split screen. Each further player gets a frame of their own beside the
 *     first — a whole second copy of the game, bound to that player's
 *     controller (`?pane=…&pad=…`) and joined to the first one's world as its
 *     own player (src/players.js). Two players stand side by side, each
 *     frame half the width; three or four take a quarter each, which is 16:9
 *     again. The game lays itself out in fractions of its own frame's width,
 *     so it fits any of them without knowing.
 *   • Someone else's game. Joining a game on the network swaps the frame for
 *     the host's copy of the game (the host's server serves it to its
 *     guests), and leaving swaps it back.
 *
 * The frames are the same origin as this page, so the first one's game
 * reaches the manager directly (`window.parent.__wwSplit`); the host's game,
 * which is not, asks by message.
 */
(() => {
    'use strict';
    const stage = document.getElementById('stage');
    const main = document.getElementById('mainFrame');
    const ALLOW = 'gamepad; fullscreen; autoplay';
    const HOME = main.getAttribute('src');
    const MAX = 4;
    const LEAVE_MS = 400;        // what a leaving pane is given to send off its player's state

    // The panes after the first: { id, frame, pad, name }.
    const panes = [];
    let nextId = 1;

    function layout() {
        stage.className = `panes-${1 + panes.length}`;
        // Each game sizes its picture when its window changes size, and is told
        // how many it shares the screen with (it keeps its graphics light then).
        const sharing = 1 + panes.filter(p => !p.going).length;
        for (const f of [main, ...panes.map(p => p.frame)]) {
            try {
                f.contentWindow?.dispatchEvent(new Event('resize'));
                f.contentWindow?.__wwSplitCount?.(sharing);
            } catch { /* another origin */ }
        }
    }
    function drop(p) {
        p.frame.remove();
        panes.splice(panes.indexOf(p), 1);
    }

    window.__wwSplit = {
        max: MAX,
        /** How many are playing on this screen, the first included. */
        count: () => 1 + panes.filter(p => !p.going).length,
        padTaken: (i) => panes.some(p => p.pad === i && !p.going),
        names: () => panes.filter(p => !p.going).map(p => p.name).filter(Boolean),

        /**
         * Another player, on controller `pad`, into world `worldId`. `taken`: the names in use.
         * `online`: the code of the online room the first player's game is in, if it is in one —
         * the new player joins that, as a further player of this machine (`slot`).
         */
        add(pad, worldId, taken = [], online = '') {
            if (this.count() >= MAX || this.padTaken(pad)) return 0;
            const id = nextId++;
            // The lowest of slots 1–3 that no pane has: a pane's id only ever goes up, a slot is used again.
            let slot = 1;
            while (panes.some(p => p.slot === slot && !p.going)) slot++;
            const frame = document.createElement('iframe');
            frame.className = 'pane';
            frame.allow = ALLOW;
            frame.src = `game.html?pane=${id}&pad=${pad}&world=${encodeURIComponent(worldId)}` +
                        `&taken=${encodeURIComponent(taken.join('|'))}&of=${2 + panes.length}&slot=${slot}` +
                        (online ? `&online=${encodeURIComponent(online)}` : '');
            stage.appendChild(frame);
            panes.push({ id, frame, pad, slot, name: null });
            layout();
            requestAnimationFrame(layout);
            return id;
        },
        /** Pane `id` has said who is playing in it. */
        named(id, name) {
            const p = panes.find(q => q.id === id);
            if (p) p.name = name;
        },
        /** Pane `id` has left (or never came in). */
        close(id) {
            const p = panes.find(q => q.id === id);
            if (!p || p.going) return;
            p.going = true;
            layout();                 // the others get their view back at once
            // Not from inside its own call — the frame asking is the one going —
            // and not before what it has just sent to be saved is on its way.
            setTimeout(() => { if (panes.includes(p)) { drop(p); layout(); requestAnimationFrame(layout); main.focus(); } }, LEAVE_MS);
        },
        /** The first player has left the world: the others were in it, and leave it too. */
        closeAll() {
            for (const p of panes) {
                if (p.going) continue;
                try { p.frame.contentWindow.leaveWorld?.(true); } catch { /* not loaded yet */ }
                this.close(p.id);
            }
        },
    };

    // The host's game is another origin: it asks by message, and only the first frame is listened to.
    window.addEventListener('message', (e) => {
        if (e.source !== main.contentWindow || !e.data || typeof e.data !== 'object') return;
        if (e.data.type === 'ww_joinLan' && /^http:\/\/[A-Za-z0-9.\-]+:\d{1,5}$/.test(e.data.url ?? '')) {
            for (const p of [...panes]) drop(p);
            layout();
            // The guest brings their own settings — name, look, controls — with them.
            const carry = e.data.me ? `#me=${encodeURIComponent(JSON.stringify(e.data.me))}` : '';
            main.src = `${e.data.url}/game.html${carry}`;
        } else if (e.data.type === 'ww_leaveLan') {
            main.src = HOME;
        }
    });

    // Keys go to the first player's game.
    const focusGame = () => { if (document.activeElement === document.body) main.focus(); };
    window.addEventListener('focus', focusGame);
    document.addEventListener('focus', focusGame);
    layout();
})();
