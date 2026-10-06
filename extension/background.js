// The background service worker. It's the only place that writes the event log and the fingerprint salt, so
// two AI tabs writing at once can't clobber each other, and it only ever stores metadata, never a detected
// value. It also owns the toolbar icon and badge, and registers Clotr on AI sites the user adds themselves.
"use strict";

// Chrome loads these with importScripts; Firefox and Safari list them before this file in the manifest instead
// (tools/package.js --firefox, --safari).
if (typeof importScripts === "function" && !globalThis.ClotrSites) importScripts("sites.js");
if (typeof importScripts === "function" && !globalThis.Clotr?.fingerprint) importScripts("patterns.js", "detector.js");
if (typeof importScripts === "function" && !globalThis.Clotr?.cleanVaultEntry) importScripts("decide.js");
if (typeof importScripts === "function" && !globalThis.Clotr?.Helper) importScripts("helper-core.js");
if (typeof importScripts === "function" && !globalThis.Clotr?.Backup) importScripts("backup.js");

const LOG = "[Clotr]";

// Session storage holds which tabs Clotr runs in; it clears when the browser closes. Safari only added it in
// 16.4, so older browsers fall back to an in-memory copy that lasts as long as the worker does.
const sessionArea = chrome.storage.session || memoryStorage();
function memoryStorage() {
  const data = new Map();
  const copy = (v) => JSON.parse(JSON.stringify(v)); // stored values are JSON, as in real storage
  return {
    get: async (key) => (data.has(key) ? { [key]: copy(data.get(key)) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, copy(v));
    },
    remove: async (keys) => {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

const MAX_EVENTS = 10000; // ~1.5 MB of the 10 MB storage quota
const MAX_MENTIONS = 2000; // replies that mention your details live in `mentions`, separate from what you sent
const { VAULT_MODES, vaultKey, dedupeVault, cleanVaultEntry, cleanEvent } = globalThis.Clotr;
const {
  CONTENT_JS,
  USER_SCRIPT_ID,
  AI_URL_REGEX,
  PROMPT_SELECTORS,
  userSitePatterns,
  applyPolicy,
  policyWords,
  policyShapes,
  mergePolicy,
  hasPolicy,
  floorOf,
  teamHoldOf,
  isEveryday,
  tourniquetRecord,
  cleanTourniquet,
  tourniquetStep,
  tourniquetPolicy,
  combinePolicies,
  firmKinds,
  grantedEverydayApps,
  offerAfterInstall,
  collapseBatch,
  weight,
} = globalThis.ClotrSites;

const ICON = (variant) => ({ 16: `icons/icon-${variant}-16.png`, 32: `icons/icon-${variant}-32.png` });
const BADGE_BRAND = "#5b3a63"; // plum, white text 9.4:1
const BADGE_RED = "#d03b3b";

// Run storage read-modify-writes one at a time.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// ---------- Storage lock ----------
// Only Clotr's own pages and this worker can read or write storage directly. The content script running
// inside an AI page has to ask for things by message instead, so a compromised page can't read your history
// or write anything unchecked. Firefox and Safari don't support this lock.
chrome.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((err) => console.warn(LOG, "could not lock storage", err));

const RESPONSE_VALUES = new Set(["block", "warn", "log"]);
const SETTINGS_KEYS = [
  "responses",
  "paused",
  "vault",
  "siteModes",
  "guided",
  "largeText",
  "replyCheck",
  "commandCheck",
  "bandage",
  "siteKinds",
  "picturesNoted",
  "tourniquet",
  "lock", // only whether there is a PIN reaches a page, never the PIN's hash
];

// The admin's policy (managed storage), or {} when there is none.
async function readPolicy() {
  try {
    return mergePolicy((await chrome.storage.managed?.get(null)) || {});
  } catch {
    return mergePolicy({});
  }
}

// Opens the office training walkthrough once, the first time a team policy shows up on this computer.
// Settings keeps its own link to it afterwards, next to the policy's own banner.
async function offerTeamTraining() {
  if (!chrome.runtime.getManifest().clotr_features?.training) return; // held back in this build
  if (!hasPolicy(await readPolicy())) return;
  const { trainingOffered } = await chrome.storage.local.get("trainingOffered");
  if (trainingOffered) return;
  await chrome.storage.local.set({ trainingOffered: true });
  await chrome.tabs.create({ url: chrome.runtime.getURL("training.html") }).catch(() => {});
}
const offerTeamTrainingSafely = () =>
  enqueue(offerTeamTraining).catch((err) => console.error(LOG, "office training offer failed", err));

// Builds the team's managed vault entries: its watch words and its kinds' words as fingerprints, never as
// plain words, with its formats kept exactly as typed. There can be up to 500 words, so these are only
// rebuilt once per policy and salt, then kept for as long as the worker runs.
let managedCache = { key: null, entries: [] };
async function managedEntries(policy) {
  const words = policyWords(policy);
  const shapes = policyShapes(policy);
  const kinds = Array.isArray(policy.kinds) ? policy.kinds : [];
  if (!words.length && !shapes.length && !kinds.length) return [];
  const salt = words.length || kinds.some((k) => k.words.length) ? await ensureSalt() : "";
  const key = JSON.stringify([salt, words, shapes, kinds]);
  if (managedCache.key === key) return managedCache.entries;
  const fp = (phrase) => globalThis.Clotr.fingerprint(salt, "watch_list", phrase);
  const word = (type, phrase) => ({
    kind: "word",
    type,
    fp: fp(phrase),
    words: phrase.split(" ").length,
    managed: true,
  });
  const shape = (type, s, near) => ({
    kind: "shape",
    type,
    shape: s,
    ...(near?.length ? { near } : {}),
    managed: true,
  });
  const entries = [
    ...words.map((phrase) => word("watch_list", phrase)),
    ...shapes.map((s) => shape("watch_list", s)),
    ...kinds.flatMap((k) => [
      ...k.words.map((phrase) => word(k.id, phrase)),
      ...k.formats.map((s) => shape(k.id, s, k.near)),
    ]),
  ];
  managedCache = { key, entries };
  return entries;
}

// Reads the stored Tourniquet record, treating a malformed value as off and logging it once. The 30 days
// can read as over before the end alarm actually fires; that's fine, not a bug.
let tourniquetIgnoredSaid = false;
function readTourniquet(raw) {
  const t = cleanTourniquet(raw);
  if (raw !== undefined && !tourniquetRecord(raw) && !tourniquetIgnoredSaid) {
    tourniquetIgnoredSaid = true;
    console.info(LOG, "Tourniquet setting ignored");
  }
  return t;
}

// Walks the 30 days after a scam forward: sets the end alarm, records the end, and catches the clock being
// turned back. sites.js's tourniquetStep decides what to do; this just applies it. Runs at startup, on the
// alarm, and on every settings change, so if it ever fails, Tourniquet just stays on rather than lapsing.
const TOURNIQUET_END = "tourniquet-end";
async function stepTourniquet() {
  const s = await chrome.storage.local.get(["tourniquet", "tourniquetEnded", "tourniquetSeen"]);
  const { set, remove, alarm } = tourniquetStep(s, Date.now());
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (remove.length) await chrome.storage.local.remove(remove);
  if (alarm === null) await chrome.alarms.clear?.(TOURNIQUET_END);
  else chrome.alarms.create(TOURNIQUET_END, { when: alarm });
  if (set.tourniquetEnded) console.info(LOG, "Tourniquet's 30 days are over on this computer's clock: off");
  if (set.tourniquet) console.info(LOG, "this computer's clock went back before Tourniquet's end: on again");
}
const stepTourniquetSafely = () =>
  enqueue(stepTourniquet).catch((err) => console.error(LOG, "Tourniquet's end check failed", err));

// Whether `value` is at least as strict as the floor `floor` (block, then warn, then log).
const notUnder = (value, floor) => globalThis.Clotr.stricter(value, floor) === value;

// A second wall behind the warning's own options, so a request from inside a chat page can't go lower than
// the organization's policy, Tourniquet, or, while a PIN locks settings, the kind's current response. Without
// this a chat page could use the PIN's own settings to get around it. Going stricter is always fine.
async function chatGuard() {
  const [r, managed] = await Promise.all([chrome.storage.local.get(["tourniquet", "lock", "responses"]), readPolicy()]);
  const policy = combinePolicies(managed, tourniquetPolicy(readTourniquet(r.tourniquet)));
  const firm = new Set(firmKinds(policy));
  const floors = new Map(Object.entries(policy.requiredResponses || {}).filter(([id]) => firm.has(id)));
  const locked = Boolean(r.lock) || managed.lockSettings === true;
  const now = applyPolicy({ responses: r.responses }, policy).responses;
  const floorOfKind = (id) => (locked ? globalThis.Clotr.responseFor(id, now) : floors.get(id));
  return {
    // Whether choosing `value` for kind `id` would go under what holds it.
    under: (id, value) => Boolean(floorOfKind(id)) && !notUnder(value, floorOfKind(id)),
    // Whether anything holds kind `id` here (no "OK to share", no offer to just count).
    holds: (id) => locked || floors.has(id),
  };
}

// Reads Bandage's own on/off state straight from storage: true if it's on, false if the person said no, and
// undefined if nobody's asked yet. Both settingsFor's full answer and the faster connect-port reply below
// share this, so they can never disagree about what "on" actually means for a given site.
function bandageFor(everyday, host, r) {
  return everyday ? false : host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined;
}

// Builds what one frame actually needs rather than the whole stored map: its own site's pause state and
// mode, with the team's policy and Tourniquet already applied so their required responses win. Watch words
// go out as fingerprints, never as plain text.
async function settingsFor(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* no url: nothing site-specific */
  }
  const [r, managed] = await Promise.all([chrome.storage.local.get(SETTINGS_KEYS), readPolicy()]);
  const tourniquet = readTourniquet(r.tourniquet);
  const policy = combinePolicies(managed, tourniquetPolicy(tourniquet));
  const eff = applyPolicy(
    { responses: r.responses, paused: Boolean(host && r.paused?.[host]), largeText: r.largeText === true },
    policy,
  );
  let vault = Array.isArray(r.vault) ? r.vault : [];
  // A required block is a floor, so an "OK to share" vault entry can't quietly weaken it. It stays in
  // storage either way, just stops applying while the team's policy holds it; Tourniquet doesn't affect it.
  vault = vault.filter((e) => !(e.mode === "allow" && floorOf(managed, e.type) === "block"));
  vault = vault.concat(await managedEntries(policy));
  const kinds = (Array.isArray(policy.kinds) ? policy.kinds : []).map(({ id, name, cover }) => ({ id, name, cover }));
  // Same idea for a per-site "Just count": drop it under any team policy or Tourniquet, so the content
  // script falls back to each kind's own floored response instead of letting everything through silently.
  const rawSiteMode = (host && r.siteModes?.[host]) || null;
  const hasPolicy =
    Boolean(managed?.requiredResponses && Object.keys(managed.requiredResponses).length) || Boolean(tourniquet);
  // Email and chat apps: you write to people there, so no cover names and no reading of replies.
  const everyday = isEveryday(host, r.siteKinds || {});
  return {
    responses: eff.responses,
    paused: eff.paused,
    siteMode: rawSiteMode === "log" && hasPolicy ? null : rawSiteMode,
    vault,
    guided: r.guided || {},
    largeText: eff.largeText,
    replyCheck: r.replyCheck !== false && !everyday, // on unless switched off in Settings
    commandCheck: r.commandCheck !== false && !everyday, // off on everyday sites regardless
    bandage: bandageFor(everyday, host, r), // true = cover names here, false = declined, undefined = not asked
    everyday,
    kinds,
    pictureNoted: Boolean(host && r.picturesNoted?.[host] === true),
    tourniquet: tourniquet ? tourniquet.for : null,
    firm: firmKinds(policy), // kinds held by policy or Tourniquet; the warning won't offer anything looser
    locked: eff.locked || Boolean(r.lock),
    teamHold: teamHoldOf(managed), // whether the policy wants a pause before sending any of these kinds
    // Sent with the settings, not fetched separately, so a send between the two requests can't slip a
    // team word past the fingerprint check.
    salt: await ensureSalt(),
  };
}

// Records that the "can't read pictures" note was shown on this site. Keeps only 200 site names, dropping
// the oldest, so a site that falls off the list might just see the note again.
const MAX_PICTURE_NOTES = 200;
async function notePicture(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: "bad request" };
  }
  if (!host) return { error: "bad request" };
  const { picturesNoted = {} } = await chrome.storage.local.get("picturesNoted");
  if (picturesNoted[host] === true) return { ok: true };
  const sites = [...Object.keys(picturesNoted).filter((h) => picturesNoted[h] === true), host];
  await chrome.storage.local.set({
    picturesNoted: Object.fromEntries(sites.slice(-MAX_PICTURE_NOTES).map((h) => [h, true])),
  });
  return { ok: true };
}

