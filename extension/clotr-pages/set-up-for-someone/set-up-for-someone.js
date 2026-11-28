// Guided setup for helping someone, with Tourniquet. The first step asks who it's for: a child or teen and
// a grown-up get Tourniquet's steps (turn it on, their details, their email and chat apps, a PIN), and
// "choose each setting yourself" gets the four steps from before. Same storage and the same PIN rules
// (sites-and-policy/helping-someone.js): when a PIN is set and not unlocked in the last 10 minutes, or an organization manages
// Clotr, the steps stay hidden.
// Turning Tourniquet on writes one record, `tourniquet: { for, since }`, and nothing else of the person's
// settings. The third choice, someone who was just scammed (Scam Shield), is the grown-up's steps for 30
// days: the record carries its end (`until`), step 2 shows a 30-day track and What to do now, and the
// background ends it by itself.
"use strict";

const { msg, Helper } = globalThis.Clotr;
const Sites = globalThis.ClotrSites;
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
// Which held-back features this build ships (`clotr_features` in manifest.json).
const FEATURES = chrome.runtime.getManifest().clotr_features || {};
let lock = null;
let managed = false;
let unlockedUntil = 0;
let wrongTries = 0;
let retryAt = 0;
let tourniquet = null; // the stored record, cleaned (null: off)
let vault = [];
let offer = null; // the email and chat apps card, once it's ready

// ---------- Page parts and words ----------

function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  node.append(...children);
  return node;
}

// The tile chosen in the first step, or null.
function chosen() {
  return document.querySelector('#who input[name="who"]:checked')?.value || null;
}

function isPreset(who) {
  return who === "child" || who === "adult" || who === "after_scam";
}

// A date in the browser's own words.
function dateWords(time, options) {
  try {
    return new Date(time).toLocaleDateString(chrome.i18n.getUILanguage(), options);
  } catch {
    return new Date(time).toDateString();
  }
}

function day(time) {
  return dateWords(time, { dateStyle: "long" });
}

// "2 October", the browser's own way: the 30 days' dates, as the popup says them.
function shortDay(time) {
  return dateWords(time, { day: "numeric", month: "long" });
}

// ---------- What each preset changes ----------
// The map's two branches (sites-and-policy/protected-sites.js holds the rules themselves).

const MAP = {
  child: () => [
    {
      kind: "asks",
      title: msg("hp_tqAsks", "Asks before sending"),
      leaves: [
        msg("hp_tqLeafNames", "Their name and family names"),
        msg("hp_tqLeafHome", "Home address and phone"),
        msg("hp_tqLeafOnline", "Email and birthday"),
        msg("hp_tqLeafCardIds", "Card and ID numbers"),
        msg("hp_tqLeafCodes", "Passwords and sign-in codes"),
      ],
    },
    {
      kind: "words",
      title: msg("hp_tqWords", "Also asks about words you add"),
      leaves: [msg("hp_tqLeafSchool", "Their school"), msg("hp_tqLeafTeam", "Their team or club")],
    },
  ],
  adult: () => [
    {
      kind: "asks",
      title: msg("hp_tqAsks", "Asks before sending"),
      leaves: [
        msg("hp_tqLeafCodes", "Passwords and sign-in codes"),
        msg("hp_tqLeafCards", "Card and bank numbers"),
        msg("hp_tqLeafIds", "Social Security, Medicare, passport"),
        msg("hp_tqLeafBirthday", "Their birthday"),
      ],
    },
    {
      kind: "notes",
      title: msg("hp_tqNotes", "A bigger note in the corner"),
      leaves: [
        msg("hp_tqLeafNames", "Their name and family names"),
        msg("hp_tqLeafContact", "Phone, address and email"),
      ],
    },
  ],
};
// Row heights in the list (clotr-pages/set-up-for-someone/set-up-for-someone.css keeps them fixed while the drawing shows), so the lines can be drawn
// from the numbers alone, in any language.
const ROW = 28;
const HEAD = 24;
const GAP = 14;
const ART = 200; // the drawing's width

