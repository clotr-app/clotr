// "What Clotr stores": shows the extension's stored records, read-only.
// Nothing here writes to storage or leaves the page. The fingerprint salt and the PIN record are masked.
"use strict";

const $ = (id) => document.getElementById(id);
const { msg } = globalThis.Clotr;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// ---------- Words ----------

const fmt = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });
const fmtShort = new Intl.DateTimeFormat([], { dateStyle: "short", timeStyle: "short" });
const fmtDay = new Intl.DateTimeFormat([], { dateStyle: "long" });
// "2 October": the 30 days after a scam, as Clotr's other screens say them.
const fmtDate = new Intl.DateTimeFormat([], { day: "numeric", month: "long" });
const OUTCOME = {
  redacted: msg("pp_covered", "Hidden"),
  allowed: msg("pp_sent", "Sent"),
  suppressed: msg("pp_justCounted", "Just counted"),
};
const RESPONSE = {
  block: msg("popup_askBeforeSending", "Ask before sending"),
  warn: msg("popup_warn", "Warn"),
  log: msg("popup_justCount", "Just count"),
};
const VAULT_TYPES = {
  my_name: msg("vt_cName", "Your name"),
  family_name: msg("vt_cFamily", "Family member"),
  employer: msg("vt_cWork", "Where you work"),
  street_address: msg("vt_cAddress", "Address"),
  phone_number: msg("vt_cPhone", "Phone number"),
  email: msg("vt_cEmail", "Email address"),
  my_id: msg("vt_cIdFormat", "Account/ID format"),
  watch_list: msg("vt_cWatch", "Watch word"),
};
// The one-time offer to use Clotr on email and chat apps (`everydayOffer`, one bookkeeping word).
const OFFER = {
  welcome: msg("sj_offerWelcome", "Made on the welcome page"),
  popup: msg("sj_offerPopup", "Shows once, the next time you open Clotr's toolbar button"),
  done: msg("sj_offerDone", "Answered, or an app was already on"),
};

function when(time) {
  return Number.isFinite(time) ? fmt.format(time) : "—";
}

// A kind's name: the vault's own word for it, else its id with spaces and a capital.
function pretty(id) {
  return VAULT_TYPES[id] || id.replace(/_/g, " ").replace(/^\w/, (first) => first.toUpperCase());
}

function onOrOff(isOff) {
  return isOff ? msg("sj_off", "Off") : msg("sj_on", "On");
}

// A list of label and value pairs, as <dt> and <dd>.
function facts(target, rows) {
  const items = rows.flatMap(([label, value]) => [el("dt", { textContent: label }), el("dd", { textContent: value })]);
  $(target).replaceChildren(...items);
}

// ---------- Your settings ----------

