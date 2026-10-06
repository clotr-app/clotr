// The toolbar popup, also used as a mini dashboard.
// Reads settings and event history from chrome.storage.local. The only things it writes back are the user's
// own settings, like pausing or per-pattern responses, plus clearing history when asked.
"use strict";

const { PATTERNS, RESPONSES, defaultResponse, responseFor, msg, Report } = globalThis.Clotr;
const VAULT_LABELS = {
  my_name: msg("pp_vName", "Name"),
  family_name: msg("pp_vFamily", "Family"),
  employer: msg("pp_vWork", "Work"),
  street_address: msg("pp_vAddresses", "Addresses"),
  phone_number: msg("pp_vPhones", "Phones"),
  email: msg("pp_vEmails", "Emails"),
  my_id: msg("pp_vIdFormats", "ID formats"),
  watch_list: msg("pp_vWatchWords", "Watch words"),
};
const RESPONSE_LABELS = {
  block: msg("popup_askBeforeSending", "Ask before sending"),
  warn: msg("popup_warn", "Warn"),
  log: msg("popup_justCount", "Just count"),
}; // plain words
const GROUPS = [
  { id: "credentials", name: msg("pp_gCredentials", "Passwords, keys & servers") },
  { id: "personal", name: msg("pp_gPersonal", "Personal info") },
  { id: "custom", name: msg("pp_gCustom", "Your watch list") },
];
const Sites = globalThis.ClotrSites;
// How many details a record stands for: one, or the count of the rest of a long list sent at once.
const weight = Sites.weight;
const sum = (list) => list.reduce((n, e) => n + weight(e), 0);
const PATTERN_NAMES = Object.fromEntries(PATTERNS.map((p) => [p.id, p.name]));
const BUILT_IN = Sites.builtInMatches();

const SERIES = [
  { action: "redacted", label: msg("pp_covered", "Hidden"), cls: "s1", color: "var(--series-1)" },
  { action: "allowed", label: msg("pp_sent", "Sent"), cls: "s2", color: "var(--series-2)" },
  { action: "suppressed", label: msg("pp_justCounted", "Just counted"), cls: "s3", color: "var(--series-3)" },
];
const OUTCOME = Object.fromEntries(SERIES.map((s) => [s.action, s]));
const ACTIVITY_LIMIT = 100;
const SVG_NS = "http://www.w3.org/2000/svg";
// Safari has no management API, so its build drops extcheck.* from the package entirely, and this hides the
// doors to it here too.
const IS_SAFARI = Boolean(chrome.runtime.getManifest().browser_specific_settings?.safari);
// Which held-back features this build actually ships. An off feature gets no door anywhere on this page; an
// on one works exactly like any other feature.
const FEATURES = chrome.runtime.getManifest().clotr_features || {};

let state = {
  events: [],
  paused: {},
  responses: {},
  vault: [],
  siteModes: {},
  advanced: false,
  userSites: [],
  builtInTools: [],
  lock: null,
  largeText: false,
  bandage: {},
  siteKinds: {},
  siteScopes: {},
  tourniquet: null,
};
let site = { kind: "none" }; // none | protected | spotted | not-ai
let rangeDays = readPref("rangeDays", 7);
let siteFilter = readPref("siteFilter", ""); // "" = all AI tools

// Events for the chosen AI tool (or all), shared by Overview and Activity.
function viewEvents() {
  return siteFilter ? state.events.filter((e) => e.site === siteFilter) : state.events;
}

function renderSiteFilter() {
  const counts = countBy(state.events, (e) => e.site);
  if (siteFilter && !counts.some(([site]) => site === siteFilter)) siteFilter = "";
  $("site-filter").replaceChildren(
    el("option", { value: "", textContent: msg("pp_allTools", "All chats"), selected: !siteFilter }),
    ...counts.map(([site, n]) =>
      el("option", { value: site, textContent: `${site} (${n})`, selected: site === siteFilter }),
    ),
  );
  $("filter-bar").hidden = counts.length < 2 && !siteFilter;
  // With one tool chosen, its per-site mode sits right next to it. "Quieter here" doesn't apply under
  // Tourniquet, since the background ignores it there, so it's hidden and a stored value just reads the same
  // as everywhere else. It's also locked while settings are locked, the same as pausing, since it could
  // otherwise be used to get around the PIN.
  $("site-mode").hidden = !siteFilter;
  $("site-mode").disabled = isLocked();
  $("site-mode").title = isLocked() ? msg("popup_settingsAreLocked", "Settings are locked") : "";
  const quieter = $("site-mode").querySelector('option[value="log"]');
  quieter.hidden = quieter.disabled = Boolean(tourniquetOn());
  const mode = state.siteModes[siteFilter] || "";
  $("site-mode").value = tourniquetOn() && mode === "log" ? "" : mode;
  $("site-mode").classList.toggle("changed", Boolean(state.siteModes[siteFilter]));
}

const $ = (id) => document.getElementById(id);
$("site-mode").addEventListener("change", async (e) => {
  const site = siteFilter; // read before awaiting: the filter may change meanwhile
  const mode = e.target.value;
  if (!site || isLocked()) return renderSiteFilter();
  const { siteModes = {} } = await chrome.storage.local.get("siteModes");
  if (mode) siteModes[site] = mode;
  else delete siteModes[site];
  await chrome.storage.local.set({ siteModes });
});
$("site-filter").addEventListener("change", (e) => {
  siteFilter = e.target.value;
  writePref("siteFilter", siteFilter);
  renderAll();
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Per-viewer convenience only; the popup works fine without it.
function readPref(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function prettyPattern(p) {
  return p.replace(/^https:\/\//, "").replace(/\/\*$/, "");
}

// ---------- Current site ----------

async function detectSite() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tab */
  }
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    site = { kind: "none" };
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
    site = { ...base, kind: "protected", source: builtIn ? "built-in" : "added by you", health };
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
    site = { ...base, kind: result?.looksLikeAI ? "spotted" : "not-ai", signals: result?.signals || [] };
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
  const spotted = Object.fromEntries([...names, host].map((h) => [h, true]));
  state.spotted = spotted;
  await chrome.storage.local.set({ spotted }).catch(() => {});
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
  if (scope === perm)
    delete siteScopes[perm]; // the whole host
  else siteScopes[perm] = [...new Set([...(siteScopes[perm] || []), scope])];
  const siteKinds = { ...state.siteKinds, [new URL(url).hostname]: kind };
  Object.assign(state, { siteScopes, siteKinds });
  chrome.storage.local.set({ siteScopes, siteKinds }).catch(() => {});
  const granted = await chrome.permissions.request({ origins: [perm] }).catch(() => false);
  if (granted) await refreshSites();
}

async function setSiteKinds(hosts, kind) {
  const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
  for (const h of hosts) {
    if (kind) siteKinds[h] = kind;
    else delete siteKinds[h];
  }
  state.siteKinds = siteKinds;
  await chrome.storage.local.set({ siteKinds });
}

async function refreshSites() {
  state.userSites = await Sites.userSitePatterns();
  await detectSite();
  renderSite();
  renderSettings();
}

// Settings' "Also on your email and chat apps": one switch per app, asking the browser for exactly its sites.
// Switching on asks first, in the same click (sites.js explains why), and doesn't write anything itself: a
// listed app counts as an email or chat app either way, and the browser remembers the grant on its own.
// Switching off also clears the note an older version wrote for it.
async function setEverydaySite(s, on) {
  if (on) {
    say("everyday-status", "");
    const yes = await Sites.requestEverydayApps([s.name]);
    // A closed prompt or a No used to leave this silent; say so instead, the same way the welcome page does.
    if (!yes)
      say(
        "everyday-status",
        msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        ),
      );
  } else {
    say("everyday-status", "");
    const hosts = s.matches.map((p) => new URL(p.replace(/\*$/, "")).hostname);
    await chrome.permissions.remove({ origins: s.matches });
    await setSiteKinds(hosts, null);
  }
  await refreshSites();
}

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
};
const signalText = (s) => (SIGNALS[s] ? msg(SIGNALS[s], s) : s);

