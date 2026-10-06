// "Share Clotr with someone": the link to send, the step-by-step setup, a one-page
// guide to print, and the card for next to the phone. Nothing is sent anywhere: copying uses the clipboard, printing
// the browser's dialog.
"use strict";

const { msg } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);
// Which held-back features this build ships (`clotr_features` in manifest.json).
const FEATURES = chrome.runtime.getManifest().clotr_features || {};
// Where someone gets Clotr: the website until the store listing is public (then its store page).
const SHARE_URL = "https://clotr.app/";

$("share-url").textContent = SHARE_URL;
$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    $("copy-msg").textContent = msg("sh_copied", "Copied. Paste it into a message to them.");
  } catch {
    $("copy-msg").textContent = msg("sh_copyFailed", "Couldn't copy that. Select the link and copy it by hand.");
  }
});
$("open-helper").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("helper.html") }));
// Clotr Antibody's two pages: practice together, and a second opinion on a message they got.
$("open-practice").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("practice.html") }));
$("open-check").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("check.html") }));
// Held back features get no door here.
$("card-section").hidden = !FEATURES.scamcheck;
$("card-sheet").hidden = !FEATURES.scamcheck;
$("practice-row").hidden = !FEATURES.practice;
$("check-row").hidden = !FEATURES.scamcheck;
$("practice-check-heading").hidden = !FEATURES.practice && !FEATURES.scamcheck;

// Tourniquet: while it's on, the guide says so and what it does, in the words its own screens use. Nothing
// about it while it's off, and never who it's for (the guide sits next to their computer). "It never sends anything
// anywhere" is the guide's own next section, so the paragraph doesn't say it twice. The 30 days after a scam say until
// when (a printed page can't count days), and never why.
async function showTourniquet() {
  const { tourniquet } = await chrome.storage.local.get("tourniquet");
  const t = globalThis.ClotrSites.cleanTourniquet(tourniquet);
  $("guide-tq").hidden = !t;
  $("guide-tq-text").textContent = !t
    ? ""
    : t.for === "child"
      ? msg(
          "sh_tqChild",
          "Clotr asks before personal details, passwords and sign-in codes go out. You can always leave them in and send.",
        )
      : t.for === "after_scam"
        ? msg(
            "sh_tqUntil",
            "Until $1, Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out, and its warnings are bigger. You can always leave them in and send.",
            shortDay(t.until),
          )
        : msg(
            "sh_tqAdult",
            "Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out, and its warnings are bigger. You can always leave them in and send.",
          );
}
// "1 November", the browser's own way.
function shortDay(t) {
  try {
    return new Date(t).toLocaleDateString(chrome.i18n.getUILanguage(), { day: "numeric", month: "long" });
  } catch {
    return new Date(t).toDateString();
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tourniquet) showTourniquet();
});
showTourniquet();

// Two sheets print from this page: the guide (as always, and what Ctrl+P prints) and the card for next to the phone
//. The print stylesheet shows the one asked for; nothing is typed into either, and nothing is kept.
$("print").addEventListener("click", () => {
  delete document.body.dataset.print;
  window.print();
});
$("print-card").addEventListener("click", () => {
  document.body.dataset.print = "card";
  window.print();
});
window.addEventListener("afterprint", () => delete document.body.dataset.print);
$("card-from").textContent = msg(
  "sh_cardFrom",
  "This card is from Clotr. It warns before most of these go out on your computer, and it's for phone calls and texts.",
);
