// The "What should I protect?" page (vault.html): what Save, Remove and OK to share do, and when they're refused.
// Run from the repo root: node --test tests/vault-page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeNode, loadPage, settle } = require("./fake-page.js");

// Not a real PIN record: the page only needs to know one is set.
const FAKE_LOCK = { salt: "00".repeat(16), iterations: 1, hash: "ab".repeat(32) };
const FAKE_SALT = "0123456789abcdef".repeat(2);
const ENTRY = { kind: "value", type: "email", fp: "f".repeat(16), scheme: 2, mode: "protect", added: 1 };

// The page, with one textarea per [type, kind, value] and a background that answers with `reply` (a function).
async function openVault({ local = {}, session = {}, boxes = [], reply } = {}) {
  const sent = [];
  const textareas = boxes.map(([type, kind, value]) =>
    Object.assign(new FakeNode("textarea", `f-${type}`), { value, dataset: { type, kind } }),
  );
  const page = loadPage(["patterns.js", "detector.js", "decide.js", "sites.js", "vault.js"], {
    local,
    session,
    hidden: ["vault-locked", "welcome", "allow-card", "where-offer"],
    selectorsAll: { "textarea[data-type]": textareas, textarea: textareas },
    sendMessage: async (m) => {
      sent.push(m);
      if (m.type === "clotr:getSalt") return { salt: FAKE_SALT };
      return reply ? reply(m) : {};
    },
  });
  await settle();
  return { ...page, sent, textareas, changes: () => sent.filter((m) => m.type !== "clotr:getSalt") };
}

// The list's first row: its OK-to-share choice and its Remove button.
const firstRow = (page) => {
  const li = page.$("vault-list").children[0];
  return {
    mode: li.children.find((c) => c.tagName === "SELECT"),
    remove: li.children.find((c) => c.tagName === "BUTTON"),
  };
};

test("vault page: unlocked within the 10 minutes, Remove and OK to share go through", async () => {
  const page = await openVault({
    local: { lock: FAKE_LOCK, vault: [ENTRY] },
    session: { unlockedUntil: Date.now() + 60_000 },
  });
  assert.equal(page.$("vault-form").hidden, false);
  const { mode, remove } = firstRow(page);
  mode.value = "allow";
  await mode.fire("change");
  await remove.fire("click");
  assert.deepEqual(
    page.changes().map((m) => m.change),
    ["allow", "remove"],
  );
});

test("vault page: once the 10 minutes are up, an open page saves, removes and shares nothing", async () => {
  const page = await openVault({
    local: { lock: FAKE_LOCK, vault: [ENTRY] },
    session: { unlockedUntil: Date.now() + 60_000 },
    boxes: [["watch_list", "word", "Project Falcon"]],
  });
  page.session.data.unlockedUntil = Date.now() - 1; // ran out, with nothing on the page told
  const { mode, remove } = firstRow(page);
  mode.value = "allow";
  await mode.fire("change");
  await remove.fire("click");
  await page.$("vault-form").fire("submit");
  await settle();
  assert.deepEqual(page.changes(), [], "nothing was sent to the background");
  assert.equal(page.$("vault-locked").hidden, false, "the locked note shows");
  assert.equal(page.$("vault-form").hidden, true);
  assert.equal(page.$("vault-list").hidden, true);
});

test("vault page: the unlock window ending in session storage locks an open page", async () => {
  const page = await openVault({
    local: { lock: FAKE_LOCK, vault: [ENTRY] },
    session: { unlockedUntil: Date.now() + 60_000 },
  });
  await page.session.set({ unlockedUntil: Date.now() - 1 });
  await settle();
  assert.equal(page.$("vault-locked").hidden, false);
  assert.equal(page.$("vault-form").hidden, true);
});

test("vault page: an open page locks itself when the 10 minutes run out", async () => {
  const page = await openVault({
    local: { lock: FAKE_LOCK, vault: [ENTRY] },
    session: { unlockedUntil: Date.now() + 80 },
  });
  assert.equal(page.$("vault-form").hidden, false);
  await new Promise((r) => setTimeout(r, 250));
  await settle();
  assert.equal(page.$("vault-locked").hidden, false);
  assert.equal(page.$("vault-form").hidden, true);
});

test("vault page: a locked page opens again once the PIN is entered in the popup, as its note says", async () => {
  const page = await openVault({
    local: { lock: FAKE_LOCK, vault: [ENTRY] },
    session: { unlockedUntil: Date.now() - 1 },
  });
  assert.equal(page.$("vault-locked").hidden, false);
  await page.session.set({ unlockedUntil: Date.now() + 60_000 });
  await settle();
  assert.equal(page.$("vault-locked").hidden, true);
  assert.equal(page.$("vault-form").hidden, false);
  assert.equal(page.$("vault-list").hidden, false);
  assert.equal(page.$("vault-lead").hidden, false);
  assert.equal(page.$("vault-empty").hidden, true, "the vault has an entry, so it isn't called empty");
  const { remove } = firstRow(page);
  await remove.fire("click");
  assert.deepEqual(
    page.changes().map((m) => m.change),
    ["remove"],
  );
});

