/* global LOG, builtInMatches, enqueue, everywhereGranted, hostOf, userSitePatterns */
/* exported installSpotRules, startInOpenTabs */
"use strict";

const {
  CONTENT_JS,
  USER_SCRIPT_ID,
  EVERYWHERE_ORIGIN,
  EVERYWHERE_SCRIPT_ID,
  AI_URL_REGEX,
  PROMPT_SELECTORS,
  dropPicksWithoutEverywhere,
  SEARCH_SITES,
} = globalThis.ClotrSites;

// ---------- Spotting new AI tools ----------

async function loadImageData(path) {
  const blob = await (await fetch(chrome.runtime.getURL(path))).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
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

// Another worker (the one this reload is replacing, or one running the moment a permission changes) can act
// on the registration between this call's look and its write. So "already gone" on an unregister is a
// success, not a failure, and the register and update fallbacks below cover the registration turning up or
// vanishing either way.
function goneAlready(err) {
  return /does not exist/i.test(String(err?.message || err));
}

async function unregisterIfThere(ids) {
  await chrome.scripting.unregisterContentScripts({ ids }).catch((err) => {
    if (!goneAlready(err)) throw err;
  });
}

// Updates the registration if this call saw one, or registers it fresh.
async function saveRegistration(script, existing) {
  if (existing.length) {
    try {
      await chrome.scripting.updateContentScripts([script]);
    } catch (err) {
      // Another sync unregistered it in the moment between this one's look and its write. Registering it
      // fresh gives the same result.
      if (!goneAlready(err)) throw err;
      await chrome.scripting.registerContentScripts([script]);
    }
    return;
  }
  try {
    await chrome.scripting.registerContentScripts([script]);
  } catch (err) {
    // While the extension reloads, the worker that's going away can finish registering after this one
    // looked, so the ID turns out to be taken. Updating that registration gives the same result.
    if (!/duplicate/i.test(String(err?.message || err))) throw err;
    await chrome.scripting.updateContentScripts([script]);
  }
}

async function syncUserSites() {
  const legacy = await chrome.scripting.getRegisteredContentScripts({ ids: LEGACY_USER_SCRIPT_IDS });
  if (legacy.length) await unregisterIfThere(legacy.map((registered) => registered.id));
  const matches = await userSitePatterns();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [USER_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await unregisterIfThere([USER_SCRIPT_ID]);
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
  await saveRegistration(script, existing);
  console.info(LOG, "user-added AI sites:", matches);
}

// ---------- Everywhere I type ----------

// Where "Everywhere I type" doesn't run: the built-in AI tools and every site switched on by itself (an email
// or chat app, a search engine, a support chat, an AI site added by hand), which already have their own copy
// of Clotr, plus search engines, since a search box isn't a chat box and stays its own choice. An email or
// chat app or a support chat that isn't switched on by itself is covered. That's every chat box, and on
// those sites the page gets the people-reading wording all the same (settingsFor).
async function dedicatedMatches() {
  const searchMatches = SEARCH_SITES.flatMap((site) => site.matches);
  return [...builtInMatches(), ...searchMatches, ...(await userSitePatterns())];
}

// Keeps the one dynamic content script for "Everywhere I type": on only while the browser holds the
// EVERYWHERE_ORIGIN grant, and never on a site with its own dedicated setup. Re-synced alongside
// syncUserSites, since adding or removing a hand-picked AI site changes what this one has to exclude.
async function syncEverywhere() {
  const { origins = [] } = await chrome.permissions.getAll();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [EVERYWHERE_SCRIPT_ID] });
  if (!everywhereGranted(origins)) {
    if (existing.length) await unregisterIfThere([EVERYWHERE_SCRIPT_ID]);
    return;
  }
  const script = {
    id: EVERYWHERE_SCRIPT_ID,
    matches: [EVERYWHERE_ORIGIN],
    excludeMatches: await dedicatedMatches(),
    js: CONTENT_JS,
    runAt: "document_start",
    allFrames: true,
    persistAcrossSessions: true,
  };
  await saveRegistration(script, existing);
  console.info(LOG, "Everywhere I type is on");
}

// ---------- Starting in tabs already open ----------

// Starts protecting a newly added site's already-open tabs without needing a reload, but only the tabs
// inside the sections the user actually chose, not every page on the host.
async function injectIntoOpenTabs(origins) {
  const hosts = new Set(origins.map(hostOf));
  const patterns = (await userSitePatterns()).filter((pattern) => hosts.has(hostOf(pattern)));
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

// The same idea as injectIntoOpenTabs, for "Everywhere I type": every open https tab outside the dedicated
// list, so switching it on protects tabs already open without needing a reload. A no-op while it's off.
async function injectEverywhereIntoOpenTabs() {
  const { origins = [] } = await chrome.permissions.getAll();
  if (!everywhereGranted(origins)) return;
  const exclude = await dedicatedMatches();
  const tabs = await chrome.tabs.query({ url: [EVERYWHERE_ORIGIN] });
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (exclude.some((pattern) => globalThis.ClotrSites.urlMatchesAny(tab.url, [pattern]))) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
    } catch (err) {
      console.warn(LOG, "could not start on open tab", tab.id, err);
    }
  }
}

// Starts the new version in every open AI tab right after an install or update, so nobody has to reload a
// page by hand. An older copy still running in a tab steps aside once the new one starts (on-websites/content.js).
async function startInOpenTabs() {
  const builtIn = chrome.runtime.getManifest().content_scripts[0].matches;
  const patterns = [...builtIn, ...(await userSitePatterns())];
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

// ---------- When grants and sections change ----------

chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  enqueue(async () => {
    await syncUserSites();
    await syncEverywhere();
    if (everywhereGranted(origins)) await injectEverywhereIntoOpenTabs();
    else await injectIntoOpenTabs(origins);
  }).catch((err) => console.error(LOG, "adding site failed", err));
});

chrome.permissions.onRemoved.addListener(() => {
  enqueue(async () => {
    await dropPicksWithoutEverywhere(); // Everywhere I type switched off: what it alone kept on goes off too
    await syncUserSites();
    await syncEverywhere();
  }).catch((err) => console.error(LOG, "removing site failed", err));
});

// Updates where Clotr runs when the chosen sections change without a permission change, such as adding
// another section on an already-granted host, or removing one. A user-added site also changes what
// "Everywhere I type" has to exclude, so it's re-synced here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.siteScopes) {
    enqueue(async () => {
      await syncUserSites();
      await syncEverywhere();
    }).catch((err) => console.error(LOG, "site sync failed", err));
  }
});
