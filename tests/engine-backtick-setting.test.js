// A setting written in inline code in a sentence, like "Set `secret: true` on it", names a setting and its
// value, not a password. A real password in backticks is still caught, with the closing backticks left out.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect } = globalThis.Clotr;

const passwordFinding = (text) => detect(text).find((result) => result.id === "password");

// Made-up code sentences where the label's value is a setting word.
const SETTINGS = [
  "Set `secret: true` on the input so the form hides it.",
  "The job gets `id-token: write` so it can sign in.",
  "Mark the field `password: required` in the schema.",
  "Use `token: auto` when the runner should pick one.",
  "Set `secret: false` on the input.",
  "Set `password: optional` in the schema.",
  "Use `token: none` here.",
  "Mark it `api_key: required` in the form.",
  "Give the job `id-token: read` too.",
  "Use `passwd: auto` for now.",
  "Set ``secret: true`` on it.",
  "Set ```secret: true``` on it.",
  '`"secret": true` hides it.',
  "Set `app.secret: true` on it.",
  "The step needs `contents: read` and `id-token: write` to run.",
  "Set `secret=true` on the input.",
  "Use `token: auto`, then run it.",
  "Use `token: auto`.",
  "Is it `token: auto`?",
  'Set `password: "required"` in it.',
  "Set `secret: 'true'` in it.",
  'Set `"secret": "true"` in it.',
  "Set `client_secret: auto` here.",
  "Use `GITHUB_TOKEN: write` in the job.",
  "> Set `secret: true` on the input.",
];

for (const text of SETTINGS) {
  test(`a setting in backticks is not a password: ${text}`, () => {
    assert.equal(passwordFinding(text), undefined);
  });
}

// Made-up passwords in backticks, each caught with the kind and severity it had before, and the value as found.
const PASSWORDS = [
  ["`password: Plum7!Kettle9`", "password", "Plum7!Kettle9"],
  ["Set `secret: Qx7vB2mN9pLr4tW` in the env file.", "password", "Qx7vB2mN9pLr4tW"],
  ["Use `token: hT4kP9wQ2zR7xL1m` for the runner.", "password", "hT4kP9wQ2zR7xL1m"],
  ["`api_key: Zr8Kq2Lw9Vx4Np7T` goes in the header.", "service_token", "Zr8Kq2Lw9Vx4Np7T"],
  ["The config has `passwd: Fern!Otter58` on line 3.", "password", "Fern!Otter58"],
  ["Put `DB_PASSWORD=Gl4ss#Harbor7` in your .env.", "password", "Gl4ss#Harbor7"],
  ["`db_password: Brisk*Maple306`", "password", "Brisk*Maple306"],
  ["```password: Moss9!Cinder4```", "password", "Moss9!Cinder4"],
  ["``secret: Vb6Np3Xq8Rw2Lk5``", "password", "Vb6Np3Xq8Rw2Lk5"],
  ["`app.secret: Jt5Rm8Yq2Ws7Nb4`", "password", "Jt5Rm8Yq2Ws7Nb4"],
  ["```\nsecret: Hx3Lv8Qn2Pz6Wr9\n```", "password", "Hx3Lv8Qn2Pz6Wr9"],
  ['In YAML, `password: "Quill#Ember73"` is the field.', "password", "Quill#Ember73"],
  ['`"password": "Wren&Slate918"`', "password", "Wren&Slate918"],
  ["`password: Plum7!Kettle9`!", "password", "Plum7!Kettle9"],
  ["Set `pin: 4821` on the lock.", "password", "4821"],
  ["Set `secret: true` and `password: Plum7!Kettle9` in it.", "password", "Plum7!Kettle9"],
  ["my password is `Kz8#rWq2vLp`", "password", null],
  ["My password is `Tangerine$Lamp42`.", "password", null],
];

for (const [text, id, value] of PASSWORDS) {
  test(`a password in backticks is still caught: ${text}`, () => {
    const result = detect(text).find((r) => r.id === id);
    assert.ok(result, `no ${id} finding`);
    assert.equal(result.severity, "high");
    if (value) assert.deepEqual(result.matches, [value]);
  });
}

test("a backtick inside a password, not closing inline code, stays in the value", () => {
  const result = passwordFinding("password: Rv8`Lq3`Wn5");
  assert.ok(result);
  assert.ok(result.matches.some((match) => match.includes("`")));
});

// A 13 to 15 character key under a key label, written in inline code. The closing backticks still count toward
// the 16 characters the key reader asks for, as before inline code was read, but the key is found without them.
// Without backticks the same keys stay too short to read. Each value is made up and built from pieces.
const KEY_LABELS = [
  "private_key",
  "access_key",
  "signing_key",
  "encryption_key",
  "master_key",
  "client_key",
  "app_key",
  "license_key",
  "service_key",
];
const KEY_SOURCES = [
  ["Rq", "7v", "Lm", "2x", "Pz", "9k", "Wn", "4t", "Hb"].join(""),
  ["Plo", "ver#", "Tide", "83", "Kq", "7m"].join(""),
];

for (const label of KEY_LABELS) {
  for (const source of KEY_SOURCES) {
    for (let length = 13; length <= 15; length++) {
      const key = source.slice(0, length);
      for (let ticks = 0; ticks <= 3; ticks++) {
        const fence = "`".repeat(ticks);
        const text = `Set ${fence}${label}: ${key}${fence} here.`;
        const caught = length + ticks >= 16;
        test(`a ${length} character key under ${label} in ${ticks} backticks is ${caught ? "caught" : "quiet"}`, () => {
          const result = detect(text).find((r) => r.id === "service_token");
          if (!caught) {
            assert.equal(result, undefined);
            return;
          }
          assert.ok(result, "no service_token finding");
          assert.equal(result.severity, "high");
          assert.deepEqual(result.matches, [key]);
        });
      }
    }
  }
}

// A question mark after the inline code counts toward the key's length too, as it did before inline code was read.
// A full stop never did. Either way the key is found alone.
for (const [end, counts] of [
  ["?", 1],
  [".", 0],
]) {
  for (let length = 12; length <= 15; length++) {
    for (let ticks = 1; ticks <= 3; ticks++) {
      const key = KEY_SOURCES[0].slice(0, length);
      const fence = "`".repeat(ticks);
      const text = `Is it ${fence}signing_key: ${key}${fence}${end}`;
      const caught = length + ticks + counts >= 16;
      test(`a ${length} character key in ${ticks} backticks before "${end}" is ${caught ? "caught" : "quiet"}`, () => {
        const result = detect(text).find((r) => r.id === "service_token");
        if (!caught) {
          assert.equal(result, undefined);
          return;
        }
        assert.ok(result, "no service_token finding");
        assert.equal(result.severity, "high");
        assert.deepEqual(result.matches, [key]);
      });
    }
  }
}
