// "Organization policy applied here": a self-attestation page for an admin or an
// insurer's checklist. Reads the managed policy, this extension's version and the browser; writes and sends
// nothing, ever. Never says "prevents", "certified" or "compliant".
"use strict";

const { msg, PATTERNS } = globalThis.Clotr;
const Sites = globalThis.ClotrSites;
const $ = (id) => document.getElementById(id);

// ---------- Names and labels ----------

const PRESET_NAMES = {
  keys_never: msg("pa_presetKeysNever", "Keys never"),
  client_names: msg("pa_presetClientNames", "Client names"),
  clinic: msg("pa_presetClinic", "Clinic"),
  tax_office: msg("pa_presetTaxOffice", "Tax office"),
};

// The UA string's tokens, checked in this order. Edge's says "Chrome" too, so it goes first.
const UA_BROWSERS = ["Edg", "Firefox", "Chrome"];

// navigator.userAgentData when a browser offers it (skipping the generic "Not.A;Brand" and
// "Chromium" entries for a more specific one); the UA string otherwise.
function browserInfo() {
  const agentData = navigator.userAgentData;
  if (agentData?.brands?.length) {
    const specific = agentData.brands.filter(
      (entry) => !/not.a.brand/i.test(entry.brand) && entry.brand !== "Chromium",
    );
    const brand = specific[0] || agentData.brands[0];
    if (brand) return `${brand.brand} ${brand.version}`;
  }
  const userAgent = navigator.userAgent;
  for (const token of UA_BROWSERS) {
    const found = userAgent.match(new RegExp(`${token}/(\\d+)`));
    if (!found) continue;
    const name = token === "Edg" ? "Edge" : token;
    return `${name} ${found[1]}`;
  }
  return userAgent;
}

function patternName(id) {
  return PATTERNS.find((pattern) => pattern.id === id)?.name || id;
}

// The fingerprint in groups of four, easier to read aloud.
function fpGroups(fingerprint) {
  const groups = fingerprint.match(/.{1,4}/g) || [fingerprint];
  return groups.join("-");
}

function yesNo(isYes) {
  return isYes ? msg("pa_yes", "Yes") : msg("pa_no", "No");
}

// ---------- The policy summary ----------

// The preset's name, marked when the organization changed it, or "Custom" without one.
function presetLabelOf(policy) {
  const presetName = PRESET_NAMES[policy.preset];
  if (!policy.preset || !presetName) return msg("pa_custom", "Custom");
  const bare = Sites.mergePolicy({ preset: policy.preset });
  if (Sites.policyFingerprint(policy) === Sites.policyFingerprint(bare)) return presetName;
  return msg("pa_presetWithChanges", "$1 with organization changes", presetName);
}

// The built-in kinds each required response holds, by name.
// A team's own kinds have their own table below, so they aren't listed twice.
function kindNamesByResponse(policy, ownKinds) {
  const ownIds = new Set(ownKinds.map((kind) => kind.id));
  const byResponse = { block: [], warn: [], log: [] };
  for (const [id, response] of Object.entries(policy.requiredResponses || {})) {
    if (byResponse[response] && !ownIds.has(id)) byResponse[response].push(patternName(id));
  }
  return byResponse;
}

// holdFiles widens the file hold past kinds set to Ask before sending, to anything a file holds. Without
// it, the hold still follows those kinds alone, worked out from the floor with no field of its own, so
// the fingerprint doesn't change just because one of them is set to block.
function fileHoldItems(policy) {
  const label = msg("pa_files", "Attached files");
  if (policy.holdFiles === true) {
    return [[label, [msg("pa_filesHeldAll", "held until you confirm, for anything Clotr finds inside")]]];
  }
  if (Sites.teamHoldOf(policy)) {
    const held = msg("pa_filesHeld", "held until the person answers, when they hold a kind set to Ask before sending");
    return [[label, [held]]];
  }
  return [];
}

