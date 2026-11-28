/* global countBy, isLocked, renderAll, tourniquetOn */
/* exported ACTIVITY_LIMIT, BUILT_IN, FEATURES, GROUPS, IS_SAFARI, OUTCOME, PATTERN_NAMES, RESPONSES, RESPONSE_LABELS,
            Report, VAULT_LABELS, aKind, defaultResponse, firefoxPanel, prettyPattern, rangeDays, responseFor, site,
            state, sum, svg, viewEvents, viewMentions */
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
  { id: "links", name: msg("pp_gLinks", "Links") },
  { id: "custom", name: msg("pp_gCustom", "Your watch list") },
];
const Sites = globalThis.ClotrSites;
// How many details a record stands for: one, or the count of the rest of a long list sent at once.
const weight = Sites.weight;
const sum = (list) => list.reduce((total, record) => total + weight(record), 0);
const PATTERN_NAMES = Object.fromEntries(PATTERNS.map((pattern) => [pattern.id, pattern.name]));
// "A credit card number", "An email address": the English article a kind's name takes, lowercased to sit
// mid-sentence. A name that starts with letters said one by one ("US", "ID") keeps them, with the article
// they sound like. English only: other languages get the bare name as well ($2), and word their own lines
// around it.
const aKind = (name) => {
  const initials = /^[A-Z]{2,}\b/.test(name);
  const vowelSound = initials ? /^[AEFHILMNORSX]/.test(name) : /^[AEIOU]/i.test(name);
  return `${vowelSound ? "An" : "A"} ${initials ? name : `${name.charAt(0).toLowerCase()}${name.slice(1)}`}`;
};
const BUILT_IN = Sites.builtInMatches();

const SERIES = [
  { action: "redacted", label: msg("pp_covered", "Hidden"), cls: "s1", color: "var(--series-1)" },
  { action: "allowed", label: msg("pp_sent", "Sent"), cls: "s2", color: "var(--series-2)" },
  { action: "suppressed", label: msg("pp_justCounted", "Just counted"), cls: "s3", color: "var(--series-3)" },
];
const OUTCOME = Object.fromEntries(SERIES.map((series) => [series.action, series]));
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
  mentions: [],
  paused: {},
  responses: {},
  vault: [],
  siteModes: {},
  advanced: false,
  userSites: [],
  grants: [], // the browser's own site grants, as it lists them
  builtInTools: [],
  lock: null,
  largeText: false,
  bandage: {},
  siteKinds: {},
  siteScopes: {},
  tourniquet: null,
};
let firefoxPanel = false; // Firefox's toolbar popup on a computer (leavesForQuestion), set by init()
let site = { kind: "none" }; // none | protected | spotted | not-ai
let rangeDays = readPref("rangeDays", 7);
let siteFilter = readPref("siteFilter", ""); // "" = all AI tools

// Events for the chosen AI tool (or all), shared by Overview and Activity.
function viewEvents() {
  return siteFilter ? state.events.filter((record) => record.site === siteFilter) : state.events;
}
function viewMentions() {
  return siteFilter ? state.mentions.filter((record) => record.site === siteFilter) : state.mentions;
}

function renderSiteFilter() {
  const counts = countBy(state.events, (record) => record.site);
  if (siteFilter && !counts.some(([host]) => host === siteFilter)) siteFilter = "";
  $("site-filter").replaceChildren(
    el("option", { value: "", textContent: msg("pp_allTools", "All chats"), selected: !siteFilter }),
    ...counts.map(([host, count]) =>
      el("option", { value: host, textContent: `${host} (${count})`, selected: host === siteFilter }),
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
$("site-mode").addEventListener("change", async (event) => {
  const filterSite = siteFilter; // read before awaiting: the filter may change meanwhile
  const mode = event.target.value;
  if (!filterSite || isLocked()) {
    renderSiteFilter();
    return;
  }
  const { siteModes = {} } = await chrome.storage.local.get("siteModes");
  if (mode) siteModes[filterSite] = mode;
  else delete siteModes[filterSite];
  await chrome.storage.local.set({ siteModes });
});
$("site-filter").addEventListener("change", (event) => {
  siteFilter = event.target.value;
  writePref("siteFilter", siteFilter);
  renderAll();
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "style") Object.assign(node.style, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

// Per-viewer convenience only; the popup works fine without it.
function readPref(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
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

function prettyPattern(pattern) {
  return pattern.replace(/^https:\/\//, "").replace(/\/\*$/, "");
}
