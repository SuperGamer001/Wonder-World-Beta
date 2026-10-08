/**
 * FarTerrain — low-detail land beyond the render distance.
 *
 * Past the last loaded chunk the world goes on as a heightfield: tiles of
 * FAR_CELLS × FAR_CELLS cells built in the workers (workers/FarTiles.js) from
 * the generator's geography, with no voxels, coloured like the surface the
 * chunks there would have, with their trees and buildings standing on it as
 * simple shapes in the nearer tiles. A tile's cell is `step` blocks, 4 for the
 * nearest tiles and doubling with each level of a quadtree further out, so
 * every tile costs the same to build and draw however much land it covers.
 *
 * Where a chunk is on screen the tile gives way to it. A small mask texture
 * (one texel per chunk, MASK × MASK around the player) says which chunks are
 * meshed: the far shader discards fragments inside them, and sinks the
 * vertices around them by SINK blocks, so between the last vertex outside and
 * the edge of the chunks the tile's surface dips under the terrain. That strip
 * is what closes the seam where far terrain comes out a little higher than
 * the chunk edge it meets (a valley narrower than a cell), which would
 * otherwise show the sky through a crack.
 *
 * A tile never leaves before the chunks that replace it are there. The tiles
 * cover the whole view, the loaded area included: each one is drawn until
 * every chunk over it is meshed, chunk by chunk through the mask, so land
 * that is still loading — ahead of a player flying faster than chunks arrive —
 * shows as far terrain instead of as a hole. (Tiles under loaded chunks used
 * to be dropped two chunks in from the load edge, loaded or not.) Tiles that
 * lie wholly under meshed chunks are not drawn, and those well inside are not
 * even built; the ones near the load edge are, so that they are ready when
 * the chunks over them unload.
 *
 * Tiles are swapped in as a set: until every tile a new selection needs is
 * built the old one stays up, so a moving player never sees a gap open while
 * tiles are on their way.
 *
 * What the player has built or dug shows too: world.js hands over a summary
 * of each changed chunk's surface (setEdit), tiles are built with the ones
 * that fall in them, and a tile is built again when one of its chunks changes.
 */

import * as THREE from 'three';
import { CHUNK_SIZE } from './engine/ChunkData.js';
import { FAR_CELLS } from './workers/FarTiles.js';

export const FAR_STEP0 = 4;                       // blocks per cell in the nearest tiles
export const FAR_TILE  = FAR_CELLS * FAR_STEP0;   // their size: 256 blocks
const LEVELS  = 5;          // tile sizes 256 … 4096
const SPLIT   = 1.0;        // a tile splits while the player is nearer it than its size
export const MASK = 64;     // chunks per side of the meshed-chunk mask
export const SINK = 32;     // blocks the surface dips under shown chunks
const LEAD    = 3;          // chunks in from the load edge within which tiles are kept built
const PRIORITY = 2.5;       // behind chunk generation (2): chunks always come first
const CACHE_MIN = 24;       // tiles kept beyond the ones in use, before the oldest go

/**
 * The tiles covering the view of a player at (px, pz): a quadtree over the
 * square of half-size `outer` around it, refined while the player is closer to
 * a tile than SPLIT × its size. The loaded chunks are not left out: which of
 * these tiles need building and drawing is decided as chunks come and go
 * (FarTerrain._needed, _covered).
 * Returns [{ key, level, x0, z0, step, size, d }].
 */
export function selectFarTiles(px, pz, outer, out = []) {
    out.length = 0;
    const top = LEVELS - 1;
    const S = FAR_TILE << top;
    const tx0 = Math.floor((px - outer) / S), tx1 = Math.floor((px + outer) / S);
    const tz0 = Math.floor((pz - outer) / S), tz1 = Math.floor((pz + outer) / S);
    const visit = (level, tx, tz) => {
        const size = FAR_TILE << level;
        const x0 = tx * size, z0 = tz * size, x1 = x0 + size, z1 = z0 + size;
        if (x1 <= px - outer || x0 >= px + outer || z1 <= pz - outer || z0 >= pz + outer) return;
        const dx = Math.max(x0 - px, 0, px - x1), dz = Math.max(z0 - pz, 0, pz - z1);
        const d = Math.max(dx, dz);
        if (level > 0 && d < SPLIT * size) {
            for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) visit(level - 1, tx * 2 + i, tz * 2 + j);
            return;
        }
        out.push({ key: `${level},${tx},${tz}`, level, x0, z0, step: FAR_STEP0 << level, size, d });
    };
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) visit(top, tx, tz);
    return out;
}

