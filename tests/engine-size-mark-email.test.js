"use strict";

// An image file name with a size mark, like "icon@2x.png", is a file name, not an email. Real emails next to it,
// including ones whose user part ends in a digit, are still found. All values are made up.

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

function emails(text) {
  const found = globalThis.Clotr.detect(text).find((r) => r.id === "email");
  return found ? found.matches : [];
}

const MARKS = ["2x", "3x", "1.5x", "2X"];
const EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "PNG"];
const NAMES = ["icon", "logo-dark", "btn_close", "hero.banner", "avatar2"];

test("image names with a size mark stay quiet", () => {
  for (const name of NAMES) {
    for (const mark of MARKS) {
      for (const ext of EXTENSIONS) {
        const file = `${name}@${mark}.${ext}`;
        for (const text of [file, `background: url("img/${file}");`, `assets/${file}\nassets/${name}.${ext}`]) {
          assert.deepEqual(emails(text), [], JSON.stringify(text));
        }
      }
    }
  }
});

test("a srcset with size-mark names stays quiet", () => {
  assert.deepEqual(emails('<img src="logo.png" srcset="logo@2x.png 2x, logo@3x.png 3x">'), []);
});

test("real-shaped emails are still found", () => {
  const cases = [
    "jane.doe@example.com",
    "sam2@example.org",
    "kim.lee7@mail-host.net",
    "pat99@2x.com",
    "dev3@png.example.io",
    "ops42@img.example.co.uk",
  ];
  for (const address of cases) {
    assert.deepEqual(emails(`write to ${address} today`), [address], address);
  }
});

test("an email next to a size-mark image name is still found", () => {
  assert.deepEqual(emails("icon@2x.png was sent by robin5@example.com"), ["robin5@example.com"]);
});
