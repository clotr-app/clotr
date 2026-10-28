// The entry point for the end-to-end suite: it opens a real browser with Clotr loaded and runs every check in
// ./checks in order, the way run order is decided by ./sections.js. The helpers each check uses live in ./lib.js.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --part 1/3       the first third of the sections (then 2/3, 3/3)
//   npm run test:e2e -- --shard 1        the sections tests/e2e/shards.js assigns to CI's shard 1 (then 2, 3)
//   npm run test:e2e -- --browser "C:/path/to/chrome.exe"
//   npm run test:e2e:all-on              every held-back feature's own checks too, against an all-on build (sections.js)
//   npm run test:e2e -- --coverage       also save which lines of extension/ ran (./coverage.js, npm run coverage:all)
//
// This also runs in a Linux container, so CI and cloud sessions fall back to the Playwright Chromium build and add
// --no-sandbox when running as root.
//
// Nothing here touches the network. The browser gets a throwaway profile, never a real one, and every request is
// either answered by a fake page in ./pages or blocked outright.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Every browser profile and scratch file a check makes goes through os.tmpdir(), so pointing TEMP/TMP/TMPDIR at a
// root of this run's own, deleted once the run ends, catches anything a check forgets to clean up itself (the same
// trick tools/run-tests.js uses for npm test).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-e2e-run-"));
process.env.TEMP = TMP_ROOT;
process.env.TMP = TMP_ROOT;
process.env.TMPDIR = TMP_ROOT;

const lib = require("./lib.js");
const { sections } = require("./sections.js");
const { sectionsForShard } = require("./shards.js");

const {
  EXT,
  OUT,
  ONLY,
  BROWSER,
  HEADED,
  COVERAGE_FILE,
  coverage,
  argValue,
  launch,
  check,
  expect,
  waitFor,
  writeReport,
} = lib;
// A held-back feature's section only runs once its flag is actually on in the build under test, read from
// manifest.json in whichever folder --ext points at. npm run test:e2e:all-on builds that folder with every flag
// on, so it runs every section; any other run picks up whatever the manifest already ships.
const manifestFeatures = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).clotr_features;
const SECTIONS = sections(undefined, manifestFeatures);

// --part k/n picks the k-th of n slices of the sections, each short enough to finish under a runner that kills any
// one command after 10 minutes. --shard instead picks the sections tests/e2e/shards.js names for that shard, built
// to keep CI's parallel jobs close in length rather than close in section count.
const PART = (() => {
  const i = process.argv.indexOf("--part");
  const m = /^(\d+)\/(\d+)$/.exec(i > 0 ? process.argv[i + 1] || "" : "");
  return m && Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2]) ? { k: Number(m[1]), n: Number(m[2]) } : { k: 1, n: 1 };
})();
const SHARD = argValue("--shard");
const RUN_SECTIONS = SHARD
  ? SECTIONS.filter((s) => sectionsForShard(SHARD).includes(s))
  : SECTIONS.filter((_, i) => Math.floor((i * PART.n) / SECTIONS.length) === PART.k - 1);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // A full run starts with no screenshots left over, so a stale one from a check that no longer takes any can't be
  // mistaken for today's UI.
  if (!ONLY.length && PART.k === 1) {
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
  }
  console.log(`Clotr end-to-end tests\n  browser: ${BROWSER}`);
  const ctx = await launch();
  console.log(`  engine:  ${ctx.version}${HEADED ? " (headed)" : " (headless)"}\n`);

  // Every section gets the same env object: the helpers, the browser, and anything earlier sections added to it.
  // A check can open an extra tab (for example, a dropped local file) without its own page handle knowing about it.
  // Close any new tab before the next check so one stray target can't slow unrelated checks later in the shard.
  const cleanupPages = async (id, browser, known) => {
    let pages;
    try {
      pages = await waitFor(() => browser.pages(), 5000);
    } catch (err) {
      ctx.problems.push(`${id}: couldn't list browser pages for cleanup: ${err.message}`);
      return;
    }
    if (!pages) {
      ctx.problems.push(`${id}: couldn't list browser pages for cleanup within 5 seconds`);
      return;
    }
    const extras = pages.filter((page) => !known.has(page) && !page.isClosed());
    const outcomes = await Promise.allSettled(
      extras.map((page) => waitFor(() => page.close({ runBeforeUnload: false }).then(() => true), 5000)),
    );
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].status === "rejected" || !outcomes[i].value) {
        ctx.problems.push(`${id}: couldn't close leftover tab ${extras[i].url()}`);
      }
    }
  };
  const checkWithCleanup = async (id, title, fn) => {
    const browsers = [ctx.browser, ctx.spanishBrowser?.browser].filter(Boolean);
    const known = new Map();
    for (const browser of browsers) {
      const pages = await waitFor(() => browser.pages(), 5000);
      if (!pages) throw new Error(`${id}: couldn't list browser pages before the check`);
      known.set(browser, new Set(pages));
    }
    try {
      await check(id, title, fn);
    } finally {
      for (const browser of [ctx.browser, ctx.spanishBrowser?.browser].filter(Boolean)) {
        await cleanupPages(id, browser, known.get(browser) || new Set());
      }
    }
  };
  const env = { ...lib, ctx, check: checkWithCleanup };
  try {
    for (const name of RUN_SECTIONS) await require(`./checks/${name}.js`)(env);

    await check("Z2", "No Clotr errors or warnings in any console", async () => {
      expect(!ctx.problems.length, ctx.problems.slice(0, 5).join(" | "));
    });
  } finally {
    // The browser has to close no matter what happens above, since a browser left open keeps the whole run alive.
    // A crash once hung it for 10 minutes before this was added.
    await ctx.browser.close().catch(() => {});
    fs.rmSync(ctx.profile, { recursive: true, force: true });
  }
  writeReport(ctx);
  if (coverage) await coverage.save(COVERAGE_FILE);
}

main()
  .catch((err) => {
    console.error("\nE2E run crashed:", err);
    process.exitCode = 2; // A leftover handle can't keep a crashed run waiting forever once TMP_ROOT is cleaned up.
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file a check left open: the folder's name says what it is, and the next clean-up takes it.
    }
    process.exit(process.exitCode || 0);
  });
