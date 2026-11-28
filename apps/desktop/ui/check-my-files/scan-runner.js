"use strict";

(() => {
  const { call, bytes: callBytes } = globalThis.ClotrApp;

  // ---------- How many readers ----------

  // How many files are checked at once: one worker per core, leaving two for Windows and the window itself.
  // Each worker holds its own copy of the engine, about 60 MB, so no more than four (past four, a scan barely
  // gets faster while memory keeps climbing), and two on a PC with under 8 GB of memory.
  const POOL_MAX = 4;
  const POOL_MAX_SMALL = 2;

  function poolSize(cores = globalThis.navigator?.hardwareConcurrency, memoryGb = globalThis.navigator?.deviceMemory) {
    const coreCount = Number(cores) || 4;
    const smallMemory = Number(memoryGb) > 0 && Number(memoryGb) < 8;
    const cap = smallMemory ? POOL_MAX_SMALL : POOL_MAX;
    return Math.max(1, Math.min(cap, coreCount - 2));
  }

  // ---------- One scan: the runner ----------

  // One scan: `start` starts the walk (scan_start), `readAll` reads every file it hands over through the
  // workers and reports each one as it lands, `end` tells the walker the page is through (scan_end), `cancel`
  // stops both the walker and the workers. A new ClotrScan() per run, so the Scan screen can start another
  // the moment "Scan again" is pressed. A fresh 128-bit salt for this run alone, never the store's own salt
  // and never written anywhere: it exists only in this closure, so it (and the fingerprints it made) are gone
  // the moment this run object is, same as a cancelled or finished run's own file list.
  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // A file with nothing found and nothing in the way, shared by every clean copy instead of one object each.
  const CLEAN = Object.freeze({ found: {}, reason: null, fps: null });

  // How long one file may take before its reader counts as stuck, the same as Clotr for Android. An honest
  // file takes well under that: the slowest of the desktop's test files reads in about a tenth of a second,
  // and a text file at the 2 MiB cap in about three.
  const READ_LIMIT_MS = 20_000;
  // Readers that fail this many files in a row stop the scan, since something is wrong past any one file.
  const STUCK_IN_A_ROW = 3;

  // A file whose reader got stuck, died or couldn't post its answer: counted as not read, never as clean. A
  // reader that ran past the limit gets the same words as the engine's own time limit. One that broke gives
  // no reason, since the file may be fine: "broke" is counted among the files not read but has no words of
  // its own.
  const TIMED_OUT = Object.freeze({ found: null, reason: null, partial: true, stuck: true });
  const BROKE = Object.freeze({ found: null, reason: "broke", stuck: true });

  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }

  // What a read file gives a later copy of it: its own answer, or the shared CLEAN one when it had nothing.
  function shareableResult(file) {
    const worthSharing = hasFinds(file) || file.reason || file.partial;
    if (!worthSharing) return CLEAN;
    return {
      found: file.found,
      reason: file.reason,
      fps: file.fps,
      ...(file.partial ? { partial: true } : {}),
      ...(file.stuck ? { stuck: true } : {}),
    };
  }

  function ClotrScan({ workers: size = poolSize(), readLimitMs = READ_LIMIT_MS } = {}) {
    let workers = [];
    let cancelled = false;
    let salt = null;
    const pending = new Map(); // worker -> askWorker's own settle, while a read it started is still in flight
    const idle = [];
    const waiting = []; // readAll's turn, while every worker is busy
    let stop;
    const stopped = new Promise((resolve) => (stop = resolve)); // settles at halt(), so readAll never waits on a read

    // Starts the walk and hears back only whether a Full scan has run yet (`{ at, files }` or null), and
    // `since`: when the record this run goes by was made, if it reads only what's new or changed (null when
    // it reads everything). `again` is a later Full scan that reads every file once more.
    async function start(kind, again = false) {
      cancelled = false;
      salt = randomSalt();
      const started = await call("scan_start", { kind, again });
      return {
        fullScan: started?.fullScan ?? null,
        since: started?.since ?? null,
        generation: started?.generation ?? null,
      };
    }

    // ----- Workers -----

    // The next free worker, or null once the run is stopped.
    function acquire() {
      if (cancelled) return Promise.resolve(null);
      if (idle.length) return Promise.resolve(idle.pop());
      return new Promise((resolve) => waiting.push(resolve));
    }

    function release(worker) {
      if (cancelled) return;
      const next = waiting.shift();
      if (next) next(worker);
      else idle.push(worker);
    }

    // One file's bytes, from a worker: resolves with its kinds and counts, and `reason` when it couldn't
    // actually be read -- "locked", "scan" (a PDF with no text layer) or "damaged" -- never a silent "nothing
    // found" for a file Clotr never opened. `cancel()` can settle this same promise from outside: a
    // terminated worker never fires another message of its own, so without that a Stop mid-read would strand
    // readAll awaiting a reply that can now never come. A reader that raises an error, can't post its answer
    // or runs past the limit settles it as stuck (TIMED_OUT or BROKE), so one file never holds the scan up
    // for good.
    function askWorker(worker, file, bytes) {
      return new Promise((resolve) => {
        function settle(answer) {
          clearTimeout(timer);
          pending.delete(worker);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          resolve(answer);
        }
        const timer = setTimeout(() => settle(TIMED_OUT), readLimitMs);
        pending.set(worker, settle);
        worker.onmessage = (event) => settle(event.data);
        worker.onerror = (event) => {
          event?.preventDefault?.();
          settle(BROKE);
        };
        worker.onmessageerror = () => settle(BROKE);
        try {
          worker.postMessage({ index: file.index, name: file.name, kind: file.kind, bytes, salt }, [bytes]);
        } catch {
          settle(BROKE);
        }
      });
    }

    // Ends a stuck reader and puts a fresh one in its place, so the next file isn't stuck behind it.
    function replace(worker) {
      worker.terminate();
      const fresh = new Worker("check-my-files/scan-worker.js");
      workers[workers.indexOf(worker)] = fresh;
      return fresh;
    }

    async function readOne(file, worker) {
      let bytes;
      try {
        bytes = await callBytes("scan_next", { index: file.index });
      } catch {
        file.reason = "locked"; // the walker found it, so this PC's own read failed: another program has it
        return file;
      }
      // Stop landed while these bytes were on their way: the worker is already gone, so the file simply
      // counts as not read and the loop ends on its next turn.
      if (cancelled) return file;
      const result = await askWorker(worker, file, bytes);
      if (result.stuck) file.stuck = true;
      file.found = result.found;
      file.reason = result.reason;
      file.fps = result.fps || null;
      if (result.partial) file.partial = true; // the engine ran out of time before the end of this file's text
      return file;
    }

    // ----- Reading every file -----

    // Reads every file the walker hands over, several at once, a batch at a time in the order it found them,
    // and asks for the next batch the moment this one lands, so the walker reads it off the disk while this
    // one is checked (waiting until the end left every worker idle through each batch's reads). `onFile`
    // hears each result as it lands (not quite in order, since a big file takes longer), for the Scan
    // screen's feed, and `onRead` each file as its read begins, for the trace map; `onBatch` hears the
    // walker's counts and its counted total after every batch, for the counts. Only the files the page still
    // needs are kept: one with finds, for Results, and one it couldn't open, which a Full scan's record then
    // leaves out. Every other file is let go, here and in the walker. A copy of a document already checked
    // this run (the walker's `dupOf`) takes that result rather than being read again. Stops early at
    // `cancel()`.
    async function readAll(onFile, onBatch, onRead) {
      workers = Array.from({ length: size }, () => new Worker("check-my-files/scan-worker.js"));
      idle.push(...workers);
      const kept = [];
      const unread = [];
      const flagged = []; // indexes worth a look this run, so a Full scan's new record can carry that bit
      const results = new Map(); // index -> its result (or the promise of one), for copies of it later on
      const inFlight = new Set();
      let counts = {};
      let completed = false;
      let settled = [];
      let keep = [];

      function settle(file) {
        settled.push(file.index);
        // A file checked only in part, or whose reader got stuck, is left out of the record too, so the next
        // scan reads it again.
        if (file.reason === "locked" || file.partial || file.stuck) {
          unread.push(file.index);
          keep.push(file.index);
        }
        if (hasFinds(file)) {
          kept.push(file);
          keep.push(file.index);
          if (globalThis.ClotrResults?.isWorthALook(file)) flagged.push(file.index);
        }
        onFile?.(file);
      }

      let stuckInARow = 0;
      let gaveUp = null;
      const outcomes = []; // per file, in the order the walker gave them: true stuck, false read, null a copy
      let counted = 0; // how far through `outcomes` the count has got

      // Counts files that got stuck one after another in the walker's order, not the order their readers
      // finish in, and stops the scan at the third. A file waits to be counted until every file before it has
      // landed.
      function tally(turn, outcome) {
        outcomes[turn] = outcome;
        while (counted < outcomes.length && outcomes[counted] !== undefined) {
          const stuck = outcomes[counted++];
          if (stuck === null) continue; // a copy took another file's result, so it says nothing new
          stuckInARow = stuck ? stuckInARow + 1 : 0;
          if (stuckInARow >= STUCK_IN_A_ROW && !gaveUp) {
            gaveUp = Object.assign(new Error("readers stuck"), { name: "ReaderStuck" });
            cancel().catch(() => {});
            return;
          }
        }
      }

      let turns = 0;
      async function check(shown, worker) {
        const turn = turns++;
        const file = { ...shown, found: null, reason: null, fps: null };
        const first = shown.dupOf != null && shown.kind !== "picture" ? results.get(shown.dupOf) : undefined;
        let done;
        if (first) {
          release(worker);
          done = Object.assign(file, await first);
          if (!cancelled) tally(turn, null);
        } else {
          const read = readOne(file, worker).then(shareableResult);
          results.set(shown.index, read);
          const result = await read;
          results.set(shown.index, result);
          release(file.stuck && !cancelled ? replace(worker) : worker);
          done = file;
          if (!cancelled) tally(turn, Boolean(file.stuck));
        }
        if (!cancelled) settle(done);
      }

      function ask() {
        const out = call("scan_batch", { settled, keep });
        out.catch(() => {}); // the loop awaits it later and throws then; this only keeps it from going unhandled
        settled = [];
        keep = [];
        return out;
      }

      try {
        let next = ask();
        while (!cancelled) {
          const batch = await Promise.race([next, stopped]);
          if (!batch || cancelled) break;
          counts = batch.counts || {};
          onBatch?.(batch);
          if (!batch.done) next = ask();
          for (const shown of batch.files || []) {
            const worker = await acquire();
            if (!worker || cancelled) break;
            onRead?.(shown);
            const job = check(shown, worker);
            inFlight.add(job);
            job.finally(() => inFlight.delete(job));
          }
          if (cancelled) break;
          if (batch.done) {
            await Promise.race([Promise.all(inFlight), stopped]);
            completed = !cancelled;
            break;
          }
        }
      } finally {
        halt(); // however the run ended, nothing from it acts after this
      }
      if (gaveUp) throw gaveUp;
      return { files: kept, counts, completed, unread, flagged };
    }

    // ----- Ending and stopping -----

    // The page is through: `completed` when it read every file the walk handed over. Hears back the Full scan
    // record's summary, which a whole Full scan has just written, with `flagged` (worth a look this run)
    // carrying that file's bit forward into it.
    async function end(completed, unread, flagged) {
      return call("scan_end", { completed, unread: unread || [], flagged: flagged || [] });
    }

    // Ends this run's side of the page: marks it stopped, then settles the reads still in flight (which
    // clears their timers) instead of leaving readAll awaiting replies its terminated workers can never send,
    // wakes a loop waiting for a free worker, and ends every worker. Each file in flight simply counts as not
    // read, and since `cancelled` is set first, no late answer, error or time-out can start a reader, count a
    // stuck file or reach the screen. readAll calls it on its way out, so a walker that fails mid-read leaves
    // nothing behind either.
    function halt() {
      cancelled = true;
      stop();
      for (const settle of pending.values()) settle({ found: null, reason: null });
      pending.clear();
      for (const resolve of waiting.splice(0)) resolve(null);
      for (const worker of workers) worker.terminate();
      workers = [];
      idle.length = 0;
    }

    async function cancel() {
      halt();
      await call("scan_cancel");
    }

    return { start, readAll, end, cancel };
  }

  ClotrScan.poolSize = poolSize;
  ClotrScan.READ_LIMIT_MS = READ_LIMIT_MS;
  ClotrScan.hasFinds = hasFinds;
  globalThis.ClotrScan = ClotrScan;
})();