// Bandage on or off for the site of the tab that asked.
async function setBandage(url, on) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: "bad request" };
  }
  if (!host || typeof on !== "boolean") return { error: "bad request" };
  const { bandage = {} } = await chrome.storage.local.get("bandage");
  bandage[host] = on;
  await chrome.storage.local.set({ bandage });
  return { ok: true };
}

// Only stores overrides, so a pattern set back to default keeps following future default changes.
// `fromChat` marks a request from inside a chat page, which chatGuard won't let go under what holds it.
async function setResponses(ids, value, fromChat = false) {
  if ((value !== "default" && !RESPONSE_VALUES.has(value)) || !Array.isArray(ids)) return { error: "bad request" };
  let clean = ids.filter((id) => typeof id === "string" && /^[a-z0-9_]{1,64}$/.test(id));
  if (!clean.length) return { error: "bad request" };
  const guard = fromChat ? await chatGuard() : null;
  const chosen = (id) => (value === "default" ? globalThis.Clotr.defaultResponse(id) : value);
  if (guard) clean = clean.filter((id) => !guard.under(id, chosen(id)));
  if (!clean.length) return { error: "refused" };
  const { responses = {} } = await chrome.storage.local.get("responses");
  for (const id of clean) {
    if (value === "default" || value === globalThis.Clotr.defaultResponse(id)) delete responses[id];
    else responses[id] = value;
  }
  await chrome.storage.local.set({ responses });
  return { ok: true };
}

