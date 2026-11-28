// Clotr for Windows — Results and Extension check's results section: what a scan found, by index into the
// walker's own list (scan-screen.js), never a path or a value on this page. Extension check runs its own read here
// (ext_check's readers) through `extcheck-core.js`, the same pure logic and the same result shape the browser
// extension's own extcheck.js uses, so the two platforms give the same answer from the same record.
"use strict";

(() => {
  const { call, bytes: callBytes } = globalThis.ClotrApp || {};
  const W = globalThis.ClotrWords;
  const C = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);

  function createNode(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // Read when used, so each page's scripts can load in any order.
  function findingsModule() {
    return globalThis.ClotrFindings;
  }

  // ---------- Colour meaning ----------

  // Red for a key or an ID number, orange for what scammers ask for (passwords, codes, cards), lemon for
  // personal details people often mean to share. One list per colour, built from the engine's own ids
  // (extension/engine/rules/rule-table.js), so a new pattern lands in the right colour by its id, not by
  // guessing from its name.
  const RED = new Set([
    "private_key",
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "google_api_key",
    "slack_token",
    "crypto_secret",
    "service_token",
    "connection_string",
    "jwt",
    "internal_ip",
    "internal_host",
    "stripe_publishable_key",
    "us_ssn",
    "national_id",
    "medicare_id",
    "passport",
    "drivers_license",
    "insurance_id",
    "vin",
    "student_id",
    "my_id",
    "bank_account",
    "id_picture",
  ]);
  const ORANGE = new Set(["password", "otp_secret", "card_code", "gift_card", "credit_card"]);

  // Red is today's hand list plus every key in the engine's credentials group (finding-groups.js's isKeyKind),
  // except the two the orange list keeps.
  function isRed(id) {
    if (RED.has(id)) return true;
    if (ORANGE.has(id)) return false;
    return Boolean(globalThis.ClotrFindings?.isKeyKind(id));
  }

  function tagClass(id) {
    if (isRed(id)) return "err";
    if (ORANGE.has(id)) return "soon";
    return "test";
  }

  // ---------- Which files count, and what each can take ----------

  // Move to the Recycle Bin: every kind that needs a look -- a key or password, an ID, a photo's place or a
  // card/bank number -- not only a password or key in a text file, since the same offer now reaches an ID
  // photo or a scanned document just as well.
  function canRecycle(file) {
    return isWorthALook(file);
  }

  // Count only what needs a look (finding-groups.js): a key or password, an ID, a card or bank number, or a
  // picture's place. A file whose only finds are contact details (email, phone, name, address...) still
  // shows, in its own group, but it's never counted or announced -- an inflated count costs trust in the next
  // real warning.
  function isWorthALook(file) {
    return Boolean(globalThis.ClotrFindings?.needsALook(file));
  }

  // One "why" line per file, four possible: a photo's place, a key that still works, a list of several
  // accounts, or the plain default. The first that fits wins; a file can only show one.
  function whyKeyFor(kind, foundIds) {
    if (kind === "picture") return "ws.whyPhoto";
    if (foundIds.some(isRed)) return "ws.whyKey";
    if (foundIds.length > 2) return "ws.whyList";
    return "ws.whyFile";
  }

  // The one type a card's "What to do" speaks to: the first red (a key or an ID), else the first orange, else
  // whatever was found first. `found` is `{ patternId: count }` (scan-worker.js, never a value).
  function dominantType(found) {
    const ids = Object.keys(found || {});
    const red = ids.find(isRed);
    if (red) return red;
    const orange = ids.find((id) => ORANGE.has(id));
    if (orange) return orange;
    return ids[0] || null;
  }

  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }

  // Office and PDF (scan_rules.rs's "doc" category) have no automatic fix yet; a picture only offers "without the
  // place" when WebView2 can redraw it (not HEIC); plain text offers "with them hidden".
  function canHideText(file) {
    return file.kind === "text";
  }

  function canRedrawPicture(file) {
    return file.kind === "picture" && !/^hei[cf]$/i.test(file.ext || "");
  }

  // The one action a row leads with: the fix that actually does something (hide the text, redraw the photo)
  // when there is one, or Open the folder when the format has no automatic fix yet.
  function primaryActionFor(file) {
    if (canHideText(file)) return "hide";
    if (canRedrawPicture(file)) return "strip";
    return "open";
  }

  // ---------- Words ----------

  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }

  function fmt(number) {
    return Number(number).toLocaleString(lang === "es" ? "es-ES" : "en-US");
  }

  function alsoIn(count) {
    return count === 1 ? W.t("ws.resAlsoInOne") : W.t("ws.resAlsoInN", fmt(count));
  }

  function filesWord(count) {
    return count === 1 ? W.t("ws.resFileOne") : W.t("ws.resFilesN", fmt(count));
  }

  function listWords(names) {
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(names);
  }

  // A numbered list from one of this file's "step / step / step" words (ws.extFirefoxSteps, the plan's own
  // "How to do this" words below): one sentence per list item, so a long walkthrough still reads as a few
  // short steps rather than one paragraph.
  function stepList(key, ...subs) {
    return createNode(
      "ol",
      {},
      W.t(key, ...subs)
        .split(" / ")
        .map((step) => createNode("li", { textContent: step })),
    );
  }

  // ---------- The screen's state ----------

  // Detailed mode itself -- the left rail of filters, the grouped list, the file always open on the right --
  // is what detailed-view.js draws into #res-workbench by renderFiles() below. GROUP_DOT stays here too: Save a
  // summary's own preview (renderSummaryPreview) reads it for a group's own dot, same as before.
  const GROUP_DOT = { keys: "err", ids: "err", photos: "soon", money: "soon", projects: "test", contact: "test" };

  let lang = "en";
  let appVersion = ""; // "Report a problem" (res-report): this draw()'s own view.appVersion and view.osVersion,
  let osVersion = ""; // so its click needs no second round trip to Rust
  // The last finished scan's own list (scan-screen.js's `setFiles`), each
  // `{ index, name, folder, ext, size, kind, found, fps, dupOf }`.
  let files = [];
  let scanKind = "quick";
  let scanCounts = {};
  let scanSince = null; // a Full that read only what changed: when the record it went by was made (scan-screen.js)
  let scanGeneration = null; // the generation belonging to the cards currently shown
  let scanFilesRead = 0;
  let scanEnding = null; // how the finish ended (scan-screen.js's endingOf), for Save a summary's opening line
  let scanNotRead = null; // the finish's own not-read counts, so Save a summary never counts them again
  let scanFilesEarlier = 0; // unchanged files re-read because they were worth a look last time
  let hasScanned = false; // once a scan has finished or stopped, Save a summary has something to build from
  // Ignore you can take back: session-level only, cleared by the next scan's own `setFiles` (a file that's
  // really ignored never even reaches this list again, since scan_start filters it out by fingerprint).
  let ignoredIndexes = new Set();
  // Every file whose action is settled (ignored, recycled or a copy saved): "all looked at" fires once every
  // file that needs a look has one of these.
  let settledIndexes = new Set();
  // Tell only what's new: set only after a weekly check found something it hadn't seen before
  // (scan-screen.js's own call to weekly_check_done), so a row can say "New" without Results needing to know why.
  let newIndexes = new Set();
  // Move to the Recycle Bin, with undo: session-level only, same as Ignore.
  let recycledIndexes = new Set();
  // Move it somewhere private, with undo: session-level only, same as Recycle.
  let movedPrivateIndexes = new Set();
  // "Was this right?": once answered this session, a card shows the quiet thank-you instead of asking
  // again. Cleared by the next scan's own setFiles(), same as the other session-level sets above.
  let accuracyAnsweredIndexes = new Set();
  let needsEntries = []; // every entry that needs a look, copies folded, for "all looked at"

  // Guided vs Detailed: "detailed" or "guided" once chosen, null until then, when the chooser shows instead
  // of either. The walk's own cards (guided-cards.js, pure) and where it was: a module-level var is session memory
  // enough, since this window stays open for the scan it's for; the next scan's own setFiles() starts the
  // walk over.
  let resultsMode = null;
  let guidedCards = [];
  let guidedIndex = 0;
  // A short walk rail: one entry per step instead of one per card (a Full scan's own rail used to grow one
  // entry per file, 19 and on, since bundling alone never folds files spread across many places). A step past
  // its own first five cards stays collapsed until "Show all" names it here; the step the walk is on now
  // always opens on its own, so the rail never hides where you are. Reset by the next scan same as
  // guidedIndex, never the plan's own ticks.
  const RAIL_PAGE = 5;
  let railExpanded = new Set();
  const areaSummary = new Map();

  // ---------- The areas' lead line and first steps ----------

  function renderFirstSteps() {
    const host = $("res-first-steps");
    const section = $("res-first");
    if (!host || !section) return;
    const steps = [...areaSummary.values()]
      .filter((area) => area.step)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
      .map((area) => {
        if (area.step.tagName === "LI") return area.step;
        return createNode("li", { className: "res-first-step" }, [area.step]);
      });
    host.replaceChildren(...steps);
    section.hidden = host.children.length === 0;
  }

  function renderAreaLead() {
    const lead = $("res-lead");
    if (!lead) return;
    const parts = [...areaSummary.entries()]
      .filter(([area]) => areaShows(area))
      .map(([, summary]) => summary.sentence)
      .filter(Boolean);
    lead.textContent = parts.length ? W.t("ws.resLead", parts.join(" ")) : "";
    lead.hidden = parts.length === 0;
    renderFirstSteps();
  }

  function setAreaSummary(area, count, sentence, step, priority = 10) {
    const details = $(`res-${area}`);
    const countNode = $(`res-${area}-count`);
    if (!count) {
      areaSummary.delete(area);
      if (details) details.hidden = true;
    } else {
      areaSummary.set(area, { sentence, step, priority });
      if (details) details.hidden = !areaShows(area);
    }
    if (countNode) countNode.textContent = count ? fmt(count) : "";
    renderAreaLead();
  }

  function isGuidedView() {
    return resultsMode === "guided";
  }

  function isDetailedView() {
    return resultsMode === "detailed";
  }

  // Guided vs Detailed is about the file list only. Extensions and AI chats show whichever is picked, and
  // also before anything is picked or when no files were scanned.
  function areaShows(area) {
    return area !== "files" || isDetailedView();
  }

  // ---------- Saving a fixed copy ----------

  async function runWorker(message, transfer) {
    const worker = new Worker("check-my-files/scan-worker.js");
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          if (event.data?.error) reject(Object.assign(new Error("copy"), { refused: true }));
          else resolve(event.data);
        };
        worker.postMessage(message, transfer);
      });
    } finally {
      worker.terminate();
    }
  }

  async function saveCopy(file, variant) {
    const bytes = await callBytes("scan_next", { index: file.index });
    const built = await runWorker(
      { type: "copy", index: file.index, name: file.name, ext: file.ext, kind: file.kind, bytes, variant },
      [bytes],
    );
    return globalThis.ClotrResults.action("scan_save_copy", {
      index: file.index,
      bytes: built.bytes,
      suggestedName: file.name,
    });
  }

  // The worker made no copy, since none it could make was safe (cut short, mixed or unread): one line says so
  // under the buttons, until the next press or the next card or file.
  function clearCopyRefused(buttons) {
    buttons?.parentNode?.querySelector(".copy-refused")?.remove();
  }

  function showCopyRefused(buttons) {
    clearCopyRefused(buttons);
    buttons.after(createNode("p", { className: "small copy-refused", textContent: W.t("ws.copyRefused") }));
  }

  // ---------- Files that hold private details ----------

  // "You've looked at everything this scan found": once every file that needs a look has settled.
  function updateAllDone() {
    const banner = $("res-all-done");
    if (!banner) return;
    const allSettled = needsEntries.every((entry) => settledIndexes.has(entry.file.index));
    banner.hidden = needsEntries.length === 0 || !allSettled;
  }

  function renderSummary(totals) {
    const host = $("res-files-summary");
    if (!host) return;
    const lines = findingsModule().summaryLines(totals, { t: W.t, lang, fmt });
    const details = $("res-scan-details");
    if (details) details.hidden = !lines.head && !lines.detail && !lines.quiet;
    const kids = [createNode("p", { className: "res-head", textContent: lines.head })];
    if (lines.detail) kids.push(createNode("p", { className: "res-detail", textContent: lines.detail }));
    if (lines.quiet) kids.push(createNode("p", { className: "small muted", textContent: lines.quiet }));
    host.replaceChildren(...kids);
  }

  // The one point where Detailed mode draws: the left rail of filters, the grouped list and the file pane all
  // live in detailed-view.js's ClotrDetailed. results.js hands it this scan's files and the shared
  // ignored/settled/recycled/new sets Guided also reads and writes, plus one callback so an action taken here
  // still ticks the plan Guided shares and still updates "You've looked at everything" the same way Guided's
  // own actions do.
  function renderFiles() {
    const section = $("res-files");
    if (!section || !findingsModule()) return;
    const withFinds = files.filter(hasFinds);
    // Shown only once Detailed is chosen, decided before anything else so the chooser stands alone either
    // way.
    section.hidden = withFinds.length === 0 || !isDetailedView();
    const workbench = $("res-workbench");
    if (section.hidden || !workbench || !globalThis.ClotrDetailed) return;
    renderSummary(findingsModule().buildView(files).totals);
    globalThis.ClotrDetailed.render(workbench, {
      // The workbench reads a copy's other folders as plain names on its lead file (scan-coverage.js's fold); `files`
      // itself stays raw, `dupOf` and all, for finding-groups.js's and guided-cards.js's own folds.
      files: globalThis.ClotrScope ? globalThis.ClotrScope.foldCopies(files) : files,
      lang,
      fmt,
      W,
      sets: { ignoredIndexes, settledIndexes, recycledIndexes, newIndexes },
      planTicked,
      afterAction(stepId, _indexes) {
        updateAllDone();
        if (stepId) tickStepIfDone(stepId);
      },
    });
  }

  // ---------- What to do: the plan ----------

  // A short plan built from this scan's own finds (what-to-do-plan.js), above Results, worst first, grouped by the
  // action it calls for. Only a step's own id is kept between visits, through the app's one writer
  // (store_file.rs's own `planTicked`, wire()'s `save`), never what it found.

  const PLAN_FILES_CAP = 8;
  const PLAN_PRIORITY = { keys: 1, idPhotos: 2, idDocs: 2, money: 3, photoPlace: 5, leaveOutFolders: 6 };

  let saveSettings = null; // wire()'s own `save`: the settings round trip through the one writer (main-window.js)
  let planTickedIds = new Set(); // this window's own copy of settings.planTicked, kept current by draw()

  function planTicked() {
    return planTickedIds;
  }

  function setPlanTicked(ticked) {
    planTickedIds = ticked;
    saveSettings?.({ planTicked: [...ticked] });
  }

  // A step's own "How to do this" walkthrough lives one key past its one-line "how" (what-to-do-plan.js's
  // `step.words.how`, e.g. "ws.planKeysHow" -> "ws.planKeysHowSteps"), split the same way ws.extFirefoxSteps
  // is above.
  function planHowKey(step) {
    return `${step.words.how}Steps`;
  }

  // "Without the place", from the plan: a saved copy turns the button into a Done tag.
  function stripPlaceButton(file) {
    const strip = createNode("button", {
      className: "btn text sm",
      type: "button",
      textContent: W.t("ws.copyNoPlace"),
    });
    strip.addEventListener("click", async () => {
      strip.disabled = true;
      try {
        const result = await saveCopy(file, "noPlace");
        if (result.saved) {
          strip.replaceWith(createNode("span", { className: "tag good", textContent: W.t("ws.cardDone") }));
        } else strip.disabled = false;
      } catch {
        strip.disabled = false;
      }
    });
    return strip;
  }

  // Clotr only fixes a file itself where doing so can't go wrong (a photo's place, same as its own card in
  // Results): every other step points at the file and leaves the change -- a new password, a moved folder --
  // to Windows and the person, never to Clotr.
  function planFileChip(file, step) {
    const kids = [createNode("span", { textContent: `${findingsModule().placeLine(file)} · ${file.name}` })];
    const open = createNode("button", {
      className: "btn text sm",
      type: "button",
      textContent: W.t("ws.planSeeFiles"),
    });
    open.addEventListener("click", () => globalThis.ClotrResults.action("scan_reveal", { index: file.index }));
    kids.push(open);
    if (step.id === "photoPlace" && canRedrawPicture(file)) kids.push(stripPlaceButton(file));
    return createNode("li", {}, kids);
  }

  // The full step, read before it's done: what it is, why, an expandable walkthrough for someone who's never
  // done this before, then the files it's about. Checking its box only records that you did this yourself
  // (store_file.rs's `planTicked`) -- Clotr never touches a file because of it.
  function planOpenBody(step) {
    const kids = [
      createNode("p", { className: "small muted", textContent: W.t(step.words.why) }),
      createNode("p", { className: "small", textContent: W.t(step.words.how) }),
      createNode("details", { className: "plan-how" }, [
        createNode("summary", { textContent: W.t("ws.planHowTitle") }),
        stepList(planHowKey(step)),
      ]),
      createNode(
        "ul",
        { className: "fr-copies" },
        step.files.slice(0, PLAN_FILES_CAP).map((file) => planFileChip(file, step)),
      ),
    ];
    if (step.files.length > PLAN_FILES_CAP) {
      kids.push(
        createNode("p", {
          className: "small muted",
          textContent: W.t("ws.planFilesMore", fmt(step.files.length - PLAN_FILES_CAP)),
        }),
      );
    }
    const box = createNode("input", { type: "checkbox", checked: false, id: `plan-${step.id}` });
    kids.push(
      createNode("div", { className: "plan-mark" }, [
        box,
        createNode("label", { htmlFor: `plan-${step.id}`, textContent: W.t("ws.planMarkDone") }),
      ]),
      createNode("p", { className: "small muted plan-mark-hint", textContent: W.t("ws.planMarkDoneHint") }),
    );
    return { kids, box };
  }

  // Once ticked, a step folds down to this one line, the same shape as a settled file's row in Results: what
  // it was, that it's done, and Undo to bring the full step (and its own box, unticked) straight back.
  function planDoneBody(step, onUndo) {
    const row = createNode("div", { className: "plan-done-row" }, [
      createNode("span", { className: "tag good", textContent: W.t("ws.planDone") }),
      createNode("span", { className: "small", textContent: W.t(step.words.what) }),
    ]);
    const undo = createNode("button", { className: "btn sm", type: "button", textContent: W.t("ws.undo") });
    undo.addEventListener("click", onUndo);
    row.append(undo);
    return [row];
  }

  function planStepRow(step, ticked) {
    const item = createNode("li", { className: "plan-step" });
    const head = createNode("div", { className: "plan-head" }, [
      createNode("b", { textContent: W.t(step.words.what) }),
      createNode("span", { className: "rg-count", textContent: fmt(step.count) }),
    ]);

    function showOpen() {
      const { kids, box } = planOpenBody(step);
      item.classList.toggle("done", false);
      item.replaceChildren(head, ...kids);
      box.addEventListener("change", () => {
        if (!box.checked) return;
        const next = planTicked();
        next.add(step.id);
        setPlanTicked(next);
        showDone();
      });
    }

    function untick() {
      const next = planTicked();
      next.delete(step.id);
      setPlanTicked(next);
      showOpen();
    }

    function showDone() {
      item.classList.toggle("done", true);
      item.replaceChildren(head, ...planDoneBody(step, untick));
    }

    if (ticked.has(step.id)) showDone();
    else showOpen();
    return item;
  }

  function planFirstStep(step) {
    const item = createNode("li", { className: "res-first-step" }, [
      createNode("b", { textContent: W.t(step.words.what) }),
    ]);
    const file = step.files[0];
    if (!file) return item;
    const fileRow = planFileChip(file, step);
    const actions = createNode(
      "div",
      { className: "btn-row" },
      Array.from(fileRow.children).filter((child) => child.tagName === "BUTTON"),
    );
    item.append(createNode("span", { className: "small muted", textContent: file.name }), actions);
    return item;
  }

  function planPriority(step) {
    return PLAN_PRIORITY[step.id] ?? 4;
  }

  function renderPlan() {
    const section = $("res-plan");
    if (!section || !globalThis.ClotrPlan) return;
    const steps = globalThis.ClotrPlan.buildPlan(files);
    section.hidden = steps.length === 0 || !isDetailedView();
    const actionable = steps.filter((step) => !planTicked().has(step.id));
    const count = files.filter(isWorthALook).length;
    const first = actionable[0] || steps[0];
    const counted = count && isDetailedView();
    setAreaSummary(
      "files",
      counted ? count : 0,
      counted ? W.t("ws.resLeadFiles", fmt(count)) : "",
      first && isDetailedView() ? planFirstStep(first) : null,
      first ? planPriority(first) : 10,
    );
    if (section.hidden) return;
    const ticked = planTicked();
    $("res-plan-steps").replaceChildren(...steps.map((step) => planStepRow(step, ticked)));
  }

  // ---------- A new scan's files ----------

  // Every entry that needs a look, copies folded (finding-groups.js's own fold), for "all looked at".
  function foldedNeeds() {
    const findings = findingsModule();
    if (!findings) return [];
    return findings.foldCopies(files.filter(hasFinds)).filter((entry) => findings.needsALook(entry.file));
  }

  function setFiles(nextFiles, meta = {}) {
    // Kept raw, `dupOf` and all: finding-groups.js's own foldCopies (buildView, needsEntries below) and guided-cards.js's
    // buildCards each do their own fold from this same list, in Detailed and Guided alike. Folding here first
    // (scan-coverage.js's own foldCopies, built for a different line -- the skipped-folders summary) used to run
    // before either of those and leave no `dupOf` chain for them to find, so `entry.copies` read empty in
    // both views.
    files = nextFiles || [];
    scanGeneration = meta.generation ?? null;
    ignoredIndexes = new Set();
    settledIndexes = new Set();
    recycledIndexes = new Set();
    movedPrivateIndexes = new Set();
    accuracyAnsweredIndexes = new Set();
    newIndexes = new Set(meta.newIndexes || []);
    if (meta.kind) scanKind = meta.kind;
    scanCounts = meta.counts || {};
    scanSince = scanKind === "full" && meta.since != null ? meta.since : null;
    scanFilesRead = meta.filesRead || 0;
    scanFilesEarlier = meta.filesEarlier || 0;
    scanEnding = meta.ending ?? null;
    scanNotRead = meta.notRead ?? null;
    hasScanned = true;
    needsEntries = foldedNeeds();
    guidedCards = globalThis.ClotrGuided ? globalThis.ClotrGuided.buildCards(files) : [];
    guidedIndex = 0;
    railExpanded = new Set();
    // A Full scan names what it left out, in one line, whatever it found.
    const reach = $("res-scan-reach");
    if (reach) reach.hidden = scanKind !== "full";
    renderSince();
    renderSkipped(meta);
    renderFiles();
    renderPlan();
    renderMode();
    updateAllDone();
    const open = $("res-summary-open");
    if (open) open.hidden = !hasScanned;
  }

  // What the finish said wasn't read, in its own numbers (scan-screen.js's meta), or that there were no files to
  // check. "" when the run read every file it counted.
  function skippedLine(meta = {}, { t = W.t } = {}) {
    if (meta.ending === "empty") return t("ws.doneEmpty");
    const summary = globalThis.ClotrSummary;
    return meta.notRead && summary ? summary.notReadLine(meta.notRead, { t, lang, fmt }) : "";
  }

  function renderSkipped(meta) {
    const line = $("res-skipped");
    if (!line) return;
    line.textContent = skippedLine(meta);
    line.hidden = !line.textContent;
  }

  // `scanSince`, worded the way a person reads a date, or "" when this run isn't a changes-only Full.
  function sinceDateStr() {
    if (scanSince == null) return "";
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(scanSince));
  }

  function sinceWords(date) {
    if (!scanFilesRead) return W.t("ws.resSinceNone", date);
    if (scanFilesRead === 1) return W.t("ws.resSinceOne", date);
    return W.t("ws.resSince", fmt(scanFilesRead), date);
  }

  // A Full that read only what changed says so above the finds, with Read everything again beside it: what an
  // earlier scan found in a file that hasn't changed since isn't read again -- unless that file had something
  // worth a look last time, which this run re-read, so Results says so too.
  function renderSince() {
    const line = $("res-since");
    if (!line) return;
    line.hidden = scanSince == null;
    if (scanSince == null) return;
    const text = sinceWords(sinceDateStr());
    let after = W.t("ws.resSinceRest");
    if (scanFilesEarlier) {
      after = scanFilesEarlier === 1 ? W.t("ws.alsoCheckedOne") : W.t("ws.alsoCheckedN", fmt(scanFilesEarlier));
    }
    $("res-since-text").textContent = `${text} ${after}`;
  }

  // ---------- Guided: the walk's words ----------

  // The walk, over what-to-do-plan.js's own order with copies folded (guided-cards.js, pure, the same card shapes the unit
  // test checks). The PC shows every card's place in an always-visible rail, so the rail's own clicks are
  // this view's Back and jump-to-anywhere; a finished action moves the walk on by itself, and Skip for now
  // moves on without one. Ask for help opens a short "coming soon" line rather than hiding the button, so the
  // control is never a dead end.

  const GUIDED_TEXT = {
    keys: ["ws.gdKeysHead", "ws.gdKeysShort", "ws.gdKeysRec"],
    idPhotos: ["ws.gdIdPhotosHead", "ws.gdIdPhotosShort", "ws.gdIdPhotosRec"],
    idDocs: ["ws.gdIdDocsHead", "ws.gdIdDocsShort", "ws.gdIdDocsRec"],
    photoPlace: ["ws.gdPhotoPlaceHead", "ws.gdPhotoPlaceShort", "ws.gdPhotoPlaceRec"],
    money: ["ws.gdMoneyHead", "ws.gdMoneyShort", "ws.gdMoneyRec"],
    leaveOutFolders: ["ws.gdLeaveOutHead", "ws.gdLeaveOutShort", "ws.gdLeaveOutRec"],
  };
  // Buttons map to what the app already does: the recommended action for idPhotos/idDocs
  // (guided-cards.js's RECOMMENDED table) falls back to Open the folder only when a file can't be recycled, redrawn
  // or moved somewhere private.
  const GUIDED_ACTION_WORD = {
    recycle: "ws.recycle",
    hide: "ws.copyHidden",
    stripPlace: "ws.copyNoPlace",
    movePrivate: "ws.movePrivate",
    ignore: "ws.ignore",
    leaveOut: "ws.leaveFolder",
    open: "ws.openFolder",
  };
  // One word per `scan_move` refusal reason (`ClotrActions.movePrivate`); "not-allowed" never reaches this
  // table since it means the folder picker was closed, the same as backing out of the confirm step.
  const MOVE_REASON_WORD = {
    changed: "ws.moveReasonChanged",
    linked: "ws.moveReasonLinked",
    "not-found": "ws.moveReasonNotFound",
    outside: "ws.moveReasonOutside",
  };

  function guidedCardIndexes(card) {
    if (card.type === "bundle") return card.files.map((file) => file.index);
    return [card.file.index, ...card.copies.map((copy) => copy.index)];
  }

  // A place the way people say it -- "on the Desktop", but "in Downloads":
  // the four everyday folders each read their own way, so a plain "in $1" never reads as "in Desktop".
  const PLACE_WORD = {
    desktop: "ws.placeDesktop",
    downloads: "ws.placeDownloads",
    documents: "ws.placeDocuments",
    pictures: "ws.placePictures",
  };

  function placePhrase(label) {
    const key = PLACE_WORD[String(label || "").toLowerCase()];
    return key ? W.t(key) : W.t("ws.placeOther", prettyFolder(label));
  }

  function guidedHeading(card) {
    const [headKey] = GUIDED_TEXT[card.stepId] || [];
    const folder = card.type === "file" ? card.file.folder : card.folder;
    return headKey ? W.t(headKey, placePhrase(folder)) : W.t(card.words.what);
  }

  function guidedShort(card) {
    if (card.type === "bundle") return W.t("ws.gdBundleShort", fmt(card.count), placePhrase(card.folder));
    const [, shortKey] = GUIDED_TEXT[card.stepId] || [];
    return shortKey ? W.t(shortKey, card.file.name) : "";
  }

  function guidedRecommends(card) {
    if (card.type === "bundle") return "";
    const [, , recKey] = GUIDED_TEXT[card.stepId] || [];
    return recKey ? W.t(recKey, card.file.name) : "";
  }

  // ---------- Guided: moving on ----------

  // A step counts as done, for the plan it shares ticks with, once every one of its cards -- file,
  // copy or bundle -- has settled, whichever view settled them.
  function tickStepIfDone(stepId) {
    const ids = guidedCards.filter((card) => card.stepId === stepId).flatMap(guidedCardIndexes);
    if (!ids.length || !ids.every((index) => settledIndexes.has(index))) return;
    const ticked = planTicked();
    if (ticked.has(stepId)) return;
    ticked.add(stepId);
    setPlanTicked(ticked);
  }

  function guidedAfterSettle(card) {
    tickStepIfDone(card.stepId);
    guidedIndex += 1;
    renderGuided();
  }

  function settleAll(ids, intoSet) {
    for (const index of ids) {
      intoSet.add(index);
      settledIndexes.add(index);
    }
  }

  // ---------- Guided: one card's buttons ----------

  // A card's buttons work on `view`: { card, file (null for a bundle), buttonsRow, redraw }, where `redraw`
  // puts the card's own buttons back.

  function guidedActionButton(actionId, isRecommended, index) {
    const labelKids = [createNode("span", { textContent: W.t(GUIDED_ACTION_WORD[actionId] || "ws.openFolder") })];
    if (isRecommended) {
      labelKids.push(createNode("span", { className: "gd-btn-tag", textContent: W.t("ws.recommended") }));
    }
    return createNode("button", { className: `gd-btn${isRecommended ? " recommended" : ""}`, type: "button" }, [
      createNode("span", { className: "gd-btn-num", textContent: String(index) }),
      createNode("span", { className: "gd-btn-label" }, labelKids),
    ]);
  }

  function guidedGhosts(card) {
    const buttons = [];
    if (card.type === "bundle") {
      const split = createNode("button", { type: "button", textContent: W.t("ws.gdOneAtATime") });
      split.addEventListener("click", () => {
        guidedCards.splice(guidedIndex, 1, ...globalThis.ClotrGuided.expandBundle(card));
        renderGuided();
      });
      buttons.push(split);
    }
    const askHelp = createNode("button", { type: "button", textContent: W.t("ws.gdAskHelp") });
    askHelp.addEventListener("click", () => {
      globalThis.ClotrNote?.open({ kind: scanKind, files, since: scanSince });
    });
    buttons.push(askHelp);
    const skip = createNode("button", { type: "button", textContent: W.t("ws.gdSkip") });
    skip.addEventListener("click", () => {
      guidedIndex += 1;
      renderGuided();
    });
    buttons.push(skip);
    return buttons;
  }

  // A card's own files for Recycle and Move it somewhere private: the file itself (or every file in a bundle,
  // "one call" for the bundle), never a copy elsewhere -- the same set recycle already moved one at a time.
  function guidedFileIds(view) {
    return view.card.type === "file" ? [view.file.index] : view.card.files.map((file) => file.index);
  }

  function guidedFileName(view, index) {
    if (view.card.type === "file") return view.file.name;
    return view.card.files.find((file) => file.index === index)?.name || "";
  }

  // Right after a successful Recycle or Move it somewhere private, Undo puts every moved file straight back
  // (ClotrActions.unrecycle / unmovePrivate) before the walk moves on -- the same choice Detailed already
  // offers, now inside the walk too. `wordFor` answers one locale key per index (ws.recycled/ws.movedPrivate
  // on success, a ws.moveReason* key on a refusal); `doneIds` is only the ones Undo can act on.
  function showGuidedResult(view, ids, wordFor, doneIds, undoOne) {
    const { card, buttonsRow } = view;
    const lines = ids.map((index) => {
      const text = W.t(wordFor(index));
      return createNode("p", {
        className: "small",
        textContent: card.type === "bundle" ? `${guidedFileName(view, index)} — ${text}` : text,
      });
    });
    const row = createNode("div", { className: "gd-buttons" });
    if (doneIds.length) {
      const undo = createNode("button", { className: "gd-btn", type: "button", textContent: W.t("ws.undo") });
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        for (const index of doneIds) {
          await undoOne(index);
          settledIndexes.delete(index);
          recycledIndexes.delete(index);
          movedPrivateIndexes.delete(index);
        }
        view.redraw();
      });
      row.append(undo);
    }
    const cont = createNode("button", {
      className: "gd-btn recommended",
      type: "button",
      textContent: W.t("ws.gdContinue"),
    });
    cont.addEventListener("click", () => guidedAfterSettle(card));
    row.append(cont);
    buttonsRow.replaceChildren(...lines, row);
  }

  // Ask first, the same shape for Recycle and Move it somewhere private: the question, then Yes and Cancel.
  // `onYes` runs with the Yes button off, and turns it back on if it throws.
  function showGuidedConfirm(view, questionKey, onYes) {
    const name = view.file ? view.file.name : prettyFolder(view.card.folder);
    const row = createNode("div", { className: "gd-buttons" });
    const yes = createNode("button", {
      className: "gd-btn recommended",
      type: "button",
      textContent: W.t("ws.recycleConfirmYes"),
    });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await onYes();
      } catch {
        yes.disabled = false;
      }
    });
    const cancel = createNode("button", { className: "gd-btn", type: "button", textContent: W.t("ws.recycleCancel") });
    cancel.addEventListener("click", view.redraw);
    row.append(yes, cancel);
    view.buttonsRow.replaceChildren(createNode("p", { className: "small", textContent: W.t(questionKey, name) }), row);
  }

  async function recycleCard(view) {
    const ids = guidedFileIds(view);
    for (const index of ids) await globalThis.ClotrResults.action("scan_recycle", { index });
    settleAll(ids, recycledIndexes);
    showGuidedResult(
      view,
      ids,
      () => "ws.recycled",
      ids,
      (index) => globalThis.ClotrActions.unrecycle(index),
    );
  }

  // Move it somewhere private: one bundled `scan_move` call (`ClotrActions.movePrivate`) answers per file, so
  // a mix of moved and refused files in one bundle each show their own line.
  async function moveCardPrivate(view) {
    const ids = guidedFileIds(view);
    const results = await globalThis.ClotrActions.movePrivate(ids);
    // The scan ended, or the person closed the folder picker without choosing anywhere: nothing happened,
    // so this reads exactly like backing out of the confirm step, not a per-file refusal.
    if (results.every((result) => result.reason === "not-allowed")) {
      view.redraw();
      return;
    }
    const byIndex = new Map(results.map((result) => [result.index, result]));
    const moved = ids.filter((index) => byIndex.get(index)?.moved);
    settleAll(moved, movedPrivateIndexes);
    function wordFor(index) {
      const result = byIndex.get(index);
      return result?.moved ? "ws.movedPrivate" : MOVE_REASON_WORD[result?.reason] || "ws.moveReasonNotMoved";
    }
    showGuidedResult(view, ids, wordFor, moved, (index) => globalThis.ClotrActions.unmovePrivate(index));
  }

  // The actions that run at once: the button stays off while they do, and an action that settles the card
  // moves the walk on.
  async function runGuidedNow(view, actionId, button) {
    const { card, file } = view;
    if (actionId === "open") {
      await globalThis.ClotrResults.action("scan_reveal", { index: file ? file.index : card.files[0].index });
      button.disabled = false;
      return;
    }
    if (actionId === "hide" || actionId === "stripPlace") {
      const result = await saveCopy(file, actionId === "hide" ? "hidden" : "noPlace");
      if (!result.saved) {
        button.disabled = false;
        return;
      }
      settledIndexes.add(file.index);
      guidedAfterSettle(card);
      return;
    }
    if (actionId === "ignore") {
      const ids = guidedCardIndexes(card);
      for (const index of ids) await globalThis.ClotrResults.action("scan_ignore", { index });
      settleAll(ids, ignoredIndexes);
      guidedAfterSettle(card);
      return;
    }
    if (actionId === "leaveOut") {
      const index = file ? file.index : card.files[0].index;
      await globalThis.ClotrResults.action("scan_exclude_from", { index, what: "folder" });
      for (const cardIndex of guidedCardIndexes(card)) settledIndexes.add(cardIndex);
      guidedAfterSettle(card);
    }
  }

  async function runGuidedAction(view, actionId, button) {
    clearCopyRefused(view.buttonsRow);
    if (actionId === "recycle") {
      showGuidedConfirm(view, "ws.recycleConfirm", () => recycleCard(view));
      return;
    }
    if (actionId === "movePrivate") {
      showGuidedConfirm(view, "ws.movePrivateConfirm", () => moveCardPrivate(view));
      return;
    }
    button.disabled = true;
    try {
      await runGuidedNow(view, actionId, button);
    } catch (err) {
      button.disabled = false;
      if (err?.refused) showCopyRefused(view.buttonsRow);
    }
  }

  // The buttons for one card: numbered, the recommended one first and marked (guided-cards.js already orders
  // `card.actions` this way), Move to the Recycle Bin asking first like Detailed's own row.
  function guidedButtons(card, buttonsRow, ghosts) {
    const view = { card, file: card.type === "file" ? card.file : null, buttonsRow, redraw: drawButtons };

    function drawButtons() {
      buttonsRow.replaceChildren(
        ...card.actions.map((actionId, i) => {
          const button = guidedActionButton(actionId, actionId === card.recommended, i + 1);
          button.addEventListener("click", () => runGuidedAction(view, actionId, button));
          return button;
        }),
      );
    }

    drawButtons();
    ghosts.replaceChildren(...guidedGhosts(card));
  }

  // ---------- Guided: the card ----------

  function thanks() {
    return createNode("p", { className: "small muted", textContent: W.t("ws.accThanks") });
  }

  // "Was this right?": a small yes-or-no on this card's own file, asked once a session. The answer keeps only
  // the kind and place tier Clotr itself works out fresh (finding-groups.js's own accuracyKindOf/accuracyTierOf),
  // never the file, its name, its place or the value.
  function accuracyControl(file) {
    const box = createNode("div", { className: "acc-check" });
    if (accuracyAnsweredIndexes.has(file.index)) {
      box.append(thanks());
      return box;
    }
    const yesButton = createNode("button", { className: "btn sm", type: "button", textContent: W.t("ws.accYes") });
    const noButton = createNode("button", { className: "btn sm", type: "button", textContent: W.t("ws.accNo") });
    async function answer(value) {
      yesButton.disabled = true;
      noButton.disabled = true;
      const kind = findingsModule().accuracyKindOf(file);
      const tier = findingsModule().accuracyTierOf(file);
      try {
        await call("accuracy_answer", { kind, tier, yes: value });
      } catch {
        // Clotr never breaks over this: the thank-you still shows, just unsaved.
      }
      accuracyAnsweredIndexes.add(file.index);
      box.replaceChildren(thanks());
    }
    yesButton.addEventListener("click", () => answer(true));
    noButton.addEventListener("click", () => answer(false));
    box.append(
      createNode("p", { className: "small" }, [createNode("b", { textContent: W.t("ws.accWasRight") })]),
      createNode("div", { className: "acc-buttons" }, [yesButton, noButton]),
    );
    return box;
  }

  function labelled(labelKey, text, textClass) {
    const textProps = textClass ? { className: textClass, textContent: text } : { textContent: text };
    return [
      createNode("p", { className: "small" }, [createNode("b", { textContent: W.t(labelKey) })]),
      createNode("p", textProps),
    ];
  }

  // What a file card says about the file itself before what Clotr found: its copies, an earlier find, its
  // kind.
  function guidedFileLines(card) {
    const lines = [];
    if (card.type !== "file") return lines;
    if (card.copies.length) {
      lines.push(createNode("p", { className: "small muted", textContent: alsoIn(card.copies.length) }));
    }
    // This file didn't change since the last Full, but that one found something worth a look, so this run
    // re-read it and Results still shows it, said plainly rather than left looking like today's own find.
    if (card.file.earlier && scanSince != null) {
      lines.push(createNode("p", { className: "small muted", textContent: W.t("ws.earlierFind", sinceDateStr()) }));
    }
    // What kind of file this is, before anything about what Clotr found in
    // it: file-kinds.js's own lookup, carried on the card's file since guided-cards.js's slimFile already ran it.
    if (card.file.kindLine) {
      lines.push(createNode("p", { className: "small muted", textContent: W.t(card.file.kindLine) }));
    }
    return lines;
  }

  function guidedMoreDetail(card) {
    return createNode("details", { className: "plan-how" }, [
      createNode("summary", { textContent: W.t("ws.gdMoreDetail") }),
      createNode("p", { className: "small" }, [createNode("b", { textContent: W.t("ws.gdWhyLabel") })]),
      createNode("p", { className: "small muted", textContent: W.t(card.words.why) }),
      createNode("p", { className: "small" }, [createNode("b", { textContent: W.t("ws.planHowTitle") })]),
      createNode("p", { className: "small", textContent: W.t(card.words.how) }),
      stepList(`${card.words.how}Steps`),
    ]);
  }

  function renderGuidedCardBody(card) {
    const host = $("guided-card");
    if (!host) return;
    const kids = [createNode("h2", { textContent: guidedHeading(card) }), ...guidedFileLines(card)];
    kids.push(...labelled("ws.gdShortLabel", guidedShort(card)));
    const rec = guidedRecommends(card);
    if (rec) kids.push(...labelled("ws.gdRecLabel", rec));
    kids.push(guidedMoreDetail(card));
    const buttonsRow = createNode("div", { className: "gd-buttons" });
    const ghosts = createNode("div", { className: "gd-ghosts" });
    kids.push(buttonsRow, ghosts);
    if (card.type === "file") {
      const full = files.find((file) => file.index === card.file.index);
      if (full) kids.push(accuracyControl(full));
    }
    host.replaceChildren(...kids);
    guidedButtons(card, buttonsRow, ghosts);
  }

  function renderGuidedFinish() {
    const host = $("guided-card");
    if (!host) return;
    const again = createNode("button", { className: "btn primary", type: "button", textContent: W.t("ws.again") });
    again.addEventListener("click", () => $("scan-again")?.click());
    const home = createNode("a", { className: "btn text", href: "#home", textContent: W.t("ws.navHome") });
    host.replaceChildren(
      createNode("div", { className: "gd-finish" }, [
        createNode("h2", { textContent: W.t("ws.gdFinishTitle") }),
        createNode("p", { className: "small muted", textContent: W.t("ws.gdFinishBody", fmt(guidedCards.length)) }),
        createNode("div", { className: "gd-buttons" }, [again, home]),
      ]),
    );
  }

  // ---------- Guided: the rail and the progress ----------

  function isCardDone(card) {
    return guidedCardIndexes(card).every((index) => settledIndexes.has(index));
  }

  // One rail item per card, the same row the flat rail always drew (a step's own heading, once, lives on its
  // group's header instead -- see renderGuidedRail): naming the file it's about underneath it, a bundle has
  // no one file, so its second line names the folder. `number` counts within its own step (1, 2, 3...), never
  // the whole walk, since the step it belongs to is already named on the header above it.
  function guidedRailItem(card, globalIndex, number) {
    const done = isCardDone(card);
    // A file says where it is (finding-groups.js placeLine), never just its drive; a bundle names its folder.
    const sub =
      card.type === "file" ? `${card.file.name} · ${findingsModule().placeLine(card.file)}` : prettyFolder(card.folder);
    const button = createNode("button", { className: "guided-rail-item", type: "button" }, [
      createNode("span", {
        className: `guided-rail-num${done ? " done" : ""}`,
        textContent: done ? "✓" : String(number),
      }),
      createNode("span", { className: "guided-rail-text" }, [
        createNode("span", { className: "guided-rail-sub", textContent: sub }),
      ]),
    ]);
    if (globalIndex === guidedIndex) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => {
      guidedIndex = globalIndex;
      renderGuided();
    });
    return createNode("li", {}, [button]);
  }

  function railHeader(group, open) {
    const groupCards = Array.from({ length: group.length }, (_, k) => guidedCards[group.start + k]);
    const headKids = [];
    if (groupCards.every(isCardDone)) {
      headKids.push(createNode("span", { className: "guided-rail-num done", textContent: "✓" }));
    }
    headKids.push(
      createNode("span", { className: "guided-rail-text" }, [
        createNode("span", { className: "guided-rail-head", textContent: W.t(group.words.what) }),
        createNode("span", { className: "guided-rail-sub", textContent: filesWord(group.files) }),
      ]),
    );
    const header = createNode(
      "button",
      { className: `guided-rail-step${open ? " open" : ""}`, type: "button" },
      headKids,
    );
    header.setAttribute("aria-expanded", String(open));
    header.addEventListener("click", () => {
      guidedIndex = group.start;
      renderGuided();
    });
    return createNode("li", { className: "guided-rail-group" }, [header]);
  }

  // However many cards the user already asked to see, never fewer than the one the walk is on now.
  function railShownCount(group, activeAt) {
    if (railExpanded.has(group.stepId)) return group.length;
    const throughActive = activeAt === -1 ? 0 : activeAt - group.start + 1;
    return Math.min(group.length, Math.max(RAIL_PAGE, throughActive));
  }

  // A short walk rail: one entry per step -- its own heading, once, plus how many files it's about -- instead
  // of one per card, so a Full scan's rail never grows past the window (guided.css also caps the rail's own
  // height and lets it scroll, so the page under the card stays short). The step the walk is on now always
  // opens, so the rail never hides where you are; any other step stays a single collapsed line until its own
  // header is clicked, which jumps the walk there and opens it the same way. Open, a step shows its first
  // RAIL_PAGE cards and a "Show all" for the rest, never more -- and a heading that doesn't fit wraps to two
  // lines instead of cutting off (main-window.css's own white-space there, not an ellipsis).
  function renderGuidedRail() {
    const list = $("guided-rail-list");
    if (!list) return;
    const groups = globalThis.ClotrGuided.groupRail(guidedCards);
    const nodes = [];
    for (const group of groups) {
      const isActive = guidedIndex >= group.start && guidedIndex < group.start + group.length;
      const activeAt = isActive ? guidedIndex : -1;
      const open = activeAt !== -1 || railExpanded.has(group.stepId);
      nodes.push(railHeader(group, open));
      if (!open) continue;
      const shown = railShownCount(group, activeAt);
      for (let k = 0; k < shown; k++) nodes.push(guidedRailItem(guidedCards[group.start + k], group.start + k, k + 1));
      if (group.length - shown <= 0) continue;
      const more = createNode("button", {
        className: "btn sm guided-rail-more",
        type: "button",
        textContent: W.t("ws.resShowAll", fmt(group.length)),
      });
      more.addEventListener("click", () => {
        railExpanded.add(group.stepId);
        renderGuidedRail();
      });
      nodes.push(createNode("li", { className: "guided-rail-more-wrap" }, [more]));
    }
    list.replaceChildren(...nodes);
  }

  function progressClass(i) {
    if (i < guidedIndex) return "done";
    if (i === guidedIndex) return "now";
    return "";
  }

  function renderGuidedProgress() {
    const progressBar = $("guided-progress");
    if (progressBar) {
      progressBar.replaceChildren(...guidedCards.map((_, i) => createNode("span", { className: progressClass(i) })));
    }
    const count = $("guided-count");
    if (count) {
      count.textContent = W.t(
        "ws.guidedCount",
        fmt(Math.min(guidedIndex + 1, guidedCards.length)),
        fmt(guidedCards.length),
      );
    }
  }

  function renderGuided() {
    if (!guidedCards.length) return;
    renderGuidedRail();
    renderGuidedProgress();
    if (guidedIndex >= guidedCards.length) renderGuidedFinish();
    else renderGuidedCardBody(guidedCards[guidedIndex]);
  }

  // ---------- Guided or Detailed ----------

  // Shows exactly one of the chooser, the walk, or Detailed's plan and file sections -- the chooser is its
  // own first screen while resultsMode is unset, never stacked above Detailed (renderPlan/renderFiles hide
  // themselves unless resultsMode is "detailed") -- and the one-line switch between them.
  function renderMode() {
    const chooser = $("res-chooser");
    const guided = $("res-guided");
    const modeSwitch = $("res-mode-switch");
    if (!chooser) return;
    chooser.hidden = resultsMode != null || !hasScanned;
    const showGuided = isGuidedView() && hasScanned && guidedCards.length > 0;
    if (guided) guided.hidden = !showGuided;
    if (modeSwitch) {
      modeSwitch.hidden = resultsMode == null || !hasScanned || guidedCards.length === 0;
      modeSwitch.textContent = W.t(isGuidedView() ? "ws.gdSeeDetail" : "ws.chooserGuided");
    }
    for (const area of ["files", "ext", "chats"]) {
      const details = $(`res-${area}`);
      if (details && areaSummary.has(area)) details.hidden = !areaShows(area);
    }
    renderAreaLead();
    if (showGuided) renderGuided();
  }

  function wireGuided() {
    $("chooser-guided")?.addEventListener("click", () => saveSettings?.({ resultsMode: "guided" }));
    $("chooser-detailed")?.addEventListener("click", () => saveSettings?.({ resultsMode: "detailed" }));
    $("res-mode-switch")?.addEventListener("click", () =>
      saveSettings?.({ resultsMode: isGuidedView() ? "detailed" : "guided" }),
    );
  }

  // ---------- Extensions that can read your AI chats ----------

  // Loaded as a classic script (dist/ai-sites.js, prepare-ui.js), not fetched: the app's network rule bans
  // `fetch()` outright, same-origin data included (results.js never asks the network for anything).
  function aiSites() {
    return Array.isArray(globalThis.ClotrAiSites) ? globalThis.ClotrAiSites : [];
  }

  function reachLine(entry) {
    if (entry.reach === "all") return W.t("ws.canRead");
    if (entry.reach === "some") return W.t("ws.extReachSome");
    if (entry.reach === "off") return W.t("ws.extReachOff");
    if (entry.reach === "none") return W.t("ws.extReachNone");
    return W.t("ws.canReadSites", listWords(entry.aiSites));
  }

  function noteLine(entry) {
    if (entry.note === "development") return W.t("ws.extDev");
    if (entry.note === "admin") return W.t("ws.extAdmin");
    return null;
  }

  function isSelf(entry) {
    return entry.self;
  }

  function canReadAi(entry) {
    return entry.reach === "all" || entry.reach === "ai";
  }

  // Chrome, Edge and Brave open straight to the extension's own card (`ext_reveal`, extension_check_commands.rs); Firefox and a
  // browser Windows couldn't find get the steps in words instead, the same two step lists the
  // browser extension's own extcheck.js offers.
  function removeAction(entry) {
    if (entry.browser === "Firefox") {
      return createNode("details", {}, [
        createNode("summary", { textContent: W.t("ws.removeIt") }),
        stepList("ws.extFirefoxSteps"),
      ]);
    }
    const button = createNode("button", { className: "btn sm", type: "button", textContent: W.t("ws.removeIt") });
    button.addEventListener("click", async () => {
      const opened = await call("ext_reveal", { browser: entry.browser, id: entry.id }).catch(() => false);
      if (opened) return;
      button.replaceWith(stepList("ws.extChromiumSteps", "chrome://extensions"));
    });
    return button;
  }

  function groupExtensionEntries(entries) {
    const groups = new Map();
    for (const entry of entries || []) {
      const key =
        entry.id || `${(entry.name || "").toLocaleLowerCase()}|${(entry.publisher || "").toLocaleLowerCase()}`;
      const group = groups.get(key) || { key, entries: [], worth: false };
      group.entries.push(entry);
      group.worth ||= Boolean(entry.worthALook);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => Number(b.worth) - Number(a.worth));
  }

  // An extension in two profiles of one browser would read "Chrome, Chrome", so those rows name the profile.
  function browserLabel(entry, group) {
    const browser = entry.browser || group.entries[0].name;
    const same = group.entries.filter((other) => other.browser === entry.browser);
    return same.length > 1 && entry.profile ? `${browser} (${entry.profile})` : browser;
  }

  function browsersOf(entries) {
    return [...new Set(entries.map((entry) => entry.browser).filter(Boolean))];
  }

  // Why a group is worth a look: a public report with its link, or a sideloaded install.
  function worthLines(group) {
    const risky = group.entries.find((entry) => entry.worthALook);
    if (risky?.worthALook.reason === "reported") {
      const { report } = risky.worthALook;
      return [
        createNode("p", { className: "small", textContent: W.t("ws.reported", report.source) }),
        createNode("p", {}, [
          createNode("a", {
            href: report.url,
            target: "_blank",
            rel: "noopener noreferrer",
            textContent: W.t("ws.readReport"),
          }),
        ]),
      ];
    }
    if (risky) return [createNode("p", { className: "small", textContent: W.t("ws.extSideload") })];
    return [];
  }

  function extensionGroupRow(group) {
    const first = group.entries[0];
    const browsers = browsersOf(group.entries);
    const browserLine = browsers.length ? W.t("ws.extInBrowsers", listWords(browsers)) : "";
    const title = createNode("h3", {}, [createNode("b", { textContent: first.name })]);
    if (group.worth) title.append(createNode("span", { className: "tag err", textContent: W.t("ws.look") }));
    const kids = [title, createNode("p", { className: "small", textContent: browserLine })];
    if (group.worth) kids.push(...worthLines(group));
    else kids.push(createNode("p", { className: "small", textContent: reachLine(first) }));
    for (const entry of group.entries) {
      const note = noteLine(entry);
      if (note) kids.push(createNode("p", { className: "small muted", textContent: note }));
      const browserRow = createNode("p", { className: "btn-row small" }, [
        createNode("span", { textContent: `${browserLabel(entry, group)} · ${reachLine(entry)}` }),
        removeAction(entry),
      ]);
      kids.push(browserRow);
    }
    return createNode("article", { className: "card" }, kids);
  }

  function extensionFirstStep(group) {
    const first = group.entries[0];
    const item = createNode("li", { className: "res-first-step ext-first-step" });
    const heading = createNode("b", { textContent: first.name });
    item.append(heading);
    if (group.worth) item.append(createNode("span", { className: "tag err", textContent: W.t("ws.look") }));
    item.append(
      ...group.entries.map((entry) =>
        createNode("span", { className: "ext-first-browser" }, [
          createNode("span", { textContent: browserLabel(entry, group) }),
          removeAction(entry),
        ]),
      ),
    );
    return item;
  }

  function foldGroups(id, groups, key) {
    const node = $(id);
    if (!node) return;
    node.hidden = groups.length === 0;
    const summary = node.querySelector("summary");
    if (summary) summary.textContent = W.t(key, groups.length);
    const list = node.querySelector(".scan-cards");
    if (list) list.replaceChildren(...groups.map(extensionGroupRow));
  }

  function isOnlySelf(group) {
    return group.entries.every(isSelf);
  }

  // The groups in four piles: worth a look, can read AI chats, turned off, and the rest that can't.
  function sortExtensionGroups(groups) {
    const worthGroups = groups.filter((group) => group.worth && !isOnlySelf(group));
    const remaining = groups.filter((group) => !worthGroups.includes(group));
    const canReadGroups = remaining.filter((group) => group.entries.some(canReadAi));
    const offGroups = remaining.filter((group) => group.entries.every((entry) => entry.reach === "off"));
    const cantGroups = remaining.filter((group) => !canReadGroups.includes(group) && !offGroups.includes(group));
    return { worthGroups, canReadGroups, offGroups, cantGroups };
  }

  function renderExtensions(result) {
    const section = $("res-ext");
    if (!section) return;
    // Clotr reads its own entry too, so it can label itself in the can-read list, but it's never one of
    // "your" extensions: left out of the headline and the worth-a-look and folded counts.
    const named = result.entries.filter((entry) => !entry.self);
    const canReadOthers = named.filter(canReadAi);
    $("res-ext-headline").textContent = W.t("ws.extHeadline", canReadOthers.length, named.length);

    const browsers = browsersOf(result.entries);
    const checked = $("res-ext-checked");
    if (checked) checked.textContent = browsers.length ? W.t("ws.extChecked", listWords(browsers)) : "";

    const groups = groupExtensionEntries(result.entries);
    const { worthGroups, canReadGroups, offGroups, cantGroups } = sortExtensionGroups(groups);
    $("res-ext-worth").hidden = worthGroups.length === 0;
    $("res-ext-none").hidden = worthGroups.length !== 0;
    $("res-ext-worth-heading").textContent = W.t("ws.extWorth", worthGroups.length);
    $("res-ext-worth-cards").replaceChildren(...worthGroups.map(extensionGroupRow));
    $("res-ext-can-read").hidden = canReadGroups.length === 0;
    const canReadHeading = $("res-ext-can-read-heading");
    if (canReadHeading) {
      canReadHeading.textContent = W.t("ws.extCanRead", canReadGroups.filter((group) => !isOnlySelf(group)).length);
    }
    $("res-ext-can-read-rows").replaceChildren(...canReadGroups.map(extensionGroupRow));

    foldGroups("res-ext-cant", cantGroups, "ws.extCant");
    foldGroups("res-ext-off", offGroups, "ws.extOff");

    const worthCount = worthGroups.length;
    setAreaSummary(
      "ext",
      groups.filter((group) => !isOnlySelf(group)).length,
      worthCount ? W.t("ws.resLeadExt", fmt(worthCount)) : "",
      worthGroups[0] ? extensionFirstStep(worthGroups[0]) : null,
      4,
    );
  }

  async function refreshExtensions() {
    if (!call) return;
    const records = await call("ext_check");
    const result = C.checkExtensions(records, {
      aiSites: aiSites(),
      reportedExtensions: C.reportedExtensions,
      words: {},
    });
    renderExtensions(result);
  }

  // ---------- Save a summary ----------

  // A one-page report built from the last finished scan's own files and counts, never a value (saved-summary.js's
  // `report`). The preview here is drawn from the same report with createElement, so it never needs
  // innerHTML; the saved and printed page is saved-summary.js's own HTML string.

  function summaryNamesOn() {
    return $("sum-names")?.getAttribute("aria-checked") !== "false";
  }

  function summaryInput() {
    return {
      kind: scanKind,
      files,
      counts: scanCounts,
      since: scanSince,
      filesRead: scanFilesRead,
      ending: scanEnding,
      notRead: scanNotRead,
    };
  }

  function summaryOptions() {
    return { names: summaryNamesOn(), t: W.t, lang, planTicked: planTicked() };
  }

  function summaryReport() {
    return globalThis.ClotrSummary.report(summaryInput(), summaryOptions());
  }

  function summaryLead(lead) {
    const kids = [createNode("p", { className: "res-head", textContent: lead.head })];
    if (lead.detail) kids.push(createNode("p", { textContent: lead.detail }));
    if (lead.quiet) kids.push(createNode("p", { className: "small muted", textContent: lead.quiet }));
    return createNode("div", { className: "sum-lead" }, kids);
  }

  function summaryPlanStep(step, doneWord) {
    const what = [`${step.what} (${step.count})`];
    if (step.done) what.push(createNode("span", { className: "tag good", textContent: doneWord }));
    const kids = [
      createNode("p", { className: "plan-what" }, what),
      createNode("p", { className: "small muted", textContent: step.why }),
      createNode("p", { className: "small", textContent: step.how }),
    ];
    if (step.names.length) {
      const names = step.names.map((named) => createNode("li", {}, [`${named.name} · ${named.where}`]));
      kids.push(createNode("ul", { className: "fr-copies" }, names));
    }
    if (step.more) kids.push(createNode("p", { className: "small muted", textContent: step.more }));
    return createNode("li", { className: `plan-step${step.done ? " done" : ""}` }, kids);
  }

  function summaryPlanSection(plan) {
    return createNode("section", { className: "sum-plan" }, [
      createNode("h3", { textContent: plan.title }),
      createNode("p", { className: "small muted", textContent: plan.lead }),
      createNode(
        "ol",
        { className: "plan-steps" },
        plan.steps.map((step) => summaryPlanStep(step, plan.doneWord)),
      ),
    ]);
  }

  function summaryGroupSection(report, group) {
    const head = createNode("tr", {}, [
      createNode("th", { scope: "col", textContent: report.heads.folder }),
      createNode("th", { scope: "col", className: "num", textContent: report.heads.files }),
      createNode("th", { scope: "col", textContent: report.heads.what }),
    ]);
    const rows = group.rows.map((row) =>
      createNode("tr", {}, [
        createNode("td", { textContent: row.folder }),
        createNode("td", { className: "num", textContent: row.files }),
        createNode("td", { textContent: row.what }),
      ]),
    );
    const section = createNode("section", { className: `sum-group ${group.id}` }, [
      createNode("h3", {}, [
        createNode("span", { className: `dot ${GROUP_DOT[group.id]}`, ariaHidden: "true" }),
        createNode("span", { textContent: group.title }),
        createNode("span", { className: "rg-count", textContent: group.count }),
      ]),
      createNode("table", { className: "events" }, [createNode("thead", {}, [head]), createNode("tbody", {}, rows)]),
    ]);
    if (!group.names.length) return section;
    const names = group.names.map((named) =>
      createNode("li", {}, [named.name, createNode("span", { className: "muted", textContent: ` · ${named.where}` })]),
    );
    section.append(createNode("ul", { className: "sum-names" }, names));
    if (group.more) section.append(createNode("p", { className: "small muted", textContent: group.more }));
    return section;
  }

  function renderSummaryPreview() {
    const host = $("res-summary-preview");
    if (!globalThis.ClotrSummary || !host) return;
    const report = summaryReport();
    const kids = [createNode("p", { className: "small muted", textContent: report.meta }), summaryLead(report.lead)];
    if (report.plan.steps.length) kids.push(summaryPlanSection(report.plan));
    for (const group of report.groups) kids.push(summaryGroupSection(report, group));
    if (report.none) kids.push(createNode("p", { textContent: report.none }));
    kids.push(createNode("h3", { textContent: report.notReadTitle }));
    kids.push(createNode("p", { textContent: report.notRead }));
    host.replaceChildren(...kids);
  }

  function summaryHtml() {
    return globalThis.ClotrSummary.summaryPage(summaryInput(), summaryOptions());
  }

  function openSummaryPanel() {
    $("res-summary-status").textContent = "";
    renderSummaryPreview();
    $("res-summary-panel").hidden = false;
    $("res-summary-heading").focus?.();
  }

  function closeSummaryPanel() {
    $("res-summary-panel").hidden = true;
  }

  function wireSummaryPanel() {
    $("res-summary-open")?.addEventListener("click", openSummaryPanel);
    $("res-summary-close")?.addEventListener("click", closeSummaryPanel);
    $("sum-names")?.addEventListener("click", () => {
      const box = $("sum-names");
      box.setAttribute("aria-checked", String(box.getAttribute("aria-checked") !== "true"));
      renderSummaryPreview();
    });
    $("res-summary-save")?.addEventListener("click", async () => {
      const result = await call("save_summary", { html: summaryHtml() }).catch(() => ({ saved: false }));
      $("res-summary-status").textContent = result.saved ? W.t("settings.saved") : "";
    });
    $("res-summary-print")?.addEventListener("click", () => {
      document.body.classList.add("printing-summary");
      window.print();
    });
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-summary"));
  }

  // ---------- Wiring ----------

  function draw(view, locale) {
    lang = locale;
    appVersion = view?.appVersion || "";
    osVersion = view?.osVersion || "";
    const mode = view?.settings?.resultsMode;
    resultsMode = mode === "guided" || mode === "detailed" ? mode : null;
    planTickedIds = new Set(Array.isArray(view?.settings?.planTicked) ? view.settings.planTicked : []);
    renderSince();
    renderFiles();
    renderPlan();
    renderMode();
  }

  function wire({ save } = {}) {
    saveSettings = save || null;
    refreshExtensions().catch(() => {});
    wireSummaryPanel();
    wireGuided();
    // Read everything again: the link itself goes to the Scan screen, and the Full scan starts there.
    $("res-read-all")?.addEventListener("click", () => globalThis.ClotrScanScreen?.readEverything());
    $("res-report")?.addEventListener("click", async () => {
      const href = globalThis.ClotrNote?.reportMailto({ appVersion, osVersion, t: W.t });
      if (href) await call?.("open_mailto", { url: href }).catch(() => {});
    });
  }

  globalThis.ClotrResults = {
    draw,
    wire,
    setFiles,
    skippedLine,
    action: (command, payload = {}) => call(command, { ...payload, generation: scanGeneration }),
    setAreaSummary,
    renderExtensionFixture: renderExtensions,
    groupExtensionEntries,
    refreshExtensions,
    tagClass,
    isWorthALook,
    canRecycle,
    whyKeyFor,
    dominantType,
    primaryActionFor,
    clearCopyRefused,
    showCopyRefused,
  };
})();
