/**
 * MobNav — where a mob can stand, and how to get from one place to another.
 *
 * The world is read as a grid of block columns. A mob stands in a cell: the
 * block under it is solid and the cells its body fills are not. From a cell it
 * can walk to any of the eight around it, if the ground there is
 *   • level, or
 *   • one block up (a jump — it needs the headroom to make it), or
 *   • no more than `maxDrop` blocks down (a drop it will take on purpose),
 * and never through a wall, under a ceiling too low for it, or across the
 * corner of a pit. Water is somewhere it can be but would rather not: a land
 * mob's paths go round a pond, yet one that has fallen in can still find the
 * way out. findPath() is A* over those cells.
 *
 * It knows nothing about mobs beyond the three numbers in a `body`
 * ({ clear, maxDrop, swims }), and nothing about Three.js, so it runs in a
 * test against any world that has getBlock().
 */

const NONE = -9999;

// A* gives up after expanding this many cells and returns the way to the
// closest one it reached — a few tenths of a millisecond at most.
const MAX_EXPANDED = 420;
const WATER_COST = 9;      // per cell of water, for a mob that walks
const UP_COST    = 0.7;    // on top of the distance, per jump
const DROP_COST  = 0.35;   // … per block dropped

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class MobNav {
    /**
     * @param {{ getBlock(x, y, z): number }} world
     * @param {{ isNoCollision(id): boolean, isLiquid(id): boolean }} blockRegistry
     */
    constructor(world, blockRegistry) {
        this.world = world;
        this.reg = blockRegistry;
        this.wet = false;        // set by stand(): the cell found is water
        this.searches = 0;       // findPath calls so far (diagnostics, budgeting)
    }

    solid(x, y, z) {
        const id = this.world.getBlock(x, y, z);
        return id !== 0 && !this.reg.isNoCollision(id);
    }

    liquid(x, y, z) {
        const id = this.world.getBlock(x, y, z);
        return id !== 0 && this.reg.isLiquid(id);
    }

    /**
     * The cell a mob would stand in if it went to column (x, z) from height
     * `y`: the highest one from y + 1 down to y − maxDrop with solid ground (or
     * water) under open space. NONE if there is none it can get into — the
     * column is a wall, a pit deeper than it will drop, or too low overhead.
     * Sets `this.wet` when the cell is water (it would be swimming).
     */
    stand(x, z, y, body) {
        this.wet = false;
        const clear = body.clear, lowest = y - body.maxDrop;
        for (let ny = y + 1; ny >= lowest; ny--) {
            if (this.solid(x, ny, z)) {
                // Rock at or above where it would stand: nothing lower is reachable from here.
                if (ny > y) continue;      // the block it would have to jump onto is higher still
                return NONE;
            }
            const wet = this.liquid(x, ny, z);
            if (!wet && !this.solid(x, ny - 1, z)) continue;       // air over air: keep falling
            // Room for the body from here up to the height it arrives at.
            const top = Math.max(ny, y) + clear - 1;
            for (let k = ny + 1; k <= top; k++) if (this.solid(x, k, z)) return NONE;
            this.wet = wet;
            return ny;
        }
        return NONE;
    }

    /** How far below `y` the ground (or water) is in column (x, z), up to `limit`; Infinity past that. */
    dropBelow(x, y, z, limit) {
        for (let d = 0; d <= limit; d++) {
            const id = this.world.getBlock(x, y - 1 - d, z);
            if (id !== 0 && (!this.reg.isNoCollision(id) || this.reg.isLiquid(id))) return d;
        }
        return Infinity;
    }

    /**
     * A path of cells from (sx, sy, sz) to within a block of (tx, ty, tz):
     * [{ x, y, z, wet }, …], not including the start. When the goal cannot be
     * reached (or is too far to search), the path to the reachable cell
     * nearest it, if that is any nearer than the start; else null.
     *
     * @param {{ clear: number, maxDrop: number, swims: boolean }} body
     *   clear: cells of headroom it needs; maxDrop: blocks it will drop;
     *   swims: water costs it nothing (and it may not leave it — see MobAI)
     */
    findPath(sx, sy, sz, tx, ty, tz, body, maxExpanded = MAX_EXPANDED) {
        this.searches++;
        sx = Math.floor(sx); sy = Math.floor(sy); sz = Math.floor(sz);
        tx = Math.floor(tx); ty = Math.floor(ty); tz = Math.floor(tz);

        const nodes = new Map();
        const heap = [];
        const key = (x, y, z) => ((x - sx + 512) & 1023) | (((z - sz + 512) & 1023) << 10) | (((y - sy + 256) & 511) << 20);
        const h = (x, y, z) => {
            const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
            return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz) + Math.abs(y - ty) * 0.5;
        };
        const push = (n) => {
            heap.push(n);
            for (let i = heap.length - 1; i > 0;) {
                const p = (i - 1) >> 1;
                if (heap[p].f <= heap[i].f) break;
                [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
            }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length) {
                heap[0] = last;
                for (let i = 0; ;) {
                    const l = i * 2 + 1, r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l].f < heap[m].f) m = l;
                    if (r < heap.length && heap[r].f < heap[m].f) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
                }
            }
            return top;
        };

        const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sy, sz), parent: null, wet: this.liquid(sx, sy, sz), closed: false };
        nodes.set(key(sx, sy, sz), start);
        push(start);
        let best = start, bestH = start.f, expanded = 0, goal = null;

        while (heap.length) {
            const n = pop();
            if (n.closed) continue;
            n.closed = true;
            // Next to the goal is close enough: the goal itself may be the player's own cell.
            if (Math.abs(n.x - tx) <= 1 && Math.abs(n.z - tz) <= 1 && Math.abs(n.y - ty) <= 2) { goal = n; break; }
            if (++expanded > maxExpanded) break;
            const hn = n.f - n.g;
            if (hn < bestH) { bestH = hn; best = n; }

            for (let d = 0; d < 8; d++) {
                const dx = DIRS[d][0], dz = DIRS[d][1];
                const nx = n.x + dx, nz = n.z + dz;
                const ny = this.stand(nx, nz, n.y, body);
                if (ny === NONE) continue;
                const wet = this.wet;
                if (ny > n.y) {
                    // A jump: its own cell needs the headroom to rise into.
                    if (this.solid(n.x, n.y + body.clear, n.z)) continue;
                }
                if (d >= 4) {
                    // Diagonal: both cells it squeezes between must be open at the
                    // same height, or it would cut the corner of a wall or a pit.
                    if (this.stand(n.x + dx, n.z, n.y, body) !== ny || this.stand(n.x, n.z + dz, n.y, body) !== ny) continue;
                    if (ny !== n.y) continue;
                }
                let cost = d < 4 ? 1 : 1.4142;
                if (ny > n.y) cost += UP_COST;
                else if (ny < n.y) cost += DROP_COST * (n.y - ny);
                if (wet && !body.swims) cost += WATER_COST;
                const g = n.g + cost;
                const k = key(nx, ny, nz);
                let m = nodes.get(k);
                if (m) {
                    if (m.closed || g >= m.g) continue;
                    m.closed = true;   // a shorter way to it: the entry in the heap is now stale
                }
                m = { x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: n, wet, closed: false };
                nodes.set(k, m);
                push(m);
            }
        }

        let end = goal ?? best;
        if (!goal && bestH >= start.f - 0.5) return null;   // got nowhere nearer
        const path = [];
        for (let n = end; n && n !== start; n = n.parent) path.push({ x: n.x, y: n.y, z: n.z, wet: n.wet });
        path.reverse();
        path.reached = !!goal;
        return path.length ? path : null;
    }
}

export { NONE };