// A setting changed (popup, vault, another tab): tell open Clotr tabs to fetch theirs again.
chrome.storage.onChanged.addListener((changes, area) => {
  // Tourniquet chosen, switched or turned off, or its end answered: the end alarm follows (stepTourniquet).
  if (area === "local" && (changes.tourniquet || changes.tourniquetEnded)) stepTourniquetSafely();
  if (area === "managed") offerTeamTrainingSafely();
  if (area !== "managed" && (area !== "local" || !SETTINGS_KEYS.some((k) => changes[k]))) return;
  // This messages every tab, not just the registered ones, since a tab still starting up would otherwise
  // miss the change; tabs without Clotr running just don't answer.
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "clotr:settingsChanged" }).catch(() => {
        /* no Clotr in this tab */
      });
    }
  });
});

// ---------- Salt & events ----------

async function ensureSalt() {
  const { salt } = await chrome.storage.local.get("salt");
  if (salt) return salt;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ salt: fresh });
  return fresh;
}

// "Keep history for" (dashboard): 90, 365 (default) or 730 days.
const KEEP_DAYS = new Set([90, 365, 730]);
const keepCutoff = (keepDays) => Date.now() - (KEEP_DAYS.has(keepDays) ? keepDays : 365) * 86400000;

async function appendEvents(incoming) {
  // cleanEvent keeps only the known fields with sane values, so a page can't inject anything else.
  const clean = (Array.isArray(incoming) ? incoming : []).map(cleanEvent).filter(Boolean);
  if (!clean.length) return 0;
  const { events = [], mentions = [], keepDays } = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const cutoff = keepCutoff(keepDays);
  const add = (list, items, max) =>
    list
      .concat(items)
      .filter((e) => e.t >= cutoff)
      .slice(-max);
  // A long list sent at once keeps 10 records per kind and outcome, plus one with the count of the rest.
  const found = collapseBatch(clean.filter((e) => e.action !== "mentioned"));
  const said = clean.filter((e) => e.action === "mentioned");
  const next = {};
  if (found.length) {
    const kept = events.concat(found).filter((e) => e.t >= cutoff);
    next.events = kept.slice(-MAX_EVENTS);
    // The cap just removed records the keep period would otherwise still have kept, and the full report
    // says so, noting only when it happened and the time of the oldest record still kept.
    if (kept.length > MAX_EVENTS) next.historyFull = { t: Date.now(), before: next.events[0].t };
  }
  if (said.length) next.mentions = add(mentions, said, MAX_MENTIONS);
  await chrome.storage.local.set(next);
  return clean.length;
}