// Clotr's plaster (the welcome page's mark), on a detail Clotr asks about; a plain dot on one it only
// points out.
function plaster() {
  return svg("svg", { class: "tq-bullet", viewBox: "-12 -12 24 24", "aria-hidden": "true", focusable: "false" }, [
    svg("g", { transform: "rotate(-35)" }, [
      svg("rect", { class: "tq-p-edge", x: -6.5, y: -11, width: 13, height: 22, rx: 6.5 }),
      svg("rect", { class: "tq-p-strip", x: -4.2, y: -8.8, width: 8.4, height: 17.6, rx: 4.2 }),
      svg("rect", { class: "tq-p-pad", x: -2.2, y: -3.2, width: 4.4, height: 6.4, rx: 1.3 }),
    ]),
  ]);
}
function dot() {
  return svg("svg", { class: "tq-bullet", viewBox: "-12 -12 24 24", "aria-hidden": "true", focusable: "false" }, [
    svg("circle", { class: "tq-dot", r: 4.5 }),
  ]);
}

// Words the helper added for Clotr to watch (their school, their team): the child preset's second branch
// is dotted until there are some.
function hasWords() {
  return vault.some((entry) => entry.type === "watch_list" || (entry.type === "employer" && entry.kind === "word"));
}

// A branch's own leaves, as a list named by its heading.
function leafList(group, groupIndex) {
  const items = group.leaves.map((text, index) =>
    el("li", { style: `--i: ${index}` }, [
      group.kind === "notes" ? dot() : plaster(),
      el("span", { textContent: text }),
    ]),
  );
  const list = el("ul", {}, items);
  list.setAttribute("aria-labelledby", `tq-branch-${groupIndex}`);
  return list;
}

// The list beside the drawing: a heading and its leaves per branch.
function mapList(groups, words) {
  return groups.map((group, groupIndex) => {
    const waiting = group.kind === "words" && !words ? " waiting" : "";
    return el("div", { className: `tq-group ${group.kind}${waiting}` }, [
      el("h3", { className: "tq-branch", id: `tq-branch-${groupIndex}`, textContent: group.title }),
      leafList(group, groupIndex),
    ]);
  });
}

// Each branch's rows' middles and its own middle, from the fixed row heights.
function branchPlaces(groups) {
  let y = 0;
  const places = groups.map((group) => {
    const top = y + HEAD;
    const rows = group.leaves.map((_, index) => top + ROW * index + ROW / 2);
    y = top + ROW * group.leaves.length + GAP;
    return { group, rows, at: top + (ROW * group.leaves.length) / 2 };
  });
  return { places, height: y - GAP };
}

// One branch's lines: a trunk from "Them", a twig to each row, and the branch's node.
function branchPaths({ group, rows, at }, groupIndex, them, words) {
  const nodeX = 136;
  const waiting = group.kind === "words" && !words;
  const className = `tq-wire ${group.kind}${waiting ? " waiting" : ""}`;
  // A drawn line is measured as 1 long, for the drawing-in; a dotted one keeps its own length, for even dots.
  const length = waiting ? {} : { pathLength: 1 };
  const paths = [
    svg("path", {
      class: `${className} trunk`,
      style: `--i: ${groupIndex}`,
      ...length,
      d: `M${them.x} ${them.y} C${them.x + 34} ${them.y} ${nodeX - 38} ${at} ${nodeX} ${at}`,
    }),
  ];
  for (const [index, rowY] of rows.entries()) {
    paths.push(
      svg("path", {
        class: `${className} twig`,
        style: `--i: ${groupIndex * 3 + index}`,
        ...length,
        d: `M${nodeX} ${at} C${nodeX + 32} ${at} ${ART - 34} ${rowY} ${ART - 6} ${rowY}`,
      }),
    );
  }
  paths.push(svg("circle", { class: `tq-node ${group.kind}${waiting ? " waiting" : ""}`, cx: nodeX, cy: at, r: 6 }));
  return paths;
}

