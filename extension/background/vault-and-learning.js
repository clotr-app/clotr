/* global askOnClotrPage, chatGuard, dedupeVault */
/* exported importBackup, markGuided, noteIgnored, relaxAnswer, vaultAdd, vaultUpdate */
"use strict";

const { VAULT_MODES, vaultKey, cleanVaultEntry } = globalThis.Clotr;

// ---------- Vault: only this worker writes it ----------

// Entries hold fingerprints or formats, never values. Every entry passes through cleanVaultEntry first, so
// nothing malformed, and nothing raw, ever gets stored. dedupeVault then keeps one entry per fingerprint or
// format.

// fromChat is true when the call came from inside a chat page itself, where chatGuard won't let someone
// mark a kind "OK to share" if the team's policy holds it, and where any "OK to share" waits for Clotr's own
// page (askOnClotrPage) unless that page `confirmed` it. "Always watch" from a chat page is kept right
// away.
async function vaultAdd(entries, fromChat = false, { tab = null, confirmed = false } = {}) {
  let clean = (Array.isArray(entries) ? entries : []).map(cleanVaultEntry).filter(Boolean);
  const guard = fromChat ? await chatGuard() : null;
  if (guard) clean = clean.filter((entry) => !(entry.mode === "allow" && guard.holds(entry.type)));
  const asked = guard && !confirmed ? clean.filter((entry) => entry.mode === "allow") : [];
  if (asked.length) {
    await askOnClotrPage({ entries: asked }, tab);
    clean = clean.filter((entry) => entry.mode !== "allow");
  }
  const { vault = [] } = await chrome.storage.local.get("vault");
  const before = new Set(vault.map(vaultKey));
  const next = dedupeVault(vault.concat(clean));
  await chrome.storage.local.set({ vault: next });
  return {
    added: clean.filter((entry) => !before.has(vaultKey(entry))).length,
    rejected: (entries?.length || 0) - clean.length - asked.length,
    ...(asked.length ? { asked: true } : {}),
  };
}

// Restoring a backup replaces this browser's settings, vault and salt with the ones in the file. Everything
// is cleaned again here, so a hand-edited file can't smuggle anything else in. History is left alone.
async function importBackup(settings) {
  const clean = globalThis.Clotr.Backup.clean(settings);
  const vault = dedupeVault((clean.vault || []).map(cleanVaultEntry).filter(Boolean));
  const next = { ...clean, vault };
  const drop = globalThis.Clotr.Backup.KEYS.filter((key) => !(key in next) && key !== "salt");
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set(next);
  return { ok: true, vault: vault.length, responses: Object.keys(clean.responses || {}).length };
}

async function vaultUpdate(key, change) {
  const { vault = [] } = await chrome.storage.local.get("vault");
  // Only a saved value takes a new mode, and only one of the known modes.
  function changesMode(entry) {
    return vaultKey(entry) === key && entry.kind === "value" && VAULT_MODES.has(change);
  }
  let next;
  if (change === "remove") next = vault.filter((entry) => vaultKey(entry) !== key);
  else next = vault.map((entry) => (changesMode(entry) ? { ...entry, mode: change } : entry));
  await chrome.storage.local.set({ vault: next });
  return { ok: true };
}

// ---------- Learning from ignores (type + timestamps only, never values) ----------

const DAY = 86400000;
const IGNORES_TO_OFFER = 3;
const validType = (type) => typeof type === "string" && /^[a-z_]{2,40}$/.test(type);

// Records that the user kept a warning instead of acting on it, and checks whether it's time to offer
// relaxing that kind: kept 3 times in 14 days, not declined in the last 30, not held by a team policy.
async function noteIgnored(types) {
  const now = Date.now();
  const guard = await chatGuard();
  const { ignores = {}, relaxDeclined = {} } = await chrome.storage.local.get(["ignores", "relaxDeclined"]);
  for (const type of (Array.isArray(types) ? types : []).filter(validType)) {
    ignores[type] = (ignores[type] || []).filter((time) => now - time < 14 * DAY).concat(now);
  }
  await chrome.storage.local.set({ ignores });
  const offer = Object.keys(ignores).find(
    (type) =>
      types.includes(type) &&
      !guard.holds(type) &&
      ignores[type].length >= IGNORES_TO_OFFER &&
      !(now - (relaxDeclined[type] || 0) < 30 * DAY),
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
