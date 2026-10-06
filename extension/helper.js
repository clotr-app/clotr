// Guided setup for helping someone, with Tourniquet. The first step asks who it's for: a child or
// teen and a grown-up get Tourniquet's steps (turn it on, their details, their email and chat apps, a PIN), and "choose
// each setting yourself" gets the four steps from before. Same storage and the same PIN rules (helper-core.js): when a
// PIN is set and not unlocked in the last 10 minutes, or an organization manages Clotr, the steps stay hidden.
// Turning Tourniquet on writes one record, `tourniquet: { for, since }`, and nothing else of the person's settings.
// The third choice, someone who was just scammed (Scam Shield), is the grown-up's steps for 30 days: the record carries
// its end (`until`), step 2 shows a 30-day track and What to do now, and the background ends it by itself.
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

const say = (id, text, error = false) => {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
};
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}
const chosen = () => document.querySelector('#who input[name="who"]:checked')?.value || null;
const isPreset = (who) => who === "child" || who === "adult" || who === "after_scam";
const day = (t) => {
  try {
    return new Date(t).toLocaleDateString(chrome.i18n.getUILanguage(), { dateStyle: "long" });
  } catch {
    return new Date(t).toDateString();
  }
};
// "2 October", the browser's own way: the 30 days' dates, as the popup says them.
const shortDay = (t) => {
  try {
    return new Date(t).toLocaleDateString(chrome.i18n.getUILanguage(), { day: "numeric", month: "long" });
  } catch {
    return new Date(t).toDateString();
  }
};

// ---------- What each preset changes: the map's two branches (sites.js holds the rules themselves) ----------

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
// Row heights in the list (helper.css keeps them fixed while the drawing shows), so the lines can be drawn from the
// numbers alone, in any language.
const ROW = 28;
const HEAD = 24;
const GAP = 14;
const ART = 200; // the drawing's width

// Clotr's plaster (the welcome page's mark), on a detail Clotr asks about; a plain dot on one it only points out.
function plaster() {
  return svg("svg", { class: "tq-bullet", viewBox: "-12 -12 24 24", "aria-hidden": "true", focusable: "false" }, [
    svg("g", { transform: "rotate(-35)" }, [
      svg("rect", { class: "tq-p-edge", x: -6.5, y: -11, width: 13, height: 22, rx: 6.5 }),
      svg("rect", { class: "tq-p-strip", x: -4.2, y: -8.8, width: 8.4, height: 17.6, rx: 4.2 }),
      svg("rect", { class: "tq-p-pad", x: -2.2, y: -3.2, width: 4.4, height: 6.4, rx: 1.3 }),
    ]),
  ]);
}
const dot = () =>
  svg("svg", { class: "tq-bullet", viewBox: "-12 -12 24 24", "aria-hidden": "true", focusable: "false" }, [
    svg("circle", { class: "tq-dot", r: 4.5 }),
  ]);

// Words the helper added for Clotr to watch (their school, their team): the child preset's second branch is dotted
// until there are some.
const hasWords = () => vault.some((e) => e.type === "watch_list" || (e.type === "employer" && e.kind === "word"));

