// Clotr for Windows -- the note for your helper: a one-page
// checklist a person can print, save or email to whoever helps them, built only from the plan's own words and a
// file's own `{ index, name, folder, kind, ext }` (plan.js's own shape for a step's files) -- never `found` or
// `fps`, so a detected value can never reach it. Pure (no DOM, no Tauri call), shared with Android through the
// engine bundle (tools/engine-bundle.js's resultsParts()); the note page and its Print, Save and Email wiring live
// in note.js, Windows-only. Also builds "Report a problem"'s own mailto: (reportMailto), kept here too since this
// is the one file a rule test holds to building every mailto: string in the app.
"use strict";

(() => {
  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  // The same four folders plan.js and findings.js already treat as everyday (EVERYDAY_FOLDERS, FOLDER_RANK): a
  // place outside them is itself something to name carefully, since a chosen folder's own name can be as personal
  // as a file name, so it only shows when "Include file names" is on.
  const EVERYDAY_FOLDERS = new Set(["desktop", "downloads", "documents", "pictures"]);
  const FOLDER_RANK = { desktop: 0, downloads: 0, documents: 1, pictures: 1 };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function compareFolders(a, b) {
    const byRank = (FOLDER_RANK[a] ?? 2) - (FOLDER_RANK[b] ?? 2);
    return byRank || collator.compare(a, b);
  }
  function prettyFolder(label) {
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  }

  // What each of plan.js's steps (STEPS, worst first) says on the note: a short noun phrase for "what Clotr
  // found" and a short sentence for "what Clotr recommends", both written for a helper who's never seen Clotr,
  // never for the person who scanned (plan.js's own words say "you" and point at buttons on this screen, which
  // don't exist on a printed page). Only the three a first-time helper would need walked through get a numbered
  // "how": the rest are one line.
  const NOTE_WORDS = {
    keys: {
      foundOne: "ws.noteFoundKeysOne",
      foundN: "ws.noteFoundKeysN",
      recommend: "ws.noteRecommendKeys",
      steps: "ws.noteStepsKeys",
    },
    idPhotos: {
      foundOne: "ws.noteFoundIdPhotosOne",
      foundN: "ws.noteFoundIdPhotosN",
      recommend: "ws.noteRecommendIdPhotos",
      steps: "ws.noteStepsIdPhotos",
    },
    idDocs: { foundOne: "ws.noteFoundIdDocsOne", foundN: "ws.noteFoundIdDocsN", recommend: "ws.noteRecommendIdDocs" },
    photoPlace: {
      foundOne: "ws.noteFoundPhotoPlaceOne",
      foundN: "ws.noteFoundPhotoPlaceN",
      recommend: "ws.noteRecommendPhotoPlace",
      steps: "ws.noteStepsPhotoPlace",
    },
    money: { foundOne: "ws.noteFoundMoneyOne", foundN: "ws.noteFoundMoneyN", recommend: "ws.noteRecommendMoney" },
    leaveOutFolders: {
      foundOne: "ws.noteFoundLeaveOutOne",
      foundN: "ws.noteFoundLeaveOutN",
      recommend: "ws.noteRecommendLeaveOut",
    },
  };

  // Settings' My helper: a plain
  // optional name, nothing else. Falls back to none whenever it isn't a non-empty string, whether that's because
  // the person never set one or because this build doesn't have the setting yet.
  function helperName(settings) {
    const name = settings && typeof settings.helperName === "string" ? settings.helperName.trim() : "";
    return name || null;
  }

  // One row per step and place plan.js's own buildPlan() hands back (worst first, the same order Results and
  // Save a summary use), split by place so "worth a look, under $1" never names two places on one line. With
  // `names` off a row's place is general: one of the everyday four by its name, else "a folder outside the usual
  // ones", and never a folder below it, since "Desktop › Divorce papers" says as much as a file name. With `names`
  // on it's the whole place, folders below and all.
  function generalPlace(label, t) {
    return EVERYDAY_FOLDERS.has(label.toLowerCase()) ? prettyFolder(label) : t("ws.noteOtherFolder");
  }
  // `stepsFor(stepId)` lets a caller swap in its own "how" text (Android's own, since results-note.js' own
  // NOTE_WORDS.*.steps walks Windows-only places like the Recycle Bin or OneDrive's Personal Vault): null keeps
  // that step's line-only row, same as no `steps` word at all.
  function buildRows(files, { t, fmt, names, stepsFor }) {
    const P = globalThis.ClotrPlan;
    if (!P) return [];
    const rows = [];
    for (const step of P.buildPlan(files || [])) {
      const stepWords = NOTE_WORDS[step.id];
      if (!stepWords) continue; // a step plan.js adds later that this note doesn't know how to word yet
      const byPlace = new Map();
      for (const file of step.files) {
        const label = file.folder || "";
        const place = names ? globalThis.ClotrFindings?.placeLine(file) || prettyFolder(label) : generalPlace(label, t);
        if (!byPlace.has(place)) byPlace.set(place, { label, n: 0 });
        byPlace.get(place).n++;
      }
      const order = [...byPlace.entries()].sort(
        ([pa, a], [pb, b]) => compareFolders(a.label, b.label) || collator.compare(pa, pb),
      );
      const stepsKey = stepsFor ? stepsFor(step.id) : stepWords.steps;
      for (const [place, { n }] of order) {
        rows.push({
          id: step.id,
          found: n === 1 ? t(stepWords.foundOne) : t(stepWords.foundN, fmt(n)),
          place,
          recommend: t(stepWords.recommend),
          steps: stepsKey ? t(stepsKey) : "",
        });
      }
    }
    return rows;
  }

  const SCAN_WORD = {
    quick: "ws.noteScanQuick",
    full: "ws.noteScanFull",
    chosen: "ws.noteScanFolders",
    photos: "ws.noteScanPhotos",
    mixed: "ws.noteScanMixed",
    lookback: "ws.noteScanLookback",
  };

  // The whole note as plain words: a heading, who it's for, when and how it was made, the checklist, the steps
  // for whichever recommendations above need them, "What Clotr is", the file-names line, and a footer. `scan` is
  // `{ kind, files }` (scan.js's own shapes); `opts.names` (default OFF, unlike Save a summary) decides whether a
  // file's own folder is named outside the everyday four; `opts.helperName` is this function's own getter, above.
  function report(scan, opts = {}) {
    const {
      names = false,
      t = (k, ...s) => `${k}${s.length ? `:${s.join(",")}` : ""}`,
      lang = "en",
      when = new Date(),
      helperName: forWhom = null,
      // Windows' own words by default; Android passes its own ("the PC" doesn't fit a phone) for just these,
      // never touching the rest of NOTE_WORDS, which stay device-neutral.
      words: wordKeys = {},
      stepsFor = null,
    } = opts;
    const fmt = (n) => Number(n).toLocaleString(lang === "es" ? "es-ES" : "en-US");
    const F = globalThis.ClotrFindings;
    const files = scan.files || [];
    const rows = buildRows(files, { t, fmt, names, stepsFor });

    // The same everyday-or-not gate as buildRows' `place`, so the "scanned from" line can never leak a folder's own
    // name when "Include file names" is off -- it says a scan touched folders outside the everyday four, never which.
    const everydayLabels = new Set();
    const otherNames = new Set();
    let hasOtherFolder = false;
    for (const f of files) {
      const label = f.folder || "";
      if (!label) continue;
      if (EVERYDAY_FOLDERS.has(label.toLowerCase())) everydayLabels.add(label.toLowerCase());
      else if (names) otherNames.add(label);
      else hasOtherFolder = true;
    }
    const foldersRead = F
      ? [
          ...[...everydayLabels].sort(compareFolders).map(prettyFolder),
          ...[...otherNames].sort((a, b) => collator.compare(a, b)).map(prettyFolder),
          ...(hasOtherFolder ? [t("ws.noteOtherFolder")] : []),
        ]
      : [];
    const dateStr = when.toLocaleDateString(lang === "es" ? "es-ES" : "en-GB", { dateStyle: "long" });
    const scanPhrase = t(SCAN_WORD[scan.kind] || "ws.noteScanQuick");
    const meta = [t(wordKeys.meta || "ws.noteMeta", dateStr, scanPhrase)];
    if (scan.kind === "full" && scan.since != null) {
      const sinceStr = new Date(scan.since).toLocaleDateString(lang === "es" ? "es-ES" : "en-GB", {
        dateStyle: "long",
      });
      meta.push(t("ws.noteSince", sinceStr));
    }
    if (foldersRead.length && F) meta.push(t("ws.noteMetaFolders", F.listFormat(lang, foldersRead)));

    const totalRead = Number.isFinite(scan.totalRead) ? scan.totalRead : null;
    const count = rows.length
      ? totalRead != null
        ? rows.length === 1
          ? t("ws.noteCountOne", fmt(totalRead))
          : t("ws.noteCountN", fmt(rows.length), fmt(totalRead))
        : rows.length === 1
          ? t("ws.noteCountOneNoTotal")
          : t("ws.noteCountNNoTotal", fmt(rows.length))
      : t("ws.noteNone");

    const stepSections = [];
    const seenSteps = new Set();
    for (const row of rows) {
      if (!row.steps || seenSteps.has(row.id)) continue;
      seenSteps.add(row.id);
      stepSections.push({ recommend: row.recommend, steps: row.steps });
    }

    return {
      lang,
      title: t("ws.noteTitle"),
      for: forWhom ? t("ws.noteFor", forWhom) : "",
      meta: meta.join(" "),
      intro: rows.length ? t(wordKeys.intro || "ws.noteIntro") : "",
      count,
      heads: {
        done: t("ws.noteDoneHeading"),
        found: t("ws.noteFoundHeading"),
        where: t("ws.noteWhereHeading"),
        recommend: t("ws.noteRecommendHeading"),
      },
      rows,
      stepsTitle: stepSections.length ? t("ws.noteStepsHeading") : "",
      stepSections,
      isTitle: t("ws.noteIsHeading"),
      is: t(wordKeys.is || "ws.noteIs"),
      namesLine: names ? t("ws.noteNamesOn") : t("ws.noteNamesOff"),
      footer: t(wordKeys.footer || "ws.noteFooter"),
    };
  }

  // Light, plain and print-ready, the same approach as summary.js's STYLE: one page to print, save or hand over.
  const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1f2226; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 32px 48px; }
.head { display: flex; align-items: baseline; gap: 10px; }
h1 { margin: 0; font-size: 24px; line-height: 1.2; }
.for { margin: 0 0 4px; color: #5b5f66; }
.meta { margin: 10px 0 0; color: #5b5f66; }
.intro { margin: 14px 0 0; }
hr { margin: 20px 0; border: none; border-top: 1px solid #c9cdd3; }
.count { margin: 0 0 14px; font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 6px 8px; border-bottom: 2px solid #1f2226; color: #1f2226; font-size: 12px; letter-spacing: 0.04em; text-align: left; text-transform: uppercase; }
td { padding: 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
th.done, td.done { width: 2.4em; }
td.done span { display: inline-block; width: 15px; height: 15px; border: 1.5px solid #1f2226; }
h2 { margin: 0 0 10px; border-bottom: 2px solid #c2410c; padding-bottom: 4px; font-size: 18px; }
.step { margin: 0 0 16px; }
.step b { display: block; margin: 0 0 4px; }
.step ol { margin: 0; padding-left: 20px; }
.is p { margin: 0 0 8px; font-size: 14px; }
.names { margin: 10px 0 0; color: #5b5f66; font-size: 13px; }
footer { margin-top: 10px; padding-top: 10px; border-top: 1px solid #c9cdd3; color: #5b5f66; font-size: 13px; }
@page { margin: 16mm; }
@media print { main { max-width: none; padding: 0; } tr { break-inside: avoid; } h2 { break-after: avoid; } }`;

  function notePage(scan, opts = {}) {
    const r = report(scan, opts);
    const rows = r.rows
      .map(
        (row) =>
          `<tr><td class="done"><span></span></td><td>${esc(row.found)}</td><td>${esc(row.place)}</td><td>${esc(row.recommend)}</td></tr>`,
      )
      .join("");
    const table = r.rows.length
      ? `<table><thead><tr><th scope="col" class="done">${esc(r.heads.done)}</th><th scope="col">${esc(r.heads.found)}</th><th scope="col">${esc(r.heads.where)}</th><th scope="col">${esc(r.heads.recommend)}</th></tr></thead><tbody>${rows}</tbody></table>`
      : "";
    const steps = r.stepSections.length
      ? `<section class="steps"><h2>${esc(r.stepsTitle)}</h2>${r.stepSections
          .map(
            (s) =>
              `<div class="step"><b>${esc(s.recommend)}</b><ol>${s.steps
                .split(" / ")
                .map((line) => `<li>${esc(line)}</li>`)
                .join("")}</ol></div>`,
          )
          .join("")}</section>`
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
<div class="head"><h1>${esc(r.title)}</h1></div>
${r.for ? `<p class="for">${esc(r.for)}</p>` : ""}
<p class="meta">${esc(r.meta)}</p>
${r.intro ? `<p class="intro">${esc(r.intro)}</p>` : ""}
<hr />
<p class="count">${esc(r.count)}</p>
${table}
${steps}
<hr />
<section class="is">
<h2>${esc(r.isTitle)}</h2>
<p>${esc(r.is)}</p>
</section>
<p class="names">${esc(r.namesLine)}</p>
<footer>${esc(r.footer)}</footer>
</main>
</body>
</html>
`;
  }

  // The plain text a helper gets through "Email it": the same content as the page, no HTML, no
  // styling, one blank line between parts. Kept separate from notePage() so an email body is never a stripped-down
  // copy of markup -- it's written for plain text from the start.
  function noteText(scan, opts = {}) {
    const r = report(scan, opts);
    const parts = [r.title];
    if (r.for) parts.push(r.for);
    parts.push(r.meta);
    if (r.intro) parts.push(r.intro);
    parts.push(r.count);
    for (const row of r.rows) parts.push(`- ${row.found} (${row.place}): ${row.recommend}`);
    for (const s of r.stepSections) {
      parts.push(s.recommend);
      s.steps.split(" / ").forEach((line, i) => parts.push(`${i + 1}. ${line}`));
    }
    parts.push(r.isTitle);
    parts.push(r.is);
    parts.push(r.namesLine);
    parts.push(r.footer);
    return parts.join("\n\n");
  }

  // "Email it" uses a `mailto:` with only a subject and a body, nothing a page could shape into another
  // scheme or an address of its own (main.rs's own `mailto_ok` checks the same shape before opening it). Past
  // `cap` characters of body the email can't hold the whole note, so the caller shows "Save as a PDF and attach
  // it" instead of this link.
  function mailto(scan, opts = {}) {
    const body = noteText(scan, opts);
    const t = opts.t || ((k) => k);
    if (body.length > (opts.cap ?? 1800)) return { ok: false, href: "" };
    const subject = t("ws.noteEmailSubject");
    const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return { ok: true, href };
  }

  // "Report a problem" (Settings, and Results near "Was this right?"): a `mailto:` to Clotr's own support
  // address, holding only Clotr's version, Windows' version and a line asking what happened -- never a file, a
  // place, a finding or anything else from a scan, since nothing like that is ever a parameter here (main.rs's
  // own `mailto_ok` checks the same one fixed address and the same subject-and-body shape before opening it).
  function reportMailto({ appVersion = "", osVersion = "", t = (k) => k } = {}) {
    const body = [t("ws.reportVersion", appVersion), t("ws.reportOs", osVersion), "", t("ws.reportWhatHappened")].join(
      "\n",
    );
    const subject = t("ws.reportSubject");
    return `mailto:support@clotr.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  globalThis.ClotrNote = { report, notePage, noteText, mailto, reportMailto, helperName, prettyFolder, NOTE_WORDS };
})();
