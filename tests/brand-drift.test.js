// One mark everywhere: the extension's toolbar icon, the website's icons and the stores' logos (tools/brand.js)
// draw themselves from the same source drawing Clotr for Windows and Android render their own icons from. This
// fails if tools/brand.js ever stops reading that exact file (an embedded copy going stale instead of the shared
// one), or if the committed extension icons fall behind what make-icons.js would draw from it right now.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function findBrowser() {
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    `${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium`,
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

test("brand drift: tools/brand-mark.svg still matches the apps' own icon source", (t) => {
  const appSource = path.join(ROOT, "apps", "desktop", "icon-source", "clotr-app-icon.svg");
  if (!fs.existsSync(appSource)) {
    t.skip("this checkout has no apps folder");
    return;
  }
  const { APP_MARK_SOURCE } = require(path.join(ROOT, "tools", "brand.js"));
  assert.equal(
    APP_MARK_SOURCE,
    fs.readFileSync(appSource, "utf8").trim(),
    "tools/brand-mark.svg no longer matches the apps' icon source; copy it over and rerun npm run icons",
  );
});

test("brand drift: the extension's icons match tools/make-icons.js's own output", async (t) => {
  const browserPath = findBrowser();
  if (!browserPath) {
    t.skip("no Brave/Chrome/Edge found to drive");
    return;
  }
  try {
    require("puppeteer-core");
  } catch {
    t.skip("puppeteer-core isn't installed");
    return;
  }

  const { plaster, renderPng } = require(path.join(ROOT, "tools", "brand.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-icons-test-"));
  try {
    const jobs = [];
    for (const state of ["on", "off", "spot"]) {
      for (const size of [16, 32, 48, 128]) {
        jobs.push({
          file: path.join(tmp, `icon-${state}-${size}.png`),
          svg: plaster(state, { size }),
          w: size,
          h: size,
          transparent: true,
        });
      }
    }
    await renderPng(jobs);
    const realIcons = path.join(ROOT, "extension", "icons");
    for (const state of ["on", "off", "spot"]) {
      for (const size of [16, 32, 48, 128]) {
        const name = `icon-${state}-${size}.png`;
        assert.ok(
          fs.readFileSync(path.join(tmp, name)).equals(fs.readFileSync(path.join(realIcons, name))),
          `extension/icons/${name} is stale: re-run npm run icons`,
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
