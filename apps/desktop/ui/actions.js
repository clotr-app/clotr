// Clotr for Windows -- Results' actions: Move it
// somewhere private and Move to the Recycle Bin for every kind, one function per action, each callable on one
// file or a whole bundle in a single call, each answering with one
// result per file the views can show straight away. Nothing here draws anything, reads `document`, or touches
// results.js, guided.js or detailed.js. Both views use these actions.
"use strict";

(() => {
  function indexesOf(files) {
    return (Array.isArray(files) ? files : [files]).map((f) => (typeof f === "number" ? f : f.index));
  }

  // Windows' own folder picker, opened on OneDrive's Personal Vault when this PC has one. Hands back the chosen
  // folder's own name (never its path -- Rust keeps that, the same way scan_pick_folders already does) or null if
  // the person closed the dialog without choosing anywhere. movePrivate calls this itself the first time a scan
  // hasn't had a folder chosen yet, so a view only needs to call it directly for "choose a different folder".
  async function pickPrivateFolder() {
    const { call } = globalThis.ClotrApp;
    const folder = await call("move_pick_folder");
    return folder ? { folder } : null;
  }

  // Move it somewhere private, on one file or a bundle: moves every file into the folder already chosen this
  // scan, picking one first if none has been chosen yet (Rust's own `scan_move` refuses the whole call with
  // "not-allowed" only in that one case; every other refusal is per file, below). One result per file, in the
  // same order as `files`: `{ index, moved, reason }`, `reason` set only when `moved` is false -- "changed" (the
  // file was edited or replaced since the scan looked at it), "linked" (the chosen folder or the file itself is a
  // link), "not-found" (the folder or the file is gone), "outside" (the computed destination didn't stay inside
  // the chosen folder), "not-moved" (the move itself failed) or "not-allowed" (the scan ended, or the person
  // closed the folder picker without choosing anywhere).
  async function movePrivate(files) {
    const indices = indexesOf(files);
    if (!indices.length) return [];
    const refused = () => indices.map((index) => ({ index, moved: false, reason: "not-allowed" }));
    try {
      return await globalThis.ClotrResults.action("scan_move", { indices });
    } catch {
      const picked = await pickPrivateFolder();
      if (!picked) return refused();
      try {
        return await globalThis.ClotrResults.action("scan_move", { indices });
      } catch {
        return refused();
      }
    }
  }

  // Undo, right after Move it somewhere private on the same card: puts one file back exactly where it was.
  async function unmovePrivate(index) {
    return globalThis.ClotrResults.action("scan_unmove", { index });
  }

  // Move to the Recycle Bin, open to every kind now (not only a text file's own key or password find): one file
  // or a bundle, one result per file in the same order as `files`: `{ index, recycled, reason }`, `reason` set
  // only when `recycled` is false (today always "changed" or "not-allowed", `scan_recycle`'s own guard). One call
  // from a view's own side (an array in, an array back); `scan_recycle` itself still acts one file at a time
  // underneath, the same as every other bundle action in results.js (Ignore, Leave this folder out).
  async function recycle(files) {
    const indices = indexesOf(files);
    const results = [];
    for (const index of indices) {
      try {
        await globalThis.ClotrResults.action("scan_recycle", { index });
        results.push({ index, recycled: true });
      } catch (err) {
        results.push({ index, recycled: false, reason: String(err) });
      }
    }
    return results;
  }

  // Undo, right after Move to the Recycle Bin on the same card: puts one file back exactly where it was.
  async function unrecycle(index) {
    return globalThis.ClotrResults.action("scan_unrecycle", { index });
  }

  globalThis.ClotrActions = { pickPrivateFolder, movePrivate, unmovePrivate, recycle, unrecycle };
})();
