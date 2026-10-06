// The backup file is what carries settings to a new computer. It's unreadable without its password, comes
// back exactly as it was sealed, and can't be used to smuggle anything extra into storage.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/backup.js");
const { Backup } = globalThis.Clotr;

const SETTINGS = {
  responses: { phone_number: "block", email: "log" },
  paused: { "chatgpt.com": true },
  siteModes: { "claude.ai": "block" },
  guided: { phone_number: 1727600000000 },
  advanced: true,
  replyCheck: false,
  keepDays: 730,
  largeText: true,
  lock: { salt: "ab".repeat(16), iterations: 150000, hash: "cd".repeat(32) },
  salt: "0123456789abcdef0123456789abcdef",
  vault: [{ kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "protect", added: 1 }],
  bandage: { "chatgpt.com": true, "claude.ai": false },
  tourniquet: { for: "adult", since: 1727800000000 },
};

test("backup: comes back exactly with the right password; the file shows nothing without it", async () => {
  const file = await Backup.seal(SETTINGS, "correct horse battery");
  for (const readable of ["0123456789abcdef", "phone_number", "chatgpt.com", "block", "cdcdcd", "adult"]) {
    assert.ok(!file.includes(readable), `readable in the file: ${readable}`);
  }
  assert.deepEqual(await Backup.open(file, "correct horse battery"), SETTINGS);
});

test("backup: a wrong password, a changed file or another file are refused", async () => {
  const file = await Backup.seal(SETTINGS, "correct horse battery");
  await assert.rejects(Backup.open(file, "correct horse batterY"), /wrong-password/);
  const parsed = JSON.parse(file);
  const bytes = Buffer.from(parsed.data, "base64");
  bytes[5] ^= 1; // one flipped bit
  await assert.rejects(
    Backup.open(JSON.stringify({ ...parsed, data: bytes.toString("base64") }), "correct horse battery"),
    /wrong-password/,
  );
  await assert.rejects(Backup.open('{"hello": 1}', "x"), /not-a-backup/);
  await assert.rejects(Backup.open("not json", "x"), /not-a-backup/);
  await assert.rejects(
    Backup.open(JSON.stringify({ ...parsed, kdf: { ...parsed.kdf, iterations: 10 } }), "x"),
    /not-a-backup/,
  );
});

test("backup: only known settings with sane values get through", () => {
  const dirty = {
    ...SETTINGS,
    events: [{ t: 1 }], // history never moves
    responses: { phone_number: "block", "bad key!": "block", email: "off" },
    paused: { "chatgpt.com": true, "evil.com/<x>": true, "claude.ai": "yes" },
    bandage: { "chatgpt.com": true, "evil.com/<x>": true, "claude.ai": "yes" },
    keepDays: 12,
    lock: { salt: "zz", iterations: 150000, hash: "cd".repeat(32) },
    salt: "not hex",
    advanced: "true",
  };
  const clean = Backup.clean(dirty);
  assert.deepEqual(clean.responses, { phone_number: "block" });
  assert.deepEqual(clean.paused, { "chatgpt.com": true });
  assert.deepEqual(clean.bandage, { "chatgpt.com": true });
  for (const k of ["events", "keepDays", "lock", "salt", "advanced"]) assert.ok(!(k in clean), `${k} got through`);
  assert.deepEqual(Backup.clean(SETTINGS), SETTINGS);
  assert.deepEqual(
    Object.keys(Backup.pick({ ...SETTINGS, events: [], spotted: {} })).sort(),
    Object.keys(SETTINGS).sort(),
  );
});

// Tourniquet moves with the settings as just one of two words and a time, nothing else. That way a changed
// file can't turn it into something that raises or lowers protection by surprise.
test("backup: Tourniquet moves; a bad one is dropped, by the same rule as sites.js", () => {
  require("../extension/sites.js");
  const { cleanTourniquet } = globalThis.ClotrSites;
  assert.ok(Backup.KEYS.includes("tourniquet"), "Tourniquet isn't one of the keys that move");
  assert.deepEqual(Backup.clean({ tourniquet: { for: "child", since: 5 } }).tourniquet, { for: "child", since: 5 });
  assert.deepEqual(Backup.clean({ tourniquet: { since: 0, for: "adult" } }).tourniquet, { for: "adult", since: 0 });
  for (const bad of [
    { for: "admin", since: 5 },
    { for: "teen", since: 5 },
    { for: "adult", since: "5" },
    { for: "adult", since: Infinity },
    { for: "adult", since: -1 },
    { for: "adult" },
    { for: "adult", since: 5, note: "hello" },
    ["adult", 5],
    "adult",
    null,
  ]) {
    assert.ok(!("tourniquet" in Backup.clean({ tourniquet: bad })), `kept: ${JSON.stringify(bad)}`);
    assert.equal(cleanTourniquet(bad), null, `sites.js keeps what the backup drops: ${JSON.stringify(bad)}`);
  }
});