let drawn = ""; // the map on screen: drawn again (and so animated again) only when it changes
function drawMap(who) {
  const words = hasWords();
  $("tq-words-hint").hidden = who !== "child" || words;
  if (drawn === `${who} ${words}`) return;
  drawn = `${who} ${words}`;
  const groups = MAP[who]();
  const list = groups.map((g, gi) =>
    el("div", { className: `tq-group ${g.kind}${g.kind === "words" && !words ? " waiting" : ""}` }, [
      el("h3", { className: "tq-branch", id: `tq-branch-${gi}`, textContent: g.title }),
      (() => {
        const ul = el(
          "ul",
          {},
          g.leaves.map((text, i) =>
            el("li", { style: `--i: ${i}` }, [
              g.kind === "notes" ? dot() : plaster(),
              el("span", { textContent: text }),
            ]),
          ),
        );
        ul.setAttribute("aria-labelledby", `tq-branch-${gi}`);
        return ul;
      })(),
    ]),
  );
  $("tq-map-list").replaceChildren(...list);

  // The lines: "Them" in the middle on the left, a branch node beside each group's rows, a curve to each row.
  let y = 0;
  const nodes = groups.map((g) => {
    const top = y + HEAD;
    const rows = g.leaves.map((_, i) => top + ROW * i + ROW / 2);
    y = top + ROW * g.leaves.length + GAP;
    return { g, rows, at: top + (ROW * g.leaves.length) / 2 };
  });
  const height = y - GAP;
  const mid = (nodes[0].at + nodes.at(-1).at) / 2;
  const them = { x: 66, y: mid };
  const nodeX = 136;
  const paths = [];
  nodes.forEach(({ g, rows, at }, gi) => {
    const waiting = g.kind === "words" && !words;
    const cls = `tq-wire ${g.kind}${waiting ? " waiting" : ""}`;
    // A drawn line is measured as 1 long, for the drawing-in; a dotted one keeps its own length, for even dots.
    const length = waiting ? {} : { pathLength: 1 };
    paths.push(
      svg("path", {
        class: `${cls} trunk`,
        style: `--i: ${gi}`,
        ...length,
        d: `M${them.x} ${them.y} C${them.x + 34} ${them.y} ${nodeX - 38} ${at} ${nodeX} ${at}`,
      }),
    );
    rows.forEach((ry, i) =>
      paths.push(
        svg("path", {
          class: `${cls} twig`,
          style: `--i: ${gi * 3 + i}`,
          ...length,
          d: `M${nodeX} ${at} C${nodeX + 32} ${at} ${ART - 34} ${ry} ${ART - 6} ${ry}`,
        }),
      ),
    );
    paths.push(svg("circle", { class: `tq-node ${g.kind}${waiting ? " waiting" : ""}`, cx: nodeX, cy: at, r: 6 }));
  });
  const lines = document.querySelector(".tq-map-lines");
  lines.setAttribute("viewBox", `0 0 ${ART} ${height}`);
  lines.setAttribute("height", String(height));
  lines.replaceChildren(...paths);
  document.querySelector(".tq-them").style.top = `${them.y}px`;
  $("tq-map").style.setProperty("--map-h", `${height}px`);
}

// ---------- The page, per choice ----------

function showFor(who) {
  for (const n of document.querySelectorAll("[data-for]")) n.hidden = !who || !n.dataset.for.split(" ").includes(who);
  document.body.dataset.who = who || "";
  if (!who) return;
  const scam = who === "after_scam"; // the grown-up's steps, for 30 days
  $("try-line").textContent =
    who === "child"
      ? msg(
          "hp_tqTryChild",
          "Try it together: in an AI chat or a chat app, type “I live at 12 Oak Street”. Clotr asks before it goes out.",
        )
      : who === "adult" || scam
        ? msg(
            "hp_tqTryAdult",
            "Try it together: in an AI chat or their email, type “my password is Tulip123”. Clotr asks before it goes out.",
          )
        : msg("hp_tryItTogether", "Try it together: open an AI chat and type a made-up phone number.");
  if (!isPreset(who)) return;
  $("tq-title").textContent = scam
    ? msg("hp_tqTurnOnAfterScamTitle", "Turn on Tourniquet for 30 days")
    : msg("hp_tqTurnOnTitle", "Turn on Tourniquet");
  $("tq-what").textContent = scam
    ? msg(
        "hp_tqWhatAfterScam",
        "For 30 days, Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out, everywhere it's on. Its warnings are bigger, and every message is still theirs to send.",
      )
    : who === "child"
      ? msg(
          "hp_tqWhatChild",
          "Here's what changes: Clotr asks before any of these go out, and its warnings no longer offer ways to warn less. Their own settings stay underneath, as they were.",
        )
      : msg(
          "hp_tqWhatAdult",
          "Here's what changes: Clotr asks before the first group goes out and always points out the second, in bigger warnings. Its warnings no longer offer ways to warn less. Their own settings stay underneath, as they were.",
        );
  $("pin-text").textContent =
    who === "child"
      ? msg(
          "hp_tqPinChild",
          "Keep the PIN yourself. Turning Tourniquet off or changing Clotr's settings then needs it, but sending, hiding a detail or clearing their own history doesn't.",
        )
      : msg(
          "hp_tqPinAdult",
          "Pick the PIN together and write it down for them. Turning Tourniquet off or changing Clotr's settings then needs it, but sending, hiding a detail or clearing their own history doesn't.",
        );
  if (!scam) drawMap(who);
  renderTourniquet();
}

