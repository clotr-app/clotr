// "What should I protect?" page (the vault).
// Each line becomes a salted fingerprint of its normalized form (or, for account/ID numbers,
// just its format) before it leaves this page; the background worker stores only that.
// The typed text is cleared right after saving and is never written anywhere.
"use strict";

const { detect, redact, wordEntry, fingerprintStrong, addressCore, cleanVaultEntry, msg, practiceNotice } =
  globalThis.Clotr;
const Sites = globalThis.ClotrSites;
const $ = (id) => document.getElementById(id);
// Which held-back features this build ships (`clotr_features` in manifest.json).
const FEATURES = chrome.runtime.getManifest().clotr_features || {};
let pageLocked = false; // settings are locked (a PIN and its 10 minutes up, or a policy): see stillUnlocked

// ---------- Words ----------

const CATEGORY = {
  my_name: msg("vt_cName", "Your name"),
  family_name: msg("vt_cFamily", "Family member"),
  employer: msg("vt_cWork", "Where you work"),
  street_address: msg("vt_cAddress", "Address"),
  phone_number: msg("vt_cPhone", "Phone number"),
  email: msg("vt_cEmail", "Email address"),
  my_id: msg("vt_cIdFormat", "Account/ID format"),
  watch_list: msg("vt_cWatch", "Watch word"),
};
function categoryOf(entry) {
  if (entry.kind === "value" && entry.type === "my_id") return msg("vt_cYourId", "Your ID number");
  return CATEGORY[entry.type] || entry.type;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// An example like "AB-123456" becomes its format "@@-######"; a format stays as typed.
function toShape(line) {
  const shape = /[#@]/.test(line) ? line : line.replace(/\d/g, "#").replace(/[A-Za-z]/g, "@");
  const marks = (shape.match(/[#@]/g) || []).length;
  return marks >= 4 && !/\d/.test(shape) ? shape : null;
}

// ---------- Turning a typed line into entries ----------

// A word line: a phrase of up to four words, or, on the watch list, a format.
function wordEntries(type, line, salt) {
  // A # or @ makes a line a format, unless it has a digit too ("Project #2"): a format never does, so
  // that's a phrase to watch for, kept as one.
  if (type === "watch_list" && /[#@]/.test(line) && !/\d/.test(line)) {
    const shape = toShape(line);
    if (shape) return [{ kind: "shape", type, shape }];
    return msg("vt_errFormat", "a format needs 4+ # or @ marks (# for any digit, @ for any letter)");
  }
  const phrase = line.replace(/\s+/g, " ");
  if (phrase.split(" ").length > 4) return msg("vt_errWords", "up to 4 words per line");
  return [wordEntry(salt, type, phrase)];
}

// An ID line: its format, and for a real example its fingerprint too.
function shapeEntries(type, line, salt) {
  const shape = toShape(line);
  if (!shape) return msg("vt_errShape", "needs at least 4 letters/digits, like AB-123456");
  const entries = [{ kind: "shape", type, shape }];
  // A real example is also kept as a fingerprint, so Clotr can tell your own ID from others
  // with the same format. Typing only the format (AB-######) keeps just the format.
  if (!/[#@]/.test(line)) {
    entries.push({ kind: "value", type, fp: fingerprintStrong(salt, type, line), scheme: 2, mode: "protect" });
  }
  return entries;
}

// An address, phone or email line: a fingerprint of each one the engine finds in it.
function valueEntries(type, line, salt) {
  if (type === "street_address") {
    if (!addressCore(line)) {
      return msg("vt_errAddress", "doesn't read as a street address (number + street name + St/Ave/Rd…) or PO Box");
    }
    return [{ kind: "value", type, fp: fingerprintStrong(salt, type, line), scheme: 2, mode: "protect" }];
  }
  const found = detect(line).find((result) => result.id === type);
  if (!found) {
    return type === "email"
      ? msg("vt_errEmail", "doesn't look like an email address")
      : msg("vt_errPhone", "doesn't look like a phone number");
  }
  return found.matches.map((match) => ({
    kind: "value",
    type,
    fp: fingerprintStrong(salt, type, match),
    scheme: 2,
    mode: "protect",
  }));
}

// One typed line → vault entries, or an error message.
function entriesFor(kind, type, line, salt) {
  if (kind === "word") return wordEntries(type, line, salt);
  if (kind === "shape") return shapeEntries(type, line, salt);
  return valueEntries(type, line, salt);
}

// ---------- Saving ----------

// The background not answering (restarting, say) or answering with an error is a failed save, never a
// saved one.
async function askBackground(message) {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    return reply && !reply.error ? reply : null;
  } catch {
    return null;
  }
}

function saveFailed() {
  $("save-msg").textContent = msg("vt_saveFailed", "Couldn't save right now. Try again.");
}

function linesOf(box) {
  return box.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// What the save did: new items, ones already there, ones refused, then each line to fix.
function saveMessage(entries, reply, problems) {
  const { added = 0, rejected = 0 } = reply;
  const already = entries.length - added - rejected;
  let savedWords = "";
  if (entries.length) {
    savedWords =
      added === 1 ? msg("vt_savedOne", "Saved 1 new item.") : msg("vt_savedMany", "Saved $1 new items.", added);
  }
  const parts = [
    savedWords,
    already > 0 ? msg("vt_already", "$1 already there.", already) : "",
    rejected > 0 ? msg("vt_notSaved", "$1 couldn't be saved.", rejected) : "",
    ...problems,
  ];
  return parts.filter(Boolean).join(" · ") || msg("vt_nothingToSave", "Nothing to save.");
}

$("vault-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(await stillUnlocked())) return;
  const { salt } = (await askBackground({ type: "clotr:getSalt" })) || {};
  if (!salt) {
    saveFailed();
    return;
  }

  const entries = [];
  const problems = [];
  const kept = new Map(); // each box → the lines it keeps once the save is through: the ones to fix
  for (const box of document.querySelectorAll("textarea[data-type]")) {
    const keep = [];
    for (const line of linesOf(box)) {
      let result = entriesFor(box.dataset.kind, box.dataset.type, line, salt);
      // What the background would refuse to keep (decide.js), said here so the line stays to fix.
      if (typeof result !== "string" && !result.every((entry) => cleanVaultEntry(entry))) {
        result = msg("vt_errTooLong", "a format can be up to 40 characters");
      }
      if (typeof result === "string") {
        problems.push(`${CATEGORY[box.dataset.type]}: "${line}" ${result}`);
        keep.push(line);
      } else entries.push(...result);
    }
    kept.set(box, keep);
  }
  const reply = entries.length ? await askBackground({ type: "clotr:vaultAdd", entries }) : {};
  if (!reply) {
    saveFailed(); // nothing is cleared: what was typed stays, to try again
    return;
  }
  for (const [box, keep] of kept) box.value = keep.join("\n"); // clear what was saved; leave only lines to fix
  $("save-msg").textContent = saveMessage(entries, reply, problems);
});

// ---------- The list (fingerprints only, so items show as hidden) ----------

function vaultKey(entry) {
  if (entry.kind === "shape") return `shape:${entry.type}:${String(entry.shape).toLowerCase()}`;
  return `${entry.kind}:${entry.type}:${entry.fp}`;
}

const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

function describe(entry) {
  if (entry.kind === "shape") return [el("code", { textContent: entry.shape })];
  if (entry.kind === "word") {
    const hidden =
      entry.words > 1
        ? msg("vt_wordsHidden", "$1 words (hidden)", entry.words)
        : msg("vt_wordHidden", "1 word (hidden)");
    return [hidden];
  }
  return [msg("vt_hidden", "Hidden")];
}

function removeButton(entry) {
  const remove = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
  remove.addEventListener("click", async () => {
    if (await stillUnlocked()) {
      await chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(entry), change: "remove" });
    }
  });
  return remove;
}

// Watch or OK to share, for a value.
function modeSelect(entry) {
  const mode = el("select", { className: "resp" }, [
    el("option", { value: "protect", textContent: msg("vault_watch", "Watch"), selected: entry.mode !== "allow" }),
    el("option", {
      value: "allow",
      textContent: msg("vault_okToShare", "OK to share"),
      selected: entry.mode === "allow",
    }),
  ]);
  mode.setAttribute("aria-label", msg("vt_modeLabel", "$1: watch or OK to share", categoryOf(entry)));
  mode.addEventListener("change", async () => {
    if (await stillUnlocked()) {
      await chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(entry), change: mode.value });
    }
  });
  return mode;
}

// "Your name · learned · added Nov 3".
function categoryLine(entry) {
  const learned = entry.learned ? msg("vt_learned", " · learned") : "";
  return `${categoryOf(entry)}${learned} · ${msg("vt_added", "added $1", fmtDate.format(entry.added))}`;
}

function vaultRow(entry) {
  const controls = [removeButton(entry)];
  if (entry.kind === "value") controls.unshift(modeSelect(entry));
  return el("li", {}, [
    el("span", { className: "grow words" }, [
      el("span", { className: "cat", textContent: categoryLine(entry) }),
      ...describe(entry),
    ]),
    ...controls,
  ]);
}

function render(vault) {
  $("vault-list").replaceChildren(...vault.map(vaultRow));
  $("vault-empty").hidden = vault.length > 0 || pageLocked;
  // Re-saving a value needs it typed again (a one-way hash can't be upgraded in place), so this only ever
  // offers; it never removes a weaker entry on its own.
  $("strengthen-offer").hidden = !vault.some((entry) => entry.kind === "value" && entry.scheme !== 2);
}

chrome.storage.local.get("vault").then(({ vault = [] }) => render(vault));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vault) render(changes.vault.newValue || []);
});

