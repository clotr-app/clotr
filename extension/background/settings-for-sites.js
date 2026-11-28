/* global LOG, RESPONSE_VALUES, SETTINGS_KEYS, builtInMatches, enqueue, ensureSalt, everywhereGranted, managedEntries,
          offerTeamTrainingSafely, openBeside, policyRead:writable, readPolicy, sessionArea, userSitePatterns,
          vaultAdd */
/* exported answerAsked, notePicture, policyRead, readAsked, setBandage, settingsFor */
"use strict";

const {
  applyPolicy,
  floorOf,
  teamHoldOf,
  isEveryday,
  isSearchSite,
  isSupportSite,
  tourniquetRecord,
  cleanTourniquet,
  tourniquetStep,
  tourniquetPolicy,
  combinePolicies,
  firmKinds,
} = globalThis.ClotrSites;

// ---------- Tourniquet in the worker ----------

// Reads the stored Tourniquet record, treating a malformed value as off and logging it once. The 30 days
// can read as over before the end alarm actually fires. That's fine, not a bug.
let tourniquetIgnoredSaid = false;
function readTourniquet(raw) {
  const record = cleanTourniquet(raw);
  if (raw !== undefined && !tourniquetRecord(raw) && !tourniquetIgnoredSaid) {
    tourniquetIgnoredSaid = true;
    console.info(LOG, "Tourniquet setting ignored");
  }
  return record;
}

// Walks the 30 days after a scam forward: sets the end alarm, records the end, and catches the clock being
// turned back. sites-and-policy/tourniquet-rules.js's tourniquetStep decides what to do, and this just applies it. Runs at startup, on
// the alarm, and on every settings change, so if it ever fails, Tourniquet just stays on rather than lapsing.
const TOURNIQUET_END = "tourniquet-end";
async function stepTourniquet() {
  const stored = await chrome.storage.local.get(["tourniquet", "tourniquetEnded", "tourniquetSeen"]);
  const { set, remove, alarm } = tourniquetStep(stored, Date.now());
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (remove.length) await chrome.storage.local.remove(remove);
  if (alarm === null) await chrome.alarms.clear?.(TOURNIQUET_END);
  else chrome.alarms.create(TOURNIQUET_END, { when: alarm });
  if (set.tourniquetEnded) console.info(LOG, "Tourniquet's 30 days are over on this computer's clock: off");
  if (set.tourniquet) console.info(LOG, "this computer's clock went back before Tourniquet's end: on again");
}
const stepTourniquetSafely = () =>
  enqueue(stepTourniquet).catch((err) => console.error(LOG, "Tourniquet's end check failed", err));

// ---------- The chat guard ----------

// Whether `value` is at least as strict as the floor `floor` (block, then warn, then log).
const notUnder = (value, floor) => globalThis.Clotr.stricter(value, floor) === value;

// A second wall behind the warning's own options, so a request from inside a chat page can't go lower than
// the organization's policy, Tourniquet, or, while a PIN locks settings, the kind's current response.
// Without this a chat page could use the PIN's own settings to get around it. Going stricter is always fine.
async function chatGuard() {
  const [stored, managed] = await Promise.all([
    chrome.storage.local.get(["tourniquet", "lock", "responses"]),
    readPolicy(),
  ]);
  const policy = combinePolicies(managed, tourniquetPolicy(readTourniquet(stored.tourniquet)));
  const firm = new Set(firmKinds(policy));
  const floors = new Map(Object.entries(policy.requiredResponses || {}).filter(([id]) => firm.has(id)));
  const locked = Boolean(stored.lock) || managed.lockSettings === true;
  const now = applyPolicy({ responses: stored.responses }, policy).responses;
  function floorOfKind(id) {
    return locked ? globalThis.Clotr.responseFor(id, now) : floors.get(id);
  }
  return {
    // Whether choosing `value` for kind `id` would go under what holds it.
    under: (id, value) => Boolean(floorOfKind(id)) && !notUnder(value, floorOfKind(id)),
    // Whether anything holds kind `id` here (no "OK to share", no offer to just count).
    holds: (id) => locked || floors.has(id),
    // What kind `id` does right now on every site, with the policy and Tourniquet applied.
    current: (id) => globalThis.Clotr.responseFor(id, now),
  };
}

// ---------- Warning less on every site, from a chat page: asked again on Clotr's own page ----------

// Clotr's warning sits inside the chat page, which can restyle or cover it and steer a click onto one of its
// choices. So from a chat page, only a choice that makes Clotr stricter applies right away. One that makes it
// warn less on every site, like "stop warning me about this kind" or "fine to share", is held here instead,
// and Clotr's own page opens beside the chat to ask again. No website can reach or draw over that page, and
// only its answer applies what was held. The chat page never learns the token that names it.
const ASKED_FOR_MS = 60 * 60 * 1000; // an unanswered question is dropped after an hour
const MAX_ASKED = 10;

