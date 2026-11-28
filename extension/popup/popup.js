// The toolbar popup, also used as a mini dashboard.
/* global Clotr */
// Reads settings and event history from chrome.storage.local. The only things it writes back are the user's
// own settings, like pausing or per-pattern responses, plus clearing history when asked.
/* global $, FEATURES, Helper, IS_SAFARI, Sites, detectSite, el, firefoxPanel:writable, isFirefoxPanel, isLocked,
          leavesForQuestion, msg, rangeDays:writable, refreshSites, renderActivity, renderOverview, renderSettings,
          renderSite, renderSiteFilter, state:writable, unlockedUntil:writable, writePref */
/* exported firefoxPanel, unlockedUntil */
"use strict";

// ---------- Tabs & range ----------

const TABS = ["overview", "activity", "settings"];
function selectTab(name) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`panel-${tab}`).hidden = tab !== name;
  }
  document.body.dataset.tab = name; // the site filter only applies to Overview and Activity
  if (name === "overview") renderOverview(); // chart needs a visible panel to measure its width
}
for (const tab of TABS) $(`tab-${tab}`).addEventListener("click", () => selectTab(tab));
$("caught-what").addEventListener("click", () => {
  selectTab("settings");
  $("responses-heading")?.scrollIntoView({ block: "start" });
});
$("caught-settings").addEventListener("click", () => selectTab("settings"));
$("reply-mentions-open").addEventListener("click", () => selectTab("activity"));

for (const button of document.querySelectorAll(".range button")) {
  button.addEventListener("click", () => {
    rangeDays = Number(button.dataset.days);
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

// Shows "Updated to vX" once per update, since the background sets lastUpdate when one happens. The
// release's own notes stay folded under "See what's new" until opened, so the popup stays short. Opening the
// list isn't the same as dismissing it; only clicking Got it marks it seen.
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
// popup/popup.js's own, and it only gets filled in once a release actually ships the pages its notes mention.
const RELEASE_DOORS = {
  "v1.3": [
    { page: "clotr-pages/look-back/look-back.html", key: "lb_name", fallback: "Look back", feature: "lookback" },
    {
      page: "clotr-pages/extension-check/extension-check.html",
      key: "ec_name",
      fallback: "Extension check",
      feature: "extcheck",
    },
  ],
};

async function renderWhatsNew() {
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  if (!lastUpdate || lastUpdate.seen) {
    $("whats-new").hidden = true;
    delete $("whats-new").dataset.reopened;
    return;
  }
  await fillWhatsNew(
    lastUpdate.to,
    lastUpdate.from
      ? msg("pp_updatedFrom", "Updated to v$1 (from v$2)", lastUpdate.to, lastUpdate.from)
      : msg("pp_updated", "Updated to v$1", lastUpdate.to),
  );
  delete $("whats-new").dataset.reopened;
  $("whats-new").hidden = false;
}

// Fills the card with one version's notes and pages. Settings reuses it to reopen the notes after Got it.
async function fillWhatsNew(version, title) {
  const minor = version.split(".").slice(0, 2).join(".");
  let notes = [];
  try {
    const log = await (await fetch(chrome.runtime.getURL("changelog.json"))).json();
    const lang = chrome.i18n.getUILanguage().split("-")[0];
    notes = log.translations?.[lang]?.[minor] || log[minor] || [];
  } catch {
    /* the title alone still helps */
  }
  $("whats-new-title").textContent = title;
  $("whats-new-list").replaceChildren(...notes.map((note) => el("li", { textContent: note })));
  $("whats-new-more").dataset.count = String(notes.length);
  $("whats-new-more").hidden = !notes.length;
  whatsNewSummary();
  const doors = (RELEASE_DOORS[`v${minor}`] || []).filter(
    (door) =>
      (!door.feature || FEATURES[door.feature]) &&
      (!IS_SAFARI || door.page !== "clotr-pages/extension-check/extension-check.html"),
  );
  $("whats-new-doors").replaceChildren(
    ...doors.map((door) => {
      const button = el("button", { className: "btn", type: "button", textContent: msg(door.key, door.fallback) });
      button.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(door.page) }));
      return button;
    }),
  );
  $("whats-new-doors").hidden = doors.length === 0;
  return minor;
}

// Settings' What's new button. An update card that hasn't been answered yet is simply brought into view.
// Otherwise the card comes back for this version, already open, just for reading: Got it then closes it
// without writing anything, so lastUpdate stays exactly as it was.
async function reopenWhatsNew() {
  const card = $("whats-new");
  if (card.hidden || card.dataset.reopened) {
    const version = chrome.runtime.getManifest().version;
    const minor = version.split(".").slice(0, 2).join(".");
    await fillWhatsNew(version, msg("pp_whatsNewIn", "What's new in Clotr $1", minor));
    card.dataset.reopened = "1";
    if ($("tq-end")) $("tq-end").hidden = true;
    $("everyday-offer").hidden = true;
    card.hidden = false;
  }
  const more = $("whats-new-more");
  if (!more.hidden) more.open = true;
  card.scrollIntoView({ block: "start" });
  (more.hidden ? $("whats-new-ok") : more.querySelector("summary")).focus();
}
$("settings-whats-new").addEventListener("click", reopenWhatsNew);
$("clotr-version").textContent = `Clotr ${chrome.runtime.getManifest().version}`;