// Clears the "history full" note once there's room again, under 9,000 records, from any kind of clearing or
// just the keep period removing old ones, or once the keep period would have removed those records anyway.
const HISTORY_ROOM = 9000;
async function settleHistoryFull(count) {
  const { historyFull, keepDays } = await chrome.storage.local.get(["historyFull", "keepDays"]);
  if (!historyFull) return;
  if (count < HISTORY_ROOM || !(historyFull.before >= keepCutoff(keepDays)))
    await chrome.storage.local.remove("historyFull");
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.events) return;
  const count = Array.isArray(changes.events.newValue) ? changes.events.newValue.length : 0;
  enqueue(() => settleHistoryFull(count)).catch(() => {}); // a failed check leaves the note; the next write tries again
});

// Every "clear" or "delete" button goes through here, so a report arriving mid-clear from another tab
// can't win the race and bring old history back.
async function clearHistory() {
  await chrome.storage.local.set({ events: [], mentions: [], spotted: {} });
}

// Drop records older than the chosen period; writes only when something is removed.
async function pruneEvents() {
  const { events = [], mentions = [], keepDays } = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const cutoff = keepCutoff(keepDays);
  const kept = events.filter((e) => e.t >= cutoff);
  const keptMentions = mentions.filter((e) => e.t >= cutoff);
  if (kept.length !== events.length) await chrome.storage.local.set({ events: kept });
  if (keptMentions.length !== mentions.length) await chrome.storage.local.set({ mentions: keptMentions });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.keepDays) enqueue(pruneEvents);
});

// ---------- Toolbar: tooltip (all tabs) and badge (protected tabs only) ----------

function todaySummary(events) {
  const start = new Date().setHours(0, 0, 0, 0);
  const today = events.filter((e) => e.t >= start);
  const sum = (list) => list.reduce((n, e) => n + weight(e), 0); // a record for a long list counts as its n
  const count = (a) => sum(today.filter((e) => e.action === a));
  return {
    total: sum(today),
    redacted: count("redacted"),
    allowed: count("allowed"),
    silenced: count("suppressed"),
    riskyAllowed: today.some((e) => e.action === "allowed" && e.severity === "high"),
  };
}

// Protected tabs are tracked in session storage because the worker can be shut down at any time.
async function getProtectedTabs() {
  const { protectedTabs = {} } = await sessionArea.get("protectedTabs");
  return protectedTabs;
}

async function refreshToolbar() {
  const { events = [] } = await chrome.storage.local.get("events");
  const s = todaySummary(events);
  const title = s.total
    ? `Clotr — today: ${s.total} found\n${s.redacted} hidden · ${s.allowed} sent · ${s.silenced} just counted`
    : "Clotr — nothing found today";
  await chrome.action.setTitle({ title });

  const tabs = await getProtectedTabs();
  for (const [id, state] of Object.entries(tabs)) {
    const tabId = Number(id);
    // Self-check: a failed edit outranks the count, so a blind tab never looks fine.
    const failed = (state.editFailed || state.uiRemoved) && !state.paused;
    const text = failed ? "!" : !state.paused && s.total ? String(s.total) : "";
    try {
      await chrome.action.setBadgeText({ tabId, text });
      if (text) {
        try {
          await chrome.action.setBadgeBackgroundColor({
            tabId,
            color: failed || s.riskyAllowed ? BADGE_RED : BADGE_BRAND,
          });
        } catch {
          /* Safari: badges have no colour there (it refuses this one); the count still shows */
        }
      }
      await chrome.action.setTitle({
        tabId,
        title: !failed ? title : state.uiRemoved ? UI_REMOVED_TITLE : EDIT_FAILED_TITLE,
      });
    } catch {
      delete tabs[id]; // tab is gone
    }
  }
  await sessionArea.set({ protectedTabs: tabs });
}

const UI_REMOVED_TITLE = "This page removed Clotr's warnings, so Clotr can't warn you here.";
const EDIT_FAILED_TITLE =
  "Clotr couldn't edit the chat box on this page. Delete flagged details by hand before sending.";

// Records that a content script's top frame reported Clotr running in its tab.
async function markTab(tabId, paused) {
  const tabs = await getProtectedTabs();
  tabs[tabId] = { editor: false, editFailed: false, ...tabs[tabId], paused: Boolean(paused) };
  await sessionArea.set({ protectedTabs: tabs });
  // A tab-specific icon outranks the declarative "spotted" icon, so protected pages never show the amber dot.
  await chrome.action.setIcon({ tabId, path: ICON(paused ? "off" : "on") });
  await refreshToolbar();
}

function forgetTab(tabId) {
  enqueue(async () => {
    const tabs = await getProtectedTabs();
    if (tabs[tabId]) {
      delete tabs[tabId];
      await sessionArea.set({ protectedTabs: tabs });
    }
  });
}

chrome.tabs.onRemoved.addListener(forgetTab);
async function noteHealth(tabId, msg) {
  const tabs = await getProtectedTabs();
  const t = { paused: false, editor: false, editFailed: false, ...tabs[tabId] };
  if (msg.editor === true) t.editor = true;
  if (typeof msg.editFailed === "boolean") t.editFailed = msg.editFailed;
  if (msg.uiRemoved === true) t.uiRemoved = true;
  tabs[tabId] = t;
  await sessionArea.set({ protectedTabs: tabs });
  await refreshToolbar();
}

