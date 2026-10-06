// "What should I protect?" page (the vault).
// Each line becomes a salted fingerprint of its normalized form (or, for account/ID numbers,
// just its format) before it leaves this page; the background worker stores only that.
// The typed text is cleared right after saving and is never written anywhere.
"use strict";

const { detect, redact, fingerprint, addressCore, msg, practiceNotice } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);
// Which held-back features this build ships (`clotr_features` in manifest.json).
const FEATURES = chrome.runtime.getManifest().clotr_features || {};

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
const categoryOf = (e) =>
  e.kind === "value" && e.type === "my_id" ? msg("vt_cYourId", "Your ID number") : CATEGORY[e.type] || e.type;

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

// One typed line → vault entries, or an error message.
function entriesFor(kind, type, line, salt) {
  if (kind === "word") {
    if (type === "watch_list" && /[#@]/.test(line)) {
      const shape = toShape(line);
      return shape ? [{ kind: "shape", type, shape }] : msg("vt_errFormat", "a format needs 4+ # or @ marks");
    }
    const phrase = line.replace(/\s+/g, " ");
    if (phrase.split(" ").length > 4) return msg("vt_errWords", "up to 4 words per line");
    return [{ kind: "word", type, fp: fingerprint(salt, "watch_list", phrase), words: phrase.split(" ").length }];
  }
  if (kind === "shape") {
    const shape = toShape(line);
    if (!shape) return msg("vt_errShape", "needs at least 4 letters/digits, like AB-123456");
    const out = [{ kind: "shape", type, shape }];
    // A real example is also kept as a fingerprint, so Clotr can tell your own ID from others
    // with the same format. Typing only the format (AB-######) keeps just the format.
    if (!/[#@]/.test(line)) out.push({ kind: "value", type, fp: fingerprint(salt, type, line), mode: "protect" });
    return out;
  }
  if (type === "street_address") {
    if (!addressCore(line))
      return msg("vt_errAddress", "doesn't read as a street address (number + street name + St/Ave/Rd…) or PO Box");
    return [{ kind: "value", type, fp: fingerprint(salt, type, line), mode: "protect" }];
  }
  const found = detect(line).find((r) => r.id === type);
  if (!found)
    return type === "email"
      ? msg("vt_errEmail", "doesn't look like an email address")
      : msg("vt_errPhone", "doesn't look like a phone number");
  return found.matches.map((m) => ({ kind: "value", type, fp: fingerprint(salt, type, m), mode: "protect" }));
}

$("vault-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { salt } = await chrome.runtime.sendMessage({ type: "clotr:getSalt" });
  if (!salt) {
    $("save-msg").textContent = msg("vt_saveFailed", "Couldn't save right now. Try again.");
    return;
  }

  const entries = [];
  const problems = [];
  for (const box of document.querySelectorAll("textarea[data-type]")) {
    const lines = box.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const keep = [];
    for (const line of lines) {
      const out = entriesFor(box.dataset.kind, box.dataset.type, line, salt);
      if (typeof out === "string") {
        problems.push(`${CATEGORY[box.dataset.type]}: "${line}" ${out}`);
        keep.push(line);
      } else entries.push(...out);
    }
    box.value = keep.join("\n"); // clear what was saved; leave only lines to fix
  }
  const { added = 0 } = entries.length ? await chrome.runtime.sendMessage({ type: "clotr:vaultAdd", entries }) : {};
  $("save-msg").textContent =
    [
      entries.length
        ? added === 1
          ? msg("vt_savedOne", "Saved 1 new item.")
          : msg("vt_savedMany", "Saved $1 new items.", added)
        : "",
      entries.length && added < entries.length ? msg("vt_already", "$1 already there.", entries.length - added) : "",
      ...problems,
    ]
      .filter(Boolean)
      .join(" · ") || msg("vt_nothingToSave", "Nothing to save.");
});

// ---------- The list (fingerprints only, so items show as hidden) ----------

const vaultKey = (e) =>
  e.kind === "shape" ? `shape:${e.type}:${String(e.shape).toLowerCase()}` : `${e.kind}:${e.type}:${e.fp}`;
const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

function describe(e) {
  if (e.kind === "shape") return [el("code", { textContent: e.shape })];
  if (e.kind === "word")
    return [
      e.words > 1 ? msg("vt_wordsHidden", "$1 words (hidden)", e.words) : msg("vt_wordHidden", "1 word (hidden)"),
    ];
  return [msg("vt_hidden", "Hidden")];
}

function render(vault) {
  $("vault-list").replaceChildren(
    ...vault.map((e) => {
      const remove = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
      remove.addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(e), change: "remove" }),
      );
      const controls = [remove];
      if (e.kind === "value") {
        const mode = el("select", { className: "resp" }, [
          el("option", { value: "protect", textContent: msg("vault_watch", "Watch"), selected: e.mode !== "allow" }),
          el("option", {
            value: "allow",
            textContent: msg("vault_okToShare", "OK to share"),
            selected: e.mode === "allow",
          }),
        ]);
        mode.setAttribute("aria-label", msg("vt_modeLabel", "$1: watch or OK to share", categoryOf(e)));
        mode.addEventListener("change", () =>
          chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(e), change: mode.value }),
        );
        controls.unshift(mode);
      }
      return el("li", {}, [
        el("span", { className: "grow words" }, [
          el("span", {
            className: "cat",
            textContent: `${categoryOf(e)}${e.learned ? msg("vt_learned", " · learned") : ""} · ${msg("vt_added", "added $1", fmtDate.format(e.added))}`,
          }),
          ...describe(e),
        ]),
        ...controls,
      ]);
    }),
  );
  $("vault-empty").hidden = vault.length > 0;
}