// Only one card shows in the top slot at a time. The end of Tourniquet's 30 days after a scam comes first,
// since it's about this person's own protection, then the one-time offer to use Clotr on email and chat
// apps. What's new only shows once both of those have been answered.
async function renderTopCard() {
  if (showTourniquetEnd()) return;
  if (await showEverydayOffer()) return;
  await renderWhatsNew();
}

// Whether the 30 days after a scam have ended. The background keeps that end in `tourniquetEnded` until
// the person answers here, and a record that's already past its end but the background hasn't noticed yet
// counts the same way.
function tourniquetEndedNow() {
  const ended = Sites.tourniquetEnded(state.tourniquetEnded);
  if (ended) return ended;
  const record = Sites.tourniquetRecord(state.tourniquet);
  const stale = record?.until !== undefined && !Sites.cleanTourniquet(record);
  return stale ? { since: record.since, at: record.until } : null;
}
function showTourniquetEnd() {
  const show = Boolean(tourniquetEndedNow());
  if ($("tq-end")) $("tq-end").hidden = !show;
  if (show) $("everyday-offer").hidden = $("whats-new").hidden = true;
  return show;
}
// Each answer closes the card for good, whether it's 30 more days, switching to the grown-up's Tourniquet
// with no end, or just Got it. None of them need the PIN, since they only ever add protection or change
// nothing at all.
async function answerTourniquetEnd(next) {
  const hadFocus = $("tq-end").contains(document.activeElement);
  const record = Sites.tourniquetRecord(state.tourniquet);
  const stale = record?.until !== undefined && !Sites.cleanTourniquet(record);
  if (next) await chrome.storage.local.set({ tourniquet: next });
  await chrome.storage.local.remove(next || !stale ? ["tourniquetEnded"] : ["tourniquetEnded", "tourniquet"]);
  state.tourniquetEnded = null;
  if (next || stale) state.tourniquet = next;
  $("tq-end").hidden = true;
  renderAll();
  await renderTopCard();
  if (hadFocus) {
    (
      [
        $("everyday-offer").querySelector("button"),
        $("whats-new-more").querySelector("summary"),
        $("whats-new-ok"),
      ].find((node) => node?.checkVisibility()) || $("tab-overview")
    ).focus();
  }
}
$("tq-end-more")?.addEventListener("click", () => answerTourniquetEnd(Sites.afterScam(Date.now())));
$("tq-end-adult")?.addEventListener("click", () => answerTourniquetEnd({ for: "adult", since: Date.now() }));
$("tq-end-ok")?.addEventListener("click", () => answerTourniquetEnd(null));

let offerMounted = false;
async function showEverydayOffer() {
  const { everydayOffer } = await chrome.storage.local.get("everydayOffer");
  if (everydayOffer !== "popup" || isLocked()) return false;
  const { origins = [] } = await chrome.permissions.getAll();
  const listed = await Sites.userSitePatterns();
  if (Sites.grantedEverydayApps(listed).length || Sites.coveredByEverywhere(Sites.EVERYDAY_SITES, origins).length) {
    // One was switched on another way in the meantime, or Everywhere I type covers them: the offer has done
    // its job.
    await chrome.storage.local.set({ everydayOffer: "done" });
    return false;
  }
  if (!offerMounted) {
    offerMounted = true;
    await globalThis.ClotrEverydayOffer.mount($("everyday-offer"), {
      onAnswer: closeEverydayOffer,
      // A switch-off waits on storage before the browser hands the site back, so the popup only closes for a
      // click that just switches apps on.
      afterAsk: (names) => {
        if (leavesForQuestion(Sites.everydayOrigins(names))) window.close();
      },
    });
  }
  $("whats-new").hidden = true;
  $("everyday-offer").hidden = false;
  return true;
}

// Answered (the browser said yes or no, or No thanks): the card goes for good, and "what's new" takes its
// place.
async function closeEverydayOffer(yes) {
  const hadFocus = $("everyday-offer").contains(document.activeElement);
  $("everyday-offer").hidden = true;
  if (yes) refreshSites();
  await renderWhatsNew();
  if (hadFocus) {
    [$("whats-new-more").querySelector("summary"), $("whats-new-ok")].find((node) => node.checkVisibility())?.focus();
  }
}
$("ev-no").addEventListener("click", () => {
  chrome.storage.local.set({ everydayOffer: "done" }).catch(() => {});
  closeEverydayOffer(false);
});

