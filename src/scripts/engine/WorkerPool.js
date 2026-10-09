/**
 * WorkerPool
 *
 * Manages a fixed-size pool of module workers.  When a worker finishes a job
 * it immediately picks up the next pending task from the queue (FIFO).
 *
 * All heavy work (terrain generation, meshing) flows through this class so that
 * the main thread remains free for rendering and gameplay.
 *
 * Usage:
 *   const pool = new WorkerPool(workerUrl);
 *   await pool.init({ seed, blockRegistry, biomes });
 *   pool.dispatch({ type: 'generateChunk', cx, cy, cz }, callback);
 */

export class WorkerPool {
    /**
     * @param {string|URL} workerUrl   — URL of the worker module entry point
     * @param {number}     [count]     — override worker count (default: auto)
     */
    constructor(workerUrl, count) {
        // Leave one logical core free for the main thread.
        // Clamp between 2 and 8 so we don't starve low-end or waste high-end.
        const auto  = Math.max(2, Math.min((navigator.hardwareConcurrency ?? 4) - 1, 8));
        const n     = count ?? auto;

        this._taskId    = 0;
        this._queue     = [];          // { taskId, job, transferList } waiting for a free worker
        this._callbacks = new Map();   // taskId → callback
        this._workers   = [];          // { worker, busy, id }
        this._url       = workerUrl;

        for (let i = 0; i < n; i++) {
            const w = new Worker(workerUrl, { type: 'module' });
            const entry = { worker: w, busy: false, id: i, currentTask: null };
            w.onmessage = (e) => this._onMessage(i, e);
            w.onerror   = (e) => this._onWorkerError(i, e);
            this._workers.push(entry);
        }
    }

    get workerCount() { return this._workers.length; }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Broadcast the init message to all workers and return a Promise that
     * resolves once every worker has sent back { type: 'ready' }.
     */
    init(initData) {
        return new Promise((resolve) => {
            let waiting = this._workers.length;
            const settled = () => { if (--waiting === 0) resolve(); };

            // A worker that fails before it has said it is ready never will be
            // — its script did not load — and one such used to leave this
            // promise, and so the whole world, waiting for ever. It is started
            // again, twice at most; after that the pool goes on without it.
            const start = (entry, triesLeft) => {
                const w = entry.worker;
                const onMessage = (e) => this._onMessage(entry.id, e);
                w.onmessage = (e) => {
                    if (e.data?.type !== 'ready') return onMessage(e);
                    entry.ready = true;
                    w.onmessage = onMessage;
                    w.onerror = (ev) => this._onWorkerError(entry.id, ev);
                    settled();
                };
                w.onerror = (ev) => {
                    ev.preventDefault?.();
                    w.terminate();
                    if (!this._workers.includes(entry)) return;      // the pool was shut down meanwhile
                    if (triesLeft > 0) {
                        console.warn(`[WorkerPool] worker ${entry.id} did not start; trying again`);
                        entry.worker = new Worker(this._url, { type: 'module' });
                        start(entry, triesLeft - 1);
                    } else {
                        console.error(`[WorkerPool] worker ${entry.id} would not start: going on without it`);
                        entry.busy = true;                             // never given a job
                        settled();
                    }
                };
                w.postMessage({ type: 'init', ...initData });
            };
            for (const entry of this._workers) start(entry, 2);
        });
    }

