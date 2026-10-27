// Clotr for Windows -- what a scan covered, for Results: copies of one file folded into a single entry, the line that
// says what the walker skipped on purpose, and a card's own "leave this out of scans" buttons. The walker (scan.rs)
// marks a copy with `dupOf`, the index of the first file with the same bytes, and `parent`, the name of the folder
// it sits in, so the page can say where the copies are without ever holding a path.
(function () {
  "use strict";

  const W = globalThis.ClotrWords;
  const MAX_PLACES = 5; // folder names listed before "and N more"

  function list(items) {
    const lang = globalThis.document?.documentElement?.lang || "en";
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(items);
  }

  // Files with finds -> the first copy of each, as a new object carrying `copies` (the other copies' folder names,
  // one per copy). A copy whose first file isn't in the list (a stopped scan can end between the two) stays an entry
  // of its own.
  function foldCopies(files) {
    const first = new Map();
    const out = [];
    for (const f of files) {
      const lead = f.dupOf == null ? null : first.get(f.dupOf);
      if (lead) {
        lead.copies.push(f.parent || "");
        continue;
      }
      const entry = { ...f, copies: [] };
      if (f.dupOf == null) first.set(f.index, entry);
      out.push(entry);
    }
    return out;
  }

  // "The same file is in 37 other places too, in a, b, c, d, e and 32 more."
  function copiesLine(file) {
    const copies = file.copies || [];
    if (!copies.length) return "";
    const names = [...new Set(copies.filter(Boolean))];
    const shown = names.slice(0, MAX_PLACES);
    if (names.length > MAX_PLACES) shown.push(W.t("ws.copiesMore", String(names.length - MAX_PLACES)));
    if (!shown.length) return copies.length === 1 ? W.t("ws.copyOneBare") : W.t("ws.copiesBare", String(copies.length));
    return copies.length === 1 ? W.t("ws.copyOne", list(shown)) : W.t("ws.copies", String(copies.length), list(shown));
  }

  // What the walker skipped on purpose, from its counts: "" when it skipped nothing.
  function skippedLine(counts = {}) {
    const dev = counts.devFolders || 0;
    const vaults = counts.vaults || 0;
    const parts = [];
    if (dev) parts.push(dev === 1 ? W.t("ws.skipDevOne") : W.t("ws.skipDev", String(dev)));
    if (vaults) parts.push(vaults === 1 ? W.t("ws.skipVaultOne") : W.t("ws.skipVault", String(vaults)));
    const lines = [];
    if (parts.length === 2) lines.push(W.t("ws.skippedBoth", parts[0], parts[1]));
    else if (parts.length === 1) lines.push(W.t("ws.skipped", parts[0]));
    const mine = counts.excluded || 0;
    if (mine) lines.push(mine === 1 ? W.t("ws.leftOutOne") : W.t("ws.leftOut", String(mine)));
    return lines.join(" ");
  }

  function extensionOf(name) {
    const dot = String(name || "").lastIndexOf(".");
    return dot > 0 ? name.slice(dot).toLowerCase() : "";
  }

  // A card's two Leave out buttons, next to Ignore. Each one asks Rust to add the file's folder (or its type) to the
  // person's own list, then swaps the card's row (via `settle`) for a line saying so, with Undo.
  function leaveOutButtons(file, { call, settle, restore }) {
    const make = (what, key) => {
      const button = document.createElement("button");
      button.className = "btn sm";
      button.type = "button";
      button.textContent = W.t(key);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const added = await globalThis.ClotrResults.action("scan_exclude_from", { index: file.index, what });
          settle(leftOutRow(added, { call, restore }));
        } catch {
          button.disabled = false;
        }
      });
      return button;
    };
    const out = [make("folder", "ws.leaveFolder")];
    if (extensionOf(file.name)) out.push(make("type", "ws.leaveType"));
    return out;
  }

  function leftOutRow(added, { call, restore }) {
    const row = document.createElement("div");
    row.className = "btn-row";
    const words = document.createElement("span");
    words.className = "small";
    words.textContent =
      added.kind === "type" ? W.t("ws.leftOutType", added.name) : W.t("ws.leftOutFolder", added.name, added.parent);
    const undo = document.createElement("button");
    undo.className = "btn sm";
    undo.type = "button";
    undo.textContent = W.t("ws.undo");
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      try {
        await call("scan_unexclude", { id: added.id });
        restore();
      } catch {
        undo.disabled = false;
      }
    });
    row.append(words, undo);
    return row;
  }

  globalThis.ClotrScope = { foldCopies, copiesLine, skippedLine, leaveOutButtons, extensionOf };
})();
