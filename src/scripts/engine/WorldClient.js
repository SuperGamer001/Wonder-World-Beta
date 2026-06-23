/**
 * WorldClient
 *
 * Single persistent WebSocket connection to the save server.
 *
 * Chunks are now 16×640×16 columns addressed by (cx, cz) only — no cy.
 *
 * Text frames (JSON) — chunk load requests:
 *   Send: { type:'loadChunk', worldId, cx, cz }
 *
 * Binary frames — chunk load responses (from server):
 *   [cx:i32][cz:i32][has:u8]([palLen:u16][pal:u16*][idx:u8*CHUNK_VOLUME])
 *
 * Binary frames — batch chunk save (to server, opcode 0xC5):
 *   [0xC5:u8][worldIdLen:u16][worldId:utf8][count:u32]
 *   per chunk: [cx:i32][cz:i32][palLen:u16][pal:u16*][idx:u8*CHUNK_VOLUME]
 *
 * Usage:
 *   const client = new WorldClient('ws://localhost:3000');
 *   await client.connect();
 *   const saved = await client.loadChunk(id, cx, cz);   // null = not saved
 *   client.saveChunks(id, worldState);                   // fire-and-forget batch
 */

import { CHUNK_VOLUME } from './ChunkData.js';

export class WorldClient {
    constructor(wsUrl) {
        this._url             = wsUrl;
        this._ws              = null;
        this._ready           = false;
        this._pending         = new Map(); // "cx,cz" → resolve(chunkEntry|null)
        this._savedChunks     = null;      // Set<string> after manifest fetch
        this._manifestResolve = null;
    }

    /** Returns a Promise that resolves once the connection is open. */
    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this._url);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                this._ws    = ws;
                this._ready = true;
                resolve();
            };

            ws.onerror = () => {
                if (!this._ready) reject(new Error('WebSocket connection failed'));
            };

            ws.onclose = () => {
                this._ready = false;
            };

            ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this._handleBinary(event.data);
                } else if (typeof event.data === 'string') {
                    this._handleText(JSON.parse(event.data));
                }
            };
        });
    }

    get connected() { return this._ready; }

    // ── Chunk I/O ─────────────────────────────────────────────────────────────

    /**
     * Fetch the list of saved chunk keys for a world.
     * Must be called once after connect() before any loadChunk calls.
     */
    fetchManifest(worldId) {
        if (!this._ready) return Promise.resolve();
        return new Promise((resolve) => {
            this._manifestResolve = resolve;
            this._ws.send(JSON.stringify({ type: 'getManifest', worldId }));
        });
    }

    /**
     * Request a single chunk column from the server.
     * Returns { palette: number[], data: Uint8Array } or null if not saved.
     */
    loadChunk(worldId, cx, cz) {
        if (!this._ready) return Promise.resolve(null);
        const key = `${cx},${cz}`;
        if (this._savedChunks && !this._savedChunks.has(key)) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this._pending.set(key, resolve);
            this._ws.send(JSON.stringify({ type: 'loadChunk', worldId, cx, cz }));
        });
    }

    /**
     * Send all generated chunks in worldState to the server in one binary message.
     * Fire-and-forget — no acknowledgement is awaited.
     */
    saveChunks(worldId, worldState) {
        if (!this._ready) return;

        const encoder    = new TextEncoder();
        const worldIdBuf = encoder.encode(worldId);
        const wl         = worldIdBuf.length;

        const chunks = [];
        for (const chunk of worldState.chunks.values()) {
            if (chunk.generated) chunks.push(chunk);
        }
        if (chunks.length === 0) return;

        // Pre-calculate total size:
        // header: opcode(1) + worldIdLen(2) + worldId(wl) + count(4)
        // per chunk: cx(4) + cz(4) + palLen(2) + pal(palLen*2) + indices(CHUNK_VOLUME)
        let totalSize = 1 + 2 + wl + 4;
        for (const chunk of chunks) {
            totalSize += 4 + 4 + 2 + chunk._palette.length * 2 + CHUNK_VOLUME;
        }

        const buf  = new ArrayBuffer(totalSize);
        const dv   = new DataView(buf);
        const u8   = new Uint8Array(buf);
        let offset = 0;

        dv.setUint8(offset, 0xC5);                  offset += 1;
        dv.setUint16(offset, wl, true);              offset += 2;
        u8.set(worldIdBuf, offset);                  offset += wl;
        dv.setUint32(offset, chunks.length, true);   offset += 4;

        for (const chunk of chunks) {
            const pal = chunk._palette;
            const idx = chunk._indices;
            dv.setInt32(offset, chunk.cx, true);     offset += 4;
            dv.setInt32(offset, chunk.cz, true);     offset += 4;
            dv.setUint16(offset, pal.length, true);  offset += 2;
            for (const id of pal) {
                dv.setUint16(offset, id, true);      offset += 2;
            }
            u8.set(idx, offset);                     offset += CHUNK_VOLUME;
        }

        if (this._savedChunks) {
            for (const { cx, cz } of chunks) {
                this._savedChunks.add(`${cx},${cz}`);
            }
        }

        this._ws.send(buf);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _handleText(msg) {
        if (msg.type === 'manifest' && this._manifestResolve) {
            this._savedChunks = new Set(msg.chunks);
            this._manifestResolve();
            this._manifestResolve = null;
        }
    }

    _handleBinary(buf) {
        const dv  = new DataView(buf);
        const cx  = dv.getInt32(0, true);
        const cz  = dv.getInt32(4, true);
        const has = dv.getUint8(8);
        const key = `${cx},${cz}`;

        const resolve = this._pending.get(key);
        if (!resolve) return;
        this._pending.delete(key);

        if (!has) { resolve(null); return; }

        // Guard: if the buffer is too small to hold a valid palette header, the
        // response is from an old/mismatched server — fall back to generation.
        if (buf.byteLength < 11) { resolve(null); return; }

        const palLen  = dv.getUint16(9, true);
        const palette = [];
        for (let i = 0; i < palLen; i++) {
            palette.push(dv.getUint16(11 + i * 2, true));
        }
        const indexOffset = 11 + palLen * 2;

        // Guard: ensure the index block fits inside the received buffer. A mismatch
        // means the response is malformed (e.g. stale server format). Resolving null
        // lets _requestGenerate fall through to terrain generation rather than hanging
        // in _pendingGen forever.
        if (indexOffset + CHUNK_VOLUME > buf.byteLength) {
            console.warn(`[WorldClient] chunk ${key}: response too small (got ${buf.byteLength} bytes, need ${indexOffset + CHUNK_VOLUME}) — regenerating from terrain`);
            resolve(null);
            return;
        }

        const data = new Uint8Array(buf, indexOffset, CHUNK_VOLUME).slice();

        resolve({ palette, data });
    }
}
