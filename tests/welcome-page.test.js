// The welcome page puts the practice box first and asks for the built-in AI chat sites by default: Try it sits
// after the short facts and before the founder note, Pin Clotr and "Where should Clotr check?". EW6 and EW7 cover the choices.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..", "extension");
require("../extension/demo-key.js");
const DEMO_AWS_KEY = globalThis.ClotrDemo.awsAccessKey;
const html = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
const js = fs.readFileSync(path.join(EXT, "vault.js"), "utf8");
const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));

const at = (needle) => {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `vault.html has no ${needle}`);
  return i;
};

test("welcome page: Try it comes right after the facts, ahead of Pin Clotr and Where should Clotr check?", () => {
  const facts = at('<ul class="facts">');
  const tryIt = at('data-i18n="vault_tryIt"');
  assert.ok(facts < tryIt, "Try it sits under the facts");
  assert.ok(tryIt < at('class="pin-title"'), "Try it comes before Pin Clotr");
  assert.ok(tryIt < at('id="where-offer"'), "Try it comes before Where should Clotr check?");
  // Nothing else sits between the facts and Try it.
  const between = html.slice(html.indexOf("</ul>", facts) + 5, tryIt);
  assert.match(between, /^\s*<h2\s*$/, `something sits between the facts and Try it: ${between.trim()}`);
});

test("welcome page: a Copy button sits beside the made-up key", () => {
  const field = html.slice(at('data-i18n="vault_tryIt"'), at('id="try-result"'));
  assert.match(field, /<code[^>]*data-demo-aws-key[^>]*><\/code>/);
  assert.doesNotMatch(field, new RegExp(DEMO_AWS_KEY));
  assert.match(html, /<script src="demo-key\.js"><\/script>/);
  assert.match(field, /<button[^>]*id="try-copy"[^>]*type="button"|<button[^>]*type="button"[^>]*id="try-copy"/);
  assert.ok(es.vault_copyKey?.message && es.vault_copied?.message, "Copy and Copied have Spanish");
});

test("welcome page: the highlighted choice names the popular AI chats and reads its count from the built-in list", () => {
  const tag = (id) => new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] || "";
  assert.match(tag("where-ai-only"), /class="btn primary"/);
  assert.match(tag("where-everywhere"), /class="btn"/);
  assert.doesNotMatch(tag("where-everywhere"), /primary/);
  assert.match(
    html,
    /<span data-i18n="vt_aiChatsThe">The<\/span> <span id="ai-site-count-choice"><\/span> <span data-i18n="vt_aiChatsOnly">popular AI chats<\/span>/,
  );
  assert.match(
    html,
    /<span id="ai-site-count-fact"><\/span> <span data-i18n="vault_onlyOnAiChats">AI chats are on from the start\.<\/span>/,
  );
  const sites = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  assert.ok(sites.length > 0);
  const where = js.slice(js.indexOf("function mountWhereOffer"), js.indexOf("async function mountMoreSitesOffer"));
  assert.match(where, /getURL\("ai-sites\.json"\)/);
  assert.match(where, /ai-site-count-choice/);
  assert.match(where, /ai-site-count-fact/);
  assert.ok(es.vt_wherePause?.message, "the site-level pause hint has Spanish");
});

test("welcome page: the everywhere button has its own refusal and a ✓ On status", () => {
  const where = js.slice(js.indexOf("function mountWhereOffer"), js.indexOf("async function mountMoreSitesOffer"));
  assert.ok(where.length > 0, "mountWhereOffer is where it was");
  assert.doesNotMatch(where, /"ev_refused"/, "the tick-boxes' refusal doesn't fit a button");
  assert.match(where, /"vt_everywhereRefused"/);
  assert.match(where, /"vt_everywhereOn"/);
  assert.ok(es.vt_everywhereRefused?.message && es.vt_everywhereOn?.message.startsWith("✓"));
});

test("welcome page: the pinned line names Clotr's icon, not a shield, in English and Spanish", () => {
  const pinned = /msg\(\s*"vt_pinned",\s*"([^"]*)"/.exec(js)?.[1] || "";
  assert.match(pinned, /Clotr's icon/);
  assert.doesNotMatch(pinned, /shield/i);
  assert.doesNotMatch(es.vt_pinned.message, /escudo/i);
  assert.match(es.vt_pinned.message, /icono de Clotr/);
});

test("welcome page: the pin steps have Firefox and Edge wording in Spanish too", () => {
  for (const key of ["vault_pinExtensionsButton", "vault_pinFirefoxMiddle", "vault_pinFirefoxEnd"]) {
    assert.ok(es[key]?.message, `es has ${key}`);
  }
  for (const key of ["vault_pinEdgeMiddle", "vault_pinEdgeEnd"]) assert.ok(es[key]?.message, `es has ${key}`);
});
