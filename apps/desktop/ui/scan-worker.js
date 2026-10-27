// Clotr for Windows — the scan's worker and Look back's reader: runs the engine and the readers here and only
// here, so the page never touches a value and (for Check my files) never needs a path. Loaded from Clotr's own
// files only (importScripts of a same-folder name, under dist/, where prepare-ui.js writes the engine bundle
// built with --scans, so Look back's and Extension check's shared readers ride along with the rest); the web
// view's CSP, default-src 'self', blocks any other.
// Check my files: scan.js sends each counted file's bytes with the walker's own index, name, kind and a
// fresh, run-only salt (scan.rs); this posts back the kinds found, how many of each, and each match's own
// salted fingerprint for that run (4.14, so two files holding the same card number can be told apart from two
// that merely each hold one), never a value, never the name.
// Look back: the screen posts the File objects the person picked (the web view's file input, or
// bytes Tauri's dialog read without ever naming the path to this page), the same "picked" and "entries" shape the
// extension's own lookback-worker.js takes; this posts back the same events ("opened", "progress", "unsupported",
// "done", "manifest") so the two platforms' results screens can share one shape. Nothing here is
// written to storage, ever.
"use strict";

if (typeof importScripts === "function") {
  importScripts("dist/clotr-engine.js");
}

const {
  detect,
  redact,
  readAttachment,
  readAttachmentDetailed,
  readPicture,
  readExport,
  detectManifest,
  fileEntriesFromZip,
  folderFileEntries,
  multiPartFileEntries,
  fromFile,
  fingerprint,
} = globalThis.Clotr;

// A file's pattern hits (detect()'s or readPicture()'s shape), grouped to counts only: nothing detected is stored
// (4.0), and that floor holds for what crosses out of this worker too.
function kindsFound(results) {
  const counts = {};
  for (const r of results) counts[r.id] = (counts[r.id] || 0) + r.matches.length;
  return counts;
}

// The same detail in several files (4.14): each match's own salted fingerprint, never the value itself, so
// scan.js can tell two files hold the same card number (say) apart from two files that merely hold a card
// number each. `salt` is a fresh, in-memory-only value scan.js makes for this run alone (never the store's own
// salt, never written anywhere), so the fingerprints mean nothing once the run or the page is gone.
function matchFps(results, salt) {
  const fps = {};
  for (const r of results) fps[r.id] = r.matches.map((m) => fingerprint(salt, r.id, m));
  return fps;
}

// One counted file's bytes, read by the readers the extension already has: `readAttachment` for text and
// documents (which already reads Office's comments and speaker notes where it covers that part, 4.2) and
// `readPicture` for a photo's place and a name that says it's an ID or other document. `meta.kind` is the
// walker's own category for the file ("text", "doc" or "picture", scan.rs). Never throws: an unreadable file
// comes back with nothing found and, for a doc Clotr recognizes by name, why ("locked", "scan" or "damaged",
// 4.3) -- so it's counted as "weren't read", never silently "clean". `salt`, when given, adds `fps` (4.14);
// without it (an old caller, or a test that never asks), the result's shape is exactly as before.
// The bytes as the readers take a file (name, type, size, text, arrayBuffer, slice), read where they already are.
// A real File would be a Blob, which the web view registers with its browser process and only lets go of when
// this worker's garbage collector gets round to it: over thousands of files that left the browser process holding
// and paging their bytes, and busy long after the scan was done.
function bytesFile(bytes, name) {
  const all = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const view = (u8) => ({
    name,
    type: "",
    size: u8.length,
    arrayBuffer: async () => u8.slice().buffer,
    text: async () => new TextDecoder().decode(u8),
    // Blob.slice's own rules: a negative end counts back from the end, and everything is clamped to the size.
    slice: (start = 0, end = u8.length) => {
      const at = (n) => (n < 0 ? Math.max(u8.length + n, 0) : Math.min(n, u8.length));
      return view(u8.subarray(at(start), Math.max(at(start), at(end))));
    },
    stream: () => new Blob([u8]).stream(),
  });
  return view(all);
}

async function readCandidate(bytes, meta, salt) {
  try {
    const file = bytesFile(bytes, meta?.name || "");
    const withFps = (results) => (salt ? { fps: matchFps(results, salt) } : {});
    if (meta?.kind === "picture") {
      const results = await readPicture(file);
      return { found: kindsFound(results), reason: null, ...withFps(results) };
    }
    const { text, reason } = await readAttachmentDetailed(file);
    const results = text ? detect(text) : [];
    return { found: kindsFound(results), reason, ...withFps(results) };
  } catch {
    return { found: {}, reason: "damaged" };
  }
}