let drawn = ""; // the map on screen: drawn again (and so animated again) only when it changes
function drawMap(who) {
  const words = hasWords();
  $("tq-words-hint").hidden = who !== "child" || words;
  if (drawn === `${who} ${words}`) return;
  drawn = `${who} ${words}`;
  const groups = MAP[who]();
  $("tq-map-list").replaceChildren(...mapList(groups, words));

  // The lines: "Them" in the middle on the left, a branch node beside each group's rows, a curve to each row.
  const { places, height } = branchPlaces(groups);
  const middle = (places[0].at + places.at(-1).at) / 2;
  const them = { x: 66, y: middle };
  const paths = places.flatMap((place, groupIndex) => branchPaths(place, groupIndex, them, words));
  const lines = document.querySelector(".tq-map-lines");
  lines.setAttribute("viewBox", `0 0 ${ART} ${height}`);
  lines.setAttribute("height", String(height));
  lines.replaceChildren(...paths);
  document.querySelector(".tq-them").style.top = `${them.y}px`;
  $("tq-map").style.setProperty("--map-h", `${height}px`);
}

// ---------- The page, per choice ----------

function tryLineWords(who) {
  if (who === "child") {
    return msg(
      "hp_tqTryChild",
      "Try it together: in an AI chat or a chat app, type “I live at 12 Oak Street”. Clotr asks before it goes out.",
    );
  }
  if (who === "adult" || who === "after_scam") {
    return msg(
      "hp_tqTryAdult",
      "Try it together: in an AI chat or their email, type “my password is Tulip123”. Clotr asks before it goes out.",
    );
  }
  return msg("hp_tryItTogether", "Try it together: open an AI chat and type a made-up phone number.");
}

function whatChangesWords(who) {
  if (who === "after_scam") {
    return msg(
      "hp_tqWhatAfterScam",
      "For 30 days, Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out, everywhere it's on. Its warnings are bigger, and every message is still theirs to send.",
    );
  }
  if (who === "child") {
    return msg(
      "hp_tqWhatChild",
      "Here's what changes: Clotr asks before any of these go out, and its warnings no longer offer ways to warn less. Their own settings stay underneath, as they were.",
    );
  }
  return msg(
    "hp_tqWhatAdult",
    "Here's what changes: Clotr asks before the first group goes out and always points out the second, in bigger warnings. Its warnings no longer offer ways to warn less. Their own settings stay underneath, as they were.",
  );
}

function pinWords(who) {
  if (who === "child") {
    return msg(
      "hp_tqPinChild",
      "Keep the PIN yourself. Turning Tourniquet off or changing Clotr's settings then needs it, but sending, hiding a detail or clearing their own history doesn't.",
    );
  }
  return msg(
    "hp_tqPinAdult",
    "Pick the PIN together and write it down for them. Turning Tourniquet off or changing Clotr's settings then needs it, but sending, hiding a detail or clearing their own history doesn't.",
  );
}

function showFor(who) {
  for (const part of document.querySelectorAll("[data-for]")) {
    part.hidden = !who || !part.dataset.for.split(" ").includes(who);
  }
  document.body.dataset.who = who || "";
  if (!who) return;
  const scam = who === "after_scam"; // the grown-up's steps, for 30 days
  $("try-line").textContent = tryLineWords(who);
  if (!isPreset(who)) return;
  $("tq-title").textContent = scam
    ? msg("hp_tqTurnOnAfterScamTitle", "Turn on Tourniquet for 30 days")
    : msg("hp_tqTurnOnTitle", "Turn on Tourniquet");
  $("tq-what").textContent = whatChangesWords(who);
  $("pin-text").textContent = pinWords(who);
  if (!scam) drawMap(who);
  renderTourniquet();
}

// The 30 days as a track: one mark per day, the days gone filled and today outlined (a picture only: the
// words beside it say the same). Before it's turned on, today is the first day and the end is 30 days out.
function dayClass(dayNumber, today) {
  if (dayNumber < today) return "gone";
  if (dayNumber === today) return "today";
  return "";
}

function renderDays() {
  const now = Date.now();
  const running = tourniquet?.for === "after_scam" ? tourniquet : null;
  const shown = running || Sites.afterScam(now);
  const { day: today, of } = Sites.tourniquetDay(shown, now);
  const marks = Array.from({ length: of }, (_, index) => el("span", { className: dayClass(index + 1, today) }));
  $("tq-days")
    .querySelector(".tq-track")
    .replaceChildren(...marks);
  $("tq-days-start").textContent = running
    ? msg("pp_tqDay", "Day $1 of $2", today, of)
    : msg("hp_tqToday", "Today, $1", shortDay(now));
  $("tq-days-end").textContent = msg("pp_tqStepsDown", "Steps down on $1", shortDay(shown.until));
}