// ---------- First install: welcome + practice box (clotr-pages/vault/vault.html?welcome=1) ----------
// The practice box runs the same local detector as the chat pages, and shows what it finds masked the same
// way (decide.js), drawn by the helper the practice page uses too (page-parts/practice-warning.js); nothing is saved or
// sent.

function tryIt() {
  const text = $("try").value;
  const found = text.trim() ? detect(text) : [];
  if (!found.length) {
    const nothing = text.trim() ? [el("p", { textContent: msg("vt_nothingFound", "Nothing sensitive found.") })] : [];
    $("try-result").replaceChildren(...nothing);
    return;
  }
  $("try-result").replaceChildren(
    practiceNotice(found, {
      onHide: () => {
        $("try").value = redact($("try").value, found);
        tryIt();
        $("try").focus();
      },
    }),
  );
}

// ---------- "Let Clotr check your AI chats" ----------
// Some browsers (Safari always, Firefox for Android on some versions) don't let Clotr into the AI chats
// it's built for when it's installed, so it can't warn there. The welcome page asks the browser which ones
// are missing, and a card asks for exactly those. The card follows the browser live (a yes given anywhere
// closes it); a browser that can't say keeps it away.

// Asks the browser once for these of Clotr's own AI chats, dropping anything not on the manifest's list.
// The request has to be the first thing this does, in the tap's own turn, because Firefox refuses it after
// any await. A no, a closed prompt or a browser that can't ask all answer false.
function askForAiChats(origins) {
  const builtIn = new Set(chrome.runtime.getManifest().host_permissions || []);
  try {
    return Promise.resolve(chrome.permissions.request({ origins: origins.filter((o) => builtIn.has(o)) })).catch(
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

function allowLeadWords(missing, builtIn) {
  if (missing.length === builtIn.length) {
    return msg("vt_allowAll", "Your browser hasn't let Clotr into your AI chats yet, so it can't warn you there.");
  }
  return msg(
    "vt_allowSome",
    "Your browser hasn't let Clotr into $1 of the AI chats it knows yet, so it can't warn you there.",
    missing.length,
  );
}

function allowCard() {
  const builtIn = chrome.runtime.getManifest().host_permissions || [];
  let missing = [];
  function status(text, done = false) {
    $("allow-status").textContent = text;
    $("allow-status").classList.toggle("done", done);
  }
  async function check() {
    const has = await Promise.all(
      builtIn.map((origin) => chrome.permissions.contains({ origins: [origin] }).catch(() => true)),
    );
    missing = builtIn.filter((_, index) => !has[index]);
    for (const id of ["allow-lead", "allow-how", "allow-ai"]) $(id).hidden = !missing.length;
    if (missing.length) {
      $("allow-lead").textContent = allowLeadWords(missing, builtIn);
      $("allow-card").hidden = false;
    } else if (!$("allow-card").hidden) {
      status(msg("vt_allowDone", "✓ Done. Clotr can check your AI chats now."), true);
    }
  }
  $("allow-ai").addEventListener("click", () => {
    if (!missing.length) return;
    askForAiChats(missing).then(async (yes) => {
      await check();
      if (!missing.length) return;
      const refused = msg(
        "vt_allowNo",
        "Your browser didn't allow it, so Clotr still can't warn you in those AI chats. Use the button to ask again.",
      );
      status(yes ? "" : refused);
    });
  });
  chrome.permissions.onAdded?.addListener(check);
  chrome.permissions.onRemoved?.addListener(check);
  check();
}

// From Settings → "Your own words and formats": straight to the field for them.
if (location.hash === "#watch") {
  const field = $("f-watch_list");
  field.scrollIntoView({ block: "center" });
  field.focus();
}

if (new URLSearchParams(location.search).has("welcome")) {
  document.title = msg("vt_welcome", "Welcome to Clotr");
  $("page-title").textContent = msg("vt_welcome", "Welcome to Clotr");
  $("welcome").hidden = false;
  $("vault-lead").hidden = true;
  allowCard();
  mountWhereOffer();
  let timer = null;
  $("try").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(tryIt, 300);
  });
  // Copy puts the made-up key on the clipboard so nobody has to select it by hand. If the browser won't
  // allow that, the key gets selected instead, ready for Ctrl+C.
  let copiedTimer = null;
  $("try-copy").addEventListener("click", async () => {
    const button = $("try-copy");
    const key = $("try-field").querySelector("code");
    try {
      await navigator.clipboard.writeText(key.textContent.trim());
    } catch {
      getSelection().selectAllChildren(key);
      return;
    }
    button.textContent = msg("vault_copied", "Copied");
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      button.textContent = msg("vault_copyKey", "Copy");
    }, 1500);
  });
  pinStepsForThisBrowser();
  // Pinned yet? The browser can tell us (Chrome/Edge/Brave; older browsers keep the instructions). Only the
  // computer's words change: a phone has no toolbar, so its line stays whatever the browser says.
  async function checkPinned() {
    const settings = await chrome.action.getUserSettings?.().catch(() => null);
    if (!settings?.isOnToolbar) return false;
    $("pin-step")
      .querySelector(".on-computer")
      .replaceChildren(msg("vt_pinned", "✓ Clotr is pinned. Its count shows on Clotr's icon in your toolbar."));
    $("pin-step").classList.add("done");
    return true;
  }
  checkPinned().then((done) => {
    if (done) return;
    const poll = setInterval(async () => {
      if (await checkPinned()) clearInterval(poll);
    }, 1500);
  });
  $("skip").addEventListener("click", async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  });
  // Clotr on email and chat apps too, right after Pin Clotr. Hidden while settings are locked, like the
  // vault's form below: the popup's own switches are off then too.
  settingsLocked().then(async (locked) => {
    if (locked) return;
    if (FEATURES.tourniquet) $("tq-offer").hidden = false; // Tourniquet's one line, right after the card
    if (FEATURES.lookback) $("lb-offer").hidden = false; // Look back's one line, after Try it
    await globalThis.ClotrEverydayOffer.mount($("everyday-offer"));
    await mountMoreSitesOffer($("more-sites-offer"));
    // Something in the fold is already on (the welcome page reopened by someone who'd already picked a
    // site or two): open it, so nothing someone turned on is hidden.
    const listed = await Sites.userSitePatterns();
    if (Sites.grantedEverydayApps(listed).length || Sites.grantedMoreSites(listed).length) {
      $("where-pick-sites").open = true;
    }
    $("where-offer").hidden = false;
  });
}

