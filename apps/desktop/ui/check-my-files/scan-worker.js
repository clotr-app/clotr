// Clotr for Windows — the scan's worker and Look back's reader: runs the engine and the readers here and only
// here, so the page never touches a value and (for Check my files) never needs a path. Loaded from Clotr's own
// files only (importScripts of a same-folder name, under dist/, where prepare-ui.js writes the engine bundle
// built with --scans, so Look back's and Extension check's shared readers ride along with the rest); the web
// view's CSP, default-src 'self', blocks any other.
// Check my files: scan-runner.js sends each counted file's bytes with the walker's own index, name, kind and a
// fresh, run-only salt (scan_run.rs); this posts back the kinds found, how many of each, and each match's own
// salted fingerprint for that run (4.14, so two files holding the same card number can be told apart from two
// that merely each hold one), never a value, never the name.
// Look back: the screen posts the File objects the person picked (the web view's file input, or
// bytes Tauri's dialog read without ever naming the path to this page), the same "picked" and "entries" shape the
// extension's own clotr-pages/look-back/look-back-worker.js takes; this posts back the same events ("opened", "progress", "unsupported",
// "done", "manifest") so the two platforms' results screens can share one shape. Nothing here is
// written to storage, ever.
"use strict";

if (typeof importScripts === "function") {
  importScripts("../dist/clotr-engine.js");
}

