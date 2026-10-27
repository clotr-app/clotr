// Clotr for Windows — Check my files: connects the walker (scan_start/scan_batch/scan_next/scan_end/scan_cancel,
// scan.rs) and the reader (scan-worker.js). The page never sees a path: scan_batch hands over the next few files'
// display details (name, folder, kind, size) and an index each; this reads each file's bytes by that index, carries
// them to one of several workers, and brings back its kinds and counts. Only the files with finds stay here, so a
// scan of a whole drive holds no more than a couple of batches at a time. The Scan screen itself (the trace map in
// trace.js, the feed, the steps) draws on top of this; this is the wiring underneath it, kept only in memory: nothing here is
// written anywhere, and a cancelled or finished run's list disappears with the page.
"use strict";

(() => {
  const { call, bytes: callBytes } = globalThis.ClotrApp;
  const W = globalThis.ClotrWords;
  const SCAN_TIMES_ENABLED = globalThis.ClotrDesktopFeatures?.scanTimes === true;
  const C = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);

  // How many files are checked at once: one worker per core, leaving two for Windows and the window itself. Each
  // worker holds its own copy of the engine, about 60 MB, so no more than four (past four, a scan barely gets
  // faster while memory keeps climbing), and two on a PC with under 8 GB of memory.
  const POOL_MAX = 4;
  const POOL_MAX_SMALL = 2;
  function poolSize(cores = globalThis.navigator?.hardwareConcurrency, memoryGb = globalThis.navigator?.deviceMemory) {
    const n = Number(cores) || 4;
    const cap = Number(memoryGb) > 0 && Number(memoryGb) < 8 ? POOL_MAX_SMALL : POOL_MAX;
    return Math.max(1, Math.min(cap, n - 2));
  }

  // One scan: `start` starts the walk (scan_start), `readAll` reads every file it hands over through the workers
  // and reports each one as it lands, `end` tells the walker the page is through (scan_end), `cancel` stops both
  // the walker and the workers. A new ClotrScan() per run, so the Scan screen can start another the moment "Scan
  // again" is pressed.
  // A fresh 128-bit salt for this run alone (4.14's grouping), never the store's own salt and never written
  // anywhere: it exists only in this closure, so it (and the fingerprints it made) are gone the moment this
  // run object is, same as a cancelled or finished run's own file list.
  function randomSalt() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // A file with nothing found and nothing in the way, shared by every clean copy instead of one object each.
  const CLEAN = Object.freeze({ found: {}, reason: null, fps: null });

  function ClotrScan({ workers: size = poolSize() } = {}) {
    let workers = [];
    let cancelled = false;
    let salt = null;
    const pending = new Map(); // worker -> askWorker's own resolve, while a read it started is still in flight
    const idle = [];
    const waiting = []; // readAll's turn, while every worker is busy
    let stop;
    const stopped = new Promise((resolve) => (stop = resolve)); // settles at cancel(), so readAll never waits on a read

    // Starts the walk and hears back only whether a Full scan has run yet (`{ at, files }` or null), and `since`:
    // when the record this run goes by was made, if it reads only what's new or changed (null when it reads
    // everything). `again` is a later Full scan that reads every file once more.
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

    // One file's bytes, from a worker: resolves with its kinds and counts, and (4.3) `reason` when it couldn't
    // actually be read -- "locked", "scan" (a PDF with no text layer) or "damaged" -- never a silent "nothing found"
    // for a file Clotr never opened. `cancel()` can settle this same promise from outside: a terminated worker never
    // fires another message of its own, so without that a Stop mid-read would strand readAll awaiting a reply that
    // can now never come.
    function askWorker(worker, file, bytes) {
      return new Promise((resolve) => {
        pending.set(worker, resolve);
        worker.onmessage = (e) => {
          pending.delete(worker);
          resolve(e.data);
        };
        worker.postMessage({ index: file.index, name: file.name, kind: file.kind, bytes, salt }, [bytes]);
      });
    }

    async function readOne(file, worker) {
      let bytes;
      try {
        bytes = await callBytes("scan_next", { index: file.index });
      } catch {
        file.reason = "locked"; // the walker found it, so this PC's own read failed: another program has it
        return file;
      }
      // Stop landed while these bytes were on their way: the worker is already gone, so the file simply counts as
      // not read and the loop ends on its next turn.
      if (cancelled) return file;
      const result = await askWorker(worker, file, bytes);
      file.found = result.found;
      file.reason = result.reason;
      file.fps = result.fps || null;
      return file;
    }

    // Reads every file the walker hands over, several at once, a batch at a time in the order it found them, and
    // asks for the next batch the moment this one lands, so the walker reads it off the disk while this one is
    // checked (waiting until the end left every worker idle through each batch's reads). `onFile` hears each result as
    // it lands (not quite in order, since a big file takes longer), for the Scan screen's feed, and `onRead` each
    // file as its read begins, for the trace map; `onBatch` hears the walker's counts and its counted total after
    // every batch, for the counts. Only the files the page still needs are kept: one with finds, for Results, and
    // one it couldn't open, which a Full scan's record then leaves out. Every other file is let go, here and in the
    // walker. A copy of a document already checked this run (the walker's `dupOf`) takes that result rather than
    // being read again. Stops early at `cancel()`.
    async function readAll(onFile, onBatch, onRead) {
      workers = Array.from({ length: size }, () => new Worker("scan-worker.js"));
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

      const settle = (file) => {
        settled.push(file.index);
        if (file.reason === "locked") {
          unread.push(file.index);
          keep.push(file.index);
        }
        if (file.found && Object.keys(file.found).length) {
          kept.push(file);
          keep.push(file.index);
          if (globalThis.ClotrResults?.isWorthALook(file)) flagged.push(file.index);
        }
        onFile?.(file);
      };
      const check = async (shown, worker) => {
        const file = { ...shown, found: null, reason: null, fps: null };
        const first = shown.dupOf != null && shown.kind !== "picture" ? results.get(shown.dupOf) : undefined;
        let done;
        if (first) {
          release(worker);
          done = Object.assign(file, await first);
        } else {
          const read = readOne(file, worker).then((f) => {
            const has = (f.found && Object.keys(f.found).length) || f.reason;
            return has ? { found: f.found, reason: f.reason, fps: f.fps } : CLEAN;
          });
          results.set(shown.index, read);
          const result = await read;
          results.set(shown.index, result);
          release(worker);
          done = file;
        }
        if (!cancelled) settle(done);
      };
      const ask = () => {
        const out = call("scan_batch", { settled, keep });
        settled = [];
        keep = [];
        return out;
      };

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
        for (const w of workers) w.terminate();
        workers = [];
        idle.length = 0;
      }
      return { files: kept, counts, completed, unread, flagged };
    }

    // The page is through: `completed` when it read every file the walk handed over. Hears back the Full scan
    // record's summary, which a whole Full scan has just written, with `flagged` (worth a look this run) carrying
    // that file's bit forward into it.
    async function end(completed, unread, flagged) {
      return call("scan_end", { completed, unread: unread || [], flagged: flagged || [] });
    }

    async function cancel() {
      cancelled = true;
      stop();
      // Reads already in flight: settle them here instead of leaving readAll awaiting replies its now-terminated
      // workers can never send, and wake a loop waiting for a free worker. Each file simply counts as not read; the
      // loop's own `if (cancelled) break` ends the run on its very next turn.
      for (const resolve of pending.values()) resolve({ found: null, reason: null });
      pending.clear();
      for (const resolve of waiting.splice(0)) resolve(null);
      for (const w of workers) w.terminate();
      workers = [];
      idle.length = 0;
      await call("scan_cancel");
    }

    return { start, readAll, end, cancel };
  }

  // ---------- The Scan screen: choose a Quick scan, a Full scan, Folders I choose or Look back, the trace map,
  // the counts, the steps, the feed of what's found so far, and Stop. Results gets only a plain, honest
  // summary. ----------

  const PICKS = ["quick", "full", "chosen", "lookback"];

  let lang = "en";
  let kind = "quick";
  let run = null; // the in-flight ClotrScan(), while running or stopping
  let state = "idle"; // idle | running | stopping | done | stopped
  let announcedQuarter = 0;
  let timeTimer = null;
  let began = 0;
  let trace = null; // the trace map's view (trace.js), once the screen is wired
  let lastFiles = []; // the last finished run's files with finds (ClotrScan's readAll)
  let fullScan = null; // the last Full scan's `{ at, files }`, or null before the first one
  let since = null; // the running scan reads only what changed since this time (scan_start's `since`), or null
  let generation = null; // the current run's id, attached to its Results actions
  let leavesOut = true; // code projects and secret files left out, unless Settings' developer switch is on
  let chosenNames = []; // "Folders I choose": the picked folders' own names (their paths stay in Rust)

  function fmt(n) {
    return Number(n).toLocaleString(lang === "en" ? "en-US" : "es-ES");
  }
  function clock(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }
  function say(words) {
    $("scan-live").textContent = words;
  }
  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }
  function thingWords(n) {
    return n === 1 ? W.t("ws.thing", fmt(n)) : W.t("ws.things", fmt(n));
  }
  // Every file's own finds, summed into one row's worth of counts for History: never a name, a folder or a
  // detected value, only how many of each kind across the whole run.
  function kindCounts(files) {
    const out = {};
    for (const file of files) {
      for (const [id, n] of Object.entries(file.found || {})) out[id] = (out[id] || 0) + n;
    }
    return out;
  }

  function kindName(id) {
    const found = (C.PATTERNS || []).find((p) => p.id === id);
    return found ? found.name : id;
  }
  function describeFound(found) {
    const parts = Object.entries(found || {}).map(([id, n]) => (n > 1 ? `${kindName(id)} (${fmt(n)})` : kindName(id)));
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(parts);
  }

  // A clean moment's own ticked list: grouped the same way the browser's own warning groups a
  // find, but only the kinds the engine actually carries today, so it never claims to look for something it
  // doesn't (checked against patterns.js's own ids, never hardcoded as a promise).
  const CLEAN_GROUPS = [
    { word: "ws.cleanPasswords", ids: ["password"] },
    {
      word: "ws.cleanKeys",
      ids: [
        "private_key",
        "aws_access_key",
        "github_token",
        "stripe_secret_key",
        "anthropic_key",
        "openai_key",
        "google_api_key",
        "slack_token",
        "service_token",
        "connection_string",
        "jwt",
      ],
    },
    { word: "ws.cleanCards", ids: ["credit_card", "card_code", "gift_card", "bank_account"] },
    {
      word: "ws.cleanIds",
      ids: ["us_ssn", "national_id", "medicare_id", "passport", "drivers_license", "insurance_id", "vin", "student_id"],
    },
    { word: "ws.cleanCodes", ids: ["otp_secret"] },
    { word: "ws.cleanSeed", ids: ["crypto_secret"] },
    { word: "ws.cleanPhoto", ids: ["photo_location"] },
  ];
  function cleanList() {
    const known = new Set((C.PATTERNS || []).map((p) => p.id));
    return CLEAN_GROUPS.filter((g) => g.ids.some((id) => known.has(id))).map((g) => W.t(g.word));
  }

  // How far through, as a thin bar over the trace map: hidden until the count is in, so it never shows a guess.
  function setProgress(progress) {
    $("scan-progress").hidden = progress == null;
    if (progress != null) $("scan-progress-fill").style.setProperty("--p", String(Math.min(1, progress)));
  }

  // The kind Results names first for a file (its own dominantType), in the same words.
  function kindOf(found) {
    const id = globalThis.ClotrResults?.dominantType(found);
    return id ? kindName(id) : "";
  }
  function mountTrace() {
    const T = globalThis.ClotrTrace;
    if (trace || !T || !$("trace")) return;
    trace = T.WebView($("trace"), {
      t: (...a) => W.t(...a),
      fmt,
      folderName: prettyFolder,
      kindOf,
      crumb: $("stage-where"),
    });
  }
  function traceState(file) {
    const worth = (f) => Boolean(globalThis.ClotrResults?.isWorthALook(f));
    return globalThis.ClotrTrace.classify(file, worth);
  }

  function setPhases(now) {
    const lis = document.querySelectorAll("#phases li");
    lis.forEach((li, i) => {
      li.classList.toggle("now", i === now);
      li.classList.toggle("did", i < now || now === 2);
    });
  }

  // Only ever the kind the person picked: an unknown one leaves the current pick as it was, never quietly
  // swapped for Quick.
  function selectPick(next) {
    if (!PICKS.includes(next)) return;
    kind = next;
    for (const b of document.querySelectorAll("#scan-pick .pick")) {
      const checked = b.dataset.kind === kind;
      b.setAttribute("aria-checked", String(checked));
      b.tabIndex = checked ? 0 : -1;
    }
    const isLookback = kind === "lookback";
    $("scan-stage").hidden = isLookback;
    $("lookback-flow").hidden = !isLookback;
    if (isLookback) {
      globalThis.ClotrLookback?.show();
    } else {
      globalThis.ClotrLookback?.hide();
      // A finished or stopped run gives way to the newly picked kind; its finds are already on Results.
      if (state !== "running" && state !== "stopping") resetStage();
    }
  }

  // Found so far, grouped the way Results groups (found-feed.js), so a big scan reads as a few folds, not a wall.
  function addFeedItem(file) {
    const words = globalThis.ClotrFoundFeed?.add($("feed-list"), file) ?? describeFound(file.found);
    $("feed-none").hidden = true;
    say(W.t("ws.foundItem", file.name, words));
  }

  function fullScanDate(at = fullScan.at) {
    return new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium" }).format(new Date(at));
  }

  // What a Quick scan covers right now, in one line: since the last Full scan, or (before any) its floor alone.
  function quickReach() {
    const reach = fullScan ? W.t("ws.quickSince", fullScanDate()) : W.t("ws.quickNoFull");
    return leavesOut ? `${reach} ${W.t("ws.scanLeavesOut")}` : reach;
  }

  // A Full scan, before it starts: the first one says plainly it can take hours, and a later one that it reads only
  // what changed unless the person picks Read everything again.
  function fullReach() {
    const reach = fullScan ? W.t("ws.fullSince", fullScanDate()) : W.t("ws.fullFirst");
    return leavesOut ? `${reach} ${W.t("ws.scanLeavesOut")}` : reach;
  }

  function resetStage() {
    clearInterval(timeTimer);
    timeTimer = null;
    $("scan-stage").dataset.state = "idle";
    setProgress(null);
    trace?.idle();
    $("stage-title").textContent = W.t("ws.ready");
    $("stage-sub").textContent = kind === "quick" ? quickReach() : kind === "full" ? fullReach() : W.t("ws.readySub");
    $("full-offer").hidden = kind !== "quick" || fullScan != null;
    $("scan-full-all").hidden = kind !== "full" || fullScan == null;
    $("projects-note").hidden = true;
    $("st-files").textContent = "0";
    $("st-found").textContent = "0";
    $("st-time").textContent = "0:00";
    $("st-left-row").hidden = true;
    $("stage-looking").hidden = true;
    $("stage-where").textContent = "";
    $("clean-list").hidden = true;
    $("clean-limits").hidden = true;
    $("clean-next").hidden = true;
    $("weekly-offer").hidden = true;
    setPhases(-1);
    // "Folders I choose" in two steps: the picker first, then the chosen folders by name with their own Start,
    // so a pick never starts a scan the person didn't see coming, and the button always says what it does next.
    const chosen = kind === "chosen" && chosenNames.length > 0;
    $("chosen-folders").hidden = !chosen;
    $("chosen-names").textContent = chosen ? W.t("ws.chosen", listOf(chosenNames)) : "";
    $("scan-rechoose").hidden = !chosen;
    $("scan-start").textContent = startWords();
    $("scan-start").hidden = false;
    $("scan-stop").hidden = true;
    $("scan-stop").disabled = false;
    $("scan-see").hidden = true;
    $("scan-again").hidden = true;
    $("scan-pick").hidden = false;
    $("feed").hidden = true;
    $("feed-list").replaceChildren();
    $("feed-title").textContent = W.t("ws.soFar");
    $("feed-none").hidden = false;
    state = "idle";
  }

  function listOf(names) {
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(names);
  }
  function startWords() {
    if (kind === "chosen") return W.t(chosenNames.length ? "ws.scanChosen" : "ws.chooseFolders");
    return W.t(kind === "full" ? "ws.runFull" : "ws.runQuick");
  }

  async function onStart() {
    if (kind === "chosen" && !chosenNames.length) {
      await pickFolders();
      return;
    }
    startScan();
  }

  // Windows' own folder picker. The chosen folders show by name with a Start button; closing the picker without
  // a choice leaves the screen exactly as it was.
  async function pickFolders() {
    const names = await call("scan_pick_folders");
    if (!names.length) return;
    chosenNames = names;
    resetStage();
    say(W.t("ws.chosen", listOf(names)));
  }

  // A start that fails (the picker, or a command refused before any file was counted) says so in words, the same
  // way a run that stops early does, never a silent jump back to the idle screen.
  function failStart(err) {
    resetStage();
    const errKind = typeof err === "string" ? err : err?.name || "error";
    console.warn("[Clotr]", "a scan couldn't start:", errKind);
    $("stage-title").textContent = W.t("ws.startFailed");
    $("stage-sub").textContent = W.t("ws.startFailedSub");
    say(W.t("ws.startFailed"));
  }

  const KIND_WORD = { quick: "ws.quick", full: "ws.full", chosen: "ws.folders" };

  function startScan(again = false) {
    run = ClotrScan();
    state = "running";
    announcedQuarter = 0;
    $("scan-stage").dataset.state = "running";
    trace?.begin();
    $("scan-start").hidden = true;
    $("scan-stop").hidden = false;
    $("scan-pick").hidden = true;
    $("full-offer").hidden = true;
    $("scan-full-all").hidden = true;
    $("projects-note").hidden = true;
    $("feed").hidden = false;
    $("feed-list").replaceChildren();
    $("feed-none").hidden = false;
    $("feed-title").textContent = W.t("ws.soFar");
    say(W.t("ws.started", W.t(KIND_WORD[kind])));
    readRun(again).catch(failRun);
  }

  // A run that throws instead of finishing or being stopped: resetStage() already clears every timer, so the
  // time can't keep climbing behind a screen that looks idle. The person hears plainly that nothing changed and
  // can just try again; the console names only the kind of failure (an error's own name, or the plain word Tauri
  // already gives a rejected command, like "locked") -- never a path or a value.
  function failRun(err) {
    resetStage();
    const errKind = typeof err === "string" ? err : err?.name || "error";
    console.warn("[Clotr]", "a scan stopped early:", errKind);
    $("stage-title").textContent = W.t("ws.failed");
    $("stage-sub").textContent = W.t("ws.failedSub");
    say(W.t("ws.failed"));
  }

  function onStop() {
    if (state !== "running") return;
    state = "stopping";
    $("scan-stop").disabled = true;
    run?.cancel();
  }

  // The progress reads off a second walk that only counts names and sizes (scan.rs): until it's through, the screen
  // says how many files it has read so far and that the rest is still being counted, and only then shows a share
  // and the time left, so a Full scan of a whole drive never shows a guess as a number.
  async function readRun(again) {
    setPhases(0);
    $("stage-title").textContent = W.t("ws.counting");
    $("stage-sub").textContent = "";
    say(W.t("ws.counting"));
    began = performance.now();

    const started = await run.start(kind, again);
    fullScan = started.fullScan;
    since = started.since;
    generation = started.generation;
    lastFiles = [];
    if (state !== "running") {
      await run.end(false).catch(() => {});
      finish({
        filesTotal: 0,
        filesRead: 0,
        foundCount: 0,
        projectFinds: 0,
        seconds: 0,
        counts: {},
        counted: false,
        stopped: true,
      });
      return;
    }

    setPhases(1);
    $("stage-title").textContent = W.t("ws.readingSoFar", fmt(0));
    // A Full scan of a whole PC runs a long time, so it says the PC is still the person's to use meanwhile.
    const keepUsing = kind === "full" ? ` ${W.t("ws.fullKeepUsing")}` : "";
    $("stage-sub").textContent = W.t("ws.stillCounting") + keepUsing;
    $("stage-looking").hidden = false;
    timeTimer = setInterval(() => {
      $("st-time").textContent = clock(Math.round((performance.now() - began) / 1000));
    }, 250);

    let total = { files: 0, bytes: 0, counted: false };
    let bytesRead = 0;
    const eta = globalThis.ClotrEta.create(); // eta.js: what's left over the recent read rate
    let filesRead = 0;
    let filesEarlier = 0; // unchanged, read again only because it was worth a look last time
    let foundCount = 0;
    let projectFinds = 0; // in code projects: on Results under their own heading, never in the headline count
    const reasons = { locked: 0, scan: 0, damaged: 0 };
    const show = () => {
      $("st-files").textContent = fmt(filesRead);
      const filesTotal = total.counted ? Math.max(total.files, filesRead) : 0;
      const bytesTotal = total.counted ? Math.max(total.bytes, bytesRead) : 0;
      const secondsLeft = eta.update(
        performance.now(),
        { bytes: bytesRead, files: filesRead },
        { bytes: bytesTotal, files: filesTotal, counted: total.counted },
      );
      if (!total.counted) {
        $("stage-title").textContent = W.t("ws.readingSoFar", fmt(filesRead));
        $("st-left-row").hidden = false;
        $("st-left").textContent = W.t("ws.timeLeftCounting");
        return;
      }
      const progress = bytesTotal ? bytesRead / bytesTotal : filesTotal ? filesRead / filesTotal : 1;
      setProgress(progress);
      $("stage-title").textContent = W.t("ws.reading", fmt(filesRead), fmt(filesTotal));
      // Until the estimate has settled it says it's still working one out, rather than guessing out loud.
      $("st-left-row").hidden = false;
      $("st-left").textContent =
        secondsLeft == null ? W.t("ws.timeLeftWorking") : W.t("ws.timeLeft", globalThis.ClotrEta.clock(secondsLeft));
      const quarter = Math.floor(progress * 4);
      if (quarter > announcedQuarter && quarter < 4) {
        announcedQuarter = quarter;
        say(W.t("ws.reading", fmt(filesRead), fmt(filesTotal)));
      }
    };
    const result = await run.readAll(
      (file) => {
        filesRead++;
        if (file.earlier) filesEarlier++;
        // What the check actually read (a photo's head, not the whole photo), the same measure the count used.
        bytesRead += file.reads ?? file.size ?? 0;
        if (file.reason) reasons[file.reason] = (reasons[file.reason] || 0) + 1;
        if (trace) trace.done(file, traceState(file));
        show();
        // Count only what's worth a look (4-1): a file with only lemon finds (an email, a phone number) still
        // reads and still shows on Results, folded away, but it never inflates the feed or the headline.
        if (!file.found || !Object.keys(file.found).length) return;
        if (globalThis.ClotrFindings?.groupOf(file) === "projects") {
          projectFinds++; // under their own heading on Results, never in the headline count
          return;
        }
        if (globalThis.ClotrResults?.isWorthALook(file)) {
          foundCount++;
          $("st-found").textContent = fmt(foundCount);
          addFeedItem(file);
        }
      },
      (batch) => {
        const wasCounted = total.counted;
        total = batch.total || total;
        if (total.counted && !wasCounted) $("stage-sub").textContent = W.t("ws.readingSub") + keepUsing;
        show();
      },
      (file) => trace?.started(file),
    );
    lastFiles = result.files;

    clearInterval(timeTimer);
    const seconds = Math.round((performance.now() - began) / 1000);
    const stopped = state === "stopping" || !result.completed;
    const ended = await run.end(!stopped, result.unread, result.flagged).catch(() => null);
    if (ended) fullScan = ended.fullScan ?? null;
    finish({
      filesTotal: total.counted ? Math.max(total.files, filesRead) : filesRead,
      filesRead,
      filesEarlier,
      foundCount,
      projectFinds,
      seconds,
      counts: result.counts,
      counted: total.counted,
      reasons,
      stopped,
    });
  }

  // What wasn't read, every time (4.3): the walker's own counts (online-only, too big) plus what the read
  // itself found out it couldn't open (locked, a scan with no words, damaged), as one honest list -- never
  // folded into "nothing found", and never printed as "0 are damaged" for a reason that never came up.
  function notReadSentence(counts, reasons) {
    const clauses = [
      [counts.onlineOnly || 0, "ws.nrOnlineOne", "ws.nrOnline"],
      [counts.tooBig || 0, "ws.nrBigOne", "ws.nrBig"],
      [reasons.locked || 0, "ws.nrLockedOne", "ws.nrLocked"],
      [reasons.scan || 0, "ws.nrScanOne", "ws.nrScan"],
      [reasons.damaged || 0, "ws.nrDamagedOne", "ws.nrDamaged"],
    ]
      .filter(([n]) => n)
      .map(([n, oneKey, manyKey]) => W.t(n === 1 ? oneKey : manyKey, fmt(n)));
    if (!clauses.length) return "";
    const total =
      (counts.onlineOnly || 0) +
      (counts.tooBig || 0) +
      (reasons.locked || 0) +
      (reasons.scan || 0) +
      (reasons.damaged || 0);
    const list = new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(clauses);
    return W.t("ws.notRead", fmt(total), list);
  }

  // What a scan left out on purpose, in one line, with the way to change it beside it: code projects, files made
  // to hold a key or password, password vaults, installed programs and games, the places apps keep their own
  // caches, logs and AI tools' history, and the rest of AppData besides. "" when it left out none.
  function leftOutLine(counts) {
    const parts = [];
    const projects = counts.codeProjects || 0;
    const files = counts.projectFiles || 0;
    if (projects) {
      const words = projects === 1 ? W.t("ws.projectOne") : W.t("ws.projectN", fmt(projects));
      parts.push(
        files
          ? W.t(
              "ws.projectsWithFiles",
              words,
              files === 1 ? W.t("ws.projectFileOne") : W.t("ws.projectFileN", fmt(files)),
            )
          : words,
      );
    }
    for (const [n, one, many] of [
      [counts.secretFiles || 0, "ws.secretOne", "ws.secretN"],
      [counts.vaults || 0, "ws.vaultOne", "ws.vaultN"],
      [counts.programs || 0, "ws.programOne", "ws.programN"],
      [counts.appData || 0, "ws.appDataOne", "ws.appDataN"],
      [counts.appStorage || 0, "ws.appStorageOne", "ws.appStorageN"],
    ]) {
      if (n) parts.push(n === 1 ? W.t(one) : W.t(many, fmt(n)));
    }
    return parts.length ? W.t("ws.leftOutScan", listOf(parts)) : "";
  }

  // How much a finished run read and how long it took. A Full that read only what changed since the last complete
  // one says so, with that one's date, so a short run never reads as the whole PC; `filesEarlier` of those weren't
  // actually new or changed, only re-read because they were worth a look last time, so they're named in
  // their own sentence rather than inflating "changed".
  function doneSub(filesTotal, filesEarlier, seconds) {
    if (kind === "full" && since != null) {
      const date = fullScanDate(since);
      const changed = filesTotal - filesEarlier;
      let sub = !changed
        ? W.t("ws.doneSubSinceNone", date)
        : changed === 1
          ? W.t("ws.doneSubSinceOne", date, clock(seconds))
          : W.t("ws.doneSubSince", fmt(changed), date, clock(seconds));
      if (filesEarlier) {
        sub = `${sub} ${filesEarlier === 1 ? W.t("ws.alsoCheckedOne") : W.t("ws.alsoCheckedN", fmt(filesEarlier))}`;
      }
      return sub;
    }
    return filesTotal === 1
      ? W.t("ws.doneSubFilesOne", clock(seconds))
      : W.t("ws.doneSubFiles", fmt(filesTotal), clock(seconds));
  }

  function finish({
    filesTotal,
    filesRead,
    filesEarlier = 0,
    foundCount,
    projectFinds = 0,
    seconds,
    counts,
    counted = true,
    reasons = {},
    stopped,
  }) {
    clearInterval(timeTimer);
    state = stopped ? "stopped" : "done";
    $("scan-stage").dataset.state = state;
    trace?.end(stopped);
    $("scan-stop").hidden = true;
    $("scan-again").hidden = false;
    // The picks come back, so the next scan can be another kind (a Quick one right after a Full one).
    $("scan-pick").hidden = false;
    $("stage-where").textContent = "";
    $("stage-looking").hidden = true;
    $("st-left-row").hidden = true;

    let title;
    let sub;
    if (stopped) {
      title = foundCount ? W.t("ws.stopped", thingWords(foundCount)) : W.t("ws.stoppedNone");
      sub = counted ? W.t("ws.stoppedSub", fmt(filesRead), fmt(filesTotal)) : W.t("ws.stoppedSubSoFar", fmt(filesRead));
      const notRead = notReadSentence(counts, reasons);
      if (notRead) sub = `${sub} ${notRead}`;
      $("scan-see").hidden = true;
      $("feed-title").textContent = W.t("ws.soFar");
    } else {
      setProgress(counted ? 1 : null);
      $("st-files").textContent = fmt(filesRead);
      $("st-time").textContent = clock(seconds);
      setPhases(2);
      title = foundCount
        ? W.t("ws.done", thingWords(foundCount))
        : filesTotal === 1
          ? W.t("ws.doneNoneOne")
          : W.t("ws.doneNone", fmt(filesTotal));
      sub = doneSub(filesTotal, filesEarlier, seconds);
      const notRead = notReadSentence(counts, reasons);
      if (notRead) sub = `${sub} ${notRead}`;
      if (counts.cappedFiles) sub = `${sub} ${W.t("ws.cap")}`;
      if (projectFinds) {
        sub = `${sub} ${projectFinds === 1 ? W.t("ws.projectFindsOne") : W.t("ws.projectFinds", fmt(projectFinds))}`;
      }
      // A Quick scan before any Full one says what it covered and offers the Full one, every time it finishes.
      if (kind === "quick" && !fullScan) sub = `${sub} ${W.t("ws.quickNoFull")}`;
      $("full-offer").hidden = kind !== "quick" || fullScan != null;
      const seen = foundCount + projectFinds;
      $("scan-see").hidden = seen === 0;
      $("scan-see").textContent = seen === 1 ? W.t("ws.seeOne") : W.t("ws.seeN", fmt(seen));
      $("feed-title").textContent = foundCount ? W.t("ws.found") : W.t("ws.soFar");
      // A clean moment that shows its work: the calm tick, the ticked list of what Clotr looked
      // for, the honest-limits line Look back's own limits list already says, and one next step.
      $("clean-list").hidden = foundCount !== 0;
      $("clean-limits").hidden = foundCount !== 0;
      $("clean-next").hidden = foundCount !== 0;
      if (foundCount === 0) {
        $("clean-list").replaceChildren(
          ...cleanList().map((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            return li;
          }),
        );
      }
    }
    $("stage-title").textContent = title;
    $("stage-sub").textContent = sub;
    // A Full that read only what changed keeps Read everything again in plain sight, stopped or not.
    const changedOnly = kind === "full" && since != null;
    $("scan-full-all").hidden = !changedOnly;
    // What it left out on purpose, whatever it found, and where to change that.
    const left = leftOutLine(counts || {});
    $("projects-note").hidden = !left;
    $("projects-text").textContent = left;
    say(`${title}.`);
    const meta = {
      kind,
      counts,
      since: changedOnly ? since : null,
      generation,
      filesRead: filesRead - filesEarlier,
      filesEarlier,
    };
    globalThis.ClotrResults?.setFiles(lastFiles, meta);
    // History's own row for this run: when, which scan, how many files it read and how many of each kind it
    // found. Only History redraws from it (the fresh view), so a run never waits on the write to finish.
    const row = { t: Date.now(), scan: kind, items: filesRead, seconds, counts: kindCounts(lastFiles) };
    call("record_scan", { row })
      .then((next) => {
        globalThis.ClotrHistory?.draw(next);
        globalThis.ClotrScanScreen?.draw(next, lang);
        const recorded = next.scans?.[next.scans.length - 1];
        if (SCAN_TIMES_ENABLED && (recorded?.added || recorded?.gone)) {
          const kinds = new Map(C.PATTERNS.map((pattern) => [pattern.id, pattern.name]));
          const added = globalThis.ClotrHistory.foundLabel(recorded.added, kinds, {
            t: W.t,
            lang: document.documentElement.lang,
          });
          const gone = globalThis.ClotrHistory.foundLabel(recorded.gone, kinds, {
            t: W.t,
            lang: document.documentElement.lang,
          });
          $("stage-sub").textContent = `${$("stage-sub").textContent} ${W.t("ws.scanChangeSummary", added, gone)}`;
        }
        // Offer the weekly check after the first scan (4-6): one line, once, only on a real finish the person
        // is looking at -- never the hidden weekly run itself, and never again once there's a second row.
        if (!globalThis.ClotrWeeklyCheck?.active && next.scans?.length === 1) showWeeklyOffer();
      })
      .catch(() => {});
    // The weekly check, run with nobody watching: main.js set this flag before calling startQuick(), and
    // weekly_check_done is how main.rs hears this run is over. Only the files actually worth a look (4-1) are
    // sent, so a repeat email address can never read as a "new" find; the fingerprinting itself happens in
    // Rust, by path, since this page never has one.
    if (globalThis.ClotrWeeklyCheck?.active) {
      const worthALook = lastFiles.filter((f) => f.found && globalThis.ClotrResults?.isWorthALook(f));
      const payload = worthALook.map((f) => ({ index: f.index, kinds: Object.keys(f.found) }));
      call("weekly_check_done", { files: payload })
        .then((r) => globalThis.ClotrResults?.setFiles(lastFiles, { ...meta, newIndexes: r.newIndices }))
        .catch(() => {});
    }
  }

  // The weekly check's own offer (4-6): "Check again every week?", once, at the end of the first scan; a yes or
  // a no both save the setting and hide the line for good (Settings' own switch stays the only way to change it
  // after that).
  let saveSettings = null;
  function showWeeklyOffer() {
    const offer = $("weekly-offer");
    if (offer) offer.hidden = false;
  }
  function answerWeeklyOffer(on) {
    $("weekly-offer").hidden = true;
    saveSettings?.({ weeklyCheck: on });
  }

  function wirePicks() {
    const items = [...document.querySelectorAll("#scan-pick .pick")];
    items.forEach((item, i) => {
      item.addEventListener("click", () => selectPick(item.dataset.kind));
      item.addEventListener("keydown", (e) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = items[(i + step + items.length) % items.length];
        next.focus();
        next.click();
      });
    });
  }

  function drawLastRuns(rows = []) {
    for (const scan of PICKS) {
      const node = document.querySelector?.(`[data-last-scan="${scan}"]`);
      if (!node) continue;
      node.hidden = !SCAN_TIMES_ENABLED;
      if (SCAN_TIMES_ENABLED) {
        const row = [...rows].reverse().find((item) => item.scan === scan);
        const when = new Intl.DateTimeFormat(document.documentElement.lang, {
          dateStyle: "medium",
          timeStyle: "short",
        });
        node.textContent = lastRunText(row, when);
      } else {
        node.textContent = "";
      }
    }
  }

  function draw(view, locale) {
    const relabel = lang !== locale;
    lang = locale;
    if (relabel) trace?.relabel();
    if (view && "fullScan" in view) fullScan = view.fullScan;
    if (view?.settings) leavesOut = view.settings.scanDevFiles !== true;
    drawLastRuns(view?.scans || []);
    if (state === "idle") resetStage();
  }

  function duration(seconds) {
    if (!Number.isFinite(Number(seconds))) return W.t("ws.scanRowNoTime");
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return value < 60
      ? W.t("ws.scanRowSeconds", String(value))
      : W.t("ws.scanRowMinutes", String(Math.floor(value / 60)));
  }

  function lastRunText(row, when) {
    if (!row) return W.t("ws.neverRan");
    const date = when.format(new Date(row.t));
    const age = Date.now() - row.t;
    const base = W.t("ws.lastRan", date, String(row.items), duration(row.seconds));
    return age >= 30 * 86_400_000 ? `${base} ${W.t("ws.runAgainWhenReady")}` : base;
  }

  function wire({ save } = {}) {
    saveSettings = save || null;
    mountTrace();
    wirePicks();
    resetStage();
    $("scan-start").addEventListener("click", () => onStart().catch(failStart));
    $("scan-rechoose").addEventListener("click", () => pickFolders().catch(failStart));
    $("scan-stop").addEventListener("click", onStop);
    $("clean-lookback").addEventListener("click", () => selectPick("lookback"));
    $("weekly-offer-yes").addEventListener("click", () => answerWeeklyOffer(true));
    $("weekly-offer-no").addEventListener("click", () => answerWeeklyOffer(false));
    $("scan-again").addEventListener("click", () => {
      resetStage();
      startScan();
    });
    $("scan-full-all").addEventListener("click", () => {
      if (state === "running" || state === "stopping") return;
      startScan(true);
    });
    // Leave out, from the scan screen: Settings, scrolled to its card.
    for (const id of ["scan-leave-link", "projects-change"]) {
      $(id).addEventListener("click", () => {
        requestAnimationFrame(() => {
          const card = $("leave-title");
          card?.scrollIntoView?.({ block: "start" });
          card?.focus?.();
        });
      });
    }
    $("scan-offer-full").addEventListener("click", () => {
      if (state === "running" || state === "stopping") return;
      selectPick("full");
      resetStage();
      startScan();
    });
  }

  // Home's "Run a quick scan", the Check my files tile and the tray's own "Run a quick scan": all land on the
  // Scan screen and start a Quick scan there, unless one is already running. A finished or stopped run's screen
  // gives way to the new one rather than swallowing the click.
  function startQuick() {
    if (state === "running" || state === "stopping") return;
    selectPick("quick");
    resetStage();
    onStart().catch(failStart);
  }

  // Results' Read everything again: its link lands on the Scan screen, and this starts a Full there that reads every
  // file once more, unless a run is already going.
  function readEverything() {
    if (state === "running" || state === "stopping") return;
    selectPick("full");
    resetStage();
    startScan(true);
  }

  // Home's Look back tile: lands on the Scan screen and selects its pick there, same as startQuick above.
  function startLookback() {
    selectPick("lookback");
  }

  globalThis.ClotrScanScreen = {
    draw,
    drawLastRuns,
    wire,
    select: selectPick,
    startQuick,
    startLookback,
    readEverything,
    kindCounts,
    notReadSentence,
    cleanList,
  };
  ClotrScan.poolSize = poolSize;
  globalThis.ClotrScan = ClotrScan;
})();
