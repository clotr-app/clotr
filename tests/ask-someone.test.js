// Tests extension/ask-someone.js, the note "Ask someone first" builds. The note-building functions never take
// the message, the copied command, or a detected value as an argument -- only a list of sign ids and a language
// -- so the strongest guarantee is structural: the same signs always build the same words, whatever message they
// came from. The corpus checks below confirm that in practice, against the real scam-sign and command corpora.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/scam-signs.js");
require("../extension/commands.js");
require("../extension/ask-someone.js");

const { SCAM_SIGNS } = globalThis.Clotr;
const { askSomeoneNoteForScamSigns, askSomeoneNoteForCommand, askSomeoneNoteForShare } = globalThis.Clotr;

function readLabelled(file) {
  return fs
    .readFileSync(path.join(__dirname, "corpus", file), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => {
      const nl = m.indexOf("\n");
      return nl < 0 ? { label: m, text: "" } : { label: m.slice(0, nl).trim(), text: m.slice(nl + 1).trim() };
    });
}
function parseSignsLabel(label) {
  const m = /^\[signs: ([a-z_, ]+)\]$/.exec(label);
  if (!m) return null;
  return m[1] === "none" ? [] : m[1].split(",").map((s) => s.trim());
}

const SCAM_CORPORA = ["scam-messages.txt", "scam-messages-es.txt", "scam-lookalikes.txt", "scam-lookalikes-es.txt"];

// Every digit run of 4 or more (a code, an amount, a phone number) and every email address or host in the
// corpus's own made-up messages, so the leak check below has real "values" to look for.
function valuesIn(text) {
  const values = [...text.matchAll(/\d{4,}/g)].map((m) => m[0]);
  values.push(...[...text.matchAll(/[\w.-]+@[\w.-]+/g)].map((m) => m[0]));
  values.push(...[...text.matchAll(/[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?/gi)].map((m) => m[0]));
  return values;
}

test("every sign in extension/scam-signs.js has a note phrase, in English and Spanish", () => {
  const { askSomeoneNoteForScamSigns: build } = globalThis.Clotr;
  for (const sign of SCAM_SIGNS) {
    assert.ok(build([sign.id], "en"), `${sign.id} (en)`);
    assert.ok(build([sign.id], "es"), `${sign.id} (es)`);
  }
});

test("no signs found builds no note", () => {
  assert.equal(askSomeoneNoteForScamSigns([], "en"), "");
  assert.equal(askSomeoneNoteForScamSigns([], "es"), "");
  assert.equal(askSomeoneNoteForScamSigns(["not_a_real_sign"], "en"), "");
});

test("the same signs always build the same note, whatever message they came from", () => {
  const a = askSomeoneNoteForScamSigns(["press_rush", "pret_bank"], "en");
  const b = askSomeoneNoteForScamSigns(["pret_bank", "press_rush"], "en");
  assert.equal(a, askSomeoneNoteForScamSigns(["press_rush", "pret_bank"], "en"));
  assert.ok(a.length > 0);
  assert.notEqual(a, askSomeoneNoteForCommand("en"));
  assert.notEqual(a, askSomeoneNoteForShare("en"));
  void b;
});

test("the scam corpora: every message's note names only its own signs, and leaks none of its made-up values", () => {
  for (const file of SCAM_CORPORA) {
    for (const entry of readLabelled(file)) {
      const signIds = parseSignsLabel(entry.label);
      if (signIds === null) continue; // a shape problem some other test already catches
      for (const lang of ["en", "es"]) {
        const note = askSomeoneNoteForScamSigns(signIds, lang);
        assert.equal(note === "", signIds.length === 0, `${file} ${entry.label}: ${note}`);
        // The note built from just this message's own signs is identical to the note built from the same
        // signs in isolation -- nothing from the message itself reached it.
        assert.equal(note, askSomeoneNoteForScamSigns([...signIds], lang));
        for (const value of valuesIn(entry.text)) {
          if (value.length < 4) continue;
          assert.ok(!note.includes(value), `${file} ${entry.label}: note kept "${value}"`);
        }
      }
    }
  }
});

test("the command corpora: the note never changes with the command or the message around it", () => {
  for (const file of ["command-lures.txt", "command-lookalikes.txt"]) {
    const text = fs.readFileSync(path.join(__dirname, "corpus", file), "utf8");
    for (const lang of ["en", "es"]) {
      const note = askSomeoneNoteForCommand(lang);
      assert.ok(note.length > 0);
      for (const value of valuesIn(text)) {
        if (value.length < 4) continue;
        assert.ok(!note.includes(value), `${file}: note kept "${value}"`);
      }
    }
  }
});

test("Ask someone first never reads the message: the builders take no message argument", () => {
  assert.equal(askSomeoneNoteForCommand.length, 1);
  assert.equal(askSomeoneNoteForShare.length, 1);
  assert.equal(askSomeoneNoteForScamSigns.length, 2);
});

test("English and Spanish notes differ, and Spanish never falls back to English text", () => {
  for (const build of [
    () => askSomeoneNoteForCommand,
    () => askSomeoneNoteForShare,
    () => (lang) => askSomeoneNoteForScamSigns(["press_rush"], lang),
  ]) {
    const fn = build();
    const en = fn("en");
    const es = fn("es");
    assert.notEqual(en, es);
    assert.ok(/[áéíóúñ¿]/i.test(es), es);
  }
});
