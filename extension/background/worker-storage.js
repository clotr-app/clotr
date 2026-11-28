/* global ensureSalt */
/* exported RESPONSE_VALUES, SETTINGS_KEYS, builtInMatches, dedupeVault, everywhereGranted, managedEntries,
            offerTeamTrainingSafely, policyRead, sessionArea, userSitePatterns */
"use strict";

const { policyWords, policyShapes, mergePolicy, hasPolicy } = globalThis.ClotrSites;

// ---------- Names the parts share ----------

// Several parts read these. They're set here, in the first part, because Firefox and Safari run each part
// as its own script, and an event can reach a listener in start-on-sites.js before the files after it load.
const LOG = "[Clotr]";

const { dedupeVault } = globalThis.Clotr;
const { userSitePatterns, builtInMatches, everywhereGranted } = globalThis.ClotrSites;

// ---------- Session storage ----------

// Session storage holds which tabs Clotr runs in, and it clears when the browser closes. Safari only added it
// in 16.4, so older browsers fall back to an in-memory copy that lasts as long as the worker does.
const sessionArea = chrome.storage.session || memoryStorage();

function memoryStorage() {
  const values = new Map();
  // Stored values are JSON, as in real storage.
  function copyOf(value) {
    return JSON.parse(JSON.stringify(value));
  }
  return {
    get: async (key) => (values.has(key) ? { [key]: copyOf(values.get(key)) } : {}),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) values.set(key, copyOf(value));
    },
    remove: async (keys) => {
      for (const key of [].concat(keys)) values.delete(key);
    },
  };
}

// ---------- One write at a time ----------

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

// ---------- The team's policy ----------

// The admin's policy (managed storage), or {} when there is none. Reading managed storage can take seconds
// in a browser that just started, and every page's settings wait on it, so the answer is kept and read again
// only when the admin's policy changes (the storage listener below). A read that fails isn't kept.
let policyRead = null;
function readPolicy() {
  if (policyRead) return policyRead;
  const read = Promise.resolve()
    .then(() => chrome.storage.managed?.get(null))
    .then(
      (raw) => mergePolicy(raw || {}),
      () => {
        if (policyRead === read) policyRead = null;
        return mergePolicy({});
      },
    );
  policyRead = read;
  return policyRead;
}
readPolicy(); // started now, so the first page's settings don't wait for all of it

// Opens the office training walkthrough once, the first time a team policy shows up on this computer.
// Settings keeps its own link to it afterwards, next to the policy's own banner.
async function offerTeamTraining() {
  if (!chrome.runtime.getManifest().clotr_features?.training) return; // held back in this build
  if (!hasPolicy(await readPolicy())) return;
  const { trainingOffered } = await chrome.storage.local.get("trainingOffered");
  if (trainingOffered) return;
  await chrome.storage.local.set({ trainingOffered: true });
  await chrome.tabs
    .create({ url: chrome.runtime.getURL("clotr-pages/office-training/office-training.html") })
    .catch(() => {});
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
  const needsSalt = words.length || kinds.some((kind) => kind.words.length);
  const salt = needsSalt ? await ensureSalt() : "";
  const key = JSON.stringify([salt, words, shapes, kinds]);
  if (managedCache.key === key) return managedCache.entries;

  function managedWord(type, phrase) {
    return { ...globalThis.Clotr.wordEntry(salt, type, phrase), managed: true };
  }
  function managedShape(type, shape, near) {
    return { kind: "shape", type, shape, ...(near?.length ? { near } : {}), managed: true };
  }
  const entries = [
    ...words.map((phrase) => managedWord("watch_list", phrase)),
    ...shapes.map((shape) => managedShape("watch_list", shape)),
    ...kinds.flatMap((kind) => [
      ...kind.words.map((phrase) => managedWord(kind.id, phrase)),
      ...kind.formats.map((shape) => managedShape(kind.id, shape, kind.near)),
    ]),
  ];
  managedCache = { key, entries };
  return entries;
}
