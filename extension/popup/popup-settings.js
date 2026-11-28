/* global $, BUILT_IN, FEATURES, GROUPS, IS_SAFARI, PATTERNS, RESPONSES, RESPONSE_LABELS, Sites, VAULT_LABELS,
          combinedPolicy, countBy, defaultResponse, detectSite, el, keptOnByEverywhere, leavesForQuestion, msg,
          prettyPattern, refreshSites, renderAll, renderSite, renderTourniquet, responseFor, selectTab, setEverydaySite,
          site, state, switchOf, switchedOffHere, tourniquetOn */
/* exported renderLookBackCard, renderScamHelpToday, unlockedUntil */
"use strict";

// ---------- Settings ----------

// Routed through the background (clotr:setResponses) so a reply arriving from another AI tab while this
// saves can't read storage before this write lands and overwrite it on its own save.
async function setResponse(id, value) {
  await chrome.runtime.sendMessage({ type: "clotr:setResponses", ids: [id], value });
}

// One control for a whole group: "default" clears the group's overrides (sites-and-policy/helping-someone.js).
const Helper = globalThis.Clotr.Helper;
const { setGroupResponse } = Helper;

// "default" when nothing is overridden, the shared response when all agree, else "custom".
function groupValue(ids) {
  if (!ids.some((id) => id in state.responses)) return "default";
  const values = new Set(ids.map((id) => responseFor(id, state.responses)));
  return values.size === 1 ? [...values][0] : "custom";
}

$("open-vault").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/vault/vault.html") }),
);
$("open-watch").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/vault/vault.html#watch") }),
);
$("open-stored").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/what-clotr-stores/what-clotr-stores.html") }),
);
$("open-move").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/what-clotr-stores/what-clotr-stores.html#move") }),
);
for (const id of ["open-dashboard", "digest-open", "mini-map-open"]) {
  $(id).addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/exposure-report/exposure-report.html") }),
  );
}

// Removes one protected section; the host's permission goes when none are left.
async function removeUserSite(pattern) {
  const perm = Sites.permissionFor(pattern);
  await Sites.forgetPicks([pattern]); // in case it was switched on while Everywhere I type covered it
  const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
  const rest = (siteScopes[perm] || []).filter((scope) => scope !== pattern);
  if (rest.length && pattern !== perm) {
    siteScopes[perm] = rest;
    await chrome.storage.local.set({ siteScopes });
  } else {
    delete siteScopes[perm];
    await chrome.storage.local.set({ siteScopes });
    // On a host with a built-in section (huggingface.co) the whole-host grant is the manifest's, and the
    // browser refuses to remove it. Dropping the section above is what stops Clotr running there, so that's
    // fine.
    await chrome.permissions.remove({ origins: [perm] }).catch(() => {});
  }
  state.userSites = await Sites.userSitePatterns();
  await detectSite();
  renderSite();
  renderSettings();
}

// ---------- Helping someone: larger warnings, stricter personal details, PIN lock ----------
// Shared with the guided setup page (clotr-pages/set-up-for-someone/set-up-for-someone.html) through sites-and-policy/helping-someone.js: the PIN is kept only as a salted
// PBKDF2 hash, and unlocking lasts 10 minutes across Clotr's pages.
let unlockedUntil = 0;
let wrongTries = 0;
let retryAt = 0;

const managedLock = () => state.policy?.lockSettings === true;
const isLocked = () => managedLock() || (Boolean(state.lock) && Date.now() >= unlockedUntil);
async function markUnlocked() {
  unlockedUntil = await Helper.markUnlocked();
}
function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}

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
  if ($("command-check")) $("command-check").checked = state.commandCheck;
  $("strict-personal").checked = Helper.asksBeforePersonal(state.responses);
  $("lock-remove").hidden = !state.lock;
  $("lock-set").textContent = state.lock
    ? msg("pp_changePin", "Change the PIN")
    : msg("popup_lockSettings", "Lock settings");
}

