/* global $, BUILT_IN, Report, Sites, el, firefoxPanel, isLocked, msg, prettyPattern, renderSettings, say,
          site:writable, state */
/* exported isFirefoxPanel, setEverydaySite */
"use strict";

// ---------- Current site ----------

// One of Clotr's own pages, like the welcome page right after install, which is where most people open the
// popup first: the site card names the page instead of saying there's no web page. Only this extension's
// pages count, never another extension's.
function ownPage(url, tab) {
  if (!url || !url.href.startsWith(chrome.runtime.getURL(""))) return null;
  if (url.pathname === "/clotr-pages/vault/vault.html" && url.searchParams.has("welcome")) return { welcome: true };
  return { title: (tab.title || "").trim() };
}

async function detectSite() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tab */
  }
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    site = { kind: "none", own: ownPage(url, tab) };
    return;
  }

  const base = { tabId: tab.id, host: url.hostname, url: url.href };
  const builtIn = Sites.urlMatchesAny(url.href, BUILT_IN);
  const added = Sites.urlMatchesAny(url.href, state.userSites);
  if (builtIn || added) {
    // Self-check: what this tab's Clotr reported (no entry = it isn't running here).
    let health = null;
    try {
      health = (await chrome.storage.session.get("protectedTabs")).protectedTabs?.[tab.id] || null;
    } catch {
      /* unknown: treat as not reported */
    }
    // A built-in site can still be missing its host access (Firefox at every install, Chrome by hand
    // through its per-site "On click" setting), which looks just like Clotr not running yet but a reload
    // never fixes it.
    let access = true;
    if (builtIn) {
      const matches = Sites.builtInMatchesFor(url.href);
      try {
        access = matches.length ? await chrome.permissions.contains({ origins: matches }) : true;
      } catch {
        access = true;
      }
    }
    site = { ...base, kind: "protected", source: builtIn ? "built-in" : "added by you", health, access };
    return;
  }
  if (url.protocol !== "https:") {
    site = { ...base, kind: "not-ai" };
    return;
  }

  // Unknown https site: check it now (activeTab grants one-time access because the user opened the popup).
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: Sites.inspectPageForAIChat,
    });
    site = { ...base, kind: Sites.spotKind(url.hostname, result), signals: result?.signals || [] };
    if (site.kind === "spotted") noteSpotted(url.hostname);
  } catch {
    site = { ...base, kind: "not-ai", signals: [] };
  }
}

// Records an AI tool Clotr spotted but doesn't protect, so its name can show up on the mind map's blind
// spots. This is the only place Clotr learns about one, since it opens the popup there; it has no other way
// to see an unprotected site.
const MAX_SPOTTED = 200;
async function noteSpotted(host) {
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || state.spotted[host]) return;
  const names = Object.keys(state.spotted).slice(-(MAX_SPOTTED - 1));
  const spotted = Object.fromEntries([...names, host].map((name) => [name, true]));
  state.spotted = spotted;
  await chrome.storage.local.set({ spotted }).catch(() => {});
}

// Firefox's question about a site opens under its toolbar popup and covers its own Allow button, so there
// the popup closes as soon as an ask has gone out in the click's own turn, and the question is left in
// front. Firefox keeps the question and the grant once the popup is gone, and background.js sets the site
// up when the grant arrives. A site already granted, or covered by Everywhere I type, gets a yes with no
// question, so the popup stays for those. Firefox for Android shows the popup as a tab, and Chrome's
// question sits on top.
function leavesForQuestion(origins) {
  if (!firefoxPanel) return false;
  const broad = Sites.everywhereGranted(state.grants);
  return origins.some((origin) => !state.grants.includes(origin) && !(broad && origin.startsWith("https://")));
}

async function isFirefoxPanel() {
  if (!chrome.runtime.getManifest().browser_specific_settings?.gecko) return false;
  try {
    const [{ os }, tab] = await Promise.all([chrome.runtime.getPlatformInfo(), chrome.tabs.getCurrent()]);
    return os !== "android" && !tab;
  } catch {
    return false;
  }
}

