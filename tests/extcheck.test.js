// Covers extcheck-core.js and the reported-extensions list: how reachOf() reads a permission warning, which
// records count as worth a look, and the shape checkExtensions returns. The actual chrome.* calls and the results
// page live in the e2e suite, not here.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/reported-extensions.js");
require("../extension/extcheck-core.js");
const C = globalThis.Clotr;

// A small stand-in for ai-sites.json. Real AI sites would work just as well here, but a fixture keeps these
// cases from drifting if the real list grows.
const AI_SITES = [
  { name: "ChatGPT", matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"] },
  { name: "Claude", matches: ["https://claude.ai/*"] },
];
const ALL_SITES_WARNING = "Read and change all your data on all websites";
const WORDS = { allSites: ALL_SITES_WARNING };

const record = (over = {}) => ({ id: "a".repeat(32), name: "Test extension", enabled: true, hosts: [], ...over });

// ---------- the reported list ----------

test("reported list: every entry has a 32-letter (a-p) id, a source, a date, an https address and 'collected AI chats'", () => {
  const { entries, checked } = C.reportedExtensions;
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(checked), "checked should be a plain date");
  assert.ok(entries.length >= 10, "all ten reported ids should be there");
  const seen = new Set();
  for (const e of entries) {
    assert.match(e.id, /^[a-p]{32}$/, `${e.name}: id should be 32 letters a-p`);
    assert.ok(!seen.has(e.id), `${e.name}: id should be listed once`);
    seen.add(e.id);
    assert.ok(e.store && typeof e.store === "string");
    assert.ok(e.name && typeof e.name === "string");
    assert.ok(e.source && typeof e.source === "string");
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.name}: date should be plain`);
    assert.ok(e.url.startsWith("https://"), `${e.name}: the report's address should be https://`);
    assert.equal(e.what, "collected AI chats");
  }
});

test("reported list: holds the Urban VPN family and OX Security's two, Similarweb held out", () => {
  const names = C.reportedExtensions.entries.map((e) => e.name);
  assert.ok(names.includes("Urban VPN Proxy"));
  assert.ok(names.includes("1ClickVPN Proxy"));
  assert.ok(names.includes("Urban Browser Guard"));
  assert.ok(names.includes("Urban Ad Blocker"));
  assert.ok(names.some((n) => n.includes("GPT-5")));
  assert.ok(names.some((n) => n.includes("AI Sidebar")));
  assert.ok(!names.some((n) => /similarweb/i.test(n)), "Similarweb is held out, pending a decision");
});

// ---------- reachOf(): what each kind of permission warning reaches ----------

test("reachOf: <all_urls> and the scheme-wide wildcards all mean 'all'", () => {
  assert.equal(C.reachOf(record({ hosts: ["<all_urls>"] }), AI_SITES, WORDS), "all");
  assert.equal(C.reachOf(record({ hosts: ["*://*/*"] }), AI_SITES, WORDS), "all");
  assert.equal(C.reachOf(record({ hosts: ["https://*/*"] }), AI_SITES, WORDS), "all");
  assert.equal(C.reachOf(record({ hosts: ["http://*/*"] }), AI_SITES, WORDS), "all");
});

test("reachOf: a warning equal to the all-sites sentence means 'all', in any language", () => {
  const sentence = "Lire et modifier toutes vos données sur tous les sites web";
  assert.equal(C.reachOf(record({ hosts: [], warnings: [sentence] }), AI_SITES, { allSites: sentence }), "all");
});

test("reachOf: a host matching an AI site means 'ai'", () => {
  assert.equal(C.reachOf(record({ hosts: ["https://chatgpt.com/*"] }), AI_SITES, WORDS), "ai");
  assert.equal(C.reachOf(record({ hosts: ["https://claude.ai/*"] }), AI_SITES, WORDS), "ai");
});

test("reachOf: Windows' content-script matches count the same way as a browser's hosts", () => {
  assert.equal(C.reachOf(record({ hosts: [], scripts: ["https://chatgpt.com/*"] }), AI_SITES, WORDS), "ai");
});

test("reachOf: script-only via warnings (Chrome drops content scripts from hostPermissions)", () => {
  const rec = record({ hosts: [], warnings: ["Read and change your data on chatgpt.com"] });
  assert.equal(C.reachOf(rec, AI_SITES, WORDS), "ai");
});

test("reachOf: 'a number of websites' and a non-AI host both mean 'some', never 'ai'", () => {
  const vague = record({ hosts: [], warnings: ["Read and change your data on a number of websites"] });
  assert.equal(C.reachOf(vague, AI_SITES, WORDS), "some");
  const other = record({ hosts: ["https://example.com/*"] });
  assert.equal(C.reachOf(other, AI_SITES, WORDS), "some");
});

test("reachOf: nothing granted means 'none'", () => {
  assert.equal(C.reachOf(record({ hosts: [] }), AI_SITES, WORDS), "none");
});

