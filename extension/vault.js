// "What should I protect?" page (the vault).
// Each line becomes a salted fingerprint of its normalized form (or, for account/ID numbers,
// just its format) before it leaves this page; the background worker stores only that.
// The typed text is cleared right after saving and is never written anywhere.
"use strict";

const { detect, redact, fingerprint, fingerprintStrong, addressCore, msg, practiceNotice } = globalThis.Clotr;
const Sites = globalThis.ClotrSites;
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
    if (!/[#@]/.test(line)) {
      out.push({ kind: "value", type, fp: fingerprintStrong(salt, type, line), scheme: 2, mode: "protect" });
    }
    return out;
  }
  if (type === "street_address") {
    if (!addressCore(line)) {
      return msg("vt_errAddress", "doesn't read as a street address (number + street name + St/Ave/Rd…) or PO Box");
    }
    return [{ kind: "value", type, fp: fingerprintStrong(salt, type, line), scheme: 2, mode: "protect" }];
  }
  const found = detect(line).find((r) => r.id === type);
  if (!found) {
    return type === "email"
      ? msg("vt_errEmail", "doesn't look like an email address")
      : msg("vt_errPhone", "doesn't look like a phone number");
  }
  return found.matches.map((m) => ({
    kind: "value",
    type,
    fp: fingerprintStrong(salt, type, m),
    scheme: 2,
    mode: "protect",
  }));
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
  if (e.kind === "word") {
    return [
      e.words > 1 ? msg("vt_wordsHidden", "$1 words (hidden)", e.words) : msg("vt_wordHidden", "1 word (hidden)"),
    ];
  }
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
  // Re-saving a value needs it typed again (a one-way hash can't be upgraded in place), so this only ever
  // offers; it never removes a weaker entry on its own.
  $("strengthen-offer").hidden = !vault.some((e) => e.kind === "value" && e.scheme !== 2);
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
      if (missing.length) {
        status(
          yes
            ? ""
            : msg(
                "vt_allowNo",
                "Your browser didn't allow it, so Clotr still can't warn you in those AI chats. Use the button to ask again.",
              ),
        );
      }
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
    copiedTimer = setTimeout(() => (button.textContent = msg("vault_copyKey", "Copy")), 1500);
  });
  pinStepsForThisBrowser();
  // Pinned yet? The browser can tell us (Chrome/Edge/Brave; older browsers keep the instructions).
  const checkPinned = async () => {
    const settings = await chrome.action.getUserSettings?.().catch(() => null);
    if (!settings?.isOnToolbar) return false;
    $("pin-step").replaceChildren(
      msg("vt_pinned", "✓ Clotr is pinned. Its count shows on Clotr's icon in your toolbar."),
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

// The page's pin steps are Chrome's and Brave's (the puzzle piece, then the pin). Firefox and Edge tuck the
// pin elsewhere in the same extensions menu, so their steps are swapped in here, using the same browser test
// as the Rate Clotr link. Phones keep their own line.
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

// "Where should Clotr check?": the highlighted choice names the built-in AI chat sites, with its count read
// from ai-sites.json. The other asks for the broad permission in the same click, the same flow Settings' own
// "Everywhere I type" switch uses; on a yes the card keeps only its title and a ✓ On line, so the person sees it took.
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
// Simpler than that one: nothing here is ever already off-to-be-removed, since the popup's Settings is where
// an already-on site gets switched off again.
async function mountMoreSitesOffer(card) {
  const groups = card.querySelector("#ms-groups");
  const go = card.querySelector("#ms-go");
  const status = card.querySelector("#ms-status");
  const rows = new Map(); // site name → { box, tag }
  let on = new Set();
  let asking = false;

  groups.replaceChildren(
    ...[
      [Sites.SEARCH_SITES, msg("ms_search", "Search engines")],
      [Sites.SUPPORT_SITES, msg("ms_support", "Support chats on websites")],
    ].map(([list, legend]) =>
      el("fieldset", { className: "ev-group" }, [
        el("legend", { textContent: legend }),
        ...list.map((s) => {
          const box = el("input", { type: "checkbox", value: s.name });
          const tag = el("span", { className: "ev-tag", textContent: msg("ev_on", "On"), hidden: true });
          rows.set(s.name, { box, tag });
          box.addEventListener("change", update);
          return el("label", { className: "ev-app" }, [box, el("span", { textContent: s.name }), tag]);
        }),
      ]),
    ),
  );

  const added = () => [...rows].filter(([name, r]) => r.box.checked && !on.has(name)).map(([name]) => name);
  function update() {
    const toAdd = added();
    go.hidden = on.size === rows.size;
    go.setAttribute("aria-disabled", String(!toAdd.length || asking));
    go.textContent =
      toAdd.length <= 2 && toAdd.length
        ? msg("ev_switchOnNames", "Switch on $1", globalThis.ClotrEverydayOffer.listOf(toAdd))
        : toAdd.length
          ? msg("ev_switchOnCount", "Switch on $1 apps", toAdd.length)
          : msg("ev_switchOn", "Switch on");
  }
  function setOn(names) {
    const now = new Set(names);
    for (const [name, { box, tag }] of rows) {
      const isOn = now.has(name);
      box.checked = isOn;
      box.disabled = isOn; // already on: switched off again in Settings, not here
      box.parentElement.classList.toggle("on", isOn);
      tag.hidden = !isOn;
    }
    on = now;
    update();
  }
  // A site switched on while Everywhere I type covered it counts (userSitePatterns), and one it covers shows On.
  async function refresh() {
    const [{ origins = [] }, listed] = await Promise.all([chrome.permissions.getAll(), Sites.userSitePatterns()]);
    setOn([...new Set([...Sites.grantedMoreSites(listed), ...Sites.coveredByEverywhere(Sites.MORE_SITES, origins)])]);
  }

  go.addEventListener("click", () => {
    if (asking) return;
    const toAdd = added();
    if (!toAdd.length) return;
    chrome.storage.local.set({ moreSitesOffer: "done" }).catch(() => {});
    asking = true;
    status.textContent = "";
    Sites.requestMoreSites(toAdd).then(async (yes) => {
      asking = false;
      if (!yes) {
        await refresh().catch(() => {});
        status.textContent = msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        );
      } else {
        const next = new Set(on);
        for (const name of toAdd) next.add(name);
        setOn([...next]);
        status.textContent = msg(
          "ev_onFor",
          "✓ On for $1, in tabs you already have open too.",
          globalThis.ClotrEverydayOffer.listOf(toAdd),
        );
      }
      status.classList.toggle("done", yes);
    });
  });

  chrome.permissions.onAdded?.addListener(() => refresh().catch(() => {}));
  chrome.permissions.onRemoved?.addListener(() => refresh().catch(() => {}));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.siteScopes) refresh().catch(() => {});
  });
  update();
  await refresh().catch(() => {});
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
