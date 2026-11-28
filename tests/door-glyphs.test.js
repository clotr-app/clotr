"use strict";
// The four door glyphs on the site's cards: each draws inside the steel disc, and no two are the same drawing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DISC, GLYPHS } = require("../tools/make-icons");

const DOORS = ["vscode", "extension", "windows", "android"];

const num = (attrs, name) => Number((attrs.match(new RegExp(`\\b${name}="([^"]+)"`)) || [])[1] || 0);

// Points along a path made of absolute M, L, H, V, Q and Z commands, with quadratic curves sampled.
function pathPoints(d) {
  const tokens = d.match(/[MLHVQZ]|-?\d+(?:\.\d+)?/g);
  const points = [];
  let x = 0;
  let y = 0;
  let cmd = "";
  for (let i = 0; i < tokens.length;) {
    if (/[A-Z]/.test(tokens[i])) cmd = tokens[i++];
    const n = () => Number(tokens[i++]);
    if (cmd === "Z") continue;
    if (cmd === "M" || cmd === "L") [x, y] = [n(), n()];
    else if (cmd === "H") x = n();
    else if (cmd === "V") y = n();
    else if (cmd === "Q") {
      const [cx, cy, ex, ey] = [n(), n(), n(), n()];
      for (let t = 0.1; t < 1; t += 0.1) {
        const u = 1 - t;
        points.push([u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey]);
      }
      [x, y] = [ex, ey];
    } else throw new Error(`path command ${cmd} is not handled`);
    points.push([x, y]);
  }
  return points;
}

// Every point a glyph reaches, each with the half stroke that sits outside it.
function glyphReach(glyph) {
  const reach = [];
  for (const [, tag, attrs] of glyph.matchAll(/<(\w+)\s([^>]*)\/>/g)) {
    const pad = num(attrs, "stroke-width") / 2;
    const cx = num(attrs, "cx");
    const cy = num(attrs, "cy");
    if (tag === "circle") reach.push({ x: cx, y: cy, out: num(attrs, "r") + pad });
    else if (tag === "ellipse") reach.push({ x: cx, y: cy, out: Math.max(num(attrs, "rx"), num(attrs, "ry")) + pad });
    else if (tag === "rect") {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => num(attrs, a));
      const corners = [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ];
      for (const [px, py] of corners) reach.push({ x: px, y: py, out: pad });
    } else if (tag === "path") {
      for (const [px, py] of pathPoints(attrs.match(/\bd="([^"]+)"/)[1])) reach.push({ x: px, y: py, out: pad });
    } else throw new Error(`element ${tag} is not handled`);
  }
  return reach;
}

for (const door of DOORS) {
  test(`the ${door} glyph draws inside the disc's outline`, () => {
    const reach = glyphReach(GLYPHS[door]);
    assert.ok(reach.length > 0, "the glyph draws something");
    const inner = DISC.r - DISC.stroke / 2;
    for (const p of reach) {
      const far = Math.hypot(p.x - DISC.cx, p.y - DISC.cy) + p.out;
      assert.ok(far <= inner, `${door} reaches ${far.toFixed(2)} from the centre, past ${inner}`);
    }
  });
}

test("the three new door glyphs differ from each other and from the brackets", () => {
  const drawings = DOORS.map((door) => GLYPHS[door].replace(/\s+/g, " "));
  assert.equal(new Set(drawings).size, DOORS.length);
});
