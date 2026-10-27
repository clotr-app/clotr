// Clotr for Windows -- Guided results: the walk's own cards, one
// finding at a time, built over plan.js's own order (worst first) the same way plan.js is built over findings.js.
// Pure, like plan.js: no DOM, no Tauri call, only a file's own `{ index, name, folder, kind, ext, found }`, and a
// card never carries `found` itself, only names -- the same rule plan.js follows, so a card is just as safe to put
// on screen.
"use strict";

(() => {
  const F = () => globalThis.ClotrFindings;
  const P = () => globalThis.ClotrPlan;
  const K = () => globalThis.ClotrFileKinds;

  // A place's files past the sixth bundle into one card: a scan with 300 needs a look still walks
  // as about twenty cards, a scan with 3 as three.
  const BUNDLE_AT = 6;

  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  // Severity then name, the same order Results reads a folder's own rows in (findings.js's own compareEntries):
  // a private key never sits below a file with only a hostname in it.
  function compareEntries(a, b) {
    const bySeverity = (a.severity ?? 1) - (b.severity ?? 1);
    if (bySeverity) return bySeverity;
    const byName = collator.compare(a.file.name, b.file.name);
    if (byName) return byName;
    return a.file.index - b.file.index;
  }

  // The same fix buttons Results already offers (results.js's own canRecycle, canHideText, canRedrawPicture,
  // canMovePrivate), kept here too so guided.js never needs results.js (which touches document) to stay pure and
  // Node-testable. Move to the Recycle Bin is open to every kind that needs a look -- a key or password, an
  // ID, a photo's place or a card/bank number -- not only a password or key in a text file.
  function canRecycle(file) {
    return F().needsALook(file);
  }
  function canHideText(file) {
    return file.kind === "text";
  }
  function canRedrawPicture(file) {
    return file.kind === "picture" && !/^hei[cf]$/i.test(file.ext || "");
  }
  // Move it somewhere private: offered for an ID photo or an ID document, the same group plan.js's
  // idPhotos/idDocs steps match on (findings.js's groupOf).
  function canMovePrivate(file) {
    return F().groupOf(file) === "ids";
  }

  // The recommended button per step.
  const RECOMMENDED = {
    keys: (file) => (canRecycle(file) ? "recycle" : canHideText(file) ? "hide" : "open"),
    idPhotos: () => "movePrivate",
    idDocs: () => "movePrivate",
    photoPlace: (file) => (canRedrawPicture(file) ? "stripPlace" : "open"),
    money: (file) => (canRecycle(file) ? "recycle" : "open"),
    leaveOutFolders: () => "leaveOut",
  };

  function slimFile(file) {
    const slim = {
      index: file.index,
      name: file.name,
      folder: file.folder || "",
      kind: file.kind,
      ext: file.ext || "",
    };
    if (file.place?.length) slim.place = file.place;
    if (file.earlier) slim.earlier = true; // Kept from a previous Full, labeled rather than dropped silently
    // What kind of file this is, one locale key (file-kinds.js): who made it when the folder says so, else what
    // the extension is for, else nothing. Every file this walk names gets the same lookup, fileCard's one file and
    // every file a bundleCard lists alike.
    const kindLine = K()?.lineKeyFor(file) || "";
    if (kindLine) slim.kindLine = kindLine;
    return slim;
  }

  // Every button a file's own card can offer, the recommended one first: the
  // fixes that apply, then keep it and leave the folder out, then Open the folder when nothing else does.
  function actionsFor(file, recommended) {
    const all = [];
    if (canRecycle(file)) all.push("recycle");
    if (canHideText(file)) all.push("hide");
    if (canRedrawPicture(file)) all.push("stripPlace");
    if (canMovePrivate(file)) all.push("movePrivate");
    all.push("ignore", "leaveOut", "open");
    return [...new Set([recommended, ...all])];
  }

  function fileCard(spec, entry) {
    const recommended = RECOMMENDED[spec.id]?.(entry.file) || "open";
    return {
      type: "file",
      stepId: spec.id,
      words: spec.words,
      file: slimFile(entry.file),
      copies: (entry.copies || []).map(slimFile),
      recommended,
      actions: actionsFor(entry.file, recommended),
    };
  }

  // A bundle speaks for every file past the sixth in one place: kept simple on purpose, since most
  // steps' files are a mix of kinds -- Ignore and Leave this folder out act on all of them. An idPhotos/idDocs
  // bundle is never a mix (every file in it matched the same `canMovePrivate` group), so it moves its whole
  // bundle in one call instead. "One at a time" (expandBundle, below) splits it back into its own cards for
  // anyone who wants that instead.
  function bundleCard(spec, folder, entries) {
    const movable = spec.id === "idPhotos" || spec.id === "idDocs";
    const recommended = spec.id === "leaveOutFolders" ? "leaveOut" : movable ? "movePrivate" : "ignore";
    const base = movable ? ["movePrivate", "ignore", "leaveOut"] : ["ignore", "leaveOut"];
    return {
      type: "bundle",
      stepId: spec.id,
      words: spec.words,
      folder,
      count: entries.length,
      files: entries.map((e) => slimFile(e.file)),
      recommended,
      actions: [...new Set([recommended, ...base])],
    };
  }

  // One step's own cards: its files grouped by place, each place sorted worst-then-name, the worst place first;
  // a place's seventh file and on become one bundle card after the first six.
  function stepCards(spec, entries) {
    const byFolder = new Map();
    for (const entry of entries) {
      const label = entry.file.folder || "";
      if (!byFolder.has(label)) byFolder.set(label, []);
      byFolder.get(label).push(entry);
    }
    const folders = [...byFolder.entries()].map(([label, list]) => {
      list.sort(compareEntries);
      return { label, list, worst: Math.min(...list.map((e) => e.severity ?? 1)) };
    });
    folders.sort((a, b) => a.worst - b.worst || collator.compare(a.label, b.label));
    const cards = [];
    for (const { label, list } of folders) {
      for (const entry of list.slice(0, BUNDLE_AT)) cards.push(fileCard(spec, entry));
      const rest = list.slice(BUNDLE_AT);
      if (rest.length) cards.push(bundleCard(spec, label, rest));
    }
    return cards;
  }

  // The whole walk follows plan.js's order, worst first, with copies folded into one card. Never
  // a file's own finds reach a card -- only plan.js's own `{ index, name, folder, kind, ext }` shape, plus the
  // severity this file alone works out (a rank, 0 to 2, never what was found) to sort a place's own files by.
  function buildCards(files) {
    const entries = F().foldCopies((files || []).filter(hasFinds));
    for (const entry of entries) entry.severity = F().worstSeverity(entry.file);
    const cards = [];
    for (const spec of P().STEPS) {
      const matched = entries.filter((e) => spec.match(e.file));
      if (matched.length) cards.push(...stepCards(spec, matched));
    }
    return cards;
  }

  // "One at a time": a bundle's files become their own cards, the same shape stepCards would have
  // built for them had the place held six or fewer.
  function expandBundle(card) {
    if (card.type !== "bundle") return [card];
    const spec = { id: card.stepId, words: card.words };
    return card.files.map((file) => fileCard(spec, { file, copies: [] }));
  }

  // The rail has one entry per step, never one per file -- buildCards already
  // lays every step's own cards out one after another (it walks P().STEPS in order, each step's own matched
  // entries turned into cards in one run), so a step's cards are always a contiguous stretch of the flat array,
  // never interleaved with another step's. `files` counts what the step is actually about: a bundle speaks for
  // every file inside it, not the one card it drew.
  function groupRail(cards) {
    const groups = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const files = card.type === "bundle" ? card.count : 1;
      const last = groups[groups.length - 1];
      if (last && last.stepId === card.stepId) {
        last.length += 1;
        last.files += files;
      } else {
        groups.push({ stepId: card.stepId, words: card.words, start: i, length: 1, files });
      }
    }
    return groups;
  }

  globalThis.ClotrGuided = { buildCards, expandBundle, groupRail, BUNDLE_AT };
})();
