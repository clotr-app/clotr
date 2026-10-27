// Clotr for Windows -- "What to do" (Results, Save a summary and the print page all read this): a short, numbered
// plan built from a scan's own finds, grouped by the action it calls for rather than by file, worst first. Pure,
// like findings.js: no DOM, no Tauri call, only a file's own `{ index, name, folder, kind, found }`, and it never
// hands back `found` itself -- only names, so a step's file list is safe to put on screen, in a saved summary or
// on paper.
"use strict";

(() => {
  const F = () => globalThis.ClotrFindings;

  // Everyday folders a Quick or Full scan already expects to find things in (findings.js's own FOLDER_RANK): a
  // credential or number sitting outside every one of these reads as someone's own project rather than a backup.
  const EVERYDAY_FOLDERS = new Set(["desktop", "downloads", "documents", "pictures"]);

  // The catalog, worst first (findings.js's own group order: keys, ids, photos, money -- contact details never
  // need a look, so there's no step for them). Each `match` picks the file entries the step speaks to; `words` are
  // the three ws.* keys ("what to do", "why", "how") that summary.js and results.js both read, so a step's wording
  // lives in exactly one place. "Leave these folders out" is its own step, last and cross-cutting: it can share
  // files with "keys", "idDocs" or "money" above it, since leaving a folder out doesn't undo needing to change
  // what's in it.
  const STEPS = [
    {
      id: "keys",
      words: { what: "ws.planKeysWhat", why: "ws.planKeysWhy", how: "ws.planKeysHow" },
      match: (file) => F().groupOf(file) === "keys",
    },
    {
      id: "idPhotos",
      words: { what: "ws.planIdPhotosWhat", why: "ws.planIdPhotosWhy", how: "ws.planIdPhotosHow" },
      match: (file) => F().groupOf(file) === "ids" && file.kind === "picture",
    },
    {
      id: "idDocs",
      words: { what: "ws.planIdDocsWhat", why: "ws.planIdDocsWhy", how: "ws.planIdDocsHow" },
      match: (file) => F().groupOf(file) === "ids" && file.kind !== "picture",
    },
    {
      id: "photoPlace",
      words: { what: "ws.planPhotoPlaceWhat", why: "ws.planPhotoPlaceWhy", how: "ws.planPhotoPlaceHow" },
      match: (file) => F().groupOf(file) === "photos",
    },
    {
      id: "money",
      words: { what: "ws.planMoneyWhat", why: "ws.planMoneyWhy", how: "ws.planMoneyHow" },
      match: (file) => F().groupOf(file) === "money",
    },
    {
      id: "leaveOutFolders",
      words: { what: "ws.planLeaveOutWhat", why: "ws.planLeaveOutWhy", how: "ws.planLeaveOutHow" },
      match: (file) =>
        file.kind !== "picture" &&
        ["keys", "ids", "money"].includes(F().groupOf(file)) &&
        !EVERYDAY_FOLDERS.has(String(file.folder || "").toLowerCase()),
    },
  ];

  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }

  // One step per catalog entry that actually matches something, each with every file it's about (copies folded,
  // the same way Results and Save a summary read them), never that file's `found`. A scan of 965 files still
  // hands back at most STEPS.length steps: the list below the plan's own cap, in render, is what keeps a step's
  // own size from growing with the scan.
  function buildPlan(files) {
    const entries = F().foldCopies((files || []).filter(hasFinds));
    const steps = [];
    for (const spec of STEPS) {
      const matched = entries.filter((e) => spec.match(e.file));
      if (!matched.length) continue;
      steps.push({
        id: spec.id,
        words: spec.words,
        count: matched.length,
        // `kind` and `ext` ride along only so the photo place step's own fix button (results.js's `canRedrawPicture`,
        // `saveCopy`) knows whether and how to redraw the file: the same extension and file type already visible in
        // the file's own name and icon, never a found value. `place` is the folders below `folder`, for saying where.
        files: matched.map((e) => ({
          index: e.file.index,
          name: e.file.name,
          folder: e.file.folder || "",
          ...(e.file.place?.length ? { place: e.file.place } : {}),
          kind: e.file.kind,
          ext: e.file.ext || "",
        })),
      });
    }
    return steps;
  }

  globalThis.ClotrPlan = { buildPlan, STEPS };
})();