// Forgets the tab on a new page load, until its content script, if it has one, reports in again. That way a
// later non-AI page loaded in the same tab never keeps Clotr's badge.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") forgetTab(tabId);
  if (changeInfo.status === "complete") recheckTab(tabId);
});

// A single-page app like ChatGPT reports "loading" for an in-page URL change even though nothing really
// reloaded. This pings the tab's Clotr directly and restores its state if it answers.
function recheckTab(tabId) {
  enqueue(async () => {
    if ((await getProtectedTabs())[tabId]) return;
    let state = null;
    try {
      state = await chrome.tabs.sendMessage(tabId, { type: "clotr:ping" }, { frameId: 0 });
    } catch {
      /* no Clotr in this tab */
    }
    if (!state?.alive) return;
    await markTab(tabId, state.paused);
    await noteHealth(tabId, {
      editor: state.editor === true,
      editFailed: Boolean(state.editFailed),
      uiRemoved: state.uiRemoved === true,
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TOURNIQUET_END) return void stepTourniquetSafely();
  if (alarm.name !== "refresh-toolbar") return;
  enqueue(refreshToolbar); // rolls "today" over after midnight
  enqueue(pruneEvents);
  stepTourniquetSafely(); // keeps watch on the clock, and sets the end alarm again if the browser lost it
});

// ---------- Spotting new AI tools ----------

async function loadImageData(path) {
  const blob = await (await fetch(chrome.runtime.getURL(path))).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function installSpotRules() {
  if (!chrome.declarativeContent) return; // Firefox: no page-state rules; the popup's page check still works
  const imageData = {
    16: await loadImageData("icons/icon-spot-16.png"),
    32: await loadImageData("icons/icon-spot-32.png"),
  };
  const conditions = PROMPT_SELECTORS.map(
    (selector) =>
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { urlMatches: AI_URL_REGEX },
        css: [selector],
      }),
  );
  await chrome.declarativeContent.onPageChanged.removeRules();
  await chrome.declarativeContent.onPageChanged.addRules([
    {
      conditions,
      actions: [new chrome.declarativeContent.SetIcon({ imageData })],
    },
  ]);
  console.info(LOG, "AI-chat spotting rules installed");
}

// ---------- User-added AI sites ----------

// Keeps one dynamic content script whose matches are the sites the user granted. ChainSec, Clotr's old
// product name, registered its own copy before v0.9.2, so that one gets removed here, to keep a user-added
// site from ending up with two registrations.
const LEGACY_USER_SCRIPT_IDS = ["chainsec-user-sites"];

async function syncUserSites() {
  const legacy = await chrome.scripting.getRegisteredContentScripts({ ids: LEGACY_USER_SCRIPT_IDS });
  if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy.map((s) => s.id) });
  const matches = await userSitePatterns();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [USER_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [USER_SCRIPT_ID] });
    return;
  }
  const script = {
    id: USER_SCRIPT_ID,
    matches,
    js: CONTENT_JS,
    runAt: "document_start", // before page scripts, so Clotr sees Enter first
    allFrames: true,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  console.info(LOG, "user-added AI sites:", matches);
}

// Starts protecting a newly added site's already-open tabs without needing a reload, but only the tabs
// inside the sections the user actually chose, not every page on the host.
async function injectIntoOpenTabs(origins) {
  const hosts = new Set(origins.map((o) => new URL(o.replace(/\*$/, "")).hostname));
  const patterns = (await userSitePatterns()).filter((p) => hosts.has(new URL(p.replace(/\*$/, "")).hostname));
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({ url: patterns });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
    } catch (err) {
      console.warn(LOG, "could not start on open tab", tab.id, err);
    }
  }
}

// Starts the new version in every open AI tab right after an install or update, so nobody has to reload a
// page by hand. An older copy still running in a tab steps aside once the new one starts (content.js).
async function startInOpenTabs() {
  const patterns = [...chrome.runtime.getManifest().content_scripts[0].matches, ...(await userSitePatterns())];
  const tabs = await chrome.tabs.query({ url: patterns });
  let started = 0;
  for (const tab of tabs) {
    if (tab.discarded) continue; // a discarded tab reloads (with the new version) when it's opened
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
      started++;
    } catch (err) {
      console.info(LOG, "could not start in open tab", tab.id, String(err?.message || err));
    }
  }
  if (tabs.length) console.info(LOG, `started in ${started} of ${tabs.length} open AI tabs`);
  return started;
}

chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  enqueue(async () => {
    await syncUserSites();
    await injectIntoOpenTabs(origins);
  }).catch((err) => console.error(LOG, "adding site failed", err));
});

chrome.permissions.onRemoved.addListener(() => {
  enqueue(syncUserSites).catch((err) => console.error(LOG, "removing site failed", err));
});

// Updates where Clotr runs when the chosen sections change without a permission change, such as adding
// another section on an already-granted host, or removing one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.siteScopes) {
    enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  }
});

// ---------- Settings migration ----------

// An older version stored "Don't warn me again" as suppressed.global[id]; this turns that into the "log"
// response.
async function migrateSuppressed() {
  const { suppressed, responses = {} } = await chrome.storage.local.get(["suppressed", "responses"]);
  if (!suppressed) return;
  const next = { ...responses };
  for (const [id, on] of Object.entries(suppressed.global || {})) if (on && !next[id]) next[id] = "log";
  await chrome.storage.local.set({ responses: next });
  await chrome.storage.local.remove("suppressed");
  console.info(LOG, "moved silenced patterns to responses", next);
}