// Step 2's button: turn it on, or switch to this preset from the one that's on.
function onButtonWords(who) {
  if (!tourniquet) {
    if (who === "after_scam") return msg("hp_tqTurnOnAfterScam", "Turn on for 30 days");
    return msg("hp_tqTurnOn", "Turn on Tourniquet");
  }
  if (who === "child") return msg("hp_tqSwitchToChild", "Switch to Tourniquet for a child");
  if (who === "adult") return msg("hp_tqSwitchToAdult", "Switch to Tourniquet for a grown-up");
  return msg("hp_tqSwitchToAfterScam", "Switch to Tourniquet for 30 days after a scam");
}

// Since when the stored Tourniquet is on, in its own words.
function stateWords() {
  if (!tourniquet) return "";
  if (tourniquet.for === "child") {
    return msg("hp_tqIsOnChild", "Tourniquet is on for a child, since $1.", day(tourniquet.since));
  }
  if (tourniquet.for === "adult") {
    return msg("hp_tqIsOnAdult", "Tourniquet is on for a grown-up, since $1.", day(tourniquet.since));
  }
  return msg(
    "hp_tqIsOnAfterScam",
    "Tourniquet is on for 30 days after a scam: day $1 of 30, steps down on $2.",
    Sites.tourniquetDay(tourniquet).day,
    shortDay(tourniquet.until),
  );
}

// Step 2's button and state: turn it on, switch to the other preset, or say since when it's on (and offer
// off).
function renderTourniquet() {
  const who = chosen();
  if (!isPreset(who)) return;
  const here = tourniquet?.for === who;
  if (who === "after_scam") renderDays();
  $("tq-on").hidden = here;
  $("tq-on").textContent = onButtonWords(who);
  $("tq-off").hidden = !tourniquet;
  const text = stateWords();
  // A live region: written only when it changes, so other updates on the page don't read it out again.
  if (tourniquet && $("tq-state").textContent !== text) {
    $("tq-state").classList.add("on");
    $("tq-state").replaceChildren(
      svg("svg", { class: "tq-shield", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" }, [
        svg("path", { d: "M8 1 14 3.4V8c0 3.4-2.5 6.1-6 7-3.5-.9-6-3.6-6-7V3.4Z" }),
      ]),
      text,
    );
  } else if (!tourniquet && $("tq-state").classList.contains("on")) {
    $("tq-state").classList.remove("on");
    $("tq-state").textContent = "";
  }
}

// ---------- The PIN and the page's state ----------

function isLocked() {
  return managed || (Boolean(lock) && Date.now() >= unlockedUntil);
}

// The 10 minutes can run out while the page is open: it locks itself then, and every change checks the
// time again first (another page may have unlocked or locked it since), showing the PIN box instead when
// it's up.
let relock = null;
async function stillUnlocked() {
  unlockedUntil = await Helper.unlockedUntil();
  if (!isLocked()) return true;
  await render();
  return false;
}