    /**
     * Queue a job.  `callback` is called with the response data when complete.
     *
     * `job` may instead be a function that builds the payload when a worker
     * picks the job up: `() => ({ job, xfer }) | null`. Mesh and light jobs use
     * this, so their chunk snapshots (about 1 MB per job) are copied only when
     * they are about to run — they reflect the chunk as it is then, the queue
     * holds no copies, and a job whose chunk has gone costs nothing. Returning
     * null drops the job and calls back with { type: 'cancelled' }.
     *
     * @param {object|function} job   — message payload (must include `type`), or its builder
     * @param {function} callback     — called with response data (minus taskId)
     * @param {Transferable[]} [xfer] — transferable objects in `job`
     * @param {number}   [priority]   — lower value runs first (default 1)
     *                                  0 = partial re-mesh (highest)
     *                                  1 = initial mesh
     *                                  2 = terrain generation (lowest)
     */
    dispatch(job, callback, xfer = [], priority = 1) {
        const taskId = this._taskId++;
        this._callbacks.set(taskId, callback);
        // Insert at the correct sorted position so lower-priority-value items run first.
        // Queue lengths stay small (≤ MAX_DISPATCH * workers), so O(n) splice is fine.
        const item = { taskId, job, xfer };
        let i = this._queue.length;
        while (i > 0 && this._queue[i - 1]._priority > priority) i--;
        item._priority = priority;
        this._queue.splice(i, 0, item);
        this._flush();
    }

    /** Cancel all pending (not yet started) tasks. */
    clearQueue() {
        for (const { taskId } of this._queue) this._callbacks.delete(taskId);
        this._queue.length = 0;
    }

    /**
     * Terminate every worker and drop all state. After this the pool is dead and
     * must not be reused. Call when leaving a world so a fresh world doesn't leak
     * a second set of workers still running with the previous world's seed.
     */
    terminate() {
        this.clearQueue();
        for (const entry of this._workers) {
            entry.worker.onmessage = null;
            entry.worker.onerror   = null;
            entry.worker.terminate();
        }
        this._workers.length = 0;
        this._callbacks.clear();
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _flush() {
        for (const entry of this._workers) {
            // `busy` is re-read each pass: a cancelled job's callback may queue
            // work and flush re-entrantly, filling this worker.
            while (!entry.busy && this._queue.length > 0) {
                const { taskId } = this._queue[0];
                let { job, xfer } = this._queue.shift();
                if (typeof job === 'function') {
                    let built;
                    try {
                        built = job();
                    } catch (err) {
                        console.error(`[WorkerPool] task ${taskId} could not be built:`, err);
                        this._finish(taskId, { type: 'error', error: String(err?.message ?? err) });
                        continue;
                    }
                    if (!built) { this._finish(taskId, { type: 'cancelled' }); continue; }
                    ({ job, xfer } = built);
                }
                entry.busy         = true;
                entry.currentTask  = taskId;
                entry.worker.postMessage({ ...job, taskId }, xfer ?? []);
            }
        }
    }

    /** Complete a task that never reached a worker. */
    _finish(taskId, result) {
        const cb = this._callbacks.get(taskId);
        this._callbacks.delete(taskId);
        cb?.(result);
    }

    _onMessage(workerId, e) {
        const { type, taskId, ...data } = e.data;

        // 'ready' is handled during init; skip stray messages
        if (type === 'ready') return;

        const entry = this._workers[workerId];
        entry.busy        = false;
        entry.currentTask = null;

        const cb = this._callbacks.get(taskId);
        if (cb) {
            this._callbacks.delete(taskId);
            if (type === 'error') {
                console.error(`[WorkerPool] task ${taskId} failed in worker ${workerId}:`, data.message);
                cb({ type: 'error', error: data.message });
            } else {
                cb({ type, ...data });
            }
        }

        this._flush();
    }

    /**
     * A worker that throws never posts a result, so without this its `busy`
     * flag stayed set forever: the pool permanently lost that worker and the
     * chunk it was holding never completed, leaving a hole in the world that
     * nothing would retry. Release the slot and fail the task so the caller can
     * decide whether to re-queue it.
     */
    _onWorkerError(workerId, e) {
        const entry = this._workers[workerId];
        const msg   = e?.message ?? String(e?.type ?? e);
        console.error(`[WorkerPool] worker ${workerId} error:`, msg, e?.filename ?? '', e?.lineno ?? '');

        const taskId = entry?.currentTask;
        if (entry) { entry.busy = false; entry.currentTask = null; }

        if (taskId != null) {
            const cb = this._callbacks.get(taskId);
            if (cb) {
                this._callbacks.delete(taskId);
                cb({ type: 'error', error: msg });
            }
        }

        this._flush();
    }
}
