/* global Clotr, answerAsked, appendEvents, bandageFor, clearHistory, enqueue, ensureSalt, importBackup, markGuided,
          markTab, noteHealth, noteIgnored, notePicture, readAsked, refreshToolbar, relaxAnswer, setBandage,
          setResponses, settingsFor, siteShape, vaultAdd, vaultUpdate */
"use strict";

// ---------- Keyboard: Alt+Shift+C jumps to Clotr's warning ----------

async function handleCommand(command, tab) {
  if (command !== "focus-notice") return;
  const id = tab?.id ?? (await frontTabId());
  if (id) chrome.tabs.sendMessage(id, { type: "clotr:focusNotice" }).catch(() => {});
}

// Safari before 18 doesn't say which tab, so the command goes to the one in front.
async function frontTabId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return tabs[0]?.id;
}

chrome.commands?.onCommand.addListener(handleCommand); // none on Firefox for Android

// ---------- Messages from content scripts / popup ----------

// True for Clotr's own pages, like the vault or settings, never for a content script inside an AI site,
// which shares that page with the site's own code.
const fromClotrPage = (sender) => (sender.url || "").startsWith(chrome.runtime.getURL(""));

// Opens one of Clotr's own pages from a warning, like the "Is this a scam?" page, right next to the chat's
// own tab when the browser says where that is, or at the end of the window otherwise.
async function openBeside(url, tab) {
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
const openCheckPage = (tab) => openBeside(chrome.runtime.getURL("clotr-pages/scam-check/scam-check.html"), tab);
const openTrackingPage = (tab) =>
  openBeside(chrome.runtime.getURL("clotr-pages/how-ads-follow-you/how-ads-follow-you.html"), tab);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  // For a request that writes: it waits its turn in the queue.
  function reply(task) {
    enqueue(task)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true; // respond asynchronously
  }
  // For a request that only reads: it doesn't wait behind the queue's writes, since a page runs on the
  // defaults until its settings come (one slow write once held a new chat page there for 9.5 s).
  function answer(task) {
    Promise.resolve()
      .then(task)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  return routeMessage(msg, sender, reply, answer);
});

// One case per message type. Each returns true when it answers later, or false when there's no answer. The
// types are split into three groups, and each group answers undefined for a type that isn't one of its own.
function routeMessage(msg, sender, reply, answer) {
  return (
    routeHistoryMessage(msg, sender, reply) ??
    routeSettingsMessage(msg, sender, reply, answer) ??
    routeTabMessage(msg, sender, reply) ??
    false
  );
}

// History and the vault.
function routeHistoryMessage(msg, sender, reply) {
  switch (msg?.type) {
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
      return reply(() => vaultAdd(msg.entries, !fromClotrPage(sender), { tab: sender.tab }));
    case "clotr:vaultUpdate":
      // Only the vault page removes an entry or switches it to "allow".
      if (!fromClotrPage(sender)) return false;
      return reply(() => vaultUpdate(msg.key, msg.change));
    case "clotr:importBackup":
      // Only from Clotr's own pages (the "Move to a new computer" section), never from a website's tab.
      if (!fromClotrPage(sender)) return false;
      return reply(() => importBackup(msg.settings));
    default:
      return undefined;
  }
}

// Settings, the salt, and the choices a page asks about.
function routeSettingsMessage(msg, sender, reply, answer) {
  switch (msg?.type) {
    case "clotr:getSalt":
      return answer(async () => ({ salt: await ensureSalt() }));
    case "clotr:ignored":
      return reply(() => noteIgnored(msg.types));
    case "clotr:guided":
      return reply(() => markGuided(msg.id));
    case "clotr:relaxAnswer":
      return reply(() => relaxAnswer(msg.id, msg.accepted));
    case "clotr:getSettings":
      return answer(() => settingsFor(sender.url || sender.tab?.url || ""));
    case "clotr:setBandage":
      return reply(() => setBandage(sender.url || sender.tab?.url || "", msg.on));
    case "clotr:pictureNoted":
      return reply(() => notePicture(sender.url || sender.tab?.url || ""));
    case "clotr:setResponses":
      return reply(() => setResponses(msg.ids, msg.value, !fromClotrPage(sender), { tab: sender.tab }));
    case "clotr:askedRead":
      // Only Clotr's own page reads or answers a choice held for it (askOnClotrPage), never a chat page.
      if (!fromClotrPage(sender)) return false;
      return reply(() => readAsked(msg.token));
    case "clotr:askedAnswer":
      if (!fromClotrPage(sender)) return false;
      return reply(() => answerAsked(msg.token, msg.yes === true));
    default:
      return undefined;
  }
}

// Clotr's own pages opened from a warning, and what a tab says about itself.
function routeTabMessage(msg, sender, reply) {
  switch (msg?.type) {
    case "clotr:openCheck":
      // A warning's "Get a second opinion": opens Clotr's own Is this a scam? page in a new tab beside the
      // chat. The page is always this fixed one; nothing from the message goes with it.
      openCheckPage(sender.tab);
      return false;
    case "clotr:openTracking":
      // Clean link's "How ads follow you": same fixed-page, new-tab pattern as openCheck. The content script
      // can't navigate to an extension page directly, since the chat page it's running on isn't Clotr's own.
      openTrackingPage(sender.tab);
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
      return undefined;
  }
}

// ---------- The tab port ----------

// A content script opens one of these the moment it starts, before it asks for real settings, so it gets
// just the Bandage flag right away instead of waiting on settingsFor's slower lookup. Firefox can suspend
// this worker between tabs and take a few seconds to wake it. Keeping the port open while a tab is open
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
    const stored = await chrome.storage.local.get(["bandage", "siteKinds"]);
    const { noAiFeatures } = await siteShape(host, stored.siteKinds || {});
    try {
      port.postMessage({ type: "clotr:bandage", on: bandageFor(noAiFeatures, host, stored) });
    } catch {
      /* the tab closed before this resolved */
    }
  })();
});

// ---------- Sync with Clotr for Windows (held back) ----------

async function oneClotrSync() {
  const protocol = globalThis.Clotr?.OneClotrProtocol;
  if (!protocol) return;
  const stored = await chrome.storage.local.get([...protocol.SETTINGS, "oneClotrMeta", "oneClotrPaired"]);
  if (!stored.oneClotrPaired) return;
  if (!(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))) return;
  try {
    const remote = await Clotr.OneClotrBridge.readSettings();
    const now = Date.now();
    const { set, remove } = protocol.apply(stored, remote, now);
    await chrome.storage.local.set(set);
    if (remove.length) await chrome.storage.local.remove(remove);
    await Clotr.OneClotrBridge.writeSettings(protocol.settingsForWrite(stored, remote, now));
  } catch {
    // A missing or closed desktop app skips this sync; the next ordinary settings change tries again.
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  const protocol = globalThis.Clotr?.OneClotrProtocol;
  if (!protocol || area !== "local") return;
  const keys = protocol.SETTINGS.filter((key) => changes[key]);
  if (!keys.length) return;
  (async () => {
    const stored = await chrome.storage.local.get(["oneClotrPaired", "oneClotrMeta", ...keys]);
    if (!stored.oneClotrPaired) return;
    const meta = { ...(stored.oneClotrMeta || {}) };
    if (!changes.oneClotrMeta) {
      for (const key of keys) {
        if (meta[key]?.linked !== false) meta[key] = { ...(meta[key] || {}), updatedAt: Date.now() };
      }
      await chrome.storage.local.set({ oneClotrMeta: meta });
    }
    await oneClotrSync();
  })();
});

chrome.runtime.onStartup.addListener(oneClotrSync);
