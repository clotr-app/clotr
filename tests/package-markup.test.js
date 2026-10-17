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
const { build, FEATURE_FILES } = require("../tools/package.js");
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
  for (const [feature, key] of Object.entries(FEATURE_MESSAGES)) {
    if (STILL_OFF.includes(feature)) assert.ok(!(key in es), `${key}: a held-back string still shipped`);
  }
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
    assert.ok(FEATURE_MESSAGES[feature] in es, `${feature}: its string is still missing once it's on`);
  }
});
