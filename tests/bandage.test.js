// Bandage keeps no details after a reload, so it rereads the labels a conversation already shows and numbers any
// new ones after them. These tests cover that reader, readBandageLabels in detector.js: every label Bandage
// writes, in English and Spanish, wherever a site or the AI places it, and nothing that only looks like one.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { retrySlow, bestOfBoth } = require("./timing.js");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");
const { readBandageLabels, BANDAGE_WORDS, BANDAGE_BORN_IN } = globalThis.Clotr;

const EXT = path.join(__dirname, "..", "extension");
const ids = (text) => readBandageLabels(text).map((f) => f.id);

test("English labels: each kind and its number, the same id for the same label", () => {
  const text =
    "I'm [Me], I work at [My company]. Call [Phone 1] or [Phone 12], write to [Email 2], " +
    "my sister [Family 3] lives at [Address 1]; card [Card 1], account [Account 2], IP [IP address 1], " +
    "[Term 4], [ID 5], [Birth date 2], and I was [born in the 1940s].";
  assert.deepEqual(ids(text), [
    "bl_me 1",
    "bl_company 1",
    "bl_phone 1",
    "bl_phone 12",
    "bl_email 2",
    "bl_family 3",
    "bl_address 1",
    "bl_card 1",
    "bl_account 2",
    "bl_ip 1",
    "bl_term 4",
    "bl_id 5",
    "bl_birth 2",
    "bl_bornIn 1940",
  ]);
  const [first] = readBandageLabels("call [Phone 1] now");
  assert.deepEqual(first, { label: "[Phone 1]", index: 5, kind: "bl_phone", n: 1, id: "bl_phone 1" });
});

test("Spanish labels read as the same labels as English ones", () => {
  const text =
    "[Yo] trabajo en [Mi empresa]. [Teléfono 1], [Correo 2], [Familiar 3], [Dirección 1], [Tarjeta 1], " +
    "[Cuenta 2], [Dirección IP 1], [Término 4], [ID 5], [Fecha de nacimiento 2], [nacimiento en los años 1940]";
  const english =
    "[Me] [My company] [Phone 1] [Email 2] [Family 3] [Address 1] [Card 1] [Account 2] [IP address 1] [Term 4] " +
    "[ID 5] [Birth date 2] [born in the 1940s]";
  assert.deepEqual(ids(text), ids(english));
  assert.equal(ids(english).length, 13);
});

test("an AI's way of writing a label still counts: case, missing accents, spacing", () => {
  assert.deepEqual(ids("[phone 3] [PHONE 4] [telefono 5] [TELÉFONO 6] [ Phone 7 ] [Phone 8] [Direccion  IP 2]"), [
    "bl_phone 3",
    "bl_phone 4",
    "bl_phone 5",
    "bl_phone 6",
    "bl_phone 7",
    "bl_phone 8",
    "bl_ip 2",
  ]);
  assert.deepEqual(ids("[Me 2] [My company 3]"), ["bl_me 2", "bl_company 3"]);
});

test("labels inside code blocks, quotes and formatting are found", () => {
  const text = [
    "```",
    'const phone = "[Phone 2]";',
    "```",
    "> [Address 3] wrote back",
    "“[Email 4]” and «[Teléfono 5]»",
    "`[Card 6]` **[Me]** _[Family 7]_",
    "([Term 8]), [ID 9].",
    "[Phone 10][Phone 11]",
  ].join("\n");
  assert.deepEqual(ids(text), [
    "bl_phone 2",
    "bl_address 3",
    "bl_email 4",
    "bl_phone 5",
    "bl_card 6",
    "bl_me 1",
    "bl_family 7",
    "bl_term 8",
    "bl_id 9",
    "bl_phone 10",
    "bl_phone 11",
  ]);
});

// The page is read as one block of text through an element's textContent, so a label split across several
// elements, like a highlight, a streamed word, or a link, still counts: textContent joins those text nodes with
// nothing in between.
test("a label split across a site's elements is found in the joined text", () => {
  const nodes = ["Sure, I'll call [Pho", "ne 3", "] tomorrow and ", "[", "Address", " 2", "]", "."];
  assert.deepEqual(ids(nodes.join("")), ["bl_phone 3", "bl_address 2"]);
  // Two block elements touch directly once textContent joins them, but the label still reads correctly and
  // nothing new appears.
  assert.deepEqual(ids(["call [Phone 1]", "[Email 2] ok"].join("")), ["bl_phone 1", "bl_email 2"]);
});

test("text that only looks like a label isn't one", () => {
  for (const text of [
    "[Phone]", // Bandage always numbers a phone, so one without a number isn't a label
    "[Address one]",
    "[Phone 1",
    "Phone 1]",
    "Phone 1",
    "[1]",
    "items[i] and a[2]",
    "[REDACTED PHONE NUMBER]",
    "[Phone number 1]",
    "[Me and you]",
    "[iPhone 12]",
    "[born in the 1940]",
    "[Phone 12345]",
    "",
  ]) {
    assert.deepEqual(ids(text), [], JSON.stringify(text));
  }
  assert.deepEqual(readBandageLabels(null), []);
});

