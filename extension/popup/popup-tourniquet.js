/* global $, FEATURES, Sites, el, isLocked, msg, selectTab, state */
/* exported combinedPolicy, renderTourniquet */
"use strict";

// ---------- Tourniquet: the chip, the Overview line, the Settings card ----------
// The person it protects always sees that it's on and what it does, in words that never name the preset.
// Once settings are open, the switch here can change the preset or turn it off, with two clicks; turning it
// on in the first place is the guided setup's job, not this page's.

const tourniquetOn = () => Sites.cleanTourniquet(state.tourniquet);
// What Clotr applies now: the organization's policy with Tourniquet on top.
const combinedPolicy = () => Sites.combinePolicies(state.policy, Sites.tourniquetPolicy(state.tourniquet));

// The line under the chip: what Tourniquet asks about, for its preset.
function tourniquetLineWords(child, scam) {
  if (child) {
    return msg(
      "pp_tqLineChild",
      "Tourniquet is on: Clotr asks before personal details, passwords and sign-in codes go out. If you choose to send a message, the AI service receives it as usual. Clotr has no server.",
    );
  }
  if (scam) {
    return msg(
      "pp_tqLineAfterScam",
      "Tourniquet is on for 30 days after a scam: Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out. If you choose to send a message, the AI service receives it as usual. Clotr has no server.",
    );
  }
  return msg(
    "pp_tqLineAdult",
    "Tourniquet is on: Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out. If you choose to send a message, the AI service receives it as usual. Clotr has no server.",
  );
}

// The Settings card's list of what Clotr asks before, for its preset.
function tourniquetAsksWords(child, scam) {
  if (child) {
    return msg(
      "pp_tqAsksChild",
      "Clotr asks before these go out: names, addresses, phone numbers, email addresses, birthdays, card and ID numbers, passwords and sign-in codes, and the words added to watch for.",
    );
  }
  if (scam) {
    return msg(
      "pp_tqAsksAfterScam",
      "Clotr asks before these go out: bank, card and ID numbers, gift card numbers, Medicare and insurance numbers, birthdays, passwords and sign-in codes.",
    );
  }
  return msg(
    "pp_tqAsksAdult",
    "Clotr asks before these go out: bank, card and ID numbers, Medicare and insurance numbers, birthdays, passwords and sign-in codes.",
  );
}

// The day it was switched on, the browser's own way.
function tourniquetSinceText(preset) {
  try {
    return new Date(preset.since).toLocaleDateString(chrome.i18n.getUILanguage(), { dateStyle: "long" });
  } catch {
    return new Date(preset.since).toDateString();
  }
}

// The email and chat apps switched on, by name.
function tourniquetAppNames() {
  const granted = state.userSites;
  return Sites.EVERYDAY_SITES.filter((everydayApp) =>
    everydayApp.matches.some((pattern) => granted.includes(pattern)),
  ).map((everydayApp) => everydayApp.name);
}

function renderTourniquet() {
  const preset = tourniquetOn();
  // Clotr Antibody's 30-day line offers Tourniquet to someone on their own: not while it's on, settings are
  // locked, or Tourniquet is held back in this build.
  if ($("ss-tq30")) $("ss-tq30").hidden = Boolean(preset) || isLocked() || !FEATURES.tourniquet;
  // The Overview row only earns its place once Tourniquet is protecting someone; otherwise Scam help stays
  // folded in Settings and the quiet day-link (renderScamHelpToday) covers the rest.
  if ($("ss-row")) $("ss-row").hidden = !preset || (!FEATURES.scamcheck && !FEATURES.practice);
  for (const id of ["tq-chip", "tq-line", "tq-card", "tq-keeps-note"]) if ($(id)) $(id).hidden = !preset;
  if (!preset) {
    disarmTourniquetOff();
    return;
  }
  const child = preset.for === "child";
  const scam = preset.for === "after_scam"; // the grown-up's rules, for 30 days (Scam Shield)
  $("tq-line-text").textContent = tourniquetLineWords(child, scam);
  $("tq-title-text").textContent = scam
    ? msg("pp_tqTitleAfterScam", "Tourniquet: 30 days after a scam")
    : msg("pp_tqTitle", "Tourniquet is on");
  $("tq-since").hidden = scam;
  $("tq-days").hidden = !scam;
  if (scam) renderTourniquetDays(preset);
  const since = tourniquetSinceText(preset);
  $("tq-since").textContent = msg("pp_tqSince", "On since $1.", since);
  $("tq-asks").textContent = tourniquetAsksWords(child, scam);
  $("tq-notes").hidden = child;
  $("tq-notes").textContent = child
    ? ""
    : msg(
        "pp_tqNotesAdult",
        "Warnings are larger. Names, addresses, phone numbers and email addresses always get a note in the corner.",
      );
  const apps = tourniquetAppNames();
  $("tq-apps").hidden = !apps.length;
  $("tq-apps").textContent = apps.length
    ? msg("pp_tqApps", "Also on your email and chat apps: $1.", apps.join(", "))
    : "";
  $("tq-switch").hidden = isLocked();
  for (const button of $("tq-switch").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.for === preset.for));
  }
}

