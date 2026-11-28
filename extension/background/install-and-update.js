/* global LOG, dedupeVault, enqueue, ensureSalt, getProtectedTabs, injectEverywhereIntoOpenTabs, installSpotRules,
          offerTeamTrainingSafely, pruneEvents, refreshToolbar, sessionArea, startInOpenTabs, stepTourniquetSafely,
          syncEverywhere, syncUserSites, userSitePatterns */
"use strict";

const { grantedEverydayApps, coveredByEverywhere, EVERYDAY_SITES, offerAfterInstall } = globalThis.ClotrSites;

// ---------- Settings migration ----------

// An older version stored "Don't warn me again" as suppressed.global[id]; this turns that into the "log"
// response.
async function migrateSuppressed() {
  const { suppressed, responses = {} } = await chrome.storage.local.get(["suppressed", "responses"]);
  if (!suppressed) return;
  const next = { ...responses };
  for (const [id, on] of Object.entries(suppressed.global || {})) {
    if (on && !next[id]) next[id] = "log";
  }
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

// Older versions had an "off" response. This version always records, so old "off" becomes "log".
async function migrateOffToLog() {
  const { responses } = await chrome.storage.local.get("responses");
  if (!responses || !Object.values(responses).includes("off")) return;
  const offAsLog = Object.entries(responses).map(([id, response]) => [id, response === "off" ? "log" : response]);
  const next = Object.fromEntries(offAsLog);
  await chrome.storage.local.set({ responses: next });
  console.info(LOG, "turned old Off settings into Log only");
}

// An older version kept "It's me" and watch-list entries separately. This folds both into the
// vault, and an "It's me" entry keeps its old meaning: it's still something the user is fine sharing.
async function migrateToVault() {
  const { mine, watch, vault = [] } = await chrome.storage.local.get(["mine", "watch", "vault"]);
  if (!mine && !watch) return;
  const next = vault.slice();
  for (const entry of mine || []) {
    next.push({ kind: "value", type: entry.type, fp: entry.fp, mode: "allow", added: entry.added });
  }
  for (const watchEntry of watch || []) next.push({ ...watchEntry, type: "watch_list" });
  await chrome.storage.local.set({ vault: dedupeVault(next) });
  await chrome.storage.local.remove(["mine", "watch"]);
  console.info(LOG, "moved It's me + watch list into the vault:", next.length, "entries");
}

// ---------- Updates ----------

// The Chrome Web Store updates a store install on its own. An unpacked install has no store to do that, so
// it rereads its own manifest from disk every minute and reloads once the version there has changed.

// Safari installs come from an app (the App Store, TestFlight or Xcode), never from a folder, so there's
// nothing to check there.
const IS_UNPACKED =
  !("update_url" in chrome.runtime.getManifest()) &&
  !chrome.runtime.getManifest().browser_specific_settings?.safari &&
  !chrome.runtime.getURL("").startsWith("safari-web-extension:");

// Firefox updates an add-on from addons.mozilla.org itself, and that has no update_url either, so in
// Firefox only a temporary or folder install ("development") counts. getSelf needs no extra permission
// there.
async function isUnpacked() {
  if (!IS_UNPACKED) return false;
  if (!chrome.runtime.getManifest().browser_specific_settings?.gecko) return true;
  try {
    return (await chrome.management.getSelf()).installType === "development";
  } catch {
    return false; // can't tell: a store install is far more likely, and it updates itself
  }
}

async function localVersionOnDisk() {
  const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
  return (await response.json()).version;
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
    const response = await fetch(chrome.runtime.getURL("local-update.txt"), { cache: "no-store" });
    if (!response.ok) return "";
    return (await response.text()).trim().slice(0, 200);
  } catch {
    return "";
  }
}

async function checkForLocalUpdate() {
  if (!(await isUnpacked())) return false;
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
      const waitNote = "waiting: a Clotr dialog or warning is open";
      console.info(LOG, `files updated on disk (${running} → ${onDisk}); ${waitNote}`);
      return false;
    }
  }
  const newBuild = restamped ? ", new local build" : "";
  console.info(LOG, `files updated on disk (${running} → ${onDisk}${newBuild}); reloading`);
  await sessionArea.remove("updateWaitingSince");
  await sessionArea.set({ localStamp: stamp }); // never reload twice for the same files
  chrome.runtime.reload();
  return true;
}

function scheduleUpdateCheck() {
  isUnpacked()
    .then((unpacked) => unpacked && chrome.alarms.create("local-update-check", { periodInMinutes: 1 }))
    .catch(() => {});
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
  // Counts an app switched on while Everywhere I type covered it, and the ones it covers, as on already.
  const anyGranted = grantedEverydayApps(await userSitePatterns()).length > 0;
  const anyOn = anyGranted || coveredByEverywhere(EVERYDAY_SITES, origins).length > 0;
  const next = offerAfterInstall(reason, everydayOffer, anyOn);
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
  if (details?.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/vault/vault.html?welcome=1") }).catch(() => {});
  }
  enqueue(runMigrations).catch((err) => console.error(LOG, "settings migration failed", err));
  enqueue(() => followPersonalSwitch(details?.reason)).catch((err) =>
    console.error(LOG, "personal-details switch failed", err),
  );
  enqueue(ensureSalt).catch((err) => console.error(LOG, "salt setup failed", err));
  enqueue(() => noteEverydayOffer(details?.reason)).catch((err) => console.error(LOG, "offer bookkeeping failed", err));
  enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  enqueue(syncEverywhere).catch((err) => console.error(LOG, "everywhere sync failed", err));
  if (details?.reason === "install" || details?.reason === "update") {
    startInOpenTabs().catch((err) => console.warn(LOG, "could not start in open tabs", err));
    enqueue(injectEverywhereIntoOpenTabs).catch((err) => console.warn(LOG, "could not start on open tabs", err));
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
  // Not injected into open tabs here. The registration persists across sessions, so tabs restored at
  // startup load it themselves, and injecting again would only start a second copy that then steps aside.
  enqueue(syncEverywhere).catch((err) => console.error(LOG, "everywhere sync failed", err));
  // Firefox drops alarms when the browser closes, and Chrome may too, so the 30-minute refresh is set again.
  chrome.alarms.create("refresh-toolbar", { periodInMinutes: 30 });
  enqueue(refreshToolbar).catch(() => {});
  enqueue(pruneEvents).catch(() => {}); // history past "Keep history for" goes now, not at the next detection
  offerTeamTrainingSafely();
  stepTourniquetSafely(); // the end alarm again, or the end itself if it came while the browser was closed
});

// "Ask before sending personal details" stays on across an update, and any personal kind the update adds
// starts out asking too, instead of quietly falling back to just a warning. Clotr remembers which kind ids
// it already knew about so it can tell what's new.
async function followPersonalSwitch(reason) {
  if (reason !== "install" && reason !== "update") return;
  const { Helper, PATTERNS } = globalThis.Clotr;
  const ids = PATTERNS.map((pattern) => pattern.id);
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