export class FarTerrain {
    /**
     * @param scene
     * @param pool          the world's WorkerPool (its workers have a generator)
     * @param makeMaterial  (uniforms) => ShaderMaterial for the tiles; given
     *                      this module's uniforms (the mask) to spread in
     */
    constructor(scene, pool, makeMaterial) {
        this.scene = scene;
        this.pool = pool;
        this.extra = 0;               // chunks of far terrain beyond the render distance; 0 = off
        this.group = new THREE.Group();
        this.group.name = 'farTerrain';
        scene.add(this.group);

        this._maskData = new Uint8Array(MASK * MASK);
        this.mask = new THREE.DataTexture(this._maskData, MASK, MASK, THREE.RedFormat, THREE.UnsignedByteType);
        this.mask.minFilter = this.mask.magFilter = THREE.NearestFilter;
        this.mask.generateMipmaps = false;
        this.mask.needsUpdate = true;
        this.uniforms = {
            uFarMask:       { value: this.mask },
            uFarMaskOrigin: { value: new THREE.Vector2(0, 0) },
            uFarSink:       { value: SINK },
        };
        this.material = makeMaterial(this.uniforms);

        this._tiles = new Map();      // key → { mesh, used, stale, t }
        this._inflight = new Map();   // key → the tile being built
        this._restale = new Set();    // tiles whose chunks changed while they were being built
        this._arrived = false;        // a tile was installed since the last _show()
        this._shown = new Set();      // keys on screen now
        this._want = [];              // the current selection
        this._wantKey = '';
        this._check = false;          // something changed: look at the selection again
        this._swapDue = false;        // the selection changed and is not on screen yet
        this._maskDirty = true;
        this._maskOx = NaN; this._maskOz = NaN;
        this._inner = [0, 0, -1, -1]; // chunks well inside the loaded area: [cx0, cz0, cx1, cz1]
        this._edits = new Map();      // "cx,cz" → { cx, cz, heights, ids }: changed chunks' surfaces
        this._frame = 0;
        this._maxInflight = Math.max(1, Math.min(3, (pool.workerCount ?? 2) - 1));
        this._disposed = false;
        this.built = 0;               // tiles built so far (stats)
        this._needCount = 0;
    }

    get active() { return this.extra > 0 && !this._disposed; }

    /** Far terrain reaches `extra` chunks past the render distance (0: off). */
    setDistance(extra) {
        this.extra = Math.max(0, extra | 0);
        this.group.visible = this.extra > 0;
        if (this.extra === 0) this._clear();
        this._wantKey = '';
    }

    /** Some chunk's mesh came or went: the mask needs redrawing. */
    chunksChanged() { this._maskDirty = true; }

    /**
     * The surface of a chunk the player has changed, as far terrain is to
     * show it: `heights` (Int16Array(256): the world Y of each column's
     * highest block, column lx + lz·16) and `ids` (Uint16Array(256): that
     * block). Tiles it falls in are built again.
     */
    setEdit(cx, cz, heights, ids) {
        this._edits.set(cx + ',' + cz, { cx, cz, heights, ids });
        const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
        // A tile samples one step past its edges.
        const hit = (t) => x0 + CHUNK_SIZE > t.x0 - t.step && x0 <= t.x0 + t.size + t.step &&
                           z0 + CHUNK_SIZE > t.z0 - t.step && z0 <= t.z0 + t.size + t.step;
        for (const tile of this._tiles.values()) if (hit(tile.t)) tile.stale = true;
        for (const [key, t] of this._inflight) if (hit(t)) this._restale.add(key);
        this._check = true;
    }

    /** The changed chunks' surfaces that tile `t` samples. */
    _editsFor(t) {
        if (this._edits.size === 0) return undefined;
        const out = [], r = t.step;
        for (const e of this._edits.values()) {
            const x0 = e.cx * CHUNK_SIZE, z0 = e.cz * CHUNK_SIZE;
            if (x0 + CHUNK_SIZE > t.x0 - r && x0 <= t.x0 + t.size + r && z0 + CHUNK_SIZE > t.z0 - r && z0 <= t.z0 + t.size + r) out.push(e);
        }
        return out.length ? out : undefined;
    }

