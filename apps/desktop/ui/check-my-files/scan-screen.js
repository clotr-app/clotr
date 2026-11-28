// Clotr for Windows — Check my files: connects the walker
// (scan_start/scan_batch/scan_next/scan_end/scan_cancel, scan_commands.rs) and the reader (scan-worker.js). The page
// never sees a path: scan_batch hands over the next few files' display details (name, folder, kind, size) and
// an index each; this reads each file's bytes by that index, carries them to one of several workers, and
// brings back its kinds and counts. Only the files with finds stay here, so a scan of a whole drive holds no
// more than a couple of batches at a time. The Scan screen itself (the trace map in scan-map-drawing.js, the feed, the
// steps) draws on top of this; this is the wiring underneath it, kept only in memory: nothing here is written
// anywhere, and a cancelled or finished run's list disappears with the page.
"use strict";

(() => {
  const W = globalThis.ClotrWords;
  const SCAN_TIMES_ENABLED = globalThis.ClotrDesktopFeatures?.scanTimes === true;
  const C = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);
  const { call } = globalThis.ClotrApp;
  const { ClotrScan } = globalThis;
  const { hasFinds } = globalThis.ClotrScan;

  // ---------- The Scan screen ----------

  // Choose a Quick scan, a Full scan, Folders I choose or Look back, the trace map, the counts, the steps,
  // the feed of what's found so far, and Stop. Results gets only a plain, honest summary.

  const PICKS = ["quick", "full", "chosen", "lookback"];

  let lang = "en";
  let kind = "quick";
  let run = null; // the in-flight ClotrScan(), while running or stopping
  let state = "idle"; // idle | running | stopping | done | stopped
  let announcedQuarter = 0;
  let timeTimer = null;
  let began = 0;
  let trace = null; // the trace map's view (scan-map-drawing.js), once the screen is wired
  let lastFiles = []; // the last finished run's files with finds (ClotrScan's readAll)
  let fullScan = null; // the last Full scan's `{ at, files }` (`again` if an older version made it), or null
  let since = null; // the running scan reads only what changed since this time (scan_start's `since`), or null
  let generation = null; // the current run's id, attached to its Results actions
  let leavesOut = true; // code projects and secret files left out, unless Settings' developer switch is on
  let chosenNames = []; // "Folders I choose": the picked folders' own names (their paths stay in Rust)

  function isBusy() {
    return state === "running" || state === "stopping";
  }

  // ---------- Words ----------

  function fmt(number) {
    return Number(number).toLocaleString(lang === "en" ? "en-US" : "es-ES");
  }

  function clock(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function say(words) {
    $("scan-live").textContent = words;
  }

  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }

  function thingWords(count) {
    return count === 1 ? W.t("ws.thing", fmt(count)) : W.t("ws.things", fmt(count));
  }

  function listOf(names) {
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(names);
  }

  // Every file's own finds, summed into one row's worth of counts for History: never a name, a folder or a
  // detected value, only how many of each kind across the whole run.
  function kindCounts(files) {
    const out = {};
    for (const file of files) {
      for (const [id, count] of Object.entries(file.found || {})) out[id] = (out[id] || 0) + count;
    }
    return out;
  }

  function kindName(id) {
    const found = (C.PATTERNS || []).find((pattern) => pattern.id === id);
    return found ? found.name : id;
  }

  function describeFound(found) {
    const parts = Object.entries(found || {}).map(([id, count]) =>
      count > 1 ? `${kindName(id)} (${fmt(count)})` : kindName(id),
    );
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(parts);
  }

  // A clean moment's own ticked list: grouped the same way the browser's own warning groups a
  // find, but only the kinds the engine actually carries today, so it never claims to look for something it
  // doesn't (checked against rule-table.js's own ids, never hardcoded as a promise).
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
    const known = new Set((C.PATTERNS || []).map((pattern) => pattern.id));
    return CLEAN_GROUPS.filter((group) => group.ids.some((id) => known.has(id))).map((group) => W.t(group.word));
  }

  // ---------- The stage's parts ----------

  // How far through, as a thin bar over the trace map: hidden until the count is in, so it never shows a
  // guess.
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
    const traceModule = globalThis.ClotrTrace;
    if (trace || !traceModule || !$("trace")) return;
    trace = traceModule.WebView($("trace"), {
      t: (...args) => W.t(...args),
      fmt,
      folderName: prettyFolder,
      kindOf,
      crumb: $("stage-where"),
    });
  }

  function traceState(file) {
    const worth = (shown) => Boolean(globalThis.ClotrResults?.isWorthALook(shown));
    return globalThis.ClotrTrace.classify(file, worth);
  }

  function setPhases(now) {
    const items = document.querySelectorAll("#phases li");
    items.forEach((item, i) => {
      item.classList.toggle("now", i === now);
      item.classList.toggle("did", i < now || now === 2);
    });
  }

  // Only ever the kind the person picked: an unknown one leaves the current pick as it was, never quietly
  // swapped for Quick.
  function selectPick(next) {
    if (!PICKS.includes(next)) return;
    kind = next;
    for (const pick of document.querySelectorAll("#scan-pick .pick")) {
      const checked = pick.dataset.kind === kind;
      pick.setAttribute("aria-checked", String(checked));
      pick.tabIndex = checked ? 0 : -1;
    }
    const isLookback = kind === "lookback";
    $("scan-stage").hidden = isLookback;
    $("lookback-flow").hidden = !isLookback;
    if (isLookback) {
      globalThis.ClotrLookback?.show();
      return;
    }
    globalThis.ClotrLookback?.hide();
    // A finished or stopped run gives way to the newly picked kind; its finds are already on Results.
    if (!isBusy()) resetStage();
  }

  // Found so far, grouped the way Results groups (found-so-far.js), so a big scan reads as a few folds, not a
  // wall.
  function addFeedItem(file) {
    const words = globalThis.ClotrFoundFeed?.add($("feed-list"), file) ?? describeFound(file.found);
    $("feed-none").hidden = true;
    say(W.t("ws.foundItem", file.name, words));
  }

  // ---------- What each scan covers ----------

  function fullScanDate(at = fullScan.at) {
    return new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium" }).format(new Date(at));
  }

  // Whether scans go by the last Full scan's record and read only what's new or changed: not before the first
  // one, and not while that record is one an older version made, since Clotr reads more kinds of files now.
  function hasRecord() {
    return fullScan != null && !fullScan.again;
  }

  // Why a Quick scan reads all of its floor: no Full scan yet, or only one an older version made.
  function quickInFull() {
    return W.t(fullScan ? "ws.quickAgain" : "ws.quickNoFull");
  }

  function withLeavesOut(reach) {
    return leavesOut ? `${reach} ${W.t("ws.scanLeavesOut")}` : reach;
  }

  // What a Quick scan covers right now, in one line: since the last Full scan, or all of its floor and why.
  function quickReach() {
    const reach = hasRecord() ? W.t("ws.quickSince", fullScanDate()) : quickInFull();
    return withLeavesOut(reach);
  }

  // A Full scan, before it starts: the first one says plainly it can take hours, one after an older version's
  // says why it reads everything again, and a later one that it reads only what changed unless the person
  // picks Read everything again.
  function fullReach() {
    if (hasRecord()) return withLeavesOut(W.t("ws.fullSince", fullScanDate()));
    return withLeavesOut(W.t(fullScan ? "ws.fullAgain" : "ws.fullFirst"));
  }

  function readyWords() {
    if (kind === "quick") return quickReach();
    if (kind === "full") return fullReach();
    return W.t("ws.readySub");
  }

  function startWords() {
    if (kind === "chosen") return W.t(chosenNames.length ? "ws.scanChosen" : "ws.chooseFolders");
    return W.t(kind === "full" ? "ws.runFull" : "ws.runQuick");
  }

  // ---------- The stage, ready ----------

  function resetStage() {
    clearInterval(timeTimer);
    timeTimer = null;
    $("scan-stage").dataset.state = "idle";
    setProgress(null);
    trace?.idle();
    $("stage-title").textContent = W.t("ws.ready");
    $("stage-sub").textContent = readyWords();
    $("full-offer").hidden = kind !== "quick" || hasRecord();
    $("scan-full-all").hidden = kind !== "full" || !hasRecord();
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
    // "Folders I choose" in two steps: the picker first, then the chosen folders by name with their own
    // Start, so a pick never starts a scan the person didn't see coming, and the button always says what it
    // does next.
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

  // ---------- Starting and stopping ----------

  async function onStart() {
    if (kind === "chosen" && !chosenNames.length) {
      await pickFolders();
      return;
    }
    startScan();
  }

  // Windows' own folder picker. The chosen folders show by name with a Start button; closing the picker
  // without a choice leaves the screen exactly as it was.
  async function pickFolders() {
    const names = await call("scan_pick_folders");
    if (!names.length) return;
    chosenNames = names;
    resetStage();
    say(W.t("ws.chosen", listOf(names)));
  }

  // The kind of failure only: an error's own name, or the plain word Tauri gives a rejected command.
  function errorKind(err) {
    return typeof err === "string" ? err : err?.name || "error";
  }

  // A start that fails (the picker, or a command refused before any file was counted) says so in words, the
  // same way a run that stops early does, never a silent jump back to the idle screen.
  function failStart(err) {
    resetStage();
    console.warn("[Clotr]", "a scan couldn't start:", errorKind(err));
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
  // time can't keep climbing behind a screen that looks idle. The person hears plainly that nothing changed
  // and can just try again; the console names only the kind of failure (an error's own name, or the plain
  // word Tauri already gives a rejected command, like "locked") -- never a path or a value.
  function failRun(err) {
    resetStage();
    console.warn("[Clotr]", "a scan stopped early:", errorKind(err));
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

  // ---------- Reading a run ----------

  // A run's own counts while it reads: what it has read, what it found, and what the walk has counted so far.
  function newRunTally() {
    return {
      total: { files: 0, bytes: 0, counted: false },
      bytesRead: 0,
      filesRead: 0,
      filesEarlier: 0, // unchanged, read again only because it was worth a look last time
      foundCount: 0,
      projectFinds: 0, // in code projects: on Results under their own heading, never in the headline count
      reasons: { locked: 0, scan: 0, damaged: 0, partial: 0, broke: 0 },
    };
  }

  // The time left reads "working it out" until the estimate has settled, rather than guessing out loud.
  function timeLeftWords(secondsLeft) {
    if (secondsLeft == null) return W.t("ws.timeLeftWorking");
    return W.t("ws.timeLeft", globalThis.ClotrEta.clock(secondsLeft));
  }

  function showRunProgress(tally, eta) {
    const { total, bytesRead, filesRead } = tally;
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
    let progress = 1;
    if (bytesTotal) progress = bytesRead / bytesTotal;
    else if (filesTotal) progress = filesRead / filesTotal;
    setProgress(progress);
    $("stage-title").textContent = W.t("ws.reading", fmt(filesRead), fmt(filesTotal));
    $("st-left-row").hidden = false;
    $("st-left").textContent = timeLeftWords(secondsLeft);
    const quarter = Math.floor(progress * 4);
    if (quarter > announcedQuarter && quarter < 4) {
      announcedQuarter = quarter;
      say(W.t("ws.reading", fmt(filesRead), fmt(filesTotal)));
    }
  }

  function countReadFile(tally, eta, file) {
    tally.filesRead++;
    if (file.earlier) tally.filesEarlier++;
    // What the check actually read (a photo's head, not the whole photo), the same measure the count used.
    tally.bytesRead += file.reads ?? file.size ?? 0;
    if (file.reason) tally.reasons[file.reason] = (tally.reasons[file.reason] || 0) + 1;
    if (file.partial) tally.reasons.partial++;
    if (trace) trace.done(file, traceState(file));
    showRunProgress(tally, eta);
    // Count only what's worth a look: a file with only lemon finds (an email, a phone number) still reads and
    // still shows on Results, folded away, but it never inflates the feed or the headline.
    if (!hasFinds(file)) return;
    if (globalThis.ClotrFindings?.groupOf(file) === "projects") {
      tally.projectFinds++; // under their own heading on Results, never in the headline count
      return;
    }
    if (!globalThis.ClotrResults?.isWorthALook(file)) return;
    tally.foundCount++;
    $("st-found").textContent = fmt(tally.foundCount);
    addFeedItem(file);
  }

  function countBatch(tally, eta, batch, keepUsing) {
    const wasCounted = tally.total.counted;
    tally.total = batch.total || tally.total;
    if (tally.total.counted && !wasCounted) $("stage-sub").textContent = W.t("ws.readingSub") + keepUsing;
    showRunProgress(tally, eta);
  }

  // Stopped before the walk began: nothing was read.
  function finishBeforeReading() {
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
  }

  // The progress reads off a second walk that only counts names and sizes (scan_run.rs): until it's through, the
  // screen says how many files it has read so far and that the rest is still being counted, and only then
  // shows a share and the time left, so a Full scan of a whole drive never shows a guess as a number.
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
      finishBeforeReading();
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

    const tally = newRunTally();
    const eta = globalThis.ClotrEta.create(); // scan-time-left.js: what's left over the recent read rate
    const result = await run.readAll(
      (file) => countReadFile(tally, eta, file),
      (batch) => countBatch(tally, eta, batch, keepUsing),
      (file) => trace?.started(file),
    );
    lastFiles = result.files;

    clearInterval(timeTimer);
    const seconds = Math.round((performance.now() - began) / 1000);
    const stopped = state === "stopping" || !result.completed;
    const ended = await run.end(!stopped, result.unread, result.flagged).catch(() => null);
    if (ended) fullScan = ended.fullScan ?? null;
    const { total, filesRead, filesEarlier, foundCount, projectFinds, reasons } = tally;
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

  // ---------- How a run ends, in words ----------

  // What wasn't read, every time: the walker's own counts (online-only, too big) plus what the read itself
  // found out it couldn't open (locked, a scan with no words, damaged) or check to the end (the engine's time
  // limit), as one list. Counted and worded in saved-summary.js, so the finish, Results and Save a summary say the
  // same thing.
  function notReadSentence(counts, reasons) {
    const summary = globalThis.ClotrSummary;
    return summary.notReadLine(summary.notReadCounts(counts, reasons), { t: W.t, lang, fmt });
  }

  // How a finished run ends, decided once for the finish, Results and Save a summary. The clean finish is
  // only for a run that read every file it counted and found nothing. A run with nothing to read is "empty",
  // unless it's a Full that read only what changed, where nothing changed is its own news.
  function endingOf({ stopped, foundCount, filesRead, notRead, changedOnly }) {
    if (stopped) return "stopped";
    if (foundCount) return "found";
    if (notRead.total) return "unread";
    if (!filesRead && !changedOnly) return "empty";
    return "clean";
  }

  // One or many of a thing, in the word list's own two forms.
  function oneOrMany(count, one, many) {
    return count === 1 ? W.t(one) : W.t(many, fmt(count));
  }

  function projectsWords(projects, files) {
    const words = oneOrMany(projects, "ws.projectOne", "ws.projectN");
    if (!files) return words;
    return W.t("ws.projectsWithFiles", words, oneOrMany(files, "ws.projectFileOne", "ws.projectFileN"));
  }

  // The rest of what a scan leaves out, by the walker's count and its two words.
  const LEFT_OUT_WORDS = [
    ["secretFiles", "ws.secretOne", "ws.secretN"],
    ["vaults", "ws.vaultOne", "ws.vaultN"],
    ["programs", "ws.programOne", "ws.programN"],
    ["appData", "ws.appDataOne", "ws.appDataN"],
    ["appStorage", "ws.appStorageOne", "ws.appStorageN"],
  ];

  // What a scan left out on purpose, in one line, with the way to change it beside it: code projects, files
  // made to hold a key or password, password vaults, installed programs and games, the places apps keep their
  // own caches, logs and AI tools' history, and the rest of AppData besides. "" when it left out none.
  function leftOutLine(counts) {
    const parts = [];
    const projects = counts.codeProjects || 0;
    const files = counts.projectFiles || 0;
    if (projects) parts.push(projectsWords(projects, files));
    for (const [key, one, many] of LEFT_OUT_WORDS) {
      const count = counts[key] || 0;
      if (count) parts.push(oneOrMany(count, one, many));
    }
    return parts.length ? W.t("ws.leftOutScan", listOf(parts)) : "";
  }

  function changedSinceWords(changed, date, seconds) {
    if (!changed) return W.t("ws.doneSubSinceNone", date);
    if (changed === 1) return W.t("ws.doneSubSinceOne", date, clock(seconds));
    return W.t("ws.doneSubSince", fmt(changed), date, clock(seconds));
  }

  // How much a finished run read and how long it took. A Full that read only what changed since the last
  // complete one says so, with that one's date, so a short run never reads as the whole PC; `filesEarlier` of
  // those weren't actually new or changed, only re-read because they were worth a look last time, so they're
  // named in their own sentence rather than inflating "changed".
  function doneSub(filesRead, filesEarlier, seconds) {
    if (kind === "full" && since != null) {
      const date = fullScanDate(since);
      const sub = changedSinceWords(filesRead - filesEarlier, date, seconds);
      if (!filesEarlier) return sub;
      return `${sub} ${filesEarlier === 1 ? W.t("ws.alsoCheckedOne") : W.t("ws.alsoCheckedN", fmt(filesEarlier))}`;
    }
    return filesRead === 1
      ? W.t("ws.doneSubFilesOne", clock(seconds))
      : W.t("ws.doneSubFiles", fmt(filesRead), clock(seconds));
  }

  // ---------- The finish ----------

  // The stage's buttons and parts once a run is over, stopped or not.
  function showRunOver(stopped) {
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
  }

  function stoppedWords({ foundCount, filesRead, filesTotal, counted, notReadLine }) {
    const title = foundCount ? W.t("ws.stopped", thingWords(foundCount)) : W.t("ws.stoppedNone");
    let sub = counted
      ? W.t("ws.stoppedSub", fmt(filesRead), fmt(filesTotal))
      : W.t("ws.stoppedSubSoFar", fmt(filesRead));
    if (notReadLine) sub = `${sub} ${notReadLine}`;
    $("scan-see").hidden = true;
    $("feed-title").textContent = W.t("ws.soFar");
    return { title, sub };
  }

  // The count is the files this run read, not the ones the counting walk saw: one gone in between was never
  // read.
  function finishedTitle(ending, foundCount, filesRead, notRead) {
    if (ending === "found") return W.t("ws.done", thingWords(foundCount));
    if (ending === "unread") return globalThis.ClotrSummary.unreadTitle(notRead, { t: W.t, fmt });
    if (ending === "empty") return W.t("ws.doneEmpty");
    return filesRead === 1 ? W.t("ws.doneNoneOne") : W.t("ws.doneNone", fmt(filesRead));
  }

  // A clean moment that shows its work: the calm tick, the ticked list of what Clotr looked for, the
  // honest-limits line Look back's own limits list already says, and one next step. Only for a run that read
  // everything it counted and found nothing.
  function showCleanMoment(isClean) {
    $("clean-list").hidden = !isClean;
    $("clean-limits").hidden = !isClean;
    $("clean-next").hidden = !isClean;
    if (!isClean) return;
    $("clean-list").replaceChildren(
      ...cleanList().map((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        return item;
      }),
    );
  }

  function finishedWords(runCounts, ending, notRead, notReadLine) {
    const { filesRead, filesEarlier, foundCount, projectFinds, seconds, counts, counted } = runCounts;
    // An empty folder gets no full bar and no ticks: there was nothing to read, so nothing reads as done.
    const empty = ending === "empty";
    setProgress(counted && !empty ? 1 : null);
    $("st-files").textContent = fmt(filesRead);
    $("st-time").textContent = clock(seconds);
    setPhases(empty ? -1 : 2);
    const title = finishedTitle(ending, foundCount, filesRead, notRead);
    let sub = doneSub(filesRead, filesEarlier, seconds);
    if (notReadLine) sub = `${sub} ${notReadLine}`;
    if (counts.cappedFiles) sub = `${sub} ${W.t("ws.cap")}`;
    if (projectFinds) {
      sub = `${sub} ${projectFinds === 1 ? W.t("ws.projectFindsOne") : W.t("ws.projectFinds", fmt(projectFinds))}`;
    }
    // A Quick scan that read all of its floor says why and offers the Full one, every time it finishes.
    if (kind === "quick" && !hasRecord()) sub = `${sub} ${quickInFull()}`;
    $("full-offer").hidden = kind !== "quick" || hasRecord();
    const seen = foundCount + projectFinds;
    $("scan-see").hidden = seen === 0;
    $("scan-see").textContent = seen === 1 ? W.t("ws.seeOne") : W.t("ws.seeN", fmt(seen));
    $("feed-title").textContent = foundCount ? W.t("ws.found") : W.t("ws.soFar");
    showCleanMoment(ending === "clean");
    return { title, sub };
  }

  // What changed since the last scan of the same kind, after the sub line, when scan times are on.
  function showScanChange(recorded) {
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

  // History's own row for this run: when, which scan, how many files it read and how many of each kind it
  // found. Only History redraws from it (the fresh view), so a run never waits on the write to finish.
  function recordHistoryRow(filesRead, seconds) {
    const row = { t: Date.now(), scan: kind, items: filesRead, seconds, counts: kindCounts(lastFiles) };
    call("record_scan", { row })
      .then((next) => {
        globalThis.ClotrHistory?.draw(next);
        globalThis.ClotrScanScreen?.draw(next, lang);
        const recorded = next.scans?.[next.scans.length - 1];
        if (SCAN_TIMES_ENABLED && (recorded?.added || recorded?.gone)) showScanChange(recorded);
        // Offer the weekly check after the first scan: one line, once, only on a real finish the person
        // is looking at -- never the hidden weekly run itself, and never again once there's a second row.
        if (!globalThis.ClotrWeeklyCheck?.active && next.scans?.length === 1) showWeeklyOffer();
      })
      .catch(() => {});
  }

  // The weekly check, run with nobody watching: main-window.js set this flag before calling startQuick(), and
  // weekly_check_done is how weekly_check.rs hears this run is over. Only the files actually worth a look are
  // sent, so a repeat email address can never read as a "new" find; the fingerprinting itself happens in
  // Rust, by path, since this page never has one.
  function sendWeeklyCheck(meta) {
    const worthALook = lastFiles.filter((file) => file.found && globalThis.ClotrResults?.isWorthALook(file));
    const payload = worthALook.map((file) => ({ index: file.index, kinds: Object.keys(file.found) }));
    call("weekly_check_done", { files: payload })
      .then((answer) => globalThis.ClotrResults?.setFiles(lastFiles, { ...meta, newIndexes: answer.newIndices }))
      .catch(() => {});
  }

  function finish(finished) {
    const {
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
    } = finished;
    showRunOver(stopped);

    const summary = globalThis.ClotrSummary;
    const notRead = summary.notReadCounts(counts, reasons);
    const changedOnly = kind === "full" && since != null;
    const ending = endingOf({ stopped, foundCount, filesRead, notRead, changedOnly });
    const notReadLine = summary.notReadLine(notRead, { t: W.t, lang, fmt });
    const { title, sub } = stopped
      ? stoppedWords({ foundCount, filesRead, filesTotal, counted, notReadLine })
      : finishedWords(
          { filesRead, filesEarlier, foundCount, projectFinds, seconds, counts, counted },
          ending,
          notRead,
          notReadLine,
        );
    $("stage-title").textContent = title;
    $("stage-sub").textContent = sub;
    // A Full that read only what changed keeps Read everything again in plain sight, stopped or not.
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
      ending,
      notRead,
    };
    globalThis.ClotrResults?.setFiles(lastFiles, meta);
    recordHistoryRow(filesRead, seconds);
    if (globalThis.ClotrWeeklyCheck?.active) sendWeeklyCheck(meta);
  }

  // ---------- The weekly check's offer ----------

  // "Check again every week?", once, at the end of the first scan; a yes or a no both save the setting and
  // hide the line for good (Settings' own switch stays the only way to change it after that).
  let saveSettings = null;

  function showWeeklyOffer() {
    const offer = $("weekly-offer");
    if (offer) offer.hidden = false;
  }

  function answerWeeklyOffer(on) {
    $("weekly-offer").hidden = true;
    saveSettings?.({ weeklyCheck: on });
  }

  // ---------- Drawing the screen ----------

  const ARROW_STEP = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

  function wirePicks() {
    const items = [...document.querySelectorAll("#scan-pick .pick")];
    items.forEach((item, i) => {
      item.addEventListener("click", () => selectPick(item.dataset.kind));
      item.addEventListener("keydown", (event) => {
        const step = ARROW_STEP[event.key];
        if (!step) return;
        event.preventDefault();
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
      if (!SCAN_TIMES_ENABLED) {
        node.textContent = "";
        continue;
      }
      const row = [...rows].reverse().find((item) => item.scan === scan);
      const when = new Intl.DateTimeFormat(document.documentElement.lang, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      node.textContent = lastRunText(row, when);
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
    if (value < 60) return W.t("ws.scanRowSeconds", String(value));
    return W.t("ws.scanRowMinutes", String(Math.floor(value / 60)));
  }

  const DAY_MS = 86_400_000;

  function lastRunText(row, when) {
    if (!row) return W.t("ws.neverRan");
    const date = when.format(new Date(row.t));
    const age = Date.now() - row.t;
    const base = W.t("ws.lastRan", date, String(row.items), duration(row.seconds));
    return age >= 30 * DAY_MS ? `${base} ${W.t("ws.runAgainWhenReady")}` : base;
  }

  // ---------- Wiring the buttons ----------

  // Leave out, from the scan screen: Settings, scrolled to its card.
  function openLeaveOutCard() {
    requestAnimationFrame(() => {
      const card = $("leave-title");
      card?.scrollIntoView?.({ block: "start" });
      card?.focus?.();
    });
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
      if (isBusy()) return;
      startScan(true);
    });
    for (const id of ["scan-leave-link", "projects-change"]) $(id).addEventListener("click", openLeaveOutCard);
    $("scan-offer-full").addEventListener("click", () => {
      if (isBusy()) return;
      selectPick("full");
      resetStage();
      startScan();
    });
  }

  // ---------- What other screens call ----------

  // Home's "Run a quick scan", the Check my files tile and the tray's own "Run a quick scan": all land on the
  // Scan screen and start a Quick scan there, unless one is already running. A finished or stopped run's
  // screen gives way to the new one rather than swallowing the click.
  function startQuick() {
    if (isBusy()) return;
    selectPick("quick");
    resetStage();
    onStart().catch(failStart);
  }

  // Results' Read everything again: its link lands on the Scan screen, and this starts a Full there that
  // reads every file once more, unless a run is already going.
  function readEverything() {
    if (isBusy()) return;
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
})();