async function askOnClotrPage(request, tab) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { asked = {} } = await sessionArea.get("asked");
  const now = Date.now();
  const kept = Object.entries(asked)
    .filter(([, held]) => now - held.at < ASKED_FOR_MS)
    .slice(-(MAX_ASKED - 1));
  const tabId = Number.isInteger(tab?.id) ? tab.id : null;
  kept.push([token, { ...request, tabId, at: now }]);
  await sessionArea.set({ asked: Object.fromEntries(kept) });
  openBeside(chrome.runtime.getURL(`clotr-pages/warn-less/warn-less.html#${token}`), tab);
}

async function heldChoice(token, take = false) {
  if (typeof token !== "string") return null;
  const { asked = {} } = await sessionArea.get("asked");
  const held = asked[token];
  if (take && held) {
    delete asked[token];
    await sessionArea.set({ asked });
  }
  const fresh = held && Date.now() - held.at < ASKED_FOR_MS;
  if (!fresh) return null;
  return held;
}

// What Clotr's page shows: the kinds and the response, never a fingerprint.
async function readAsked(token) {
  const held = await heldChoice(token);
  if (!held) return { gone: true };
  if (!held.entries) return { ids: held.ids, value: held.value };
  return { allow: [...new Set(held.entries.map((entry) => entry.type))] };
}

// The person's answer on Clotr's page. A yes still goes through chatGuard, so a PIN, a policy or Tourniquet
// that took hold in the meantime still wins. Either way the question is gone and the chat tab comes back to
// the front.
async function answerAsked(token, yes) {
  const held = await heldChoice(token, true);
  if (!held) return { gone: true };
  let changed = false;
  if (yes && held.entries) changed = (await vaultAdd(held.entries, true, { confirmed: true })).added > 0;
  else if (yes) changed = !(await setResponses(held.ids, held.value, true, { confirmed: true })).error;
  if (held.tabId !== null) {
    try {
      Promise.resolve(chrome.tabs.update(held.tabId, { active: true })).catch(() => {});
    } catch {
      /* no such tab anymore */
    }
  }
  return { ok: true, changed };
}

// ---------- What each site gets ----------

// Reads Bandage's own on/off state straight from storage: true if it's on, false if the person said no, and
// undefined if nobody's asked yet. Both settingsFor's full answer and the faster connect-port reply below
// share this, so they can never disagree about what "on" actually means for a given site.
function bandageFor(everyday, host, stored) {
  if (everyday) return false;
  if (host && typeof stored.bandage?.[host] === "boolean") return stored.bandage[host];
  return undefined;
}

const hostOf = (pattern) => new URL(pattern.replace(/\*$/, "")).hostname;

// Whether this host has no dedicated setup of its own (not built in, not a site the person added by hand)
// and is covered only because "Everywhere I type" is on. A site with its own setup keeps it even if the
// broad switch happens to be on too, so turning Discord off there still means Discord specifically, not
// "everywhere except Discord".
async function isEverywhereOnly(host, dedicated) {
  if (!host || dedicated) return false;
  const { origins = [] } = await chrome.permissions.getAll();
  if (!everywhereGranted(origins)) return false;
  if (new Set(builtInMatches().map(hostOf)).has(host)) return false;
  return !new Set((await userSitePatterns()).map(hostOf)).has(host);
}