    /**
     * Once a frame, before the render. `meshes` is world.js's chunkMeshes map
     * (entries carry cx, cz); `renderDist` in chunks. `loading`: the loading
     * screen is up — the land around the player is about to arrive as chunks,
     * so tiles under it are not worth building.
     */
    update(px, pz, renderDist, meshes, loading = false) {
        if (!this.active) return;
        this._frame++;
        const pcx = Math.floor(px / CHUNK_SIZE), pcz = Math.floor(pz / CHUNK_SIZE);
        if (this._updateMask(pcx, pcz, meshes)) this._check = true;

        // The selection only changes when the player crosses a chunk; build
        // it at chunk resolution so it does not churn every frame.
        const key = `${pcx},${pcz},${renderDist},${this.extra}`;
        if (key !== this._wantKey) {
            this._wantKey = key;
            const cx = (pcx + 0.5) * CHUNK_SIZE, cz = (pcz + 0.5) * CHUNK_SIZE;
            const outer = (renderDist + this.extra + 1) * CHUNK_SIZE;
            this._want = selectFarTiles(cx, cz, outer).sort((a, b) => a.d - b.d);
            const r = renderDist - LEAD;
            this._inner = [pcx - r, pcz - r, pcx + r, pcz + r];
            this._swapDue = true;
            this._check = true;
        }
        if (loading !== this._loading) { this._loading = loading; this._check = true; }
        if (!this._check && this._inflight.size === 0) return;
        this._check = false;

        let ready = true, need = 0;
        for (const t of this._want) {
            const tile = this._tiles.get(t.key);
            if (tile) {
                tile.used = this._frame;
                // A changed chunk in it: build it again, behind the scenes.
                if (tile.stale && !this._inflight.has(t.key) && this._inflight.size < this._maxInflight) this._request(t);
                need++;
                continue;
            }
            if (!this._needed(t)) continue;
            need++;
            ready = false;
            if (!this._inflight.has(t.key) && this._inflight.size < this._maxInflight) this._request(t);
        }
        this._needCount = need;
        if (ready && (this._swapDue || this._arrived)) { this._show(); this._swapDue = false; }
        this._hideCovered();
        if (!ready) this._check = true;
    }

    /** Tile `t`'s span in chunks. */
    _span(t) {
        return [t.x0 / CHUNK_SIZE, t.z0 / CHUNK_SIZE, (t.x0 + t.size) / CHUNK_SIZE - 1, (t.z0 + t.size) / CHUNK_SIZE - 1];
    }

    /** Is every chunk over tile `t` meshed (so that none of it would be drawn)? */
    _covered(t) {
        const [cx0, cz0, cx1, cz1] = this._span(t);
        const ox = this._maskOx, oz = this._maskOz;
        if (cx0 < ox || cz0 < oz || cx1 >= ox + MASK || cz1 >= oz + MASK) return false;
        const d = this._maskData;
        for (let cz = cz0; cz <= cz1; cz++) {
            const row = (cz - oz) * MASK - ox;
            for (let cx = cx0; cx <= cx1; cx++) if (d[row + cx] === 0) return false;
        }
        return true;
    }

    /**
     * Does tile `t` have to be built? Not if it lies well inside the loaded
     * area and every chunk over it is on screen — or is about to be, while the
     * world is still loading. Otherwise yes: it shows now, or it is near
     * enough to the load edge to show the moment chunks there unload.
     */
    _needed(t) {
        const [cx0, cz0, cx1, cz1] = this._span(t), n = this._inner;
        const inside = cx0 >= n[0] && cz0 >= n[1] && cx1 <= n[2] && cz1 <= n[3];
        return !(inside && (this._loading || this._covered(t)));
    }

    _request(t) {
        this._inflight.set(t.key, t);
        this._restale.delete(t.key);
        const edits = this._editsFor(t);
        this.pool.dispatch({ type: 'farTile', x0: t.x0, z0: t.z0, step: t.step, cells: FAR_CELLS, edits }, (res) => {
            this._inflight.delete(t.key);
            // A chunk in it changed while it was being built: build it once more.
            const stale = this._restale.delete(t.key);
            this._check = true;
            if (this._disposed || !this.active || res.type !== 'farTileBuilt') {
                if (res.type === 'error') console.warn('[far] tile failed:', res.error);
                return;
            }
            this._install(t, res, stale);
        }, [], PRIORITY);
    }