// "2 October", the browser's own way: the 30 days' dates.
function shortDay(time) {
  try {
    return new Date(time).toLocaleDateString(chrome.i18n.getUILanguage(), { day: "numeric", month: "long" });
  } catch {
    return new Date(time).toDateString();
  }
}

// A day on the 30 days' track: gone, today, or still to come.
function trackDayClass(dayNumber, today) {
  if (dayNumber < today) return "gone";
  if (dayNumber === today) return "today";
  return "";
}

// Fills in the day count and end date for the 30 days after a scam, worked out from the stored dates on
// this computer's clock. The track underneath is just a picture; the words already say the same thing. If the
// clock gets turned back, a note explains that the stored dates don't move with it.
function renderTourniquetDays(preset) {
  const now = Date.now();
  const { day, of } = Sites.tourniquetDay(preset, now);
  $("tq-day").textContent = msg("pp_tqDay", "Day $1 of $2", day, of);
  $("tq-ends").textContent = msg("pp_tqStepsDown", "Steps down on $1", shortDay(preset.until));
  $("tq-days")
    .querySelector(".tq-track")
    .replaceChildren(
      ...Array.from({ length: of }, (_, index) => el("span", { className: trackDayClass(index + 1, day) })),
    );
  const back = Sites.tourniquetClockBack(state.tourniquetSeen, now);
  $("tq-clock").hidden = !back;
  $("tq-clock").textContent = back
    ? msg(
        "pp_tqClockBack",
        "This computer's clock was turned back. Clotr keeps its own dates, so the 30 days end when this clock reaches $1.",
        shortDay(preset.until),
      )
    : "";
}

// The chip and "What it changes" open Settings at the card and move the focus to its heading.
function showTourniquetCard() {
  selectTab("settings");
  $("tq-title").focus();
}
$("tq-chip")?.addEventListener("click", showTourniquetCard);
$("tq-line-open")?.addEventListener("click", showTourniquetCard);

let tourniquetOffArmed = null;
// Tourniquet held back: there's no switch left to disarm, and renderTourniquet() calls this on every
// render (it's always "off" with nothing to turn off), so this has to be the quiet no-op it looks like.
function disarmTourniquetOff() {
  clearTimeout(tourniquetOffArmed);
  tourniquetOffArmed = null;
  const off = $("tq-switch")?.querySelector('[data-for="off"]');
  if (off) {
    off.textContent = msg("pp_tqOff", "Off");
    off.classList.remove("confirm");
  }
  if ($("tq-off-msg")) $("tq-off-msg").textContent = "";
}
$("tq-switch")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const preset = tourniquetOn();
  if (!button || !preset || isLocked()) return;
  if (button.dataset.for !== "off") {
    disarmTourniquetOff();
    // A new choice is a new start: `since` is when it was chosen (after a scam: 30 days from now).
    if (button.dataset.for !== preset.for) {
      const chosen = button.dataset.for;
      await chrome.storage.local.set({
        tourniquet: chosen === "after_scam" ? Sites.afterScam(Date.now()) : { for: chosen, since: Date.now() },
      });
    }
    return;
  }
  if (!tourniquetOffArmed) {
    button.textContent = msg("pp_tqOffAgain", "Click again");
    button.classList.add("confirm");
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
