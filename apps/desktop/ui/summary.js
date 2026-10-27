// Clotr for Windows — Save a summary: a one-page report the person keeps, built from a finished
// scan's own files and counts, never a detected value. It reads in the same order as the top of Results: one short
// paragraph, then a small table per group (folder, files, what's in them as words), and file names only when
// "Include file names" is on. `report` is pure (no DOM, no Tauri call) so it can be tested on its own; the saved
// page (`summaryPage`) and the preview in the app (results.js) are both drawn from it.
"use strict";

(() => {
  // The saved file is a standalone document, not drawn with createElement like the rest of the window, so every
  // piece of text that could hold markup (a file or folder name) is escaped by hand here.
  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  const SCAN_KIND_WORD = { quick: "ws.quick", full: "ws.full", chosen: "ws.folders", lookback: "ws.lookback" };
  const GROUP_WORD = {
    keys: "ws.grpKeys",
    ids: "ws.grpIds",
    photos: "ws.grpPhotos",
    money: "ws.grpMoney",
    projects: "ws.grpProjects",
    contact: "ws.grpContact",
  };
  // A group lists about this many lines of file names, shared between its folders; Results in the app has the rest.
  const NAMES_CAP = 50;
  // A plan step's own file list is capped the same way the live page caps it (results.js): the rest is a count.
  const PLAN_FILES_CAP = 8;

  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }

  // The "What to do" plan (plan.js), same steps and order as Results' own, worst first: which steps are ticked
  // comes in as `opts.planTicked` (a Set of step ids), the same thing results.js keeps in localStorage, so the
  // summary never has to know what a step found to say it's done.
  function planSection(scan, opts, t, fmt) {
    const P = globalThis.ClotrPlan;
    if (!P) return { title: "", lead: "", doneWord: "", steps: [] };
    const planTicked = opts.planTicked || new Set();
    const names = opts.names !== false;
    const steps = P.buildPlan(scan.files || []).map((step) => {
      const shown = names ? step.files.slice(0, PLAN_FILES_CAP) : [];
      const rest = names ? step.files.length - shown.length : 0;
      return {
        id: step.id,
        done: planTicked.has(step.id),
        what: t(step.words.what),
        why: t(step.words.why),
        how: t(step.words.how),
        count: fmt(step.count),
        names: shown.map((f) => ({ name: f.name, where: globalThis.ClotrFindings.placeLine(f) })),
        more: rest > 0 ? t("ws.planFilesMore", fmt(rest)) : "",
      };
    });
    return { title: t("ws.planTitle"), lead: t("ws.planLead"), doneWord: t("ws.planDone"), steps };
  }

  // The whole report as plain words and numbers. `scan` is the last finished run: `{ kind, files, counts }`
  // (scan.js's own shapes), plus `since` and `filesRead` when a Full read only what changed since an earlier one. `opts.names` (default on) decides whether file names are listed, never whether a kind
  // or count shows. `opts.t` is ClotrWords.t (or a stand-in in a test). `opts.planTicked` is the plan's own ticked
  // step ids (results.js's localStorage set), so a saved or printed summary shows the plan the same as Results does.
  function report(scan, opts = {}) {
    const {
      names = true,
      t = (k, ...s) => `${k}${s.length ? `:${s.join(",")}` : ""}`,
      lang = "en",
      when = new Date(),
    } = opts;
    const F = globalThis.ClotrFindings;
    const fmt = (n) => Number(n).toLocaleString(lang === "es" ? "es-ES" : "en-US");
    const filesWord = (n) => (n === 1 ? t("ws.resFileOne") : t("ws.resFilesN", fmt(n)));
    const files = scan.files || [];
    const counts = scan.counts || {};
    const view = F.buildView(files);

    const foldersRead = [...new Set(files.map((f) => prettyFolder(f.folder || "")))].filter(Boolean);
    const scanWord = t(SCAN_KIND_WORD[scan.kind] || "ws.quick");
    const dateOf = (d) => d.toLocaleDateString(lang === "es" ? "es-ES" : "en-GB", { dateStyle: "long" });
    const dateStr = dateOf(when);
    const meta = [t("ws.repMeta", scanWord, dateStr)];
    // Kept past the `if` below so an earlier-carried file's own line can name the same date.
    const sinceStr = scan.kind === "full" && scan.since != null ? dateOf(new Date(scan.since)) : null;
    if (sinceStr) {
      const read = scan.filesRead || 0;
      if (!read) meta.push(t("ws.repSinceNone", sinceStr));
      else if (read === 1) meta.push(t("ws.repSinceOne", sinceStr));
      else meta.push(t("ws.repSince", fmt(read), sinceStr));
    }
    if (foldersRead.length) meta.push(t("ws.repRead", F.listFormat(lang, foldersRead)));

    const groups = view.groups.map((group) => {
      // What's at stake in this group only: a key file's email addresses belong to its key, not to this table.
      const as = { kind: group.id === "photos" ? "picture" : "text" };
      const rows = group.folders.map((folder) => {
        const summed = {};
        for (const { file } of folder.entries) {
          for (const [id, n] of Object.entries(file.found)) summed[id] = (summed[id] || 0) + n;
        }
        return {
          folder: prettyFolder(folder.label),
          files: fmt(folder.entries.length),
          what: F.kindsPhrase(summed, { t, lang, fmt, cap: 4, onlyGroup: group.id, file: as }),
        };
      });
      // One line per name and place: forty config.env files in one folder read as one line saying forty, not a
      // column of the same word. Each folder gets its share of the cap, so the last folder isn't left nameless.
      const share = Math.ceil(NAMES_CAP / Math.max(1, group.folders.length));
      const shown = [];
      let unlisted = 0;
      for (const folder of group.folders) {
        const lines = new Map();
        for (const { file, copies } of folder.entries) {
          const place = F.placeLine(file);
          const key = `${file.name}\0${place}`;
          const line = lines.get(key) || { name: file.name, place, files: 0, copies: 0, earlier: false };
          line.files++;
          line.copies += copies.length;
          if (file.earlier) line.earlier = true;
          lines.set(key, line);
        }
        const all = [...lines.values()];
        shown.push(...all.slice(0, share));
        unlisted += all.slice(share).reduce((n, line) => n + line.files, 0);
      }
      const listed = names
        ? shown.map((line) => {
            const where = [line.place];
            if (line.files > 1) where.push(filesWord(line.files));
            if (line.copies) {
              where.push(line.copies === 1 ? t("ws.resAlsoInOne") : t("ws.resAlsoInN", fmt(line.copies)));
            }
            if (line.earlier && sinceStr) where.push(t("ws.earlierFind", sinceStr));
            return { name: line.name, where: where.join(", ") };
          })
        : [];
      return {
        id: group.id,
        title: t(GROUP_WORD[group.id]),
        count: filesWord(group.files),
        why: t(`${GROUP_WORD[group.id]}Why`),
        rows,
        names: listed,
        more: names && unlisted ? t("ws.repNamesMore", fmt(unlisted)) : "",
      };
    });

    const notRead = (counts.onlineOnly || 0) + (counts.tooBig || 0);
    return {
      lang,
      title: t("ws.repTitle"),
      meta: meta.join(" "),
      lead: F.summaryLines(view.totals, { t, lang, fmt }),
      none: groups.length ? "" : t("ws.summaryNoneFound"),
      plan: planSection(scan, opts, t, fmt),
      groups,
      heads: {
        folder: t("ws.summaryFolderHeading"),
        files: t("ws.summaryFilesHeading"),
        what: t("ws.repWhat"),
        names: t("ws.repNames"),
      },
      notReadTitle: t("ws.summaryNotReadHeading"),
      notRead: notRead
        ? t("ws.summaryNotRead", fmt(notRead), fmt(counts.onlineOnly || 0), fmt(counts.tooBig || 0))
        : t("ws.summaryAllRead"),
      footer: t("ws.summaryFooter"),
    };
  }

  // Light, plain and print-ready whatever look the app is in: it's a page to keep, read or hand to someone.
  const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1f2226; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 32px 48px; }
