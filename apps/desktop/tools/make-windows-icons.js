// Clotr for Windows' icons, all from one drawing: the C with the bandage from Clotr's mark
// (icon-source/clotr-app-icon.svg). The app's icon (icon.ico and the sizes Windows and Tauri ask for, rendered
// straight from the SVG at each size instead of scaled down from one big PNG), the tray's three icons (on: the
// icon at full colour; off, paused: its colour drained; look, something worth a look: the icon with a lemon dot),
// the sidebar's own copy (ui/app-icon.svg) and the Store package's tiles in msix/assets.
// Run once after the brand changes: node tools/make-icons.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderPng } = require("../../../tools/brand");

const APP_SVG = fs.readFileSync(path.join(__dirname, "..", "icon-source", "clotr-app-icon.svg"), "utf8");
const at = (size, svg = APP_SVG) => svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
const UI_ICON = path.join(__dirname, "..", "ui", "app-icon.svg");
const MSIX_ASSETS = path.join(__dirname, "..", "msix", "assets");
// The three tiles AppxManifest.xml asks for: the package's logo and its small and medium Start tiles, each the
// size that file already names. Windows adds its own rounding and padding on top of each.
const MSIX_SIZES = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 };
// Paused: the same icon with its colour drained and faded, so it reads as switched off at tray size.
const drained = (svg) =>
  svg
    .replace(
      /(<svg[^>]*>)/,
      '$1<defs><filter id="drain"><feColorMatrix type="saturate" values="0"/></filter></defs><g filter="url(#drain)" opacity="0.55">',
    )
    .replace("</svg>", "</g></svg>");

const ICONS = path.join(__dirname, "..", "src-tauri", "icons");

// The lemon dot (Clotr's spotted-site yellow) at the tile's bottom right, in its 128-unit box.
function withLookDot(svg) {
  return svg.replace(
    "</svg>",
    '<circle cx="100" cy="100" r="22" fill="#e8d23a" stroke="#0b0b0b" stroke-width="4"/></svg>',
  );
}

// A Windows .ico, built by hand from PNGs instead of through Tauri's own `icon` command (which needs its CLI
// installed): the ICO format accepts PNG-compressed entries directly, which every Windows version since Vista
// reads, so no separate BMP encoder is needed. `sizes` lists the square icon each PNG square is.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // 0 means 256 in the ICO format
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Renders every icon into `dirs` (each defaulting to the real shipped location), so a test can point it at a
// scratch folder instead and compare the result with what's committed.
async function build(dirs = {}) {
  const icons = dirs.icons || ICONS;
  const msixAssets = dirs.msixAssets || MSIX_ASSETS;
  const uiIcon = dirs.uiIcon || UI_ICON;
  fs.writeFileSync(uiIcon, APP_SVG);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-icons-"));
  try {
    const sized = (size) => path.join(tmp, `${size}.png`);
    await renderPng([
      ...[...new Set([...ICO_SIZES, 512])].map((size) => ({
        file: sized(size),
        svg: at(size),
        w: size,
        h: size,
        transparent: true,
      })),
      { file: path.join(icons, "tray-on.png"), svg: at(32), w: 32, h: 32, transparent: true },
      { file: path.join(icons, "tray-off.png"), svg: at(32, drained(APP_SVG)), w: 32, h: 32, transparent: true },
      {
        file: path.join(icons, "tray-look.png"),
        svg: at(32, withLookDot(APP_SVG)),
        w: 32,
        h: 32,
        transparent: true,
      },
      ...Object.entries(MSIX_SIZES).map(([name, size]) => ({
        file: path.join(msixAssets, `${name}.png`),
        svg: at(size),
        w: size,
        h: size,
        transparent: true,
      })),
    ]);
    fs.copyFileSync(sized(32), path.join(icons, "32x32.png"));
    fs.copyFileSync(sized(128), path.join(icons, "128x128.png"));
    fs.copyFileSync(sized(256), path.join(icons, "128x128@2x.png"));
    fs.copyFileSync(sized(512), path.join(icons, "icon.png"));
    const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: fs.readFileSync(sized(size)) })));
    fs.writeFileSync(path.join(icons, "icon.ico"), ico);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  build().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { build, ICONS, MSIX_ASSETS, MSIX_SIZES, UI_ICON };