// Away from an AI chat, say where Clotr does work (first impression: "is it on?").
function coverageLine() {
  const names = state.builtInTools.map((t) => t.name);
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

function renderSite() {
  const box = $("site");
  const stateLine = (dotCls, text) =>
    el("div", { className: "state" }, [el("i", { className: `dot ${dotCls}` }), text]);
  // "Report a problem" can offer this AI tool's host, opt-in only, never on a non-AI page.
  Report?.setHost(site.kind === "protected" || site.kind === "spotted" ? site.host : null);

  if (site.kind === "none") {
    box.replaceChildren(
      el("div", { className: "grow" }, [stateLine("", msg("pp_noPage", "No web page in this tab.")), coverageLine()]),
    );
    return;
  }

  if (site.kind === "protected") {
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
        (() => {
          const h = Sites.healthText({
            running: Boolean(site.health),
            paused: isPaused,
            editor: site.health?.editor,
            editFailed: site.health?.editFailed,
            uiRemoved: site.health?.uiRemoved,
          });
          const line = stateLine(h.level, msg(h.key, h.text));
          line.dataset.health = h.level;
          line.title =
            site.source === "built-in"
              ? msg("pp_builtInSite", "Built-in AI site")
              : Sites.isEveryday(site.host, state.siteKinds)
                ? msg("pp_addedEveryday", "Email or chat site you switched on")
                : msg("pp_addedSite", "AI site you added");
          return line;
        })(),
        ...(isPaused ? [] : testHere(site)),
      ]),
      toggle,
    );
    return;
  }

  // "Test Clotr here": the chat box Clotr watches on this tab flashes orange. Nothing is typed or sent.
  function testHere(site) {
    const result = el("div", { className: "why", role: "status" });
    const btn = el("button", {
      className: "linkish test-here",
      type: "button",
      textContent: msg("pp_testHere", "Test Clotr here"),
    });
    btn.addEventListener("click", async () => {
      let answer = null;
      try {
        answer = await chrome.tabs.sendMessage(site.tabId, { type: "clotr:showChatBox" }, { frameId: 0 });
      } catch {
        /* no Clotr in this tab (yet) */
      }
      result.textContent = !answer
        ? msg("pp_testNotRunning", "Clotr isn't running in this tab yet. Reload the page, then try again.")
        : answer.found
          ? msg(
              "pp_testFound",
              "The box that just flashed orange is the one Clotr is watching. Nothing was typed or sent.",
            )
          : msg(
              "pp_testNoBox",
              "Clotr can't find a chat box on this page yet. Click into the chat box, then try again.",
            );
    });
    return [btn, result];
  }

  // Exactly what a click would cover, so it's never a surprise (shared hosts: just a section).
  const willCover = () =>
    el("div", {
      className: "why",
      textContent: msg("pp_willProtect", "Will protect: $1", prettyPattern(Sites.protectScope(site.url))),
    });

  if (site.kind === "spotted") {
    const add = el("button", { className: "btn primary", textContent: msg("pp_protectSite", "Protect this site") });
    add.addEventListener("click", () => protectSite(site.url));
    box.replaceChildren(
      el("div", { className: "grow" }, [
        el("div", { className: "host", textContent: site.host }),
        stateLine("spot", msg("pp_spotted", "Looks like an AI chat, not protected yet")),
        el("div", {
          className: "why",
          textContent: msg("pp_found", "Found $1.", site.signals.map(signalText).join(", ")),
        }),
        willCover(),
      ]),
      add,
    );
    return;
  }

  // Not an AI site: stays off here until you switch it on, whether it's an email or chat app, any other site,
  // or an AI tool Clotr missed.
  const https = Boolean(site.host && site.url?.startsWith("https:"));
  const known = Sites.everydaySiteFor(site.host);
  const turnOn = el("button", {
    className: "btn primary",
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
      stateLine("", msg("pp_offHere", "Clotr is off on this site.")),
      https
        ? el("div", {
            className: "why",
            textContent: msg(
              "pp_offHereWhy",
              "Out of the box it runs only on AI chats. Want a heads-up here too, like on your email or a chat app?",
            ),
          })
        : coverageLine(),
      https ? willCover() : "",
      https && !known ? override : "",
    ]),
    ...(https ? [turnOn] : []),
  );
}

// ---------- Overview (dashboard) ----------

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function lastNDays(n) {
  const today = startOfDay(Date.now());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (n - 1 - i));
    return d;
  });
}

function niceCeil(v) {
  if (v <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return Math.ceil(m * pow);
  return v;
}

function countBy(list, keyFn) {
  const out = new Map();
  for (const item of list) out.set(keyFn(item), (out.get(keyFn(item)) || 0) + weight(item));
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function renderOverview() {
  const days = lastNDays(rangeDays);
  const since = days[0].getTime();
  const events = viewEvents().filter((e) => e.t >= since);

  for (const b of document.querySelectorAll(".range button")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.days) === rangeDays));
  }

  renderExposure(); // all history, so it shows even when this range is quiet
  renderMiniMap();
  renderDigest();
  renderLookBackCard(); // all history too: it's about what's out there, not this range
  const empty = events.length === 0;
  const quiet = empty && viewEvents().length > 0; // history exists, just not in this range
  $("empty-title").textContent = quiet
    ? msg("pp_quietDays", "Quiet $1 days.", rangeDays)
    : msg("popup_nothingFoundYet", "Nothing found yet.");
  $("empty-hint").hidden = quiet;
  $("empty-quiet").hidden = !quiet;
  $("empty-overview").hidden = !empty;
  $("overview-body").hidden = empty;
  if (empty) return;

  const n = (action) => sum(events.filter((e) => e.action === action));

  // Hero
  $("hero-value").textContent = n("redacted").toLocaleString();
  $("hero-label").textContent =
    n("redacted") === 1
      ? msg("pp_heroOne", "leak stopped in the last $1 days", rangeDays)
      : msg("pp_heroMany", "leaks stopped in the last $1 days", rangeDays);
  $("hero-sub").textContent = msg(
    "pp_heroSub",
    "$1 found · $2 sent · $3 just counted",
    sum(events),
    n("allowed"),
    n("suppressed"),
  );

  renderAlerts(events);
  renderLegend(events);
  renderChart(days, events);
  renderHBars(
    $("by-site"),
    countBy(events, (e) => e.site),
  );
  renderHBars(
    $("by-type"),
    countBy(events, (e) => PATTERN_NAMES[e.type] || e.name || e.type),
  );
}

// The small mind map: only branches with something in them; the full one is in the report.
function renderMiniMap() {
  const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
  const { layoutRadial, renderMindMap } = globalThis.ClotrMindMap;
  const events = viewEvents();
  const mentions = siteFilter ? state.mentions.filter((e) => e.site === siteFilter) : state.mentions;
  const model = exposureModel({ events, mentions });
  $("mini-map-card").hidden = !model.has.bySite.length && !model.near.bySite.length;
  if ($("mini-map-card").hidden) return;
  const tree = layoutRadial(buildMindMapTree(model, { compact: true, max: 4 }));
  renderMindMap($("mini-map"), tree, { compact: true });
  // The key: each branch's name and count, drawn in its line's style.
  $("mini-map-key").replaceChildren(
    ...tree.children.map((b) =>
      el("span", { className: `key-${b.branch}` }, [
        el("i", { "aria-hidden": "true" }),
        `${b.label} `,
        el("b", { textContent: String(b.count) }),
      ]),
    ),
  );
}