$("managed-see").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/policy-applied/policy-applied.html") }),
);
$("managed-training")?.addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/office-training/office-training.html") }),
);
// A held-back feature's own element isn't in the shipped build at all, so every door to it and
// every line that hides or shows it is guarded the same way: nothing to find, nothing to touch.
if ($("managed-training")) $("managed-training").hidden = !FEATURES.training;
$("large-text").addEventListener("change", (event) => chrome.storage.local.set({ largeText: event.target.checked }));
$("reply-check").addEventListener("change", (event) => chrome.storage.local.set({ replyCheck: event.target.checked }));
$("command-check")?.addEventListener("change", (event) =>
  chrome.storage.local.set({ commandCheck: event.target.checked }),
);
if ($("command-check-row")) $("command-check-row").hidden = !FEATURES.commandcheck;
if ($("command-check-hint")) $("command-check-hint").hidden = !FEATURES.commandcheck;

// ---------- Clotr Antibody: the Overview row and Settings' section open its pages ----------
// Each door opens a page in a new tab; none changes a setting, so the Overview row works while settings
// are locked. The 30-day line opens the setup page with "After a scam" already chosen (clotr-pages/set-up-for-someone/set-up-for-someone.js reads
// ?for=after_scam).
for (const [id, page] of [
  ["ss-row-check", "clotr-pages/scam-check/scam-check.html"],
  ["ss-row-practice", "clotr-pages/practice/practice.html"],
  ["ss-settings-check", "clotr-pages/scam-check/scam-check.html"],
  ["ss-settings-practice", "clotr-pages/practice/practice.html"],
  ["ss-open-card", "clotr-pages/share-clotr/share-clotr.html#card"],
  ["ss-tq30-open", "clotr-pages/set-up-for-someone/set-up-for-someone.html?for=after_scam#who"],
]) {
  $(id)?.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
}
// The Overview row's own doors, folded into Scam help in Settings too, so someone who meets the row under
// Tourniquet and someone who opens the folded section both land in the same two places.
if ($("ss-row-check")) $("ss-row-check").hidden = !FEATURES.scamcheck;
if ($("ss-row-practice")) $("ss-row-practice").hidden = !FEATURES.practice;
if ($("ss-settings-check")) $("ss-settings-check").hidden = !FEATURES.scamcheck;
if ($("ss-settings-practice")) $("ss-settings-practice").hidden = !FEATURES.practice;
if ($("ss-open-card")) $("ss-open-card").hidden = !FEATURES.scamcheck;
// The Overview row's own visibility (shown only while Tourniquet's on) is decided in renderTourniquet(); Scam
// help's whole section hides only once nothing it holds is on (its own ss-tq30 line is gated there too).
const scamHelpParts = [FEATURES.scamcheck, FEATURES.practice, FEATURES.commandcheck, FEATURES.tourniquet];
$("ss-settings").hidden = !scamHelpParts.some(Boolean);
$("ss-today-open")?.addEventListener("click", () => {
  selectTab("settings");
  const details = $("ss-help");
  if (details) details.open = true;
  details?.scrollIntoView({ block: "start" });
});

// ---------- Look back and Extension check: the Overview card and Settings' section open them ----------
// Neither door changes a setting or touches storage, so both work while settings are locked.
for (const [id, page] of [
  ["lb-card-open", "clotr-pages/look-back/look-back.html"],
  ["lb-card-check", "clotr-pages/extension-check/extension-check.html"],
  ["lb-settings-open", "clotr-pages/look-back/look-back.html"],
  ["lb-settings-check", "clotr-pages/extension-check/extension-check.html"],
]) {
  $(id)?.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
}
// Look back and Extension check are both held back, gated independently; Safari also has
// no management API, so its build hides Extension check's doors even when the feature is on.
if ($("lb-card-row")) $("lb-card-row").hidden = !FEATURES.lookback;
if ($("lb-settings-row")) $("lb-settings-row").hidden = !FEATURES.lookback;
if ($("lb-card-ec-row")) $("lb-card-ec-row").hidden = IS_SAFARI || !FEATURES.extcheck;
if ($("lb-settings-ec-row")) $("lb-settings-ec-row").hidden = IS_SAFARI || !FEATURES.extcheck;
$("lb-card").hidden = !FEATURES.lookback && (IS_SAFARI || !FEATURES.extcheck);
$("lb-settings").hidden = !FEATURES.lookback && (IS_SAFARI || !FEATURES.extcheck);

