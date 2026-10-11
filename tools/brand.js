// Clotr's toolbar and store icon, drawn in code instead of saved as image files, and the helpers that render SVG
// to PNG through a headless browser, so no separate image tools are needed. make-icons.js uses it.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let uid = 0;
const nextId = (p) => `${p}${uid++}`;

// Geometry for the toolbar and store icon: just the stitched bandage, tilted -32 degrees, with no tile or
// letter. I fit each size by hand instead of scaling one shape so small icons stay crisp, which is also why
// the numbers below don't scale neatly between rows.
const PLASTER_GEO = {
  16: { tapeHW: 6.52, tapeHH: 2.42, tapeSW: 1.0, padX: 2.53, padY: 1.75, padW: 5.05, padH: 3.51, padR: 0.28 },
  32: {
    tapeHW: 13.75,
    tapeHH: 5.29,
    tapeSW: 1.5,
    padX: 5.22,
    padY: 3.63,
    padW: 10.44,
    padH: 7.25,
    padR: 0.58,
    stitchHW: 11.94,
    stitchHH: 3.48,
    stitchSW: 0.8,
    stitchDash: "1.21 0.85",
  },
  48: {
    tapeHW: 20.99,
    tapeHH: 8.16,
    tapeSW: 2.0,
    padX: 7.92,
    padY: 5.5,
    padW: 15.83,
    padH: 10.99,
    padR: 0.88,
    stitchHW: 18.24,
    stitchHH: 5.41,
    stitchSW: 1.01,
    stitchDash: "1.83 1.28",
  },
  128: {
    tapeHW: 57.91,
    tapeHH: 23.25,
    tapeSW: 3.0,
    padX: 21.39,
    padY: 14.85,
    padW: 42.78,
    padH: 29.7,
    padR: 1.0,
    stitchHW: 50.48,
    stitchHH: 15.83,
    stitchSW: 2.72,
    stitchDash: "4.95 3.47",
  },
};

const PLASTER_COLORS = {
  tape: "#E3E6E9", // a light steel, light enough to read on its own on both light and dark toolbars
  key: "#1F2226",
  pad: "#5B3A63",
  padOff: "#545B64", // the same bandage with the plum drained out, used when Clotr isn't active
  dot: "#E2C81C", // matches the popup's colour for a spotted site
};

// The toolbar icon has three states. Only the pad's colour changes between on and off, and spot is just the
// on bandage plus the dot Clotr already uses elsewhere to flag an AI site it hasn't opened on yet.
//   on   - protecting this tab
//   off  - not active here yet (the default icon before any tab reports in)
//   spot - this page looks like an AI chat, click to protect it
function plaster(state = "on", { size = 128 } = {}) {
  const g = PLASTER_GEO[size];
  if (!g) throw new Error(`no plaster geometry for size ${size}`);
  const cx = size / 2,
    cy = size / 2;
  const tape =
    `<path d="M${-g.tapeHW} ${-g.tapeHH}H${g.tapeHW}V${g.tapeHH}H${-g.tapeHW}Z" fill="${PLASTER_COLORS.tape}" ` +
    `stroke="${PLASTER_COLORS.key}" stroke-width="${g.tapeSW}" stroke-linejoin="round"/>`;
  const pad = state === "off" ? PLASTER_COLORS.padOff : PLASTER_COLORS.pad;
  const padRect = `<rect x="${-g.padX}" y="${-g.padY}" width="${g.padW}" height="${g.padH}" rx="${g.padR}" fill="${pad}"/>`;
  const stitch = g.stitchHW
    ? `<path d="M${-g.stitchHW} ${-g.stitchHH}H${g.stitchHW}V${g.stitchHH}H${-g.stitchHW}Z" fill="none" ` +
      `stroke="${PLASTER_COLORS.key}" stroke-width="${g.stitchSW}" stroke-dasharray="${g.stitchDash}"/>`
    : "";
  const bandage = `<g transform="translate(${cx} ${cy}) rotate(-32)">${tape}${padRect}${stitch}</g>`;
  const dot =
    state === "spot"
      ? `<circle cx="${size * 0.78}" cy="${size * 0.78}" r="${size * 0.165}" fill="${PLASTER_COLORS.dot}" ` +
        `stroke="${PLASTER_COLORS.key}" stroke-width="${Math.max(size * 0.02, 0.6)}"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bandage}${dot}</svg>`;
}

// The bandage at any size, for pictures bigger than the toolbar's: one hand-fit drawing scaled through the viewBox,
// with an optional margin and an opaque background. The hand-fit sizes with neither come back exactly as plaster()
// draws them.
function plasterAt(size, { from = PLASTER_GEO[size] ? size : 128, padding = 0, background = null, state = "on" } = {}) {
  const svg = plaster(state, { size: from });
  if (from === size && !padding && !background) return svg;
  const m = +((padding * from) / (size - 2 * padding)).toFixed(3);
  const side = +(from + 2 * m).toFixed(3);
  const bg = background ? `<rect x="${-m}" y="${-m}" width="${side}" height="${side}" fill="${background}"/>` : "";
  return svg.replace(
    / width="\d+" height="\d+" viewBox="[^"]*">/,
    ` width="${size}" height="${size}" viewBox="${-m} ${-m} ${side} ${side}">${bg}`,
  );
}