// ---------- Save: the typed lines go only once the background has them ----------

// The background's vaultAdd (background.js): what cleanVaultEntry refuses is counted as rejected.
function backgroundVault() {
  const kept = [];
  const key = (e) => (e.kind === "shape" ? `shape:${e.type}:${e.shape.toLowerCase()}` : `${e.kind}:${e.type}:${e.fp}`);
  return {
    kept,
    reply: (m, Clotr) => {
      const clean = m.entries.map(Clotr.cleanVaultEntry).filter(Boolean);
      const before = new Set(kept.map(key));
      const added = clean.filter((e) => !before.has(key(e)));
      kept.push(...added);
      return { added: added.length, rejected: m.entries.length - clean.length };
    },
  };
}
const watchBox = (value) => [["watch_list", "word", value]];

test("vault page: a saved watch format clears its box and says it was saved", async () => {
  const bg = backgroundVault();
  const page = await openVault({ boxes: watchBox("EMP-#####"), reply: (m) => bg.reply(m, page.ctx.Clotr) });
  await page.$("vault-form").fire("submit");
  assert.equal(bg.kept.length, 1);
  assert.equal(page.textareas[0].value, "");
  assert.equal(page.$("save-msg").textContent, "Saved 1 new item.");
});

test("vault page: saving one already there says so", async () => {
  const bg = backgroundVault();
  const page = await openVault({ boxes: watchBox("EMP-#####"), reply: (m) => bg.reply(m, page.ctx.Clotr) });
  await page.$("vault-form").fire("submit");
  page.textareas[0].value = "EMP-#####";
  await page.$("vault-form").fire("submit");
  assert.equal(page.$("save-msg").textContent, "Saved 0 new items. · 1 already there.");
});

test("vault page: a format Clotr can't keep stays in its box and isn't called already there", async () => {
  const bg = backgroundVault();
  const tooLong = `${"@@@@-".repeat(9)}####`; // a made-up format over 40 characters
  const page = await openVault({ boxes: watchBox(tooLong), reply: (m) => bg.reply(m, page.ctx.Clotr) });
  await page.$("vault-form").fire("submit");
  assert.equal(bg.kept.length, 0);
  assert.equal(page.textareas[0].value, tooLong, "the line stays to fix");
  const said = page.$("save-msg").textContent;
  assert.doesNotMatch(said, /already there|Saved/);
  assert.match(said, /40 characters/);
});

test("vault page: when the background answers with an error, the typed lines stay and the page says so", async () => {
  const page = await openVault({ boxes: watchBox("Project Falcon"), reply: () => ({ error: "Error: made up" }) });
  await page.$("vault-form").fire("submit");
  assert.equal(page.textareas[0].value, "Project Falcon");
  assert.equal(page.$("save-msg").textContent, "Couldn't save right now. Try again.");
});

test("vault page: when the background can't be reached, the typed lines stay and the page says so", async () => {
  const page = await openVault({
    boxes: watchBox("Project Falcon"),
    reply: () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
  });
  await page.$("vault-form").fire("submit");
  assert.equal(page.textareas[0].value, "Project Falcon");
  assert.equal(page.$("save-msg").textContent, "Couldn't save right now. Try again.");
});

// ---------- Words to watch for: a format, or a phrase that happens to have a # in it ----------

test("vault page: a watch phrase with a number after its # is kept as a phrase, not refused as a format", async () => {
  const bg = backgroundVault();
  const page = await openVault({ boxes: watchBox("Project #2"), reply: (m) => bg.reply(m, page.ctx.Clotr) });
  await page.$("vault-form").fire("submit");
  assert.deepEqual(
    bg.kept.map((e) => [e.kind, e.words]),
    [["word", 2]],
  );
  assert.equal(page.textareas[0].value, "");
  assert.equal(page.$("save-msg").textContent, "Saved 1 new item.");
  // And the phrase it keeps is the one found in a message.
  const { Clotr } = page.ctx;
  Clotr.setVault({ salt: FAKE_SALT, entries: bg.kept });
  const found = Clotr.detect("notes about Project #2 for later").find((r) => r.id === "watch_list");
  assert.deepEqual([...(found?.matches || [])], ["Project #2"]);
});

test("vault page: a format with too few marks is still refused, saying what the marks stand for", async () => {
  const page = await openVault({ boxes: watchBox("EMP-##") });
  await page.$("vault-form").fire("submit");
  assert.equal(page.textareas[0].value, "EMP-##");
  const said = page.$("save-msg").textContent;
  assert.match(said, /^Watch word: "EMP-##" a format needs 4\+ # or @ marks/);
  assert.match(said, /# .*digit.*@ .*letter/);
});