// The 30 days as a track: one mark per day, the days gone filled and today outlined (a picture only: the words beside
// it say the same). Before it's turned on, today is the first day and the end is 30 days out.
function renderDays() {
  const now = Date.now();
  const running = tourniquet?.for === "after_scam" ? tourniquet : null;
  const t = running || Sites.afterScam(now);
  const { day: today, of } = Sites.tourniquetDay(t, now);
  $("tq-days")
    .querySelector(".tq-track")
    .replaceChildren(
      ...Array.from({ length: of }, (_, i) =>
        el("span", { className: i + 1 < today ? "gone" : i + 1 === today ? "today" : "" }),
      ),
    );
  $("tq-days-start").textContent = running
    ? msg("pp_tqDay", "Day $1 of $2", today, of)
    : msg("hp_tqToday", "Today, $1", shortDay(now));
  $("tq-days-end").textContent = msg("pp_tqStepsDown", "Steps down on $1", shortDay(t.until));
}

// Step 2's button and state: turn it on, switch to the other preset, or say since when it's on (and offer off).
function renderTourniquet() {
  const who = chosen();
  if (!isPreset(who)) return;
  const here = tourniquet?.for === who;
  if (who === "after_scam") renderDays();
  $("tq-on").hidden = here;
  $("tq-on").textContent = !tourniquet
    ? who === "after_scam"
      ? msg("hp_tqTurnOnAfterScam", "Turn on for 30 days")
      : msg("hp_tqTurnOn", "Turn on Tourniquet")
    : who === "child"
      ? msg("hp_tqSwitchToChild", "Switch to Tourniquet for a child")
      : who === "adult"
        ? msg("hp_tqSwitchToAdult", "Switch to Tourniquet for a grown-up")
        : msg("hp_tqSwitchToAfterScam", "Switch to Tourniquet for 30 days after a scam");
  $("tq-off").hidden = !tourniquet;
  const text = !tourniquet
    ? ""
    : tourniquet.for === "child"
      ? msg("hp_tqIsOnChild", "Tourniquet is on for a child, since $1.", day(tourniquet.since))
      : tourniquet.for === "adult"
        ? msg("hp_tqIsOnAdult", "Tourniquet is on for a grown-up, since $1.", day(tourniquet.since))
        : msg(
            "hp_tqIsOnAfterScam",
            "Tourniquet is on for 30 days after a scam: day $1 of 30, steps down on $2.",
            Sites.tourniquetDay(tourniquet).day,
            shortDay(tourniquet.until),
          );
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

async function render() {
  const s = await chrome.storage.local.get(["largeText", "responses", "lock", "vault", "tourniquet"]);
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  managed = policy.lockSettings === true;
  lock = s.lock || null;
  tourniquet = Sites.cleanTourniquet(s.tourniquet);
  vault = Array.isArray(s.vault) ? s.vault : [];
  unlockedUntil = await Helper.unlockedUntil();
  const locked = managed || (Boolean(lock) && Date.now() >= unlockedUntil);
  $("managed-note").hidden = !managed;
  $("unlock").hidden = !locked || managed; // an organization's lock has no PIN
  $("steps").hidden = locked;
  $("setup-end").hidden = locked;
  // Opened with Tourniquet on: start at its preset, so turning it off or switching is right there.
  if (!chosen() && tourniquet) {
    document.querySelector(`#who input[value="${tourniquet.for}"]`).checked = true;
    showFor(tourniquet.for);
  } else if (isPreset(chosen())) {
    if (chosen() !== "after_scam") drawMap(chosen());
    renderTourniquet();
  }
  $("large-text").checked = Boolean(s.largeText);
  $("strict-personal").checked = Helper.asksBeforePersonal(s.responses);
  $("vault-count").textContent = vault.length ? msg("hp_detailsSaved", "$1 saved so far", vault.length) : "";
  // Details marked OK to share (on the vault page, or from a chat before Tourniquet) are still honoured: say so.
  const shared = vault.filter((e) => e.mode === "allow").length;
  $("vault-share").hidden = !shared || !isPreset(chosen());
  $("vault-share-text").textContent =
    shared === 1
      ? msg("hp_tqShareOne", "1 detail is marked OK to share, so Clotr doesn't warn about it.")
      : msg("hp_tqShareMany", "$1 details are marked OK to share, so Clotr doesn't warn about them.", shared);
  $("lock-set").textContent = lock ? msg("pp_changePin", "Change the PIN") : msg("popup_lockSettings", "Lock settings");
}

$("who").addEventListener("change", () => {
  const who = chosen();
  showFor(who);
  if (isPreset(who)) offer?.tick(Sites.TOURNIQUET[who].apps);
  render();
});

// Turning it on, or switching: one record, and the first-time tips start again so each kind Tourniquet holds gets its
// one-line explanation. The person's own responses, larger warnings and site modes stay as they are underneath.
$("tq-on").addEventListener("click", async () => {
  const who = chosen();
  if (!isPreset(who)) return;
  disarmOff();
  // After a scam: 30 days from now, the end in the record (the background ends it: sites.js tourniquetStep).
  const record = who === "after_scam" ? Sites.afterScam(Date.now()) : { for: who, since: Date.now() };
  await chrome.storage.local.set({ tourniquet: record });
  await chrome.storage.local.remove("guided");
});

// Off takes two clicks; the email and chat apps stay on (they're the person's sites now).
let offArmed = null;
function disarmOff() {
  clearTimeout(offArmed);
  offArmed = null;
  $("tq-off").textContent = msg("hp_tqTurnOff", "Turn it off");
  $("tq-off").classList.remove("confirm");
}
$("tq-off").addEventListener("click", async () => {
  if (!offArmed) {
    $("tq-off").textContent = msg("hp_tqTurnOffAgain", "Click again to turn it off");
    $("tq-off").classList.add("confirm");
    offArmed = setTimeout(disarmOff, 4000);
    return;
  }
  disarmOff();
  await chrome.storage.local.remove("tourniquet");
  $("tq-state").classList.remove("on");
  $("tq-state").textContent = msg(
    "hp_tqTurnedOff",
    "Tourniquet is off, and their own settings are as they were. The email and chat apps stay on until you switch them off in Settings.",
  );
});

$("open-vault").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("vault.html") }));
$("review-share").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("vault.html#vault-list") }),
);
$("open-share").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("share.html") }));
// The card for next to their phone: the Share page, at the card.
$("open-card").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("share.html#card") }));
// Clotr Antibody's two pages: a second opinion on a message, and the six made-up scams to answer together.
$("open-check").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("check.html") }));
$("open-practice").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("practice.html") }));
// The office training walkthrough: the fuller, self-paced walkthrough for a team to run on their own.
$("open-training").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("training.html") }));
// Held back features get no door here.
$("tq-tiles").hidden = !FEATURES.tourniquet;
$("open-card-row").hidden = !FEATURES.scamcheck;
$("open-check").hidden = !FEATURES.scamcheck;
$("open-practice").hidden = !FEATURES.practice;
$("open-training").hidden = !FEATURES.training;
$("after-share-row").hidden = !FEATURES.scamcheck && !FEATURES.practice && !FEATURES.training;
// Extension check: Safari has no management API, so its build drops the page; hide the line here too.
if (!FEATURES.extcheck || chrome.runtime.getManifest().browser_specific_settings?.safari)
  $("ext-check-line").hidden = true;
