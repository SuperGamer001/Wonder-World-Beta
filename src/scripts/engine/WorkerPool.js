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

        for (let i = 0; i < n; i++) {
            const w = new Worker(workerUrl, { type: 'module' });
            const entry = { worker: w, busy: false, id: i };
            w.onmessage = (e) => this._onMessage(i, e);
            w.onerror   = (e) => console.error(`[WorkerPool] worker ${i} error:`, e);
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
            let ready = 0;

            const onReady = () => {
                ready++;
                if (ready === this._workers.length) resolve();
            };

            for (const entry of this._workers) {
                // Temporarily intercept messages to catch 'ready'
                const originalHandler = entry.worker.onmessage;
                entry.worker.onmessage = (e) => {
                    if (e.data?.type === 'ready') {
                        entry.worker.onmessage = originalHandler;
                        onReady();
                    } else {
                        originalHandler.call(entry.worker, e);
                    }
                };
                entry.worker.postMessage({ type: 'init', ...initData });
            }
        });
    }

    /**
     * Queue a job.  `callback` is called with the response data when complete.
     *
     * @param {object}   job          — message payload (must include `type`)
     * @param {function} callback     — called with response data (minus taskId)
     * @param {Transferable[]} [xfer] — transferable objects in `job`
     */
    dispatch(job, callback, xfer = []) {
        const taskId = this._taskId++;
        this._callbacks.set(taskId, callback);
        this._queue.push({ taskId, job, xfer });
        this._flush();
    }

    /** Cancel all pending (not yet started) tasks. */
    clearQueue() {
        for (const { taskId } of this._queue) this._callbacks.delete(taskId);
        this._queue.length = 0;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _flush() {
        for (const entry of this._workers) {
            if (entry.busy || this._queue.length === 0) continue;
            const { taskId, job, xfer } = this._queue.shift();
            entry.busy         = true;
            entry.currentTask  = taskId;
            entry.worker.postMessage({ ...job, taskId }, xfer);
        }
    }

    _onMessage(workerId, e) {
        const { type, taskId, ...data } = e.data;

        // 'ready' is handled during init; skip stray messages
        if (type === 'ready') return;

        const entry = this._workers[workerId];
        entry.busy  = false;

        const cb = this._callbacks.get(taskId);
        if (cb) {
            this._callbacks.delete(taskId);
            cb({ type, ...data });
        }

        this._flush();
    }
}