// What kind of site this is, as far as the page's features go. settingsFor and the tab port's early Bandage
// answer both read it, so the two can't disagree about where the AI-only features are off.
//
// Email and chat apps: you write to people there, so no cover names and no reading of replies. A support
// chat is the same shape (someone on the other end reads it, maybe a bot), so it gets the same wording and
// the same features turned off. A search engine has nobody reading what you type either, but it isn't a
// person or an AI, so it keeps its own wording (on-websites/warning-ui.js) while still losing the AI-only features.
//
// Everywhere I type: no list names this host in advance, so it gets the same people-reading wording and
// the same AI-only features off as an email or chat app. The content script also has to tell a chat box
// from an ordinary form field itself, and the `everywhere` flag is what tells it to.
async function siteShape(host, siteKinds) {
  const everydaySite = isEveryday(host, siteKinds);
  const support = isSupportSite(host);
  const search = isSearchSite(host);
  const everywhere = await isEverywhereOnly(host, everydaySite || support || search);
  const everyday = everydaySite || support || everywhere;
  return { everyday, everywhere, search, noAiFeatures: everyday || search };
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
  const [stored, managed] = await Promise.all([chrome.storage.local.get(SETTINGS_KEYS), readPolicy()]);
  const tourniquet = readTourniquet(stored.tourniquet);
  const policy = combinePolicies(managed, tourniquetPolicy(tourniquet));
  const own = {
    responses: stored.responses,
    paused: Boolean(host && stored.paused?.[host]),
    largeText: stored.largeText === true,
  };
  const effective = applyPolicy(own, policy);
  let vault = Array.isArray(stored.vault) ? stored.vault : [];
  // A required block is a floor, so an "OK to share" vault entry can't quietly weaken it. It stays in
  // storage either way, just stops applying while the team's policy holds it. Tourniquet doesn't affect it.
  vault = vault.filter((entry) => !(entry.mode === "allow" && floorOf(managed, entry.type) === "block"));
  vault = vault.concat(await managedEntries(policy));
  const namedKinds = Array.isArray(policy.kinds) ? policy.kinds : [];
  const kinds = namedKinds.map(({ id, name, cover }) => ({ id, name, cover }));
  // Same idea for a per-site "Just count": drop it under any team policy or Tourniquet, so the content
  // script falls back to each kind's own floored response instead of letting everything through silently.
  const rawSiteMode = (host && stored.siteModes?.[host]) || null;
  // mergePolicy adds custom-kind responses to requiredResponses. Check the effective policy so a site's
  // "Just count" mode cannot override a custom managed kind's response floor.
  const hasResponseFloor = Boolean(policy.requiredResponses && Object.keys(policy.requiredResponses).length);
  const { everyday, everywhere, search, noAiFeatures } = await siteShape(host, stored.siteKinds || {});
  return {
    responses: effective.responses,
    paused: effective.paused,
    siteMode: rawSiteMode === "log" && hasResponseFloor ? null : rawSiteMode,
    vault,
    guided: stored.guided || {},
    largeText: effective.largeText,
    replyCheck: stored.replyCheck !== false && !noAiFeatures, // on unless switched off in Settings
    commandCheck: stored.commandCheck !== false && !noAiFeatures, // off on everyday, support and search sites
    bandage: bandageFor(noAiFeatures, host, stored), // true covers names, false declined, undefined not asked
    everyday,
    everywhere,
    search,
    kinds,
    pictureNoted: Boolean(host && stored.picturesNoted?.[host] === true),
    tourniquet: tourniquet ? tourniquet.for : null,
    firm: firmKinds(policy), // kinds held by policy or Tourniquet, so the warning offers nothing looser
    locked: effective.locked || Boolean(stored.lock),
    teamHold: teamHoldOf(managed), // whether the policy wants a pause before sending any of these kinds
    holdFiles: managed?.holdFiles === true, // whether the policy holds every file finding, not just Ask-level
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
  const noted = Object.keys(picturesNoted).filter((site) => picturesNoted[site] === true);
  const sites = [...noted, host];
  await chrome.storage.local.set({
    picturesNoted: Object.fromEntries(sites.slice(-MAX_PICTURE_NOTES).map((site) => [site, true])),
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

// ---------- A kind's response ----------

// Only stores overrides, so a pattern set back to default keeps following future default changes.
// `fromChat` marks a request from inside a chat page, which chatGuard won't let go under what holds it, and
// where a choice that warns less waits for Clotr's own page (askOnClotrPage) unless that page `confirmed`
// it.
async function setResponses(ids, value, fromChat = false, { tab = null, confirmed = false } = {}) {
  if (value !== "default" && !RESPONSE_VALUES.has(value)) return { error: "bad request" };
  if (!Array.isArray(ids)) return { error: "bad request" };
  let clean = ids.filter((id) => typeof id === "string" && /^[a-z0-9_]{1,64}$/.test(id));
  if (!clean.length) return { error: "bad request" };
  const guard = fromChat ? await chatGuard() : null;
  function chosen(id) {
    return value === "default" ? globalThis.Clotr.defaultResponse(id) : value;
  }
  if (guard) clean = clean.filter((id) => !guard.under(id, chosen(id)));
  if (!clean.length) return { error: "refused" };
  const looser = guard && !confirmed ? clean.filter((id) => !notUnder(chosen(id), guard.current(id))) : [];
  if (looser.length) {
    await askOnClotrPage({ ids: looser, value }, tab);
    clean = clean.filter((id) => !looser.includes(id));
    if (!clean.length) return { ok: true, asked: true };
  }
  const { responses = {} } = await chrome.storage.local.get("responses");
  for (const id of clean) {
    if (value === "default" || value === globalThis.Clotr.defaultResponse(id)) delete responses[id];
    else responses[id] = value;
  }
  await chrome.storage.local.set({ responses });
  return looser.length ? { ok: true, asked: true } : { ok: true };
}

// A setting changed (popup, vault, another tab): tell open Clotr tabs to fetch theirs again.
chrome.storage.onChanged.addListener((changes, area) => {
  // Tourniquet chosen, switched or turned off, or its end answered: the end alarm follows (stepTourniquet).
  if (area === "local" && (changes.tourniquet || changes.tourniquetEnded)) stepTourniquetSafely();
  if (area === "managed") {
    policyRead = null; // before the tabs below ask again
    offerTeamTrainingSafely();
  }
  // A new salt (a loaded file) changes every fingerprint a page makes, the team's watch words included.
  const tabsCare = changes.salt || SETTINGS_KEYS.some((key) => changes[key]);
  if (area !== "managed" && (area !== "local" || !tabsCare)) return;
  // This messages every tab, not just the registered ones, since a tab still starting up would otherwise
  // miss the change. Tabs without Clotr running just don't answer.
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "clotr:settingsChanged" }).catch(() => {
        /* no Clotr in this tab */
      });
    }
  });
});