// ---------- Save a copy: built here, never on the page, so the page only ever carries bytes it
// already asked for. Text (`variant: "hidden"`): the engine's own `redact()` over what `readAttachment` found, so
// a redacted copy holds exactly what the card showed, never more. A picture (`variant: "noPlace"`): redrawn on an
// `OffscreenCanvas`, which carries no EXIF forward (there's nothing to strip; a fresh canvas never had it). HEIC
// isn't offered this button (results.js), since WebView2 can't decode it to redraw. ----------
async function buildCopy(bytes, meta) {
  const file = new File([bytes], meta?.name || "", {});
  if (meta?.variant === "noPlace") {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const type = { png: "image/png", webp: "image/webp" }[meta?.ext?.toLowerCase()] || "image/jpeg";
    const blob = await canvas.convertToBlob({ type });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const text = (await readAttachment(file)) || "";
  return new TextEncoder().encode(redact(text, detect(text)));
}

// ---------- Look back: the same walk as the extension's lookback-worker.js ----------

// A .tgz (Takeout's other export choice) isn't a zip at all: say so without ever trying to open it as one, the
// same way the extension's own worker does ("choose .zip" -- .tgz isn't supported yet).
function looksLikeTgz(name) {
  return /\.tgz$|\.tar\.gz$/i.test(name || "");
}

// `entries`: [{ name, file }], the File objects the page already picked, never a path. "folder"/"json" come from
// the web view's own file input or a dropped folder; "zip" is the one archive file, read by zip.js; "parts" is
// several files chosen together (Claude's split export, conversations-000.zip, -001.zip…), read as one export.
async function buildLookbackEntries(picked, entries) {
  if (picked === "zip") return fileEntriesFromZip(fromFile(entries[0].file));
  if (picked === "parts") return multiPartFileEntries(entries);
  const byName = {};
  for (const { name, file } of entries) byName[name] = file;
  return folderFileEntries(byName);
}

// Reads one picked export exactly as the extension's own worker does, emitting the same event names
// ("opened", "progress", "unsupported", "done", "manifest") so a results screen can read either platform's
// worker the same way. Returns the result on success, or null when nothing was read (said through
// `onEvent`).
async function readLookback(picked, entries, { vault, onEvent } = {}) {
  const emit = onEvent || (() => {});
  if ((picked === "zip" || picked === "parts") && entries.some((en) => looksLikeTgz(en.name))) {
    emit({ type: "unsupported", kind: "tgz" });
    return null;
  }
  let fileEntries;
  try {
    fileEntries = await buildLookbackEntries(picked, entries);
  } catch (err) {
    emit({ type: "unsupported", kind: "damaged", message: err?.message });
    return null;
  }

  // Claude's October 2026 export emails a small list of download links first, not the export itself (recognized
  // by its shape, never by a file name): say so plainly instead of reading on and calling it "unknown", the same
  // as the extension's own worker.
  const manifest = await detectManifest(fileEntries);
  if (manifest) {
    emit({ type: "manifest", manifest });
    return null;
  }

  const totalBytes = fileEntries.reduce((s, f) => s + (f.size || 0), 0);
  emit({ type: "opened", totalBytes });
  const result = await readExport(fileEntries, { vault, onProgress: (tick) => emit({ type: "progress", ...tick }) });
  if (result.format === null) {
    // A bare .json or .jsonl picked on its own (never a .zip or a folder) gets a message that names the file
    // Look back actually reads, since the generic "can't read this export" line leaves a person guessing.
    emit({ type: "unsupported", kind: picked === "json" ? "unknownJson" : "unknown" });
    return null;
  }
  if (result.format === "gemini-html") {
    emit({ type: "unsupported", kind: "html" });
    return null;
  }
  if (result.format === "gemini-no-chats") {
    emit({ type: "unsupported", kind: "geminiNoChats" });
    return null;
  }
  emit({ type: "done", result });
  return result;
}

if (typeof self !== "undefined") {
  self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.type === "lookback") {
      try {
        await readLookback(msg.picked, msg.entries, { vault: msg.vault, onEvent: (ev) => postMessage(ev) });
      } catch (err) {
        postMessage({ type: "error", message: err?.message || String(err) });
      }
      return;
    }
    if (msg.type === "copy") {
      try {
        const out = await buildCopy(msg.bytes, { name: msg.name, ext: msg.ext, variant: msg.variant });
        postMessage({ type: "copy", index: msg.index, bytes: out }, [out.buffer]);
      } catch {
        postMessage({ type: "copy", index: msg.index, error: true });
      }
      return;
    }
    const { index, name, kind, bytes, salt } = msg;
    const { found, reason, fps } = await readCandidate(bytes, { name, kind }, salt);
    postMessage({ index, found, reason, fps });
  };
}

// Reached directly by a Node test (tests/scan-worker.test.js, tests/desktop-lookback.test.js) over fixtures, with
// no worker and no page.
globalThis.ClotrScanWorker = { readCandidate, kindsFound, matchFps, readLookback, buildCopy };
