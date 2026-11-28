/* global enqueue */
/* exported appendEvents, clearHistory, ensureSalt */
"use strict";

const MAX_EVENTS = 10000; // ~1.5 MB of the 10 MB storage quota
const MAX_MENTIONS = 2000; // replies that mention your details live in `mentions`, separate from what you sent
const { cleanEvent } = globalThis.Clotr;
const { collapseBatch } = globalThis.ClotrSites;

// ---------- Salt & events ----------

// A page's settings ask for the salt outside the write queue (answered, below), so making one has its own
// lock: pages asking at the same moment on a fresh install all get the one that's kept.
let saltMaking = null;
async function ensureSalt() {
  const { salt } = await chrome.storage.local.get("salt");
  if (salt) return salt;
  saltMaking ||= (async () => {
    const { salt: made } = await chrome.storage.local.get("salt");
    if (made) return made;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const fresh = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ salt: fresh });
    return fresh;
  })().finally(() => {
    saltMaking = null;
  });
  return saltMaking;
}

// "Keep history for" (dashboard): 90, 365 (default) or 730 days.
const KEEP_DAYS = new Set([90, 365, 730]);
const keepCutoff = (keepDays) => Date.now() - (KEEP_DAYS.has(keepDays) ? keepDays : 365) * 86400000;

async function appendEvents(incoming) {
  // cleanEvent keeps only the known fields with sane values, so a page can't inject anything else.
  const clean = (Array.isArray(incoming) ? incoming : []).map(cleanEvent).filter(Boolean);
  if (!clean.length) return 0;
  const stored = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const { events = [], mentions = [], keepDays } = stored;
  const cutoff = keepCutoff(keepDays);
  function keepRecent(list, items, max) {
    return list
      .concat(items)
      .filter((record) => record.t >= cutoff)
      .slice(-max);
  }
  // A long list sent at once keeps 10 records per kind and outcome, plus one with the count of the rest.
  const found = collapseBatch(clean.filter((record) => record.action !== "mentioned"));
  const said = clean.filter((record) => record.action === "mentioned");
  const next = {};
  if (found.length) {
    const kept = events.concat(found).filter((record) => record.t >= cutoff);
    next.events = kept.slice(-MAX_EVENTS);
    // The cap just removed records the keep period would otherwise still have kept, and the full report
    // says so, noting only when it happened and the time of the oldest record still kept.
    if (kept.length > MAX_EVENTS) next.historyFull = { t: Date.now(), before: next.events[0].t };
  }
  if (said.length) next.mentions = keepRecent(mentions, said, MAX_MENTIONS);
  await chrome.storage.local.set(next);
  return clean.length;
}

// Clears the "history full" note once there's room again, under 9,000 records, from any kind of clearing
// or just the keep period removing old ones, or once the keep period would have removed those records
// anyway.
const HISTORY_ROOM = 9000;
async function settleHistoryFull(count) {
  const { historyFull, keepDays } = await chrome.storage.local.get(["historyFull", "keepDays"]);
  if (!historyFull) return;
  if (count < HISTORY_ROOM || !(historyFull.before >= keepCutoff(keepDays))) {
    await chrome.storage.local.remove("historyFull");
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.events) return;
  const count = Array.isArray(changes.events.newValue) ? changes.events.newValue.length : 0;
  // A failed check leaves the note, and the next write tries again.
  enqueue(() => settleHistoryFull(count)).catch(() => {});
});

// Every "clear" or "delete" button goes through here, so a report arriving mid-clear from another tab
// can't win the race and bring old history back.
async function clearHistory() {
  await chrome.storage.local.set({ events: [], mentions: [], spotted: {} });
}

// Drop records older than the chosen period; writes only when something is removed.
async function pruneEvents() {
  const stored = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const { events = [], mentions = [], keepDays } = stored;
  const cutoff = keepCutoff(keepDays);
  const kept = events.filter((record) => record.t >= cutoff);
  const keptMentions = mentions.filter((record) => record.t >= cutoff);
  if (kept.length !== events.length) await chrome.storage.local.set({ events: kept });
  if (keptMentions.length !== mentions.length) await chrome.storage.local.set({ mentions: keptMentions });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.keepDays) enqueue(pruneEvents);
});