// ---------- The welcome page's other cards ----------

// The page's pin steps are Chrome's and Brave's (the puzzle piece, then the pin). Firefox and Edge tuck
// the pin elsewhere in the same extensions menu, so their steps are swapped in here, using the same
// browser test as the Rate Clotr link. Phones keep their own line.
function pinStepsForThisBrowser() {
  const kind = globalThis.Clotr.Rate?.browserFor();
  const steps = {
    firefox: [
      msg("vault_pinFirefoxMiddle", "in your browser's toolbar, then the gear next to Clotr, then"),
      msg("vault_pinFirefoxEnd", "Pin to Toolbar"),
    ],
    edge: [
      msg("vault_pinEdgeMiddle", "in your browser's toolbar, then the eye next to Clotr, which says"),
      msg("vault_pinEdgeEnd", "Show in toolbar"),
    ],
  }[kind];
  if (!steps) return;
  $("pin-step")
    .querySelector(".on-computer")
    .replaceChildren(
      msg(
        "vault_pinIntroButton",
        "Browsers tuck new extensions away. To see Clotr's count and open its dashboard, click the",
      ),
      " ",
      el("b", { textContent: msg("vault_pinExtensionsButton", "extensions button") }),
      ` ${steps[0]} `,
      el("b", { textContent: steps[1] }),
      ".",
    );
}

