// Clotr for Windows -- Detailed results: a permanent left rail of filters (kind, place, status), the matching
// list in the middle, and the file always open on the right with Next up above it. results-screen.js calls render()
// at the one point it used to build the old list itself (its own renderFiles()); everything else on Results
// -- the summary band, the full "What to do first" plan, Guided, the chooser -- stays exactly where it was,
// and keeps ticking the one shared plan.
"use strict";

(() => {
  // ---------- Setup ----------

  // Read when used, so each page's scripts can load in any order.
  function findingsApi() {
    return globalThis.ClotrFindings;
  }
  function planApi() {
    return globalThis.ClotrPlan;
  }
  function fileKindsApi() {
    return globalThis.ClotrFileKinds;
  }

  const PAGE = 50; // a place's own rows, 50 at a time

  // ---------- Which fixes a file can take ----------

  // The same three fix buttons Results and Guided already offer, kept here too (guided-cards.js's own comment
  // explains why: this file stays independent of results-screen.js, which touches document, so both are testable
  // without a page).
  const RECYCLE_KINDS = new Set([
    "password",
    "otp_secret",
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
  ]);

  function canRecycle(file) {
    return file.kind === "text" && Object.keys(file.found || {}).some((id) => RECYCLE_KINDS.has(id));
  }

  function canHideText(file) {
    return file.kind === "text";
  }

  function canRedrawPicture(file) {
    return file.kind === "picture" && !/^hei[cf]$/i.test(file.ext || "");
  }

  // ---------- Words for each group and status ----------

  const GROUP_WORD = {
    keys: "ws.grpKeys",
    ids: "ws.grpIds",
    photos: "ws.grpPhotos",
    money: "ws.grpMoney",
    projects: "ws.grpProjects",
    contact: "ws.grpContact",
  };
  const GROUP_WHY = {
    keys: "ws.grpKeysWhy",
    ids: "ws.grpIdsWhy",
    photos: "ws.grpPhotosWhy",
    money: "ws.grpMoneyWhy",
    projects: "ws.grpProjectsWhy",
    contact: "ws.grpContactWhy",
  };
  const GROUP_DOT = { keys: "err", ids: "err", photos: "soon", money: "soon", projects: "test", contact: "test" };
  // What the pane's own headline says Clotr found, by the plan step a file matches first (what-to-do-plan.js's own
  // order); a file past every step (projects, contact) falls back to a plain headline built from its own
  // kinds phrase.
  const WHAT_FOUND = {
    keys: "ws.dtlFoundKeys",
    idPhotos: "ws.dtlFoundIdPhotos",
    idDocs: "ws.dtlFoundIdDocs",
    photoPlace: "ws.dtlFoundPhotoPlace",
    money: "ws.dtlFoundMoney",
  };
  const STATUS_IDS = ["new", "ignored", "done"];
  const STATUS_WORD = { new: "ws.newFind", ignored: "ws.resRowIgnored", done: "ws.planDone" };

  // ---------- The workbench's picture, pure ----------

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function compareEntries(a, b) {
    const bySeverity = (a.severity ?? 1) - (b.severity ?? 1);
    if (bySeverity) return bySeverity;
    const byName = collator.compare(a.file.name, b.file.name);
    if (byName) return byName;
    return a.file.index - b.file.index;
  }

  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }

  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }

  // results-screen.js already hands detailed.js files folded by scan-coverage.js's own foldCopies: a copy's own index is
  // gone by then (only its folder name survives, for copiesLine's sentence), so an entry's own file is the
  // only index left to act on.
  function indexesOf(entry) {
    return [entry.file.index];
  }

  // A file's own status tags (it can carry more than one: new since the last check, and also ignored).
  // Ignored wins over Done, the same priority results-screen.js's own stateTag reads a folded row's own tag from.
  function statusesOf(index, sets) {
    const out = [];
    if (sets.newIndexes?.has(index)) out.push("new");
    if (sets.ignoredIndexes?.has(index)) out.push("ignored");
    else if (sets.settledIndexes?.has(index)) out.push("done");
    return out;
  }

  // An entry passes a filter type when `skip` names it (facet counts read every filter but their own, so
  // unchecking Keys and passwords doesn't make its own count disappear) or, past that, this entry still
  // matches it. A file with no status tag at all (most files) always passes the status filter -- it isn't
  // New, Ignored or Done, there's simply nothing to filter it by.
  function passes(entry, state, sets, skip = {}) {
    if (!skip.kind && state.kindOff.has(entry.group)) return false;
    if (!skip.place && state.placeOff.has(entry.file.folder || "")) return false;
    if (!skip.status) {
      const statuses = statusesOf(entry.file.index, sets);
      if (statuses.length && !statuses.some((status) => state.statusOn.has(status))) return false;
    }
    if (skip.query || !state.query) return true;
    return entry.file.name.toLocaleLowerCase().includes(state.query);
  }

  function entriesOf(files) {
    const entries = (files || []).filter(hasFinds).map((file) => ({ file, copies: file.copies || [] }));
    for (const entry of entries) {
      entry.group = findingsApi().groupOf(entry.file);
      entry.severity = findingsApi().worstSeverity(entry.file);
    }
    return entries;
  }

  function addOne(counts, key) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Each facet counts the entries that pass every filter but its own.
  function facetCounts(entries, state, sets) {
    const kindCounts = new Map();
    const placeCounts = new Map();
    const statusCounts = { new: 0, ignored: 0, done: 0 };
    for (const entry of entries) {
      if (passes(entry, state, sets, { kind: true })) addOne(kindCounts, entry.group);
      const place = entry.file.folder || "";
      if (passes(entry, state, sets, { place: true })) addOne(placeCounts, place);
      if (!passes(entry, state, sets, { status: true })) continue;
      for (const status of statusesOf(entry.file.index, sets)) statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    return { kindCounts, placeCounts, statusCounts };
  }

  function groupBy(entries, keyOf) {
    const groups = new Map();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return groups;
  }

  // The shown entries by kind (finding-groups.js's GROUPS order), then by place, each place's rows worst first.
  function sectionsOf(shown) {
    const byGroup = groupBy(shown, (entry) => entry.group);
    const sections = [];
    for (const id of findingsApi().GROUPS) {
      const list = byGroup.get(id);
      if (!list?.length) continue;
      const byPlace = groupBy(list, (entry) => entry.file.folder || "");
      const places = [...byPlace.keys()].sort(collator.compare).map((label) => ({
        label,
        entries: byPlace.get(label).sort(compareEntries),
      }));
      sections.push({ id, files: list.length, places });
    }
    return sections;
  }

  // The workbench's whole picture, pure (no DOM, no Tauri call): facet counts for the left rail, the filtered
  // list grouped by kind then place for the middle column. Exported mainly so grouping, filters and search
  // have something to unit test without a page. `files` arrives already folded by scan-coverage.js's own foldCopies
  // (results-screen.js's setFiles does that before detailed.js ever sees them): each surviving file may carry
  // `.copies`, the other folders it's also in, as plain names -- not a second pass of folding here.
  function computeView(files, state, sets = {}) {
    const entries = entriesOf(files);
    const { kindCounts, placeCounts, statusCounts } = facetCounts(entries, state, sets);
    const shown = entries.filter((entry) => passes(entry, state, sets, {}));
    const sections = sectionsOf(shown);
    const kinds = findingsApi()
      .GROUPS.filter((id) => kindCounts.has(id))
      .map((id) => ({ id, count: kindCounts.get(id), checked: !state.kindOff.has(id) }));
    const places = [...placeCounts.keys()]
      .sort(collator.compare)
      .map((label) => ({ label, count: placeCounts.get(label), checked: !state.placeOff.has(label) }));
    const statuses = STATUS_IDS.map((id) => ({ id, count: statusCounts[id] || 0, checked: state.statusOn.has(id) }));
    return { sections, kinds, places, statuses, shownFiles: shown.length, entries: shown };
  }

  // ---------- The plan's steps ----------

  // Worst undone step first (what-to-do-plan.js's own order): the one file a step speaks to, for the pane's "why" and
  // "what to do" text; a file past every step (projects, contact) has none.
  function stepFor(file) {
    return planApi().STEPS.find((step) => step.match(file)) || null;
  }

  function nextUpStep(files, ticked) {
    const steps = planApi().buildPlan(files);
    const step = steps.find((each) => !ticked.has(each.id)) || null;
    return { step, steps, done: steps.filter((each) => ticked.has(each.id)).length, total: steps.length };
  }

  // ---------- A file's buttons ----------

  // A file's buttons use a fixed display order: Open leads and Move to the Recycle Bin trails. Move it
  // somewhere private appears when `ClotrActions.movePrivate` is available; until then an ID photo or
  // document falls back to Open the folder, the same way Guided's own table does.
  const ORDER = ["open", "movePrivate", "hide", "stripPlace", "leaveOut", "ignore", "recycle"];

  function recommendForKeys(file) {
    if (canRecycle(file)) return "recycle";
    if (canHideText(file)) return "hide";
    return "open";
  }

  function recommendMovePrivate() {
    return globalThis.ClotrActions?.movePrivate ? "movePrivate" : "open";
  }

  const RECOMMENDED = {
    keys: recommendForKeys,
    idPhotos: recommendMovePrivate,
    idDocs: recommendMovePrivate,
    photoPlace: (file) => (canRedrawPicture(file) ? "stripPlace" : "open"),
    money: (file) => (canRecycle(file) ? "recycle" : "open"),
    leaveOutFolders: () => "leaveOut",
  };

  function actionsFor(file, stepId) {
    const all = new Set(["open", "ignore"]);
    if (globalThis.ClotrScope) all.add("leaveOut"); // the leaveOut button is scan-coverage.js's own, same guard results-screen.js kept
    if (canRecycle(file)) all.add("recycle");
    if (canHideText(file)) all.add("hide");
    if (canRedrawPicture(file)) all.add("stripPlace");
    const isIdStep = stepId === "idPhotos" || stepId === "idDocs";
    if (globalThis.ClotrActions?.movePrivate && isIdStep) all.add("movePrivate");
    const recommended = (stepId && RECOMMENDED[stepId]?.(file)) || "open";
    all.add(recommended);
    return { order: ORDER.filter((action) => all.has(action)), recommended };
  }

  // ---------- The DOM: the workbench itself ----------

  // A pure `computeView` above feeds a three-column paint: the rail (facets), the list (search + grouped
  // rows, 50 at a time per place) and the pane (Next up, then the selected file). Only the pane repaints on a
  // selection change or keyboard move, so arrow-key focus is never lost mid-list.

  const { call, bytes: callBytes } = globalThis.ClotrApp || {};

  function newElement(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

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

  // ---------- The workbench's state ----------

  function freshFilters() {
    return { kindOff: new Set(), placeOff: new Set(), statusOn: new Set(["new"]), query: "" };
  }

  let host = null;
  let ctx = null; // results-screen.js's own render(host, ctx) call: { files, sets, lang, fmt, W, planTicked, afterAction }
  let lastFiles = null;
  let state = freshFilters();
  let shownIn = new Map(); // "kind:place" -> how many rows are shown, kept across a repaint, reset by a new scan
  let selected = null; // the file index shown in the pane
  let rowButtons = []; // this paint's own rows, in visual order, for ArrowUp/ArrowDown
  // "Was this right?": once answered this session, the pane shows the quiet thank-you instead of asking
  // again. Reset the same place `selected` is, a new scan's own file list.
  let accuracyAnswered = new Set();
  let lastView = { sections: [] };

  // ---------- Words ----------

  function textFor(key, ...subs) {
    return ctx.W.t(key, ...subs);
  }

  function formatNumber(number) {
    return ctx.fmt(number);
  }

  function filesWord(count) {
    return count === 1 ? textFor("ws.resFileOne") : textFor("ws.resFilesN", formatNumber(count));
  }

  function kindsPhrase(file) {
    const ids = Object.entries(file.found || {}).filter(([, count]) => count > 0);
    const plain = ids.map(([id, count]) => {
      const label = ctx.W.t(`ws.plain.${id}`);
      if (label === `ws.plain.${id}`) return null;
      return count === 1 ? label : `${label} (${ctx.fmt(count)})`;
    });
    if (plain.length && plain.every(Boolean)) {
      return new Intl.ListFormat(ctx.lang === "en" ? "en-GB" : ctx.lang, { type: "conjunction" }).format(plain);
    }
    return findingsApi().kindsPhrase(file.found, { t: ctx.W.t, lang: ctx.lang, fmt: ctx.fmt });
  }

  // ---------- The rail: filters ----------

  let nextLabelId = 0;

  function facetRow(labelId, label, count, checked, onToggle) {
    const box = newElement("button", { className: "wb-box", type: "button" });
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(checked));
    box.setAttribute("aria-labelledby", labelId);
    box.addEventListener("click", () => onToggle(box.getAttribute("aria-checked") !== "true"));
    const text = newElement("span", { id: labelId, className: "wb-facet-label", textContent: label });
    const countText = newElement("span", { className: "wb-facet-count", textContent: formatNumber(count) });
    return newElement("div", { className: "wb-facet-row" }, [box, text, countText]);
  }

  function facetSection(titleKey, items, labelFor, onToggle) {
    const box = newElement("div", { className: "wb-facet" }, [
      newElement("p", { className: "wb-facet-title", textContent: textFor(titleKey) }),
    ]);
    for (const item of items) {
      const labelId = `wb-l${nextLabelId++}`;
      box.append(facetRow(labelId, labelFor(item), item.count, item.checked, (on) => onToggle(item, on)));
    }
    return box;
  }

  // Adds `key` to a filter set when the box is unchecked, takes it out when checked.
  function setOff(offSet, key, on) {
    if (on) offSet.delete(key);
    else offSet.add(key);
  }

  function toggleKind(item, on) {
    setOff(state.kindOff, item.id, on);
    repaintList();
  }

  // The place's own raw folder label is the key (findEntry/passes compare against `file.folder` directly),
  // never its capitalized display text, so a folder name that isn't one plain lowercase word still matches.
  function togglePlace(item, on) {
    setOff(state.placeOff, item.label, on);
    repaintList();
  }

  function toggleStatus(item, on) {
    if (on) state.statusOn.add(item.id);
    else state.statusOn.delete(item.id);
    repaintList();
  }

  // Wide: an always-open column, the summary never shown (detailed-view.css hides it, so nothing can close it).
  // Medium and narrow: a native <details> fold the facets into one "Filters" bar (detailed-view.css shows the
  // summary and spans the rail across the grid there), so the rail never competes with the list and pane for
  // width.
  function renderRail(view) {
    const body = newElement("div", { className: "wb-rail-body" });
    body.append(
      facetSection("ws.dtlKind", view.kinds, (kind) => textFor(GROUP_WORD[kind.id]), toggleKind),
      facetSection("ws.dtlPlace", view.places, (place) => prettyFolder(place.label), togglePlace),
      facetSection("ws.dtlStatus", view.statuses, (status) => textFor(STATUS_WORD[status.id]), toggleStatus),
    );
    const rail = newElement("details", { className: "wb-rail", open: true });
    rail.append(newElement("summary", { className: "wb-rail-toggle", textContent: textFor("ws.dtlFilters") }), body);
    return rail;
  }

  // ---------- The list: search and grouped rows ----------

  const SEARCH_WAIT_MS = 150;

  function selectEntry(index) {
    selected = index;
    repaintPane();
  }

  function rowTags(index) {
    const tags = [];
    if (ctx.sets.newIndexes?.has(index)) {
      tags.push(newElement("span", { className: "tag soon", textContent: textFor("ws.newFind") }));
    }
    if (ctx.sets.ignoredIndexes?.has(index)) {
      tags.push(newElement("span", { className: "tag good", textContent: textFor("ws.resRowIgnored") }));
    } else if (ctx.sets.settledIndexes?.has(index)) {
      tags.push(newElement("span", { className: "tag good", textContent: textFor("ws.planDone") }));
    }
    return tags;
  }

  function rowNode(entry) {
    const file = entry.file;
    const tags = rowTags(file.index);
    const meta = kindsPhrase(file);
    const button = newElement("button", { className: "wb-row", type: "button" }, [
      newElement("span", { className: "wb-row-name" }, [
        newElement("b", { textContent: file.name, title: file.name }),
        ...tags,
      ]),
      newElement("span", { className: "wb-row-meta", textContent: meta, title: meta }),
    ]);
    button.dataset.index = String(file.index);
    if (file.index === selected) button.classList.toggle("current", true);
    button.addEventListener("click", () => selectEntry(file.index));
    const open = newElement("button", {
      className: "btn text sm wb-row-open",
      type: "button",
      textContent: textFor("ws.openFolder"),
    });
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      globalThis.ClotrResults.action("scan_reveal", { index: file.index });
    });
    const row = newElement("div", { className: "wb-row-wrap" }, [button, open]);
    rowButtons.push(button);
    return row;
  }

  function placeBlock(groupId, place) {
    const key = `${groupId}:${place.label}`;
    const shown = Math.min(shownIn.get(key) || PAGE, place.entries.length);
    const kids = [
      newElement("p", { className: "wb-place-title" }, [
        newElement("b", { textContent: prettyFolder(place.label) }),
        newElement("span", { className: "wb-place-count", textContent: filesWord(place.entries.length) }),
      ]),
    ];
    for (const entry of place.entries.slice(0, shown)) kids.push(rowNode(entry));
    const left = place.entries.length - shown;
    if (left > 0) {
      const more = newElement("button", {
        className: "btn sm wb-more",
        type: "button",
        textContent: textFor("ws.resShowMore", formatNumber(Math.min(PAGE, left)), formatNumber(left)),
      });
      more.addEventListener("click", () => {
        shownIn.set(key, shown + PAGE);
        repaintList();
      });
      kids.push(more);
    }
    return newElement("div", { className: "wb-place" }, kids);
  }

  function sectionBlock(section) {
    const kids = [
      newElement("p", { className: "wb-section-title" }, [
        newElement("span", { className: `dot ${GROUP_DOT[section.id]}`, ariaHidden: "true" }),
        newElement("b", { textContent: textFor(GROUP_WORD[section.id]) }),
        newElement("span", { className: "wb-place-count", textContent: filesWord(section.files) }),
      ]),
      newElement("p", { className: "small muted wb-section-why", textContent: textFor(GROUP_WHY[section.id]) }),
    ];
    for (const place of section.places) kids.push(placeBlock(section.id, place));
    return newElement("div", { className: `wb-section ${section.id}` }, kids);
  }

  function onListKeydown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const at = rowButtons.indexOf(event.target);
    if (at === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? Math.min(at + 1, rowButtons.length - 1) : Math.max(at - 1, 0);
    rowButtons[next]?.focus();
  }

  function searchBox() {
    const search = newElement("input", {
      type: "search",
      className: "wb-find",
      autocomplete: "off",
      spellcheck: false,
    });
    search.placeholder = textFor("ws.dtlFindFile");
    search.value = state.query;
    let typing = null;
    search.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        state.query = search.value;
        repaintList();
      }, SEARCH_WAIT_MS);
    });
    return search;
  }

  function renderList(view) {
    const list = newElement("div", { className: "wb-list" });
    list.append(searchBox());
    rowButtons = [];
    if (!view.sections.length) {
      list.append(newElement("p", { className: "small muted wb-empty", textContent: textFor("ws.dtlEmpty") }));
      return list;
    }
    const body = newElement("div", { className: "wb-sections" }, view.sections.map(sectionBlock));
    body.addEventListener("keydown", onListKeydown);
    list.append(body);
    return list;
  }

  // ---------- The pane: Next up ----------

  function nextUpCard() {
    const { step, done, total } = nextUpStep(ctx.files, ctx.planTicked());
    if (!total) return null;
    const card = newElement("div", { className: "wb-nextup" });
    const what = step ? textFor(step.words.what) : textFor("ws.dtlAllDone");
    const progress = textFor("ws.dtlPlanProgress", formatNumber(done), formatNumber(total));
    card.append(newElement("p", { className: "wb-nextup-label", textContent: textFor("ws.dtlNextUp") }));
    card.append(newElement("p", { className: "wb-nextup-what", textContent: what }));
    card.append(newElement("p", { className: "small muted", textContent: progress }));
    return card;
  }

  // ---------- The pane: the selected file's actions ----------

  // What the selected file is, why it matters, what to do, and its own actions (results-screen.js's fileActions,
  // adapted to a stacked column and the fixed button order).

  const ACTION_WORD = {
    open: "ws.openFolder",
    movePrivate: "ws.dtlMovePrivate",
    hide: "ws.copyHidden",
    stripPlace: "ws.copyNoPlace",
    ignore: "ws.ignore",
    recycle: "ws.recycle",
  };

  function foundHeadline(entry) {
    const spec = stepFor(entry.file);
    if (spec && WHAT_FOUND[spec.id]) return { spec, text: textFor(WHAT_FOUND[spec.id]) };
    const key = entry.group === "contact" ? "ws.dtlFoundContact" : "ws.dtlFoundDefault";
    return { spec: null, text: textFor(key, kindsPhrase(entry.file)) };
  }

  function markSettled(stepId, indexes) {
    for (const index of indexes) ctx.sets.settledIndexes.add(index);
    ctx.afterAction?.(stepId, indexes);
    repaintList(); // recomputes the view (status counts moved) and repaints the pane as its last step
  }

  // The actions that wait for an answer: the button stays off until it comes, and back on when nothing was
  // saved.
  async function runSlowAction(actionId, file, entry, stepId, button) {
    if (actionId === "movePrivate") {
      const result = await globalThis.ClotrActions.movePrivate(file);
      if (result?.saved !== false) markSettled(stepId, [file.index]);
      else button.disabled = false;
      return;
    }
    if (actionId === "hide" || actionId === "stripPlace") {
      const result = await saveCopy(file, actionId === "hide" ? "hidden" : "noPlace");
      if (result.saved) markSettled(stepId, [file.index]);
      else button.disabled = false;
      return;
    }
    if (actionId === "ignore") {
      const all = indexesOf(entry);
      for (const index of all) await globalThis.ClotrResults.action("scan_ignore", { index });
      for (const index of all) ctx.sets.ignoredIndexes.add(index);
      markSettled(stepId, all);
    }
  }

  function actionButton(actionId, file, entry, stepId, isRecommended) {
    // Guided's own buttons mark only the recommended one (its own .gd-btn.recommended); the workbench's
    // actions follow the same rule, recycle included, rather than inventing a danger colour this app doesn't
    // use yet.
    const className = `btn wb-action${isRecommended ? " primary" : ""}`;
    const button = newElement("button", { className, type: "button", textContent: textFor(ACTION_WORD[actionId]) });
    button.addEventListener("click", async () => {
      const pane = host.querySelector(".wb-actions");
      globalThis.ClotrResults.clearCopyRefused(pane);
      if (actionId === "open") {
        globalThis.ClotrResults.action("scan_reveal", { index: file.index });
        return;
      }
      if (actionId === "recycle") {
        renderRecycleConfirm(file, stepId);
        return;
      }
      button.disabled = true;
      try {
        await runSlowAction(actionId, file, entry, stepId, button);
      } catch (err) {
        button.disabled = false;
        if (err?.refused) globalThis.ClotrResults.showCopyRefused(pane);
      }
    });
    return button;
  }

  function renderRecycleConfirm(file, stepId) {
    const pane = host.querySelector(".wb-actions");
    if (!pane) return;
    const row = newElement("div", { className: "wb-actions-confirm" });
    row.append(newElement("p", { className: "small", textContent: textFor("ws.recycleConfirm", file.name) }));
    const yesWord = textFor("ws.recycleConfirmYes");
    const yes = newElement("button", { className: "btn primary", type: "button", textContent: yesWord });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await globalThis.ClotrResults.action("scan_recycle", { index: file.index });
        ctx.sets.recycledIndexes.add(file.index);
        markSettled(stepId, [file.index]);
      } catch {
        yes.disabled = false;
      }
    });
    const cancel = newElement("button", { className: "btn", type: "button", textContent: textFor("ws.recycleCancel") });
    cancel.addEventListener("click", () => repaintPane());
    row.append(yes, cancel);
    pane.replaceChildren(row);
  }

  function isSettled(index) {
    const sets = ctx.sets;
    if (sets.ignoredIndexes?.has(index)) return true;
    if (sets.recycledIndexes?.has(index)) return true;
    return Boolean(sets.settledIndexes?.has(index));
  }

  function leaveOutButtons(box, entry, stepId) {
    const index = entry.file.index;
    return globalThis.ClotrScope.leaveOutButtons(entry.file, {
      call,
      settle: (row) => {
        ctx.sets.settledIndexes.add(index);
        box.replaceChildren(row);
      },
      restore: () => {
        ctx.sets.settledIndexes.delete(index);
        fillActions(box, entry, stepId);
      },
    });
  }

  function fillActions(box, entry, stepId) {
    const file = entry.file;
    if (isSettled(file.index)) {
      box.replaceChildren(newElement("p", { className: "tag good wb-done-tag", textContent: textFor("ws.cardDone") }));
      return;
    }
    const { order, recommended } = actionsFor(file, stepId);
    const kids = [];
    for (const actionId of order) {
      if (actionId === "leaveOut") kids.push(...leaveOutButtons(box, entry, stepId));
      else kids.push(actionButton(actionId, file, entry, stepId, actionId === recommended));
    }
    box.replaceChildren(...kids);
  }

  function paneActions(entry, stepId) {
    const box = newElement("div", { className: "wb-actions" });
    fillActions(box, entry, stepId);
    return box;
  }

  // ---------- The pane: "Was this right?" ----------

  // The same control guided-cards.js's cards offer, kept here too so detailed.js stays independent of results-screen.js.
  // Never the file, its name, its place or the value -- only the kind and place tier
  // findingsApi().accuracyKindOf/accuracyTierOf work out fresh from what's already on screen.
  function thanks() {
    return newElement("p", { className: "small muted", textContent: textFor("ws.accThanks") });
  }

  function accuracyControl(file) {
    const box = newElement("div", { className: "acc-check" });
    if (accuracyAnswered.has(file.index)) {
      box.append(thanks());
      return box;
    }
    const yesButton = newElement("button", { className: "btn sm", type: "button", textContent: textFor("ws.accYes") });
    const noButton = newElement("button", { className: "btn sm", type: "button", textContent: textFor("ws.accNo") });
    async function answer(value) {
      yesButton.disabled = true;
      noButton.disabled = true;
      try {
        const kind = findingsApi().accuracyKindOf(file);
        const tier = findingsApi().accuracyTierOf(file);
        await call("accuracy_answer", { kind, tier, yes: value });
      } catch {
        // Clotr never breaks over this: the thank-you still shows, just unsaved.
      }
      accuracyAnswered.add(file.index);
      box.replaceChildren(thanks());
    }
    yesButton.addEventListener("click", () => answer(true));
    noButton.addEventListener("click", () => answer(false));
    box.append(
      newElement("p", { className: "wb-pane-label", textContent: textFor("ws.accWasRight") }),
      newElement("div", { className: "acc-buttons" }, [yesButton, noButton]),
    );
    return box;
  }

  // ---------- The pane: the selected file ----------

  function paneBody(entry) {
    const file = entry.file;
    const spec = stepFor(file);
    const { text: headline } = foundHeadline(entry);
    const kids = [
      newElement("h3", { textContent: file.name }),
      newElement("p", { className: "small muted", textContent: prettyFolder(file.folder) }),
    ];
    // The same "what kind of file this is" line Guided opens with (file-kinds.js): one line, so it sits
    // beside the place line without crowding the rest of the pane.
    const kindLine = fileKindsApi()?.lineKeyFor(file);
    if (kindLine) kids.push(newElement("p", { className: "small muted", textContent: textFor(kindLine) }));
    kids.push(newElement("p", {}, [headline]));
    if (entry.copies?.length && globalThis.ClotrScope) {
      kids.push(newElement("p", { className: "small muted" }, [globalThis.ClotrScope.copiesLine(file)]));
    }
    const why = textFor(spec ? spec.words.why : GROUP_WHY[entry.group]);
    kids.push(
      newElement("p", { className: "wb-pane-label", textContent: textFor("ws.gdWhyLabel") }),
      newElement("p", { className: "small muted", textContent: why }),
    );
    if (spec) {
      const { steps } = nextUpStep(ctx.files, ctx.planTicked());
      const at = steps.findIndex((step) => step.id === spec.id) + 1;
      const whatToDo = `${textFor(spec.words.what)} ${textFor("ws.dtlStepOf", formatNumber(at))}`;
      kids.push(
        newElement("p", { className: "wb-pane-label", textContent: textFor("ws.whatToDo") }),
        newElement("p", { className: "small", textContent: whatToDo }),
      );
    }
    kids.push(paneActions(entry, spec?.id));
    kids.push(accuracyControl(file));
    return newElement("div", { className: "wb-file" }, kids);
  }

  // ---------- Painting ----------

  function findEntry(view, index) {
    for (const section of view.sections) {
      for (const place of section.places) {
        const hit = place.entries.find((entry) => entry.file.index === index);
        if (hit) return hit;
      }
    }
    return null;
  }

  function firstEntry(view) {
    return view.sections[0]?.places[0]?.entries[0] || null;
  }

  function repaintPane() {
    const pane = newElement("aside", { className: "wb-pane" });
    const nextUp = nextUpCard();
    if (nextUp) pane.append(nextUp);
    let entry = selected == null ? null : findEntry(lastView, selected);
    if (!entry) entry = firstEntry(lastView);
    selected = entry ? entry.file.index : null;
    if (entry) pane.append(paneBody(entry));
    else pane.append(newElement("p", { className: "small muted", textContent: textFor("ws.dtlEmpty") }));
    host.querySelector(".wb-pane")?.replaceWith(pane);
  }

  function repaintList() {
    lastView = computeView(ctx.files, state, ctx.sets);
    const rail = renderRail(lastView);
    const list = renderList(lastView);
    const pane = newElement("aside", { className: "wb-pane" });
    host.replaceChildren(rail, list, pane);
    repaintPane();
  }

  // results-screen.js's own single entry point, called whenever Detailed mode draws (setFiles, draw, the mode
  // switch). `ctx.files` is results-screen.js's own folded list; a new scan (a new array reference) resets every
  // filter, the search box and which file is selected, the same reset setFiles() already gives the old list
  // and Guided.
  function render(mountHost, renderCtx) {
    host = mountHost;
    ctx = renderCtx;
    if (ctx.files !== lastFiles) {
      lastFiles = ctx.files;
      state = freshFilters();
      shownIn = new Map();
      selected = null;
      accuracyAnswered = new Set();
    }
    repaintList();
  }

  globalThis.ClotrDetailed = {
    PAGE,
    GROUP_WORD,
    GROUP_WHY,
    GROUP_DOT,
    WHAT_FOUND,
    STATUS_IDS,
    STATUS_WORD,
    computeView,
    stepFor,
    nextUpStep,
    actionsFor,
    canRecycle,
    canHideText,
    canRedrawPicture,
    prettyFolder,
    render,
  };
})();