h1 { margin: 0 0 4px; font-size: 26px; line-height: 1.2; }
.meta { margin: 0 0 24px; color: #5b5f66; }
.lead { margin: 0 0 28px; padding: 16px 20px; border-left: 4px solid #c2410c; border-radius: 6px; background: #fbf5ef; }
.lead p { margin: 0; }
.lead .head { font-size: 20px; font-weight: 700; }
.lead .quiet { margin-top: 6px; color: #5b5f66; font-size: 14px; }
section.group { margin: 0 0 28px; }
h2 { display: flex; align-items: baseline; gap: 12px; margin: 0; padding-bottom: 4px; border-bottom: 2px solid currentColor; font-size: 18px; }
.keys h2, .ids h2 { color: #b42318; }
.photos h2, .money h2 { color: #b54708; }
.contact h2 { color: #4b5058; }
h2 .count { margin-left: auto; color: #4b5058; font-size: 14px; font-weight: 600; }
.why { margin: 6px 0 10px; color: #5b5f66; font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 6px 8px; border-bottom: 1px solid #c9cdd3; color: #4b5058; font-size: 12px; letter-spacing: 0.04em; text-align: left; text-transform: uppercase; }
td { padding: 6px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
th.num, td.num { width: 5em; text-align: right; white-space: nowrap; }
td:first-child { width: 22%; font-weight: 600; }
h3 { margin: 14px 0 4px; color: #4b5058; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
ul.names { margin: 0; padding-left: 18px; columns: 2; column-gap: 28px; font-size: 13px; }
ul.names li { break-inside: avoid; }
ul.names span { color: #5b5f66; }
.more { margin: 4px 0 0; color: #5b5f66; font-size: 13px; }
section.plan { margin: 0 0 28px; }
section.plan h2 { border-bottom: 2px solid #c2410c; color: #1f2226; }
section.plan .plan-lead { margin: 0 0 12px; color: #5b5f66; font-size: 13px; }
ol.plan-steps { margin: 0; padding-left: 20px; }
ol.plan-steps li.plan-step { margin: 0 0 14px; }
ol.plan-steps li.plan-step.done { color: #5b5f66; }
.plan-what { font-weight: 700; }
.plan-what .done-tag { margin-left: 8px; color: #15803d; font-size: 12px; font-weight: 600; text-transform: uppercase; }
.plan-why, .plan-how { margin: 2px 0; font-size: 14px; }
ul.plan-files { margin: 4px 0 0; padding-left: 18px; font-size: 13px; color: #5b5f66; }
section.notread h2 { color: #1f2226; }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #c9cdd3; color: #5b5f66; font-size: 13px; }
@page { margin: 16mm; }
@media print {
  main { max-width: none; padding: 0; }
  .lead { background: none; }
  h2, h3 { break-after: avoid; }
  tr { break-inside: avoid; }
}`;

  function summaryPage(scan, opts = {}) {
    const r = report(scan, opts);
    const groups = r.groups
      .map((g) => {
        const rows = g.rows
          .map(
            (row) =>
              `<tr><td>${esc(row.folder)}</td><td class="num">${esc(row.files)}</td><td>${esc(row.what)}</td></tr>`,
          )
          .join("");
        const names = g.names.length
          ? `<h3>${esc(r.heads.names)}</h3><ul class="names">${g.names
              .map((n) => `<li>${esc(n.name)} <span>· ${esc(n.where)}</span></li>`)
              .join("")}</ul>${g.more ? `<p class="more">${esc(g.more)}</p>` : ""}`
          : "";
        return `<section class="group ${esc(g.id)}">
<h2>${esc(g.title)} <span class="count">${esc(g.count)}</span></h2>
<p class="why">${esc(g.why)}</p>
<table><thead><tr><th scope="col">${esc(r.heads.folder)}</th><th scope="col" class="num">${esc(r.heads.files)}</th><th scope="col">${esc(r.heads.what)}</th></tr></thead><tbody>${rows}</tbody></table>
${names}
</section>`;
      })
      .join("\n");
    const lead = [
      `<p class="head">${esc(r.lead.head)}</p>`,
      r.lead.detail ? `<p>${esc(r.lead.detail)}</p>` : "",
      r.lead.quiet ? `<p class="quiet">${esc(r.lead.quiet)}</p>` : "",
    ].join("");

    const plan = r.plan.steps.length
      ? `<section class="plan">
<h2>${esc(r.plan.title)}</h2>
<p class="plan-lead">${esc(r.plan.lead)}</p>
<ol class="plan-steps">${r.plan.steps
          .map(
            (step) => `<li class="plan-step${step.done ? " done" : ""}">
<p class="plan-what">${esc(step.what)} (${esc(step.count)})${step.done ? `<span class="done-tag">${esc(r.plan.doneWord)}</span>` : ""}</p>
<p class="plan-why">${esc(step.why)}</p>
<p class="plan-how">${esc(step.how)}</p>
${
  step.names.length
    ? `<ul class="plan-files">${step.names.map((n) => `<li>${esc(n.name)} <span>· ${esc(n.where)}</span></li>`).join("")}</ul>${step.more ? `<p class="more">${esc(step.more)}</p>` : ""}`
    : ""
}
</li>`,
          )
          .join("")}</ol>
</section>`
      : "";

    return `<!doctype html>
<html lang="${esc(r.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(r.title)}</title>
<style>${STYLE}
</style>
</head>
<body>
<main>
<h1>${esc(r.title)}</h1>
<p class="meta">${esc(r.meta)}</p>
<div class="lead">${lead}</div>
${plan}
${r.none ? `<p>${esc(r.none)}</p>` : groups}
<section class="notread">
<h2>${esc(r.notReadTitle)}</h2>
<p>${esc(r.notRead)}</p>
</section>
<footer>${esc(r.footer)}</footer>
</main>
</body>
</html>
`;
  }

  globalThis.ClotrSummary = { report, summaryPage, prettyFolder, NAMES_CAP };
})();
