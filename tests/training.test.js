// Tests for the office training walkthrough's content and logic in training-data.js, without loading the page
// itself. Every "what Clotr finds" moment reuses the practice drills' own ids and runs the real engine, so a
// change to either one fails here first. training-data.js resolves every string lazily, only calling msg() when
// it's invoked rather than when the module loads, so these tests switch languages with withLang() around each
// call instead of reloading the module per language.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const ES = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));

require("../extension/patterns.js");
require("../extension/detector.js");
const { detect } = globalThis.Clotr;
require("../extension/practice-data.js");
const { practice } = globalThis.Clotr;
require("../extension/training-data.js");
const t = globalThis.Clotr.training;

// Stands in for chrome.i18n, built from the Spanish messages file, the same way patterns.test.js and
// practice.test.js do.
function spanish(key, subs = []) {
  const m = ES[key];
  if (!m) return "";
  return m.message
    .replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const n = Number(/^\$(\d)$/.exec(m.placeholders[name].content)[1]);
      return subs[n - 1] ?? "";
    })
    .replace(/\$\$|\$(\d)/g, (full, n) => (full === "$$" ? "$" : (subs[n - 1] ?? "")));
}

// Runs fn() with chrome.i18n swapped for the given language, as the real extension page would see it.
function withLang(lang, fn) {
  const before = globalThis.chrome;
  globalThis.chrome = lang === "es" ? { i18n: { getMessage: spanish } } : undefined;
  try {
    return fn();
  } finally {
    globalThis.chrome = before;
  }
}
const LANGS = ["en", "es"];

// ---------- isTaxMode ----------

test("isTaxMode: the tax_office preset or ?for=tax turns tax mode on; client_names no longer does", () => {
  assert.equal(t.isTaxMode({ policyPreset: "tax_office" }), true);
  assert.equal(t.isTaxMode({ forParam: "tax" }), true);
  assert.equal(t.isTaxMode({ policyPreset: "tax_office", forParam: "tax" }), true);
  assert.equal(t.isTaxMode({}), false);
  assert.equal(t.isTaxMode({ policyPreset: "everyday" }), false);
  assert.equal(t.isTaxMode({ policyPreset: "client_names" }), false, "the tax kit has its own preset now");
  assert.equal(t.isTaxMode({ forParam: "something-else" }), false);
  assert.equal(t.isTaxMode(), false);
});

// ---------- Step 1: Why ----------

test("whyLines: the IRS line only in tax mode, with its source and link; both languages say something, and Spanish differs from English", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      const neutral = t.whyLines(false);
      assert.equal(neutral.source, null);
      assert.equal(neutral.href, null);
      assert.equal(neutral.lines.length, 2);
      assert.ok(neutral.lines.every((l) => l.length > 0));

      const tax = t.whyLines(true);
      assert.equal(tax.lines.length, 2);
      assert.match(tax.source, /Office of Professional Responsibility|Responsabilidad Profesional/);
      assert.match(tax.href, /^https:\/\/www\.irs\.gov\//);
    });
  }
  const en = withLang("en", () => t.whyLines(false));
  const es = withLang("es", () => t.whyLines(false));
  assert.notEqual(es.lines[0], en.lines[0]);
  const enTax = withLang("en", () => t.whyLines(true));
  const esTax = withLang("es", () => t.whyLines(true));
  assert.notEqual(esTax.lines[0], enTax.lines[0]);
});

// ---------- Step 2: Try it ----------

test("the try-it number is the Social Security Administration's own never-issued example, and detect() finds it as a us_ssn", () => {
  assert.equal(t.TRY_NUMBER, "219-09-9999");
  const found = detect(t.TRY_NUMBER);
  assert.deepEqual(
    found.map((r) => r.id),
    ["us_ssn"],
  );
  assert.deepEqual(found[0].matches, [t.TRY_NUMBER]);
});

