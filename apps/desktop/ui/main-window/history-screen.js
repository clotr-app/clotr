// Clotr for Windows' History screen: the last 12 weeks as stacked bars (Clotr hid, Left in, Counted) with
// the totals in words beside the legend, the scans Clotr has run (counts only, once scans exist), and the warnings
// table. Never a file name or a value, only counts and kinds. Every node is made with createElement and
// textContent.
(() => {
  "use strict";
  const C = globalThis.Clotr;
  const W = globalThis.ClotrWords;
  const SCAN_TIMES_ENABLED = globalThis.ClotrDesktopFeatures?.scanTimes === true;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  const CHOICE_TAG = { redacted: "good", allowed: "", suppressed: "" };
  const WEEK_MS = 7 * 86_400_000;
  const WEEKS = 12;
  const SCAN_LABEL = { quick: "ws.quick", full: "ws.full", chosen: "ws.folders", lookback: "ws.lookback" };

  function scanLabel(scan, t = W.t) {
    return SCAN_LABEL[scan] ? t(SCAN_LABEL[scan]) : scan;
  }

  function readLabel(row, t = W.t) {
    return t(row.scan === "lookback" ? "ws.scanRowChats" : "ws.scanRowFiles", String(row.items));
  }

  function durationLabel(seconds, t = W.t) {
    if (!Number.isFinite(Number(seconds))) return t("ws.scanRowNoTime");
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return value < 60 ? t("ws.scanRowSeconds", String(value)) : t("ws.scanRowMinutes", String(Math.floor(value / 60)));
  }

  // The kinds a scan found, as a plain sentence ("Credit Card Number and Phone Number (2)"), or the
  // "nothing worth a look" line when it found none. Never a value, only kinds and counts.
  function foundLabel(counts, kinds, opts = {}) {
    const { t = W.t, lang = document.documentElement.lang } = opts;
    const parts = Object.entries(counts || {}).map(([id, n]) => {
      const name = kinds.get(id) || id;
      return n > 1 ? `${name} (${n})` : name;
    });
    if (!parts.length) return t("ws.scanRowFoundNone");
    return new Intl.ListFormat(lang, { type: "conjunction" }).format(parts);
  }

  // The last 12 weeks, oldest first, each a count per action. The chart is decorative (aria-hidden): the totals
  // beside its legend, and the table below, are the words-only way to read the same numbers.
  function weekBuckets(events) {
    const start = Date.now() - WEEK_MS * WEEKS;
    const buckets = Array.from({ length: WEEKS }, () => ({ redacted: 0, allowed: 0, suppressed: 0 }));
    for (const e of events) {
      const idx = Math.floor((e.t - start) / WEEK_MS);
      if (idx >= 0 && idx < WEEKS && Object.hasOwn(buckets[idx], e.action)) buckets[idx][e.action]++;
    }
    return buckets;
  }

  function drawWeeks(events) {
    const buckets = weekBuckets(events);
    const totals = { redacted: 0, allowed: 0, suppressed: 0 };
    const max = Math.max(1, ...buckets.map((b) => b.redacted + b.allowed + b.suppressed));
    $("weeks").replaceChildren(
      ...buckets.map((b) => {
        const total = b.redacted + b.allowed + b.suppressed;
        const bar = el("div", { className: "bar" });
        bar.style.height = `${total ? Math.max(6, (total / max) * 100) : 2}%`;
        for (const kind of ["redacted", "allowed", "suppressed"]) {
          totals[kind] += b[kind];
          if (b[kind] <= 0) continue;
          const seg = el("span", { className: `seg ${kind}` });
          seg.style.flexGrow = String(b[kind]);
          bar.append(seg);
        }
        return bar;
      }),
    );
    $("weeks-redacted").textContent = String(totals.redacted);
    $("weeks-allowed").textContent = String(totals.allowed);
    $("weeks-suppressed").textContent = String(totals.suppressed);
  }

  function drawScans(scans, kinds) {
    const rows = [...scans].sort((a, b) => b.t - a.t).slice(0, 300);
    $("scans-empty").hidden = rows.length > 0;
    $("scans-table").hidden = rows.length === 0;
    const when = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
    $("scans-table")
      .querySelector("tbody")
      .replaceChildren(
        ...rows.map((row) => {
          const cells = [
            el("td", { textContent: when.format(new Date(row.t)) }),
            el("td", { textContent: scanLabel(row.scan) }),
            el("td", { textContent: readLabel(row) }),
            el("td", { textContent: foundLabel(row.counts, kinds) }),
          ];
          if (SCAN_TIMES_ENABLED) {
            cells.push(
              el("td", { textContent: durationLabel(row.seconds) }),
              el("td", {
                textContent: `${W.t("ws.scanRowAdded")}: ${foundLabel(row.added, kinds)} · ${W.t("ws.scanRowGone")}: ${foundLabel(row.gone, kinds)}`,
              }),
            );
          }
          return el("tr", {}, cells);
        }),
      );
  }

  function draw(view) {
    drawWeeks(view.events);
    const names = new Map(view.apps.map((a) => [`app:${a.id}`, a.name]));
    const kinds = new Map(C.PATTERNS.map((p) => [p.id, p.name]));
    drawScans(view.scans || [], kinds);
    const events = [...view.events].sort((a, b) => b.t - a.t).slice(0, 300);
    $("empty").hidden = events.length > 0;
    $("history").hidden = events.length === 0;
    const when = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
    $("history")
      .querySelector("tbody")
      .replaceChildren(
        ...events.map((e) =>
          el("tr", {}, [
            el("td", { textContent: when.format(new Date(e.t)) }),
            el("td", { textContent: names.get(e.site) || e.site.replace(/^app:/, "") }),
            el("td", { textContent: kinds.get(e.type) || e.name }),
            el("td", {}, [
              el("span", { className: `tag ${CHOICE_TAG[e.action] ?? ""}`, textContent: W.t(`settings.${e.action}`) }),
            ]),
          ]),
        ),
      );
    $("keep").value = String(view.settings.keepDays || 365);
  }

  // Wired once: `save`, `call` and `show` come from the main window.
  function wire({ save, call, show, saved }) {
    $("keep").addEventListener("change", () => save({ keepDays: Number($("keep").value) }));
    $("clear").addEventListener("click", async () => {
      show(await call("clear_history"));
      saved(W.t("settings.cleared"));
    });
  }

  globalThis.ClotrHistory = { draw, wire, scanLabel, readLabel, foundLabel, durationLabel };
})();
