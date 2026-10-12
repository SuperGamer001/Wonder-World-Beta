// A world exported to one file and imported again: everything in its folder
// comes back byte for byte, as a new world; and a file that is not a world,
// is cut short, or reaches outside a world's folder is refused by the scan
// and leaves nothing behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-file-'));
const WORLDS = path.join(process.env.WONDER_DATA_DIR, 'user', 'worlds');

const { serverReady } = await import('../server/server.js');
const { CHUNK_VOLUME } = await import('../src/scripts/engine/ChunkData.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
const worlds = async () => (await fetch(`${base}/api/worlds`)).json();

// ── A world with something in it ─────────────────────────────────────────────
const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Homestead', seed: 4242, gameMode: 'CREATIVE' }),
})).json();
const dir = path.join(WORLDS, world.id);

/** A region file as the server writes them: "WWR2", a count, then each chunk. */
function region(chunks) {
    const parts = [Buffer.from('WWR2', 'latin1'), Buffer.alloc(2)];
    parts[1].writeUInt16LE(chunks.length);
    for (const [lx, lz, salt] of chunks) {
        const palette = [0, 1, 3, 19, 40 + salt], head = Buffer.alloc(4 + palette.length * 2);
        head.writeUInt8(lx, 0); head.writeUInt8(lz, 1); head.writeUInt16LE(palette.length, 2);
        palette.forEach((p, i) => head.writeUInt16LE(p, 4 + i * 2));
        const indices = Buffer.alloc(CHUNK_VOLUME);
        for (let i = 0; i < CHUNK_VOLUME; i += 97) indices[i] = (i + salt) % palette.length;
        parts.push(head, indices);
    }
    return zlib.gzipSync(Buffer.concat(parts));
}
fs.mkdirSync(path.join(dir, 'regions'), { recursive: true });
fs.mkdirSync(path.join(dir, 'players'), { recursive: true });
fs.writeFileSync(path.join(dir, 'regions', '0,0.wwr'), region([[0, 0, 1], [1, 0, 2], [3, 7, 3]]));
fs.writeFileSync(path.join(dir, 'regions', '-1,2.wwr'), region([[5, 5, 4]]));
fs.writeFileSync(path.join(dir, 'player.json'), JSON.stringify({ pos: { x: 1.5, y: 70, z: -3 }, health: 17 }));
fs.writeFileSync(path.join(dir, 'players', 'guest_1.json'), JSON.stringify({ pos: { x: 9, y: 70, z: 9 } }));
fs.writeFileSync(path.join(dir, 'containers.json'), JSON.stringify({ '1,64,2': [{ id: 'torch', count: 3 }] }));
fs.writeFileSync(path.join(dir, 'screenshot.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(dir, 'notes.txt'), 'not part of a world');            // left behind: not a world's file

function tree(d, rel = '') {
    const out = {};
    for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) Object.assign(out, tree(d, p));
        else out[p] = fs.readFileSync(path.join(d, p));
    }
    return out;
}

// ── Export ───────────────────────────────────────────────────────────────────
const res = await fetch(`${base}/api/worlds/${world.id}/export`);
const file = Buffer.from(await res.arrayBuffer());
check('export answers with a file', res.ok && /attachment; filename="Homestead\.wwworld"/.test(res.headers.get('content-disposition') ?? ''),
    res.headers.get('content-disposition'));
check('the file is as long as it said', Number(res.headers.get('content-length')) === file.length, `${file.length} bytes`);
check('it begins as a world file', file.subarray(0, 6).toString('latin1') === 'WWEX1\n');
check('a world that is not there is not exported', (await fetch(`${base}/api/worlds/nope/export`)).status === 404);

// ── Scan ─────────────────────────────────────────────────────────────────────
const scan = await (await post('/api/worlds/import/scan', file)).json();
check('the scan says what world it is', scan.ok && scan.world.name === 'Homestead' && scan.world.seed === 4242 && scan.world.gameMode === 'CREATIVE', JSON.stringify(scan.world));
check('… and how much land is in it', scan.chunks === 4 && scan.regions === 2, `chunks=${scan.chunks} regions=${scan.regions}`);
check('scanning keeps nothing', (await worlds()).length === 1);

