// The saved words' growth tests from tests/engine-vault-words.test.js, on a count of work (tests/work.js) instead of the
// clock. The meter keeps V8's block counting on, which slows the engine more on bigger input, so the clock tests stay
// in their own file. The vault's regexes are bounded or read one phrase at a time, so a slowdown there is a pass or a
// loop too many, which the count sees on any machine.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertWorkLinear, onWorkClock } = require("./work.js");
require("./load-engine.js")("rules", "detect", "decide");

const C = globalThis.Clotr;
const SALT = "s4lt";
const saved = (type, phrase) => C.wordEntry(SALT, type, phrase);

function withVault(entries, fn) {
  C.setVault({ salt: SALT, entries });
  try {
    fn();
  } finally {
    C.setVault(null);
  }
}

// patterns.js keeps the vault's finds for the last text it read, so setting the vault again drops them.
function detectAfresh(entries, text) {
  C.setVault({ salt: SALT, entries });
  return C.detect(text);
}

const assertLinear = (fn, makeInput, units, n) => assertWorkLinear(fn, makeInput, units, n, undefined, [__filename]);

test("vault words stay linear on long hostile text", () => {
  const bs = "\\";
  const entries = [
    saved("my_name", "Ann Lee Smith Jones"),
    saved("employer", "Acme Corp."),
    saved("my_name", "王小明"),
    saved("my_name", "@ann"),
  ];
  C.setVault({ salt: SALT, entries });
  try {
    // Each unit is repeated to about 2.5 KB and 10 KB, inside one of detect()'s windows.
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      [
        "a&",
        "Ann.",
        "a.!+",
        `${bs}nAnn `,
        "我叫王小明",
        "ก่",
        "e\u0301",
        "a\u0301\u0301\u0301",
        "a-",
        "a_b.",
        "%20a",
        `${bs}u0041`,
        "%C3%A9",
        "@a ",
        "Corp ",
        "a+",
        "Ann社",
      ],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("300 KB of Chinese or Japanese with saved words is scanned whole: a word and an email at the end are found", () => {
  const email = ["bob.jones", "example.com"].join("@");
  const entries = [saved("employer", "Acme"), saved("my_name", "王小明"), saved("employer", "株式会社日立製作所")];
  for (const unit of ["今日はとても良い天気ですね。", "我们今天去公园散步然后吃饭"]) {
    const text = `${unit.repeat(Math.ceil(100_000 / unit.length))}我叫王小明。${email}`;
    assert.ok(new TextEncoder().encode(text).length >= 300_000);
    withVault(entries, () => {
      C.detect.forget();
      // On the stand-in clock, so only too much reading can cut the scan short, never a busy machine.
      const found = onWorkClock(() => C.detect(text));
      assert.ok(!found.truncated, "scan cut short");
      assert.ok(found.some((r) => r.id === "email"));
      assert.ok(found.some((r) => r.id === "my_name" && r.matches.includes("王小明")));
    });
  }
  withVault(entries, () =>
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["今日はとても良い天気ですね。", "我们今天去公园散步然后吃饭", "a社", "王小明a"],
      25_000,
    ),
  );
});

test("reading entities and tags for vault words stays linear on long hostile text", () => {
  const entries = [saved("my_name", "Ann Lee Smith Jones"), saved("my_name", "王小明")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["<a", "<a ", "<b>Ann", "&nbsp;", "&#1234567", "&#x41;", "&eacute;a", "&abcdefgh", "a<b&&c>", "<王>"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading the pieces of joined words for vault words stays linear on long hostile text", () => {
  const entries = [saved("my_name", "Ann Lee Smith Jones"), saved("employer", "Initech")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["aB", "a1", "a_", "a.b1C", "Ann", "1a-", "x'Y", "éB"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("looking for saved ID formats in escaped text stays linear on long hostile text", () => {
  const entries = [
    { kind: "shape", type: "my_id", shape: "@@-####" },
    { kind: "shape", type: "my_id", shape: "### ### ###" },
    { kind: "shape", type: "my_id", shape: "@@ ####", near: ["case"] },
  ];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["%22AB-1234", "AB%201234 ", "1+", "%201", "case AB+12", "<b>1 ", "&nbsp;12"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading a space or a middle dot inside a saved Chinese, Japanese or Korean name stays linear", () => {
  const entries = [saved("my_name", "山田 太郎"), saved("my_name", "ジョン・スミス"), saved("my_name", "Ann Lee")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["山 ", "ジ・", "山・ ", "김 ", "a・", "・ ", "山田 太郎・"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading apostrophes inside saved words stays linear on long hostile text", () => {
  const entries = [saved("my_name", "O'Brien Lee"), saved("employer", "Shell")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["a'", "O'B", "a'll", "a`", "a´b ", "'"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading marks between saved words stays linear on long hostile text", () => {
  const entries = [saved("my_name", "Ann Lee Smith Jones"), saved("my_name", "Bo Li")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["a**", "a,", "Ann/", "*a* ", "a. ", "a|||||", "Bo,Li,", "a!?.,;"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading text in the wrong encoding stays linear on long hostile text", () => {
  const entries = [saved("my_name", "José García Lee Ann"), saved("my_name", "Zoë")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["Ã©", "Ã", "Ãa", "â€™", "ð", "Â©Â", "é’", "Ã©a "],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});

test("reading Korean particles after a saved name stays linear on long hostile text", () => {
  const entries = [saved("my_name", "김민수"), saved("my_name", "이준")];
  C.setVault({ salt: SALT, entries });
  try {
    assertLinear(
      (text) => detectAfresh(entries, text),
      (u, n) => u.repeat(Math.ceil(n / u.length)),
      ["이나", "김 민수가", "이 ", "가", "이 준이나"],
      2500,
    );
  } finally {
    C.setVault(null);
  }
});
