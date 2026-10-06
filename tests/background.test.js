// Safari loads the background script as a page from its own script list, with fewer APIs than Chrome has.
// These tests load the real files into a bare JavaScript context with a stand-in chrome object that only has
// what Safari has, and check that Clotr's bookkeeping still works there and stays the same in Chrome.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto, createHash } = require("crypto");
const { safariManifest } = require("../tools/package.js");

const EXT = path.join(__dirname, "..", "extension");
const source = () => JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const settle = () => new Promise((r) => setTimeout(r, 30));
// Replies come from inside the test's own JavaScript context, so I make a plain copy to compare by value.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

const event = () => {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn) };
};

// Stands in for a storage area kept in memory, with the same get, set and remove shapes Clotr uses.
function area() {
  const data = {};
  const pick = (keys) => {
    if (keys == null) return { ...data };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
  };
  return {
    data,
    get: async (keys) => pick(keys),
    set: async (items) => void Object.assign(data, structuredClone(items)),
    remove: async (keys) => [].concat(keys).forEach((k) => delete data[k]),
  };
}

// The browser argument picks the environment to load: "safari" for Safari 17 (no managed storage, no
// declarativeContent, no storage lock, and a badge color it rejects as a string), "safari-no-session" for the
// same thing without session storage, or "chrome" for an unpacked Chrome copy. The chromeManifest option
// simulates Safari running the Chrome build's manifest, which happens when someone packages the app without a
// dedicated Safari build.
function loadBackground(browser, { chromeManifest = false } = {}) {
  const safari = browser.startsWith("safari");
  const manifest = safari && !chromeManifest ? safariManifest(source()) : source();
  const calls = { alarms: [], alarmAt: {}, cleared: [], badge: [], colors: [], errors: [], sent: [], reloads: 0 };
  const local = area();
  const session = browser === "safari-no-session" ? undefined : area();
  const chrome = {
    runtime: {
      id: "clotr-test",
      getManifest: () => manifest,
      getURL: (p) => `${safari ? "safari-web-extension" : "chrome-extension"}://clotr-test/${p}`,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      onConnect: event(), // the tab port that keeps a sleeping background awake
      reload: () => calls.reloads++,
    },
    storage: { local, onChanged: event(), ...(session ? { session } : {}) },
    action: {
      setTitle: async () => {},
      setIcon: async () => {},
      setBadgeText: async ({ tabId, text }) => void calls.badge.push({ tabId, text }),
      setBadgeBackgroundColor: ({ color }) => {
        // Safari only accepts an array for the badge color and otherwise ignores it. A string throws here
        // so a wrong call fails loudly instead of silently doing nothing.
        if (safari && typeof color === "string") throw new TypeError("color: an array is expected");
        calls.colors.push(color);
        return Promise.resolve();
      },
    },
    alarms: {
      create: (name, info) => {
        calls.alarms.push(name);
        calls.alarmAt[name] = info?.when;
      },
      clear: async (name) => {
        calls.cleared.push(name);
        return delete calls.alarmAt[name];
      },
      onAlarm: event(),
    },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      query: async (q) => (q?.active ? [{ id: 9 }] : []),
      create: async () => ({}),
      sendMessage: async (tabId, msg) => {
        calls.sent.push({ tabId, type: msg?.type });
        throw new Error("no Clotr in this tab");
      },
    },
    permissions: { getAll: async () => ({ origins: [] }), onAdded: event(), onRemoved: event() },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      updateContentScripts: async () => {},
      executeScript: async () => [],
    },
    commands: { onCommand: event() },
    i18n: { getMessage: () => "" },
  };
  if (!safari) {
    chrome.storage.managed = { get: async () => ({}) };
    chrome.storage.local.setAccessLevel = async () => {};
    chrome.declarativeContent = undefined; // spotting unprotected sites needs a canvas, outside what these tests check
  }
  const quiet = { info() {}, log() {}, warn() {}, debug() {}, error: (...a) => calls.errors.push(a.join(" ")) };
  const context = vm.createContext({
    chrome,
    console: quiet,
    URL,
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("no network in tests");
    },
  });
  // Safari runs the background scripts in order on a page, since it has no importScripts to load them another way.
  for (const file of manifest.background.scripts || [
    "sites.js",
    "patterns.js",
    "detector.js",
    "decide.js",
    "helper-core.js",
    "backup.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), context, { filename: file });
  }
  if (!manifest.background.scripts)
    vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), context, { filename: "background.js" });
  // Date.now here is replaceable, so a test can move the clock with setNow. It reads the real time until one does.
  vm.runInContext("{ const real = Date.now; Date.now = () => globalThis.__now ?? real(); }", context);
  const setNow = (t) => {
    context.__now = t;
  };

  const send = (msg, sender = {}) =>
    new Promise((resolve) => {
      const handled = chrome.runtime.onMessage.listeners[0](
        msg,
        { id: chrome.runtime.id, url: "https://chatgpt.com/c/1", ...sender },
        (reply) => resolve(plain(reply)),
      );
      if (!handled) resolve(undefined);
    });
  const install = async (reason = "install") => {
    for (const fn of chrome.runtime.onInstalled.listeners) fn({ reason });
    await settle();
  };
  return { chrome, calls, local, session, send, install, manifest, setNow };
}