// `kind`: "ai" for an AI tool, "everyday" for an email or chat app.
async function protectSite(url, kind = "ai") {
  // Both the storage write and the permission ask happen in the same click, before anything is awaited: the
  // browser's own prompt can close this popup, and Firefox refuses the prompt once anything has been awaited
  // first. background.js finishes the setup from storage either way, so this uses the popup's own copy of the
  // state instead of reading it fresh.
  const scope = Sites.protectScope(url);
  const perm = Sites.permissionFor(scope);
  const siteScopes = { ...state.siteScopes };
  if (scope === perm) {
    delete siteScopes[perm];
  } // the whole host
  else siteScopes[perm] = [...new Set([...(siteScopes[perm] || []), scope])];
  const siteKinds = { ...state.siteKinds, [new URL(url).hostname]: kind };
  Object.assign(state, { siteScopes, siteKinds });
  chrome.storage.local.set({ siteScopes, siteKinds }).catch(() => {});
  const asked = chrome.permissions.request({ origins: [perm] }).catch(() => false);
  if (leavesForQuestion([perm])) window.close();
  const granted = await asked;
  if (granted) {
    await Sites.notePicks([scope]); // a yes Everywhere I type already covered is never recorded by the browser
    await refreshSites();
  }
}

// Asks for exactly this built-in site's access, when the browser withheld it: Firefox does that at every
// install, and Chrome's own per-site "On click" setting does the same by hand. The ask has to come first, in
// the click's own turn, like protectSite above, since Firefox refuses it once anything has been awaited.
async function allowBuiltInHere(url) {
  const origins = Sites.builtInMatchesFor(url);
  const asked = chrome.permissions.request({ origins }).catch(() => false);
  if (leavesForQuestion(origins)) window.close();
  const granted = await asked;
  if (granted) await detectSite();
  return granted;
}

async function setSiteKinds(hosts, kind) {
  const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
  for (const host of hosts) {
    if (kind) siteKinds[host] = kind;
    else delete siteKinds[host];
  }
  state.siteKinds = siteKinds;
  await chrome.storage.local.set({ siteKinds });
}

async function refreshSites() {
  state.userSites = await Sites.userSitePatterns();
  state.grants = (await chrome.permissions.getAll()).origins || [];
  state.everywhereOn = Sites.everywhereGranted(state.grants);
  await detectSite();
  renderSite();
  renderSettings();
}

// Settings' "Also on your email and chat apps": one switch per app, asking the browser for exactly its sites.
// Switching on asks first, in the same click (sites-and-policy/protected-sites.js explains why). A listed app counts as an email or chat
// app on its own, and the browser remembers the grant, so the only thing written after a yes is clearing an
// old note that called the app an AI chat, which would keep it out of this list. Switching off also clears
// the note an older version wrote for it.
async function setEverydaySite(everydayApp, on) {
  const hosts = everydayApp.matches.map((pattern) => new URL(pattern.replace(/\*$/, "")).hostname);
  say("everyday-status", "");
  if (on) {
    const asked = Sites.requestEverydayApps([everydayApp.name]);
    if (leavesForQuestion(everydayApp.matches)) {
      // No popup is left to clear the old note after a yes, so it goes now, the way protectSite writes ahead.
      // Clotr only runs on the app once the browser says yes, so after a No the note made no difference
      // anyway.
      if (hosts.some((host) => state.siteKinds[host] === "ai")) {
        const siteKinds = { ...state.siteKinds };
        for (const host of hosts) delete siteKinds[host];
        chrome.storage.local.set({ siteKinds }).catch(() => {});
      }
      window.close();
    }
    const yes = await asked;
    // A closed prompt or a No used to leave this silent; say so instead, the same way the welcome page does.
    if (!yes) {
      say(
        "everyday-status",
        msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        ),
      );
    } else if (hosts.some((host) => state.siteKinds[host] === "ai")) {
      await setSiteKinds(hosts, null);
    }
  } else {
    if (!(await switchedOffHere(everydayApp, Sites.removeEverydayApps))) {
      say("everyday-status", keptOnByEverywhere());
      return;
    }
    await setSiteKinds(hosts, null);
  }
  await refreshSites();
  if (!on && switchOf(everydayApp, state.userSites).on) say("everyday-status", keptOnByEverywhere());
}

// How one listed site's switch reads. `listed` holds the sites switched on by themselves (userSitePatterns):
// their own grants, and any noted while "Everywhere I type" covered them. A site can also be on only because
// Everywhere I type covers it, and `through` says it's on only thanks to that switch, so it goes off with it.
function switchOf(everydayApp, listed) {
  const own = everydayApp.matches.some((pattern) => state.grants.includes(pattern));
  const picked = everydayApp.matches.some((pattern) => listed.includes(pattern));
  const on = picked || Sites.coveredByEverywhere([everydayApp], state.grants).length > 0;
  return { on, through: on && !own, picked };
}

