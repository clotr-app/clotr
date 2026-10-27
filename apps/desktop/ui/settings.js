// Clotr for Windows' Settings screen: General (start with Windows, language, look, motion), Notifications
// (the weekly check, off by default, and whether it tells you) and the move file. Your data's "What Clotr stores"
// and About are plain text, filled in by words() alone. Language and Look and Motion take effect at once, "live,
// never reload"; the weekly check and notify on find take effect the moment they're switched (main.rs's own
// hourly look reads the setting straight from the store, no restart needed). Start with Windows asks the MSIX
// startup task, or the per-user Run key in the unpackaged build (startup.rs), and shows what Windows actually did
// after the click, read back, not the click itself. Leave out of scans lists what the person chose by name and
// parent folder only; the paths stay in Rust. Every change goes straight to the one writer, which checks it again.
(() => {
  "use strict";
  const W = globalThis.ClotrWords;
  const ONE_CLOTR_ENABLED = globalThis.ClotrDesktopFeatures?.oneClotr === true;
  const $ = (id) => document.getElementById(id);

  const KEEP_LABEL = { 90: "settings.keep90", 365: "settings.keep365", 730: "settings.keep730" };

  // "Report a problem": the version and Windows version this draw() last heard, for about-report's own click
  // (wire(), below) to hand reportMailto, without a second round trip to Rust.
  let appVersion = "";
  let osVersion = "";

  // What the move file actually changed, in counts and names, never the values (main.rs's brought_summary
  // decided which fields count as changed; this only turns that into a sentence).
  function broughtMessage(brought) {
    if (!brought || !brought.changed) return W.t("settings.broughtNone");
    const p = brought.parts;
    const bits = [];
    if ("responses" in p) {
      bits.push(
        p.responses === 1 ? W.t("settings.broughtResponsesOne") : W.t("settings.broughtResponses", p.responses),
      );
    }
    if ("vault" in p) {
      bits.push(p.vault === 1 ? W.t("settings.broughtVaultOne") : W.t("settings.broughtVault", p.vault));
    }
    if ("largeText" in p) bits.push(W.t(p.largeText ? "settings.broughtLargeOn" : "settings.broughtLargeOff"));
    if ("keepDays" in p) bits.push(W.t("settings.broughtKeepDays", W.t(KEEP_LABEL[p.keepDays] || "settings.keep365")));
    const lang = document.documentElement.lang;
    const list = new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(bits);
    return `${W.t("settings.broughtIntro")} ${list}`;
  }

  function draw(view) {
    const s = view.settings;
    $("one-clotr-card").hidden = !ONE_CLOTR_ENABLED;
    const supported = view.startupTaskState !== "unsupported";
    $("start-windows").disabled = !supported;
    $("start-soon").hidden = supported;
    $("start-windows").setAttribute("aria-checked", String(supported && view.startupTaskState === "enabled"));
    // Off in Task Manager (or by a policy) wins over the switch, so say where to turn it back on.
    const held = { "disabled-by-user": "ws.startHeldUser", "disabled-by-policy": "ws.startHeldPolicy" }[
      view.startupTaskState
    ];
    $("start-note").hidden = !held;
    $("start-note").textContent = held ? W.t(held) : "";
    $("language").value = s.language === "en" || s.language === "es" ? s.language : "system";
    $("look").value = s.look === "dark" ? "ember" : ["light", "plum", "ember"].includes(s.look) ? s.look : "system";
    $("motion").value = s.motion === "still" ? "still" : "system";
    $("results-mode").value = s.resultsMode === "detailed" ? "detailed" : "guided";
    if (document.activeElement !== $("helper-name")) $("helper-name").value = s.helperName || "";
    $("weekly-check").setAttribute("aria-checked", String(s.weeklyCheck === true));
    $("notify-find").setAttribute("aria-checked", String(s.notifyFind !== false));
    $("dev-files").setAttribute("aria-checked", String(s.scanDevFiles === true));
    $("ignored-count").textContent = W.t("settings.ignoredCount", String(s.scanIgnored?.length || 0));
    $("full-scan-kept").textContent = fullScanKept(view.fullScan);
    drawLeftOut(view.scanExcluded || []);
    drawAccuracy(view.accuracy || []);
    appVersion = view.appVersion || "";
    osVersion = view.osVersion || "";
    $("about-version").textContent = appVersion ? W.t("ws.aboutVersion", appVersion) : "";
    if (ONE_CLOTR_ENABLED) drawOneClotr();
  }

  async function drawOneClotr() {
    if (!ONE_CLOTR_ENABLED) return;
    try {
      const status = await host.call("one_clotr_status");
      const browsers = Array.isArray(status.browsers) ? status.browsers : [];
      $("one-clotr-browsers").textContent = browsers.join(", ");
      $("one-clotr-state").textContent =
        status.available === false
          ? W.t("oc_unavailable")
          : status.paired
            ? W.t("oc_connected")
            : status.pending
              ? W.t("oc_connectBrowser")
              : W.t("oc_notConnected");
      $("one-clotr-consent").hidden = !status.pending;
      $("one-clotr-consent").textContent = status.pending ? W.t("oc_consent") : "";
      $("one-clotr-accept").hidden = !status.pending;
      $("one-clotr-decline").hidden = !status.pending;
      $("one-clotr-disconnect").hidden = !status.paired;
      $("one-clotr-disconnect-sub").hidden = !status.paired;
    } catch {
      $("one-clotr-state").textContent = W.t("oc_notConnected");
    }
  }

  // "Was this right?": how many answers are kept, never which files they were about. Export and Clear
  // stay disabled with nothing to export or clear.
  function drawAccuracy(rows) {
    lastAccuracy = rows;
    const total = rows.reduce((n, r) => n + (r.yes || 0) + (r.no || 0), 0);
    $("accuracy-count").textContent = total
      ? W.t("settings.accuracyCount", String(total))
      : W.t("settings.accuracyNone");
    $("accuracy-export").disabled = total === 0;
    $("accuracy-clear").disabled = total === 0;
  }

  // The export itself: exactly the four fields a row may ever hold, named again here rather than trusted from
  // whatever shape arrived, so a row can never carry more than this by the time it reaches a file.
  function accuracyExportRows(rows) {
    return (rows || []).map((r) => ({ kind: r.kind, tier: r.tier, yes: r.yes || 0, no: r.no || 0 }));
  }

  let host = null; // wire()'s `call` and `show`, for each Remove button drawn later
  let lastAccuracy = []; // this draw()'s own accuracy rows, for Export's click (wire() runs once, draw() every view)

  // Leave out of scans: one row per folder, file or type, named with its parent folder, with its own Remove.
  function drawLeftOut(entries) {
    $("leave-empty").hidden = entries.length > 0;
    $("leave-list").replaceChildren(
      ...entries.map((entry) => {
        const name = document.createElement("b");
        name.textContent = entry.name;
        const where = document.createElement("small");
        where.textContent =
          entry.kind === "type" ? W.t("settings.leaveIsType") : W.t("settings.leaveIn", entry.parent || "");
        const label = document.createElement("span");
        label.append(name, where);
        const remove = document.createElement("button");
        remove.className = "btn sm";
        remove.type = "button";
        remove.textContent = W.t("settings.leaveRemove");
        remove.setAttribute("aria-label", W.t("settings.leaveRemoveName", entry.name));
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            host.show(await host.call("scan_unexclude", { id: entry.id }));
          } catch {
            remove.disabled = false;
          }
        });
        const row = document.createElement("li");
        row.append(label, remove);
        return row;
      }),
    );
  }

  // What Clotr keeps for Quick scans: the last Full scan's fingerprints, sizes and dates, never a name or a path.
  function fullScanKept(full) {
    if (!full) return W.t("settings.fullScanNone");
    const lang = document.documentElement.lang;
    const when = new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(full.at));
    return W.t("settings.fullScanKept", new Intl.NumberFormat(lang).format(full.files), when);
  }

  // Wired once: `save`, `call`, `show` and `saved` come from the main window. start-windows is disabled in
  // main.html (shown as "Coming") until draw() hears a real state, so its own click only ever fires once that's true.
  function wire({ save, call, show, saved }) {
    host = { call, show };
    if (ONE_CLOTR_ENABLED) {
      $("one-clotr-accept").addEventListener("click", async () => {
        await call("one_clotr_consent", { accepted: true });
        await drawOneClotr();
      });
      $("one-clotr-decline").addEventListener("click", async () => {
        await call("one_clotr_consent", { accepted: false });
        await drawOneClotr();
      });
      $("one-clotr-disconnect").addEventListener("click", async () => {
        await call("one_clotr_disconnect");
        await drawOneClotr();
      });
    }
    for (const kind of ["folder", "file"]) {
      $(`leave-${kind}`).addEventListener("click", async () => show(await call("scan_exclude_pick", { kind })));
    }
    $("leave-type").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("leave-status");
      status.classList.remove("error");
      status.textContent = "";
      try {
        show(await call("scan_exclude_type", { ext: $("leave-type-input").value.trim() }));
        $("leave-type").reset();
      } catch {
        status.classList.add("error");
        status.textContent = W.t("settings.leaveTypeBad");
      }
    });
    $("start-windows").addEventListener("click", () =>
      save({ startWithWindows: $("start-windows").getAttribute("aria-checked") !== "true" }),
    );
    $("language").addEventListener("change", () => save({ language: $("language").value }));
    $("look").addEventListener("change", () => save({ look: $("look").value }));
    $("motion").addEventListener("change", () => save({ motion: $("motion").value }));
    $("results-mode").addEventListener("change", () => save({ resultsMode: $("results-mode").value }));
    $("helper-name").addEventListener("change", () => save({ helperName: $("helper-name").value.trim() }));
    $("weekly-check").addEventListener("click", () =>
      save({ weeklyCheck: $("weekly-check").getAttribute("aria-checked") !== "true" }),
    );
    $("notify-find").addEventListener("click", () =>
      save({ notifyFind: $("notify-find").getAttribute("aria-checked") !== "true" }),
    );
    $("dev-files").addEventListener("click", () =>
      save({ scanDevFiles: $("dev-files").getAttribute("aria-checked") !== "true" }),
    );
    $("show-ignored").addEventListener("click", async () => {
      show(await call("clear_scan_ignored"));
      saved(W.t("settings.ignoredCleared"));
    });
    $("accuracy-export").addEventListener("click", async () => {
      const status = $("accuracy-status");
      status.classList.remove("error");
      const text = JSON.stringify(accuracyExportRows(lastAccuracy), null, 2);
      const result = await call("save_accuracy_export", { text });
      status.textContent = result?.saved ? W.t("settings.accuracyExported") : "";
    });
    $("accuracy-clear").addEventListener("click", async () => {
      show(await call("clear_accuracy_answers"));
      saved(W.t("settings.accuracyCleared"));
    });
    $("about-report").addEventListener("click", async () => {
      const href = globalThis.ClotrNote?.reportMailto({ appVersion, osVersion, t: W.t });
      if (href) await call("open_mailto", { url: href }).catch(() => {});
    });
    $("move").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = $("move-file").files[0];
      const status = $("move-status");
      status.classList.remove("error");
      if (!file) return;
      try {
        if (file.size > globalThis.Clotr.Backup.MAX_FILE_BYTES) throw new Error("not-a-backup");
        const settings = await globalThis.ClotrMoveFile.open(await file.text(), $("move-password").value);
        const view = await call("import_settings", { settings });
        show(view);
        status.textContent = broughtMessage(view.brought);
        $("move").reset();
      } catch (err) {
        status.classList.add("error");
        status.textContent = W.t(err?.message === "wrong-password" ? "settings.moveWrong" : "settings.moveNot");
      }
    });
    if (ONE_CLOTR_ENABLED) drawOneClotr();
  }

  globalThis.ClotrSettings = { draw, wire, accuracyExportRows, broughtMessage, refreshOneClotr: drawOneClotr };
})();
