// "Organization policy applied here": a self-attestation page for an admin or an
// insurer's checklist. Reads the managed policy, this extension's version and the browser; writes and sends
// nothing, ever. Never says "prevents", "certified" or "compliant".
"use strict";

const { msg, PATTERNS } = globalThis.Clotr;
const Sites = globalThis.ClotrSites;
const $ = (id) => document.getElementById(id);

const PRESET_NAMES = {
  keys_never: msg("pa_presetKeysNever", "Keys never"),
  client_names: msg("pa_presetClientNames", "Client names"),
  clinic: msg("pa_presetClinic", "Clinic"),
  tax_office: msg("pa_presetTaxOffice", "Tax office"),
};

// navigator.userAgentData when a browser offers it (skipping the generic "Not.A;Brand" and
// "Chromium" entries for a more specific one); the UA string otherwise.
function browserInfo() {
  const uad = navigator.userAgentData;
  if (uad?.brands?.length) {
    const filtered = uad.brands.filter((b) => !/not.a.brand/i.test(b.brand) && b.brand !== "Chromium");
    const pick = filtered[0] || uad.brands[0];
    if (pick) return `${pick.brand} ${pick.version}`;
  }
  const ua = navigator.userAgent;
  for (const name of ["Edg", "Firefox", "Chrome"]) {
    const m = ua.match(new RegExp(`${name}/(\\d+)`));
    if (m) return `${name === "Edg" ? "Edge" : name} ${m[1]}`;
  }
  return ua;
}

function patternName(id) {
  return PATTERNS.find((p) => p.id === id)?.name || id;
}

function fpGroups(fp) {
  return (fp.match(/.{1,4}/g) || [fp]).join("-");
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

  let presetLabel = msg("pa_custom", "Custom");
  if (policy.preset && PRESET_NAMES[policy.preset]) {
    const bare = Sites.mergePolicy({ preset: policy.preset });
    presetLabel =
      Sites.policyFingerprint(policy) === Sites.policyFingerprint(bare)
        ? PRESET_NAMES[policy.preset]
        : msg("pa_presetWithChanges", "$1 with organization changes", PRESET_NAMES[policy.preset]);
  }
  $("pa-preset").textContent = presetLabel;
  $("pa-fingerprint").textContent = fpGroups(Sites.policyFingerprint(policy));

  // A team's own kinds have their own table below, so they aren't listed twice.
  const kinds = Array.isArray(policy.kinds) ? policy.kinds : [];
  const own = new Set(kinds.map((k) => k.id));
  const byResponse = { block: [], warn: [], log: [] };
  for (const [id, value] of Object.entries(policy.requiredResponses || {})) {
    if (byResponse[value] && !own.has(id)) byResponse[value].push(patternName(id));
  }
  const words = Sites.policyWords(policy);
  const shapes = Sites.policyShapes(policy);
  const items = [
    [msg("pa_countBlock", "Ask before sending"), byResponse.block],
    [msg("pa_countWarn", "Warn"), byResponse.warn],
    [msg("pa_countLog", "Just count"), byResponse.log],
    [msg("pa_countWatchWords", "Watch words"), [String(words.length)]],
    [msg("pa_countWatchFormats", "Watch formats"), [String(shapes.length)]],
    [
      msg("pa_pausingAllowed", "Pausing allowed"),
      [policy.allowPause === false ? msg("pa_no", "No") : msg("pa_yes", "Yes")],
    ],
    [
      msg("pa_settingsLocked", "Settings locked"),
      [policy.lockSettings === true ? msg("pa_yes", "Yes") : msg("pa_no", "No")],
    ],
    [
      msg("pa_largerWarnings", "Larger warnings"),
      [policy.largeText === true ? msg("pa_yes", "Yes") : msg("pa_no", "No")],
    ],
    // Worked out from the kinds set to Ask before sending: no field of its own, so the fingerprint
    // above doesn't change with it.
    ...(Sites.teamHoldOf(policy)
      ? [
          [
            msg("pa_files", "Attached files"),
            [msg("pa_filesHeld", "held until the person answers, when they hold a kind set to Ask before sending")],
          ],
        ]
      : []),
  ];
  $("pa-counts").replaceChildren(
    ...items.map(([label, list]) => {
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = `${label}: `;
      li.append(b, document.createTextNode(list.length ? list.join(", ") : msg("pa_none2", "none")));
      return li;
    }),
  );

  renderKinds(kinds);

  $("pa-show-words").checked = false;
  $("pa-words").hidden = true;
  $("pa-words").textContent = [...words, ...shapes].join(", ");
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
  const cell = (text) => {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  };
  $("pa-kinds-table").tBodies[0].replaceChildren(
    ...kinds.map((k) => {
      const tr = document.createElement("tr");
      const formats = String(k.formats.length);
      tr.append(
        cell(k.name),
        cell(responses[k.response] || responses.warn),
        cell(String(k.words.length)),
        cell(k.formats.length && k.near.length ? msg("pa_kindsWithNear", "$1, with nearby words", formats) : formats),
      );
      return tr;
    }),
  );
  const covers = [...new Set(kinds.map((k) => `[${k.cover} 1]`))].join(", ");
  $("pa-kinds-covers").textContent = kinds.length
    ? msg("pa_kindsCovers", "Cover names for these kinds: $1.", covers)
    : "";
}

$("pa-show-words").addEventListener("change", (e) => {
  $("pa-words").hidden = !e.target.checked;
});
$("pa-print").addEventListener("click", () => window.print());

document.title = msg("pa_title", "Organization policy applied here");
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") render();
});
render();