// With no history yet there's nothing else on Overview to look at, so the card keeps its full words and
// invites someone in; once there's real history it folds onto one line (.compact), the same quiet shape as
// the Antibody row above it: an empty history invites people in, a full one stays out of the way.
function renderLookBackCard() {
  $("lb-card").classList.toggle("compact", state.events.length > 0);
}

// A quiet nudge for the rest of the day a card-code or gift-card warning showed, so Scam help isn't fully
// out of sight right when it might matter. A code tucked inside a plain password (a login code, a backup
// code…) never shows up here: the engine deliberately never stores why a password matched, only that it
// did, so only these two kinds can be told apart from history after the fact. Tourniquet already keeps its
// own row up, so this skips while that's on.
function renderScamHelpToday() {
  const link = $("ss-today-link");
  if (!link) return;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const shown =
    FEATURES.scamcheck &&
    !tourniquetOn() &&
    state.events.some(
      (record) => record.t >= todayStart && (record.type === "card_code" || record.type === "gift_card"),
    );
  link.hidden = !shown;
}

// ---------- Bandage: per-site on/off, and turning it on for this tab ----------
async function setBandageHost(host, on) {
  const { bandage = {} } = await chrome.storage.local.get("bandage");
  bandage[host] = on;
  await chrome.storage.local.set({ bandage });
  state.bandage = bandage;
  renderBandage();
}
$("bandage-here").addEventListener("change", (event) => {
  if (site.kind === "protected") setBandageHost(site.host, event.target.checked);
});
function renderBandage() {
  const entries = Object.entries(state.bandage).sort(([firstHost], [secondHost]) =>
    firstHost.localeCompare(secondHost),
  );
  $("bandage-sites").replaceChildren(
    ...entries.map(([host, on]) => {
      const box = el("input", { type: "checkbox", checked: on === true });
      box.addEventListener("change", () => setBandageHost(host, box.checked));
      return el("li", {}, [
        el("label", { className: "toggle" }, [box, el("span", { className: "grow", textContent: host })]),
      ]);
    }),
  );
  $("bandage-sites-empty").hidden = entries.length > 0;
  const onThisSite = site.kind === "protected" && state.bandage[site.host] === true;
  $("bandage-here").checked = onThisSite;
  $("bandage-here").disabled = site.kind !== "protected";
}
$("strict-personal").addEventListener("change", (event) => Helper.setAskBeforePersonal(event.target.checked));
$("open-helper").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/set-up-for-someone/set-up-for-someone.html") }),
);
$("open-share").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/share-clotr/share-clotr.html") }),
);
// The first-install welcome again: to reread it, show someone, or try the practice box.
$("open-welcome").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("clotr-pages/vault/vault.html?welcome=1") }),
);
$("everywhere-switch").addEventListener("click", () => setEverywhere(!state.everywhereOn));
$("lock-set").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  if (!Helper.validPin(pin)) {
    say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
    return;
  }
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
  if (Date.now() < retryAt) {
    say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
    return;
  }
  const pin = $("unlock-pin").value.trim();
  const ok = await Helper.pinMatches(pin, state.lock);
  $("unlock-pin").value = "";
  if (!ok) {
    if (++wrongTries >= 5) {
      retryAt = Date.now() + 30000;
      wrongTries = 0;
    }
    say("unlock-msg", msg("pp_wrongPin", "That PIN didn't match."), true);
    return;
  }
  wrongTries = 0;
  say("unlock-msg", "");
  await markUnlocked();
  renderAll();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (event) => {
  if (event.key === "Enter") tryUnlock();
});