// Clotr Antibody's one setting, "Check commands I copy on AI chats", is on until someone switches it off. A
// file from before it existed should leave it on, and only a true or false value is ever accepted.
test("backup: the command check's switch moves; a missing one stays on, anything but true or false is dropped", async () => {
  assert.ok(Backup.KEYS.includes("commandCheck"), "the command check's switch isn't one of the keys that move");
  const off = { ...SETTINGS, commandCheck: false };
  assert.equal(Backup.pick(off).commandCheck, false);
  const file = await Backup.seal(Backup.pick(off), "correct horse battery");
  assert.equal(Backup.clean(await Backup.open(file, "correct horse battery")).commandCheck, false);
  assert.ok(!("commandCheck" in Backup.clean(SETTINGS)), "a file without it says nothing about it");
  for (const bad of ["false", 0, null, { on: false }])
    assert.ok(!("commandCheck" in Backup.clean({ commandCheck: bad })), `kept: ${JSON.stringify(bad)}`);
});

// The "can't read pictures" note moves with the first-time tips, as the names only of the AI sites it showed on.
test("backup: the sites the picture note was shown on move too, as site names only", async () => {
  const withNote = { ...SETTINGS, picturesNoted: { "chatgpt.com": true, "claude.ai": true } };
  assert.ok(Backup.KEYS.includes("picturesNoted"));
  assert.deepEqual(Backup.pick(withNote).picturesNoted, withNote.picturesNoted);
  const file = await Backup.seal(Backup.pick(withNote), "correct horse battery");
  assert.deepEqual(Backup.clean(await Backup.open(file, "correct horse battery")), withNote);
  const clean = Backup.clean({
    picturesNoted: { "chatgpt.com": true, "evil.com/<x>": true, "claude.ai": "yes", "gemini.google.com": 1 },
  });
  assert.deepEqual(clean.picturesNoted, { "chatgpt.com": true });
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`ai${i}.example.org`, true]));
  assert.equal(Object.keys(Backup.clean({ picturesNoted: many }).picturesNoted).length, 200, "at most 200 sites");
});

// Every version of Clotr that brings settings in is tested against the same move file, in tests/fixtures/ and
// made by make-move-file.js. That's what proves a file made by an older Clotr still opens, here and in the apps.
test("backup: the shared move file still opens with its password, exactly as it was sealed", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "fixtures");
  const { password, settings } = JSON.parse(fs.readFileSync(path.join(dir, "move-file.json"), "utf8"));
  const file = fs.readFileSync(path.join(dir, "move-file.clotr"), "utf8");
  assert.deepEqual(await Backup.open(file, password), settings);
  assert.deepEqual(Backup.clean(settings), settings, "everything in it is something the extension keeps");
  await assert.rejects(Backup.open(file, `${password}!`), /wrong-password/);
});

// While the after-scam 30 days are running, the move file carries them with their stored dates, so the new
// computer counts from the same start. An ended one isn't carried, and the end's bookkeeping never moves.
test("backup: a running after_scam moves with its end; an ended one doesn't; the bookkeeping stays behind", () => {
  require("../extension/sites.js");
  const { cleanTourniquet } = globalThis.ClotrSites;
  const DAY = 86400000;
  const since = Date.UTC(2026, 9, 2, 15);
  const t = { for: "after_scam", since, until: since + 30 * DAY };
  const during = since + 4 * DAY;
  assert.deepEqual(Backup.clean({ tourniquet: t }, during).tourniquet, t);
  assert.deepEqual(Backup.pick({ tourniquet: t }, during).tourniquet, t);
  assert.ok(!("tourniquet" in Backup.clean({ tourniquet: t }, t.until)), "an ended one loaded");
  assert.ok(!("tourniquet" in Backup.pick({ tourniquet: t }, t.until)), "an ended one saved");
  for (const bad of [
    { ...t, until: since },
    { ...t, until: since + 62 * DAY },
    { ...t, note: "x" },
    { for: "adult", since, until: t.until },
    { for: "after_scam", since },
  ]) {
    assert.ok(!("tourniquet" in Backup.clean({ tourniquet: bad }, during)), `kept: ${JSON.stringify(bad)}`);
    assert.equal(cleanTourniquet(bad, during), null, `sites.js keeps what the backup drops: ${JSON.stringify(bad)}`);
  }
  for (const key of ["tourniquetEnded", "tourniquetSeen"]) assert.ok(!Backup.KEYS.includes(key), `${key} moves`);
});