// Weekly digest: this week against last week, and the one thing to do now. Local, no notifications.
function renderDigest() {
  const DAY = 86400000;
  const now = Date.now();
  const all = viewEvents();
  const week = all.filter((e) => e.t >= now - 7 * DAY);
  const found = sum(week);
  const last = sum(all.filter((e) => e.t >= now - 14 * DAY && e.t < now - 7 * DAY));
  $("digest").hidden = found === 0 && last === 0;
  if ($("digest").hidden) return;
  const n = (action) => sum(week.filter((e) => e.action === action));
  const trend =
    found < last
      ? msg("pp_fewer", "fewer than last week ($1)", last)
      : found > last
        ? msg("pp_more", "more than last week ($1)", last)
        : msg("pp_same", "the same as last week");
  $("digest-line").textContent = msg(
    "pp_digest",
    "This week: $1 found, $2 hidden, $3 sent anyway. That's $4.",
    found,
    n("redacted"),
    n("allowed"),
    trend,
  );
  const risky = week.filter((e) => e.action === "allowed" && e.severity === "high").at(-1);
  $("digest-todo").textContent = risky
    ? msg(
        "pp_todo",
        "To do: the $1 sent to $2. $3",
        PATTERN_NAMES[risky.type] || risky.name || risky.type,
        risky.site,
        globalThis.ClotrInsights.adviceFor(risky.type),
      )
    : msg("pp_nothingRisky", "Nothing high-risk went out this week.");
  $("digest-todo").classList.toggle("urgent", Boolean(risky));
}

// Profile exposure: distinct personal details (by fingerprint) each AI tool actually
// received, i.e. sent with outcome "allowed". All stored history, not just the range.
const PROFILE_TYPES = new Set(PATTERNS.filter((p) => p.group === "personal" || p.group === "custom").map((p) => p.id));
function renderExposure() {
  const seen = new Map(); // site → Set(fp)
  for (const e of viewEvents()) {
    if (e.action !== "allowed" || !e.fp || !PROFILE_TYPES.has(e.type)) continue;
    if (!seen.has(e.site)) seen.set(e.site, new Set());
    seen.get(e.site).add(`${e.type}:${e.fp}`);
  }
  const rows = [...seen].map(([site, fps]) => [site, fps.size]).sort((a, b) => b[1] - a[1]);
  renderHBars($("exposure"), rows);
  $("exposure-empty").hidden = rows.length > 0;
  $("exposure-card").hidden = viewEvents().length === 0; // nothing at all yet: the empty card covers it
}

function renderAlerts(events) {
  const alerts = [];

  const riskyAllowed = sum(events.filter((e) => e.action === "allowed" && e.severity === "high"));
  if (riskyAllowed) {
    alerts.push(
      riskyAllowed === 1
        ? msg("pp_riskyOne", "You sent 1 high-risk item anyway in this period.")
        : msg("pp_riskyMany", "You sent $1 high-risk items anyway in this period.", riskyAllowed),
    );
  }

  // The same secret seen more than once (by fingerprint); only high-severity ones are worth nagging about.
  const high = events.filter((e) => e.fp && e.severity === "high");
  const repeats = countBy(high, (e) => e.fp)
    .filter(([, count]) => count > 1)
    .slice(0, 2);
  for (const [fp, count] of repeats) {
    const hit = high.find((e) => e.fp === fp);
    alerts.push(
      msg(
        "pp_repeat",
        "Clotr found the same $1 $2 times. If it's a real password or key, it's worth changing.",
        PATTERN_NAMES[hit.type] || hit.name,
        count,
      ),
    );
  }

  $("alerts").replaceChildren(
    ...alerts.map((text) =>
      el("div", { className: "alert", role: "note" }, [
        el("span", { className: "icon", textContent: "⚠️", "aria-hidden": "true" }),
        el("span", { textContent: text }),
      ]),
    ),
  );
}

function renderLegend(events) {
  $("legend").replaceChildren(
    ...SERIES.map((s) =>
      el("span", {}, [
        el("i", { style: { background: s.color } }),
        s.label,
        el("b", { textContent: String(sum(events.filter((e) => e.action === s.action))) }),
      ]),
    ),
  );
}

function colPath(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart(days, events) {
  const chart = $("chart");
  const tooltip = $("tooltip");
  const W = chart.clientWidth || 352;
  const H = 132;
  const pad = { top: 8, right: 2, bottom: 18, left: 20 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const base = pad.top + plotH;

  // Bucket events per day and outcome.
  const buckets = days.map((d) => ({ date: d, redacted: 0, allowed: 0, suppressed: 0 }));
  const index = new Map(days.map((d, i) => [d.getTime(), i]));
  for (const e of events) {
    const i = index.get(startOfDay(e.t).getTime());
    if (i !== undefined && e.action in buckets[i]) buckets[i][e.action] += weight(e);
  }
  const total = (b) => b.redacted + b.allowed + b.suppressed;
  const yMax = niceCeil(Math.max(1, ...buckets.map(total)));
  const y = (v) => (v / yMax) * plotH;

  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  chart.replaceChildren();

  // Recessive grid: top + midpoint (when it's a whole number) + baseline.
  const ticks = yMax >= 2 && yMax % 2 === 0 ? [yMax / 2, yMax] : [yMax];
  for (const t of ticks) {
    const ty = base - y(t);
    chart.append(svg("line", { class: "gridline", x1: pad.left, x2: W - pad.right, y1: ty, y2: ty }));
    const label = svg("text", { class: "tick", x: pad.left - 5, y: ty + 3, "text-anchor": "end" });
    label.textContent = String(t);
    chart.append(label);
  }
  const zero = svg("text", { class: "tick", x: pad.left - 5, y: base + 3, "text-anchor": "end" });
  zero.textContent = "0";
  chart.append(zero);

  const band = plotW / buckets.length;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const GAP = 2;
  const fmtDay = new Intl.DateTimeFormat(
    [],
    rangeDays <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" },
  );
  const fmtFull = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
  const labelEvery = rangeDays <= 7 ? 1 : 7;

  buckets.forEach((b, i) => {
    const x0 = pad.left + i * band;
    const bx = x0 + (band - barW) / 2;
    const col = svg("g", { class: "col" });

    // Stack bottom → top; 2px surface gap between segments; only the top one gets rounded corners.
    const segs = SERIES.map((s) => ({ s, v: b[s.action] })).filter((seg) => seg.v > 0);
    let cursor = base;
    segs.forEach((seg, k) => {
      const h = Math.max(3, y(seg.v));
      const top = cursor - h;
      const drawH = h - (k > 0 ? GAP : 0);
      const isTop = k === segs.length - 1;
      col.append(
        isTop
          ? svg("path", { class: seg.s.cls, d: colPath(bx, top, barW, drawH, 4) })
          : svg("rect", { class: seg.s.cls, x: bx, y: top, width: barW, height: drawH }),
      );
      cursor = top;
    });
    chart.append(col);

    // Sparse x labels (last one always), anchored to the right edge for "today".
    const isLast = i === buckets.length - 1;
    if (i % labelEvery === 0 || isLast) {
      if (!(rangeDays > 7 && !isLast && buckets.length - 1 - i < labelEvery / 2)) {
        const tx = svg("text", { class: "tick", x: x0 + band / 2, y: H - 4, "text-anchor": "middle" });
        tx.textContent = isLast ? "Today" : fmtDay.format(b.date);
        chart.append(tx);
      }
    }

    // Hit target = the whole day band (bigger than the bar), keyboard focusable.
    const summary = msg(
      "pp_daySummary",
      "$1: $2 hidden, $3 sent, $4 just counted",
      fmtFull.format(b.date),
      b.redacted,
      b.allowed,
      b.suppressed,
    );
    const hit = svg("rect", {
      class: "hit",
      x: x0,
      y: pad.top,
      width: band,
      height: plotH,
      tabindex: 0,
      role: "img",
      "aria-label": summary,
    });
    const show = () => {
      chart.classList.add("hovering");
      col.classList.add("active");
      tooltip.replaceChildren(
        el("div", { className: "tt-date", textContent: fmtFull.format(b.date) }),
        ...SERIES.map((s) =>
          el("div", { className: "tt-row" }, [
            el("i", { className: "key", style: { background: s.color } }),
            el("b", { textContent: String(b[s.action]) }),
            s.label,
          ]),
        ),
        el("div", { className: "tt-total", textContent: msg("pp_nFound", "$1 found", total(b)) }),
      );
      tooltip.hidden = false;
      // Place beside the column, flipping sides past the midpoint so it never covers the hovered bar.
      const cx = x0 + band / 2;
      const tw = tooltip.offsetWidth;
      const left = cx < W / 2 ? cx + barW / 2 + 8 : cx - barW / 2 - 8 - tw;
      tooltip.style.left = `${Math.max(0, Math.min(W - tw, left))}px`;
      tooltip.style.top = "0px";
    };
    const hide = () => {
      chart.classList.remove("hovering");
      col.classList.remove("active");
      tooltip.hidden = true;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    chart.append(hit);
  });

  chart.append(svg("line", { class: "baseline", x1: pad.left, x2: W - pad.right, y1: base, y2: base }));
}

function renderHBars(container, rows) {
  const top = rows.slice(0, 5);
  const max = Math.max(1, ...top.map(([, v]) => v));
  container.replaceChildren(
    ...top.map(([label, v]) =>
      el("div", { className: "hbar", title: `${label}: ${v}` }, [
        el("span", { className: "label", textContent: label }),
        el("span", { className: "track" }, [
          el("span", { className: "bar", style: { width: `calc((100% - 32px) * ${v / max})` } }),
          el("span", { className: "val", textContent: String(v) }),
        ]),
      ]),
    ),
  );
}

// ---------- Activity (table view) ----------

function renderActivity() {
  const seen = {};
  const events = viewEvents();
  for (const e of events) if (e.fp) seen[e.fp] = (seen[e.fp] || 0) + 1;

  const today = startOfDay(Date.now()).getTime();
  const fmtTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

  const rows = events
    .slice(-ACTIVITY_LIMIT)
    .reverse()
    .map((e) => {
      const when = e.t >= today ? fmtTime.format(e.t) : `${fmtDate.format(e.t)} ${fmtTime.format(e.t)}`;
      const what = el("td", {}, [
        el("span", { className: `sev ${e.severity}`, textContent: msg(`sev_${e.severity}`, e.severity) }),
        PATTERN_NAMES[e.type] || e.name || e.type,
      ]);
      // The rest of a long list sent at once, as one record.
      if (weight(e) > 1) {
        what.append(
          el("span", {
            className: "more",
            textContent: msg("pp_moreInOneGo", "$1 more in one go", weight(e).toLocaleString()),
            title: msg(
              "pp_moreInOneGoWhy",
              "One record for the rest of a long list sent at once, so your history keeps its room.",
            ),
          }),
        );
      }
      if (seen[e.fp] > 1) {
        what.append(
          el("span", {
            className: "repeat",
            textContent: `×${seen[e.fp]}`,
            title: msg("pp_sameItem", "Clotr found this same item $1 times", seen[e.fp]),
          }),
        );
      }
      what.append(el("span", { className: "site-name", textContent: e.site }));
      const o = OUTCOME[e.action];
      return el("tr", {}, [
        el("td", { className: "when", textContent: when }),
        what,
        el("td", {}, [
          el("span", { className: "outcome" }, [
            el("i", { style: { background: o?.color || "var(--muted)" } }),
            o?.label || e.action,
          ]),
        ]),
      ]);
    });

  $("events-body").replaceChildren(...rows);
  $("events-empty").hidden = rows.length > 0;
}

// ---------- Settings ----------

// Routed through the background (clotr:setResponses) so a reply arriving from another AI tab while this
// saves can't read storage before this write lands and overwrite it on its own save.
async function setResponse(id, value) {
  await chrome.runtime.sendMessage({ type: "clotr:setResponses", ids: [id], value });
}

// One control for a whole group: "default" clears the group's overrides (helper-core.js).
const Helper = globalThis.Clotr.Helper;
const { setGroupResponse } = Helper;

// "default" when nothing is overridden, the shared response when all agree, else "custom".
function groupValue(ids) {
  if (!ids.some((id) => id in state.responses)) return "default";
  const values = new Set(ids.map((id) => responseFor(id, state.responses)));
  return values.size === 1 ? [...values][0] : "custom";
}

$("open-vault").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("vault.html") }));
$("open-watch").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("vault.html#watch") }));
$("open-stored").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("stored.html") }));
$("open-move").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("stored.html#move") }));
for (const id of ["open-dashboard", "digest-open", "mini-map-open"])
  $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));