// A site's switch, for screen readers and voice control: the words on it first ("Turn on", "On"), so saying
// what you see reaches it (WCAG 2.5.3, label in name), then which site it's for.
const switchName = (btn, listedSite) => `${btn.textContent}, ${msg("pp_everydayFor", "Clotr on $1", listedSite.name)}`;

// Settings' "Also on search engines" and "Also on support chats on websites": the same one-switch-per-site
// shape as renderEverydaySites, for the search and support lists, which only ever hold one kind each so the
// section heading says what they are instead of a per-row label.
function renderMoreSites(listId, statusId, sites, granted) {
  const rows = sites.map((listedSite) => {
    const { on, through } = switchOf(listedSite, granted);
    const btn = el("button", {
      className: on ? "btn switch on" : "btn switch",
      textContent: on ? msg("pp_on", "On") : msg("pp_turnOn", "Turn on"),
      disabled: isLocked(),
    });
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", switchName(btn, listedSite));
    btn.addEventListener("click", () => setMoreSite(listedSite, !on, statusId));
    const why = through ? [el("span", { className: "why", textContent: throughEverywhere() })] : [];
    return el("li", {}, [el("span", { className: "grow" }, [el("b", { textContent: listedSite.name }), ...why]), btn]);
  });
  $(listId).replaceChildren(...rows);
}

// Same idea as setEverydaySite, for one search or support site: the ask comes first, in the same click, and
// nothing about it is stored beyond what the browser already remembers as a grant.
async function setMoreSite(listedSite, on, statusId) {
  if (on) {
    say(statusId, "");
    const asked = Sites.requestMoreSites([listedSite.name]);
    if (leavesForQuestion(listedSite.matches)) window.close();
    const yes = await asked;
    if (!yes) {
      say(
        statusId,
        msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        ),
      );
    }
  } else {
    say(statusId, "");
    if (!(await switchedOffHere(listedSite, Sites.removeMoreSites))) {
      say(statusId, keptOnByEverywhere());
      return;
    }
  }
  await refreshSites();
  if (!on && switchOf(listedSite, state.userSites).on) say(statusId, keptOnByEverywhere());
}

// "Everywhere I type": one switch for the broad permission itself, not a list, so it reads the browser's own
// grant (passed in, since userSitePatterns() excludes the broad origin) rather than anything stored.
function renderEverywhereSwitch(on) {
  const btn = $("everywhere-switch");
  btn.className = on ? "btn switch on" : "btn switch";
  btn.textContent = on ? msg("pp_on", "On") : msg("pp_turnOn", "Turn on");
  btn.setAttribute("aria-pressed", String(on));
  btn.disabled = isLocked();
}

// Same shape as setMoreSite, for the one broad origin: the ask comes first, in the same click, and switching
// off just removes the grant Clotr asked for. Every switch below that read "Through Everywhere I type" goes
// off with it.
async function setEverywhere(on) {
  say("everywhere-status", "");
  if (on) {
    const asked = Sites.requestEverywhere();
    if (leavesForQuestion([Sites.EVERYWHERE_ORIGIN])) window.close();
    const yes = await asked;
    if (!yes) {
      say(
        "everywhere-status",
        msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        ),
      );
    }
  } else {
    await chrome.permissions.remove({ origins: [Sites.EVERYWHERE_ORIGIN] });
  }
  await refreshSites();
}

const throughEverywhere = () => msg("pp_throughEverywhere", "Through Everywhere I type");