const tab = { id: 7, url: "https://chatgpt.com/c/1" };
const todaysEvent = () => ({
  t: Date.now(),
  site: "chatgpt.com",
  type: "credit_card",
  name: "Credit card",
  severity: "high",
  action: "allowed",
  fp: "0123456789abcdef",
});

test("Safari: the background loads from the Safari build's script list and installs without an error", async () => {
  for (const browser of ["safari", "safari-no-session"]) {
    const bg = loadBackground(browser);
    assert.deepEqual(bg.manifest.background, {
      scripts: ["patterns.js", "detector.js", "decide.js", "helper-core.js", "backup.js", "sites.js", "background.js"],
    });
    await bg.install();
    assert.deepEqual(bg.calls.errors, [], `${browser}: errors at install`);
    assert.match(bg.local.data.salt, /^[0-9a-f]{32}$/, `${browser}: the salt is made`);
  }
});

test("Safari without session storage: protected tabs are kept in memory, so the badge still works", async () => {
  const bg = loadBackground("safari-no-session");
  await bg.install();
  assert.deepEqual(await bg.send({ type: "clotr:tabState", paused: false }, { tab }), { ok: true });
  assert.deepEqual(await bg.send({ type: "clotr:health", editor: true }, { tab }), { ok: true });
  const reply = await bg.send({ type: "clotr:events", events: [todaysEvent()] }, { tab });
  assert.equal(reply.count, 1);
  assert.deepEqual(bg.calls.badge.at(-1), { tabId: 7, text: "1" }, "the tab's count is on its badge");
  // A health report that the edit failed outranks the count, as in Chrome.
  await bg.send({ type: "clotr:health", editFailed: true }, { tab });
  assert.deepEqual(bg.calls.badge.at(-1), { tabId: 7, text: "!" });
  // Closing the tab forgets it.
  for (const fn of bg.chrome.tabs.onRemoved.listeners) fn(7);
  const before = bg.calls.badge.length;
  await bg.send({ type: "clotr:events", events: [todaysEvent()] }, { tab: { id: 8 } });
  assert.ok(!bg.calls.badge.slice(before).some((b) => b.tabId === 7), "a closed tab still got a badge");
});

test("Safari: a badge colour Safari refuses never makes Clotr forget the tab", async () => {
  const bg = loadBackground("safari");
  await bg.install();
  await bg.send({ type: "clotr:tabState", paused: false }, { tab });
  await bg.send({ type: "clotr:events", events: [todaysEvent()] }, { tab });
  assert.ok(bg.session.data.protectedTabs?.[7], "the tab was dropped from the protected list");
  // The popup reads the tab's state here, so it has to stay.
  await bg.send({ type: "clotr:events", events: [todaysEvent()] }, { tab });
  assert.deepEqual(bg.calls.badge.at(-1), { tabId: 7, text: "2" });
});