test("reachOf: Firefox's moz-extension: pattern is dropped, not counted as 'some'", () => {
  assert.equal(
    C.reachOf(record({ hosts: ["moz-extension://11111111-1111-1111-1111-111111111111/*"] }), AI_SITES, WORDS),
    "none",
  );
});

test("reachOf: enabled:false always means 'off', whatever it could otherwise reach", () => {
  assert.equal(C.reachOf(record({ hosts: ["<all_urls>"], enabled: false }), AI_SITES, WORDS), "off");
});

test("reachOf: Clotr's own record reads honestly too (self changes nothing about reach)", () => {
  const self = record({ hosts: ["https://chatgpt.com/*", "https://claude.ai/*"], self: true });
  assert.equal(C.reachOf(self, AI_SITES, WORDS), "ai");
});

test("aiSitesReached: names the AI tools a record actually reaches", () => {
  const rec = record({ hosts: ["https://chatgpt.com/*", "https://claude.ai/*"] });
  assert.deepEqual(C.aiSitesReached(rec, AI_SITES).sort(), ["ChatGPT", "Claude"]);
  assert.deepEqual(C.aiSitesReached(record({ hosts: ["https://example.com/*"] }), AI_SITES), []);
});

// ---------- worth a look, and Clotr recognizing itself ----------

test("worthALookOf: on the reported list, by id", () => {
  const reportedId = C.reportedExtensions.entries[0].id;
  const found = C.worthALookOf(record({ id: reportedId }), C.reportedExtensions);
  assert.equal(found.reason, "reported");
  assert.equal(found.report.id, reportedId);
  assert.equal(C.worthALookOf(record({ id: "b".repeat(32) }), C.reportedExtensions), null);
});

test("worthALookOf: installed by another program ('sideload'), never for Clotr itself", () => {
  const sideloaded = record({ installType: "sideload" });
  assert.deepEqual(C.worthALookOf(sideloaded, C.reportedExtensions), { reason: "sideload" });
  const selfSideloaded = record({ installType: "sideload", self: true });
  assert.equal(C.worthALookOf(selfSideloaded, C.reportedExtensions), null, "Clotr is never worth a look");
});

test("worthALookOf: on the reported list but self is still never worth a look", () => {
  const reportedId = C.reportedExtensions.entries[0].id;
  assert.equal(C.worthALookOf(record({ id: reportedId, self: true }), C.reportedExtensions), null);
});

test("worthALookOf: ordinary extensions (normal installType) aren't flagged", () => {
  assert.equal(C.worthALookOf(record({ installType: "normal" }), C.reportedExtensions), null);
});

test("installNoteOf: development and admin are plain notes, not a flag", () => {
  assert.equal(C.installNoteOf(record({ installType: "development" })), "development");
  assert.equal(C.installNoteOf(record({ installType: "admin" })), "admin");
  assert.equal(C.installNoteOf(record({ installType: "normal" })), null);
  assert.equal(C.installNoteOf(record({ installType: "sideload" })), null, "sideload is worth a look, not a note");
});

// ---------- the result shape ----------

test("checkExtensions: the counts and entries the results page needs", () => {
  const reportedId = C.reportedExtensions.entries[0].id;
  const records = [
    record({ id: "s".repeat(32), self: true, hosts: ["https://chatgpt.com/*"] }), // Clotr itself: reads AI chats
    record({ id: reportedId, hosts: ["<all_urls>"] }), // worth a look, and reads everything
    record({ id: "c".repeat(32), installType: "sideload", hosts: [] }), // worth a look, but reaches nothing either
    record({ id: "d".repeat(32), hosts: ["https://example.com/*"] }), // some
    record({ id: "e".repeat(32), hosts: [], enabled: false }), // off
    record({ id: "f".repeat(32), hosts: [] }), // none
  ];
  const result = C.checkExtensions(records, {
    aiSites: AI_SITES,
    reportedExtensions: C.reportedExtensions,
    words: WORDS,
  });
  assert.equal(result.total, 6);
  assert.equal(result.canReadAi, 2, "Clotr and the all-sites one both read AI chats");
  assert.equal(result.worthALook.length, 2);
  assert.ok(result.worthALook.some((e) => e.worthALook.reason === "reported"));
  assert.ok(result.worthALook.some((e) => e.worthALook.reason === "sideload"));
  assert.equal(result.some, 1);
  assert.equal(result.off, 1);
  assert.equal(result.none, 2, "the sideloaded one and the plain one both reach nothing");
  const self = result.entries.find((e) => e.self);
  assert.equal(self.reach, "ai");
  assert.deepEqual(self.aiSites, ["ChatGPT"]);
});

test("checkExtensions: no records at all gives honest zeros, not an error", () => {
  const result = C.checkExtensions([], { aiSites: AI_SITES, reportedExtensions: C.reportedExtensions, words: WORDS });
  assert.equal(result.total, 0);
  assert.equal(result.canReadAi, 0);
  assert.deepEqual(result.worthALook, []);
});