// Typing the Try It number without dashes used to find nothing. A bare 9-digit number with nothing else in the
// message now counts as an SSN, so the walkthrough catches the very slip it's meant to teach against.
test("the try-it number typed without dashes is still caught as a us_ssn", () => {
  const bare = t.TRY_NUMBER.replace(/-/g, "");
  assert.equal(bare, "219099999");
  const found = detect(bare);
  assert.deepEqual(
    found.map((r) => r.id),
    ["us_ssn"],
  );
  assert.deepEqual(found[0].matches, [bare]);
});

test("tryInstruction, tryScript and tryAiReply: tax wording only changes the instruction, never echoes the number back, and Spanish differs from English", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      const plain = t.tryInstruction(false);
      const tax = t.tryInstruction(true);
      assert.ok(plain.includes(t.TRY_NUMBER));
      assert.ok(tax.includes(t.TRY_NUMBER));
      assert.notEqual(plain, tax);
      assert.ok(t.tryScript().includes(t.TRY_NUMBER));
      assert.ok(!t.tryAiReply().includes(t.TRY_NUMBER), `${lang}: the pretend reply must never echo the number`);
    });
  }
  assert.notEqual(
    withLang("es", () => t.tryInstruction(false)),
    withLang("en", () => t.tryInstruction(false)),
  );
  assert.notEqual(
    withLang("es", () => t.tryAiReply()),
    withLang("en", () => t.tryAiReply()),
  );
});

// ---------- Step 3: Your office's words ----------

test("officeWordsDemo: no policy kinds explains what an office can add, never a real word", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      const demo = t.officeWordsDemo([]);
      assert.equal(demo.active, false);
      assert.ok(demo.example.length > 0);
      assert.equal(demo.kinds, undefined);
    });
  }
});

test("officeWordsDemo: with kinds, only names, counts and responses are shown, never a word or format", () => {
  const kinds = [
    { id: "a", name: "Client file numbers", response: "block", words: ["super-secret-word"], formats: ["\\d{6}"] },
    { id: "b", name: "Matter codes", response: "log", words: ["another-secret"], formats: [] },
    { id: "c", name: "Extra one", response: "warn", words: [], formats: [] },
    { id: "d", name: "A fourth, dropped by the top-3 limit", response: "warn", words: [], formats: [] },
  ];
  for (const lang of LANGS) {
    withLang(lang, () => {
      const demo = t.officeWordsDemo(kinds);
      assert.equal(demo.active, true);
      assert.equal(demo.kinds.length, 3, "at most 3 shown");
      assert.deepEqual(
        demo.kinds.map((k) => k.name),
        ["Client file numbers", "Matter codes", "Extra one"],
      );
      const dump = JSON.stringify(demo);
      assert.doesNotMatch(
        dump,
        /super-secret-word|another-secret|\\\\d\{6\}/,
        "no real word or format leaks into the demo",
      );
      assert.ok(demo.example.length > 0);
    });
  }
});

// ---------- Step 4: Spot the leak ----------

test("leakPicks: the five chosen ids exist in the practice drills' own Spot-the-leak set, and detect() matches what each drill lists", () => {
  const picks = t.leakPicks(practice.leaks);
  assert.equal(picks.length, 5);
  assert.deepEqual(picks.map((l) => l.id).sort(), [...t.LEAK_IDS].sort());
  for (const l of picks) {
    assert.deepEqual(
      detect(l.text)
        .map((r) => r.id)
        .sort(),
      [...l.finds].sort(),
      `${l.id}: detect() must match what the drill lists`,
    );
  }
});

test("leakPicks: a missing or non-array leaks list is handled without throwing", () => {
  assert.deepEqual(t.leakPicks([]), []);
  assert.deepEqual(t.leakPicks(undefined), []);
});

// ---------- Step 5: the AI-tool checklist ----------