const {
  detect,
  redact,
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
// scan-runner.js can tell two files hold the same card number (say) apart from two files that merely hold a card
// number each. `salt` is a fresh, in-memory-only value scan-runner.js makes for this run alone (never the store's own
// salt, never written anywhere), so the fingerprints mean nothing once the run or the page is gone.
function matchFps(results, salt) {
  const fps = {};
  for (const r of results) fps[r.id] = r.matches.map((m) => fingerprint(salt, r.id, m));
  return fps;
}

// UTF-16 without a byte order mark is mostly ASCII, so most code units have a zero high byte and a nonzero low one.
function looksLikeUtf16(u8) {
  let ascii = 0;
  for (let i = 0; i + 1 < u8.length; i += 2) if (u8[i] !== 0 && u8[i + 1] === 0) ascii++;
  return ascii > 0 && ascii >= 0.75 * Math.floor(u8.length / 2);
}

// A text file's words, UTF-16 (Notepad's "Unicode", Windows PowerShell 5.1's `>`) read as UTF-16. `other` is any
// UTF-8 lines added to a UTF-16 file, read as UTF-8 less the UTF-16 runs (a letter beside a zero byte), or "" when
// there's nothing else to read.
function fileReadings(u8) {
  let text = null;
  if (u8[0] === 0xff && u8[1] === 0xfe) text = new TextDecoder("utf-16le").decode(u8.subarray(2));
  else if (u8[0] === 0xfe && u8[1] === 0xff) {
    const swapped = u8.slice(2, 2 + ((u8.length - 2) & ~1));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    text = new TextDecoder("utf-16le").decode(swapped);
  } else if (u8.includes(0) && looksLikeUtf16(u8)) text = new TextDecoder("utf-16le").decode(u8);
  if (text === null) return { text: new TextDecoder().decode(u8), other: "" };
  const other = new TextDecoder()
    .decode(u8)
    .replace(/(?:[^\0]\0)+|(?:\0[^\0])+/g, "\n")
    .replace(/[\0\ufffd]/g, "");
  return { text, other: /\S/.test(other) ? other : "" };
}

// Both readings, so a key in either is found.
function fileText(u8) {
  const { text, other } = fileReadings(u8);
  return other ? `${text}\n${other}` : text;
}

// One counted file's bytes, read by the readers the extension already has: `readAttachment` for text and
// documents (which already reads Office's comments and speaker notes where it covers that part, 4.2) and
// `readPicture` for a photo's place and a name that says it's an ID or other document. `meta.kind` is the
// walker's own category for the file ("text", "doc" or "picture", scan_rules.rs). Never throws: an unreadable file
// comes back with nothing found and, for a doc Clotr recognizes by name, why ("locked", "scan" or "damaged",
// 4.3) -- so it's counted as "weren't read", never silently "clean". `salt`, when given, adds `fps` (4.14);
// without it (an old caller, or a test that never asks), the result's shape is exactly as before.
// The bytes as the readers take a file (name, type, size, text, arrayBuffer, slice), read where they already are.
// A real File would be a Blob, which the web view registers with its browser process and only lets go of when
// this worker's garbage collector gets round to it: over thousands of files that left the browser process holding
// and paging their bytes, and busy long after the scan was done.
function bytesU8(bytes) {
  return ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

// `firstReading` gives a UTF-16 file's own reading alone, the one a copy is made from.
function bytesFile(bytes, name, firstReading = false) {
  const all = bytesU8(bytes);
  const view = (u8) => ({
    name,
    type: "",
    size: u8.length,
    arrayBuffer: async () => u8.slice().buffer,
    text: async () => (firstReading ? fileReadings(u8).text : fileText(u8)),
    // Blob.slice's own rules: a negative end counts back from the end, and everything is clamped to the size.
    slice: (start = 0, end = u8.length) => {
      const at = (n) => (n < 0 ? Math.max(u8.length + n, 0) : Math.min(n, u8.length));
      return view(u8.subarray(at(start), Math.max(at(start), at(end))));
    },
    stream: () => new Blob([u8]).stream(),
  });
  return view(all);
}

// The readers' text, or its plain text for a file the walker sends as text that no reader takes (a sign-in file such
// as .pgpass, whose name says nothing to them) and so gets null and no reason. A file a reader knows with no words
// in it, a drawing that is only shapes, has "" and stays that way.
async function textOf(file, meta) {
  const read = await readAttachmentDetailed(file);
  if (read.text !== null || read.reason || meta?.kind !== "text") return read;
  return { text: await file.text(), reason: null };
}

async function readCandidate(bytes, meta, salt) {
  try {
    const file = bytesFile(bytes, meta?.name || "");
    const withFps = (results) => (salt ? { fps: matchFps(results, salt) } : {});
    if (meta?.kind === "picture") {
      const results = await readPicture(file);
      return { found: kindsFound(results), reason: null, ...withFps(results) };
    }
    const { text, reason } = await textOf(file, meta);
    const results = text ? detect(text) : [];
    // The engine stopped before the end (its time limit): the rest wasn't checked, so the file never reads as clean.
    const partial = results.truncated ? { partial: true } : {};
    return { found: kindsFound(results), reason, ...withFps(results), ...partial };
  } catch {
    return { found: {}, reason: "damaged" };
  }
}

// ---------- Save a copy: built here, never on the page, so the page only ever carries bytes it
// already asked for. Text (`variant: "hidden"`): the engine's own `redact()` over what `readAttachment` found, so
// a redacted copy holds exactly what the card showed, never more. A picture (`variant: "noPlace"`): redrawn on an
// `OffscreenCanvas`, which carries no EXIF forward (there's nothing to strip; a fresh canvas never had it). HEIC
// isn't offered this button (results-screen.js), since WebView2 can't decode it to redraw. ----------
async function buildCopy(bytes, meta) {
  if (meta?.variant === "noPlace") {
    const file = new File([bytes], meta?.name || "", {});
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const type = { png: "image/png", webp: "image/webp" }[meta?.ext?.toLowerCase()] || "image/jpeg";
    const blob = await canvas.convertToBlob({ type });
    return new Uint8Array(await blob.arrayBuffer());
  }
  // Read the way Check my files read it, UTF-16 and sign-in files included. No copy is made of a file no reader gives
  // text for, or of one with a find in UTF-8 lines added to UTF-16, which the copy would hold as letters it can't hide.
  const { other } = fileReadings(bytesU8(bytes));
  if (other && detect(other).length) throw new Error("mixed");
  const { text } = await textOf(bytesFile(bytes, meta?.name || "", true), meta);
  if (typeof text !== "string") throw new Error("unread");
  const results = detect(text);
  // A check the time limit cut short could leave a value in the "hidden" copy, so none is saved.
  if (results.truncated) throw new Error("partial");
  return new TextEncoder().encode(redact(text, results));
}

// ---------- Look back: the same walk as the extension's clotr-pages/look-back/look-back-worker.js ----------

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
        const out = await buildCopy(msg.bytes, { name: msg.name, ext: msg.ext, kind: msg.kind, variant: msg.variant });
        postMessage({ type: "copy", index: msg.index, bytes: out }, [out.buffer]);
      } catch {
        postMessage({ type: "copy", index: msg.index, error: true });
      }
      return;
    }
    const { index, name, kind, bytes, salt } = msg;
    const { found, reason, fps, partial } = await readCandidate(bytes, { name, kind }, salt);
    postMessage({ index, found, reason, fps, ...(partial ? { partial } : {}) });
  };
}

// Reached directly by a Node test (tests/scan-worker.test.js, tests/desktop-lookback.test.js) over fixtures, with
// no worker and no page.
globalThis.ClotrScanWorker = { readCandidate, kindsFound, matchFps, readLookback, buildCopy };