// "Where should Clotr check?": the highlighted choice names the built-in AI chat sites, with its count
// read from ai-sites.json. The other asks for the broad permission in the same click, the same flow
// Settings' own "Everywhere I type" switch uses; on a yes the card keeps only its title and a ✓ On line,
// so the person sees it took.
function mountWhereOffer() {
  fetch(chrome.runtime.getURL("ai-sites.json"))
    .then((response) => (response.ok ? response.json() : []))
    .then((sites) => {
      if (!Array.isArray(sites) || !sites.length) return;
      const count = String(sites.length);
      $("ai-site-count-choice").textContent = count;
      $("ai-site-count-fact").textContent = count;
    })
    .catch(() => {}); // Keep the general wording if the bundled list cannot be read.
  $("where-ai-only").addEventListener("click", () => {
    $("where-offer").hidden = true;
  });
  $("where-everywhere").addEventListener("click", async () => {
    const status = $("where-status");
    status.textContent = "";
    const yes = await Sites.requestEverywhere();
    if (yes) {
      $("where-offer").querySelector(".ev-actions").hidden = true;
      $("where-pick-sites").hidden = true;
      status.textContent = msg(
        "vt_everywhereOn",
        "✓ On. Clotr now checks a chat box on any website too. You can switch it off in Settings, under Everywhere I type.",
      );
    } else {
      status.textContent = msg(
        "vt_everywhereRefused",
        "Nothing was switched on, because the browser's question was closed or answered No. Press the button to ask again, or switch on Everywhere I type later in Settings.",
      );
    }
  });
}