test("CHECKLIST: three plain questions with a hint, no links (Privacy Check-up isn't built), text in both languages", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      assert.equal(t.CHECKLIST.length, 3);
      for (const item of t.CHECKLIST) {
        assert.ok(item.q().length > 0);
        assert.ok(item.hint().length > 0);
        assert.doesNotMatch(item.q(), /<a |href=/i);
        assert.doesNotMatch(item.hint(), /<a |href=/i);
      }
    });
  }
  for (const [i, item] of t.CHECKLIST.entries()) {
    assert.notEqual(
      withLang("es", () => item.q()),
      withLang("en", () => item.q()),
      `checklist item ${i}`,
    );
  }
});

// ---------- Step 6: Check AI's work ----------

test("accuracyCheck: the stated figure and citation appear in the answer text, and the real total differs from the stated one, in both modes and languages", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      for (const tax of [false, true]) {
        const c = t.accuracyCheck(tax);
        assert.ok(c.answer.includes(c.figureText), `${lang} tax=${tax}: the wrong figure appears in the answer text`);
        assert.ok(
          c.answer.includes(c.citationText),
          `${lang} tax=${tax}: the invented citation appears in the answer text`,
        );
        assert.notEqual(c.figureText, c.correctFigure, "the flagged figure must differ from the real total");
        assert.ok(c.explain.length > 0);
      }
    });
  }
});

test("accuracyCheck: the neutral example's arithmetic is actually wrong (23, not 42) and the tax example's is too (5, not 6)", () => {
  const neutral = t.accuracyCheck(false);
  assert.equal(neutral.figureText, "42");
  assert.match(neutral.correctFigure, /^23\b/);
  const tax = t.accuracyCheck(true);
  assert.equal(tax.figureText, "6");
  // correctFigure reads like "5 (3 W-2s + 2 1099s)", so this splits on the parenthesized "+" and reads each
  // side's leading number, which keeps a digit inside a label like "W-2" from being mistaken for one of the two
  // real counts.
  const inner = /\(([^)]*)\)/.exec(tax.correctFigure)?.[1];
  assert.ok(inner, `correctFigure should parenthesize what it adds: "${tax.correctFigure}"`);
  const sides = inner.split("+").map((s) => /^\s*(\d+)/.exec(s)?.[1]);
  assert.ok(sides.every(Boolean), `each side of the sum should start with a number: "${inner}"`);
  const sum = sides.reduce((n, s) => n + Number(s), 0);
  assert.equal(sum, 5);
  assert.notEqual(sum, 6);
});

test("accuracyCheck: right-as-written decoys sit beside the two wrong parts, so the clickable ones don't give the answer away", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      for (const tax of [false, true]) {
        const c = t.accuracyCheck(tax);
        const where = `${lang} tax=${tax}`;
        assert.ok(c.decoys.length >= 3, `${where}: at least three decoys`);
        assert.ok(
          c.decoys.some((d) => !/^\d+$/.test(d)),
          `${where}: a decoy that isn't a number, beside the citation`,
        );
        for (const d of c.decoys) {
          assert.ok(t.findTarget(c.answer, d) >= 0, `${where}: decoy "${d}" stands on its own in the answer`);
          assert.ok(d !== c.figureText && d !== c.citationText, `${where}: "${d}" isn't one of the wrong parts`);
        }
      }
    });
  }
});

test("findTarget: a number decoy matches only a number standing on its own, never inside W-2, a year or a section", () => {
  const s = "Your client has 3 W-2 forms and 2 1099 forms, per IRC §6724(d)(3), section 4.2 of 2024.";
  assert.equal(t.findTarget(s, "3"), s.indexOf("3 W-2"));
  assert.equal(t.findTarget(s, "2"), s.indexOf("2 1099"));
  assert.equal(t.findTarget(s, "24"), -1);
  assert.equal(t.findTarget(s, "4"), -1);
  assert.equal(t.findTarget("so 42 people", "the usual"), -1);
  assert.equal(t.findTarget("matches the usual rate", "the usual rate"), "matches ".length);
});

// ---------- Step 7: the check ----------