// Email and chat apps: a switch per app on the list, then any other site you switched on as "not an AI".
function renderEverydaySites(granted) {
  const listed = new Set(Sites.EVERYDAY_SITES.flatMap((everydayApp) => everydayApp.matches));
  const rows = Sites.EVERYDAY_SITES.map((everydayApp) => {
    const { on, through } = switchOf(everydayApp, granted);
    const kind = everydayApp.kind === "email" ? msg("pp_kindEmail", "Email") : msg("pp_kindChat", "Chat app");
    const btn = el("button", {
      className: on ? "btn switch on" : "btn switch",
      textContent: on ? msg("pp_on", "On") : msg("pp_turnOn", "Turn on"),
      disabled: isLocked(),
    });
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", switchName(btn, everydayApp));
    btn.addEventListener("click", () => setEverydaySite(everydayApp, !on));
    return el("li", {}, [
      el("span", { className: "grow" }, [
        el("b", { textContent: everydayApp.name }),
        el("span", {
          className: "why",
          textContent: through ? msg("pp_kindThroughEverywhere", "$1, through Everywhere I type", kind) : kind,
        }),
      ]),
      btn,
    ]);
  });
  const others = granted
    .filter((pattern) => !listed.has(pattern))
    .map((pattern) => {
      const btn = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
      btn.addEventListener("click", () => removeUserSite(pattern));
      return el("li", {}, [el("span", { className: "grow", textContent: prettyPattern(pattern) }), btn]);
    });
  $("everyday-sites").replaceChildren(...rows, ...others);
}

// ---------- Settings: the lists of sites ----------

// Which list a site you switched on belongs in, by its host.
function userSiteHost(pattern) {
  return new URL(pattern.replace(/\*$/, "")).hostname;
}
function isEverydayPattern(pattern) {
  return Sites.isEveryday(userSiteHost(pattern), state.siteKinds);
}
function isSearchPattern(pattern) {
  return Sites.isSearchSite(userSiteHost(pattern));
}
function isSupportPattern(pattern) {
  return Sites.isSupportSite(userSiteHost(pattern));
}