    _install(t, res, stale = false) {
        const g = new THREE.BufferGeometry();
        const release = function () { this.array = null; };
        const tris = res.indices.length / 3;
        g.setAttribute('position', new THREE.BufferAttribute(res.positions, 3).onUpload(release));
        g.setAttribute('fcol',     new THREE.BufferAttribute(res.colors, 4, true).onUpload(release));
        g.setAttribute('nrm',      new THREE.BufferAttribute(res.normals, 4, true).onUpload(release));
        g.setIndex(new THREE.BufferAttribute(res.indices, 1).onUpload(release));
        const half = t.size / 2, hy = (res.yMax - res.yMin) / 2;
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(half, res.yMin + hy, half),
                                            Math.sqrt(2 * half * half + hy * hy) + SINK);
        const old = this._tiles.get(t.key);
        const mesh = new THREE.Mesh(g, this.material);
        mesh.position.set(t.x0, 0, t.z0);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.renderOrder = 1;        // after the chunks, so they hide most of it before it is shaded
        mesh.visible = old ? old.mesh.visible : false;
        mesh.name = 'far:' + t.key;
        this.group.add(mesh);
        if (old) { this.group.remove(old.mesh); old.mesh.geometry.dispose(); }
        this._tiles.set(t.key, { mesh, used: this._frame, stale, t, tris, features: res.features ?? 0 });
        this._arrived = true;
        this.built++;
    }

    /** Put the current selection on screen and let the rest go. */
    _show() {
        const want = new Set();
        for (const t of this._want) if (this._tiles.has(t.key)) want.add(t.key);
        for (const k of this._shown) if (!want.has(k)) { const t = this._tiles.get(k); if (t) t.mesh.visible = false; }
        this._shown = want;
        this._arrived = false;
        this._evict();
    }

    /** Of the tiles on show, draw the ones some unmeshed chunk still needs. */
    _hideCovered() {
        for (const k of this._shown) {
            const tile = this._tiles.get(k);
            if (tile) tile.mesh.visible = !this._covered(tile.t);
        }
    }

    _evict() {
        const spare = [...this._tiles].filter(([k]) => !this._shown.has(k));
        const keep = Math.max(CACHE_MIN, this._shown.size >> 1);
        if (spare.length <= keep) return;
        spare.sort((a, b) => a[1].used - b[1].used);
        for (let i = 0; i < spare.length - keep; i++) this._drop(spare[i][0]);
    }

    _drop(key) {
        const t = this._tiles.get(key);
        if (!t) return;
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        this._tiles.delete(key);
    }

    _clear() {
        for (const k of [...this._tiles.keys()]) this._drop(k);
        this._shown.clear();
        this._want = [];
        this._needCount = 0;
    }

    /** Redraw the mask if a chunk came or went or the player changed chunk. True if it changed. */
    _updateMask(pcx, pcz, meshes) {
        const ox = pcx - MASK / 2, oz = pcz - MASK / 2;
        if (!this._maskDirty && ox === this._maskOx && oz === this._maskOz) return false;
        this._maskDirty = false;
        this._maskOx = ox; this._maskOz = oz;
        const d = this._maskData;
        d.fill(0);
        for (const e of meshes.values()) {
            const x = e.cx - ox, z = e.cz - oz;
            if (x >= 0 && z >= 0 && x < MASK && z < MASK) d[z * MASK + x] = 255;
        }
        this.mask.needsUpdate = true;
        this.uniforms.uFarMaskOrigin.value.set(ox, oz);
        return true;
    }

    /** One triangle with the far material, for the shader warm-up draw. */
    warmupObjects() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]), 3));
        g.setAttribute('fcol', new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
        g.setAttribute('nrm', new THREE.BufferAttribute(new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]), 4, true));
        g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
        const m = new THREE.Mesh(g, this.material);
        m.userData.warmupGeometry = true;
        return [m];
    }

    /**
     * `wanted`: the tiles the current selection needs built; `shown`: how many
     * of them are on show (drawn, or hidden only because chunks cover them).
     * Equal once far terrain has caught up. `selected` counts the selection's
     * tiles under loaded chunks too.
     */
    info() {
        let tris = 0, drawn = 0, features = 0, shown = 0;
        for (const k of this._shown) {
            const tile = this._tiles.get(k);
            if (!tile) continue;
            if (tile.mesh.visible) { tris += tile.tris; drawn++; features += tile.features; }
        }
        for (const t of this._want) if (this._shown.has(t.key)) shown++;
        return {
            extra: this.extra, shown, wanted: this._needCount, selected: this._want.length, drawn,
            cached: this._tiles.size, inflight: this._inflight.size, built: this.built, tris, features,
            edits: this._edits.size,
        };
    }

    dispose() {
        this._disposed = true;
        this._clear();
        this.scene.remove(this.group);
        this.mask.dispose();
        this.material.dispose();
    }
}