// The offer to use Clotr on search engines and support chats too, right after the email/chat-apps card.
// Simpler than that one: nothing here is ever already off-to-be-removed, since the popup's Settings is
// where an already-on site gets switched off again.
async function mountMoreSitesOffer(card) {
  // The card's parts and its state: site name → { box, tag }, the sites on, and whether a question is out.
  const offer = {
    groups: card.querySelector("#ms-groups"),
    goButton: card.querySelector("#ms-go"),
    status: card.querySelector("#ms-status"),
    rows: new Map(),
    on: new Set(),
    asking: false,
  };
  offer.groups.replaceChildren(...moreSitesGroups(offer));
  offer.goButton.addEventListener("click", () => askForMoreSites(offer));
  chrome.permissions.onAdded?.addListener(() => refreshMoreSites(offer).catch(() => {}));
  chrome.permissions.onRemoved?.addListener(() => refreshMoreSites(offer).catch(() => {}));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.siteScopes) refreshMoreSites(offer).catch(() => {});
  });
  updateMoreSites(offer);
  await refreshMoreSites(offer).catch(() => {});
}

// A fieldset each for search engines and support chats, a tick box and a hidden On tag per site.
function moreSitesGroups(offer) {
  const groups = [
    [Sites.SEARCH_SITES, msg("ms_search", "Search engines")],
    [Sites.SUPPORT_SITES, msg("ms_support", "Support chats on websites")],
  ];
  return groups.map(([list, legend]) =>
    el("fieldset", { className: "ev-group" }, [
      el("legend", { textContent: legend }),
      ...list.map((site) => {
        const box = el("input", { type: "checkbox", value: site.name });
        const tag = el("span", { className: "ev-tag", textContent: msg("ev_on", "On"), hidden: true });
        offer.rows.set(site.name, { box, tag });
        box.addEventListener("change", () => updateMoreSites(offer));
        return el("label", { className: "ev-app" }, [box, el("span", { textContent: site.name }), tag]);
      }),
    ]),
  );
}

// Sites newly ticked, to switch on.
function moreSitesAdded(offer) {
  return [...offer.rows].filter(([name, row]) => row.box.checked && !offer.on.has(name)).map(([name]) => name);
}

function updateMoreSites(offer) {
  const toAdd = moreSitesAdded(offer);
  offer.goButton.hidden = offer.on.size === offer.rows.size;
  offer.goButton.setAttribute("aria-disabled", String(!toAdd.length || offer.asking));
  offer.goButton.textContent = switchOnWords(toAdd);
}

