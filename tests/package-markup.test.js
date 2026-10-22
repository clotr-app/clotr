// A held-back feature's own markup, comments and name never reach the shipped build either: tools/package.js
// strips every data-feature="<name>" element from the built HTML and every HTML comment, trims the feature's
// name from clotr_features, and drops a message key once nothing shipped still asks for it. So a store
// reviewer reading the files finds no title, subtitle or name for something that isn't there. Turning the
// feature on ships its markup, name and strings whole again, from the same flag.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build, FEATURE_FILES, stripFeatureMarkup } = require("../tools/package.js");
const manifestOnDisk = require("../extension/manifest.json");

const HELD_BACK = Object.keys(FEATURE_FILES);
const STILL_OFF = HELD_BACK.filter((k) => !manifestOnDisk.clotr_features[k]);

// Every folder a test makes is removed when the file's tests end (npm test also wipes its own scratch folder).
const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-pkg-markup-"));
  made.push(d);
  return d;
};
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// A held-back feature's own string, once its card is stripped: there only while its flag is on.
const FEATURE_MESSAGES = {
  tourniquet: "ss_tq30Ask",
  extcheck: "hp_extCheckLine",
  scamcheck: "ss_shareCheckText",
  commandcheck: "pp_commandCheck",
  practice: "ss_shareTogetherText",
  checkup: ["pc_exit", "pc_exitLabel", "pc_exitHint"],
};

// Reads a stored-only zip back into [name, bytes] pairs; package.test.js has the fuller version with CRC checks.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const size = buf.readUInt32LE(p + 20);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push([name, buf.subarray(dataStart, dataStart + size)]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("the shipped build strips every still-held-back feature's markup, comments and name", () => {
  const r = build({ outDir: tmp() });
  const entries = unzip(fs.readFileSync(r.out));
  const html = entries.filter(([n]) => n.endsWith(".html"));
  assert.ok(html.length > 3, "too few HTML files shipped to be a real check");
  for (const [name, data] of html) {
    const text = data.toString("utf8");
    assert.ok(!text.includes("<!--"), `${name}: still has a comment`);
    for (const feature of STILL_OFF) {
      assert.ok(!text.includes(`data-feature="${feature}"`), `${name}: still has ${feature}'s markup`);
      if (feature === "oneclotr") assert.ok(!text.includes('id="one-clotr"'), `${name}: One Clotr card still ships`);
    }
  }
  const manifest = JSON.parse(entries.find(([n]) => n === "manifest.json")[1].toString("utf8"));
  for (const feature of STILL_OFF) {
    assert.ok(
      !(feature in manifest.clotr_features),
      `${feature}: a held-back feature's name is still in clotr_features`,
    );
  }
  const es = JSON.parse(entries.find(([n]) => n === "_locales/es/messages.json")[1].toString("utf8"));
  for (const [feature, keys] of Object.entries(FEATURE_MESSAGES)) {
    if (!STILL_OFF.includes(feature)) continue;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      assert.ok(!(key in es), `${key}: a held-back string still shipped`);
    }
  }
  if (STILL_OFF.includes("checkup")) {
    for (const [name, data] of html) {
      const text = data.toString("utf8");
      assert.ok(!text.includes('src="quick-exit.js"'), `${name}: Quick exit script still referenced`);
      assert.ok(!text.includes('href="quick-exit.css"'), `${name}: Quick exit stylesheet still referenced`);
    }
    assert.ok(!entries.some(([name]) => name === "quick-exit.js" || name === "quick-exit.css"));
  }
});

test("a held-back stylesheet link is removed as a void element", () => {
  const html =
    '<head><link rel="stylesheet" href="quick-exit.css" data-feature="checkup"><meta charset="utf-8"></head>';
  assert.equal(stripFeatureMarkup(html, { checkup: false }), '<head><meta charset="utf-8"></head>');
});

test("One Clotr's popup card and bridge references follow its flag", () => {
  const off = build({ zip: false, folder: tmp() });
  const offPopup = fs.readFileSync(path.join(off.folder, "popup.html"), "utf8");
  assert.ok(!offPopup.includes('id="one-clotr"'));
  assert.ok(!offPopup.includes('src="one-clotr-protocol.js"'));
  assert.ok(!offPopup.includes('src="one-clotr-bridge.js"'));

  const on = build({ zip: false, folder: tmp(), features: { oneclotr: true } });
  const onPopup = fs.readFileSync(path.join(on.folder, "popup.html"), "utf8");
  assert.ok(onPopup.includes('id="one-clotr"'));
  assert.ok(onPopup.includes('data-feature="oneclotr"'));
  assert.ok(onPopup.includes('src="one-clotr-protocol.js" data-feature="oneclotr"'));
  assert.ok(onPopup.includes('src="one-clotr-bridge.js" data-feature="oneclotr"'));
});

test("turning a held-back feature on ships its markup, name and strings again", () => {
  for (const feature of Object.keys(FEATURE_MESSAGES)) {
    const r = build({ outDir: tmp(), features: { [feature]: true } });
    const entries = unzip(fs.readFileSync(r.out));
    const html = entries.filter(([n]) => n.endsWith(".html")).map(([, data]) => data.toString("utf8"));
    assert.ok(
      html.some((text) => text.includes(`data-feature="${feature}"`)),
      `${feature}: its markup is missing once it's on`,
    );
    const manifest = JSON.parse(entries.find(([n]) => n === "manifest.json")[1].toString("utf8"));
    assert.strictEqual(manifest.clotr_features[feature], true, `${feature}: missing from clotr_features once on`);
    const es = JSON.parse(entries.find(([n]) => n === "_locales/es/messages.json")[1].toString("utf8"));
    const keys = Array.isArray(FEATURE_MESSAGES[feature]) ? FEATURE_MESSAGES[feature] : [FEATURE_MESSAGES[feature]];
    for (const key of keys) assert.ok(key in es, `${feature}: ${key} is still missing once it's on`);
    if (feature === "checkup") {
      assert.ok(entries.some(([name]) => name === "quick-exit.js"));
      assert.ok(entries.some(([name]) => name === "quick-exit.css"));
      assert.ok(html.some((text) => text.includes('src="quick-exit.js" data-feature="checkup"')));
      assert.ok(html.some((text) => text.includes('href="quick-exit.css" data-feature="checkup"')));
    }
    if (feature === "oneclotr") assert.ok(html.some((text) => text.includes('id="one-clotr"')));
  }
});