// Switching off a site Clotr runs on only through Everywhere I type has nothing of its own to hand back, so
// it stays on. Hands back whatever the site does have, through `remove` (sites-and-policy/protected-sites.js), and says whether it did.
async function switchedOffHere(everydayApp, remove) {
  if (!switchOf(everydayApp, state.userSites).picked) return false;
  await remove([everydayApp.name]);
  return true;
}

const keptOnByEverywhere = () =>
  msg("pp_keptOnByEverywhere", "Everywhere I type keeps Clotr on here. Switch it off first to pick sites one by one.");

async function setPaused(host, value) {
  const { paused = {} } = await chrome.storage.local.get("paused");
  if (value) paused[host] = true;
  else delete paused[host];
  await chrome.storage.local.set({ paused });
}

const SIGNALS = {
  "AI wording in the address": "pp_sigAddress",
  "AI wording in the page title": "pp_sigTitle",
  "a chat-style prompt box": "pp_sigBox",
  "a send button": "pp_sigSend",
  "a chat-shaped box": "pp_sigShape",
};
const signalText = (signal) => (SIGNALS[signal] ? msg(SIGNALS[signal], signal) : signal);

// Away from an AI chat, say where Clotr does work (first impression: "is it on?").
function coverageLine() {
  const names = state.builtInTools.map((tool) => tool.name);
  const text =
    names.length > 3
      ? msg(
          "pp_coverage",
          "Clotr works on $1 and $2 more AI chats. Using another one? Open this popup there.",
          names.slice(0, 3).join(", "),
          names.length - 3,
        )
      : msg("pp_coverageShort", "Clotr works on AI chat sites. Using another one? Open this popup there.");
  return el("div", { className: "why", textContent: text });
}

function siteStateLine(dotCls, text) {
  return el("div", { className: "state" }, [el("i", { className: `dot ${dotCls}` }), text]);
}

// The line for a tab with no web page, or one of Clotr's own pages.
function ownPageWords(own) {
  if (own?.welcome) return msg("pp_ownWelcome", "This is Clotr's welcome page.");
  if (own?.title) return msg("pp_ownPageNamed", "This is Clotr's “$1” page.", own.title);
  if (own) return msg("pp_ownPage", "This is one of Clotr's own pages.");
  return msg("pp_noPage", "No web page in this tab.");
}

function renderNoPage(box) {
  const line = ownPageWords(site.own);
  box.replaceChildren(el("div", { className: "grow" }, [siteStateLine("", line), coverageLine()]));
}

// A built-in site the browser hasn't let Clotr into: one button asks for it.
function renderNoAccess(box) {
  const status = el("div", { className: "why", role: "status" });
  const allow = el("button", {
    className: "btn primary",
    type: "button",
    textContent: msg("pp_allowHere", "Allow Clotr on this site"),
  });
  allow.addEventListener("click", async () => {
    const granted = await allowBuiltInHere(site.url);
    if (granted) renderSite();
    else {
      status.textContent = msg(
        "pp_allowNo",
        "Your browser didn't allow it, so Clotr still can't warn you here. Use the button to ask again.",
      );
    }
  });
  box.replaceChildren(
    el("div", { className: "grow" }, [
      el("div", { className: "host", textContent: site.host }),
      siteStateLine(
        "warn",
        msg("pp_noAccess", "Your browser hasn't let Clotr into this site, so it can't warn you here."),
      ),
      allow,
      status,
    ]),
  );
}

// Who put this site on Clotr's list, for the health line's tooltip.
function siteSourceWords() {
  if (site.source === "built-in") return msg("pp_builtInSite", "Built-in AI site");
  if (Sites.isEveryday(site.host, state.siteKinds)) {
    return msg("pp_addedEveryday", "Email or chat site you switched on");
  }
  return msg("pp_addedSite", "AI site you added");
}

// What this tab's Clotr reported about itself, as one line with a coloured dot.
function healthLine(isPaused) {
  const health = Sites.healthText({
    running: Boolean(site.health),
    paused: isPaused,
    editor: site.health?.editor,
    editFailed: site.health?.editFailed,
    uiRemoved: site.health?.uiRemoved,
    builtIn: site.source === "built-in",
  });
  const line = siteStateLine(health.level, msg(health.key, health.text));
  line.dataset.health = health.level;
  line.title = siteSourceWords();
  return line;
}