test("Safari: no local update check in a store install (the app updates it)", async () => {
  const bg = loadBackground("safari");
  await bg.install("update");
  for (const fn of bg.chrome.runtime.onStartup.listeners) fn();
  await settle();
  assert.ok(!bg.calls.alarms.includes("local-update-check"), "Safari got the one-minute update check");
  assert.ok(bg.calls.alarms.includes("refresh-toolbar"), "the toolbar's half-hourly refresh still runs");
  assert.equal(bg.calls.reloads, 0);
  // Safari's own address for the extension's files tells it too, whichever manifest the app was made from.
  const fromChromeBuild = loadBackground("safari", { chromeManifest: true });
  await fromChromeBuild.install("update");
  assert.ok(!fromChromeBuild.calls.alarms.includes("local-update-check"), "Safari got the update check");
});

test("Safari: no managed storage, and settings still reach the page (no team policy)", async () => {
  const bg = loadBackground("safari");
  await bg.install();
  await bg.local.set({ responses: { credit_card: "block" }, paused: { "chatgpt.com": true } });
  const s = await bg.send({ type: "clotr:getSettings" }, { tab });
  assert.equal(s.responses.credit_card, "block");
  assert.equal(s.paused, true);
  assert.deepEqual(s.vault, []);
});

test("Chrome stays as it was: session storage holds the tabs, string colours, the update check when unpacked", async () => {
  const bg = loadBackground("chrome");
  await bg.install();
  assert.ok(bg.calls.alarms.includes("local-update-check"), "an unpacked copy still checks its folder");
  await bg.send({ type: "clotr:tabState", paused: false }, { tab });
  await bg.send({ type: "clotr:events", events: [todaysEvent()] }, { tab });
  assert.ok(bg.session.data.protectedTabs?.[7], "the popup reads protected tabs from session storage");
  assert.deepEqual(bg.calls.colors.at(-1), "#d03b3b", "a risky send turns the badge red, as before");
  assert.deepEqual(bg.calls.errors, []);
});

// Safari versions before 18 don't tell the handler which tab a keyboard shortcut was pressed in.
test("Safari 17: Alt+Shift+C still jumps to the warning, in the tab in front", async () => {
  const bg = loadBackground("safari");
  const [onCommand] = bg.chrome.commands.onCommand.listeners;
  onCommand("focus-notice"); // no tab given
  await settle();
  assert.deepEqual(bg.calls.sent, [{ tabId: 9, type: "clotr:focusNotice" }]);
  onCommand("focus-notice", { id: 4 }); // Chrome, Firefox and Safari 18 name the tab: that one
  await settle();
  assert.deepEqual(bg.calls.sent.at(-1), { tabId: 4, type: "clotr:focusNotice" });
  onCommand("something-else");
  await settle();
  assert.equal(bg.calls.sent.length, 2);
});

// Turning on "Ask before sending personal details" should survive an update. If every personal kind Clotr
// already knew was set to ask first, a new personal kind the update adds should ask first too. Clotr keeps a
// list of the kind names it knows, so it can tell a brand new kind apart from one it already had.
test("Update: new personal kinds follow Ask before sending personal details, in Chrome and Safari", async () => {
  require("../extension/patterns.js");
  const { PATTERNS } = globalThis.Clotr;
  const ids = PATTERNS.map((p) => p.id);
  const personal = PATTERNS.filter((p) => p.group === "personal").map((p) => p.id);
  const brought = personal.slice(-2);
  const before = ids.filter((id) => !brought.includes(id));
  const ask = (list) => Object.fromEntries(list.map((id) => [id, "block"]));
  const idle = async () => {
    for (let i = 0; i < 5; i++) await settle();
  };
  for (const browser of ["chrome", "safari"]) {
    // On a fresh install there's nothing to follow yet, so Clotr just notes the kinds it knows.
    const fresh = loadBackground(browser);
    await fresh.install("install");
    await idle();
    assert.deepEqual(plain(fresh.local.data.knownKinds), ids, `${browser}: kinds noted on install`);
    assert.equal(fresh.local.data.responses, undefined, `${browser}: an install changed responses`);
    // The setting was already on, and the update adds two new personal kinds, so those ask first too.
    const on = loadBackground(browser);
    on.local.data.knownKinds = before;
    on.local.data.responses = { ...ask(personal.filter((id) => !brought.includes(id))), password: "warn" };
    await on.install("update");
    await idle();
    for (const id of brought) assert.equal(on.local.data.responses[id], "block", `${browser}: ${id} after the update`);
    assert.equal(on.local.data.responses.password, "warn", `${browser}: another kind changed`);
    assert.deepEqual(plain(on.local.data.knownKinds), ids, `${browser}: kinds noted after the update`);
    // If someone had only a few kinds set to ask, the same update leaves their choices untouched.
    const few = loadBackground(browser);
    few.local.data.knownKinds = before;
    few.local.data.responses = { phone_number: "block", email: "block" };
    await few.install("update");
    await idle();
    assert.deepEqual(plain(few.local.data.responses), { phone_number: "block", email: "block" }, browser);
    assert.deepEqual([...fresh.calls.errors, ...on.calls.errors, ...few.calls.errors], [], browser);
  }
});

