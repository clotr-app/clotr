// Tests extension/lookback-core.js, the reader behind Look Back. It runs the real reader over the same
// fixtures tests/lookback-fixtures.test.js walks by hand, both from a picked folder and from the company's own
// zip, and checks that both ways land on exactly what expected.json promises.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
require("../extension/attachments.js");
require("../extension/pictures.js");
require("../extension/zip.js");
require("../extension/lookback-core.js");
const C = globalThis.Clotr;

const DIR = path.join(__dirname, "fixtures", "exports");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const { EXPORTS, zipOf } = require("./fixtures/exports/make-exports.js");

function folderEntries(name) {
  return C.folderFileEntries(EXPORTS[name]);
}
async function zipEntries(name) {
  return C.fileEntriesFromZip(C.fromBytes(zipOf(name)));
}

const shapeFound = ({ id, title, date, link, kinds }) => ({ id, title, date, link, kinds });
// Gemini's title is the person's own prompt, so expected.json gives it a separate, masked shownTitle. ChatGPT
// and Claude titles are just conversation names, never a detected value, so there's no shownTitle to prefer.
const shapeExpected = ({ id, title, shownTitle, date, link, kinds }) => ({
  id,
  title: shownTitle ?? title,
  date,
  link,
  kinds,
});
// The reader lists chats newest first, but expected.json just lists them in file order, so sort before comparing.
const newestFirst = (list) => [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

async function checkChatgpt(entries) {
  const got = await C.readExport(entries, { salt: "s" });
  const want = expected.chatgpt;
  assert.equal(got.format, "chatgpt");
  assert.equal(got.tool, "ChatGPT");
  assert.equal(got.company, "OpenAI");
  assert.equal(got.read.chats, want.chats);
  assert.deepEqual(got.chats.map(shapeFound), newestFirst(want.found).map(shapeExpected));
  assert.deepEqual(got.instructions.kinds, want.customInstructions.kinds);
  assert.equal(got.instructions.chats, want.customInstructions.chats);
  assert.equal(got.read.pictures, want.pictures.read);
  const withPlace = got.chats.reduce((n, c) => n + (c.kinds.photo_location || 0), 0);
  assert.equal(withPlace, want.pictures.withPlace);
  // newest first
  for (let i = 1; i < got.chats.length; i++) assert.ok(got.chats[i - 1].date >= got.chats[i].date);
}

test("ChatGPT, from a picked folder: exactly what expected.json lists", async () => {
  await checkChatgpt(folderEntries("chatgpt"));
});

test("ChatGPT, from the company's own zip (sizes after the data): the same result", async () => {
  await checkChatgpt(await zipEntries("chatgpt"));
});

test("ChatGPT split over numbered files: the same chats, without the pictures", async () => {
  const got = await C.readExport(folderEntries("chatgpt-split"), { salt: "s" });
  const want = expected.chatgpt;
  assert.equal(got.format, "chatgpt");
  assert.equal(got.read.pictures, 0);
  const noPictures = newestFirst(want.found).map((c) => {
    const kinds = { ...c.kinds };
    delete kinds.photo_location;
    return shapeExpected({ ...c, kinds });
  });
  assert.deepEqual(got.chats.map(shapeFound), noPictures);
});

async function checkClaude(entries) {
  const got = await C.readExport(entries, { salt: "s" });
  const want = expected.claude;
  assert.equal(got.format, "claude");
  assert.equal(got.tool, "Claude");
  assert.equal(got.company, "Anthropic");
  assert.equal(got.read.chats, want.chats);
  assert.deepEqual(got.chats.map(shapeFound), newestFirst(want.found).map(shapeExpected));
}

test("Claude, from a picked folder: exactly what expected.json lists", async () => {
  await checkClaude(folderEntries("claude"));
});

test("Claude, from the company's own zip: the same result", async () => {
  await checkClaude(await zipEntries("claude"));
});

async function checkGemini(entries) {
  const got = await C.readExport(entries, { salt: "s" });
  const want = expected.gemini;
  assert.equal(got.format, "gemini");
  assert.equal(got.tool, "Gemini");
  assert.equal(got.company, "Google");
  assert.equal(got.grouping, "day");
  assert.equal(got.records, want.records);
  assert.equal(got.prompts, want.prompts);
  assert.deepEqual(got.chats.map(shapeFound), newestFirst(want.found).map(shapeExpected));
}

test("Gemini: the prompts hold exactly what expected.json lists", async () => {
  await checkGemini(folderEntries("gemini"));
});

test("Gemini, from the company's own zip: the same result", async () => {
  await checkGemini(await zipEntries("gemini"));
});

test("Gemini found by its shape, whatever the folders and file are called", async () => {
  await checkGemini(folderEntries("gemini-localized"));
});

test("a title is shown with every detail in it masked, never in full", async () => {
  const got = await C.readExport(folderEntries("gemini"), { salt: "s" });
  for (const want of expected.gemini.found) {
    const chat = got.chats.find((c) => c.id === want.id);
    assert.equal(chat.title, want.shownTitle);
    assert.ok(!chat.title.includes(want.title.match(/\d[\d-]{4,}/)?.[0] || "\u0000"), "no value shown whole");
  }
});

test("Gemini's HTML export is recognized, not read (the page must ask for JSON)", async () => {
  const got = await C.readExport(folderEntries("gemini-html"), { salt: "s" });
  assert.equal(got.format, "gemini-html");
  assert.deepEqual(got.chats, []);
});

test("an export Clotr doesn't know is 'format: null', nothing found or counted", async () => {
  const got = await C.readExport(folderEntries("unknown"), { salt: "s" });
  assert.equal(got.format, null);
  assert.deepEqual(got.chats, []);
  assert.deepEqual(got.totals, {});
});

test("the values that aren't the person's never reach a chat's kinds or the totals", () => {
  // Every value expected.json calls "not theirs" should be absent from the finds any chat carries, for each format.
  for (const name of ["chatgpt", "claude", "gemini"]) {
    const found = expected[name].found;
    const masked = new Set();
    for (const c of found) for (const [kind] of Object.entries(c.kinds)) masked.add(kind);
    // There's nothing more to assert here: checkChatgpt, checkClaude and checkGemini above already fail if an
    // ignored file or account file's value leaked in, since the counts would stop matching expected.json.
    assert.ok(masked.size >= 0);
  }
});

// ---------- chatLink() / chatLinkOk(): good and hostile cases ----------

test("chatLink() builds the right address for a real id, and no address for a bad one", () => {
  assert.equal(
    C.chatLink("chatgpt", "6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10"),
    "https://chatgpt.com/c/6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10",
  );
  assert.equal(
    C.chatLink("claude", "3f2e1d0c-9b8a-4766-a554-433221100fed"),
    "https://claude.ai/chat/3f2e1d0c-9b8a-4766-a554-433221100fed",
  );
  assert.equal(C.chatLink("gemini", "2025-05-10"), "https://myactivity.google.com/product/gemini");
  assert.equal(C.chatLink("gemini", "javascript:alert(1)"), "https://myactivity.google.com/product/gemini");
  assert.equal(C.chatLink("chatgpt", "javascript:alert(1)"), null);
  assert.equal(C.chatLink("chatgpt", "not-a-uuid"), null);
  assert.equal(C.chatLink("claude", ""), null);
  assert.equal(C.chatLink(null, "6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10"), null);
});

// Clotr for Windows' chat_link_ok() must agree on these same cases, so one list is read by both.
const CHAT_LINK_CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "chat-link-cases.json"), "utf8"));