function userSiteItem(pattern) {
  const btn = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
  btn.addEventListener("click", () => removeUserSite(pattern));
  const label = el("span", { className: "grow", textContent: prettyPattern(pattern) });
  if (Sites.isWiderThanNeeded(pattern)) {
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
}

// AI sites you added, apart from the email, chat, search and support ones.
function renderUserSites() {
  const userItems = state.userSites
    .filter((pattern) => !isEverydayPattern(pattern) && !isSearchPattern(pattern) && !isSupportPattern(pattern))
    .map(userSiteItem);
  $("user-sites").replaceChildren(...userItems);
  $("user-sites-empty").hidden = userItems.length > 0;
}

// Named list from ai-sites.json; falls back to the raw manifest patterns.
function renderBuiltInSites() {
  const tools = state.builtInTools.length
    ? state.builtInTools
    : BUILT_IN.map((pattern) => ({ name: prettyPattern(pattern), matches: [] }));
  $("builtin-count").textContent = String(tools.length);
  $("builtin-sites").replaceChildren(
    ...tools.map((tool) =>
      el("li", {}, [
        el("b", { textContent: tool.name }),
        tool.matches.length ? ` — ${tool.matches.map(prettyPattern).join(", ")}` : "",
      ]),
    ),
  );
}

// ---------- Settings: what Clotr does for each kind ----------

function responseTitle(floored, floor, name) {
  if (floored) return msg("popup_managedByYourOrganization", "Managed by your organization.");
  if (floor) return msg("pp_tqKeeps", "Tourniquet keeps this");
  return msg("pp_whatDoes", "What Clotr does when it finds: $1", name);
}

// One kind's row: its name and a choice of Ask before sending, Warn or Just count.
function responseRow(pattern, { effResponses, kept }) {
  const current = responseFor(pattern.id, effResponses);
  const floored = RESPONSES.includes(state.policy?.requiredResponses?.[pattern.id]);
  // Tourniquet's floor for this kind: the choices under it can't be picked while it's on.
  const floor = !floored && Object.hasOwn(kept, pattern.id) ? kept[pattern.id] : null;
  const select = el(
    "select",
    {
      className: "resp",
      title: responseTitle(floored, floor, pattern.name),
      disabled: floored || floor === "block",
    },
    RESPONSES.map((response) =>
      el("option", {
        value: response,
        selected: response === current,
        disabled: Boolean(floor) && RESPONSES.indexOf(response) > RESPONSES.indexOf(floor),
        textContent:
          RESPONSE_LABELS[response] +
          (response === defaultResponse(pattern.id) ? msg("pp_defaultSuffix", " (default)") : ""),
      }),
    ),
  );
  select.dataset.pattern = pattern.id;
  select.classList.toggle("changed", current !== defaultResponse(pattern.id));
  select.setAttribute("aria-label", msg("pp_responseFor", "Response for $1", pattern.name));
  select.addEventListener("change", () => setResponse(pattern.id, select.value));
  // A kind's name wraps between words ("Número de la Seguridad Social de EE. UU."), never inside one.
  return el("li", {}, [
    el("span", { className: "grow words" }, [
      el("span", {
        className: `sev ${pattern.severity}`,
        textContent: msg(`sev_${pattern.severity}`, pattern.severity),
      }),
      pattern.name,
    ]),
    select,
  ]);
}

// A group's own choice: Default, each response, and Custom when its kinds differ.
function groupOptions(ids, value) {
  // A group with a kind that starts as Just count says so, so its "Default" isn't read as warn for all.
  const someQuiet = ids.some((id) => defaultResponse(id) === "log");
  const options = [
    [
      "default",
      someQuiet
        ? msg("pp_defaultWarnSomeCount", "Default (warn, a few just count)")
        : msg("pp_defaultWarn", "Default (warn)"),
    ],
    ...RESPONSES.map((response) => [response, RESPONSE_LABELS[response]]),
  ];
  if (value === "custom") options.push(["custom", msg("pp_custom", "Custom")]);
  return options;
}

function groupBlock(group, { openGroups, effResponses, kept }) {
  const members = PATTERNS.filter((pattern) => pattern.group === group.id);
  const ids = members.map((pattern) => pattern.id);
  const value = groupValue(ids);
  const select = el(
    "select",
    { className: "resp" },
    groupOptions(ids, value).map(([optionValue, label]) =>
      el("option", {
        value: optionValue,
        selected: optionValue === value,
        textContent: label,
        disabled: optionValue === "custom",
      }),
    ),
  );
  select.dataset.group = group.id;
  select.classList.toggle("changed", value !== "default");
  select.setAttribute("aria-label", msg("pp_responseForAll", "Response for all: $1", group.name));
  select.addEventListener("change", () => setGroupResponse(ids, select.value));
  const details = el("details", { className: "advanced-only", open: openGroups.has(group.id) }, [
    el("summary", { textContent: msg("pp_chooseEach", "Choose for each ($1)", members.length) }),
    el(
      "ul",
      { className: "list" },
      members.map((pattern) => responseRow(pattern, { effResponses, kept })),
    ),
  ]);
  details.dataset.group = group.id;
  return el("div", { className: "resp-group" }, [
    el("div", { className: "head" }, [el("span", { className: "grow", textContent: group.name }), select]),
    details,
  ]);
}

function renderResponses() {
  const openGroups = new Set(
    [...document.querySelectorAll(".resp-group details[open]")].map((details) => details.dataset.group),
  );
  // The effective response per kind: writes still go
  // to the raw stored map (setResponse), so nothing is lost when the policy or Tourniquet goes away.
  const kept = Sites.tourniquetPolicy(state.tourniquet)?.requiredResponses || {};
  const effResponses = Sites.applyPolicy({ responses: state.responses }, combinedPolicy()).responses;
  $("responses").replaceChildren(
    ...GROUPS.map((group) => groupBlock(group, { openGroups, effResponses, kept })),
    ...teamGroup(effResponses),
  );
}

// Simple mode by default: per-type settings, per-site modes and the built-in list
// appear only with "Show advanced options"; a note says when hidden ones are in use.
function renderAdvancedNote() {
  document.body.classList.toggle("advanced", state.advanced);
  $("advanced").checked = state.advanced;
  const customized = GROUPS.some(
    (group) =>
      groupValue(PATTERNS.filter((pattern) => pattern.group === group.id).map((pattern) => pattern.id)) === "custom",
  );
  $("advanced-in-use").hidden = state.advanced || !(customized || Object.keys(state.siteModes).length);
}

// Vault summary: counts by category (the vault page has the details).
function renderVaultSummary() {
  const byCat = countBy(state.vault, (entry) => VAULT_LABELS[entry.type] || msg("pp_other", "Other"));
  $("vault-summary").textContent = byCat.length
    ? byCat.map(([cat, count]) => `${cat} ${count}`).join(" · ")
    : msg("pp_vaultEmpty", "Nothing here yet. Add your details so Clotr knows what's yours to protect.");
}

function renderSettings() {
  renderHelper();
  renderTourniquet();
  renderBandage();
  renderUserSites();
  renderEverydaySites(state.userSites.filter(isEverydayPattern));
  renderMoreSites("search-sites", "search-status", Sites.SEARCH_SITES, state.userSites.filter(isSearchPattern));
  renderMoreSites("support-sites", "support-status", Sites.SUPPORT_SITES, state.userSites.filter(isSupportPattern));
  renderEverywhereSwitch(state.everywhereOn);
  // "Pick sites one by one instead" opens itself once an email, chat or support site inside it is already
  // on, so a switch someone already flipped is never left hidden behind the fold.
  if (state.userSites.some((pattern) => isEverydayPattern(pattern) || isSupportPattern(pattern))) {
    $("pick-sites").open = true;
  }
  renderBuiltInSites();
  renderResponses();
  renderAdvancedNote();
  renderVaultSummary();
}

// One of a team's own kinds, with its response locked in.
function teamKindRow(kind, { effResponses, setBy }) {
  const current = responseFor(kind.id, effResponses);
  const select = el(
    "select",
    { className: "resp", title: `${setBy}.`, disabled: true },
    RESPONSES.map((response) =>
      el("option", { value: response, selected: response === current, textContent: RESPONSE_LABELS[response] }),
    ),
  );
  select.dataset.pattern = kind.id;
  select.setAttribute("aria-label", msg("pp_responseFor", "Response for $1", kind.name));
  return el("li", {}, [el("span", { className: "grow", textContent: kind.name }), select]);
}

// Shows a team's own kinds, set by its policy, with each row's response locked in and unchangeable. It shows
// even in simple mode, since this is what the organization chose for this computer, though the rows stay
// folded away until asked for. With no kinds in the policy, this renders nothing.
function teamGroup(effResponses) {
  const kinds = Array.isArray(state.policy?.kinds) ? state.policy.kinds : [];
  if (!kinds.length) return [];
  const setBy = msg("pp_setByOrg", "Set by your organization");
  const open = Boolean(document.querySelector('.resp-group[data-group="team"] details[open]'));
  const group = el("div", { className: "resp-group" }, [
    el("div", { className: "head" }, [
      el("span", { className: "grow", textContent: msg("pp_gTeam", "Kinds your organization added") }),
      el("span", { className: "set-by", textContent: setBy }),
    ]),
    el("details", { open }, [
      el("summary", { textContent: msg("pp_seeEach", "See each ($1)", kinds.length) }),
      el(
        "ul",
        { className: "list" },
        kinds.map((kind) => teamKindRow(kind, { effResponses, setBy })),
      ),
    ]),
  ]);
  group.dataset.group = "team";
  return [group];
}

// Two clicks to clear, so a stray click can't wipe history: Settings' "Clear history", and "Clear my
// history" in the locked view (no PIN: the history is the person's own).
function twoClickClear(btn, idleText) {
  let armed = null;
  function disarm() {
    clearTimeout(armed);
    armed = null;
    btn.textContent = idleText();
    btn.classList.remove("confirm");
  }
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
