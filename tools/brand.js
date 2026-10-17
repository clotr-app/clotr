// Clotr's toolbar and store icon, drawn in code instead of saved as image files, and the helpers that render SVG
// to PNG through a headless browser, so no separate image tools are needed. make-icons.js uses it.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let uid = 0;
const nextId = (p) => `${p}${uid++}`;

// One mark everywhere: the same C with the bandage across its mouth that Clotr for Windows and Android draw.
// tools/brand-mark.svg is a copy of the apps' own icon source, kept beside this script so it
// works in a checkout without the apps; tests/brand-drift.test.js fails if the two stop matching.
const APP_MARK_SOURCE = fs.readFileSync(path.join(__dirname, "brand-mark.svg"), "utf8").trim();
const APP_MARK_BODY = APP_MARK_SOURCE.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const PLASTER_COLORS = {
  tileTop: "#4A3560", // plum, the tile's gradient start
  tileBottom: "#1A1221", // ink, the tile's gradient end
  tileEdge: "#93819f",
  ring: "#FF6700", // the C
  cap: "#F7F1FB", // the bandage's tape
  key: "#1A1221", // ink: outlines and body text next to the mark
  pad: "#4A3560", // plum: headings next to the mark (the name "pad" is historical, from the mark's old bandage-only look)
  dot: "#E2C81C", // matches the popup's colour for a spotted site
};

// A fresh id for every def a drawing needs (gradients, filters), so two copies of the mark can sit in one page
// (a preview sheet, a contact sheet) without one silently reusing the other's fill.
function freshIds(body, ...names) {
  let out = body;
  for (const name of names) {
    const id = nextId("m");
    out = out
      .replace(new RegExp(`id="${name}"`), `id="${id}"`)
      .replace(new RegExp(`url\\(#${name}\\)`, "g"), `url(#${id})`);
  }
  return out;
}

// Below 24 px the full drawing (the ring's two-tone edge, the bandage's own border and stitch) blurs into a smudge,
// so this is a simplified stand-in, by hand: one thick ring, a bigger bandage with no stitch, and (since colour
// alone can't carry the shape once the off state drains it to grey) a dark keyline under the ring and the
// bandage's tape, so the C and the bandage still read as two shapes at a few pixels across. Same C, same bandage
// angle and corner as the full drawing.
function simplifiedMark(size) {
  const tile =
    `<rect x="2" y="2" width="124" height="124" rx="26" fill="url(#g)" ` +
    `stroke="${PLASTER_COLORS.tileEdge}" stroke-width="1.5" stroke-opacity=".6"/>`;
  const ringEdge = `<path d="M 84.5 44.5 A 33 33 0 1 0 84.5 87.5" fill="none" stroke="${PLASTER_COLORS.key}" stroke-width="44"/>`;
  const ring = `<path d="M 84.5 44.5 A 33 33 0 1 0 84.5 87.5" fill="none" stroke="${PLASTER_COLORS.ring}" stroke-width="38"/>`;
  const bandage =
    `<g transform="translate(93 66) rotate(-45)">` +
    `<rect x="-19" y="-35" width="38" height="70" rx="6" fill="${PLASTER_COLORS.key}"/>` +
    `<rect x="-18" y="-34" width="36" height="68" rx="5" fill="${PLASTER_COLORS.cap}"/>` +
    `<rect x="-10" y="-11" width="20" height="22" rx="3" fill="${PLASTER_COLORS.ring}"/>` +
    `</g>`;
  const body = freshIds(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PLASTER_COLORS.tileTop}"/>` +
      `<stop offset="1" stop-color="${PLASTER_COLORS.tileBottom}"/></linearGradient></defs>${tile}${ringEdge}${ring}${bandage}`,
    "g",
  );
  return `<g transform="scale(${size / 128})">${body}</g>`;
}

// The full drawing, scaled from its own 128-unit artwork.
function fullMark(size) {
  return `<g transform="scale(${size / 128})">${freshIds(APP_MARK_BODY, "g")}</g>`;
}

// The toolbar and store icon has three states. On and spot show the mark at full colour; off drains it to grey
// and dims it, the same recipe Clotr for Windows' tray uses for its own off icon, so every app agrees on what
// "not active" looks like.
//   on   - protecting this tab
//   off  - not active here yet (the default icon before any tab reports in)
//   spot - this page looks like an AI chat, click to protect it
function plaster(state = "on", { size = 128 } = {}) {
  const mark = size < 24 ? simplifiedMark(size) : fullMark(size);
  const body =
    state === "off"
      ? freshIds(
          `<defs><filter id="drain"><feColorMatrix type="saturate" values="0"/></filter></defs>` +
            `<g filter="url(#drain)" opacity="0.7">${mark}</g>`,
          "drain",
        )
      : mark;
  const dot =
    state === "spot"
      ? `<circle cx="${size * 0.78}" cy="${size * 0.78}" r="${size * 0.165}" fill="${PLASTER_COLORS.dot}" ` +
        `stroke="${PLASTER_COLORS.key}" stroke-width="${Math.max(size * 0.02, 0.6)}"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}${dot}</svg>`;
}

// The mark at any size, for pictures bigger than the toolbar's: one drawing scaled through the viewBox, with an
// optional margin and an opaque background. With neither, this comes back exactly as plaster() draws it.
function plasterAt(size, { from = size, padding = 0, background = null, state = "on" } = {}) {
  const svg = plaster(state, { size: from });
  if (from === size && !padding && !background) return svg;
  const m = Number(((padding * from) / (size - 2 * padding)).toFixed(3));
  const side = Number((from + 2 * m).toFixed(3));
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
// as 20 px and crops it to a circle, so the tile is drawn round here instead of its usual rounded square: a
// square's corners would be cut off by that crop (tests/site-icons.test.js checks this directly).
function githubAvatarSvg() {
  const size = GITHUB_AVATAR.size;
  const markSize = 470; // its radius (235) stays inside the 240 px GitHub crops to, with a hair of margin
  const circleTile = `<circle cx="64" cy="64" r="62" fill="url(#g)" stroke="${PLASTER_COLORS.tileEdge}" stroke-width="1.5" stroke-opacity=".6"/>`;
  const body = freshIds(APP_MARK_BODY.replace(/<rect[^>]*rx="26"[^>]*\/>/, circleTile), "g");
  const offset = (size - markSize) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${STEEL}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${markSize / 128})">${body}</g></svg>`
  );
}
const GITHUB_AVATAR = {
  size: 500,
  file: "docs/brand/github-avatar-500.png",
  svg: githubAvatarSvg,
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
        omitBackground: Boolean(j.transparent),
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
  APP_MARK_SOURCE,
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
