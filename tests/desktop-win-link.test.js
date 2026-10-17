"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const popup = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(root, "extension", "_locales", "en", "messages.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(root, "extension", "_locales", "es", "messages.json"), "utf8"));

test("the extension settings page links to Clotr for Windows in both locales", () => {
  assert.match(popup, /data-i18n="getClotrWindows"/);
  assert.match(popup, /href="https:\/\/clotr\.app\/download\.html#windows"/);
  assert.equal(en.getClotrWindows.message, "Get Clotr for Windows");
  assert.equal(es.getClotrWindows.message, "Consigue Clotr para Windows");
  assert.match(changelog, /- The settings page links to Clotr for Windows\./);
});
