// Clotr for Windows -- Detailed results: a permanent left rail of filters
// (kind, place, status), the matching list in the middle, and the file always open on the right with Next up above
// it. results.js calls render() at the one point it used to build the old list itself (its own renderFiles());
// everything else on Results -- the summary band, the full "What to do first" plan, Guided, the chooser -- stays
// exactly where it was, and keeps ticking the one shared plan.
"use strict";

(() => {
  const F = () => globalThis.ClotrFindings;
  const P = () => globalThis.ClotrPlan;
  const K = () => globalThis.ClotrFileKinds;

  const PAGE = 50; // a place's own rows, 50 at a time

  // The same three fix buttons Results and Guided already offer, kept here too (guided.js's own comment explains
  // why: this file stays independent of results.js, which touches document, so both are testable without a page).
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
  // What the pane's own headline says Clotr found, by the plan step a file matches first (plan.js's own order); a
  // file past every step (projects, contact) falls back to a plain headline built from its own kinds phrase.
  const WHAT_FOUND = {
    keys: "ws.dtlFoundKeys",
    idPhotos: "ws.dtlFoundIdPhotos",
    idDocs: "ws.dtlFoundIdDocs",
    photoPlace: "ws.dtlFoundPhotoPlace",
    money: "ws.dtlFoundMoney",
  };
  const STATUS_IDS = ["new", "ignored", "done"];
  const STATUS_WORD = { new: "ws.newFind", ignored: "ws.resRowIgnored", done: "ws.planDone" };

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
  // results.js already hands detailed.js files folded by scope.js's own foldCopies: a copy's own index is gone by
  // then (only its folder name survives, for copiesLine's sentence), so an entry's own file is the only index left
  // to act on.
  function indexesOf(entry) {
    return [entry.file.index];
  }

  // A file's own status tags (it can carry more than one: new since the last check, and also ignored). Ignored
  // wins over Done, the same priority results.js's own stateTag reads a folded row's own tag from.
  function statusesOf(index, sets) {
    const out = [];
    if (sets.newIndexes?.has(index)) out.push("new");
    if (sets.ignoredIndexes?.has(index)) out.push("ignored");
    else if (sets.settledIndexes?.has(index)) out.push("done");
    return out;
  }

  // An entry passes a filter type when `skip` names it (facet counts read every filter but their own, so
  // unchecking Keys and passwords doesn't make its own count disappear) or, past that, this entry still matches it.
  // A file with no status tag at all (most files) always passes the status filter -- it isn't New, Ignored or Done,
  // there's simply nothing to filter it by.
  function passes(entry, state, sets, skip = {}) {
    if (!skip.kind && state.kindOff.has(entry.group)) return false;
    if (!skip.place && state.placeOff.has(entry.file.folder || "")) return false;
    if (!skip.status) {
      const statuses = statusesOf(entry.file.index, sets);
      if (statuses.length && !statuses.some((s) => state.statusOn.has(s))) return false;
    }
    if (!skip.query && state.query && !entry.file.name.toLocaleLowerCase().includes(state.query)) return false;
    return true;
  }

  // The workbench's whole picture, pure (no DOM, no Tauri call): facet counts for the left rail, the filtered list
  // grouped by kind then place for the middle column. Exported mainly so grouping, filters and search have
  // something to unit test without a page. `files` arrives already folded by scope.js's own foldCopies (results.js's
  // setFiles does that before detailed.js ever sees them): each surviving
  // file may carry `.copies`, the other folders it's also in, as plain names -- not a second pass of folding here.
  function computeView(files, state, sets = {}) {
    const entries = (files || []).filter(hasFinds).map((file) => ({ file, copies: file.copies || [] }));
    for (const e of entries) {
      e.group = F().groupOf(e.file);
      e.severity = F().worstSeverity(e.file);
    }
    const kindCounts = new Map();
    const placeCounts = new Map();
    const statusCounts = { new: 0, ignored: 0, done: 0 };
    for (const e of entries) {
      if (passes(e, state, sets, { kind: true })) kindCounts.set(e.group, (kindCounts.get(e.group) || 0) + 1);
      const place = e.file.folder || "";
      if (passes(e, state, sets, { place: true })) placeCounts.set(place, (placeCounts.get(place) || 0) + 1);
      if (passes(e, state, sets, { status: true })) {
        for (const s of statusesOf(e.file.index, sets)) statusCounts[s] = (statusCounts[s] || 0) + 1;
      }
    }
    const shown = entries.filter((e) => passes(e, state, sets, {}));
    const byGroup = new Map();
    for (const e of shown) {
      if (!byGroup.has(e.group)) byGroup.set(e.group, []);
      byGroup.get(e.group).push(e);
    }
    const sections = [];
    for (const id of F().GROUPS) {
      const list = byGroup.get(id);
      if (!list?.length) continue;
      const byPlace = new Map();
      for (const e of list) {
        const label = e.file.folder || "";
        if (!byPlace.has(label)) byPlace.set(label, []);
        byPlace.get(label).push(e);
      }
      const places = [...byPlace.keys()].sort(collator.compare).map((label) => ({
        label,
        entries: byPlace.get(label).sort(compareEntries),
      }));
      sections.push({ id, files: list.length, places });
    }
    const kinds = F()
      .GROUPS.filter((id) => kindCounts.has(id))
      .map((id) => ({ id, count: kindCounts.get(id), checked: !state.kindOff.has(id) }));
    const places = [...placeCounts.keys()]
      .sort(collator.compare)
      .map((label) => ({ label, count: placeCounts.get(label), checked: !state.placeOff.has(label) }));
    const statuses = STATUS_IDS.map((id) => ({ id, count: statusCounts[id] || 0, checked: state.statusOn.has(id) }));
    return { sections, kinds, places, statuses, shownFiles: shown.length, entries: shown };
  }

  // Worst undone step first (plan.js's own order): the one file a step speaks to, for the pane's "why" and "what
  // to do" text; a file past every step (projects, contact) has none.
  function stepFor(file) {
    return P().STEPS.find((s) => s.match(file)) || null;
  }

  function nextUpStep(files, ticked) {
    const steps = P().buildPlan(files);
    const step = steps.find((s) => !ticked.has(s.id)) || null;
    return { step, steps, done: steps.filter((s) => ticked.has(s.id)).length, total: steps.length };
  }

  // A file's buttons use a fixed display order: Open leads and Move to the Recycle Bin trails. Move it somewhere
  // private appears when `ClotrActions.movePrivate` is available; until then an ID photo or document falls back to Open the
  // folder, the same way Guided's own table does.
  const ORDER = ["open", "movePrivate", "hide", "stripPlace", "leaveOut", "ignore", "recycle"];
  const RECOMMENDED = {
    keys: (file) => (canRecycle(file) ? "recycle" : canHideText(file) ? "hide" : "open"),
    idPhotos: () => (globalThis.ClotrActions?.movePrivate ? "movePrivate" : "open"),
    idDocs: () => (globalThis.ClotrActions?.movePrivate ? "movePrivate" : "open"),
    photoPlace: (file) => (canRedrawPicture(file) ? "stripPlace" : "open"),
    money: (file) => (canRecycle(file) ? "recycle" : "open"),
    leaveOutFolders: () => "leaveOut",
  };
  function actionsFor(file, stepId) {
    const all = new Set(["open", "ignore"]);
    if (globalThis.ClotrScope) all.add("leaveOut"); // the leaveOut button is scope.js's own, same guard results.js kept
    if (canRecycle(file)) all.add("recycle");
    if (canHideText(file)) all.add("hide");
    if (canRedrawPicture(file)) all.add("stripPlace");
    if (globalThis.ClotrActions?.movePrivate && (stepId === "idPhotos" || stepId === "idDocs")) all.add("movePrivate");
    const recommended = (stepId && RECOMMENDED[stepId]?.(file)) || "open";
    all.add(recommended);
    return { order: ORDER.filter((a) => all.has(a)), recommended };
  }

  // ========================================================================
  // DOM: the workbench itself. A pure `computeView` above feeds a three-column paint: the rail (facets), the list
  // (search + grouped rows, 50 at a time per place) and the pane (Next up, then the selected file). Only the pane
  // repaints on a selection change or keyboard move, so arrow-key focus is never lost mid-list.
  // ========================================================================

  const { call, bytes: callBytes } = globalThis.ClotrApp || {};

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  async function runWorker(message, transfer) {
    const worker = new Worker("scan-worker.js");
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data?.error ? reject(new Error("copy")) : resolve(e.data));
        worker.postMessage(message, transfer);
      });
    } finally {
      worker.terminate();
    }
  }
  async function saveCopy(file, variant) {
    const bytes = await callBytes("scan_next", { index: file.index });
    const built = await runWorker({ type: "copy", index: file.index, name: file.name, ext: file.ext, bytes, variant }, [
      bytes,
    ]);
    return globalThis.ClotrResults.action("scan_save_copy", {
      index: file.index,
      bytes: built.bytes,
      suggestedName: file.name,
    });
  }

  let host = null;
  let ctx = null; // results.js's own render(host, ctx) call: { files, sets, lang, fmt, W, planTicked, afterAction }
  let lastFiles = null;
  let state = { kindOff: new Set(), placeOff: new Set(), statusOn: new Set(["new"]), query: "" };
  let shownIn = new Map(); // "kind:place" -> how many rows are shown, kept across a repaint, reset by a new scan
  let selected = null; // the file index shown in the pane
  let rowButtons = []; // this paint's own rows, in visual order, for ArrowUp/ArrowDown
  // "Was this right?": once answered this session, the pane shows the quiet thank-you instead of asking
  // again. Reset the same place `selected` is, a new scan's own file list.
  let accuracyAnswered = new Set();

  function t(key, ...subs) {
    return ctx.W.t(key, ...subs);
  }
  function fmt(n) {
    return ctx.fmt(n);
  }
  function kindsPhrase(file) {
    const ids = Object.entries(file.found || {}).filter(([, n]) => n > 0);
    const plain = ids.map(([id, n]) => {
      const label = ctx.W.t(`ws.plain.${id}`);
      if (label === `ws.plain.${id}`) return null;
      return n === 1 ? label : `${label} (${ctx.fmt(n)})`;
    });
    if (plain.length && plain.every(Boolean)) {
      return new Intl.ListFormat(ctx.lang === "en" ? "en-GB" : ctx.lang, { type: "conjunction" }).format(plain);
    }
    return F().kindsPhrase(file.found, { t: ctx.W.t, lang: ctx.lang, fmt: ctx.fmt });
  }

  function facetRow(labelId, label, count, checked, onToggle) {
    const box = el("button", { className: "wb-box", type: "button" });
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(checked));
    box.setAttribute("aria-labelledby", labelId);
    box.addEventListener("click", () => onToggle(box.getAttribute("aria-checked") !== "true"));
    const text = el("span", { id: labelId, className: "wb-facet-label", textContent: label });
    const num = el("span", { className: "wb-facet-count", textContent: fmt(count) });
    return el("div", { className: "wb-facet-row" }, [box, text, num]);
  }

  let nextLabelId = 0;
  function facetSection(titleKey, items, labelFor, onToggle) {
    const box = el("div", { className: "wb-facet" }, [
      el("p", { className: "wb-facet-title", textContent: t(titleKey) }),
    ]);
    for (const item of items) {
      box.append(
        facetRow(`wb-l${nextLabelId++}`, labelFor(item), item.count, item.checked, (on) => onToggle(item, on)),
      );
    }
    return box;
  }

  // Wide: an always-open column, the summary never shown (detailed.css hides it, so nothing can close it).
  // Medium and narrow: a native <details> fold the facets into one "Filters" bar (detailed.css shows the summary
  // and spans the rail across the grid there), so the rail never competes with the list and pane for width.
  function renderRail(view) {
    const body = el("div", { className: "wb-rail-body" });
    body.append(
      facetSection(
        "ws.dtlKind",
        view.kinds,
        (k) => t(GROUP_WORD[k.id]),
        (item, on) => {
          if (on) state.kindOff.delete(item.id);
          else state.kindOff.add(item.id);
          repaintList();
        },
      ),
      facetSection(
        "ws.dtlPlace",
        view.places,
        (p) => prettyFolder(p.label),
        (item, on) => {
          // The place's own raw folder label is the key (findEntry/passes compare against `file.folder` directly),
          // never its capitalized display text, so a folder name that isn't one plain lowercase word still matches.
          if (on) state.placeOff.delete(item.label);
          else state.placeOff.add(item.label);
          repaintList();
        },
      ),
      facetSection(
        "ws.dtlStatus",
        view.statuses,
        (s) => t(STATUS_WORD[s.id]),
        (item, on) => {
          if (on) state.statusOn.add(item.id);
          else state.statusOn.delete(item.id);
          repaintList();
        },
      ),
    );
    const rail = el("details", { className: "wb-rail", open: true });
    rail.append(el("summary", { className: "wb-rail-toggle", textContent: t("ws.dtlFilters") }), body);
    return rail;
  }

  function selectEntry(index) {
    selected = index;
    repaintPane();
  }

  function rowNode(entry) {
    const file = entry.file;
    const tags = [];
    if (ctx.sets.newIndexes?.has(file.index)) {
      tags.push(el("span", { className: "tag soon", textContent: t("ws.newFind") }));
    }
    if (ctx.sets.ignoredIndexes?.has(file.index)) {
      tags.push(el("span", { className: "tag good", textContent: t("ws.resRowIgnored") }));
    } else if (ctx.sets.settledIndexes?.has(file.index)) {
      tags.push(el("span", { className: "tag good", textContent: t("ws.planDone") }));
    }
    const meta = kindsPhrase(file);
    const button = el("button", { className: "wb-row", type: "button" }, [
      el("span", { className: "wb-row-name" }, [el("b", { textContent: file.name, title: file.name }), ...tags]),
      el("span", { className: "wb-row-meta", textContent: meta, title: meta }),
    ]);
    button.dataset.index = String(file.index);
    if (file.index === selected) button.classList.toggle("current", true);
    button.addEventListener("click", () => selectEntry(file.index));
    const open = el("button", {
      className: "btn text sm wb-row-open",
      type: "button",
      textContent: t("ws.openFolder"),
    });
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      globalThis.ClotrResults.action("scan_reveal", { index: file.index });
    });
    const row = el("div", { className: "wb-row-wrap" }, [button, open]);
    rowButtons.push(button);
    return row;
  }

  function placeBlock(groupId, place) {
    const key = `${groupId}:${place.label}`;
    const shown = Math.min(shownIn.get(key) || PAGE, place.entries.length);
    const kids = [
      el("p", { className: "wb-place-title" }, [
        el("b", { textContent: prettyFolder(place.label) }),
        el("span", { className: "wb-place-count", textContent: filesWord(place.entries.length) }),
      ]),
    ];
    for (const entry of place.entries.slice(0, shown)) kids.push(rowNode(entry));
    const left = place.entries.length - shown;
    if (left > 0) {
      const more = el("button", {
        className: "btn sm wb-more",
        type: "button",
        textContent: t("ws.resShowMore", fmt(Math.min(PAGE, left)), fmt(left)),
      });
      more.addEventListener("click", () => {
        shownIn.set(key, shown + PAGE);
        repaintList();
      });
      kids.push(more);
    }
    return el("div", { className: "wb-place" }, kids);
  }

  function filesWord(n) {
    return n === 1 ? t("ws.resFileOne") : t("ws.resFilesN", fmt(n));
  }

  function sectionBlock(section) {
    const kids = [
      el("p", { className: "wb-section-title" }, [
        el("span", { className: `dot ${GROUP_DOT[section.id]}`, ariaHidden: "true" }),
        el("b", { textContent: t(GROUP_WORD[section.id]) }),
        el("span", { className: "wb-place-count", textContent: filesWord(section.files) }),
      ]),
      el("p", { className: "small muted wb-section-why", textContent: t(GROUP_WHY[section.id]) }),
    ];
    for (const place of section.places) kids.push(placeBlock(section.id, place));
    return el("div", { className: `wb-section ${section.id}` }, kids);
  }

  function onListKeydown(e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = rowButtons.indexOf(e.target);
    if (at === -1) return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? Math.min(at + 1, rowButtons.length - 1) : Math.max(at - 1, 0);
    rowButtons[next]?.focus();
  }

  function renderList(view) {
    const list = el("div", { className: "wb-list" });
    const search = el("input", { type: "search", className: "wb-find", autocomplete: "off", spellcheck: false });
    search.placeholder = t("ws.dtlFindFile");
    search.value = state.query;
    let typing = null;
    search.addEventListener("input", () => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        state.query = search.value;
        repaintList();
      }, 150);
    });
    list.append(search);
    rowButtons = [];
    if (!view.sections.length) {
      list.append(el("p", { className: "small muted wb-empty", textContent: t("ws.dtlEmpty") }));
    } else {
      const body = el("div", { className: "wb-sections" }, view.sections.map(sectionBlock));
      body.addEventListener("keydown", onListKeydown);
      list.append(body);
    }
    return list;
  }

  // ---------- The pane: Next up, then the selected file -- what it is, why it matters, what to do, and its own
  // actions (results.js's fileActions, adapted to a stacked column and the fixed button order). ----------

  function nextUpCard() {
    const { step, done, total } = nextUpStep(ctx.files, ctx.planTicked());
    if (!total) return null;
    const card = el("div", { className: "wb-nextup" });
    card.append(el("p", { className: "wb-nextup-label", textContent: t("ws.dtlNextUp") }));
    card.append(el("p", { className: "wb-nextup-what", textContent: step ? t(step.words.what) : t("ws.dtlAllDone") }));
    card.append(el("p", { className: "small muted", textContent: t("ws.dtlPlanProgress", fmt(done), fmt(total)) }));
    return card;
  }

  function foundHeadline(entry) {
    const spec = stepFor(entry.file);
    if (spec && WHAT_FOUND[spec.id]) return { spec, text: t(WHAT_FOUND[spec.id]) };
    const key = entry.group === "contact" ? "ws.dtlFoundContact" : "ws.dtlFoundDefault";
    return { spec: null, text: t(key, kindsPhrase(entry.file)) };
  }

  function markSettled(stepId, indexes) {
    for (const i of indexes) ctx.sets.settledIndexes.add(i);
    ctx.afterAction?.(stepId, indexes);
    repaintList(); // recomputes the view (status counts moved) and repaints the pane as its last step
  }

  function actionButton(actionId, file, entry, stepId, isRecommended) {
    const label = {
      open: "ws.openFolder",
      movePrivate: "ws.dtlMovePrivate",
      hide: "ws.copyHidden",
      stripPlace: "ws.copyNoPlace",
      ignore: "ws.ignore",
      recycle: "ws.recycle",
    }[actionId];
    // Guided's own buttons mark only the recommended one (its own .gd-btn.recommended); the workbench's actions
    // follow the same rule, recycle included, rather than inventing a danger colour this app doesn't use yet.
    const cls = `btn wb-action${isRecommended ? " primary" : ""}`;
    const button = el("button", { className: cls, type: "button", textContent: t(label) });
    button.addEventListener("click", async () => {
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
        if (actionId === "movePrivate") {
          const r = await globalThis.ClotrActions.movePrivate(file);
          if (r?.saved !== false) markSettled(stepId, [file.index]);
          else button.disabled = false;
          return;
        }
        if (actionId === "hide" || actionId === "stripPlace") {
          const r = await saveCopy(file, actionId === "hide" ? "hidden" : "noPlace");
          if (r.saved) markSettled(stepId, [file.index]);
          else button.disabled = false;
          return;
        }
        if (actionId === "ignore") {
          const all = indexesOf(entry);
          for (const index of all) await globalThis.ClotrResults.action("scan_ignore", { index });
          for (const index of all) ctx.sets.ignoredIndexes.add(index);
          markSettled(stepId, all);
        }
      } catch {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderRecycleConfirm(file, stepId) {
    const pane = host.querySelector(".wb-actions");
    if (!pane) return;
    const row = el("div", { className: "wb-actions-confirm" });
    row.append(el("p", { className: "small", textContent: t("ws.recycleConfirm", file.name) }));
    const yes = el("button", { className: "btn primary", type: "button", textContent: t("ws.recycleConfirmYes") });
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
    const cancel = el("button", { className: "btn", type: "button", textContent: t("ws.recycleCancel") });
    cancel.addEventListener("click", () => repaintPane());
    row.append(yes, cancel);
    pane.replaceChildren(row);
  }

  function fillActions(box, entry, stepId) {
    const file = entry.file;
    const index = file.index;
    if (
      ctx.sets.ignoredIndexes?.has(index) ||
      ctx.sets.recycledIndexes?.has(index) ||
      ctx.sets.settledIndexes?.has(index)
    ) {
      box.replaceChildren(el("p", { className: "tag good wb-done-tag", textContent: t("ws.cardDone") }));
      return;
    }
    const { order, recommended } = actionsFor(file, stepId);
    const kids = [];
    for (const actionId of order) {
      if (actionId === "leaveOut") {
        kids.push(
          ...globalThis.ClotrScope.leaveOutButtons(file, {
            call,
            settle: (row) => {
              ctx.sets.settledIndexes.add(index);
              box.replaceChildren(row);
            },
            restore: () => {
              ctx.sets.settledIndexes.delete(index);
              fillActions(box, entry, stepId);
            },
          }),
        );
        continue;
      }
      kids.push(actionButton(actionId, file, entry, stepId, actionId === recommended));
    }
    box.replaceChildren(...kids);
  }
  function paneActions(entry, stepId) {
    const box = el("div", { className: "wb-actions" });
    fillActions(box, entry, stepId);
    return box;
  }

  // "Was this right?": the same control guided.js's cards offer, kept here too so detailed.js stays
  // independent of results.js. Never the file, its name, its place or the value -- only the kind and place tier
  // F().accuracyKindOf/accuracyTierOf work out fresh from what's already on screen.
  function accuracyControl(file) {
    const box = el("div", { className: "acc-check" });
    if (accuracyAnswered.has(file.index)) {
      box.append(el("p", { className: "small muted", textContent: t("ws.accThanks") }));
      return box;
    }
    const yes = el("button", { className: "btn sm", type: "button", textContent: t("ws.accYes") });
    const no = el("button", { className: "btn sm", type: "button", textContent: t("ws.accNo") });
    const answer = async (value) => {
      yes.disabled = true;
      no.disabled = true;
      try {
        await call("accuracy_answer", { kind: F().accuracyKindOf(file), tier: F().accuracyTierOf(file), yes: value });
      } catch {
        // Clotr never breaks over this: the thank-you still shows, just unsaved.
      }
      accuracyAnswered.add(file.index);
      box.replaceChildren(el("p", { className: "small muted", textContent: t("ws.accThanks") }));
    };
    yes.addEventListener("click", () => answer(true));
    no.addEventListener("click", () => answer(false));
    box.append(
      el("p", { className: "wb-pane-label", textContent: t("ws.accWasRight") }),
      el("div", { className: "acc-buttons" }, [yes, no]),
    );
    return box;
  }

  function paneBody(entry) {
    const file = entry.file;
    const spec = stepFor(file);
    const { text: headline } = foundHeadline(entry);
    const kids = [
      el("h3", { textContent: file.name }),
      el("p", { className: "small muted", textContent: prettyFolder(file.folder) }),
    ];
    // The same "what kind of file this is" line Guided opens with (file-kinds.js): one line, so it sits beside the
    // place line without crowding the rest of the pane.
    const kindLine = K()?.lineKeyFor(file);
    if (kindLine) kids.push(el("p", { className: "small muted", textContent: t(kindLine) }));
    kids.push(el("p", {}, [headline]));
    if (entry.copies?.length && globalThis.ClotrScope) {
      kids.push(el("p", { className: "small muted" }, [globalThis.ClotrScope.copiesLine(file)]));
    }
    kids.push(
      el("p", { className: "wb-pane-label", textContent: t("ws.gdWhyLabel") }),
      el("p", { className: "small muted", textContent: t(spec ? spec.words.why : GROUP_WHY[entry.group]) }),
    );
    if (spec) {
      const { steps } = nextUpStep(ctx.files, ctx.planTicked());
      const at = steps.findIndex((s) => s.id === spec.id) + 1;
      kids.push(
        el("p", { className: "wb-pane-label", textContent: t("ws.whatToDo") }),
        el("p", { className: "small", textContent: `${t(spec.words.what)} ${t("ws.dtlStepOf", fmt(at))}` }),
      );
    }
    kids.push(paneActions(entry, spec?.id));
    kids.push(accuracyControl(file));
    return el("div", { className: "wb-file" }, kids);
  }

  function findEntry(view, index) {
    for (const section of view.sections) {
      for (const place of section.places) {
        const hit = place.entries.find((e) => e.file.index === index);
        if (hit) return hit;
      }
    }
    return null;
  }

  function firstEntry(view) {
    return view.sections[0]?.places[0]?.entries[0] || null;
  }

  let lastView = { sections: [] };

  function repaintPane() {
    const pane = el("aside", { className: "wb-pane" });
    const up = nextUpCard();
    if (up) pane.append(up);
    let entry = selected == null ? null : findEntry(lastView, selected);
    if (!entry) entry = firstEntry(lastView);
    selected = entry ? entry.file.index : null;
    if (entry) pane.append(paneBody(entry));
    else pane.append(el("p", { className: "small muted", textContent: t("ws.dtlEmpty") }));
    host.querySelector(".wb-pane")?.replaceWith(pane);
  }

  function repaintList() {
    lastView = computeView(ctx.files, state, ctx.sets);
    const rail = renderRail(lastView);
    const list = renderList(lastView);
    const pane = el("aside", { className: "wb-pane" });
    host.replaceChildren(rail, list, pane);
    repaintPane();
  }

  // results.js's own single entry point, called whenever Detailed mode draws (setFiles, draw, the mode switch).
  // `ctx.files` is results.js's own folded list; a new scan (a new array reference) resets every filter, the
  // search box and which file is selected, the same reset setFiles() already gives the old list and Guided.
  function render(mountHost, renderCtx) {
    host = mountHost;
    ctx = renderCtx;
    if (ctx.files !== lastFiles) {
      lastFiles = ctx.files;
      state = { kindOff: new Set(), placeOff: new Set(), statusOn: new Set(["new"]), query: "" };
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