// Removes one protected section; the host's permission goes when none are left.
async function removeUserSite(pattern) {
  const perm = Sites.permissionFor(pattern);
  const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
  const rest = (siteScopes[perm] || []).filter((s) => s !== pattern);
  if (rest.length && pattern !== perm) {
    siteScopes[perm] = rest;
    await chrome.storage.local.set({ siteScopes });
  } else {
    delete siteScopes[perm];
    await chrome.storage.local.set({ siteScopes });
    await chrome.permissions.remove({ origins: [perm] });
  }
  state.userSites = await Sites.userSitePatterns();
  await detectSite();
  renderSite();
  renderSettings();
}

// ---------- Helping someone: larger warnings, stricter personal details, PIN lock ----------
// Shared with the guided setup page (helper.html) through helper-core.js: the PIN is kept only as a salted
// PBKDF2 hash, and unlocking lasts 10 minutes across Clotr's pages.
let unlockedUntil = 0;
let wrongTries = 0;
let retryAt = 0;

const managedLock = () => state.policy?.lockSettings === true;
const isLocked = () => managedLock() || (Boolean(state.lock) && Date.now() >= unlockedUntil);
async function markUnlocked() {
  unlockedUntil = await Helper.markUnlocked();
}
const say = (id, text, error = false) => {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
};

function renderHelper() {
  const locked = isLocked();
  const policyActive = Sites.hasPolicy(state.policy);
  $("managed-note").hidden = !policyActive;
  $("managed-note-title").textContent = state.policy?.orgName
    ? msg("popup_managedByOrg", "Managed by $1.", state.policy.orgName)
    : msg("popup_managedByYourOrganization", "Managed by your organization.");
  $("unlock").hidden = !locked || managedLock(); // an organization's lock has no PIN
  $("settings-body").hidden = locked;
  // The history is the person's own: "Clear my history" stays in reach while settings are locked.
  $("history-mine").hidden = !locked;
  $("large-text").checked = state.largeText;
  $("reply-check").checked = state.replyCheck;
  $("command-check").checked = state.commandCheck;
  $("strict-personal").checked = Helper.asksBeforePersonal(state.responses);
  $("lock-remove").hidden = !state.lock;
  $("lock-set").textContent = state.lock
    ? msg("pp_changePin", "Change the PIN")
    : msg("popup_lockSettings", "Lock settings");
}

$("managed-see").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("policy.html") }));
$("managed-training").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("training.html") }),
);
$("managed-training").hidden = !FEATURES.training;
$("large-text").addEventListener("change", (e) => chrome.storage.local.set({ largeText: e.target.checked }));
$("reply-check").addEventListener("change", (e) => chrome.storage.local.set({ replyCheck: e.target.checked }));
$("command-check").addEventListener("change", (e) => chrome.storage.local.set({ commandCheck: e.target.checked }));
$("command-check-row").hidden = !FEATURES.commandcheck;
$("command-check-hint").hidden = !FEATURES.commandcheck;

// ---------- Clotr Antibody: the Overview row and Settings' section open its pages ----------
// Each door opens a page in a new tab; none changes a setting, so the Overview row works while settings are locked.
// The 30-day line opens the setup page with "After a scam" already chosen (helper.js reads ?for=after_scam).
for (const [id, page] of [
  ["ss-row-check", "check.html"],
  ["ss-row-practice", "practice.html"],
  ["ss-open-card", "share.html#card"],
  ["ss-tq30-open", "helper.html?for=after_scam#who"],
])
  $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
// Held back features get no door here: the Overview row only has "Is this a scam?" and
// Practice, so it hides when both are off; Settings' section also holds the command check and Tourniquet's
// 30-day line, so it only hides when nothing in it is on (Tourniquet's own ss-tq30 is gated in renderTourniquet()).
$("ss-row-check").hidden = !FEATURES.scamcheck;
$("ss-row-practice").hidden = !FEATURES.practice;
$("ss-open-card").hidden = !FEATURES.scamcheck;
$("ss-row").hidden = !FEATURES.scamcheck && !FEATURES.practice;
$("ss-settings").hidden = !FEATURES.scamcheck && !FEATURES.commandcheck && !FEATURES.tourniquet;

