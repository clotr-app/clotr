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

// Each browser smooths a small icon's edges a little differently (Brave on Windows, Chromium on Linux CI), so the
// files never match byte for byte across machines. The pixels are compared instead: a redrawn mark differs in most
// of its pixels, smoothing only in a few edge ones.
function decodePng(buf) {
  const zlib = require("zlib");
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs are read here");
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (!channels) throw new Error(`PNG colour type ${data[9]} isn't read here`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter];
      out[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = out.subarray(i * channels, (i + 1) * channels);
    const rgba =
      channels === 4
        ? src
        : channels === 3
          ? [...src, 255]
          : channels === 2
            ? [src[0], src[0], src[0], src[1]]
            : [src[0], src[0], src[0], 255];
    for (let k = 0; k < 4; k++) pixels[i * 4 + k] = rgba[k];
  }
  return { width, height, pixels };
}

// The mean channel difference, and the share of pixels that differ by more than 32 in any channel.
function pixelDiff(a, b) {
  let total = 0;
  let far = 0;
  const count = a.length / 4;
  for (let i = 0; i < count; i++) {
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(a[i * 4 + k] - b[i * 4 + k]);
      total += d;
      worst = Math.max(worst, d);
    }
    if (worst > 32) far++;
  }
  return { mean: Math.round((total / a.length) * 100) / 100, farOff: Math.round((far / count) * 1000) / 1000 };
}

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
        const drawn = decodePng(fs.readFileSync(path.join(tmp, name)));
        const committed = decodePng(fs.readFileSync(path.join(realIcons, name)));
        assert.ok(
          drawn.width === committed.width && drawn.height === committed.height,
          `extension/icons/${name} is stale: re-run npm run icons`,
        );
        // Loose on purpose: a 16-pixel icon smoothed by another browser is off by about 7 on average, as much as
        // the small spotted dot. The fingerprint test below catches a small change exactly; this catches an icon
        // that doesn't match its drawing at all (the on, off and spot icons are 32 to 54 apart).
        const diff = pixelDiff(drawn.pixels, committed.pixels);
        assert.ok(
          diff.mean <= 20 && diff.farOff <= 0.5,
          `extension/icons/${name} is stale: re-run npm run icons (${JSON.stringify(diff)})`,
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("brand drift: the extension's icons were drawn from today's bandage", () => {
  const { iconsSourceHash, FINGERPRINT } = require(path.join(ROOT, "tools", "make-icons.js"));
  assert.equal(
    fs.readFileSync(FINGERPRINT, "utf8").trim(),
    iconsSourceHash(),
    "the bandage drawing changed since the icons were made: re-run npm run icons",
  );
});