// The background folds a long batch of events into one summary record before writing it, and only its own
// count is trusted, since a page can't report a count for itself. The badge still counts every detail that arrived.
test("A long list sent at once: one record for the rest, a page's own count ignored, the badge counts all", async () => {
  const bg = loadBackground("chrome");
  await bg.install();
  await bg.send({ type: "clotr:tabState", paused: false }, { tab });
  const list = Array.from({ length: 300 }, (_, i) => ({
    ...todaysEvent(),
    type: "email",
    name: "Email Address",
    severity: "low",
    fp: (i + 1).toString(16).padStart(16, "0"),
    n: 99999,
  }));
  const reply = await bg.send({ type: "clotr:events", events: list }, { tab });
  assert.equal(reply.count, 300, "the reply counts what arrived");
  const stored = bg.local.data.events;
  assert.equal(stored.length, 11);
  assert.ok(
    stored.slice(0, 10).every((e) => !("n" in e) && /^[0-9a-f]{16}$/.test(e.fp)),
    "the first ten are ordinary records",
  );
  assert.equal(stored[10].n, 290);
  assert.equal(stored[10].fp, "");
  assert.deepEqual(bg.calls.badge.at(-1), { tabId: 7, text: "300" }, "the badge counts the whole list");
  assert.deepEqual(bg.calls.errors, []);
});

// Clotr shows the "can't read pictures" note once per AI site. Only the background writes down which sites
// have seen it, and it reads the site from the asking frame's own address, so a page can never write an entry
// for another site.
test("The picture note: the background records the asking frame's own site, names only, at most 200", async () => {
  const bg = loadBackground("chrome");
  await bg.install();
  assert.equal((await bg.send({ type: "clotr:getSettings" })).pictureNoted, false);
  const reply = await bg.send({ type: "clotr:pictureNoted", host: "claude.ai", picturesNoted: { "x.com": true } });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(bg.local.data.picturesNoted, { "chatgpt.com": true }, "the sender's site, nothing else");
  assert.equal((await bg.send({ type: "clotr:getSettings" })).pictureNoted, true);
  const claude = { url: "https://claude.ai/new" };
  assert.equal((await bg.send({ type: "clotr:getSettings" }, claude)).pictureNoted, false, "per site");
  await bg.send({ type: "clotr:pictureNoted" }, claude);
  assert.deepEqual(Object.keys(bg.local.data.picturesNoted), ["chatgpt.com", "claude.ai"]);
  // Clotr keeps at most 200 sites, dropping the oldest first.
  for (let i = 0; i < 205; i++) await bg.send({ type: "clotr:pictureNoted" }, { url: `https://ai${i}.example.org/` });
  const sites = Object.keys(bg.local.data.picturesNoted);
  assert.equal(sites.length, 200);
  assert.ok(!sites.includes("chatgpt.com") && sites.includes("ai204.example.org"));
  assert.ok(Object.values(bg.local.data.picturesNoted).every((v) => v === true));
  // A frame without an address of its own records nothing.
  assert.ok((await bg.send({ type: "clotr:pictureNoted" }, { url: "not an address" })).error);
  assert.deepEqual(bg.calls.errors, []);
});