function setMoreSitesOn(offer, names) {
  const nowOn = new Set(names);
  for (const [name, { box, tag }] of offer.rows) {
    const isOn = nowOn.has(name);
    box.checked = isOn;
    box.disabled = isOn; // already on: switched off again in Settings, not here
    box.parentElement.classList.toggle("on", isOn);
    tag.hidden = !isOn;
  }
  offer.on = nowOn;
  updateMoreSites(offer);
}

// A site switched on while Everywhere I type covered it counts (userSitePatterns), and one it covers
// shows On.
async function refreshMoreSites(offer) {
  const [{ origins = [] }, listed] = await Promise.all([chrome.permissions.getAll(), Sites.userSitePatterns()]);
  const covered = Sites.coveredByEverywhere(Sites.MORE_SITES, origins);
  setMoreSitesOn(offer, [...new Set([...Sites.grantedMoreSites(listed), ...covered])]);
}

// The button: asks the browser for the ticked sites, in the click's own turn.
function askForMoreSites(offer) {
  if (offer.asking) return;
  const toAdd = moreSitesAdded(offer);
  if (!toAdd.length) return;
  chrome.storage.local.set({ moreSitesOffer: "done" }).catch(() => {});
  offer.asking = true;
  offer.status.textContent = "";
  Sites.requestMoreSites(toAdd).then((yes) => answerMoreSites(offer, toAdd, yes));
}

// The browser's answer: on a no, the card asks the browser again; on a yes, the sites show On.
async function answerMoreSites(offer, toAdd, yes) {
  offer.asking = false;
  if (!yes) {
    await refreshMoreSites(offer).catch(() => {});
    offer.status.textContent = msg(
      "ev_refused",
      "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
    );
  } else {
    const next = new Set(offer.on);
    for (const name of toAdd) next.add(name);
    setMoreSitesOn(offer, [...next]);
    offer.status.textContent = msg(
      "ev_onFor",
      "✓ On for $1, in tabs you already have open too.",
      globalThis.ClotrEverydayOffer.listOf(toAdd),
    );
  }
  offer.status.classList.toggle("done", yes);
}

// The more-sites button: named sites up to two, else a count.
function switchOnWords(toAdd) {
  if (!toAdd.length) return msg("ev_switchOn", "Switch on");
  if (toAdd.length <= 2) return msg("ev_switchOnNames", "Switch on $1", globalThis.ClotrEverydayOffer.listOf(toAdd));
  return msg("ev_switchOnCount", "Switch on $1 apps", toAdd.length);
}

// ---------- Leaving the page, and the lock ----------

// Browsers restore form fields on Back/Forward and after a crash. Details typed here but not
// saved must not end up in that restore data, so the fields are emptied whenever the page is
// hidden. Saved items are fingerprints already.
window.addEventListener("pagehide", () => {
  for (const box of document.querySelectorAll("textarea")) box.value = "";
});

// Helping someone: with a PIN set and not unlocked in the popup (10 minutes), or settings locked by an
// organization's policy, the vault can't be changed here. The first-run welcome never has a PIN yet.
async function settingsLocked() {
  const { lock } = await chrome.storage.local.get("lock");
  const { unlockedUntil = 0 } = await chrome.storage.session.get("unlockedUntil").catch(() => ({}));
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  return policy.lockSettings === true || (Boolean(lock) && Date.now() >= unlockedUntil);
}
// The 10 minutes can run out while the page is open: it locks itself then, and opens again once the PIN is
// entered in the popup (as its note says). Save, Remove and OK to share each check the time again first.
let relock = null;
async function stillUnlocked() {
  const locked = await settingsLocked();
  if (locked !== pageLocked) showLocked(locked);
  clearTimeout(relock);
  const { unlockedUntil = 0 } = await chrome.storage.session.get("unlockedUntil").catch(() => ({}));
  if (!locked && unlockedUntil > Date.now()) relock = setTimeout(stillUnlocked, unlockedUntil - Date.now());
  return !locked;
}
function showLocked(locked) {
  pageLocked = locked;
  $("vault-locked").hidden = !locked;
  $("vault-form").hidden = locked;
  $("vault-list").hidden = locked;
  $("vault-lead").hidden = locked || new URLSearchParams(location.search).has("welcome");
  $("vault-empty").hidden = locked || $("vault-list").children.length > 0;
}
stillUnlocked();
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" && changes.lock) || (area === "session" && changes.unlockedUntil)) stillUnlocked();
});