async function render() {
  const stored = await chrome.storage.local.get(["largeText", "responses", "lock", "vault", "tourniquet"]);
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  managed = policy.lockSettings === true;
  lock = stored.lock || null;
  tourniquet = Sites.cleanTourniquet(stored.tourniquet);
  vault = Array.isArray(stored.vault) ? stored.vault : [];
  unlockedUntil = await Helper.unlockedUntil();
  const locked = isLocked();
  clearTimeout(relock);
  if (!locked && lock) relock = setTimeout(render, unlockedUntil - Date.now());
  $("managed-note").hidden = !managed;
  $("unlock").hidden = !locked || managed; // an organization's lock has no PIN
  $("steps").hidden = locked;
  $("setup-end").hidden = locked;
  // Opened with Tourniquet on: start at its preset, so turning it off or switching is right there.
  // Tourniquet held back but an earlier build's record is still in storage: its own tiles are gone, so
  // there's nothing to check and nothing to show for it; "self" stays the only choice on screen.
  const tourniquetTile = tourniquet && document.querySelector(`#who input[value="${tourniquet.for}"]`);
  if (!chosen() && tourniquetTile) {
    tourniquetTile.checked = true;
    showFor(tourniquet.for);
  } else if (isPreset(chosen())) {
    if (chosen() !== "after_scam") drawMap(chosen());
    renderTourniquet();
  }
  $("large-text").checked = Boolean(stored.largeText);
  $("strict-personal").checked = Helper.asksBeforePersonal(stored.responses);
  $("vault-count").textContent = vault.length ? msg("hp_detailsSaved", "$1 saved so far", vault.length) : "";
  // Details marked OK to share (on the vault page, or from a chat before Tourniquet) are still honoured:
  // say so.
  const shared = vault.filter((entry) => entry.mode === "allow").length;
  $("vault-share").hidden = !shared || !isPreset(chosen());
  $("vault-share-text").textContent =
    shared === 1
      ? msg("hp_tqShareOne", "1 detail is marked OK to share, so Clotr doesn't warn about it.")
      : msg("hp_tqShareMany", "$1 details are marked OK to share, so Clotr doesn't warn about them.", shared);
  $("lock-set").textContent = lock ? msg("pp_changePin", "Change the PIN") : msg("popup_lockSettings", "Lock settings");
}

// ---------- Choices and buttons ----------

$("who").addEventListener("change", () => {
  const who = chosen();
  showFor(who);
  if (isPreset(who)) offer?.tick(Sites.TOURNIQUET[who].apps);
  render();
});

// Turning it on, or switching: one record, and the first-time tips start again so each kind Tourniquet
// holds gets its one-line explanation. The person's own responses, larger warnings and site modes stay as
// they are underneath.
$("tq-on")?.addEventListener("click", async () => {
  const who = chosen();
  if (!isPreset(who)) return;
  disarmOff();
  if (!(await stillUnlocked())) return;
  // After a scam: 30 days from now, the end in the record (the background ends it: sites-and-policy/tourniquet-rules.js tourniquetStep).
  const record = who === "after_scam" ? Sites.afterScam(Date.now()) : { for: who, since: Date.now() };
  await chrome.storage.local.set({ tourniquet: record });
  await chrome.storage.local.remove("guided");
});

// Off takes two clicks; the email and chat apps stay on (they're the person's sites now).
const OFF_ARM_MS = 4000;
let offArmed = null;
function disarmOff() {
  clearTimeout(offArmed);
  offArmed = null;
  $("tq-off").textContent = msg("hp_tqTurnOff", "Turn it off");
  $("tq-off").classList.remove("confirm");
}
$("tq-off")?.addEventListener("click", async () => {
  if (!offArmed) {
    $("tq-off").textContent = msg("hp_tqTurnOffAgain", "Click again to turn it off");
    $("tq-off").classList.add("confirm");
    offArmed = setTimeout(disarmOff, OFF_ARM_MS);
    return;
  }
  disarmOff();
  if (!(await stillUnlocked())) return;
  await chrome.storage.local.remove("tourniquet");
  $("tq-state").classList.remove("on");
  $("tq-state").textContent = msg(
    "hp_tqTurnedOff",
    "Tourniquet is off, and their own settings are as they were. The email and chat apps stay on until you switch them off in Settings.",
  );
});