test("a long chat is read in one quick pass", () => {
  const chunk = "Here is a long answer about [Phone 3] and [Address 2], with arrays like a[i] and [links](x). ";
  const text = chunk.repeat(20000); // about 2 MB
  assert.equal(readBandageLabels(text).length, 40000);
  retrySlow(() => {
    const t = bestOfBoth(() => readBandageLabels(text), 1);
    if (t.over(1000)) return `took ${t.wall.toFixed(0)} ms (${t.allowed.toFixed(0)} allowed on this computer now)`;
  });
  const plain = "nothing to see here ".repeat(100000);
  assert.deepEqual(readBandageLabels(plain), []);
  retrySlow(() => {
    const t = bestOfBoth(() => readBandageLabels(plain), 1);
    if (t.over(200)) return `text without a bracket wasn't skipped quickly: ${t.wall.toFixed(0)} ms`;
  });
});

// The reader's word list has to match what Bandage actually writes: English lives in content.js, Spanish in
// _locales. If a label word changes in one place but not the other, labels from before a reload get missed.
test("the reader's words match the labels content.js gives, in English and Spanish", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const content = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  const given = Object.fromEntries(
    [...content.matchAll(/\[\s*"(bl_\w+)",\s*msg\(\s*"(bl_\w+)",\s*"([^"]+)"\)\s*\]/g)].map((m) => {
      assert.equal(m[1], m[2], `${m[1]}: the kind and the message key differ`);
      return [m[1], m[3]];
    }),
  );
  assert.deepEqual(Object.keys(given).sort(), Object.keys(BANDAGE_WORDS).sort());
  for (const [kind, words] of Object.entries(BANDAGE_WORDS)) {
    assert.equal(words[0], given[kind], `${kind}: English`);
    assert.ok(words.includes(es[kind].message), `${kind}: Spanish "${es[kind].message}" isn't read`);
  }
  const bornIn = content.match(/msg\("bl_bornIn", "([^"]+)"/);
  assert.equal(BANDAGE_BORN_IN[0], bornIn[1]);
  assert.equal(BANDAGE_BORN_IN[1], es.bl_bornIn.message);
  // Every language Clotr speaks is read.
  const locales = fs.readdirSync(path.join(EXT, "_locales"));
  for (const loc of locales) {
    const m = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", loc, "messages.json"), "utf8"));
    for (const kind of Object.keys(BANDAGE_WORDS)) {
      if (m[kind]) assert.ok(BANDAGE_WORDS[kind].includes(m[kind].message), `${loc} ${kind} isn't read`);
    }
  }
});

// A team can cover its own kinds with its own word, like "[Matter 1]", so after a reload those labels read just
// like Bandage's built-in ones and keep numbering from where they left off. The cover words come from the kinds
// set on the page's vault through patterns.js's setVault; without a vault, "[Matter 2]" is just plain text.
test("a team's cover words are read as labels while its kinds are set, and a built-in word keeps its numbering", () => {
  const C = globalThis.Clotr;
  assert.deepEqual(ids("[Matter 2] and [Client 1]"), []);
  C.setVault({
    salt: "s",
    entries: [],
    kinds: [
      { id: "team_matter_number", name: "Matter number", cover: "Matter" },
      { id: "team_client_name", name: "Client name", cover: "Número de cliente" },
      { id: "team_work_phone", name: "Work phone", cover: "Phone" },
    ],
  });
  try {
    assert.deepEqual(
      ids("[Matter 2], [matter 3], [ MATTER 4 ], [numero de cliente 1], [Phone 5], [Matter], [Matters 1]"),
      ["team:matter 2", "team:matter 3", "team:matter 4", "team:numero de cliente 1", "bl_phone 5"],
    );
    assert.deepEqual(ids("[Phone 1] [Matter 1] [Email 1]"), ["bl_phone 1", "team:matter 1", "bl_email 1"]);
    const [first] = readBandageLabels("see [Matter 12] here");
    assert.deepEqual(first, { label: "[Matter 12]", index: 4, kind: "team:matter", n: 12, id: "team:matter 12" });
    // A cover word numbers under its own kind, unless it happens to match one of Bandage's own words in any language.
    assert.equal(C.bandageKindOf("Matter"), "team:matter");
    assert.equal(C.bandageKindOf("Phone"), "bl_phone");
    assert.equal(C.bandageKindOf("Teléfono"), "bl_phone");
    // Still one quick pass over a long chat.
    const long = "An answer about [Matter 3] and [Phone 2], with a[i] and [links](x). ".repeat(20000);
    assert.equal(readBandageLabels(long).length, 40000);
    retrySlow(() => {
      const t = bestOfBoth(() => readBandageLabels(long), 1);
      if (t.over(1000))
        return `a long chat with team labels took ${t.wall.toFixed(0)} ms (${t.allowed.toFixed(0)} allowed on this computer now)`;
    });
  } finally {
    C.setVault(null);
  }
  assert.deepEqual(ids("[Matter 2]"), []);
});
