// "Warn you less on every site?": Clotr's own page, opened beside a chat when a choice in Clotr's warning there
// would make Clotr warn less on every site. The chat page can restyle or cover that warning and steer a click onto
// one of its choices, so the background holds the choice (askOnClotrPage in background.js) and only a yes on this
// page applies it. This page shows kinds of data, never a value, and keeps and sends nothing itself.
"use strict";

const { msg, PATTERNS } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
const yes = $("cf-yes");
const no = $("cf-no");
const outcome = $("cf-status");

const nameOf = (id) => PATTERNS.find((p) => p.id === id)?.name || id;
const names = (ids) => [...new Set(ids.map(nameOf))].join(", ");

function describe(a) {
  if (a.allow)
    return msg(
      "cf_allow",
      "Stop warning you about the $1 you chose in the warning, on every site? Clotr still counts it in your history.",
      names(a.allow),
    );
  if (a.value === "log")
    return msg(
      "cf_log",
      "Stop warning you about $1 on every site? Clotr still counts it in your history.",
      names(a.ids),
    );
  if (a.value === "warn")
    return msg("cf_warn", "Just warn you about $1 on every site, instead of asking before it's sent?", names(a.ids));
  return msg("cf_change", "Change how Clotr handles $1 on every site?", names(a.ids));
}

// Yes stays asleep until this page has been in front for a moment, and falls asleep again whenever the page is
// hidden or loses focus. With a mouse, it also needs the pointer to move after it wakes. So a click the chat page
// lined up for the spot where Yes appears, like the second half of a double-click, or a click from a pointer that
// never moved here, does nothing. A key press or a tap still reaches Yes, once it's awake.
const WAKE_MS = 1000;
let asked = null; // the question, once it's read; null again once it's answered
let waking = null;
let moved = false;
function doze() {
  clearTimeout(waking);
  yes.disabled = true;
  moved = false;
}
function wake() {
  doze();
  if (asked && document.visibilityState === "visible") waking = setTimeout(() => (yes.disabled = false), WAKE_MS);
}
document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);
window.addEventListener("blur", doze);
document.addEventListener("pointermove", (e) => {
  if (!yes.disabled && (e.movementX || e.movementY)) moved = true;
});

async function answer(choice) {
  if (!asked) return;
  asked = null;
  doze();
  no.disabled = true;
  const r = await chrome.runtime.sendMessage({ type: "clotr:askedAnswer", token, yes: choice }).catch(() => null);
  outcome.textContent = r?.gone
    ? msg("cf_gone", "This question was already answered, or it's too old. Nothing changed.")
    : r?.changed
      ? msg("cf_done", "Done. You can change it back in Settings.")
      : msg("cf_kept", "Nothing changed.");
  // The background has brought the chat back to the front; this page closes itself, or stays to say what happened.
  try {
    const tab = await chrome.tabs.getCurrent();
    if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id);
  } catch {
    /* it stays open */
  }
}
yes.addEventListener("click", (e) => {
  if (yes.disabled || (e.pointerType === "mouse" && !moved)) return;
  answer(true);
});
no.addEventListener("click", () => answer(false));

(async () => {
  const a = token ? await chrome.runtime.sendMessage({ type: "clotr:askedRead", token }).catch(() => null) : null;
  if (!a?.allow && !a?.ids) {
    outcome.textContent = msg("cf_gone", "This question was already answered, or it's too old. Nothing changed.");
    yes.hidden = true;
    no.hidden = true;
    return;
  }
  $("cf-what").textContent = describe(a);
  asked = a;
  wake();
})();
