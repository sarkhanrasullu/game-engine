// Download lane (engine /assets, 0.5.2 BOOT-NET): ONE priority scheduler for everything a game streams
// after the boot bundle — hero glTFs, the stage glTF, sample-bank clips. On a slow link the only thing that
// matters is ORDER: one download at a time, the thing the player is looking at first, and a cheap way to
// change one's mind (a swipe) without waiting for a megabyte that is no longer wanted.
//
// Jobs: `add({ id, priority, run, preempt })` queues a job (lower priority number = sooner; equal priority
// = FIFO) and returns its promise; adding an id that is already queued or running returns the same promise
// (and lowers its priority number if the new one is more urgent). `bump(id, priority)` re-prioritises a
// queued job. `promote(id)` moves a job to the very front and — when the job in flight says it may be
// preempted (`preempt()` true: e.g. less than half downloaded) — aborts it through the AbortSignal handed
// to its `run` and re-queues it at its own place (same priority, same arrival order); the preempted job's
// promise stays the same and settles when it eventually runs. A run that ignores the signal simply finishes.
// `promote(id, { preempt: false })` moves up without aborting anything.
//
// A job's rejection settles that job's promise only. Not thread-safe (main thread only). Zero timers: the
// worker loop starts on a microtask and sleeps when the queue is empty.

/**
 * Create a download lane.
 * @returns {{
 *   add: (job: {id: string, priority?: number, run: (ctx: {signal: AbortSignal}) => Promise<any>, preempt?: (() => boolean) | null}) => Promise<any>,
 *   bump: (id: string, priority: number) => boolean,
 *   promote: (id: string, how?: {preempt?: boolean}) => boolean,
 *   yieldToFront: () => void,
 *   current: () => string | null,
 *   idle: () => Promise<void>,
 *   snapshot: () => {id: string, priority: number}[],
 * }}
 * @example
 *   const lane = createDownloadLane();
 *   lane.add({ id: 'hero:a', priority: 10, run: ({ signal }) => fetchBytes(urlA, null, { signal }), preempt: () => fractionA < 0.5 });
 *   lane.add({ id: 'bank:hit_01.m4a', priority: 30, run: () => fetch(url).then((r) => r.arrayBuffer()) });
 *   lane.promote('hero:b'); // the swiped-to hero goes first; hero:a is aborted and re-queued if barely started
 *   await lane.idle();
 */
export function createDownloadLane() {
  /** @type {Map<string, any>} every job not yet settled */
  const jobs = new Map();
  /** Queued jobs, front first (sorted by priority, then arrival). */
  const queue = [];
  let current = null;
  let controller = null;
  let working = false;
  let seq = 0;
  let frontSeq = 0;
  const idleWaiters = [];

  function insert(job) {
    let i = queue.length;
    while (i > 0 && (job.priority < queue[i - 1].priority || (job.priority === queue[i - 1].priority && job.seq < queue[i - 1].seq))) i--;
    queue.splice(i, 0, job);
  }
  function remove(job) {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
  }

  /** Abort the job in flight if it allows that; it goes back to its own place in the queue. */
  function preemptCurrent() {
    if (!current || current.preempted || current.preempt?.() !== true) return;
    current.preempted = true;
    insert(current); // the worker picks up from the queue when the abort lands
    controller.abort();
  }

  async function work() {
    if (working) return;
    working = true;
    while (queue.length) {
      const job = queue.shift();
      current = job;
      job.preempted = false;
      controller = new AbortController();
      let ok = true;
      let value;
      try {
        value = await job.run({ signal: controller.signal });
      } catch (e) {
        ok = false;
        value = e;
      }
      current = null;
      if (job.preempted && !ok) continue; // aborted by promote(): back in the queue, its promise untouched
      remove(job); // preempted but ignored the signal and finished anyway
      jobs.delete(job.id);
      if (ok) job.resolve(value); else job.reject(value);
    }
    working = false;
    for (const fn of idleWaiters.splice(0)) fn();
  }

  return {
    add({ id, priority = 0, run, preempt = null }) {
      const existing = jobs.get(id);
      if (existing) {
        if (existing !== current && priority < existing.priority) {
          remove(existing);
          existing.priority = priority;
          insert(existing);
        }
        return existing.promise;
      }
      const job = { id, priority, seq: seq++, run, preempt, preempted: false };
      job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
      jobs.set(id, job);
      insert(job);
      queueMicrotask(work);
      return job.promise;
    },
    /** Re-prioritise a QUEUED job (a running one keeps going). @returns {boolean} true when the job was queued */
    bump(id, priority) {
      const job = jobs.get(id);
      if (!job || job === current) return false;
      remove(job);
      job.priority = priority;
      insert(job);
      return true;
    },
    /**
     * Move a job to the very front (ahead of every queued job, whatever its priority). If another job is in
     * flight and its `preempt()` says yes, that job is aborted and re-queued at its own place, unless
     * `how.preempt` is false. Promoting a job that is being aborted moves it to the front too; a job running
     * normally stays as it is.
     * @param {string} id @param {{preempt?: boolean}} [how]
     * @returns {boolean} true when the id is a known, unsettled job
     */
    promote(id, { preempt = true } = {}) {
      const job = jobs.get(id);
      if (!job) return false;
      if (job === current && !job.preempted) return true;
      remove(job);
      job.priority = Math.min(job.priority, current ? current.priority : Infinity, ...queue.map((j) => j.priority));
      job.seq = --frontSeq;
      insert(job);
      if (preempt && current !== job) preemptCurrent();
      return true;
    },
    /**
     * Let the front of the queue go next when it is more urgent than the job in flight and that job allows
     * being aborted (a fight has started: bytes for the next scene wait for the audio this one can still use).
     * With nothing more urgent waiting it does nothing: a download is never thrown away to restart it.
     * @example bank.prefetch({ groups: ['essential'], priority: -1 }); lane.yieldToFront();
     */
    yieldToFront() {
      if (current && queue[0] && queue[0] !== current && queue[0].priority < current.priority) preemptCurrent();
    },
    /** Id of the job in flight, or null. */
    current: () => current?.id ?? null,
    /** Resolves when nothing is queued or in flight (at once when already idle). */
    idle: () => (working || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve()),
    /** Debug / tests: the in-flight job first, then the queue in run order. */
    snapshot: () => (current ? [current, ...queue.filter((j) => j !== current)] : queue).map((j) => ({ id: j.id, priority: j.priority })),
  };
}