// Runs every settings migration, oldest first. Each one is a no-op once it's already run, and one failing
// doesn't stop the rest.
async function runMigrations() {
  for (const step of [migrateSuppressed, migrateToVault, migrateOffToLog]) {
    try {
      await step();
    } catch (err) {
      console.error(LOG, `settings migration ${step.name} failed`, err);
    }
  }
}

// Older versions had an "off" response; this version always records, so old "off" becomes "log".
async function migrateOffToLog() {
  const { responses } = await chrome.storage.local.get("responses");
  if (!responses || !Object.values(responses).includes("off")) return;
  const next = Object.fromEntries(Object.entries(responses).map(([id, r]) => [id, r === "off" ? "log" : r]));
  await chrome.storage.local.set({ responses: next });
  console.info(LOG, "turned old Off settings into Log only");
}

// An older version kept "It's me" and watch-list entries separately. This folds both into the
// vault, and an "It's me" entry keeps its old meaning: it's still something the user is fine sharing.
async function migrateToVault() {
  const { mine, watch, vault = [] } = await chrome.storage.local.get(["mine", "watch", "vault"]);
  if (!mine && !watch) return;
  const next = vault.slice();
  for (const x of mine || []) next.push({ kind: "value", type: x.type, fp: x.fp, mode: "allow", added: x.added });
  for (const w of watch || []) next.push({ ...w, type: "watch_list" });
  await chrome.storage.local.set({ vault: dedupeVault(next) });
  await chrome.storage.local.remove(["mine", "watch"]);
  console.info(LOG, "moved It's me + watch list into the vault:", next.length, "entries");
}

// ---------- Vault (only this worker writes it; entries hold fingerprints or formats, never values) ----------
// Every entry passes through cleanVaultEntry first, so nothing malformed, and nothing raw, ever gets stored.
// dedupeVault then keeps one entry per fingerprint or format.

// fromChat is true when the call came from inside a chat page itself, where chatGuard won't let someone
// mark a kind "OK to share" if the team's policy holds it.
async function vaultAdd(entries, fromChat = false) {
  let clean = (Array.isArray(entries) ? entries : []).map(cleanVaultEntry).filter(Boolean);
  const guard = fromChat ? await chatGuard() : null;
  if (guard) clean = clean.filter((e) => !(e.mode === "allow" && guard.holds(e.type)));
  const { vault = [] } = await chrome.storage.local.get("vault");
  const before = new Set(vault.map(vaultKey));
  const next = dedupeVault(vault.concat(clean));
  await chrome.storage.local.set({ vault: next });
  return {
    added: clean.filter((e) => !before.has(vaultKey(e))).length,
    rejected: (entries?.length || 0) - clean.length,
  };
}

// Restoring a backup replaces this browser's settings, vault and salt with the ones in the file. I clean
// everything again here so a hand-edited file can't smuggle anything else in. History is left alone.
async function importBackup(settings) {
  const clean = globalThis.Clotr.Backup.clean(settings);
  const vault = dedupeVault((clean.vault || []).map(cleanVaultEntry).filter(Boolean));
  const next = { ...clean, vault };
  const drop = globalThis.Clotr.Backup.KEYS.filter((k) => !(k in next) && k !== "salt");
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set(next);
  return { ok: true, vault: vault.length, responses: Object.keys(clean.responses || {}).length };
}

async function vaultUpdate(key, change) {
  const { vault = [] } = await chrome.storage.local.get("vault");
  const next =
    change === "remove"
      ? vault.filter((e) => vaultKey(e) !== key)
      : vault.map((e) =>
          vaultKey(e) === key && e.kind === "value" && VAULT_MODES.has(change) ? { ...e, mode: change } : e,
        );
  await chrome.storage.local.set({ vault: next });
  return { ok: true };
}

// ---------- Learning from ignores (type + timestamps only, never values) ----------

const DAY = 86400000;
const IGNORES_TO_OFFER = 3;
const validType = (t) => typeof t === "string" && /^[a-z_]{2,40}$/.test(t);

// Records that the user kept a warning instead of acting on it, and checks whether it's time to offer
// relaxing that kind: kept 3 times in 14 days, not declined in the last 30, not held by a team policy.
async function noteIgnored(types) {
  const now = Date.now();
  const guard = await chatGuard();
  const { ignores = {}, relaxDeclined = {} } = await chrome.storage.local.get(["ignores", "relaxDeclined"]);
  for (const t of (Array.isArray(types) ? types : []).filter(validType)) {
    ignores[t] = (ignores[t] || []).filter((x) => now - x < 14 * DAY).concat(now);
  }
  await chrome.storage.local.set({ ignores });
  const offer = Object.keys(ignores).find(
    (t) =>
      types.includes(t) &&
      !guard.holds(t) &&
      ignores[t].length >= IGNORES_TO_OFFER &&
      !(now - (relaxDeclined[t] || 0) < 30 * DAY),
  );
  return { offer: offer || null, count: offer ? ignores[offer].length : 0 };
}

async function relaxAnswer(id, accepted) {
  if (!validType(id)) return { ok: false };
  const { ignores = {}, relaxDeclined = {} } = await chrome.storage.local.get(["ignores", "relaxDeclined"]);
  delete ignores[id];
  if (!accepted) relaxDeclined[id] = Date.now();
  await chrome.storage.local.set({ ignores, relaxDeclined });
  return { ok: true };
}

// ---------- Updates ----------
// The Chrome Web Store updates a store install on its own. An unpacked install has no store to do that, so
// it rereads its own manifest from disk every minute and reloads once the version there has changed.

