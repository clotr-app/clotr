// "What Clotr stores": shows the extension's stored records, read-only.
// Nothing here writes to storage or leaves the page. The fingerprint salt is masked.
"use strict";

const $ = (id) => document.getElementById(id);
const { msg } = globalThis.Clotr;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const fmt = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });
const when = (t) => (Number.isFinite(t) ? fmt.format(t) : "—");
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
const pretty = (id) => VAULT_TYPES[id] || id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function facts(target, rows) {
  $(target).replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
}

// The email and chat sites Clotr runs on: the ones the browser granted (sites.js `isEveryday`: a listed app, or a
// site you switched on as one). Read from the grants, not from `siteKinds`: older versions wrote that note before
// the browser's question and kept it after a No.
function everydayHosts(granted, siteKinds = {}) {
  const hosts = granted
    .filter((o) => /^https:\/\/[^/*]+\/\*?$/.test(o))
    .map((o) => new URL(o.replace(/\*$/, "")).hostname)
    .filter((h) => globalThis.ClotrSites.isEveryday(h, siteKinds));
  return [...new Set(hosts)].sort();
}

// Tourniquet: since when and what it asks about, in the words its own screens use, never who it's for. A value
// that isn't exactly its record is off, as the background treats it.
function tourniquetText(raw) {
  const t = globalThis.ClotrSites.cleanTourniquet(raw);
  if (!t) return msg("sj_off", "Off");
  if (t.for === "after_scam")
    return msg(
      "sj_tqOnAfterScam",
      "After a scam, since $1, until $2. Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out.",
      fmtDate.format(t.since),
      fmtDate.format(t.until),
    );
  return t.for === "child"
    ? msg(
        "sj_tqOnChild",
        "On since $1. Clotr asks before personal details, passwords and sign-in codes go out.",
        fmtDay.format(t.since),
      )
    : msg(
        "sj_tqOnAdult",
        "On since $1. Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out.",
        fmtDay.format(t.since),
      );
}

// "Your settings": what you changed from the defaults, Tourniquet, how long history is kept, and the sites you added.
function renderSettings(all, granted) {
  const responses = Object.entries(all.responses || {});
  const siteModes = Object.entries(all.siteModes || {});
  const paused = Object.keys(all.paused || {}).filter((h) => all.paused[h]);
  const everyday = everydayHosts(granted, all.siteKinds);
  facts("settings", [
    [
      msg("sj_changed", "Changed from the default (warn)"),
      responses.length
        ? responses.map(([id, r]) => `${pretty(id)}: ${RESPONSE[r] || r}`).join(" · ")
        : msg("sj_nothingChanged", "Nothing: everything warns"),
    ],
    [msg("sj_tourniquet", "Tourniquet"), tourniquetText(all.tourniquet)],
    [
      msg("sj_siteModes", "Stricter or quieter on one AI tool"),
      siteModes.length
        ? siteModes
            .map(([h, m]) => `${h}: ${m === "block" ? msg("sj_stricter", "stricter") : msg("sj_quieter", "quieter")}`)
            .join(" · ")
        : msg("sj_none", "None"),
    ],
    [msg("sj_pausedOn", "Paused on"), paused.length ? paused.join(", ") : msg("sj_nowhere", "Nowhere")],
    [msg("sj_advanced", "Advanced options shown"), all.advanced ? msg("sj_yes", "Yes") : msg("sj_no", "No")],
    [
      msg("dash_keepHistoryFor", "Keep history for"),
      { 90: msg("dash_3Months", "3 months"), 730: msg("dash_2Years", "2 years") }[all.keepDays] ||
        msg("dash_1Year", "1 year"),
    ],
    [
      msg("popup_aiToolsYouAdded", "AI tools you added"),
      Object.keys(all.siteScopes || {}).length
        ? Object.entries(all.siteScopes)
            .map(([o, s]) => `${o} (${s.join(", ")})`)
            .join(" · ")
        : msg("sj_seeSettings", "See Settings → AI tools you added"),
    ],
    [
      msg("sj_everydaySites", "Email and chat sites you switched on"),
      everyday.length ? everyday.join(", ") : msg("sj_none", "None"),
    ],
  ]);
}

// "Your vault": one row per item, each a fingerprint or a format, never what was typed.
function renderVault(all) {
  const vault = all.vault || [];
  $("vault-count").textContent = vault.length
    ? vault.length === 1
      ? msg("sj_item1", "1 item.")
      : msg("sj_itemN", "$1 items.", vault.length)
    : msg("sj_empty", "Empty.");
  $("vault-table").hidden = !vault.length;
  $("vault-table").tBodies[0].replaceChildren(
    ...vault.map((e) =>
      el("tr", {}, [
        el("td", { textContent: pretty(e.type) + (e.learned ? " (learned)" : "") }),
        el("td", {
          textContent:
            e.kind === "value" && e.mode === "allow"
              ? msg("vault_okToShare", "OK to share")
              : msg("vault_watch", "Watch"),
        }),
        el("td", {}, [
          e.kind === "shape"
            ? el("code", { textContent: e.shape })
            : el("code", { textContent: `fingerprint ${e.fp}` }),
        ]),
        el("td", { textContent: when(e.added) }),
      ]),
    ),
  );
}

// "History": how many records and over what time, then the newest 100.
function renderHistory(all) {
  const events = all.events || [];
  // A record with a count `n` stands for the rest of a long list sent at once.
  const { weight } = globalThis.ClotrSites;
  const folded = events.some((e) => weight(e) > 1);
  const span = [events.length.toLocaleString(), when(events[0]?.t), when(events.at(-1)?.t)];
  $("history-count").textContent = !events.length
    ? msg("sj_noRecords", "No records yet.")
    : folded
      ? msg(
          "sj_historyCountFolded",
          "$1 records (some stand for a long list sent at once), from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
          ...span,
        )
      : events.length === 1
        ? msg(
            "sj_historyCount1",
            "1 record, from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
            ...span,
          )
        : msg(
            "sj_historyCountN",
            "$1 records, from $2 to $3. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.",
            ...span,
          );
  $("history-table").hidden = !events.length;
  $("history-table").tBodies[0].replaceChildren(
    ...events
      .slice(-100)
      .reverse()
      .map((e) =>
        el("tr", {}, [
          el("td", { textContent: Number.isFinite(e.t) ? fmtShort.format(e.t) : "—" }),
          el("td", { textContent: e.site }),
          el("td", {}, [
            e.name || pretty(e.type),
            ...(weight(e) > 1
              ? [el("br"), msg("pp_moreInOneGo", "$1 more in one go", weight(e).toLocaleString())]
              : []),
          ]),
          el("td", { textContent: OUTCOME[e.action] || e.action }),
          el("td", {}, [el("code", { textContent: e.fp || "—" })]),
        ]),
      ),
  );
}

// AI replies that brought up your details, as "site: kind" with a count when there's more than one.
function mentionsText(mentions) {
  const counts = {};
  for (const e of mentions) {
    const key = `${e.site}: ${pretty(e.type)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, c]) => (c > 1 ? `${k} ×${c}` : k))
    .join(" · ");
}

// "Other bookkeeping": the fingerprint secret (described, never shown), counters and notes Clotr keeps.
function renderOther(all) {
  facts("other", [
    [
      msg("sj_salt", "Fingerprint secret"),
      all.salt
        ? msg(
            "sj_saltWhat",
            "A random number made on this computer, used so fingerprints can't be compared with anyone else's (hidden here). Moving to a new computer takes it along, so your vault keeps working there.",
          )
        : msg("sj_notYet", "Not created yet"),
    ],
    [
      msg("sj_kept", "Times you kept a warning (last 14 days)"),
      Object.entries(all.ignores || {})
        .map(([id, ts]) => `${pretty(id)}: ${ts.length}`)
        .join(" · ") || msg("sj_none", "None"),
    ],
    [
      msg("sj_tips", "First-time tips already shown for"),
      Object.keys(all.guided || {})
        .map(pretty)
        .join(", ") || msg("sj_noneYet", "None yet"),
    ],
    [
      msg("sj_pictureNote", "The picture note was shown on"),
      Object.keys(all.picturesNoted || {}).join(", ") || msg("sj_noneYet", "None yet"),
    ],
    [
      msg("sj_replyCheck", "Check the AI's replies for my details"),
      all.replyCheck === false ? msg("sj_off", "Off") : msg("sj_on", "On"),
    ],
    [
      msg("sj_commandCheck", "Check commands I copy on AI chats"),
      all.commandCheck === false ? msg("sj_off", "Off") : msg("sj_on", "On"),
    ],
    [
      msg("sj_mentions", "AI replies that brought up your details (kind and fingerprint, never the text)"),
      (all.mentions || []).length ? mentionsText(all.mentions) : msg("sj_none", "None"),
    ],
    [
      msg("sj_spotted", "AI tools you opened Clotr on that it doesn't protect (names only)"),
      Object.keys(all.spotted || {}).join(", ") || msg("sj_none", "None"),
    ],
    [
      msg("sj_historyFull", "History full"),
      Number.isFinite(all.historyFull?.before)
        ? msg(
            "sj_historyFullWhat",
            "On $1, to stay under 10,000 records, Clotr removed records from before $2. Only these two dates are kept.",
            when(all.historyFull.t),
            when(all.historyFull.before),
          )
        : msg("sj_no", "No"),
    ],
    [msg("sj_lastUpdate", "Last update"), all.lastUpdate ? `${all.lastUpdate.from} → ${all.lastUpdate.to}` : "—"],
    // Kind ids only, so the next update can tell which kinds it brought.
    [
      msg("sj_knownKinds", "Kinds of detail Clotr knows"),
      Array.isArray(all.knownKinds)
        ? msg(
            "sj_knownKindsWhat",
            "$1 kinds, by name only, so that after an update a new kind can follow Ask before sending personal details.",
            all.knownKinds.length,
          )
        : "—",
    ],
    [msg("sj_everydayOffer", "Offer to use Clotr on your email and chat apps"), OFFER[all.everydayOffer] || "—"],
    // Tourniquet's 30 days after a scam (Scam Shield): two times, nothing about what happened.
    [
      msg("sj_tqEnded", "End of Tourniquet's 30 days"),
      Number.isFinite(all.tourniquetEnded?.at)
        ? msg(
            "sj_tqEndedWhat",
            "$1. Kept until you answer the note about it in Clotr's popup, so it's said once.",
            when(all.tourniquetEnded.at),
          )
        : "—",
    ],
    [
      msg("sj_tqSeen", "Latest time seen during Tourniquet's 30 days"),
      Number.isFinite(all.tourniquetSeen)
        ? msg(
            "sj_tqSeenWhat",
            "$1. The latest time this computer's clock showed while the 30 days ran, so Clotr can tell if the clock is turned back.",
            when(all.tourniquetSeen),
          )
        : "—",
    ],
  ]);
}

// "Show the raw data": every stored record exactly as kept, with the fingerprint secret hidden.
function renderRaw(all) {
  const shown = { ...all, ...(all.salt ? { salt: "(hidden)" } : {}) };
  $("raw").textContent = JSON.stringify(shown, null, 2);
}

// Every section, from one read of the whole storage and the browser's site grants (again whenever either changes).
function render(all, granted) {
  renderSettings(all, granted);
  renderVault(all);
  renderHistory(all);
  renderOther(all);
  renderRaw(all);
}

// "What Clotr can reach": read from the installed manifest, so it can't drift from what the browser enforces.
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
function renderReach() {
  const m = chrome.runtime.getManifest();
  $("policy").textContent = m.content_security_policy?.extension_pages || "";
  const row = (id, label, why) => {
    const dt = el("dt", { textContent: label });
    dt.dataset.permission = id;
    return [dt, el("dd", { textContent: why })];
  };
  const sites = m.host_permissions || [];
  $("permissions").replaceChildren(
    ...(m.permissions || []).flatMap((p) =>
      row(p, p, WHY[p] || msg("sj_pOther", "Used by Clotr's own features on this computer.")),
    ),
    ...row(
      "AI sites",
      msg("sj_aiSitesN", "$1 AI chat sites", sites.length),
      msg(
        "sj_aiSitesWhy",
        "Reads what you type in the chat boxes of these AI chat sites, to warn you before you send: $1. Never any other site.",
        sites.map((s) => s.replace(/^https:\/\/|\/\*$/g, "")).join(", "),
      ),
    ),
    ...((m.optional_host_permissions || []).length
      ? row(
          "Sites you add",
          msg("sj_youAdd", "Sites you add"),
          msg(
            "sj_youAddWhy",
            "Only when you click Protect this site on an AI tool Clotr doesn't know yet, and only after the browser asks you.",
          ),
        )
      : []),
  );
}
renderReach();

async function refresh() {
  const [all, { origins = [] }] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.permissions.getAll().catch(() => ({})),
  ]);
  render(all, origins);
}
refresh();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