// A warning's "Get a second opinion" link opens Clotr's own "Is this a scam?" page beside the chat. It always
// opens that same page, never one built from what the chat message said, and the new tab's address carries
// nothing from the chat. If the browser won't open it in that exact spot, the page still opens somewhere else,
// and the warning itself is left alone either way.
test("Get a second opinion opens Is this a scam? beside the chat, only that page, with nothing from the chat", async () => {
  for (const browser of ["chrome", "safari"]) {
    const bg = loadBackground(browser);
    await bg.install();
    const opened = [];
    bg.chrome.tabs.create = async (o) => void opened.push(plain(o));
    const chat = { tab: { id: 7, index: 2, windowId: 3, url: "https://chatgpt.com/c/1" } };
    const reply = await bg.send({ type: "clotr:openCheck", url: "https://evil.example/", text: "482" }, chat);
    await settle();
    assert.equal(reply, undefined, "nothing to answer");
    const page = bg.chrome.runtime.getURL("check.html");
    assert.deepEqual(opened, [{ url: page, windowId: 3, index: 3 }], browser);
    // Without a tab to open it beside, it opens at the end of the window instead; if even that spot is refused,
    // it falls back to opening the page plainly.
    opened.length = 0;
    await bg.send({ type: "clotr:openCheck" });
    await settle();
    assert.deepEqual(opened, [{ url: page }]);
    opened.length = 0;
    bg.chrome.tabs.create = async (o) => {
      if (o.index !== undefined) throw new Error("no such index");
      opened.push(plain(o));
    };
    await bg.send({ type: "clotr:openCheck" }, chat);
    await settle();
    assert.deepEqual(opened, [{ url: page }]);
    bg.chrome.tabs.create = () => {
      throw new Error("no tabs here");
    };
    await bg.send({ type: "clotr:openCheck" }, chat);
    await settle();
    // Another extension's message opens nothing.
    opened.length = 0;
    bg.chrome.tabs.create = async (o) => void opened.push(plain(o));
    await bg.send({ type: "clotr:openCheck" }, { id: "someone-else", ...chat });
    await settle();
    assert.deepEqual(opened, []);
    assert.deepEqual(bg.calls.errors, []);
  }
});

// A page's settings always include the salt its words were fingerprinted with. The page used to ask for the
// salt separately, but that answer could arrive after the settings did, and anything sent in between went
// unchecked against a team's word list.
test("Settings come with the salt that fingerprinted the team's words, the one kept", async () => {
  const bg = loadBackground("chrome");
  bg.chrome.storage.managed.get = async () => ({
    watchWords: ["Acme Holdings"],
    requiredResponses: { watch_list: "block" },
  });
  const settings = await bg.send({ type: "clotr:getSettings" }, { tab });
  assert.match(settings.salt, /^[0-9a-f]{32}$/);
  assert.equal(settings.salt, bg.local.data.salt, "the salt kept");
  assert.equal((await bg.send({ type: "clotr:getSalt" }, { tab })).salt, settings.salt, "the same one asked for alone");
  const fp = createHash("sha256").update(`${settings.salt}watch_list:acme holdings`).digest("hex").slice(0, 16);
  assert.ok(
    settings.vault.some((e) => e.managed && e.fp === fp),
    "the team's word, fingerprinted with that salt",
  );
  assert.deepEqual(bg.calls.errors, []);
});

// Teams can hold a risky send for review. The chat page only ever learns a single yes or no, decided by the
// organization's own policy, never by Tourniquet, and never the organization's name or policy details themselves.
test("teamHold reaches the page: on under a policy that asks before sending, off otherwise", async () => {
  const bg = loadBackground("chrome");
  await bg.install();
  const settings = async (managed) => {
    bg.chrome.storage.managed.get = async () => managed;
    return bg.send({ type: "clotr:getSettings" }, { tab });
  };
  const clinic = await settings({ preset: "clinic", orgName: "Riverside Clinic" });
  assert.equal(clinic.teamHold, true);
  assert.ok(!JSON.stringify(clinic).includes("Riverside"), "the organization's name reached the page");
  assert.equal((await settings({ requiredResponses: { email: "warn" } })).teamHold, false);
  assert.equal((await settings({})).teamHold, false);
  await bg.local.set({ tourniquet: { for: "child", since: Date.now() } });
  const tq = await settings({});
  assert.equal(tq.responses.us_ssn, "block", "Tourniquet asks for itself");
  assert.equal(tq.teamHold, false, "Tourniquet isn't an organization");
  assert.deepEqual(bg.calls.errors, []);
});

