// Look back's dedicated worker. The page posts the picked File objects here, never a copy of their bytes, and
// this file does every byte of the reading: opening the zip or folder, finding the export's shape, walking it
// with lookback-core.js, and posting progress back as it goes. Stop just means the page calls
// `worker.terminate()`, so this file never needs its own stop flag, and it never writes anything to storage.
"use strict";

importScripts("patterns.js", "detector.js", "decide.js", "attachments.js", "pictures.js", "zip.js", "lookback-core.js");

const { readExport, detectManifest, fileEntriesFromZip, folderFileEntries, multiPartFileEntries, fromFile } =
  globalThis.Clotr;

// A .tgz (Takeout's other export choice) isn't a zip at all: say so without ever trying to open it as one.
function looksLikeTgz(name) {
  return /\.tgz$|\.tar\.gz$/i.test(name || "");
}

async function buildFileEntries(picked, entries) {
  if (picked === "folder") {
    const byName = {};
    for (const { name, file } of entries) byName[name] = file;
    return folderFileEntries(byName);
  }
  if (picked === "json") return folderFileEntries({ [entries[0].name]: entries[0].file });
  // "parts" reads several files chosen together, such as Claude's split export, as one export.
  // "zip" is just the one file the company sent.
  if (picked === "parts") return multiPartFileEntries(entries);
  return fileEntriesFromZip(fromFile(entries[0].file));
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== "start") return;
  const { picked, entries, vault } = msg;
  try {
    if ((picked === "zip" || picked === "parts") && entries.some((en) => looksLikeTgz(en.name))) {
      postMessage({ type: "unsupported", kind: "tgz" });
      return;
    }

    let fileEntries;
    try {
      fileEntries = await buildFileEntries(picked, entries);
    } catch (err) {
      // Any failure opening the zip itself, such as a truncated file or too many entries, reads as damaged or
      // unreadable, and zip.js's own error message says which.
      postMessage({ type: "unsupported", kind: "damaged", message: err?.message });
      return;
    }

    // Claude's export can also email a small list of download links first, rather than the export itself. I
    // recognize that by its shape, not its file name, and say so plainly instead of reading on and calling it
    // "unknown".
    const manifest = await detectManifest(fileEntries);
    if (manifest) {
      postMessage({ type: "manifest", manifest });
      return;
    }

    const totalBytes = fileEntries.reduce((s, f) => s + (f.size || 0), 0);
    postMessage({ type: "opened", totalBytes });

    const result = await readExport(fileEntries, {
      vault,
      onProgress: (tick) => postMessage({ type: "progress", ...tick }),
    });

    if (result.format === null) {
      postMessage({ type: "unsupported", kind: "unknown" });
      return;
    }
    if (result.format === "gemini-html") {
      postMessage({ type: "unsupported", kind: "html" });
      return;
    }
    postMessage({ type: "done", result });
  } catch (err) {
    console.warn("[Clotr] Look back's worker couldn't read the export:", err instanceof Error ? err.message : err);
    postMessage({ type: "error", message: err?.message || String(err) });
  }
};
