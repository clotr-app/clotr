// mask(value, kind) is the only way a found value comes back on screen. A password-like kind shows no characters
// at all. Any other kind, and a call with no kind, shows at most a quarter of the value, so a person can still tell
// two values apart without reading either. A value of 8 characters or fewer is all dots, whatever its kind. Every
// value here is made up.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
require("./load-engine.js")("rules", "detect", "decide");
const { build } = require("../tools/engine-bundle.js");
const C = globalThis.Clotr;

// The kinds that are passwords or work like one: a password (with its sign-in codes, PINs and security answers),
// backup codes, a wallet seed or key, a two-step sign-in key, a card's security code, a gift card code, a private
// key and a connection string.
const PASSWORD_KINDS = [
  "password",
  "backup_codes",
  "crypto_secret",
  "otp_secret",
  "card_code",
  "gift_card",
  "private_key",
  "connection_string",
];
const OTHER_KINDS = C.PATTERNS.map((p) => p.id).filter((id) => !PASSWORD_KINDS.includes(id));
const LENGTHS = [9, 10, 11, 12, 13, 15, 16, 20, 31, 32, 33, 48, 63, 64];
const SOURCE = "Qx7mPz4kR2vWn9Lb6TyH3sJd8FgC5aKe1Uo0iNrBhVlMwXtYcZqEp";
const made = (n) => (SOURCE + SOURCE).slice(0, n);
// What a person can read in a masked value: every character that isn't a dot or the ellipsis.
const shownOf = (masked) => [...masked].filter((ch) => ch !== "•" && ch !== "…").length;

test("the password kinds named here are all real kinds", () => {
  const ids = new Set(C.PATTERNS.map((p) => p.id));
  for (const kind of PASSWORD_KINDS) assert.ok(ids.has(kind), kind);
});

test("mask: a password of 9 to 64 characters shows no characters", () => {
  for (const kind of PASSWORD_KINDS) {
    for (const n of LENGTHS) {
      const masked = C.mask(made(n), kind);
      assert.equal(shownOf(masked), 0, `${kind} at ${n}: ${masked}`);
    }
  }
});

test("mask: a password's dots don't give away its length", () => {
  assert.equal(C.mask(made(9), "password"), C.mask(made(64), "password"));
});

test("mask: any other kind of 9 to 64 characters shows at most a quarter of it", () => {
  for (const kind of [...OTHER_KINDS, undefined, null, 0, 1, 2, "", "not_a_kind"]) {
    for (const n of LENGTHS) {
      const masked = C.mask(made(n), kind);
      assert.ok(shownOf(masked) <= Math.floor(n / 4), `${String(kind)} at ${n}: ${masked}`);
      assert.ok(shownOf(masked) >= 1, `${String(kind)} at ${n} shows nothing to tell it apart: ${masked}`);
    }
  }
});

test("mask: a value of 8 characters or fewer stays all dots, whatever its kind", () => {
  for (const kind of [...PASSWORD_KINDS, ...OTHER_KINDS, undefined]) {
    for (let n = 0; n <= 8; n++) assert.equal(C.mask(made(n), kind), "•".repeat(n), `${String(kind)} at ${n}`);
  }
});

test("describeValues: a password result shows no characters, and map's index never counts as a kind", () => {
  const pw = { id: "password", name: "Password or Secret", matches: [made(12), made(20), made(33)] };
  assert.equal(shownOf(C.describeValues(pw).replace(/, /g, "")), 0, C.describeValues(pw));
  const phones = { id: "phone_number", name: "Phone Number", matches: ["555-555-0101", "555-555-0202"] };
  for (const part of C.describeValues(phones).split(", ")) assert.ok(shownOf(part) <= 3, part);
});

test("noticeWords: a password item reads 'Password or Secret (dots)', with nothing of the value", () => {
  const value = made(16);
  const words = C.noticeWords([{ id: "password", name: "Password or Secret", matches: [value] }]);
  assert.equal(words.items.length, 1);
  assert.match(words.items[0], /^Password or Secret \(•+\)$/);
});

test("ClotrHost check: a password shows no characters in its preview or its words, a phone at most a quarter", () => {
  const context = vm.createContext({});
  vm.runInContext(build().text, context, { filename: "clotr-engine.js" });
  const call = (method, ...args) => {
    const answer = JSON.parse(vm.runInContext("ClotrHost.call", context)(JSON.stringify({ method, args })));
    if (answer.error) throw new Error(`${method}: ${answer.error}`);
    return answer.result;
  };
  call("init", { salt: "0123456789abcdef0123456789abcdef", responses: {}, appModes: {}, pausedApps: {} });
  const r = call("check", "my password is Hq7#vLp2xR9m and call me at 555-555-0187", { app: "chatgpt" });
  const pw = r.findings.find((f) => f.type === "password");
  const phone = r.findings.find((f) => f.type === "phone_number");
  assert.ok(pw && phone, JSON.stringify(r.findings.map((f) => f.type)));
  assert.equal(shownOf(pw.preview), 0, pw.preview);
  assert.ok(shownOf(phone.preview) <= 3, phone.preview);
  const pwItem = r.words.items.find((item) => item.startsWith("Password or Secret ("));
  const phoneItem = r.words.items.find((item) => item.startsWith("Phone"));
  assert.ok(pwItem && phoneItem, JSON.stringify(r.words.items));
  assert.equal(pwItem, `Password or Secret (${pw.preview})`);
  assert.ok(phoneItem.endsWith(`(${phone.preview})`), phoneItem);
});

// Each caller has the finding's kind beside the value, and passes it along.
const CALLERS = [
  ...require("./load-engine.js")
    .files("decide")
    .map((file) => `extension/${file}`),
  "extension/clotr-pages/look-back/chat-export-reader.js",
  "extension/page-parts/practice-warning.js",
  "extension/clotr-pages/practice/practice.js",
  "extension/clotr-pages/office-training/office-training.js",
  "extension/on-websites/warning-ui.js",
  "apps/engine/host.js",
];

test("every caller of mask passes the value's kind as well", () => {
  for (const file of CALLERS) {
    const code = fs
      .readFileSync(path.join(ROOT, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    const calls = code.match(/(?<!function )\bmask\((?:[^()]|\([^()]*\))*\)/g) || [];
    const bare = calls.filter((c) => !/,/.test(c));
    assert.deepEqual(bare, [], `${file} calls mask with the value alone`);
    assert.doesNotMatch(code, /\.map\(mask\)/, `${file} hands map's index to mask`);
  }
});