// Each store's listing logo. Chrome asks for 96 px of artwork inside 16 px of see-through padding; Edge asks for a
// 300 px square, and gets the same share of margin so the corners survive its rounded tiles. Firefox shows the
// package's own icon.
const STORE_LOGOS = {
  chrome: { size: 128, file: "docs/store/logo-chrome-128.png", svg: () => plasterAt(128, { padding: 16 }) },
  edge: { size: 300, file: "docs/store/logo-edge-300.png", svg: () => plasterAt(300, { padding: 37.5 }) },
  firefox: { size: 128, file: "extension/icons/icon-on-128.png", svg: () => plaster("on", { size: 128 }) },
};

// The website header's brushed steel, the colour every page opens on in both themes. The opaque icons sit on it.
const STEEL = "#C2C7CC";

// The wordmark the popup ships (extension/icons/wordmark.svg) draws its letters inside a 330×116 box they don't
// fill: they stop at x 233 and y 95, leaving blank margin on the right and below. Sized by that box's own height,
// the letters read smaller than they are and leave a gap before whatever text follows them. wordmarkTight() crops
// the viewBox to the letters' own bounding box (measured once from the live render, not guessed) so a header or a
// headline can size the mark by its own type height and butt the next word right up against it.
const WORDMARK_SOURCE = fs.readFileSync(path.join(ROOT, "extension", "icons", "wordmark.svg"), "utf8").trim();
const WORDMARK_CROP = { x: 4, y: 14, w: 232, h: 86 };
function wordmarkTight() {
  return WORDMARK_SOURCE.replace(
    / width="330" height="116" viewBox="0 0 330 116"/,
    ` width="${WORDMARK_CROP.w}" height="${WORDMARK_CROP.h}" viewBox="${WORDMARK_CROP.x} ${WORDMARK_CROP.y} ${WORDMARK_CROP.w} ${WORDMARK_CROP.h}"`,
  );
}

// The clotr-app organisation's avatar, which GitHub also puts on the repo's link previews. GitHub shows it as small
// as 20 px and crops it to a circle, so the bandage is drawn large with its far corners still inside the circle.
const GITHUB_AVATAR = {
  size: 500,
  file: "docs/brand/github-avatar-500.png",
  svg: () => plasterAt(500, { padding: 30, background: STEEL }),
};

// Recursive is the extension's own font. I embed it here so a render never has to fetch anything.
function fontCss() {
  const data = fs.readFileSync(path.join(ROOT, "extension", "fonts", "Recursive-var-normal.woff2")).toString("base64");
  return `@font-face{font-family:"Recursive";src:url(data:font/woff2-variations;base64,${data}) format("woff2-variations");font-weight:300 1000}`;
}

const BROWSERS = [
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function launchBrowser() {
  const puppeteer = require("puppeteer-core");
  const executablePath = process.env.CLOTR_BROWSER || BROWSERS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error("No Brave/Chrome found (set CLOTR_BROWSER)");
  return puppeteer.launch({ executablePath, headless: true, pipe: true });
}

// Renders a batch of SVGs to PNG files, all in one browser session. Each job gives a file path, the svg
// string, a width and height, and whether the background should stay transparent.
async function renderPng(jobs) {
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    const css = fontCss();
    for (const j of jobs) {
      await tab.setViewport({ width: j.w, height: j.h, deviceScaleFactor: 1 });
      await tab.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${j.svg}</body></html>`,
        { waitUntil: "load" },
      );
      await tab.evaluate("document.fonts.ready"); // runs in the page
      fs.mkdirSync(path.dirname(j.file), { recursive: true });
      await tab.screenshot({
        path: j.file,
        omitBackground: !!j.transparent,
        clip: { x: 0, y: 0, width: j.w, height: j.h },
      });
      console.log(path.relative(ROOT, j.file).replace(/\\/g, "/"), `(${j.w}×${j.h})`);
    }
  } finally {
    await browser.close();
  }
}

// Converts PNGs to WebP in the same browser; the website's screenshots end up about a third of the size.
// Each job gives a from path, a to path, and an optional quality.
async function renderWebp(jobs) {
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    for (const j of jobs) {
      const src = `data:image/png;base64,${fs.readFileSync(j.from).toString("base64")}`;
      // runs in the page
      const url = await tab.evaluate(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(src)};
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/webp", ${j.quality || 0.85});
      })()`);
      if (!url.startsWith("data:image/webp")) throw new Error("This browser can't write WebP");
      fs.writeFileSync(j.to, Buffer.from(url.split(",")[1], "base64"));
      console.log(path.relative(ROOT, j.to).replace(/\\/g, "/"), `(${fs.statSync(j.to).size} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

module.exports = {
  ROOT,
  GITHUB_AVATAR,
  PLASTER_COLORS,
  STORE_LOGOS,
  plaster,
  plasterAt,
  STEEL,
  renderPng,
  renderWebp,
  nextId,
  fontCss,
  wordmarkTight,
};
