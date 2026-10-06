// The entry point for the end-to-end suite: it opens a real browser with Clotr loaded and runs every check in
// ./checks in order, the way run order is decided by ./sections.js. The helpers each check uses live in ./lib.js.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --part 1/3       the first third of the sections (then 2/3, 3/3)
//   npm run test:e2e -- --browser "C:/path/to/chrome.exe"
//   npm run test:e2e:all-on              a held-back feature's own checks, against an all-on build (sections.js)
//
// This also runs in a Linux container, so CI and cloud sessions fall back to the Playwright Chromium build and add
// --no-sandbox when running as root.
//
// Nothing here touches the network. The browser gets a throwaway profile, never a real one, and every request is
// either answered by a fake page in ./pages or blocked outright.
"use strict";

const fs = require("fs");
const path = require("path");
const lib = require("./lib.js");
const { sections } = require("./sections.js");

const { OUT, ONLY, BROWSER, HEADED, ALL_ON, launch, check, expect, writeReport } = lib;
const SECTIONS = sections(undefined, ALL_ON);

// --part k/n picks the k-th of n slices of the sections, each short enough to finish under a runner that kills any
// one command after 10 minutes.
const PART = (() => {
  const i = process.argv.indexOf("--part");
  const m = /^(\d+)\/(\d+)$/.exec(i > 0 ? process.argv[i + 1] || "" : "");
  return m && +m[1] >= 1 && +m[1] <= +m[2] ? { k: +m[1], n: +m[2] } : { k: 1, n: 1 };
})();
const RUN_SECTIONS = SECTIONS.filter((_, i) => Math.floor((i * PART.n) / SECTIONS.length) === PART.k - 1);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // A full run starts with no screenshots left over, so a stale one from a check that no longer takes any can't be
  // mistaken for today's UI.
  if (!ONLY.length && PART.k === 1)
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
  console.log(`Clotr end-to-end tests\n  browser: ${BROWSER}`);
  const ctx = await launch();
  console.log(`  engine:  ${ctx.version}${HEADED ? " (headed)" : " (headless)"}\n`);

  // Every section gets the same env object: the helpers, the browser, and anything earlier sections added to it.
  const env = { ...lib, ctx };
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
}

main().catch((err) => {
  console.error("\nE2E run crashed:", err);
  process.exit(2); // Exit right away, so a leftover handle can't keep a crashed run waiting forever.
});
