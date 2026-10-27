// The warning's two buttons say the same words everywhere the extension warns: the corner card, the dialog that
// holds a send and the practice box on the welcome page. "Clot this leak" is the brand's own verb, so each of those
// buttons also carries a tooltip that says what it does without the brand's verb.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const es = JSON.parse(read("extension/_locales/es/messages.json"));

// The extension's English lives in the code, as msg()'s fallback: every fallback given for one key.
function englishOf(file, key) {
  const found = [...read(file).matchAll(new RegExp(`msg\\(\\s*"${key}",\\s*"([^"]*)"`, "g"))].map((m) => m[1]);
  assert.ok(found.length, `${file} uses ${key}`);
  return [...new Set(found)];
}

test("the browser's warning buttons read Clot this leak and Leave it alone, in English and Spanish", () => {
  const english = {
    noticeCover: "Clot this leak",
    noticeSendAsIs: "Leave it alone",
    coverIt: "Clot this leak",
    leaveIt: "Leave it alone",
    leaveItSend: "Leave it and send",
  };
  const spanish = {
    noticeCover: "Taponar esta fuga",
    noticeSendAsIs: "Dejarlo así",
    coverIt: "Taponar esta fuga",
    leaveIt: "Dejarlo así",
    leaveItSend: "Dejarlo así y enviar",
  };
  for (const [key, words] of Object.entries(english)) {
    assert.deepEqual(englishOf("extension/warning-ui.js", key), [words], `warning-ui.js ${key}`);
    assert.equal(es[key]?.message, spanish[key], `es ${key}`);
  }
  for (const key of ["coverIt", "leaveIt"]) {
    assert.deepEqual(englishOf("extension/page-notice.js", key), [english[key]], `the practice box's ${key}`);
  }
  const share = read("extension/share.html");
  assert.match(share, /data-i18n="coverIt">Clot this leak</);
  assert.match(share, /data-i18n="leaveIt">Leave it alone</);
});

test("each browser button's tooltip says plainly what it does", () => {
  const hints = {
    coverItHint: "Covers the detail before it's sent",
    leaveItHint: "Closes this warning and leaves your message as it is",
    leaveItSendHint: "Sends your message as it is, with nothing covered",
  };
  for (const [key, words] of Object.entries(hints)) {
    assert.deepEqual(englishOf("extension/warning-ui.js", key), [words], `warning-ui.js ${key}`);
    assert.ok(es[key]?.message, `es has ${key}`);
  }
  for (const key of ["coverItHint", "leaveItHint"]) {
    assert.deepEqual(englishOf("extension/page-notice.js", key), [hints[key]], `the practice box's ${key}`);
  }
  // Set as the button's title, so it's a tooltip and the button's accessible description, while the button's
  // name stays the words on it (the browser checks read both).
  for (const file of ["extension/warning-ui.js", "extension/page-notice.js"]) {
    const code = read(file);
    assert.match(code, /title: msg\("coverItHint"/, `${file} gives the cover button its tooltip`);
    assert.match(code, /title: msg\("leaveItHint"/, `${file} gives the leave button its tooltip`);
  }
});

test("no warning text still teaches the old button words", () => {
  const OLD_EN = /\b(Hide it|Hide them|Cover it|Send as is|Leave it in|Paste it as is|It's mine)\b/;
  const OLD_ES = /\b(Ocultarlo|Ocultarlos|Cubrirlo|Enviarlo tal cual|Pegarlo tal cual|Ocúltalo|Es mío)\b/;
  const keys = [
    "coverIt",
    "leaveIt",
    "leaveItSend",
    "noticeCover",
    "noticeSendAsIs",
    "choiceAllowOne",
    "choiceAllowMany",
    "choiceLogKinds",
    "choiceProtectOne",
    "choiceProtectMany",
    "dialogNote",
    "enterCovers",
    "whyBody",
  ];
  for (const key of keys) {
    for (const words of englishOf("extension/warning-ui.js", key)) {
      assert.doesNotMatch(words, OLD_EN, `en ${key}: ${words}`);
    }
    assert.doesNotMatch(es[key].message, OLD_ES, `es ${key}: ${es[key].message}`);
  }
  const share = read("extension/share.html");
  assert.doesNotMatch(share.match(/data-i18n="sh_notSure">([^<]*)</)[1], OLD_EN, "the share page's tip");
  assert.doesNotMatch(es.sh_notSure.message, OLD_ES, "es sh_notSure");
});
