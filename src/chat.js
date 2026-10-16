/* =========================================================
   CHAT
   What the players say to each other, and the commands (a line beginning
   with "/"). T opens it — or "/", with the slash already typed — Enter says
   the line and closes it, Esc closes it. world.js carries what is said to the
   others and runs the commands (`window.__wwChat`; engine/Commands.js); this
   is only the box and the list of lines.

   A line is shown as "(Name) what they said", the name in bold; what the game
   itself says (someone joined, what came of a command) has no name and is in
   gold. Lines stay for a few seconds and then fade, and are all there again
   while the box is open. Everything shown is put in as text, never as markup.

   It is a menu as far as the pointer goes (`_menuOpen`, main.js): the game
   plays on behind it, and closing it takes the pointer back.
========================================================= */

const CHAT_KEEP    = 120;      // lines kept in the list
const CHAT_SHOW_MS = 10000;    // how long a new line stays up with the box shut
const CHAT_HISTORY = 40;       // lines of one's own that Up brings back

let _chatOpen = false;
const _chatSaid = [];          // what this player sent, oldest first
let _chatAt = -1;              // which of them Up / Down is showing (-1: none)
let _chatDraft = '';

const _chatEl = (id) => document.getElementById(id);

/** Add a line: { kind: 'say', name, text } from a player, { kind: 'sys', text } from the game, { kind: 'clear' }. */
function addChatLine(line) {
    const log = _chatEl('chatLog');
    if (!log || !line) return;
    if (line.kind === 'clear') { log.textContent = ''; return; }
    const text = String(line.text ?? '').slice(0, 400);
    if (!text) return;
    const row = document.createElement('div');
    row.className = line.kind === 'sys' ? 'chatLine sys' : 'chatLine';
    if (line.kind !== 'sys') {
        const who = document.createElement('strong');
        who.append(`(${String(line.name ?? 'Player').slice(0, 24)}`);
        // Two players of one name: the later has a number after it, in grey.
        if (line.dup) { const n = document.createElement('span'); n.className = 'dupTag'; n.textContent = ` #${line.dup | 0}`; who.append(n); }
        who.append(')');
        row.append(who, ' ');
    }
    row.append(text);
    log.appendChild(row);
    while (log.children.length > CHAT_KEEP) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    setTimeout(() => row.classList.add('old'), CHAT_SHOW_MS);
}
window.addEventListener('ww_chat', (e) => addChatLine(e.detail));

function openChat(begin = '') {
    const bar = _chatEl('chatBar'), input = _chatEl('chatInput');
    if (!bar || !input || _chatOpen || !gameStarted || _menuOpen || paused || _dead || _loadingActive) return;
    _chatOpen = true;
    _menuOpen = true;          // before the pointer is let go, so that letting it go is not a pause
    if (document.pointerLockElement) document.exitPointerLock();
    _chatEl('chat').classList.add('open');
    bar.classList.remove('hidden');
    input.value = begin;
    _chatAt = -1;
    input.focus();
    input.setSelectionRange(begin.length, begin.length);
    const log = _chatEl('chatLog');
    log.scrollTop = log.scrollHeight;
}

/** Put the box away. `lock`: take the pointer back (not on Esc going down: main.js does that when the key is up). */
function closeChat(lock = true) {
    if (!_chatOpen) return;
    _chatOpen = false;
    _chatEl('chat')?.classList.remove('open');
    _chatEl('chatBar')?.classList.add('hidden');
    _chatEl('chatInput')?.blur();
    const log = _chatEl('chatLog');
    if (log) log.scrollTop = log.scrollHeight;
    _menuOpen = false;
    if (lock) requestGameLock();
}

function _chatSubmit() {
    const input = _chatEl('chatInput');
    const text = input.value.trim();
    if (text) {
        if (_chatSaid[_chatSaid.length - 1] !== text) _chatSaid.push(text);
        if (_chatSaid.length > CHAT_HISTORY) _chatSaid.shift();
        if (window.__wwChat) window.__wwChat.send(text);
        else addChatLine({ kind: 'sys', text: 'There is no world to say it in.' });
    }
    closeChat();
}

// T, or / for a command — while playing, with nothing else up.
window.addEventListener('keydown', (e) => {
    if (_chatOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'KeyT' && e.code !== 'Slash') return;
    if (e.target?.closest?.('input, textarea, select')) return;
    if (!gameStarted || _menuOpen || paused || _dead) return;
    e.preventDefault();        // the key that opens the box is not typed into it
    openChat(e.code === 'Slash' ? '/' : '');
});

document.addEventListener('DOMContentLoaded', () => {
    const input = _chatEl('chatInput');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); _chatSubmit(); return; }
        // Up and Down: what was said before, and back to what was being typed.
        if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
            if (!_chatSaid.length) return;
            e.preventDefault();
            if (_chatAt < 0) { if (e.code === 'ArrowDown') return; _chatDraft = input.value; _chatAt = _chatSaid.length; }
            _chatAt += e.code === 'ArrowUp' ? -1 : 1;
            if (_chatAt < 0) _chatAt = 0;
            if (_chatAt >= _chatSaid.length) { _chatAt = -1; input.value = _chatDraft; }
            else input.value = _chatSaid[_chatAt];
            input.setSelectionRange(input.value.length, input.value.length);
        }
    });
    // Clicked away from: the box stays, and takes the keys back.
    input.addEventListener('blur', () => { if (_chatOpen) setTimeout(() => { if (_chatOpen) input.focus(); }, 0); });
});

// Dying puts every menu away; the death screen is then what is up (main.js keeps _menuOpen).
window.addEventListener('ww_playerDied', () => {
    if (!_chatOpen) return;
    _chatOpen = false;
    _chatEl('chat')?.classList.remove('open');
    _chatEl('chatBar')?.classList.add('hidden');
    _chatEl('chatInput')?.blur();
});