function renderProtectedSite(box) {
  const isPaused = Boolean(state.paused[site.host]);
  const toggle = el("button", {
    className: "btn",
    textContent: isPaused ? msg("pp_resume", "Resume") : msg("pp_pause", "Pause"),
  });
  toggle.addEventListener("click", () => setPaused(site.host, !isPaused));
  if (isLocked() || state.policy?.allowPause === false) {
    toggle.disabled = true;
    toggle.title =
      state.policy?.allowPause === false
        ? msg("pp_orgKeepsOn", "Your organization keeps Clotr on")
        : msg("pp_lockedTab", "Settings are locked (Settings tab)");
  }
  box.replaceChildren(
    el("div", { className: "grow" }, [
      el("div", { className: "host", textContent: site.host }),
      healthLine(isPaused),
      ...(isPaused ? [] : testHere(site)),
    ]),
    toggle,
  );
}

function testAnswerWords(answer) {
  if (!answer) {
    return msg("pp_testNotRunning", "Clotr isn't running in this tab yet. Reload the page, then try again.");
  }
  if (answer.found) {
    return msg(
      "pp_testFound",
      "The box that just flashed orange is the one Clotr is watching. Nothing was typed or sent.",
    );
  }
  return msg("pp_testNoBox", "Clotr can't find a chat box on this page yet. Click into the chat box, then try again.");
}

// "Test Clotr here": the chat box Clotr watches on this tab flashes orange. Nothing is typed or sent.
function testHere(forSite) {
  const result = el("div", { className: "why", role: "status" });
  const btn = el("button", {
    className: "linkish test-here",
    type: "button",
    textContent: msg("pp_testHere", "Test Clotr here"),
  });
  btn.addEventListener("click", async () => {
    let answer = null;
    try {
      answer = await chrome.tabs.sendMessage(forSite.tabId, { type: "clotr:showChatBox" }, { frameId: 0 });
    } catch {
      /* no Clotr in this tab (yet) */
    }
    result.textContent = testAnswerWords(answer);
  });
  return [btn, result];
}

// Exactly what a click would cover, so it's never a surprise (shared hosts: just a section).
function willCoverLine() {
  return el("div", {
    className: "why",
    textContent: msg("pp_willProtect", "Will protect: $1", prettyPattern(Sites.protectScope(site.url))),
  });
}

function renderSpottedSite(box) {
  const add = el("button", { className: "btn primary", textContent: msg("pp_protectSite", "Protect this site") });
  add.addEventListener("click", () => protectSite(site.url));
  box.replaceChildren(
    el("div", { className: "grow" }, [
      el("div", { className: "host", textContent: site.host }),
      siteStateLine("spot", msg("pp_spotted", "Looks like an AI chat, not protected yet")),
      el("div", {
        className: "why",
        textContent: msg("pp_found", "Found $1.", site.signals.map(signalText).join(", ")),
      }),
      willCoverLine(),
    ]),
    add,
  );
}

// Not an AI site: stays off here until you switch it on, whether it's an email or chat app, any other site,
// or an AI tool Clotr missed. It reads as resting rather than off, so nobody takes it for broken, and on an
// ordinary site the switch-on button is the quiet one, since that site could be their bank. A known email or
// chat app keeps the highlighted button: that's where people do want it.
function renderRestingSite(box) {
  const https = Boolean(site.host && site.url?.startsWith("https:"));
  const known = Sites.everydaySiteFor(site.host);
  const turnOn = el("button", {
    className: known ? "btn primary" : "btn",
    textContent: known ? msg("pp_turnOnFor", "Turn on for $1", known.name) : msg("pp_turnOnHere", "Turn Clotr on here"),
  });
  turnOn.addEventListener("click", () => protectSite(site.url, "everyday"));
  const override = el("button", {
    className: "linkish",
    textContent: msg("pp_override", "It's an AI chat: protect it"),
  });
  override.addEventListener("click", () => protectSite(site.url, "ai"));
  box.replaceChildren(
    el("div", { className: "grow" }, [
      el("div", { className: "host", textContent: site.host }),
      siteStateLine("", msg("pp_offHere", "Clotr watches AI chats, so it's resting here.")),
      https
        ? el("div", {
            className: "why",
            textContent: msg("pp_offHereWhy", "Want a heads-up here too, like on your email or a chat app?"),
          })
        : coverageLine(),
      https ? willCoverLine() : "",
      https && !known ? override : "",
    ]),
    ...(https ? [turnOn] : []),
  );
}

function renderSite() {
  const box = $("site");
  // "Report a problem" can offer this AI tool's host, opt-in only, never on a non-AI page.
  Report?.setHost(site.kind === "protected" || site.kind === "spotted" ? site.host : null);
  if (site.kind === "none") renderNoPage(box);
  else if (site.kind === "protected" && site.access === false) renderNoAccess(box);
  else if (site.kind === "protected") renderProtectedSite(box);
  else if (site.kind === "spotted") renderSpottedSite(box);
  else renderRestingSite(box);
}