// After a scam, Tourniquet turns on for 30 days and then turns itself off, announcing that once. The day
// count is read from this computer's clock against the stored start and end dates, so moving the clock back or
// forward never quietly adds or removes days.
const DAY = 86400000;
const SINCE = Date.UTC(2026, 9, 2, 15);
const AFTER_SCAM = { for: "after_scam", since: SINCE, until: SINCE + 30 * DAY };
// Mimics the storage-change event the browser fires after a page writes to storage.
const changed = async (bg, changes) => {
  for (const fn of bg.chrome.storage.onChanged.listeners) fn(changes, "local");
  await settle();
};
const fire = async (bg, name) => {
  for (const fn of bg.chrome.alarms.onAlarm.listeners) fn({ name });
  await settle();
};

test("After a scam: turning it on sets the end alarm at the stored end; a start re-creates it from storage", async () => {
  for (const browser of ["chrome", "safari"]) {
    const bg = loadBackground(browser);
    bg.setNow(SINCE);
    await bg.install("update");
    await bg.local.set({ tourniquet: AFTER_SCAM });
    await changed(bg, { tourniquet: { newValue: AFTER_SCAM } });
    assert.equal(bg.calls.alarmAt["tourniquet-end"], AFTER_SCAM.until, `${browser}: the alarm at the end`);
    assert.equal(bg.local.data.tourniquetSeen, SINCE, `${browser}: the latest time seen`);
    // Alarms don't survive every update or restart, so starting the browser again has to set this one again.
    delete bg.calls.alarmAt["tourniquet-end"];
    bg.setNow(SINCE + 2 * DAY);
    for (const fn of bg.chrome.runtime.onStartup.listeners) fn();
    await settle();
    assert.equal(bg.calls.alarmAt["tourniquet-end"], AFTER_SCAM.until, `${browser}: not set again at start`);
    assert.equal(bg.local.data.tourniquetSeen, SINCE + 2 * DAY);
    // When a tab asks for its settings, it gets the preset's name and the adult policy's rules.
    const s = await bg.send({ type: "clotr:getSettings" }, { tab });
    assert.equal(s.tourniquet, "after_scam");
    assert.equal(s.responses.credit_card, "block");
    assert.equal(s.largeText, true);
    assert.deepEqual(bg.calls.errors, [], browser);
  }
});

test("After a scam: the alarm at its end turns it off and keeps one note for the popup; open tabs step down", async () => {
  const bg = loadBackground("chrome");
  bg.setNow(SINCE + 29 * DAY);
  await bg.install("update");
  await bg.local.set({ tourniquet: AFTER_SCAM, tourniquetSeen: SINCE + 29 * DAY });
  bg.setNow(AFTER_SCAM.until + 1000);
  await fire(bg, "tourniquet-end");
  assert.equal(bg.local.data.tourniquet, undefined, "still on after its end");
  assert.equal(bg.local.data.tourniquetSeen, undefined, "the mark outlived the 30 days");
  assert.deepEqual(plain(bg.local.data.tourniquetEnded), { since: SINCE, at: AFTER_SCAM.until });
  assert.ok(bg.calls.cleared.includes("tourniquet-end"));
  // Even before the alarm fires, a tab that asks for settings after the end date gets no Tourniquet, because
  // the read itself also checks the time.
  const late = loadBackground("chrome");
  await late.local.set({ tourniquet: AFTER_SCAM });
  late.setNow(AFTER_SCAM.until);
  const s = await late.send({ type: "clotr:getSettings" }, { tab });
  assert.equal(s.tourniquet, null);
  assert.equal(s.largeText, false);
  assert.deepEqual([...bg.calls.errors, ...late.calls.errors], [], "an ended record isn't a bad value");
});

test("After a scam: a record already past its end when the browser starts is ended the same way", async () => {
  const bg = loadBackground("chrome");
  await bg.local.set({ tourniquet: AFTER_SCAM });
  bg.setNow(AFTER_SCAM.until + 3 * DAY); // the computer was off on the day it ended
  for (const fn of bg.chrome.runtime.onStartup.listeners) fn();
  await settle();
  assert.equal(bg.local.data.tourniquet, undefined);
  assert.deepEqual(plain(bg.local.data.tourniquetEnded), { since: SINCE, at: AFTER_SCAM.until }, "the stored end");
});