test("quizQuestions: five questions, each with exactly one correct option and a non-empty explanation, in both modes and languages", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      for (const tax of [false, true]) {
        const qs = t.quizQuestions(tax);
        assert.equal(qs.length, 5);
        for (const q of qs) {
          assert.ok(q.q().length > 0, `${lang} ${q.id}: question text`);
          assert.equal(q.options.length, 3, `${lang} ${q.id}: three options`);
          const correct = q.options.filter((o) => o.correct);
          assert.equal(correct.length, 1, `${lang} ${q.id}: exactly one correct option`);
          for (const o of q.options) assert.ok(o.text().length > 0, `${lang} ${q.id}.${o.id}: option text`);
          assert.ok(q.explain().length > 0, `${lang} ${q.id}: explanation text`);
        }
      }
    });
  }
});

test("quizQuestions: tax wording never puts a Social Security number or account number in a correct answer", () => {
  const qs = t.quizQuestions(true);
  const q1 = qs.find((q) => q.id === "q1");
  const correctText = q1.options.find((o) => o.correct).text();
  assert.doesNotMatch(correctText, /\d{3}-\d{2}-\d{4}|\d{9,}/);
});

test("scoreQuiz: counts only answers that match a real correct option id, out of the question list given", () => {
  const qs = t.quizQuestions(false);
  const correctAnswers = Object.fromEntries(qs.map((q) => [q.id, q.options.find((o) => o.correct).id]));
  assert.equal(t.scoreQuiz(qs, correctAnswers), 5);
  assert.equal(t.scoreQuiz(qs, {}), 0, "no answers at all");
  assert.equal(t.scoreQuiz(qs, { q1: "not-a-real-option" }), 0, "an answer id that doesn't exist");
  const oneWrong = { ...correctAnswers, q1: qs[0].options.find((o) => !o.correct).id };
  assert.equal(t.scoreQuiz(qs, oneWrong), 4);
});

// ---------- Step titles ----------

test("STEP_TITLES: eight non-empty titles, in order, and Spanish differs from English", () => {
  for (const lang of LANGS) {
    withLang(lang, () => {
      assert.equal(t.STEP_TITLES.length, 8);
      assert.ok(t.STEP_TITLES.every((f) => f().length > 0));
    });
  }
  const enTitles = withLang("en", () => t.STEP_TITLES.map((f) => f()));
  const esTitles = withLang("es", () => t.STEP_TITLES.map((f) => f()));
  assert.notDeepEqual(esTitles, enTitles);
});

// ---------- Nothing in the training page can be a real person's detail, and nothing is stored, sent or fetched ----------

test("the training page loads only Clotr's own scripts and never stores, sends or fetches anything", () => {
  const html = fs.readFileSync(path.join(EXT, "training.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 4, "the page's scripts");
  for (const [, attrs, body] of scripts) {
    const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
    assert.ok(src && /^[a-z0-9-]+\.js$/.test(src), `a script that isn't one of Clotr's files: ${attrs}`);
    assert.ok(fs.existsSync(path.join(EXT, src)), `${src} isn't in the extension`);
    assert.equal(body.trim(), "", "no inline script");
  }
  assert.doesNotMatch(html, /\b(src|href)="(https?:)?\/\//, "nothing from elsewhere");
  assert.doesNotMatch(html, /\binnerHTML\b/);
  const own = ["training.js", "training-data.js"].map((f) =>
    fs
      .readFileSync(path.join(EXT, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n"),
  );
  for (const code of own) {
    assert.doesNotMatch(code, /storage\.\w+\.(set|remove|clear)|sendMessage|connect\(|fetch\(|XMLHttpRequest/);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.\w+\(/);
    assert.doesNotMatch(code, /\binnerHTML\s*=/);
  }
});

// Checks the walkthrough doesn't claim certification, or print a raw "safe" or "compliant" verdict about Clotr.
test("training.js and its Spanish strings never say the walkthrough is 'certified'", () => {
  const js = fs.readFileSync(path.join(EXT, "training.js"), "utf8");
  assert.doesNotMatch(js, /certif/i);
  for (const [key, entry] of Object.entries(ES)) {
    if (key.startsWith("tw_")) assert.doesNotMatch(entry.message, /certific/i, key);
  }
});