$("whats-new-ok").addEventListener("click", async () => {
  const card = $("whats-new");
  if (card.dataset.reopened) {
    // Reopened from Settings: closing it puts back whatever card it covered, and marks nothing seen.
    card.hidden = true;
    delete card.dataset.reopened;
    await renderTopCard();
    return;
  }
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  await chrome.storage.local.set({ lastUpdate: { ...lastUpdate, seen: true } });
  card.hidden = true;
});

async function loadBuiltInTools() {
  try {
    return await (await fetch(chrome.runtime.getURL("ai-sites.json"))).json();
  } catch (error) {
    console.warn("[Clotr] could not read ai-sites.json", error);
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
    grants: (await chrome.permissions.getAll()).origins || [],
    everywhereOn: Sites.everywhereGranted((await chrome.permissions.getAll()).origins),
    builtInTools: await loadBuiltInTools(),
    siteKinds: stored.siteKinds || {},
    siteScopes: stored.siteScopes || {},
    tourniquet: stored.tourniquet || null,
    tourniquetEnded: stored.tourniquetEnded || null,
    tourniquetSeen: stored.tourniquetSeen ?? null,
  };
  firefoxPanel = await isFirefoxPanel();
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

$("advanced").addEventListener("change", (event) => chrome.storage.local.set({ advanced: event.target.checked }));

// The browser's name, for Clotr for Windows' list of connected browsers.
function connectingBrowserName() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Firefox")) return "Firefox";
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Vivaldi")) return "Vivaldi";
  if (userAgent.includes("OPR/")) return "Opera";
  if (navigator.brave) return "Brave";
  return "Chrome";
}

if (FEATURES.oneclotr) {
  const oneClotrPlatform = navigator.userAgentData?.platform || navigator.platform;
  $("one-clotr").hidden = !/^Win/i.test(oneClotrPlatform);

  $("one-clotr-connect").addEventListener("click", async () => {
    const status = $("one-clotr-state");
    status.textContent = msg("oc_waiting", "Waiting for you to say yes in Clotr for Windows…");
    try {
      const result = await Clotr.OneClotrBridge.connectFromClick(connectingBrowserName());
      if (result.type !== "connected") {
        status.textContent = msg(
          result.type === "waiting" ? "oc_waiting" : "oc_notInstalled",
          result.type === "waiting"
            ? "Waiting for you to say yes in Clotr for Windows…"
            : "Clotr for Windows isn't installed yet",
        );
        return;
      }
      const current = await chrome.storage.local.get([
        ...Clotr.OneClotrProtocol.SETTINGS,
        "oneClotrMeta",
        "oneClotrPaired",
      ]);
      const remote = await Clotr.OneClotrBridge.readSettings();
      const now = Date.now();
      const { set, remove } = Clotr.OneClotrProtocol.apply(current, remote, now);
      await chrome.storage.local.set({ ...set, oneClotrPaired: true });
      if (remove.length) await chrome.storage.local.remove(remove);
      await Clotr.OneClotrBridge.writeSettings(Clotr.OneClotrProtocol.settingsForWrite(current, remote, now));
      status.textContent = msg("oc_connected", "Connected to Clotr for Windows");
      $("one-clotr-connect").hidden = true;
      $("one-clotr-disconnect").hidden = false;
    } catch (error) {
      status.textContent =
        error?.message === "not_running"
          ? msg("oc_notRunning", "Open Clotr for Windows to connect your browser.")
          : msg("oc_notInstalled", "Clotr for Windows isn't installed yet");
    }
  });

  $("one-clotr-disconnect").addEventListener("click", async () => {
    try {
      await Clotr.OneClotrBridge.disconnect();
    } catch {
      await chrome.permissions.remove({ permissions: ["nativeMessaging"] }).catch(() => {});
    }
    await chrome.storage.local.set({ oneClotrPaired: false });
    $("one-clotr-state").textContent = msg("oc_notConnected", "Not connected to Clotr for Windows");
    $("one-clotr-connect").hidden = false;
    $("one-clotr-disconnect").hidden = true;
  });

  chrome.storage.local.get(["oneClotrPaired"]).then(({ oneClotrPaired }) => {
    if (oneClotrPaired) {
      $("one-clotr-state").textContent = msg("oc_connected", "Connected to Clotr for Windows");
      $("one-clotr-connect").hidden = true;
      $("one-clotr-disconnect").hidden = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.oneClotrPaired) return;
    const paired = changes.oneClotrPaired.newValue === true;
    $("one-clotr-state").textContent = msg(
      paired ? "oc_connected" : "oc_notConnected",
      paired ? "Connected to Clotr for Windows" : "Not connected to Clotr for Windows",
    );
    $("one-clotr-connect").hidden = paired;
    $("one-clotr-disconnect").hidden = !paired;
  });
}

$("tips-again").addEventListener("click", async () => {
  await chrome.storage.local.remove(["guided", "picturesNoted"]); // the "can't read pictures" note too
  $("tips-again").textContent = msg("pp_tipsAgain", "Tips will show again");
});

init();