// ── Import ───────────────────────────────────────────────────────────────────
const done = await post('/api/worlds/import', file);
const got = await done.json();
check('import makes a new world', done.status === 201 && got.id && got.id !== world.id, got.id);
check('… under a name of its own', got.name === 'Homestead (Imported)', got.name);
check('… which is listed, first', (await worlds())[0]?.id === got.id);
check('… with the seed and the mode it had', got.seed === 4242 && got.gameMode === 'CREATIVE');
const a = tree(dir), b = tree(path.join(WORLDS, got.id));
delete a['notes.txt'];
const names = Object.keys(a).sort();
check('every file of the world came back', JSON.stringify(Object.keys(b).sort()) === JSON.stringify(names), Object.keys(b).sort().join(' '));
check('… byte for byte', names.filter(n => n !== 'world.json').every(n => b[n] && a[n].equals(b[n])));
check('what was not a world\'s file stayed behind', !('notes.txt' in b));
check('the first world is as it was', (await (await fetch(`${base}/api/worlds/${world.id}`)).json()).name === 'Homestead');

// A world nobody has played yet is its description and nothing else.
const bare = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Untouched', seed: 5 }),
})).json();
const bareFile = Buffer.from(await (await fetch(`${base}/api/worlds/${bare.id}/export`)).arrayBuffer());
const bareBack = await post('/api/worlds/import', bareFile);
check('a world never played exports and imports too', bareBack.status === 201 && (await bareBack.json()).seed === 5);

// ── What is refused ──────────────────────────────────────────────────────────
const count = (await worlds()).length;
async function refused(name, bytes) {
    const s = await post('/api/worlds/import/scan', bytes), i = await post('/api/worlds/import', bytes);
    const why = (await s.json()).error ?? '';
    check(`refused: ${name}`, s.status === 400 && i.status === 400 && why.length > 0, why);
}
/** The same file with its list of contents changed. */
function relist(change) {
    const len = file.readUInt32LE(6), header = JSON.parse(file.toString('utf8', 10, 10 + len));
    const body = change(header, file.subarray(10 + len)) ?? file.subarray(10 + len);
    const h = Buffer.from(JSON.stringify(header)), n = Buffer.alloc(4);
    n.writeUInt32LE(h.length);
    return Buffer.concat([Buffer.from('WWEX1\n', 'latin1'), n, h, body]);
}
await refused('something that is not a world file', Buffer.from('PK\x03\x04 this is a zip, or a photo, or anything'));
await refused('an empty file', Buffer.alloc(0));
await refused('a file cut short', file.subarray(0, file.length - 500));
await refused('a file with more on the end', Buffer.concat([file, Buffer.from('extra')]));
await refused('a path out of the world\'s folder', relist((h) => { h.files[0].path = '../../settings.json'; }));
await refused('a file that is no part of a world', relist((h) => { h.files[0].path = 'regions/evil.exe'; }));
await refused('no world.json', relist((h, body) => {
    const i = h.files.findIndex(f => f.path === 'world.json');
    let at = 0; for (let k = 0; k < i; k++) at += h.files[k].size;
    const size = h.files[i].size;
    h.files.splice(i, 1);
    return Buffer.concat([body.subarray(0, at), body.subarray(at + size)]);
}));
await refused('a region that will not open', relist((h, body) => {
    const i = h.files.findIndex(f => f.path.startsWith('regions/'));
    let at = 0; for (let k = 0; k < i; k++) at += h.files[k].size;
    const copy = Buffer.from(body);
    copy.fill(0x55, at, at + h.files[i].size);
    return copy;
}));
await refused('a world of another height', relist((h, body) => {
    const i = h.files.findIndex(f => f.path === 'world.json');
    let at = 0; for (let k = 0; k < i; k++) at += h.files[k].size;
    const meta = Buffer.from(JSON.stringify({ ...h.world, worldHeight: 256 }));
    const out = Buffer.concat([body.subarray(0, at), meta, body.subarray(at + h.files[i].size)]);
    h.files[i].size = meta.length;
    return out;
}));
await refused('a file from a newer game', relist((h) => { h.version = 99; }));
check('nothing refused left a world behind', (await worlds()).length === count && fs.readdirSync(WORLDS).length === count);

console.log(failures ? `\n${failures} FAILED` : '\nAll world-file checks passed.');
process.exit(failures ? 1 : 0);