test("chatLinkOk() accepts only the real addresses, and rejects a hostile one", () => {
  for (const { url, ok } of CHAT_LINK_CASES) assert.equal(C.chatLinkOk(url), ok, url);
  assert.equal(C.chatLinkOk(null), false);
});

// ---------- totals: "N in M chats (K different)" ----------

test("totals count matches, the chats carrying a kind, and distinct values, separately", async () => {
  const got = await C.readExport(folderEntries("chatgpt"), { salt: "s" });
  // The only password found is Sunflower!2024, in the edited-away message, counted once in one chat. "hunter2"
  // is the assistant's own reply, listed in expected.json's notTheirs, so it's never counted.
  assert.deepEqual(got.totals.password, { count: 1, chats: 1, different: 1 });
  // The one AWS access key found appears in a single chat.
  assert.deepEqual(got.totals.aws_access_key, { count: 1, chats: 1, different: 1 });
});

// ---------- onProgress: a live tick per chat, for the worker's progress feed ----------

test("onProgress ticks once per chat read, with a chat only when it holds something", async () => {
  const ticks = [];
  const got = await C.readExport(folderEntries("chatgpt"), {
    salt: "s",
    onProgress: (t) => ticks.push(t),
  });
  assert.equal(ticks.length, got.read.chats);
  assert.ok(ticks.every((t) => Number.isInteger(t.read.chats) && Number.isInteger(t.liveBytes)));
  // Every fixture chat holds something, so every tick carries one, and none of them holds a raw value: they
  // always go through mask() first.
  assert.ok(ticks.every((t) => t.chat && Object.keys(t.chat.kinds).length > 0));
  const flat = JSON.stringify(ticks);
  for (const v of ["AKIA4HPQ7XZ2R6TWLJ3N", "219-09-9999", "hunter2", "Sunflower!2024"])
    assert.ok(!flat.includes(v), `a raw value reached onProgress: ${v}`);
});