// The doors to Clotr's other pages. The last four are optional: a build can leave their pages out.
const DOORS = [
  ["open-vault", "clotr-pages/vault/vault.html"],
  ["review-share", "clotr-pages/vault/vault.html#vault-list"],
  ["open-share", "clotr-pages/share-clotr/share-clotr.html"],
];
// The card for next to their phone (the Share page, at the card), Clotr Antibody's two pages (a second
// opinion on a message, and the six made-up scams to answer together), and the office training
// walkthrough for a team to run on their own.
const OPTIONAL_DOORS = [
  ["open-card", "clotr-pages/share-clotr/share-clotr.html#card"],
  ["open-check", "clotr-pages/scam-check/scam-check.html"],
  ["open-practice", "clotr-pages/practice/practice.html"],
  ["open-training", "clotr-pages/office-training/office-training.html"],
];
for (const [id, page] of DOORS) {
  $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
}
for (const [id, page] of OPTIONAL_DOORS) {
  $(id)?.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
}
// Held back features get no door here, and no element in the shipped build to hide either.
if ($("tq-tiles")) $("tq-tiles").hidden = !FEATURES.tourniquet;
if ($("open-card-row")) $("open-card-row").hidden = !FEATURES.scamcheck;
if ($("open-check")) $("open-check").hidden = !FEATURES.scamcheck;
if ($("open-practice")) $("open-practice").hidden = !FEATURES.practice;
if ($("open-training")) $("open-training").hidden = !FEATURES.training;
$("after-share-row").hidden = !FEATURES.scamcheck && !FEATURES.practice && !FEATURES.training;
// Extension check: Safari has no management API, so its build drops the page; hide the line here too.
const isSafari = Boolean(chrome.runtime.getManifest().browser_specific_settings?.safari);
if ($("ext-check-line") && (!FEATURES.extcheck || isSafari)) $("ext-check-line").hidden = true;
$("large-text").addEventListener("change", async (event) => {
  if (await stillUnlocked()) await chrome.storage.local.set({ largeText: event.target.checked });
});
$("strict-personal").addEventListener("change", async (event) => {
  if (await stillUnlocked()) await Helper.setAskBeforePersonal(event.target.checked);
});
$("lock-set").addEventListener("click", async () => {
  if (!(await stillUnlocked())) return;
  const pin = $("pin").value.trim();
  if (!Helper.validPin(pin)) {
    say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
    return;
  }
  const next = await Helper.makeLock(pin);
  unlockedUntil = await Helper.markUnlocked(); // you set it, so you stay in for now
  await chrome.storage.local.set({ lock: next });
  $("pin").value = "";
  say("lock-msg", msg("pp_locked", "Settings locked. Clotr will ask for the PIN next time."));
});

// Five wrong PINs in a row wait half a minute.
const MAX_WRONG_TRIES = 5;
const RETRY_WAIT_MS = 30000;

async function tryUnlock() {
  if (Date.now() < retryAt) {
    say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
    return;
  }
  const matches = await Helper.pinMatches($("unlock-pin").value.trim(), lock);
  $("unlock-pin").value = "";
  if (!matches) {
    if (++wrongTries >= MAX_WRONG_TRIES) {
      retryAt = Date.now() + RETRY_WAIT_MS;
      wrongTries = 0;
    }
    say("unlock-msg", msg("pp_wrongPin", "That PIN didn't match."), true);
    return;
  }
  wrongTries = 0;
  say("unlock-msg", "");
  await Helper.markUnlocked();
  render();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (event) => {
  if (event.key === "Enter") tryUnlock();
});

// ---------- Start ----------

// Details added in the vault tab, or settings changed in the popup, show up here too, and so does the PIN
// being entered (or the 10 minutes ending) on another page.
const WATCHED_KEYS = ["largeText", "responses", "lock", "vault", "tourniquet"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && WATCHED_KEYS.some((key) => key in changes)) render();
  if (area === "session" && "unlockedUntil" in changes) render();
});

(async () => {
  // From a link that already knows the answer (clotr-pages/set-up-for-someone/set-up-for-someone.html?for=after_scam, from Is this a scam? or the
  // popup): that choice is made, so the person lands on its steps.
  const asked = new URLSearchParams(location.search).get("for");
  const tile = asked === "after_scam" && document.querySelector('#who input[value="after_scam"]');
  if (tile) {
    tile.checked = true;
    showFor("after_scam");
  }
  await render();
  // The apps step: the shared card, its ask in the click's own turn (page-parts/email-and-chat-offer.js), the preset's apps
  // ticked.
  offer = await globalThis.ClotrEverydayOffer.mount($("step-apps")).catch(() => null);
  if (isPreset(chosen())) offer?.tick(Sites.TOURNIQUET[chosen()].apps);
  // From the welcome page's line (clotr-pages/set-up-for-someone/set-up-for-someone.html#who): straight to the question.
  if (location.hash === "#who") {
    $("who").scrollIntoView({ block: "start" });
    (
      document.querySelector('#who input[name="who"]:checked') || document.querySelector('#who input[name="who"]')
    ).focus();
  }
})();