// ---------- Look back and Extension check: the Overview card and Settings' section open them ----------
// Neither door changes a setting or touches storage, so both work while settings are locked.
for (const [id, page] of [
  ["lb-card-open", "lookback.html"],
  ["lb-card-check", "extcheck.html"],
  ["lb-settings-open", "lookback.html"],
  ["lb-settings-check", "extcheck.html"],
])
  $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
// Look back and Extension check are both held back, gated independently; Safari also has
// no management API, so its build hides Extension check's doors even when the feature is on.
$("lb-card-row").hidden = !FEATURES.lookback;
$("lb-settings-row").hidden = !FEATURES.lookback;
$("lb-card-ec-row").hidden = IS_SAFARI || !FEATURES.extcheck;
$("lb-settings-ec-row").hidden = IS_SAFARI || !FEATURES.extcheck;
$("lb-card").hidden = !FEATURES.lookback && (IS_SAFARI || !FEATURES.extcheck);
$("lb-settings").hidden = !FEATURES.lookback && (IS_SAFARI || !FEATURES.extcheck);

// With no history yet there's nothing else on Overview to look at, so the card keeps its full words and
// invites someone in; once there's real history it folds onto one line (.compact), the same quiet shape as
// the Antibody row above it: an empty history invites people in, a full one stays out of the way.
function renderLookBackCard() {
  $("lb-card").classList.toggle("compact", state.events.length > 0);
}

// ---------- Bandage: per-site on/off, and turning it on for this tab ----------
async function setBandageHost(host, on) {
  const { bandage = {} } = await chrome.storage.local.get("bandage");
  bandage[host] = on;
  await chrome.storage.local.set({ bandage });
  state.bandage = bandage;
  renderBandage();
}
$("bandage-here").addEventListener("change", (e) => {
  if (site.kind === "protected") setBandageHost(site.host, e.target.checked);
});
function renderBandage() {
  const entries = Object.entries(state.bandage).sort(([a], [b]) => a.localeCompare(b));
  $("bandage-sites").replaceChildren(
    ...entries.map(([host, on]) => {
      const cb = el("input", { type: "checkbox", checked: on === true });
      cb.addEventListener("change", () => setBandageHost(host, cb.checked));
      return el("li", {}, [
        el("label", { className: "toggle" }, [cb, el("span", { className: "grow", textContent: host })]),
      ]);
    }),
  );
  $("bandage-sites-empty").hidden = entries.length > 0;
  const onThisSite = site.kind === "protected" && state.bandage[site.host] === true;
  $("bandage-here").checked = onThisSite;
  $("bandage-here").disabled = site.kind !== "protected";
}
$("strict-personal").addEventListener("change", (e) => Helper.setAskBeforePersonal(e.target.checked));
$("open-helper").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("helper.html") }));
$("open-share").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("share.html") }));
// The first-install welcome again: to reread it, show someone, or try the practice box.
$("open-welcome").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("vault.html?welcome=1") }),
);
$("lock-set").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  if (!Helper.validPin(pin)) return say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
  const lock = await Helper.makeLock(pin);
  await markUnlocked(); // you set it, so you stay in for now
  await chrome.storage.local.set({ lock });
  $("pin").value = "";
  say("lock-msg", msg("pp_locked", "Settings locked. Clotr will ask for the PIN next time."));
});
$("lock-remove").addEventListener("click", async () => {
  await chrome.storage.local.remove("lock");
  say("lock-msg", msg("pp_pinRemoved", "PIN removed: settings are open again."));
});
async function tryUnlock() {
  if (Date.now() < retryAt) return say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
  const pin = $("unlock-pin").value.trim();
  const ok = await Helper.pinMatches(pin, state.lock);
  $("unlock-pin").value = "";
  if (!ok) {
    if (++wrongTries >= 5) {
      retryAt = Date.now() + 30000;
      wrongTries = 0;
    }
    return say("unlock-msg", msg("pp_wrongPin", "That PIN didn't match."), true);
  }
  wrongTries = 0;
  say("unlock-msg", "");
  await markUnlocked();
  renderAll();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryUnlock();
});

// Email and chat apps: a switch per app on the list, then any other site you switched on as "not an AI".
function renderEverydaySites(granted) {
  const listed = new Set(Sites.EVERYDAY_SITES.flatMap((s) => s.matches));
  const rows = Sites.EVERYDAY_SITES.map((s) => {
    const on = s.matches.some((p) => granted.includes(p));
    const btn = el("button", {
      className: on ? "btn switch on" : "btn switch",
      textContent: on ? msg("pp_on", "On") : msg("pp_turnOn", "Turn on"),
      disabled: isLocked(),
    });
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", msg("pp_everydayFor", "Clotr on $1", s.name));
    btn.addEventListener("click", () => setEverydaySite(s, !on));
    return el("li", {}, [
      el("span", { className: "grow" }, [
        el("b", { textContent: s.name }),
        el("span", {
          className: "why",
          textContent: s.kind === "email" ? msg("pp_kindEmail", "Email") : msg("pp_kindChat", "Chat app"),
        }),
      ]),
      btn,
    ]);
  });
  const others = granted
    .filter((p) => !listed.has(p))
    .map((p) => {
      const btn = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
      btn.addEventListener("click", () => removeUserSite(p));
      return el("li", {}, [el("span", { className: "grow", textContent: prettyPattern(p) }), btn]);
    });
  $("everyday-sites").replaceChildren(...rows, ...others);
}

