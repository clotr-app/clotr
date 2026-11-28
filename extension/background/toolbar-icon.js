/* global TOURNIQUET_END, enqueue, pruneEvents, sessionArea, stepTourniquetSafely */
"use strict";

const ICON = (variant) => ({ 16: `icons/icon-${variant}-16.png`, 32: `icons/icon-${variant}-32.png` });
const BADGE_BRAND = "#5b3a63"; // plum, white text 9.4:1
const BADGE_RED = "#d03b3b";
const { weight } = globalThis.ClotrSites;

// ---------- Toolbar: tooltip (all tabs) and badge (protected tabs only) ----------

const UI_REMOVED_TITLE = "This page removed Clotr's warnings, so Clotr can't warn you here.";
const EDIT_FAILED_TITLE =
  "Clotr couldn't edit the chat box on this page. Delete flagged details by hand before sending.";

function todaySummary(events, mentions = []) {
  const start = new Date().setHours(0, 0, 0, 0);
  const today = events.filter((record) => record.t >= start);
  const replies = mentions.filter((record) => record.t >= start && record.action === "mentioned");
  // A record for a long list counts as its n.
  function sum(list) {
    return list.reduce((total, record) => total + weight(record), 0);
  }
  function count(action) {
    return sum(today.filter((record) => record.action === action));
  }
  return {
    total: sum(today),
    replyMentions: replies.length,
    redacted: count("redacted"),
    allowed: count("allowed"),
    silenced: count("suppressed"),
    riskyAllowed: today.some((record) => record.action === "allowed" && record.severity === "high"),
  };
}

// Protected tabs are tracked in session storage because the worker can be shut down at any time.
async function getProtectedTabs() {
  const { protectedTabs = {} } = await sessionArea.get("protectedTabs");
  return protectedTabs;
}

async function refreshToolbar() {
  const { events = [], mentions = [] } = await chrome.storage.local.get(["events", "mentions"]);
  const today = todaySummary(events, mentions);
  const replyWord = today.replyMentions === 1 ? "reply" : "replies";
  const replySummary = `${today.replyMentions} AI ${replyWord} mentioned your details`;
  const todaySummaryText = [today.total ? `${today.total} found` : "", today.replyMentions ? replySummary : ""]
    .filter(Boolean)
    .join(" · ");
  const outcomeCounts = `${today.redacted} hidden · ${today.allowed} sent · ${today.silenced} just counted`;
  const title = todaySummaryText
    ? `Clotr — today: ${todaySummaryText}\n${outcomeCounts}`
    : "Clotr — nothing found today";
  await chrome.action.setTitle({ title });

  const tabs = await getProtectedTabs();
  for (const [id, state] of Object.entries(tabs)) {
    const tabId = Number(id);
    // Self-check: a failed edit outranks the count, so a blind tab never looks fine.
    const failed = (state.editFailed || state.uiRemoved) && !state.paused;
    const count = today.total + today.replyMentions;
    let text = "";
    if (failed) text = "!";
    else if (!state.paused && count) text = String(count);
    let tabTitle = title;
    if (failed) tabTitle = state.uiRemoved ? UI_REMOVED_TITLE : EDIT_FAILED_TITLE;
    try {
      await chrome.action.setBadgeText({ tabId, text });
      if (text) {
        try {
          await chrome.action.setBadgeBackgroundColor({
            tabId,
            color: failed || today.riskyAllowed || today.replyMentions ? BADGE_RED : BADGE_BRAND,
          });
        } catch {
          /* Safari: badges have no colour there (it refuses this one); the count still shows */
        }
      }
      await chrome.action.setTitle({ tabId, title: tabTitle });
    } catch {
      delete tabs[id]; // tab is gone
    }
  }
  await sessionArea.set({ protectedTabs: tabs });
}

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
  const tabHealth = { paused: false, editor: false, editFailed: false, ...tabs[tabId] };
  if (msg.editor === true) tabHealth.editor = true;
  if (typeof msg.editFailed === "boolean") tabHealth.editFailed = msg.editFailed;
  if (msg.uiRemoved === true) tabHealth.uiRemoved = true;
  tabs[tabId] = tabHealth;
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
  if (alarm.name === TOURNIQUET_END) {
    stepTourniquetSafely();
    return;
  }
  if (alarm.name !== "refresh-toolbar") return;
  enqueue(refreshToolbar); // rolls "today" over after midnight
  enqueue(pruneEvents);
  stepTourniquetSafely(); // keeps watch on the clock, and sets the end alarm again if the browser lost it
});
