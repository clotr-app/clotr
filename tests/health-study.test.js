// These are the test messages that will judge a future health-detail kind before it's built. Clotr should only
// speak up about health when the same message also says who the person is: a name, a birthday, an address, an ID
// number, a phone number or an email. There are two corpora, each in English and Spanish:
// - quiet (tests/corpus/health-quiet*.txt): health questions, essays, other people's health, and someone's own or
//   family health with nothing that says who they are. None of these should ever warn as a health detail.
// - warn (tests/corpus/health-warn*.txt): a health term said about a person, with who that person is. Each label
//   names the term and the kinds of "who" the message gives.
// No health kind exists yet, so this file just checks the corpora are well formed and pins today's behavior: quiet
// messages warn about nothing, and in warn messages only the identity parts warn.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");

// Calls the extension's detect() and reshapes the result to { patternId: [matched text, …] }, the same shape
// tests/patterns.test.js uses.
function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

// A corpus file holds comment lines, then messages separated by lines of "---".
function readMessages(file) {
  return fs
    .readFileSync(path.join(__dirname, "corpus", file), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Each health message starts with one label line, so this splits it into { label, text }.
function readLabelled(file) {
  return readMessages(file).map((m) => {
    const nl = m.indexOf("\n");
    return nl < 0 ? { label: m, text: "" } : { label: m.slice(0, nl).trim(), text: m.slice(nl + 1).trim() };
  });
}

const QUIET = ["health-quiet.txt", "health-quiet-es.txt"];
const WARN = ["health-warn.txt", "health-warn-es.txt"];
const COUNTS = {
  "health-quiet.txt": 400,
  "health-quiet-es.txt": 140,
  "health-warn.txt": 150,
  "health-warn-es.txt": 50,
};
const QUIET_LABELS = ["[question]", "[essay]", "[someone else]", "[own, no who]"];

// Who the person is can be a name introduced in the text, or a kind the detector already finds today.
const WHO_KINDS = [
  "date_of_birth",
  "street_address",
  "phone_number",
  "email",
  "us_ssn",
  "medical_record",
  "medicare_id",
  "insurance_id",
  "passport",
  "drivers_license",
  "national_id",
  "student_id",
];
const WHO = ["name", ...WHO_KINDS];

// "[term: type 2 diabetes | who: name, date_of_birth]"
const WARN_LABEL = /^\[term: ([^|\]]+?) \| who: ([a-z_, ]+)\]$/;
function parseWarnLabel(label) {
  const m = WARN_LABEL.exec(label);
  return m && { term: m[1], who: m[2].split(",").map((w) => w.trim()) };
}

// Accents and case don't hide a term or make a message new. For checking repeats, spacing doesn't either.
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const plain = (s) => fold(s).replace(/\s+/g, " ").trim();
const wordRe = (term) =>
  new RegExp(`(?<![\\p{L}\\d])${plain(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u");
const hasWord = (text, term) => wordRe(term).test(plain(text));

// A health term counts as near an anchor when it falls within six words after a verb said about a person ("I
// have", "I was diagnosed with", "my son has", "I take", "tengo", "me diagnosticaron") or a record's label
// ("Diagnosis:", "Medications:", "Diagnóstico:"). Every warn message is written so this check can find its term.
const ANCHOR = new RegExp(
  [
    String.raw`\b(?:have|has|had|'ve|got|get|gets|getting|take|takes|taking|took|uses?|using|diagnosed|diagnosis|treated|treating|treatment|living with|lives with|suffers?(?: from)?|suffering|recovering|recovery|history of|positive for|tested positive|pregnant|prescribed|started|starting|refills?|managing|manages|struggles? with|struggling with|dealing with|survivor|carrier|i'm|i am|she's|he's|she is|he is|we're|(?:is|was|been|are|still|now) on)\b`,
    String.raw`(?<![\p{L}])(?:tengo|tiene|tienes|tenes|tenemos|tienen|tuve|tuvo|padezco|padece|padecen|sufro|sufre|tomo|toma|tomando|tomaba|diagnosticaron|diagnosticad[oa]|diagnostico|vivo con|vive con|recetaron|receta|tratamiento|tratad[oa]|uso|usa|usando|positivo|positiva|embarazada|operaron|operad[oa]|antecedentes de|me detectaron|le detectaron|me encontraron|le encontraron|me salio|le salio|soy|estoy|esta)(?![\p{L}])`,
    // A label: "Diagnosis:", "Dx:", "Reason for visit:", "Medicamentos:"
    String.raw`(?<![\p{L}])\p{L}[\p{L}'#./-]*(?: \p{L}[\p{L}'#./-]*){0,3}:`,
  ].join("|"),
  "giu",
);
function termNearAnchor(text, term) {
  const t = fold(text);
  return [...t.matchAll(new RegExp(wordRe(term).source, "gu"))].some((hit) => {
    const before = t.slice(0, hit.index);
    return [...before.matchAll(ANCHOR)].some((m) => {
      const between = before.slice(m.index + m[0].length).trim();
      return between === "" || between.split(/\s+/).length <= 6;
    });
  });
}

// Matches a name introduced in the text: "my name is Ana Ruiz", "I'm Maria Lopez", a record's "Patient: Ruiz, Ana",
// a family member like "my daughter Ana Ruiz", or their Spanish equivalents. It looks for two capitalized words
// right after the introduction.
const CAP = "[A-ZÁÉÍÓÚÑÜ][\\p{L}'’.-]*";
const INTRODUCED_NAME = new RegExp(
  String.raw`(?:\b(?:my name is|name is|i'm|i am|this is|name|patient|pt|employee|student|member|insured|subscriber|resident|client|applicant|my (?:son|daughter|child|kid|mom|mother|dad|father|husband|wife|partner|grandson|granddaughter|grandmother|grandma|grandfather|grandpa|brother|sister|aunt|uncle|baby|stepson|stepdaughter))|(?<![\p{L}])(?:me llamo|mi nombre es|soy|nombre(?: completo)?|paciente|alumn[oa]|afiliad[oa]|asegurad[oa]|trabajador(?:a)?|mi (?:hij[oa]|mamá|madre|papá|padre|espos[oa]|marido|mujer|herman[oa]|abuel[oa]|niet[oa]|bebé|ti[oa]|pareja)))(?![\p{L}])(?:'s name)?\s*:?\s*(${CAP},?\s+${CAP})`,
  "giu",
);
// The introducing phrase can be in any case, but the two words after it must really be capitalized.
const nameIntroduced = (text) => [...text.matchAll(INTRODUCED_NAME)].some((m) => /^\p{Lu}\S*,?\s+\p{Lu}/u.test(m[1]));

// A quiet message that still wrongly warns today, while its fix waits, is listed here by the start of its text, the
// kinds it warns as, and an issue number ("#0" until one is opened). As with the everyday ratchet in
// tests/patterns.test.js, this list may only shrink: an entry whose message stops warning, or starts warning as
// different kinds, fails the test. The three messages that were wrongly flagged here (an NDC drug code read as a
// phone number, and two appointment times read as a street address) were fixed in 1.3.0, with regression tests in
// tests/patterns.test.js.
const ACCEPTED = {
  "health-quiet.txt": [],
  "health-quiet-es.txt": [],
};

// Finds what's wrong with messages that should warn about nothing today.
function quietProblems(msgs, accepted) {
  const warned = msgs.map((m) => [m, detect(m)]).filter(([, f]) => Object.keys(f).length);
  const problems = warned
    .filter(([m]) => !accepted.some((a) => a.message && m.startsWith(a.message)))
    .map(([m, f]) => `wrong warning ${JSON.stringify(Object.keys(f))} ← ${m.slice(0, 80)}`);
  for (const a of accepted) {
    const named = msgs.filter((m) => a.message && m.startsWith(a.message));
    const found = named.length === 1 && warned.find(([m]) => m === named[0]);
    if (named.length !== 1) problems.push(`ACCEPTED must name one message (${named.length} start "${a.message}")`);
    else if (!found) problems.push(`no longer warns, take it out of ACCEPTED: "${a.message}" (${a.issue})`);
    else if (JSON.stringify(Object.keys(found[1]).sort()) !== JSON.stringify([...(a.kinds || [])].sort()))
      problems.push(`warns as ${JSON.stringify(Object.keys(found[1]))}, not as listed: "${a.message}"`);
    if (!/^#\d+$/.test(a.issue || "")) problems.push(`ACCEPTED needs an issue number: "${a.message}"`);
  }
  return problems;
}

test("the health corpora have their sizes", () => {
  for (const [file, n] of Object.entries(COUNTS)) assert.equal(readLabelled(file).length, n, file);
  const own = (file) => readLabelled(file).filter((m) => m.label === "[own, no who]").length;
  assert.equal(own("health-quiet.txt"), 100, "health-quiet.txt: [own, no who]");
  // In Spanish, the mix is the same, with about a quarter being own health.
  assert.ok(own("health-quiet-es.txt") >= 30 && own("health-quiet-es.txt") <= 40, "health-quiet-es.txt: [own, no who]");
});

test("every quiet message has a known label, and each file has all four", () => {
  for (const file of QUIET) {
    const msgs = readLabelled(file);
    assert.deepEqual(
      msgs.filter((m) => !QUIET_LABELS.includes(m.label) || !m.text).map((m) => m.label + " " + m.text.slice(0, 60)),
      [],
      file,
    );
    for (const label of QUIET_LABELS)
      assert.ok(msgs.filter((m) => m.label === label).length >= 10, `${file}: too few ${label}`);
  }
});

test("every warn label parses, its term is in the message near an anchor, and its who values are known", () => {
  for (const file of WARN) {
    const problems = [];
    for (const { label, text } of readLabelled(file)) {
      const l = parseWarnLabel(label);
      if (!l || !text) {
        problems.push(`bad label: ${label}`);
        continue;
      }
      if (!hasWord(text, l.term)) problems.push(`term "${l.term}" isn't in: ${text.slice(0, 60)}`);
      else if (!termNearAnchor(text, l.term))
        problems.push(`term "${l.term}" is far from an anchor: ${text.slice(0, 60)}`);
      const unknown = l.who.filter((w) => !WHO.includes(w));
      if (unknown.length || !l.who.length) problems.push(`unknown who ${JSON.stringify(unknown)}: ${label}`);
      if (new Set(l.who).size !== l.who.length) problems.push(`who repeats: ${label}`);
      if (l.who.includes("name") && !nameIntroduced(text)) problems.push(`no introduced name: ${text.slice(0, 60)}`);
    }
    assert.deepEqual(problems, [], file);
  }
});

// A health kind must work with any one part of who the person is, and with several together.
test("the warn messages spread who they are: every kind often, each kind alone, and several together", () => {
  const whos = WARN.flatMap((f) => readLabelled(f).map((m) => parseWarnLabel(m.label)?.who || []));
  for (const w of WHO) {
    assert.ok(whos.filter((list) => list.includes(w)).length >= 5, `too few with ${w}`);
    assert.ok(
      whos.some((list) => list.length === 1 && list[0] === w),
      `no message with ${w} alone`,
    );
  }
  assert.ok(whos.filter((list) => list.length >= 3).length >= 20, "too few messages with three kinds or more");
  assert.ok(whos.filter((list) => list.length === 1).length >= 30, "too few messages with one kind only");
});

test("no message repeats, within the health corpora or across them and the everyday corpora", () => {
  const seen = new Map();
  for (const file of ["normal-messages.txt", "normal-messages-es.txt"])
    for (const m of readMessages(file)) seen.set(plain(m), file);
  const repeats = [];
  for (const file of [...QUIET, ...WARN])
    for (const { text } of readLabelled(file)) {
      const key = plain(text);
      if (seen.has(key)) repeats.push(`${file} repeats ${seen.get(key)}: ${text.slice(0, 60)}`);
      seen.set(key, file);
    }
  assert.deepEqual(repeats, []);
});

test("there is no health kind yet (it ships in 1.5.0, only if these corpora pass)", () => {
  assert.equal(
    globalThis.Clotr.PATTERNS.some((p) => p.id === "health_detail"),
    false,
  );
});

for (const file of QUIET)
  test(`today: no quiet health message warns at all (${file})`, () => {
    assert.deepEqual(
      quietProblems(
        readLabelled(file).map((m) => m.text),
        ACCEPTED[file],
      ),
      [],
    );
  });

test("the quiet check fails on a planted warning, on an ACCEPTED entry that passes, and on other kinds", () => {
  const msgs = ["What does an A1C of 7.2 mean?", "I have asthma, call me at 555-555-0142"];
  assert.match(quietProblems(msgs, []).join("\n"), /^wrong warning \["phone_number"\] ← I have asthma/);
  assert.deepEqual(quietProblems(msgs, [{ message: "I have asthma", kinds: ["phone_number"], issue: "#0" }]), []);
  assert.match(
    quietProblems(msgs, [{ message: "I have asthma", kinds: ["email"], issue: "#0" }]).join("\n"),
    /not as listed/,
  );
  assert.match(
    quietProblems(msgs, [
      { message: "I have asthma", kinds: ["phone_number"], issue: "#0" },
      { message: "What does", kinds: [], issue: "#0" },
    ]).join("\n"),
    /^no longer warns, take it out of ACCEPTED: "What does" \(#0\)$/,
  );
  assert.match(quietProblems(msgs, [{ message: "I have asthma", kinds: ["phone_number"] }]).join("\n"), /issue number/);
});

for (const file of WARN)
  test(`today: in every warn message, only who the person is warns (${file})`, () => {
    const problems = [];
    for (const { label, text } of readLabelled(file)) {
      const l = parseWarnLabel(label);
      if (!l) continue; // reported by the label test
      const found = detect(text);
      if (found.health_detail) problems.push(`health_detail already: ${text.slice(0, 60)}`);
      const missing = l.who.filter((w) => w !== "name" && !found[w]);
      if (missing.length) problems.push(`not found ${JSON.stringify(missing)} ← ${text.slice(0, 80)}`);
    }
    assert.deepEqual(problems, []);
  });