// Each count line: a bold label, then the names or the number.
function countItem([label, list]) {
  const item = document.createElement("li");
  const bold = document.createElement("b");
  bold.textContent = `${label}: `;
  const value = list.length ? list.join(", ") : msg("pa_none2", "none");
  item.append(bold, document.createTextNode(value));
  return item;
}

function renderCounts(policy, ownKinds, words, shapes) {
  const byResponse = kindNamesByResponse(policy, ownKinds);
  const items = [
    [msg("pa_countBlock", "Ask before sending"), byResponse.block],
    [msg("pa_countWarn", "Warn"), byResponse.warn],
    [msg("pa_countLog", "Just count"), byResponse.log],
    [msg("pa_countWatchWords", "Watch words"), [String(words.length)]],
    [msg("pa_countWatchFormats", "Watch formats"), [String(shapes.length)]],
    [msg("pa_pausingAllowed", "Pausing allowed"), [yesNo(policy.allowPause !== false)]],
    [msg("pa_settingsLocked", "Settings locked"), [yesNo(policy.lockSettings === true)]],
    [msg("pa_largerWarnings", "Larger warnings"), [yesNo(policy.largeText === true)]],
    ...fileHoldItems(policy),
  ];
  $("pa-counts").replaceChildren(...items.map(countItem));
}

async function render() {
  const raw = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  const policy = Sites.mergePolicy(raw);
  const active = Sites.hasPolicy(policy);
  $("pa-none").hidden = active;
  $("pa-policy").hidden = !active;
  if (!active) return;

  $("pa-org").textContent = policy.orgName || "";
  const manifest = chrome.runtime.getManifest();
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("pa-version").textContent = `Clotr ${manifest.version} — ${dateStr} — ${browserInfo()}`;

  $("pa-preset").textContent = presetLabelOf(policy);
  $("pa-fingerprint").textContent = fpGroups(Sites.policyFingerprint(policy));

  const kinds = Array.isArray(policy.kinds) ? policy.kinds : [];
  const words = Sites.policyWords(policy);
  const shapes = Sites.policyShapes(policy);
  renderCounts(policy, kinds, words, shapes);

  renderKinds(kinds);

  $("pa-show-words").checked = false;
  $("pa-words").hidden = true;
  $("pa-words").textContent = [...words, ...shapes].join(", ");
}

// ---------- The team's own kinds ----------

function tableCell(text) {
  const element = document.createElement("td");
  element.textContent = text;
  return element;
}

// "Kinds your organization added": each kind's name, its response, and how many words and formats it
// has, never the words or formats themselves; then the cover names Bandage gives them.
function renderKinds(kinds) {
  $("pa-kinds").hidden = !kinds.length;
  const responses = {
    block: msg("pa_countBlock", "Ask before sending"),
    warn: msg("pa_countWarn", "Warn"),
    log: msg("pa_countLog", "Just count"),
  };
  const rows = kinds.map((kind) => kindRow(kind, responses));
  $("pa-kinds-table").tBodies[0].replaceChildren(...rows);
  const covers = [...new Set(kinds.map((kind) => `[${kind.cover} 1]`))].join(", ");
  $("pa-kinds-covers").textContent = kinds.length
    ? msg("pa_kindsCovers", "Cover names for these kinds: $1.", covers)
    : "";
}

function kindRow(kind, responses) {
  const row = document.createElement("tr");
  const formats = String(kind.formats.length);
  const hasNear = kind.formats.length && kind.near.length;
  const formatsText = hasNear ? msg("pa_kindsWithNear", "$1, with nearby words", formats) : formats;
  row.append(
    tableCell(kind.name),
    tableCell(responses[kind.response] || responses.warn),
    tableCell(String(kind.words.length)),
    tableCell(formatsText),
  );
  return row;
}

// ---------- Start ----------

$("pa-show-words").addEventListener("change", (event) => {
  $("pa-words").hidden = !event.target.checked;
});
$("pa-print").addEventListener("click", () => window.print());

document.title = msg("pa_title", "Organization policy applied here");
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "managed") render();
});
render();