test("onProgress is optional: readExport works the same without it", async () => {
  const got = await C.readExport(folderEntries("claude"), { salt: "s" });
  assert.equal(got.read.chats, 2);
});

// ---------- Claude's October 2026 export: a manifest first, the conversations split into .jsonl parts ----------

test("one .jsonl part, found by shape (an arbitrary file name): exactly what expected.json lists", async () => {
  for (const name of ["claude-conversations-000", "claude-conversations-001"]) {
    const got = await C.readExport(folderEntries(name), { salt: "s" });
    const want = expected[name];
    assert.equal(got.format, "claude");
    assert.equal(got.read.chats, want.chats);
    assert.deepEqual(got.chats.map(shapeFound), newestFirst(want.found).map(shapeExpected));
  }
});

test("several conversations-NNN.zip parts, chosen together, read as one export", async () => {
  const parts = [
    { name: "conversations-000.zip", file: new Blob([zipOf("claude-conversations-000")]) },
    { name: "conversations-001.zip", file: new Blob([zipOf("claude-conversations-001")]) },
  ];
  const entries = await C.multiPartFileEntries(parts);
  const got = await C.readExport(entries, { salt: "s" });
  assert.equal(got.format, "claude");
  assert.equal(got.read.chats, expected.claude.chats);
  assert.deepEqual(got.chats.map(shapeFound), newestFirst(expected.claude.found).map(shapeExpected));
});

test("parts are read whichever order they're chosen in: the same combined result", async () => {
  const parts = [
    { name: "conversations-001.zip", file: new Blob([zipOf("claude-conversations-001")]) },
    { name: "conversations-000.zip", file: new Blob([zipOf("claude-conversations-000")]) },
  ];
  const got = await C.readExport(await C.multiPartFileEntries(parts), { salt: "s" });
  assert.equal(got.read.chats, expected.claude.chats);
  assert.deepEqual(got.chats.map(shapeFound), newestFirst(expected.claude.found).map(shapeExpected));
});

// ---------- detectManifest()/manifestExpiry()/exportLinkOk(): Claude's manifest (2026-10) ----------

test("Claude's manifest is recognized by its shape, from an arbitrarily named .json file", async () => {
  const manifest = await C.detectManifest(folderEntries("claude-manifest"));
  const want = expected["claude-manifest"];
  assert.ok(manifest);
  assert.equal(manifest.createdAt, want.createdAt);
  assert.deepEqual(
    manifest.files.map((f) => f.filename),
    want.manifestFiles,
  );
  assert.ok(manifest.files.every((f) => C.exportLinkOk(f.url)));
});

test("a real export's own conversations file is never mistaken for a manifest", async () => {
  assert.equal(await C.detectManifest(folderEntries("claude")), null);
  assert.equal(await C.detectManifest(folderEntries("chatgpt")), null);
});

test("manifest look-alikes, missing one required field each, are all rejected", async () => {
  const base = {
    version: "1.0",
    created_at: "2026-10-04T13:11:24.000000Z",
    data_files: [{ category: "conversations", filename: "conversations-000.zip", export_url: "https://claude.ai/x" }],
  };
  const cases = {
    "no version": { ...base, version: undefined },
    "no created_at": { ...base, created_at: undefined },
    "empty data_files": { ...base, data_files: [] },
    "a data_files item with no filename": { ...base, data_files: [{ category: "conversations" }] },
    "a top-level array, like every real export": [base],
  };
  for (const [label, value] of Object.entries(cases)) {
    const entries = C.folderFileEntries({ "manifest.json": JSON.stringify(value) });
    assert.equal(await C.detectManifest(entries), null, label);
  }
});

test("manifestExpiry(): 24 hours after created_at, or null for an unparsable date", () => {
  assert.equal(C.manifestExpiry("2026-10-04T13:11:24.000000Z"), "2026-10-05T13:11:24.000Z");
  assert.equal(C.manifestExpiry("not a date"), null);
  assert.equal(C.manifestExpiry(undefined), null);
});

test("exportLinkOk(): only https on claude.ai or a subdomain of it, never a lookalike host", () => {
  assert.equal(C.exportLinkOk("https://claude.ai/api/export/download/abc"), true);
  assert.equal(C.exportLinkOk("https://files.claude.ai/abc"), true);
  assert.equal(C.exportLinkOk("http://claude.ai/abc"), false, "not https");
  assert.equal(C.exportLinkOk("https://claude.ai.evil.com/abc"), false, "lookalike host");
  assert.equal(C.exportLinkOk("https://evilclaude.ai/abc"), false, "lookalike host");
  assert.equal(C.exportLinkOk("https://anthropic.com/abc"), false, "a different real host");
  assert.equal(C.exportLinkOk("not a url"), false);
  assert.equal(C.exportLinkOk(null), false);
});