// Safari installs come from an app (the App Store, TestFlight or Xcode), never from a folder: nothing to check there.
const IS_UNPACKED =
  !("update_url" in chrome.runtime.getManifest()) &&
  !chrome.runtime.getManifest().browser_specific_settings?.safari &&
  !chrome.runtime.getURL("").startsWith("safari-web-extension:");

async function localVersionOnDisk() {
  const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
  return (await res.json()).version;
}

// A reload restarts Clotr in open tabs, which closes any dialog or warning they show,
// so it waits while one is open: at most MAX_UPDATE_WAIT, then updates anyway.
const MAX_UPDATE_WAIT = 2 * 60 * 60000;

async function tabBusy(tabId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "clotr:busy?" })) === true;
  } catch {
    return false; // no Clotr in that tab, or nothing open: no frame answered
  }
}

// A developer copy can track a running line of commits instead of a version number. A local updater
// writes local-update.txt after each one, and its contents changing is enough to trigger a reload even
// though the manifest version didn't move. Returns "" when the file isn't there.
async function localStampOnDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL("local-update.txt"), { cache: "no-store" });
    return res.ok ? (await res.text()).trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

async function checkForLocalUpdate() {
  if (!IS_UNPACKED) return false;
  const onDisk = await localVersionOnDisk();
  const running = chrome.runtime.getManifest().version;
  const stamp = await localStampOnDisk();
  const { localStamp } = await sessionArea.get("localStamp");
  if (localStamp === undefined) await sessionArea.set({ localStamp: stamp }); // this run's starting point
  const restamped = localStamp !== undefined && stamp !== localStamp;
  if (onDisk === running && !restamped) return false;
  const tabIds = Object.keys(await getProtectedTabs()).map(Number);
  const busy = (await Promise.all(tabIds.map(tabBusy))).some(Boolean);
  if (busy) {
    let { updateWaitingSince } = await sessionArea.get("updateWaitingSince");
    if (!updateWaitingSince) {
      updateWaitingSince = Date.now();
      await sessionArea.set({ updateWaitingSince });
    }
    if (Date.now() - updateWaitingSince < MAX_UPDATE_WAIT) {
      console.info(LOG, `files updated on disk (${running} → ${onDisk}); waiting: a Clotr dialog or warning is open`);
      return false;
    }
  }
  console.info(LOG, `files updated on disk (${running} → ${onDisk}${restamped ? ", new local build" : ""}); reloading`);
  await sessionArea.remove("updateWaitingSince");
  await sessionArea.set({ localStamp: stamp }); // never reload twice for the same files
  chrome.runtime.reload();
  return true;
}

function scheduleUpdateCheck() {
  if (IS_UNPACKED) chrome.alarms.create("local-update-check", { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "local-update-check") checkForLocalUpdate().catch(() => {});
});

// ---------- Lifecycle ----------

// The one-time offer to use Clotr on email and chat apps is one word in storage: "welcome" for a fresh
// install, "popup" for someone who already had Clotr, "done" once offered. Which apps are actually on
// lives in the browser's own permission grants, not here.
async function noteEverydayOffer(reason) {
  const { origins = [] } = await chrome.permissions.getAll();
  const { everydayOffer } = await chrome.storage.local.get("everydayOffer");
  const next = offerAfterInstall(reason, everydayOffer, grantedEverydayApps(origins).length > 0);
  if (next && next !== everydayOffer) await chrome.storage.local.set({ everydayOffer: next });
  return next;
}

chrome.runtime.onInstalled.addListener((details) => {
  // After an update, the popup shows "Updated to vX: what's new" once (from changelog.json).
  if (details?.reason === "update" && details.previousVersion !== chrome.runtime.getManifest().version) {
    chrome.storage.local.set({
      lastUpdate: {
        from: details.previousVersion,
        to: chrome.runtime.getManifest().version,
        t: Date.now(),
        seen: false,
      },
    });
  }
  scheduleUpdateCheck();
  // First install: ask "What should I protect?" once. Everything on that page is optional.
  if (details?.reason === "install")
    chrome.tabs.create({ url: chrome.runtime.getURL("vault.html?welcome=1") }).catch(() => {});
  enqueue(runMigrations).catch((err) => console.error(LOG, "settings migration failed", err));
  enqueue(() => followPersonalSwitch(details?.reason)).catch((err) =>
    console.error(LOG, "personal-details switch failed", err),
  );
  enqueue(ensureSalt).catch((err) => console.error(LOG, "salt setup failed", err));
  enqueue(() => noteEverydayOffer(details?.reason)).catch((err) => console.error(LOG, "offer bookkeeping failed", err));
  enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  if (details?.reason === "install" || details?.reason === "update") {
    startInOpenTabs().catch((err) => console.warn(LOG, "could not start in open tabs", err));
  }
  installSpotRules().catch((err) => console.error(LOG, "spotting rules failed", err));
  chrome.alarms.create("refresh-toolbar", { periodInMinutes: 30 });
  enqueue(refreshToolbar).catch(() => {});
  stepTourniquetSafely(); // alarms don't survive every update
  offerTeamTrainingSafely();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleUpdateCheck();
  enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  enqueue(refreshToolbar).catch(() => {});
  offerTeamTrainingSafely();
  stepTourniquetSafely(); // the end alarm again, or the end itself if it came while the browser was closed
});