function renderSettings() {
  renderHelper();
  renderTourniquet();
  renderBandage();
  const everydayHost = (p) => Sites.isEveryday(new URL(p.replace(/\*$/, "")).hostname, state.siteKinds);
  const userItems = state.userSites
    .filter((p) => !everydayHost(p))
    .map((p) => {
      const btn = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
      btn.addEventListener("click", () => removeUserSite(p));
      const label = el("span", { className: "grow", textContent: prettyPattern(p) });
      if (Sites.isWiderThanNeeded(p)) {
        label.append(
          el("span", {
            className: "why",
            textContent: msg(
              "pp_wider",
              "Every page of this site: wider than a chat needs. Remove it, then protect just the chat page.",
            ),
          }),
        );
      }
      return el("li", {}, [label, btn]);
    });
  $("user-sites").replaceChildren(...userItems);
  $("user-sites-empty").hidden = userItems.length > 0;
  renderEverydaySites(state.userSites.filter(everydayHost));

  // Named list from ai-sites.json; falls back to the raw manifest patterns.
  const tools = state.builtInTools.length
    ? state.builtInTools
    : BUILT_IN.map((p) => ({ name: prettyPattern(p), matches: [] }));
  $("builtin-count").textContent = String(tools.length);
  $("builtin-sites").replaceChildren(
    ...tools.map((t) =>
      el("li", {}, [
        el("b", { textContent: t.name }),
        t.matches.length ? ` — ${t.matches.map(prettyPattern).join(", ")}` : "",
      ]),
    ),
  );

  const openGroups = new Set([...document.querySelectorAll(".resp-group details[open]")].map((d) => d.dataset.group));
  // The effective response per kind: writes still go
  // to the raw stored map (setResponse), so nothing is lost when the policy or Tourniquet goes away.
  const kept = Sites.tourniquetPolicy(state.tourniquet)?.requiredResponses || {};
  const effResponses = Sites.applyPolicy({ responses: state.responses }, combinedPolicy()).responses;
  const patternRow = (p) => {
    const current = responseFor(p.id, effResponses);
    const floored = RESPONSES.includes(state.policy?.requiredResponses?.[p.id]);
    // Tourniquet's floor for this kind: the choices under it can't be picked while it's on.
    const floor = !floored && Object.hasOwn(kept, p.id) ? kept[p.id] : null;
    const select = el(
      "select",
      {
        className: "resp",
        title: floored
          ? msg("popup_managedByYourOrganization", "Managed by your organization.")
          : floor
            ? msg("pp_tqKeeps", "Tourniquet keeps this")
            : msg("pp_whatDoes", "What Clotr does when it finds: $1", p.name),
        disabled: floored || floor === "block",
      },
      RESPONSES.map((r) =>
        el("option", {
          value: r,
          selected: r === current,
          disabled: Boolean(floor) && RESPONSES.indexOf(r) > RESPONSES.indexOf(floor),
          textContent: RESPONSE_LABELS[r] + (r === defaultResponse(p.id) ? msg("pp_defaultSuffix", " (default)") : ""),
        }),
      ),
    );
    select.dataset.pattern = p.id;
    select.classList.toggle("changed", current !== defaultResponse(p.id));
    select.setAttribute("aria-label", msg("pp_responseFor", "Response for $1", p.name));
    select.addEventListener("change", () => setResponse(p.id, select.value));
    // A kind's name wraps between words ("Número de la Seguridad Social de EE. UU."), never inside one.
    return el("li", {}, [
      el("span", { className: "grow words" }, [
        el("span", { className: `sev ${p.severity}`, textContent: msg(`sev_${p.severity}`, p.severity) }),
        p.name,
      ]),
      select,
    ]);
  };
  $("responses").replaceChildren(
    ...GROUPS.map((g) => {
      const members = PATTERNS.filter((p) => p.group === g.id);
      const ids = members.map((p) => p.id);
      const value = groupValue(ids);
      // A group with a kind that starts as Just count says so, so its "Default" isn't read as warn for all.
      const someQuiet = ids.some((id) => defaultResponse(id) === "log");
      const options = [
        [
          "default",
          someQuiet
            ? msg("pp_defaultWarnSomeCount", "Default (warn, a few just count)")
            : msg("pp_defaultWarn", "Default (warn)"),
        ],
        ...RESPONSES.map((r) => [r, RESPONSE_LABELS[r]]),
      ];
      if (value === "custom") options.push(["custom", msg("pp_custom", "Custom")]);
      const select = el(
        "select",
        { className: "resp" },
        options.map(([v, label]) =>
          el("option", { value: v, selected: v === value, textContent: label, disabled: v === "custom" }),
        ),
      );
      select.dataset.group = g.id;
      select.classList.toggle("changed", value !== "default");
      select.setAttribute("aria-label", msg("pp_responseForAll", "Response for all: $1", g.name));
      select.addEventListener("change", () => setGroupResponse(ids, select.value));
      const details = el("details", { className: "advanced-only", open: openGroups.has(g.id) }, [
        el("summary", { textContent: msg("pp_chooseEach", "Choose for each ($1)", members.length) }),
        el("ul", { className: "list" }, members.map(patternRow)),
      ]);
      details.dataset.group = g.id;
      return el("div", { className: "resp-group" }, [
        el("div", { className: "head" }, [el("span", { className: "grow", textContent: g.name }), select]),
        details,
      ]);
    }),
    ...teamGroup(effResponses),
  );

  // Simple mode by default: per-type settings, per-site modes and the built-in list
  // appear only with "Show advanced options"; a note says when hidden ones are in use.
  document.body.classList.toggle("advanced", state.advanced);
  $("advanced").checked = state.advanced;
  const customized = GROUPS.some(
    (g) => groupValue(PATTERNS.filter((p) => p.group === g.id).map((p) => p.id)) === "custom",
  );
  $("advanced-in-use").hidden = state.advanced || !(customized || Object.keys(state.siteModes).length);

  // Vault summary: counts by category (the vault page has the details).
  const byCat = countBy(state.vault, (e) => VAULT_LABELS[e.type] || msg("pp_other", "Other"));
  $("vault-summary").textContent = byCat.length
    ? byCat.map(([cat, n]) => `${cat} ${n}`).join(" · ")
    : msg("pp_vaultEmpty", "Nothing here yet. Add your details so Clotr knows what's yours to protect.");
}

// Shows a team's own kinds, set by its policy, with each row's response locked in and unchangeable. It shows
// even in simple mode, since this is what the organization chose for this computer, though the rows stay
// folded away until asked for. With no kinds in the policy, this renders nothing.
function teamGroup(effResponses) {
  const kinds = Array.isArray(state.policy?.kinds) ? state.policy.kinds : [];
  if (!kinds.length) return [];
  const setBy = msg("pp_setByOrg", "Set by your organization");
  const row = (k) => {
    const current = responseFor(k.id, effResponses);
    const select = el(
      "select",
      { className: "resp", title: `${setBy}.`, disabled: true },
      RESPONSES.map((r) => el("option", { value: r, selected: r === current, textContent: RESPONSE_LABELS[r] })),
    );
    select.dataset.pattern = k.id;
    select.setAttribute("aria-label", msg("pp_responseFor", "Response for $1", k.name));
    return el("li", {}, [el("span", { className: "grow", textContent: k.name }), select]);
  };
  const open = Boolean(document.querySelector('.resp-group[data-group="team"] details[open]'));
  const group = el("div", { className: "resp-group" }, [
    el("div", { className: "head" }, [
      el("span", { className: "grow", textContent: msg("pp_gTeam", "Kinds your organization added") }),
      el("span", { className: "set-by", textContent: setBy }),
    ]),
    el("details", { open }, [
      el("summary", { textContent: msg("pp_seeEach", "See each ($1)", kinds.length) }),
      el("ul", { className: "list" }, kinds.map(row)),
    ]),
  ]);
  group.dataset.group = "team";
  return [group];
}

// Two clicks to clear, so a stray click can't wipe history: Settings' "Clear history", and "Clear my history" in the
// locked view (no PIN: the history is the person's own).
function twoClickClear(btn, idleText) {
  let armed = null;
  const disarm = () => {
    clearTimeout(armed);
    armed = null;
    btn.textContent = idleText();
    btn.classList.remove("confirm");
  };
  btn.addEventListener("click", async () => {
    if (!armed) {
      btn.textContent = msg("pp_clearAgain", "Click again to clear all history");
      btn.classList.add("confirm");
      armed = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    await chrome.runtime.sendMessage({ type: "clotr:clearHistory" });
  });
}
twoClickClear($("clear"), () => msg("popup_clearHistory", "Clear history"));
twoClickClear($("clear-mine"), () => msg("pp_tqClearMine", "Clear my history"));

// ---------- Tourniquet: the chip, the Overview line, the Settings card ----------
// The person it protects always sees that it's on and what it does, in words that never name the preset.
// Once settings are open, the switch here can change the preset or turn it off, with two clicks; turning it
// on in the first place is the guided setup's job, not this page's.

const tourniquetOn = () => Sites.cleanTourniquet(state.tourniquet);
// What Clotr applies now: the organization's policy with Tourniquet on top.
const combinedPolicy = () => Sites.combinePolicies(state.policy, Sites.tourniquetPolicy(state.tourniquet));

function renderTourniquet() {
  const t = tourniquetOn();
  // Clotr Antibody's 30-day line offers Tourniquet to someone on their own: not while it's on, settings are
  // locked, or Tourniquet is held back in this build.
  $("ss-tq30").hidden = Boolean(t) || isLocked() || !FEATURES.tourniquet;
  for (const id of ["tq-chip", "tq-line", "tq-card", "tq-keeps-note"]) $(id).hidden = !t;
  if (!t) return disarmTourniquetOff();
  const child = t.for === "child";
  const scam = t.for === "after_scam"; // the grown-up's rules, for 30 days (Scam Shield)
  $("tq-line-text").textContent = child
    ? msg(
        "pp_tqLineChild",
        "Tourniquet is on: Clotr asks before personal details, passwords and sign-in codes go out. Clotr sends nothing anywhere.",
      )
    : scam
      ? msg(
          "pp_tqLineAfterScam",
          "Tourniquet is on for 30 days after a scam: Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out. Clotr sends nothing anywhere.",
        )
      : msg(
          "pp_tqLineAdult",
          "Tourniquet is on: Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out. Clotr sends nothing anywhere.",
        );
  $("tq-title-text").textContent = scam
    ? msg("pp_tqTitleAfterScam", "Tourniquet: 30 days after a scam")
    : msg("pp_tqTitle", "Tourniquet is on");
  $("tq-since").hidden = scam;
  $("tq-days").hidden = !scam;
  if (scam) renderTourniquetDays(t);
  let since;
  try {
    since = new Date(t.since).toLocaleDateString(chrome.i18n.getUILanguage(), { dateStyle: "long" });
  } catch {
    since = new Date(t.since).toDateString();
  }
  $("tq-since").textContent = msg("pp_tqSince", "On since $1.", since);
  $("tq-asks").textContent = child
    ? msg(
        "pp_tqAsksChild",
        "Clotr asks before these go out: names, addresses, phone numbers, email addresses, birthdays, card and ID numbers, passwords and sign-in codes, and the words added to watch for.",
      )
    : scam
      ? msg(
          "pp_tqAsksAfterScam",
          "Clotr asks before these go out: bank, card and ID numbers, gift card numbers, Medicare and insurance numbers, birthdays, passwords and sign-in codes.",
        )
      : msg(
          "pp_tqAsksAdult",
          "Clotr asks before these go out: bank, card and ID numbers, Medicare and insurance numbers, birthdays, passwords and sign-in codes.",
        );
  $("tq-notes").hidden = child;
  $("tq-notes").textContent = child
    ? ""
    : msg(
        "pp_tqNotesAdult",
        "Warnings are larger. Names, addresses, phone numbers and email addresses always get a note in the corner.",
      );
  const granted = state.userSites;
  const apps = Sites.EVERYDAY_SITES.filter((s) => s.matches.some((p) => granted.includes(p))).map((s) => s.name);
  $("tq-apps").hidden = !apps.length;
  $("tq-apps").textContent = apps.length
    ? msg("pp_tqApps", "Also on your email and chat apps: $1.", apps.join(", "))
    : "";
  $("tq-switch").hidden = isLocked();
  for (const b of $("tq-switch").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.for === t.for));
}