test("After a scam, moving the clock back keeps the stored dates and adds nothing quietly, and moving it forward then back turns Tourniquet on again", async () => {
  const bg = loadBackground("chrome");
  bg.setNow(SINCE + 10 * DAY);
  await bg.install("update");
  await bg.local.set({ tourniquet: AFTER_SCAM });
  await changed(bg, { tourniquet: { newValue: AFTER_SCAM } });
  // Moving the clock back a week leaves Tourniquet on with its original dates, and the mark stays at the
  // latest time actually seen, which is what the popup reports.
  bg.setNow(SINCE + 3 * DAY);
  await fire(bg, "refresh-toolbar");
  assert.deepEqual(plain(bg.local.data.tourniquet), AFTER_SCAM, "the stored dates were rewritten");
  assert.equal(bg.local.data.tourniquetSeen, SINCE + 10 * DAY, "the mark went down with the clock");
  assert.equal(bg.calls.alarmAt["tourniquet-end"], AFTER_SCAM.until, "the end moved");
  // Moving the clock forward past the end turns it off, and that's announced once.
  bg.setNow(AFTER_SCAM.until + 40 * DAY);
  await fire(bg, "tourniquet-end");
  assert.equal(bg.local.data.tourniquet, undefined);
  assert.ok(bg.local.data.tourniquetEnded);
  // Moving the clock back to the real date, before anyone saw the end, finds the stored dates still inside
  // the 30 days, so Tourniquet turns back on.
  bg.setNow(SINCE + 11 * DAY);
  await fire(bg, "refresh-toolbar");
  assert.deepEqual(plain(bg.local.data.tourniquet), AFTER_SCAM, "not back on with its own dates");
  assert.equal(bg.local.data.tourniquetEnded, undefined);
  assert.equal(bg.local.data.tourniquetSeen, AFTER_SCAM.until, "the popup can't tell the clock went back");
  assert.equal(bg.calls.alarmAt["tourniquet-end"], AFTER_SCAM.until);
  // If the person turns it off, nothing comes back on its own: no alarm, no mark.
  await bg.local.remove("tourniquet");
  await changed(bg, { tourniquet: { oldValue: AFTER_SCAM } });
  assert.equal(bg.local.data.tourniquetSeen, undefined);
  assert.equal(bg.calls.alarmAt["tourniquet-end"], undefined);
  bg.setNow(SINCE + 12 * DAY);
  await fire(bg, "refresh-toolbar");
  assert.equal(bg.local.data.tourniquet, undefined, "turned off, then back on by itself");
  assert.deepEqual(bg.calls.errors, []);
});

// When the extension reloads, the worker that's going away can still be registering the added sites' script
// as the new one starts, so the new worker finds nothing registered and then hears the ID is taken.
test("Added sites: a script another worker registered in the meantime is updated, not registered twice", async () => {
  const bg = loadBackground("chrome");
  const registered = new Map([["clotr-user-sites", { id: "clotr-user-sites", matches: ["https://old.example/*"] }]]);
  let missed = false;
  const updated = [];
  bg.chrome.permissions.getAll = async () => ({ origins: ["https://chat.example/*"] });
  Object.assign(bg.chrome.scripting, {
    // The first lookup for the added sites misses the registration still in flight from the old worker.
    getRegisteredContentScripts: async ({ ids }) => {
      if (ids.includes("clotr-user-sites") && !missed) return ((missed = true), []);
      return ids.filter((id) => registered.has(id)).map((id) => registered.get(id));
    },
    registerContentScripts: async (scripts) => {
      for (const s of scripts) if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
      for (const s of scripts) registered.set(s.id, s);
    },
    updateContentScripts: async (scripts) => {
      for (const s of scripts) updated.push(s.matches);
      for (const s of scripts) registered.set(s.id, { ...registered.get(s.id), ...s });
    },
  });
  for (const fn of bg.chrome.runtime.onStartup.listeners) fn();
  await settle();
  assert.deepEqual(bg.calls.errors, []);
  assert.deepEqual(plain(updated), [["https://chat.example/*"]]);
  assert.deepEqual(plain(registered.get("clotr-user-sites").matches), ["https://chat.example/*"]);
});