// "Ask before sending personal details" stays on across an update, and any personal kind the update adds
// starts out asking too, instead of quietly falling back to just a warning. Clotr remembers which kind ids
// it already knew about so it can tell what's new.
async function followPersonalSwitch(reason) {
  if (reason !== "install" && reason !== "update") return;
  const { Helper, PATTERNS } = globalThis.Clotr;
  const ids = PATTERNS.map((p) => p.id);
  const { responses = {}, knownKinds } = await chrome.storage.local.get(["responses", "knownKinds"]);
  if (reason === "update") {
    const brought = Helper.newPersonalToAsk(responses, knownKinds);
    if (brought.length) {
      for (const id of brought) responses[id] = "block";
      await chrome.storage.local.set({ responses });
      console.info(LOG, "Ask before sending personal details now covers new kinds:", brought);
    }
  }
  if (JSON.stringify(knownKinds) !== JSON.stringify(ids)) await chrome.storage.local.set({ knownKinds: ids });
}

// ---------- First-time tips: which kinds of data the user was already guided about ----------

async function markGuided(id) {
  if (!validType(id)) return { ok: false };
  const { guided = {} } = await chrome.storage.local.get("guided");
  if (!guided[id]) {
    guided[id] = Date.now();
    await chrome.storage.local.set({ guided });
  }
  return { ok: true };
}

// ---------- Keyboard: Alt+Shift+C jumps to Clotr's warning ----------

async function handleCommand(command, tab) {
  if (command !== "focus-notice") return;
  // Safari before 18 doesn't say which tab: the one in front.
  const id = tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0]?.id;
  if (id) chrome.tabs.sendMessage(id, { type: "clotr:focusNotice" }).catch(() => {});
}
chrome.commands?.onCommand.addListener(handleCommand); // none on Firefox for Android

// ---------- Messages from content scripts / popup ----------

// True for Clotr's own pages, like the vault or settings, never for a content script inside an AI site,
// which shares that page with the site's own code.
const fromClotrPage = (sender) => (sender.url || "").startsWith(chrome.runtime.getURL(""));

// Opens the "Is this a scam?" page from a warning, right next to the chat's own tab when the browser
// can tell us where that is, or at the end of the window otherwise.
async function openCheckPage(tab) {
  const url = chrome.runtime.getURL("check.html");
  const beside = Number.isInteger(tab?.index) && Number.isInteger(tab?.windowId);
  try {
    await chrome.tabs.create(beside ? { url, windowId: tab.windowId, index: tab.index + 1 } : { url });
  } catch {
    try {
      if (beside) await chrome.tabs.create({ url });
    } catch {
      // nowhere to open it: the warning stays as it is
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  const reply = (task) => {
    enqueue(task)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true; // respond asynchronously
  };

  switch (msg?.type) {
    case "clotr:getSalt":
      return reply(async () => ({ salt: await ensureSalt() }));
    case "clotr:events":
      return reply(async () => {
        const count = await appendEvents(msg.events);
        await refreshToolbar();
        return { ok: true, count };
      });
    case "clotr:clearHistory":
      // Only Clotr's own pages offer this; a site's own tab never gets to clear your history.
      if (!fromClotrPage(sender)) return false;
      return reply(async () => {
        await clearHistory();
        await refreshToolbar();
        return { ok: true };
      });
    case "clotr:vaultAdd":
      return reply(() => vaultAdd(msg.entries, !fromClotrPage(sender)));
    case "clotr:vaultUpdate":
      // Only the vault page removes an entry or switches it to "allow".
      if (!fromClotrPage(sender)) return false;
      return reply(() => vaultUpdate(msg.key, msg.change));
    case "clotr:importBackup":
      // Only from Clotr's own pages (the "Move to a new computer" section), never from a website's tab.
      if (!fromClotrPage(sender)) return false;
      return reply(() => importBackup(msg.settings));
    case "clotr:ignored":
      return reply(() => noteIgnored(msg.types));
    case "clotr:guided":
      return reply(() => markGuided(msg.id));
    case "clotr:relaxAnswer":
      return reply(() => relaxAnswer(msg.id, msg.accepted));
    case "clotr:getSettings":
      return reply(() => settingsFor(sender.url || sender.tab?.url || ""));
    case "clotr:setBandage":
      return reply(() => setBandage(sender.url || sender.tab?.url || "", msg.on));
    case "clotr:pictureNoted":
      return reply(() => notePicture(sender.url || sender.tab?.url || ""));
    case "clotr:setResponses":
      return reply(() => setResponses(msg.ids, msg.value, !fromClotrPage(sender)));
    case "clotr:openCheck":
      // A warning's "Get a second opinion": opens Clotr's own Is this a scam? page in a new tab beside the
      // chat. The page is always this fixed one; nothing from the message goes with it.
      openCheckPage(sender.tab);
      return false;
    case "clotr:health":
      if (!sender.tab?.id) return false;
      return reply(async () => {
        await noteHealth(sender.tab.id, msg);
        return { ok: true };
      });
    case "clotr:tabState":
      if (!sender.tab?.id) return false;
      return reply(async () => {
        await markTab(sender.tab.id, msg.paused);
        return { ok: true };
      });
    default:
      return false;
  }
});

// A content script opens one of these the moment it starts, before it asks for real settings, so it gets
// just the Bandage flag right away instead of waiting on settingsFor's slower lookup. Firefox can suspend
// this worker between tabs and take a few seconds to wake it; keeping the port open while a tab is open
// avoids that delay too.
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id || port.name !== "clotr:tab") return;
  (async () => {
    let host = "";
    try {
      host = new URL(port.sender.url || port.sender.tab?.url || "").hostname;
    } catch {
      /* no url: nothing site-specific to answer */
    }
    const r = await chrome.storage.local.get(["bandage", "siteKinds"]);
    const everyday = isEveryday(host, r.siteKinds || {});
    try {
      port.postMessage({ type: "clotr:bandage", on: bandageFor(everyday, host, r) });
    } catch {
      /* the tab closed before this resolved */
    }
  })();
});