chrome.storage.local.get("vault").then(({ vault = [] }) => render(vault));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vault) render(changes.vault.newValue || []);
});

// ---------- First install: welcome + practice box (vault.html?welcome=1) ----------
// The practice box runs the same local detector as the chat pages, and shows what it finds masked the same way
// (decide.js), drawn by the helper the practice page uses too (page-notice.js); nothing is saved or sent.

function tryIt() {
  const text = $("try").value;
  const found = text.trim() ? detect(text) : [];
  if (!found.length) {
    $("try-result").replaceChildren(
      ...(text.trim() ? [el("p", { textContent: msg("vt_nothingFound", "Nothing sensitive found.") })] : []),
    );
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
// Some browsers (Safari always, Firefox for Android on some versions) don't let Clotr into the AI chats it's built
// for when it's installed, so it can't warn there. The welcome page asks the browser which ones are missing, and a
// card asks for exactly those. The card follows the browser live (a yes given anywhere closes it); a browser that
// can't say keeps it away.

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

function allowCard() {
  const builtIn = chrome.runtime.getManifest().host_permissions || [];
  let missing = [];
  const status = (text, done = false) => {
    $("allow-status").textContent = text;
    $("allow-status").classList.toggle("done", done);
  };
  const check = async () => {
    const has = await Promise.all(
      builtIn.map((origin) => chrome.permissions.contains({ origins: [origin] }).catch(() => true)),
    );
    missing = builtIn.filter((_, i) => !has[i]);
    for (const id of ["allow-lead", "allow-how", "allow-ai"]) $(id).hidden = !missing.length;
    if (missing.length) {
      $("allow-lead").textContent =
        missing.length === builtIn.length
          ? msg("vt_allowAll", "Your browser hasn't let Clotr into your AI chats yet, so it can't warn you there.")
          : msg(
              "vt_allowSome",
              "Your browser hasn't let Clotr into $1 of the AI chats it knows yet, so it can't warn you there.",
              missing.length,
            );
      $("allow-card").hidden = false;
    } else if (!$("allow-card").hidden) {
      status(msg("vt_allowDone", "✓ Done. Clotr can check your AI chats now."), true);
    }
  };
  $("allow-ai").addEventListener("click", () => {
    if (!missing.length) return;
    askForAiChats(missing).then(async (yes) => {
      await check();
      if (missing.length)
        status(
          yes
            ? ""
            : msg(
                "vt_allowNo",
                "Your browser didn't allow it, so Clotr still can't warn you in those AI chats. Use the button to ask again.",
              ),
        );
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
  let timer = null;
  $("try").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(tryIt, 300);
  });
  // Pinned yet? The browser can tell us (Chrome/Edge/Brave; older browsers keep the instructions).
  const checkPinned = async () => {
    const settings = await chrome.action.getUserSettings?.().catch(() => null);
    if (!settings?.isOnToolbar) return false;
    $("pin-step").replaceChildren(
      msg("vt_pinned", "✓ Clotr is pinned. Its count shows on the shield in your toolbar."),
    );
    $("pin-step").classList.add("done");
    return true;
  };
  checkPinned().then((done) => {
    if (done) return;
    const poll = setInterval(async () => {
      if (await checkPinned()) clearInterval(poll);
    }, 1500);
  });
  // Clotr Antibody's two pages, each in a new tab beside this one.
  for (const [id, page] of [
    ["ss-welcome-check", "check.html"],
    ["ss-welcome-practice", "practice.html"],
  ])
    $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(page) }));
  // Held back features get no door here.
  $("ss-welcome-check").hidden = !FEATURES.scamcheck;
  $("ss-welcome-practice").hidden = !FEATURES.practice;
  $("ss-welcome").hidden = !FEATURES.scamcheck && !FEATURES.practice;
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
    $("everyday-offer").hidden = false;
  });
}

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
(async () => {
  if (!(await settingsLocked())) return;
  document.getElementById("vault-locked").hidden = false;
  for (const id of ["vault-lead", "vault-form", "vault-list", "vault-empty"]) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
})();