// The email and chat sites Clotr runs on: the ones the browser granted (sites-and-policy/protected-sites.js `isEveryday`: a listed
// app, or a site you switched on as one). Read from the grants, not from `siteKinds`: older versions wrote
// that note before the browser's question and kept it after a No.
function everydayHosts(granted, siteKinds = {}) {
  const hosts = granted
    .filter((origin) => /^https:\/\/[^/*]+\/\*?$/.test(origin))
    .map((origin) => new URL(origin.replace(/\*$/, "")).hostname)
    .filter((host) => globalThis.ClotrSites.isEveryday(host, siteKinds));
  return [...new Set(hosts)].sort();
}

// Tourniquet: since when and what it asks about, in the words its own screens use, never who it's for.
// A value that isn't exactly its record is off, as the background treats it.
function tourniquetText(raw) {
  const tourniquet = globalThis.ClotrSites.cleanTourniquet(raw);
  if (!tourniquet) return msg("sj_off", "Off");
  if (tourniquet.for === "after_scam") {
    return msg(
      "sj_tqOnAfterScam",
      "After a scam, since $1, until $2. Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out.",
      fmtDate.format(tourniquet.since),
      fmtDate.format(tourniquet.until),
    );
  }
  if (tourniquet.for === "child") {
    return msg(
      "sj_tqOnChild",
      "On since $1. Clotr asks before personal details, passwords and sign-in codes go out.",
      fmtDay.format(tourniquet.since),
    );
  }
  return msg(
    "sj_tqOnAdult",
    "On since $1. Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out.",
    fmtDay.format(tourniquet.since),
  );
}

function responsesText(responses) {
  if (!responses.length) return msg("sj_nothingChanged", "Nothing: everything warns");
  return responses.map(([id, response]) => `${pretty(id)}: ${RESPONSE[response] || response}`).join(" · ");
}

function siteModesText(siteModes) {
  if (!siteModes.length) return msg("sj_none", "None");
  return siteModes
    .map(([host, mode]) => {
      const word = mode === "block" ? msg("sj_stricter", "stricter") : msg("sj_quieter", "quieter");
      return `${host}: ${word}`;
    })
    .join(" · ");
}

// Looked up by key, so a stored "90" as text reads the same as 90.
function keepDaysText(keepDays) {
  const words = { 90: msg("dash_3Months", "3 months"), 730: msg("dash_2Years", "2 years") };
  return words[keepDays] || msg("dash_1Year", "1 year");
}

function addedSitesText(added) {
  if (!added.length) return msg("sj_seeSettings", "See Settings → AI tools you added");
  return added.map(([origin, scopes]) => `${origin} (${scopes.join(", ")})`).join(" · ");
}

// "Your settings": what you changed from the defaults, Tourniquet, how long history is kept, and the
// sites you added.
function renderSettings(all, granted) {
  const Sites = globalThis.ClotrSites;
  const responses = Object.entries(all.responses || {});
  const siteModes = Object.entries(all.siteModes || {});
  const paused = Object.keys(all.paused || {}).filter((host) => all.paused[host]);
  // Sites switched on while Everywhere I type covered them are kept under its key (sites-and-policy/protected-sites.js notePicks).
  const everyday = everydayHosts(Sites.withPicks(granted, all.siteScopes), all.siteKinds);
  const added = Object.entries(all.siteScopes || {}).filter(([origin]) => origin !== Sites.EVERYWHERE_ORIGIN);
  facts("settings", [
    [msg("sj_changed", "Changed from the default (warn)"), responsesText(responses)],
    [msg("sj_tourniquet", "Tourniquet"), tourniquetText(all.tourniquet)],
    [msg("sj_siteModes", "Stricter or quieter on one AI tool"), siteModesText(siteModes)],
    [msg("sj_pausedOn", "Paused on"), paused.length ? paused.join(", ") : msg("sj_nowhere", "Nowhere")],
    [msg("sj_advanced", "Advanced options shown"), all.advanced ? msg("sj_yes", "Yes") : msg("sj_no", "No")],
    [msg("dash_keepHistoryFor", "Keep history for"), keepDaysText(all.keepDays)],
    [msg("popup_aiToolsYouAdded", "AI tools you added"), addedSitesText(added)],
    [
      msg("sj_everydaySites", "Email and chat sites you switched on"),
      everyday.length ? everyday.join(", ") : msg("sj_none", "None"),
    ],
  ]);
}

// ---------- Your vault ----------

function vaultCountText(count) {
  if (!count) return msg("sj_empty", "Empty.");
  if (count === 1) return msg("sj_item1", "1 item.");
  return msg("sj_itemN", "$1 items.", count);
}

function vaultRow(entry) {
  const shared = entry.kind === "value" && entry.mode === "allow";
  const what = entry.kind === "shape" ? entry.shape : `fingerprint ${entry.fp}`;
  return el("tr", {}, [
    el("td", { textContent: pretty(entry.type) + (entry.learned ? " (learned)" : "") }),
    el("td", { textContent: shared ? msg("vault_okToShare", "OK to share") : msg("vault_watch", "Watch") }),
    el("td", {}, [el("code", { textContent: what })]),
    el("td", { textContent: when(entry.added) }),
  ]);
}

// "Your vault": one row per item, each a fingerprint or a format, never what was typed.
function renderVault(all) {
  const vault = all.vault || [];
  $("vault-count").textContent = vaultCountText(vault.length);
  $("vault-table").hidden = !vault.length;
  $("vault-table").tBodies[0].replaceChildren(...vault.map(vaultRow));
}

// ---------- History ----------

// How many records, over what time. `span` is the count, the first time and the last.
function historyCountText(events, folded, span) {
  if (!events.length) return msg("sj_noRecords", "No records yet.");
  if (folded) {
    return msg(
      "sj_historyCountFolded",
      "$1 records (some stand for a long list sent at once), from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
      ...span,
    );
  }
  if (events.length === 1) {
    return msg(
      "sj_historyCount1",
      "1 record, from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
      ...span,
    );
  }
  return msg(
    "sj_historyCountN",
    "$1 records, from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
    ...span,
  );
}

function historyRow(event, weight) {
  const more = weight(event) > 1;
  const kindCell = [
    event.name || pretty(event.type),
    ...(more ? [el("br"), msg("pp_moreInOneGo", "$1 more in one go", weight(event).toLocaleString())] : []),
  ];
  return el("tr", {}, [
    el("td", { textContent: Number.isFinite(event.t) ? fmtShort.format(event.t) : "—" }),
    el("td", { textContent: event.site }),
    el("td", {}, kindCell),
    el("td", { textContent: OUTCOME[event.action] || event.action }),
    el("td", {}, [el("code", { textContent: event.fp || "—" })]),
  ]);
}

// "History": how many records and over what time, then the newest 100.
function renderHistory(all) {
  const events = all.events || [];
  // A record with a count `n` stands for the rest of a long list sent at once.
  const { weight } = globalThis.ClotrSites;
  const folded = events.some((event) => weight(event) > 1);
  const span = [events.length.toLocaleString(), when(events[0]?.t), when(events.at(-1)?.t)];
  $("history-count").textContent = historyCountText(events, folded, span);
  $("history-table").hidden = !events.length;
  const newest = events.slice(-100).reverse();
  $("history-table").tBodies[0].replaceChildren(...newest.map((event) => historyRow(event, weight)));
}

// ---------- Other bookkeeping ----------

// AI replies that brought up your details, as "site: kind" with a count when there's more than one.
function mentionsText(mentions) {
  const counts = {};
  for (const mention of mentions) {
    const key = `${mention.site}: ${pretty(mention.type)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => (count > 1 ? `${key} ×${count}` : key))
    .join(" · ");
}

function saltText(salt) {
  if (!salt) return msg("sj_notYet", "Not created yet");
  return msg(
    "sj_saltWhat",
    "A random number made on this computer, used so fingerprints can't be compared with anyone else's (hidden here). Moving to a new computer takes it along, so your vault keeps working there.",
  );
}

function historyFullText(historyFull) {
  if (!Number.isFinite(historyFull?.before)) return msg("sj_no", "No");
  return msg(
    "sj_historyFullWhat",
    "On $1, to stay under 10,000 records, Clotr removed records from before $2. Only these two dates are kept.",
    when(historyFull.t),
    when(historyFull.before),
  );
}

function knownKindsText(knownKinds) {
  if (!Array.isArray(knownKinds)) return "—";
  return msg(
    "sj_knownKindsWhat",
    "$1 kinds, by name only, so that after an update a new kind can follow Ask before sending personal details.",
    knownKinds.length,
  );
}

function tourniquetEndedText(ended) {
  if (!Number.isFinite(ended?.at)) return "—";
  return msg(
    "sj_tqEndedWhat",
    "$1. Kept until you answer the note about it in Clotr's popup, so it's said once.",
    when(ended.at),
  );
}

function tourniquetSeenText(seen) {
  if (!Number.isFinite(seen)) return "—";
  return msg(
    "sj_tqSeenWhat",
    "$1. The latest time this computer's clock showed while the 30 days ran, so Clotr can tell if the clock is turned back.",
    when(seen),
  );
}

// "Other bookkeeping": the fingerprint secret (described, never shown), counters and notes Clotr keeps.
function renderOther(all) {
  const ignores = Object.entries(all.ignores || {})
    .map(([id, times]) => `${pretty(id)}: ${times.length}`)
    .join(" · ");
  const tips = Object.keys(all.guided || {})
    .map(pretty)
    .join(", ");
  const mentions = all.mentions || [];
  facts("other", [
    [msg("sj_salt", "Fingerprint secret"), saltText(all.salt)],
    [msg("sj_kept", "Times you kept a warning (last 14 days)"), ignores || msg("sj_none", "None")],
    [msg("sj_tips", "First-time tips already shown for"), tips || msg("sj_noneYet", "None yet")],
    [
      msg("sj_pictureNote", "The picture note was shown on"),
      Object.keys(all.picturesNoted || {}).join(", ") || msg("sj_noneYet", "None yet"),
    ],
    [msg("sj_replyCheck", "Check the AI's replies for my details"), onOrOff(all.replyCheck === false)],
    [msg("sj_commandCheck", "Check commands I copy on AI chats"), onOrOff(all.commandCheck === false)],
    [
      msg("sj_mentions", "AI replies that brought up your details (kind and fingerprint, never the text)"),
      mentions.length ? mentionsText(all.mentions) : msg("sj_none", "None"),
    ],
    [
      msg("sj_spotted", "AI tools you opened Clotr on that it doesn't protect (names only)"),
      Object.keys(all.spotted || {}).join(", ") || msg("sj_none", "None"),
    ],
    [msg("sj_historyFull", "History full"), historyFullText(all.historyFull)],
    [msg("sj_lastUpdate", "Last update"), all.lastUpdate ? `${all.lastUpdate.from} → ${all.lastUpdate.to}` : "—"],
    // Kind ids only, so the next update can tell which kinds it brought.
    [msg("sj_knownKinds", "Kinds of detail Clotr knows"), knownKindsText(all.knownKinds)],
    [msg("sj_everydayOffer", "Offer to use Clotr on your email and chat apps"), OFFER[all.everydayOffer] || "—"],
    // Tourniquet's 30 days after a scam (Scam Shield): two times, nothing about what happened.
    [msg("sj_tqEnded", "End of Tourniquet's 30 days"), tourniquetEndedText(all.tourniquetEnded)],
    [msg("sj_tqSeen", "Latest time seen during Tourniquet's 30 days"), tourniquetSeenText(all.tourniquetSeen)],
  ]);
}

// ---------- Raw data ----------

// "Show the raw data": every stored record exactly as kept, with the fingerprint secret hidden, and the
// PIN's record too (a 4 to 8 digit PIN can be found again from its hash and salt).
function renderRaw(all) {
  const shown = { ...all, ...(all.salt ? { salt: "(hidden)" } : {}), ...(all.lock ? { lock: "(set)" } : {}) };
  $("raw").textContent = JSON.stringify(shown, null, 2);
}

// Every section, from one read of the whole storage and the browser's site grants (again whenever either
// changes).
function render(all, granted) {
  renderSettings(all, granted);
  renderVault(all);
  renderHistory(all);
  renderOther(all);
  renderRaw(all);
}

// ---------- What Clotr can reach ----------

// Read from the installed manifest, so it can't drift from what the browser enforces.
const WHY = {
  storage: msg("sj_pStorage", "Keeps your settings, vault fingerprints and history on this computer."),
  activeTab: msg(
    "sj_pActiveTab",
    "When you click Clotr's button, lets it look at that one tab to tell whether it's an AI chat. Nothing else.",
  ),
  scripting: msg("sj_pScripting", "Starts Clotr on AI chat sites you add yourself, only after you allow each one."),
  declarativeContent: msg(
    "sj_pDeclarative",
    "Lets the browser show the amber dot on pages that look like an AI chat, without Clotr reading them.",
  ),
  alarms: msg(
    "sj_pAlarms",
    "Updates today's count after midnight, removes old history on schedule, and ends Tourniquet's 30 days after a scam on time.",
  ),
};

// One permission's <dt> and <dd>, the <dt> marked with the permission's id.
function reachRow(id, label, why) {
  const term = el("dt", { textContent: label });
  term.dataset.permission = id;
  return [term, el("dd", { textContent: why })];
}

// "https://claude.ai/*" → "claude.ai".
function patternHost(pattern) {
  return pattern.replace(/^https:\/\/|\/\*$/g, "");
}

function aiSitesWhy(sites, readsMore) {
  const list = sites.map(patternHost).join(", ");
  if (readsMore) {
    return msg(
      "sj_aiSitesWhyOnly",
      "Reads what you type in the chat boxes of these AI chat sites, to warn you before you send: $1.",
      list,
    );
  }
  return msg(
    "sj_aiSitesWhy",
    "Reads what you type in the chat boxes of these AI chat sites, to warn you before you send: $1. Never any other site.",
    list,
  );
}

function youAddWhy(added) {
  if (added.length) {
    return msg(
      "sj_youAddOn",
      "Sites you switched on or added yourself, each only after the browser asked you: $1.",
      added.join(", "),
    );
  }
  return msg(
    "sj_youAddWhy",
    "Only when you click Protect this site on an AI tool Clotr doesn't know yet, and only after the browser asks you.",
  );
}

function everywhereRow() {
  return reachRow(
    "Everywhere I type",
    msg("popup_everywhere", "Everywhere I type"),
    msg(
      "sj_everywhereWhy",
      "On, after the browser asked you, so Clotr can read pages on every website (https) too. There it only checks a box that looks like a chat, to warn you before you send. Switch it off in Settings.",
    ),
  );
}

// The sites the browser granted beyond the manifest's (sites you switched on or added, and Everywhere I
// type) are read from its grants, so the list says what Clotr can reach right now, not just at install.
function renderReach(granted = []) {
  const manifest = chrome.runtime.getManifest();
  $("policy").textContent = manifest.content_security_policy?.extension_pages || "";
  const sites = manifest.host_permissions || [];
  const { EVERYWHERE_ORIGIN } = globalThis.ClotrSites;
  const everywhere = granted.includes(EVERYWHERE_ORIGIN);
  const beyond = granted.filter((origin) => !sites.includes(origin) && origin !== EVERYWHERE_ORIGIN);
  const added = [...new Set(beyond.map(patternHost))];
  const permissionRows = (manifest.permissions || []).flatMap((permission) =>
    reachRow(
      permission,
      permission,
      WHY[permission] || msg("sj_pOther", "Used by Clotr's own features on this computer."),
    ),
  );
  const aiSites = reachRow(
    "AI sites",
    msg("sj_aiSitesN", "$1 AI chat sites", sites.length),
    aiSitesWhy(sites, everywhere || added.length),
  );
  const canAdd = (manifest.optional_host_permissions || []).length;
  const youAdd = canAdd ? reachRow("Sites you add", msg("sj_youAdd", "Sites you add"), youAddWhy(added)) : [];
  $("permissions").replaceChildren(...permissionRows, ...aiSites, ...youAdd, ...(everywhere ? everywhereRow() : []));
}

// ---------- Start ----------

renderReach();

async function refresh() {
  const [all, { origins = [] }] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.permissions.getAll().catch(() => ({})),
  ]);
  render(all, origins);
  renderReach(origins);
}
refresh();
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refresh();
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