// "2 October", the browser's own way: the 30 days' dates.
function shortDay(t) {
  try {
    return new Date(t).toLocaleDateString(chrome.i18n.getUILanguage(), { day: "numeric", month: "long" });
  } catch {
    return new Date(t).toDateString();
  }
}

// Fills in the day count and end date for the 30 days after a scam, worked out from the stored dates on this
// computer's clock. The track underneath is just a picture; the words already say the same thing. If the
// clock gets turned back, a note explains that the stored dates don't move with it.
function renderTourniquetDays(t) {
  const now = Date.now();
  const { day, of } = Sites.tourniquetDay(t, now);
  $("tq-day").textContent = msg("pp_tqDay", "Day $1 of $2", day, of);
  $("tq-ends").textContent = msg("pp_tqStepsDown", "Steps down on $1", shortDay(t.until));
  $("tq-days")
    .querySelector(".tq-track")
    .replaceChildren(
      ...Array.from({ length: of }, (_, i) =>
        el("span", { className: i + 1 < day ? "gone" : i + 1 === day ? "today" : "" }),
      ),
    );
  const back = Sites.tourniquetClockBack(state.tourniquetSeen, now);
  $("tq-clock").hidden = !back;
  $("tq-clock").textContent = back
    ? msg(
        "pp_tqClockBack",
        "This computer's clock was turned back. Clotr keeps its own dates, so the 30 days end when this clock reaches $1.",
        shortDay(t.until),
      )
    : "";
}

// The chip and "What it changes" open Settings at the card and move the focus to its heading.
function showTourniquetCard() {
  selectTab("settings");
  $("tq-title").focus();
}
$("tq-chip").addEventListener("click", showTourniquetCard);
$("tq-line-open").addEventListener("click", showTourniquetCard);

let tourniquetOffArmed = null;
function disarmTourniquetOff() {
  clearTimeout(tourniquetOffArmed);
  tourniquetOffArmed = null;
  const off = $("tq-switch").querySelector('[data-for="off"]');
  off.textContent = msg("pp_tqOff", "Off");
  off.classList.remove("confirm");
  $("tq-off-msg").textContent = "";
}
$("tq-switch").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  const t = tourniquetOn();
  if (!b || !t || isLocked()) return;
  if (b.dataset.for !== "off") {
    disarmTourniquetOff();
    // A new choice is a new start: `since` is when it was chosen (after a scam: 30 days from now).
    if (b.dataset.for !== t.for)
      await chrome.storage.local.set({
        tourniquet:
          b.dataset.for === "after_scam" ? Sites.afterScam(Date.now()) : { for: b.dataset.for, since: Date.now() },
      });
    return;
  }
  if (!tourniquetOffArmed) {
    b.textContent = msg("pp_tqOffAgain", "Click again");
    b.classList.add("confirm");
    $("tq-off-msg").textContent = msg(
      "pp_tqOffWhy",
      "Click again to turn Tourniquet off. The email and chat apps stay on until you switch them off below.",
    );
    tourniquetOffArmed = setTimeout(disarmTourniquetOff, 4000);
    return;
  }
  disarmTourniquetOff();
  await chrome.storage.local.remove("tourniquet");
});

// ---------- Tabs & range ----------

const TABS = ["overview", "activity", "settings"];
function selectTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  document.body.dataset.tab = name; // the site filter only applies to Overview and Activity
  if (name === "overview") renderOverview(); // chart needs a visible panel to measure its width
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

for (const b of document.querySelectorAll(".range button")) {
  b.addEventListener("click", () => {
    rangeDays = Number(b.dataset.days);
    writePref("rangeDays", rangeDays);
    renderOverview();
  });
}

// ---------- Startup & live updates ----------

function renderAll() {
  renderSite();
  renderSiteFilter();
  if (!$("panel-overview").hidden) renderOverview();
  renderActivity();
  renderSettings();
}

// Shows "Updated to vX" once per update, since the background sets lastUpdate when one happens. The release's
// own notes stay folded under "See what's new" until opened, so the popup stays short. Opening the list isn't
// the same as dismissing it; only clicking Got it marks it seen.
function whatsNewSummary() {
  const more = $("whats-new-more");
  more.querySelector("summary").textContent = more.open
    ? msg("pp_hideList", "Hide the list")
    : msg("pp_seeWhatsNew", "See what's new ($1)", more.dataset.count);
}
$("whats-new-more").addEventListener("toggle", whatsNewSummary);

// Which pages a release's "What's new" card opens, keyed by "v" plus the release's minor version. The "v" is
// there because a bare "1.3" would be read as a number, and "1.10" would silently collide with "1.1" the
// moment either one lost its trailing zero. changelog.json only holds the notes themselves; this map is
// popup.js's own, and it only gets filled in once a release actually ships the pages its notes mention.
const RELEASE_DOORS = {
  "v1.3": [
    { page: "lookback.html", key: "lb_name", fallback: "Look back", feature: "lookback" },
    { page: "extcheck.html", key: "ec_name", fallback: "Extension check", feature: "extcheck" },
  ],
};

async function renderWhatsNew() {
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  if (!lastUpdate || lastUpdate.seen) {
    $("whats-new").hidden = true;
    return;
  }
  const minor = lastUpdate.to.split(".").slice(0, 2).join(".");
  let notes = [];
  try {
    const log = await (await fetch(chrome.runtime.getURL("changelog.json"))).json();
    const lang = chrome.i18n.getUILanguage().split("-")[0];
    notes = log.translations?.[lang]?.[minor] || log[minor] || [];
  } catch {
    /* the title alone still helps */
  }
  $("whats-new-title").textContent = lastUpdate.from
    ? msg("pp_updatedFrom", "Updated to v$1 (from v$2)", lastUpdate.to, lastUpdate.from)
    : msg("pp_updated", "Updated to v$1", lastUpdate.to);
  $("whats-new-list").replaceChildren(...notes.map((n) => el("li", { textContent: n })));
  $("whats-new-more").dataset.count = String(notes.length);
  $("whats-new-more").hidden = !notes.length;
  whatsNewSummary();
  const doors = (RELEASE_DOORS[`v${minor}`] || []).filter(
    (d) => (!d.feature || FEATURES[d.feature]) && (!IS_SAFARI || d.page !== "extcheck.html"),
  );
  $("whats-new-doors").replaceChildren(
    ...doors.map((d) => {
      const b = el("button", { className: "btn", type: "button", textContent: msg(d.key, d.fallback) });
      b.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(d.page) }));
      return b;
    }),
  );
  $("whats-new-doors").hidden = doors.length === 0;
  $("whats-new").hidden = false;
}
// Only one card shows in the top slot at a time. The end of Tourniquet's 30 days after a scam comes first,
// since it's about this person's own protection, then the one-time offer to use Clotr on email and chat
// apps. What's new only shows once both of those have been answered.
async function renderTopCard() {
  if (showTourniquetEnd()) return;
  if (await showEverydayOffer()) return;
  await renderWhatsNew();
}