$("large-text").addEventListener("change", (e) => chrome.storage.local.set({ largeText: e.target.checked }));
$("strict-personal").addEventListener("change", (e) => Helper.setAskBeforePersonal(e.target.checked));
$("lock-set").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  if (!Helper.validPin(pin)) return say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
  const next = await Helper.makeLock(pin);
  unlockedUntil = await Helper.markUnlocked(); // you set it, so you stay in for now
  await chrome.storage.local.set({ lock: next });
  $("pin").value = "";
  say("lock-msg", msg("pp_locked", "Settings locked. Clotr will ask for the PIN next time."));
});

async function tryUnlock() {
  if (Date.now() < retryAt) return say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
  const ok = await Helper.pinMatches($("unlock-pin").value.trim(), lock);
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
  await Helper.markUnlocked();
  render();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryUnlock();
});

// Details added in the vault tab, or settings changed in the popup, show up here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["largeText", "responses", "lock", "vault", "tourniquet"].some((k) => k in changes)) render();
});

(async () => {
  // From a link that already knows the answer (helper.html?for=after_scam, from Is this a scam? or the popup): that
  // choice is made, so the person lands on its steps.
  const asked = new URLSearchParams(location.search).get("for");
  const tile = asked === "after_scam" && document.querySelector('#who input[value="after_scam"]');
  if (tile) {
    tile.checked = true;
    showFor("after_scam");
  }
  await render();
  // The apps step: the shared card, its ask in the click's own turn (everyday-offer.js), the preset's apps ticked.
  offer = await globalThis.ClotrEverydayOffer.mount($("step-apps")).catch(() => null);
  if (isPreset(chosen())) offer?.tick(Sites.TOURNIQUET[chosen()].apps);
  // From the welcome page's line (helper.html#who): straight to the question.
  if (location.hash === "#who") {
    $("who").scrollIntoView({ block: "start" });
    (
      document.querySelector('#who input[name="who"]:checked') || document.querySelector('#who input[name="who"]')
    ).focus();
  }
})();
