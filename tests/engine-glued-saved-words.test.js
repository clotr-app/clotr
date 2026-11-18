// The host's Hide it hides a saved word glued to a digit ("Acme2") or inside a script written without spaces
// (Chinese, Japanese, Thai), as 1.6.1's host did, and still leaves a Latin word inside a longer one ("Maine").
// Run from the repo root: node --test tests/engine-glued-saved-words.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
require("../extension/backup.js");
require("../apps/engine/host.js");

const C = globalThis.Clotr;
const H = globalThis.ClotrHost;
const SALT = "0123456789abcdef0123456789abcdef";

// The word saved today, and the way 1.6.1's vault page saved it.
const entries = (word) => [
  C.wordEntry(SALT, "my_name", word),
  { kind: "word", type: "watch_list", fp: C.fingerprint(SALT, "watch_list", word), words: 1 },
];

// The text after the host's Hide it on every detail it found, with `entry` the only saved word.
function hideAll(entry, text) {
  H.init({ salt: SALT, vault: [entry] });
  try {
    const { findings } = H.check(text, { app: "chatgpt" });
    return H.redact(
      text,
      findings.map((f) => f.id),
    );
  } finally {
    H.init({ salt: SALT, vault: [] });
  }
}

// Each [saved word, the copy it sits in]. The word also stands alone once, so it's found.
const GLUED = [
  ["王伟", "我是王伟的同事"],
  ["Mai", "私はMaiです"],
  ["สมชาย", "ผมชื่อสมชายครับ"],
  ["Acme", "Acme2"],
];

test("a saved word glued to a digit or inside Chinese, Japanese or Thai is hidden there too", () => {
  const left = [];
  for (const [word, glued] of GLUED) {
    for (const text of [`${word} said: ${glued}`, `${glued} ${word}`]) {
      for (const entry of entries(word)) {
        const hidden = hideAll(entry, text);
        if (hidden.includes(word)) left.push(`${entry.type} ${JSON.stringify(text)} -> ${JSON.stringify(hidden)}`);
      }
    }
  }
  assert.deepEqual(left, []);
});

test("a saved word inside Chinese, Japanese or Thai is hidden when it's the only copy", () => {
  for (const [word, glued] of GLUED.slice(0, 3)) {
    const hidden = hideAll(C.wordEntry(SALT, "my_name", word), glued);
    assert.ok(!hidden.includes(word), `${word} still shows in ${JSON.stringify(hidden)}`);
  }
});

test("a saved Latin word inside a longer Latin word still stays showing", () => {
  for (const entry of entries("Mai")) {
    for (const text of ["Mai said: Maine", "Maine Mai"]) {
      const hidden = hideAll(entry, text);
      assert.ok(hidden.includes("Maine"), `Maine was changed in ${JSON.stringify(hidden)}`);
      assert.equal(
        hidden.split("Mai").length - 1,
        1,
        `the word Mai on its own still shows in ${JSON.stringify(hidden)}`,
      );
    }
  }
});

// A word ending in a vowel sign, saved the way 1.6.1's vault page saved it (no count of steps), as its only copy,
// glued to the text after it (or, in the last, before it). 1.6.1 hid the letters before the vowel sign there.
const MARK_END = [
  ["มาลี", "มาลีมาแล้ว"],
  ["มาลี", "ok มาลีมาแล้ว"],
  ["ນາລີ", "ນາລີມາແລ້ວ"],
  ["ນາລີ", "ok ນາລີມາແລ້ວ"],
  ["မိုး", "မိုးရောက်ပြီ"],
  ["မိုး", "ok မိုးရောက်ပြီ"],
  ["မိုး", "ရောက်ပြီမိုး"],
];

test("an old saved word ending in a vowel sign is hidden whole when glued in Thai, Lao or Myanmar", () => {
  const wrong = [];
  for (const [word, text] of MARK_END) {
    const entry = { kind: "word", type: "my_name", fp: C.fingerprint(SALT, "watch_list", word), words: 1 };
    const hidden = hideAll(entry, text);
    const want = text.replace(word, "[REDACTED YOUR NAME]");
    if (hidden !== want) wrong.push(`${JSON.stringify(text)} -> ${JSON.stringify(hidden)}`);
  }
  assert.deepEqual(wrong, []);
});