// Whether the 30 days after a scam have ended. The background keeps that end in `tourniquetEnded` until the
// person answers here, and a record that's already past its end but the background hasn't noticed yet counts
// the same way.
function tourniquetEndedNow() {
  const ended = Sites.tourniquetEnded(state.tourniquetEnded);
  if (ended) return ended;
  const r = Sites.tourniquetRecord(state.tourniquet);
  return r?.until !== undefined && !Sites.cleanTourniquet(r) ? { since: r.since, at: r.until } : null;
}
function showTourniquetEnd() {
  const show = Boolean(tourniquetEndedNow());
  $("tq-end").hidden = !show;
  if (show) $("everyday-offer").hidden = $("whats-new").hidden = true;
  return show;
}
// Each answer closes the card for good, whether it's 30 more days, switching to the grown-up's Tourniquet
// with no end, or just Got it. None of them need the PIN, since they only ever add protection or change
// nothing at all.
async function answerTourniquetEnd(next) {
  const hadFocus = $("tq-end").contains(document.activeElement);
  const r = Sites.tourniquetRecord(state.tourniquet);
  const stale = r?.until !== undefined && !Sites.cleanTourniquet(r);
  if (next) await chrome.storage.local.set({ tourniquet: next });
  await chrome.storage.local.remove(next || !stale ? ["tourniquetEnded"] : ["tourniquetEnded", "tourniquet"]);
  state.tourniquetEnded = null;
  if (next || stale) state.tourniquet = next;
  $("tq-end").hidden = true;
  renderAll();
  await renderTopCard();
  if (hadFocus)
    (
      [
        $("everyday-offer").querySelector("button"),
        $("whats-new-more").querySelector("summary"),
        $("whats-new-ok"),
      ].find((n) => n?.checkVisibility()) || $("tab-overview")
    ).focus();
}
$("tq-end-more").addEventListener("click", () => answerTourniquetEnd(Sites.afterScam(Date.now())));
$("tq-end-adult").addEventListener("click", () => answerTourniquetEnd({ for: "adult", since: Date.now() }));
$("tq-end-ok").addEventListener("click", () => answerTourniquetEnd(null));

let offerMounted = false;
async function showEverydayOffer() {
  const { everydayOffer } = await chrome.storage.local.get("everydayOffer");
  if (everydayOffer !== "popup" || isLocked()) return false;
  const { origins = [] } = await chrome.permissions.getAll();
  if (Sites.grantedEverydayApps(origins).length) {
    // One was switched on another way in the meantime: the offer has done its job.
    await chrome.storage.local.set({ everydayOffer: "done" });
    return false;
  }
  if (!offerMounted) {
    offerMounted = true;
    await globalThis.ClotrEverydayOffer.mount($("everyday-offer"), { onAnswer: closeEverydayOffer });
  }
  $("whats-new").hidden = true;
  $("everyday-offer").hidden = false;
  return true;
}

// Answered (the browser said yes or no, or No thanks): the card goes for good, and "what's new" takes its place.
async function closeEverydayOffer(yes) {
  const hadFocus = $("everyday-offer").contains(document.activeElement);
  $("everyday-offer").hidden = true;
  if (yes) refreshSites();
  await renderWhatsNew();
  if (hadFocus)
    [$("whats-new-more").querySelector("summary"), $("whats-new-ok")].find((n) => n.checkVisibility())?.focus();
}
$("ev-no").addEventListener("click", () => {
  chrome.storage.local.set({ everydayOffer: "done" }).catch(() => {});
  closeEverydayOffer(false);
});

$("whats-new-ok").addEventListener("click", async () => {
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  await chrome.storage.local.set({ lastUpdate: { ...lastUpdate, seen: true } });
  $("whats-new").hidden = true;
});

async function loadBuiltInTools() {
  try {
    return await (await fetch(chrome.runtime.getURL("ai-sites.json"))).json();
  } catch (err) {
    console.warn("[Clotr] could not read ai-sites.json", err);
    return [];
  }
}

async function init() {
  const stored = await chrome.storage.local.get([
    "events",
    "paused",
    "responses",
    "vault",
    "siteModes",
    "advanced",
    "lock",
    "largeText",
    "replyCheck",
    "commandCheck",
    "mentions",
    "spotted",
    "bandage",
    "siteKinds",
    "siteScopes",
    "tourniquet",
    "tourniquetEnded",
    "tourniquetSeen",
  ]);
  unlockedUntil = await Helper.unlockedUntil();
  const policy = Sites.mergePolicy((await chrome.storage.managed?.get(null).catch(() => ({}))) || {});
  state = {
    events: stored.events || [],
    paused: stored.paused || {},
    responses: stored.responses || {},
    vault: stored.vault || [],
    siteModes: stored.siteModes || {},
    advanced: stored.advanced === true,
    lock: stored.lock || null,
    policy,
    largeText: stored.largeText === true,
    replyCheck: stored.replyCheck !== false,
    commandCheck: stored.commandCheck !== false,
    mentions: stored.mentions || [],
    spotted: stored.spotted || {},
    bandage: stored.bandage || {},
    userSites: await Sites.userSitePatterns(),
    builtInTools: await loadBuiltInTools(),
    siteKinds: stored.siteKinds || {},
    siteScopes: stored.siteScopes || {},
    tourniquet: stored.tourniquet || null,
    tourniquetEnded: stored.tourniquetEnded || null,
    tourniquetSeen: stored.tourniquetSeen ?? null,
  };
  await detectSite();
  renderAll();
  renderTopCard();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") {
    chrome.storage.managed
      ?.get(null)
      .then((policy) => {
        state.policy = Sites.mergePolicy(policy || {});
        renderAll();
      })
      .catch(() => {});
    return;
  }
  if (area !== "local") return;
  for (const key of ["events", "paused", "responses", "vault", "siteModes", "siteScopes", "siteKinds"]) {
    if (changes[key]) state[key] = changes[key].newValue || (["events", "vault"].includes(key) ? [] : {});
  }
  if (changes.advanced) state.advanced = changes.advanced.newValue === true;
  if (changes.lock) state.lock = changes.lock.newValue || null;
  if (changes.largeText) state.largeText = changes.largeText.newValue === true;
  if (changes.replyCheck) state.replyCheck = changes.replyCheck.newValue !== false;
  if (changes.commandCheck) state.commandCheck = changes.commandCheck.newValue !== false;
  if (changes.mentions) state.mentions = changes.mentions.newValue || [];
  if (changes.spotted) state.spotted = changes.spotted.newValue || {};
  if (changes.bandage) state.bandage = changes.bandage.newValue || {};
  if (changes.tourniquet) state.tourniquet = changes.tourniquet.newValue || null;
  if (changes.tourniquetEnded) state.tourniquetEnded = changes.tourniquetEnded.newValue || null;
  if (changes.tourniquetSeen) state.tourniquetSeen = changes.tourniquetSeen.newValue ?? null;
  renderAll();
  // The 30 days ended (or were answered) while the popup is open: the top card follows, no reload needed.
  if (changes.tourniquetEnded) renderTopCard();
});

$("advanced").addEventListener("change", (e) => chrome.storage.local.set({ advanced: e.target.checked }));
$("tips-again").addEventListener("click", async () => {
  await chrome.storage.local.remove(["guided", "picturesNoted"]); // the "can't read pictures" note too
  $("tips-again").textContent = msg("pp_tipsAgain", "Tips will show again");
});

init();
