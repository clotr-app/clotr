// Clotr — content script.
//
// Watches AI chat inputs and scans their text locally against Clotr.PATTERNS.
// What happens on a detection depends on the pattern's response (patterns.js):
// block → a modal dialog the user must answer (Hide it / Leave it in), sending
// waits; warn → a corner notice that doesn't block; log → counted quietly; off → ignored.
// Nothing leaves the browser: no network calls. Settings and event metadata
// (never the detected values) are kept in chrome.storage.local.
// What the person sees (the dialog, the notice, the offers) is drawn by warning-ui.js; this file decides
// when to show it and what each choice does.
(() => {
  "use strict";

  const LOG = "[Clotr]";

  // Already running here (e.g. injected into an open tab right after the user added this site).
  if (globalThis.__clotrActive) return;
  globalThis.__clotrActive = true;

  const { detect, redact, generalize, responseFor, fingerprint, setVault, readAttachment, readBandageLabels, msg } =
    globalThis.Clotr;
  const { realTarget, findEditor, getText, replaceText } = globalThis.Clotr.editor;
  const IS_TOP = window === window.top;

  console.info(LOG, "active on", location.href, IS_TOP ? "(top frame)" : "(iframe)");

  // ---------- Fail open (D30) ----------
  // After an update reload, this page's copy of Clotr keeps running but is orphaned:
  // every extension call throws "Extension context invalidated". Extension calls go
  // through these helpers so they can never throw into the chat or Clotr's own UI.
  function message(msg) {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function orphaned() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  // An orphaned copy keeps protecting with the settings it last knew, but only warns:
  // it never holds a message and records nothing (D37). Reloading the page brings in
  // the new version.
  let orphanLogged = false;
  function noteOrphaned() {
    if (!orphanLogged)
      console.info(LOG, "Clotr was updated; this page keeps warning with the old copy until it's reloaded");
    orphanLogged = true;
  }

  // Seamless updates (D39): after an update the background starts the new version in open
  // tabs. The new copy runs in a fresh script world, so it announces itself with a page
  // event; an orphaned older copy hears it and steps aside. A page faking the event can't
  // switch off a working copy: only an orphaned one listens to it.
  let retired = false;
  document.addEventListener("clotr:hello", () => {
    if (!retired && orphaned()) retire();
  });
  document.dispatchEvent(new CustomEvent("clotr:hello"));

  function retire() {
    retired = true;
    clearTimeout(scanTimer);
    stopWatchingLabels();
    ui.retire();
    console.info(LOG, "the updated Clotr took over this page");
  }

  // Lets the toolbar show the protected icon + today's count for this tab.
  function reportTabState() {
    if (!IS_TOP) return;
    message({ type: "clotr:tabState", paused: isPaused() }).catch((err) =>
      console.warn(LOG, "could not update toolbar", err),
    );
  }

  // ---------- Self-check: does Clotr see the chat box here, and did its last edit work? ----------
  // Reported to the background (per tab, any frame), which the popup and toolbar read.
  const health = { editor: false, editFailed: false, uiRemoved: false };

  // ---------- The warning UI (warning-ui.js) ----------
  // It draws what the person sees; the callbacks below are what their choices do. Created here, after the hello
  // above, so an older copy's warnings stepping aside aren't taken for the page removing Clotr's.
  const ui = globalThis.Clotr.ui.create({
    safely,
    orphaned,
    retired: () => retired,
    editor: () => activeEditor,
    largeText: () => largeText,
    everyday: () => everyday,
    bandageUnasked: () => bandage === undefined,
    canRemember: () => Boolean(saltValue),
    isVaultType: (id) => VAULT_TYPES.has(id),
    isGuided: (id) => Boolean(guided[id]),
    markGuided,
    responseOf: (id) => responseOf(id),
    setResponse,
    setToLog,
    addToVault,
    answerBandage,
    removedByPage,
    // A hotspot keeps the chat it was made for: its detail comes from that chat only (BN20).
    currentChat: () => bandageChat(),
    realValue: (label, chat) => chat?.byLabel.get(label),
    realText: bandageRealText,
  });

  // One of Clotr's own boxes vanished without Clotr removing it: the page is removing Clotr's warnings
  // (hostile, or a framework rebuilding the page). Stop holding messages there so nobody is stuck (D30, HP1)
  // and say so.
  function removedByPage(node) {
    if (!health.uiRemoved && !retired) {
      console.info(LOG, "this page removed Clotr's warning; messages won't be held here");
      reportHealth({ uiRemoved: true });
    }
    // The dialog had the keyboard: give it back to the chat box so the user can carry on.
    if (node.nodeName === "CLOTR-GUARD" && activeEditor?.isConnected) activeEditor.focus();
  }
  function reportHealth(change) {
    Object.assign(health, change);
    message({ type: "clotr:health", ...change }).catch(() => {}); // orphaned copy: nothing to report
  }
  function noteEditor() {
    if (!health.editor) reportHealth({ editor: true });
  }
  // A chat box on the page (textarea or rich editor, also inside open shadow roots), without
  // waiting for the user to type. Checked for a while after load; focus and typing catch the rest.
  // Returns the chat box (or null).
  function findChatBox(root = document, depth = 0) {
    for (const node of root.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) {
      if (node.getClientRects().length && findEditor(node)) return findEditor(node);
    }
    if (depth > 2) return null;
    for (const node of root.querySelectorAll("*")) {
      const inside = node.shadowRoot && findChatBox(node.shadowRoot, depth + 1);
      if (inside) return inside;
    }
    return null;
  }

  // "Test Clotr here" (popup): outline the chat box Clotr watches for a moment. Nothing is typed,
  // sent or recorded; the outline never takes clicks and removes itself.
  function showChatBox() {
    const box = activeEditor?.isConnected ? activeEditor : findChatBox();
    if (!box) return { found: false };
    ui.outline(box);
    noteEditor();
    return { found: true };
  }
  let chatBoxChecks = 0;
  function lookForChatBox() {
    if (health.editor || retired) return;
    try {
      if (document.documentElement && findChatBox()) return noteEditor();
    } catch {
      /* never let the self-check break the page */
    }
    if (++chatBoxChecks < 15) setTimeout(lookForChatBox, 2000);
  }
  setTimeout(lookForChatBox, 500);
  window.addEventListener(
    "focusin",
    safely((e) => {
      if (!health.editor && findEditor(realTarget(e))) noteEditor();
    }),
    true,
  );

  // Send buttons on ChatGPT, Claude/Gemini and NotebookLM respectively, plus generic forms.
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
    'form button[type="submit"]',
  ].join(",");

  const SCAN_DELAY_MS = 400; // wait for typing to pause so half-typed keys don't trigger

  // Did the person do this (S24)? A page could otherwise put guesses in its own chat box by script,
  // fire a fake input or Enter, and watch whether Clotr's warning appears: that would tell it which
  // names or numbers are in your vault. Events a script makes right after a real key or click (sites
  // re-dispatch them) still count; where the browser can't tell, Clotr reacts as before.
  const byUser = (e) => e.isTrusted || navigator.userActivation?.isActive !== false;

  // ---------- Per-pattern responses (set in the popup, or "stop warning me about this kind" = log) ----------

  let responses = {}; // overrides only: { [patternId]: "block" | "warn" | "log" }

  // Per-site mode (popup → per-site view): "block" = stricter here, "log" = quieter here.
  let siteMode = null; // this site's mode, or null
  const responseOf = (patternId) => {
    const r = responseFor(patternId, responses);
    return siteMode || r;
  };

  function setToLog(patternIds) {
    setResponse(patternIds, "log");
    console.info(LOG, "won't warn again for", patternIds);
  }

  function setResponse(patternIds, value) {
    responses = { ...responses };
    for (const id of patternIds) responses[id] = value;
    try {
      message({ type: "clotr:setResponses", ids: patternIds, value }).catch((err) =>
        console.warn(LOG, "could not save preference", err),
      );
    } catch (err) {
      console.warn(LOG, "could not save preference", err);
    }
  }

  // ---------- Pause per site (toggled from the popup) ----------

  let paused = {};

  function isPaused() {
    return Boolean(paused[location.hostname]);
  }

  // ---------- Your vault (fingerprints only; see patterns.js setVault) ----------
  // Value entries (phone, email, address, …) mark something the regular patterns find as
  // yours: "protect" = always at least warn, even if that type is set to Log only;
  // "allow" = OK to share: never warns, still recorded (as "Just counted") like everything else. Words and ID formats are matched in patterns.js.

  let vaultEntries = [];
  const vaultCache = new Map(); // "type\0match" → "protect" | "allow" | null, hashed once per page

  function applyVault() {
    vaultCache.clear();
    setVault({ salt: saltValue, entries: vaultEntries });
  }

  function vaultMode(patternId, match) {
    if (!saltValue || !vaultEntries.some((e) => e.kind === "value")) return null;
    const key = `${patternId}\0${match}`;
    if (!vaultCache.has(key)) {
      if (vaultCache.size >= 2000) vaultCache.clear(); // a tab left open all day stays small
      const entry = (id) => {
        const fp = fingerprint(saltValue, id, match);
        return vaultEntries.find((e) => e.kind === "value" && e.type === patternId && e.fp === fp);
      };
      // An address saved before 0.9.68 kept its accents in the fingerprint: it still matches as typed.
      const found =
        entry(patternId) ||
        (patternId === "street_address" && /[^\x00-\x7f]/.test(match) && entry("street_address_accented"));
      vaultCache.set(key, found?.mode || null);
    }
    return vaultCache.get(key);
  }

  // With a fingerprint of your own ID in the vault (D23), IDs that only share its format are
  // named apart ("Account/ID Number") and ranked lower than yours ("Your Account/ID Number").
  function splitOwnIds(results) {
    if (!saltValue || !vaultEntries.some((e) => e.kind === "value" && e.type === "my_id")) return results;
    return results.flatMap((r) => {
      if (r.id !== "my_id") return [r];
      const own = r.matches.filter((m) => vaultMode("my_id", m));
      const other = r.matches.filter((m) => !vaultMode("my_id", m));
      return [
        ...(own.length ? [{ ...r, matches: own }] : []),
        ...(other.length
          ? [{ ...r, matches: other, name: msg("otherAccountId", "Account/ID Number"), severity: "medium" }]
          : []),
      ];
    });
  }

  // The response for one detected value: the type's response, adjusted by the vault.
  function respFor(r, m) {
    const mode = vaultMode(r.id, m);
    if (mode === "allow") return "log";
    const base = responseOf(r.id);
    return mode === "protect" && base === "log" ? "warn" : base;
  }

  // First-time tips (D21, D43): kinds of data the user has already been guided about.
  let guided = {};
  function markGuided(id) {
    guided = { ...guided, [id]: Date.now() };
    message({ type: "clotr:guided", id }).catch(() => {});
  }
  // Helping someone (settings → "Larger warnings"): bigger text and buttons in Clotr's boxes.
  let largeText = false;
  let replyCheck = true; // Settings → "Check the AI's replies for my details" (D63)
  let bandage; // Bandage on this site (D93): true on, false the user said no, undefined not asked yet
  let everyday = false; // an email or chat app you switched on (D134): your words go to people, not to an AI

  // Settings come from the background (storage is locked to Clotr's own pages, S20): only what
  // this frame needs, its own site's pause and mode included. Fetched at start, when the background
  // says something changed, and when the tab is shown again.
  let settingsLoaded = false;
  function loadSettings() {
    return message({ type: "clotr:getSettings" })
      .then((r) => {
        if (!r || r.error) throw new Error(r?.error || "no settings");
        const wasPaused = isPaused();
        guided = r.guided || {};
        largeText = r.largeText === true;
        replyCheck = r.replyCheck !== false;
        bandage = typeof r.bandage === "boolean" ? r.bandage : undefined;
        safely(watchLabels)(); // on: read the labels the conversation already holds (after a reload); off: stop
        everyday = r.everyday === true;
        if (!replyCheck) closeReplyWindow(); // switched off: a reply already on its way isn't read either
        responses = r.responses || {};
        siteMode = r.siteMode || null;
        vaultEntries = Array.isArray(r.vault) ? r.vault : [];
        applyVault();
        paused = r.paused ? { [location.hostname]: true } : {};
        if (!settingsLoaded) {
          settingsLoaded = true;
          console.info(LOG, "responses:", JSON.stringify(responses), isPaused() ? "(paused on this site)" : "");
          return;
        }
        if (wasPaused === isPaused()) return;
        console.info(LOG, isPaused() ? "paused on this site" : "resumed on this site");
        reportTabState();
        if (isPaused()) {
          ui.closeDialog();
          ui.closeNotice();
          pending = [];
          warnings = [];
          fileWarnings = [];
        }
      })
      .catch((err) => console.warn(LOG, "could not load preferences", err));
  }
  loadSettings().finally(reportTabState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !retired) loadSettings();
  });

  // ---------- Event reporting (metadata only) ----------

  // Salted SHA-256 of the normalized value, computed here so the raw value never leaves
  // this script. Lets the popup spot "same secret pasted again" without storing it.
  let saltPromise = null;
  let saltValue = null; // set once loaded, for the synchronous "It's me" check
  function getSalt() {
    saltPromise ??= message({ type: "clotr:getSalt" })
      .then((r) => {
        if (!r?.salt) throw new Error(r?.error || "no salt");
        saltValue = r.salt;
        applyVault();
        return r.salt;
      })
      .catch((err) => {
        saltPromise = null; // retry next time
        throw err;
      });
    return saltPromise;
  }

  getSalt().catch((err) => console.warn(LOG, "could not load salt", err));

  // One event per detected value. `via`: how a "redacted" event happened ("bandage" apart from
  // hand-hidden), so the report can count what Bandage kept apart from what you hid yourself.
  async function report(results, action, via) {
    if (orphaned()) return; // nothing can be recorded after an update (D37)
    try {
      const t = Date.now();
      const salt = await getSalt();
      const events = [];
      for (const r of results) {
        for (const m of r.matches) {
          events.push({
            t,
            site: location.hostname,
            type: r.id,
            name: r.name,
            severity: r.severity,
            action,
            fp: fingerprint(salt, r.id, m),
            ...(via ? { via } : {}),
          });
        }
      }
      if (events.length) await message({ type: "clotr:events", events });
    } catch (err) {
      console.warn(LOG, "could not record event", err);
    }
  }

  // ---------- State ----------

  // Both last for the message being written (DECISIONS D3): once it's sent or the box is
  // emptied, the next message warns (and logs) again like normal.
  const allowedValues = new Set(); // values the user kept ("Leave it in" in the dialog or notice) in this message
  const loggedSilenced = new Set(); // log-only values already recorded for this message
  function newMessage() {
    backToEdit = false;
    allowedValues.clear();
    loggedSilenced.clear();
    bandageFailed.clear();
  }
  let activeEditor = null; // the chat input the user last typed in
  let pending = []; // "block" detections the user hasn't answered yet
  let warnings = []; // "warn" detections shown in the notice, not yet answered
  let fileWarnings = []; // detections in attached files, not yet acknowledged
  const flagged = new Map(); // value → { id, name }: shown to the user and still in the text
  const offered = new Set(); // values already offered for the vault on this page
  // Types that come from the vault itself (nothing to learn there).
  const VAULT_TYPES = new Set(["my_name", "family_name", "employer", "my_id", "watch_list"]);
  let scanTimer = null;
  let backToEdit = false; // the user went back to the message from the dialog: don't reopen it until they send
  let heldVia = null; // while a send attempt is checked: what it used (the chat box for Enter, a button, a form)

  // ---------- Bandage (D93): cover names while you type ----------
  // On a site where the user said yes, personal details become labels in brackets ([Phone 1], [Me]) as soon as typing
  // pauses, the same label for the same detail within one chat. Passwords and keys are never covered: they keep their
  // warning. The label ↔ detail map lives only in this page's memory, keyed by fingerprint; nothing is stored. A reload
  // forgets it, but the conversation still holds the labels given before: Clotr reads them from the page and numbers
  // new details after them, so one label never stands for two details (D27; "after a reload" below).
  const bandageChats = new Map(); // conversation path → newBandageChat()
  const newBandageChat = () => ({
    byKey: new Map(), // fingerprint → label
    byLabel: new Map(), // label → detail, for the labels this page gave
    counts: {}, // label kind (bl_phone…) → the highest number given here or found on the page
    given: new Set(), // ids (readBandageLabels) of the labels this page gave
    seen: new Set(), // ids of the labels found on the page
    read: false, // the whole page has been read for labels since this chat began (or Bandage came on)
  });
  const bandageFailed = new Set(); // details this chat box wouldn't let Clotr cover: they get the normal warning
  let bandagePath = null;
  let bandageCurrent = null; // the chat bandageChat() gave last: another one means the conversation changed
  let bandaging = false; // a swap is under way: a send waits for it
  let bandageHeldSend = false; // a send was held for the swap: say so once it's done
  let bandageRounds = [];
  // Typing through an input method (Japanese, Chinese, Korean…): never swap text in the middle of a composition,
  // which would scramble it; the scan right after it ends covers the details (e2e BN13).
  let composing = false;
  addEventListener("compositionstart", () => (composing = true), true);
  addEventListener(
    "compositionend",
    safely(() => {
      composing = false;
      if (!activeEditor?.isConnected) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(
        safely(() => scan(activeEditor)),
        SCAN_DELAY_MS,
      );
    }),
    true,
  );

  // A chat's page before its first message ("/", "/new", "/app") has no id in its path; the first send moves the page
  // to the conversation's own path, which keeps the labels already given.
  const isStartPage = (path) => !path.split("/").some((part) => part.length >= 8 && /\d/.test(part));
  function bandageChat() {
    const path = location.pathname;
    if (path !== bandagePath) {
      const from = bandagePath;
      if (from && bandageChats.has(from) && !bandageChats.has(path) && isStartPage(from) && !isStartPage(path)) {
        bandageChats.set(path, bandageChats.get(from));
        bandageChats.delete(from);
      }
      bandagePath = path;
    }
    if (!bandageChats.has(path)) bandageChats.set(path, newBandageChat());
    const chat = bandageChats.get(path);
    if (chat !== bandageCurrent) {
      const left = bandageCurrent;
      bandageCurrent = chat;
      if (left) bandageSwitched(chat);
    }
    return chat;
  }

  // The conversation changed without a reload (the site's sidebar, back and forward, a new chat; not the first send
  // moving a new chat to its own address, which keeps its chat). The same label stands for a different detail in each
  // chat, and the old chat's messages can stay on the page for a moment, so every hotspot goes now: they were all made
  // for the chat you left (each also keeps its own chat, so none can show this one's details). The page is read whole
  // again for this chat's labels, and the answer being waited for belongs to the chat you left: its labels aren't
  // marked here.
  function bandageSwitched(chat) {
    ui.clearSpots();
    chat.read = false;
    labelWatch.nodes.clear();
    labelWatch.unseen.clear();
    if (labelWatch.observer && !labelWatch.timer) labelWatch.timer = setTimeout(safely(bandageReadPage), LABEL_READ_MS);
    replyChat = null;
    replyNodes.clear();
  }

  // Label words, per kind of detail; anything else personal is an ID. The kind (the word's message key) numbers the
  // labels in any language, so a "[Teléfono 1]" from before makes the next phone "[Phone 2]".
  function bandageWord(id) {
    switch (id) {
      case "my_name":
        return ["bl_me", msg("bl_me", "Me")];
      case "employer":
        return ["bl_company", msg("bl_company", "My company")];
      case "family_name":
        return ["bl_family", msg("bl_family", "Family")];
      case "street_address":
        return ["bl_address", msg("bl_address", "Address")];
      case "phone_number":
        return ["bl_phone", msg("bl_phone", "Phone")];
      case "email":
        return ["bl_email", msg("bl_email", "Email")];
      case "date_of_birth":
        return ["bl_birth", msg("bl_birth", "Birth date")];
      case "credit_card":
        return ["bl_card", msg("bl_card", "Card")];
      case "bank_account":
        return ["bl_account", msg("bl_account", "Account")];
      case "public_ip":
        return ["bl_ip", msg("bl_ip", "IP address")];
      case "watch_list":
        return ["bl_term", msg("bl_term", "Term")];
      default:
        return ["bl_id", msg("bl_id", "ID")];
    }
  }

  // The same id for one label in any language or case (detector.js); the label itself if it isn't one.
  const labelId = (label) => readBandageLabels(label)[0]?.id ?? label;

  function bandageLabel(r, value) {
    const chat = bandageChat();
    const key = saltValue ? fingerprint(saltValue, r.id, value) : `${r.id}\0${value}`;
    if (chat.byKey.has(key)) return chat.byKey.get(key);
    bandageReadPage(); // first, what the page shows now: a label the conversation already holds is never given again
    let label = null;
    // A birth date with a written year keeps its decade, so the AI can still reason about age.
    const year = r.id === "date_of_birth" && value.match(/\b(19|20)\d\d\b/);
    if (year) label = `[${msg("bl_bornIn", "born in the $1s", String(Math.floor(Number(year[0]) / 10) * 10))}]`;
    if (!label || chat.byLabel.has(label) || chat.seen.has(labelId(label))) {
      const [kind, word] = bandageWord(r.id);
      const n = (chat.counts[kind] || 0) + 1;
      chat.counts[kind] = n;
      // "Me" and "My company" stand alone; everything else is numbered.
      label = (r.id === "my_name" || r.id === "employer") && n === 1 ? `[${word}]` : `[${word} ${n}]`;
    }
    chat.byKey.set(key, label);
    chat.byLabel.set(label, value);
    chat.given.add(labelId(label));
    return label;
  }

  // ---------- Bandage after a reload: the labels the conversation already holds (D27) ----------
  // Nothing is stored, so after a reload Clotr no longer knows which detail an earlier label stood for, but the page
  // still shows those labels (your messages and the AI's replies). While Bandage is on here, Clotr reads them: the whole
  // page once per chat, then only what changed (the observer just collects changed nodes; they're read at most twice a
  // second, and right before a new label is given). Each kind's numbering continues after the highest number found, and
  // a label this page didn't give gets a hotspot whose bubble says Clotr didn't keep its detail, never another one.
  // A label skipped because its text wasn't visible yet is looked at again every LABEL_READ_MS, for up to
  // UNSEEN_TRIES reads (about 10 seconds): a fade-in changes only a style, which the observer doesn't see, so the
  // hotspot waited for some other change on the page, 4 to 5 seconds on ChatGPT (R96). Text that stays hidden (a
  // screen reader's copy) runs out of tries and never gets one.
  const labelWatch = { observer: null, nodes: new Set(), timer: 0, unseen: new Set(), tries: 0 };
  const LABEL_READ_MS = 500;
  const UNSEEN_TRIES = 20;
  const MAX_CHANGED = 500; // more changed nodes than this before a read: read the whole page instead
  const NO_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

  function watchLabels() {
    const on = bandageOn() && !retired;
    if (!on || labelWatch.observer) {
      if (!on) stopWatchingLabels();
      return;
    }
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", safely(watchLabels), { once: true });
      return;
    }
    for (const chat of bandageChats.values()) chat.read = false; // what changed while it was off is read again
    labelWatch.observer = new MutationObserver(
      safely((records) => {
        bandageChat(); // the page changed: if its chat did too, the old chat's hotspots go now (bandageSwitched)
        for (const rec of records) {
          const nodes = rec.type === "characterData" ? [rec.target] : rec.addedNodes;
          for (const n of nodes) {
            const root = n.nodeType === 3 ? n.parentNode : n.nodeType === 1 ? n : null;
            if (root) labelWatch.nodes.add(root);
          }
        }
        if (labelWatch.nodes.size > MAX_CHANGED) {
          labelWatch.nodes.clear();
          bandageChat().read = false;
        }
        if (!labelWatch.timer) labelWatch.timer = setTimeout(safely(bandageReadPage), LABEL_READ_MS);
      }),
    );
    labelWatch.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    labelWatch.timer = setTimeout(safely(bandageReadPage), 0);
  }

  function stopWatchingLabels() {
    labelWatch.observer?.disconnect();
    labelWatch.observer = null;
    labelWatch.nodes.clear();
    labelWatch.unseen.clear();
    clearTimeout(labelWatch.timer);
    labelWatch.timer = 0;
  }

  // Reads the labels the page gained since the last read (the whole page the first time in a chat).
  function bandageReadPage() {
    clearTimeout(labelWatch.timer);
    labelWatch.timer = 0;
    if (!bandageOn() || retired || !document.body) return;
    const chat = bandageChat();
    const retry = [...labelWatch.unseen];
    labelWatch.unseen.clear();
    const roots = chat.read ? [...labelWatch.nodes, ...retry] : [document.body];
    chat.read = true;
    labelWatch.nodes.clear();
    let spots = 0;
    for (const root of roots) {
      try {
        if (root.isConnected) spots += bandageReadLabels(root, chat);
      } catch (err) {
        console.warn(LOG, "Bandage couldn't read the labels on the page", err);
      }
    }
    if (spots) ui.placeSpots();
    if (!labelWatch.unseen.size) labelWatch.tries = 0;
    else if (++labelWatch.tries <= UNSEEN_TRIES) labelWatch.timer = setTimeout(safely(bandageReadPage), LABEL_READ_MS);
    else labelWatch.unseen.clear();
  }

  // Notes the labels in `root`'s text: each kind's highest number, and which ones this page didn't give. The text is
  // read whole, so a label a site splits across elements still counts. Returns the hotspots added.
  function bandageReadLabels(root, chat) {
    let older = false;
    for (const f of readBandageLabels(root.textContent)) {
      if (f.n) chat.counts[f.kind] = Math.max(chat.counts[f.kind] || 0, f.n);
      chat.seen.add(f.id);
      if (!chat.given.has(f.id)) older = true;
    }
    return older ? bandageSpotOlder(root, chat) : 0;
  }

  // A hotspot over each visible label in `root` that this page didn't give: its bubble says the detail wasn't kept.
  function bandageSpotOlder(root, chat) {
    let added = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const parent = t.parentElement;
      if (!t.nodeValue.includes("[") || !parent || NO_TEXT.has(parent.nodeName)) continue;
      const older = readBandageLabels(t.nodeValue).filter((f) => !chat.given.has(f.id) && !ui.hasSpot(t, f.index));
      if (!older.length || !validReplyNode(parent)) continue;
      if (unseenText(parent)) {
        labelWatch.unseen.add(parent); // fading in (as ChatGPT's messages do after a reload): looked at again soon
        continue;
      }
      for (const f of older) {
        if (!ui.addSpot(t, f.index, f.label, root, chat, true)) return added; // enough of them already
        added++;
      }
    }
    return added;
  }

  // What Bandage covers: personal details and watch words the user hasn't marked fine to share.
  const bandageOn = () => bandage === true && !orphaned();
  const coverable = (r, m) =>
    r.group !== "credentials" && !bandageFailed.has(m) && !allowedValues.has(m) && respFor(r, m) !== "log";

  // Swaps the details in `text` (the chat box's text right now) for their labels. If the box won't take the edit,
  // those details fall back to the normal warning (D30: never stuck, never silent).
  async function bandageCover(editor, text, results) {
    const now = Date.now();
    bandageRounds = bandageRounds.filter((t) => now - t < 2000).concat(now);
    const pairs = results
      .flatMap((r) => r.matches.map((m) => [m, bandageLabel(r, m)]))
      .sort((a, b) => b[0].length - a[0].length);
    let next = text;
    for (const [m, label] of pairs) next = next.split(m).join(label);
    // A swap that changes nothing, or keeps finding more to swap, would never end: warn instead.
    const stuck = next === text || bandageRounds.length > 5;
    bandaging = true;
    let ok = false;
    try {
      ok = !stuck && (await setText(editor, next));
    } catch (err) {
      console.warn(LOG, "Bandage couldn't edit the chat box", err);
    } finally {
      bandaging = false;
    }
    if (ok) {
      console.info(
        LOG,
        "Bandage covered",
        results.map((r) => r.id),
      );
      report(results, "redacted", "bandage");
      if (bandageHeldSend) {
        bandageHeldSend = false;
        ui.tellCovered();
      }
    } else if (stuck || getText(editor) === text) {
      bandageHeldSend = false;
      for (const r of results) for (const m of r.matches) bandageFailed.add(m);
      if (!stuck) reportHealth({ editFailed: true });
    }
    if (editor.isConnected) scan(editor);
  }

  function setBandageHere(on) {
    bandage = on;
    safely(watchLabels)();
    message({ type: "clotr:setBandage", on }).catch(() => {});
  }

  // The answer to the Bandage offer in the warning (D93), the first time a personal detail shows up on a site.
  function answerBandage(on) {
    setBandageHere(on);
    if (on) {
      console.info(LOG, "Bandage on for this site");
      if (activeEditor?.isConnected) {
        scan(activeEditor);
        activeEditor.focus();
      } else ui.closeNotice();
    } else {
      console.info(LOG, "Bandage declined for this site");
      if (warnings.length) warn(warnings);
      else ui.closeNotice();
    }
  }

  // ---------- Detection ----------

  // Keeps only the matches in `results` that pass `keep`, dropping empty results.
  function filterMatches(results, keep) {
    return results.map((r) => ({ ...r, matches: r.matches.filter((m) => keep(r, m)) })).filter((r) => r.matches.length);
  }

  // ---------- Editor helpers (editor.js) ----------

  // Replaces the chat box's text; true only if it really changed. Clotr's own edit isn't
  // something to rescan, and nothing in it was removed by hand.
  async function setText(editor, text) {
    try {
      return await replaceText(editor, text);
    } finally {
      clearTimeout(scanTimer);
      flagged.clear();
    }
  }

  // Hide the found items in the chat box, or with `general`, swap a birth date for its month and year and an
  // address for its town (the rest is hidden). Counted as hidden only once the text really changed; otherwise say
  // so plainly, so nobody sends a key they think is gone (Kimi, M2). Either way the exact detail never goes out.
  async function coverIn(editor, results, general = false) {
    const text = editor ? getText(editor) : "";
    const next = general ? generalize(text, results, navigator.language) : redact(text, results);
    const ok = Boolean(editor) && (await setText(editor, next));
    if (ok) {
      report(results, "redacted");
      if (health.editFailed) reportHealth({ editFailed: false });
      return;
    }
    reportHealth({ editFailed: true });
    ui.tellCoverFailed(results);
  }

  // ---------- What the person's choices do (warning-ui.js draws them) ----------
  // Every warning offers: this time only (Hide it / Leave it in), and from now on, for this
  // item (vault fingerprint: "fine to share" or "always watch") or for this kind of data (D40).

  function addToVault(results, mode) {
    const entries = results.flatMap((r) =>
      r.matches.map((m) => ({
        kind: "value",
        type: r.id,
        fp: fingerprint(saltValue, r.id, m),
        mode,
        added: Date.now(),
      })),
    );
    message({ type: "clotr:vaultAdd", entries }).catch((err) => console.warn(LOG, "could not add to vault", err));
  }

  // "Ask before sending": one decision for everything found, the warn-level items included.
  function askFirst(results) {
    // Opened by a send attempt: leaving it in sends the message (D121).
    const resend = heldVia;
    const answer = (doRedact, general = false) => {
      if (doRedact) {
        ui.closeDialog();
        ui.closeNotice();
        flagged.clear(); // removed by Clotr, not by hand: nothing to learn
        coverIn(activeEditor, results, general);
      } else {
        report(results, "allowed");
        for (const r of results) for (const m of r.matches) allowedValues.add(m);
        ui.closeDialog();
        ui.closeNotice();
        activeEditor?.focus();
        noteIgnored(results);
      }
      console.info(
        LOG,
        doRedact ? (general ? "user generalized" : "user redacted") : "user allowed once",
        results.map((r) => r.id),
      );
      pending = [];
      warnings = [];
      if (!doRedact && resend)
        setTimeout(
          safely(() => sendAgain(resend)),
          0,
        );
    };
    ui.showDialog(results, {
      resend: Boolean(resend),
      leave: () => answer(false),
      cover: () => answer(true),
      general: () => answer(true, true),
      // Back to the message without choosing (D41): the dialog comes back when you send.
      back: () => {
        ui.closeDialog();
        backToEdit = true;
        activeEditor?.focus();
      },
    });
  }

  // The corner warning (doesn't block, doesn't take focus). `file` = { name, lines } for an attached file: it can't
  // be redacted, only removed by the user.
  function warn(results, file = null) {
    ui.showNotice(results, file, {
      leave: () => {
        allowWarnings();
        activeEditor?.focus();
        noteIgnored(results);
      },
      cover: (general = false) => {
        ui.closeNotice();
        flagged.clear();
        coverIn(activeEditor, results, general);
        warnings = [];
        console.info(
          LOG,
          general ? "user generalized it (notice)" : "user hid it (notice)",
          results.map((r) => r.id),
        );
      },
    });
  }

  // ---------- Learning offers (local only): "add to your vault?", "warn less?" ----------

  // The user deleted flagged items by hand before sending: offer to always watch for them.
  function offerVault(removed) {
    const items = removed.filter(
      (f) => !offered.has(f.value) && !VAULT_TYPES.has(f.id) && vaultMode(f.id, f.value) === null,
    );
    if (!items.length || !saltValue) return;
    items.forEach((f) => offered.add(f.value));
    ui.offerVault(items, () =>
      message({
        type: "clotr:vaultAdd",
        entries: items.map((f) => ({
          kind: "value",
          type: f.id,
          fp: fingerprint(saltValue, f.id, f.value),
          mode: "protect",
          learned: true,
          added: Date.now(),
        })),
      })
        .then(() =>
          console.info(
            LOG,
            "learned vault items",
            items.map((f) => f.id),
          ),
        )
        .catch((err) => console.warn(LOG, "could not add to vault", err)),
    );
  }

  // The user kept (ignored) a warning. After a few of the same type, offer to relax it.
  function noteIgnored(results) {
    if (orphaned()) return;
    const types = [...new Set(results.map((r) => r.id))];
    message({ type: "clotr:ignored", types })
      .then((r) => {
        const id = r?.offer;
        const p = id && results.find((x) => x.id === id);
        if (!p || !["warn", "block"].includes(responseOf(id)) || ui.isDialogOpen()) return;
        ui.offerRelax(
          p.name,
          r.count,
          () => {
            setToLog([id]);
            message({ type: "clotr:relaxAnswer", id, accepted: true }).catch(() => {});
          },
          () => message({ type: "clotr:relaxAnswer", id, accepted: false }).catch(() => {}),
        );
      })
      .catch((err) => console.warn(LOG, "could not record choice", err));
  }

  // The user kept the warned items (clicked "Leave it in" or sent anyway): count them as allowed.
  function allowWarnings() {
    const kept = warnings.concat(fileWarnings);
    if (!kept.length) return;
    report(kept, "allowed");
    for (const r of kept) for (const m of r.matches) allowedValues.add(m);
    console.info(
      LOG,
      "user kept warned items",
      kept.map((r) => r.id),
    );
    warnings = [];
    fileWarnings = [];
    ui.closeNotice();
  }

  // ---------- Scanning & blocking ----------

  function scan(editor) {
    activeEditor = editor;
    const lost = orphaned(); // after an update: warn only, record nothing (D37)
    if (lost) {
      noteOrphaned();
      // No updated copy took over (D39 couldn't start it here): ask for a reload (D37).
      if (!ui.reloadAsked()) setTimeout(safely(ui.showReloadPrompt), 0);
    }
    if (isPaused()) return;
    const draft = getText(editor);
    if (!draft.trim()) newMessage();
    const all = splitOwnIds(detect(draft));
    noteTyped(all);

    // Log-only patterns don't interrupt, but are still counted (once per value per page).
    const silenced = filterMatches(all, (r, m) => respFor(r, m) === "log" && !loggedSilenced.has(m));
    if (silenced.length) {
      for (const r of silenced) for (const m of r.matches) loggedSilenced.add(m);
      report(silenced, "suppressed");
    }

    // Bandage: personal details become labels; they're neither warned about nor held.
    const covering = bandageOn() && !composing ? filterMatches(all, coverable) : [];
    const willCover = (r, m) => covering.some((c) => c.id === r.id && c.matches.includes(m));
    if (covering.length && !bandaging) bandageCover(editor, draft, covering);

    const open = (r, m) => !allowedValues.has(m) && !willCover(r, m);
    pending = filterMatches(all, (r, m) => respFor(r, m) === "block" && open(r, m));
    warnings = filterMatches(all, (r, m) => respFor(r, m) === "warn" && open(r, m));
    if (lost) {
      warnings = pending.concat(warnings);
      pending = [];
    }

    // Learning: flagged values that vanished while the message is still being written
    // were removed by hand.
    const text = getText(editor);
    const removed = [];
    for (const [value, f] of flagged) {
      if (text.includes(value)) continue;
      flagged.delete(value);
      // Edited into another value of the same type ("555-555-5636" → "…5637") isn't a removal.
      if (text.trim() && !all.some((r) => r.id === f.id)) removed.push({ value, ...f });
    }
    for (const r of all)
      for (const m of r.matches)
        if (respFor(r, m) !== "log" && !willCover(r, m)) flagged.set(m, { id: r.id, name: r.name });
    if (pending.length && backToEdit) {
      // Editing after "Go back to my message": the dialog returns when they send.
    } else if (pending.length) {
      // One decision for everything: the dialog also lists the warn-level items.
      console.info(
        LOG,
        "detected",
        pending.concat(warnings).map((r) => r.id),
      );
      ui.closeNotice();
      askFirst(pending.concat(warnings));
    } else {
      if (ui.isDialogOpen()) ui.closeDialog();
      if (warnings.length) {
        console.info(
          LOG,
          "warning about",
          warnings.map((r) => r.id),
        );
        warn(warnings);
      } else if (ui.isNoticeOpen() && ui.noticeKind() === "warn") {
        ui.closeNotice();
      }
      if (!warnings.length && removed.length && !lost) offerVault(removed);
    }
  }

  // Re-check right before a send, in case the debounced scan hasn't run yet.
  // Block-level items stop the send; warn-level items go through and count as allowed.
  // `unsure`: the click was on an unlabeled button in the chat box that may or may not send.
  // It can hold a message only for Ask before sending; for warnings nothing is recorded until
  // the box really empties (confirmSent), so an Attach or microphone click never counts.
  function shouldBlock(opts) {
    const held = shouldHold(opts);
    if (!held && activeEditor) openReplyWindow();
    return held;
  }

  function shouldHold({ unsure = false, via = null } = {}) {
    if (isPaused() || health.uiRemoved) return false; // a page removing Clotr's dialog must not leave you stuck
    if (ui.isDialogOpen()) {
      if (!orphaned()) return true;
      ui.closeDialog(); // opened before the update: an orphaned copy never holds a message
    }
    if (!activeEditor || !activeEditor.isConnected) return false;
    clearTimeout(scanTimer);
    backToEdit = false; // a send attempt brings the dialog back
    // Was a warning on screen long enough to read before this send? (fast paste-and-Enter)
    const seen = ui.isNoticeOpen() && ui.noticeKind() === "warn" && Date.now() - ui.noticeOpenedAt() >= SEEN_MS;
    heldVia = via || activeEditor;
    try {
      scan(activeEditor);
    } finally {
      heldVia = null;
    }
    if (bandaging) {
      // Typed fast: the details are being covered right now. This send waits; the next one sends the labels.
      bandageHeldSend = true;
      return true;
    }
    if (pending.length) return true;
    if (warnings.length && (!seen || unsure)) {
      confirmSent(activeEditor, warnings.slice(), !seen);
      return false;
    }
    if (unsure) return false;
    allowWarnings();
    flagged.clear(); // the message is going out: an emptied box isn't a removal
    // After this send attempt, not during it: a form's send button is two attempts (the click, then the
    // submit), and the second must still see what you allowed (A3b).
    setTimeout(() => retired || newMessage(), 0);
    return false;
  }

  // Warn never holds a message (D30). When it went out before the warning could be read,
  // say what went, right after, and offer to ask first next time (D52).
  const SEEN_MS = 1500;
  const CONFIRM_MS = 1200;
  // Only say "Just sent" (and record it) once the message really left: sites sometimes ignore
  // an Enter pressed too soon (Gemini did). If the text is still in the box, show the normal
  // warning instead, now that there's time to read it.
  function confirmSent(editor, results, tell = true) {
    const before = getText(editor).replace(/\s+/g, " ").trim();
    ui.closeNotice(); // the half-shown warning; it comes back if the message didn't go
    warnings = [];
    setTimeout(
      safely(() => {
        const now = editor.isConnected ? getText(editor).replace(/\s+/g, " ").trim() : "";
        if (now === before) {
          scan(editor);
          return;
        } // not sent
        report(results, "allowed");
        for (const r of results) for (const m of r.matches) allowedValues.add(m);
        flagged.clear();
        newMessage();
        if (tell) justSent(results);
      }),
      CONFIRM_MS,
    );
  }

  // "Leave it in and send" (D121): the dialog stopped a send, so leaving it in sends the message the
  // way it was sent: the button or form the user used; for Enter, the site's send button near the chat box
  // (a click works from a script on every site), else Enter again. If nothing sends, the text is still in
  // the box and the next Enter goes through: its details are allowed now.
  function sendAgain(via) {
    if (!via.isConnected || orphaned()) return;
    if (via instanceof HTMLFormElement) return via.requestSubmit();
    if (via !== activeEditor) return via.click();
    let area = via;
    for (let i = 0; i < 5 && area; i++) {
      area = area.parentElement || area.getRootNode().host;
      const btn = area?.querySelector(SEND_BUTTON_SELECTOR);
      if (btn && !btn.disabled) return btn.click();
    }
    const key = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    for (const type of ["keydown", "keypress", "keyup"]) via.dispatchEvent(new KeyboardEvent(type, key));
  }

  function justSent(results) {
    if (orphaned()) return;
    const types = [...new Set(results.map((r) => r.id))];
    ui.tellJustSent(results, () => setResponse(types, "block"));
  }

  function block(event, why) {
    event.preventDefault();
    event.stopImmediatePropagation();
    console.info(LOG, "blocked send via", why);
    ui.shakeDialog();
  }

  function safely(fn) {
    return (event) => {
      if (retired) return; // a newer copy handles this page now
      try {
        fn(event);
      } catch (err) {
        console.error(LOG, "handler error", err);
      }
    };
  }

  // Capture-phase listeners on window run before the site's own handlers.
  const onTyping = safely((e) => {
    if (isPaused() || globalThis.Clotr.editor.isEditing() || !byUser(e)) return;
    const editor = findEditor(realTarget(e));
    if (!editor) return;
    activeEditor = editor;
    noteEditor();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(
      safely(() => scan(editor)),
      SCAN_DELAY_MS,
    );
  });
  window.addEventListener("input", onTyping, true);
  // Editors that cancel beforeinput and apply the edit themselves (Slate, CKEditor 5) never fire
  // input; the scan waits for typing to pause, so the edit has landed by the time it reads the text.
  window.addEventListener("beforeinput", onTyping, true);

  window.addEventListener(
    "keydown",
    safely((e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || !byUser(e)) return;
      const editor = findEditor(realTarget(e));
      if (!editor) return;
      activeEditor = editor;
      if (shouldBlock({ via: editor })) block(e, "Enter key");
    }),
    true,
  );

  // Send buttons without a "send" label (an icon in a div, DeepSeek-style): a button close
  // around the chat box whose label isn't one of the chat box's other tools.
  const NOT_SEND =
    /attach|upload|file|image|photo|camera|mic|voice|dictat|speak|record|model|mode|picker|select|switch|tool|plus|add|emoji|search|research|think|reason|canvas|setting|menu|more|option|stop|cancel|close|new|share|copy|edit|regenerat|retry|like|thumb|expand|collapse/i;
  function composerButton(target) {
    if (!activeEditor || !activeEditor.isConnected) return null;
    const btn = target.closest('button, [role="button"]');
    if (!btn || btn === activeEditor || btn.contains(activeEditor)) return null;
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.textContent || ""}`;
    if (NOT_SEND.test(label)) return null;
    let area = activeEditor;
    for (let i = 0; i < 5 && area.parentElement; i++) {
      area = area.parentElement;
      if (area.contains(btn)) return btn;
    }
    return null;
  }

  window.addEventListener(
    "click",
    safely((e) => {
      if (!byUser(e)) return;
      const target = realTarget(e);
      if (!(target instanceof Element)) return;
      const sendBtn = target.closest(SEND_BUTTON_SELECTOR);
      const otherBtn = !sendBtn && composerButton(target);
      if (sendBtn) {
        if (shouldBlock({ via: sendBtn })) block(e, "send button");
      } else if (otherBtn && shouldBlock({ unsure: true, via: otherBtn })) {
        block(e, "unlabeled button in the chat box");
      }
    }),
    true,
  );

  // ---------- Reply check: the AI mentions your own details that you didn't type here (D63) ----------
  // Only your vault details (fingerprints), only text that appears in the 90 s after you send (so an
  // old conversation opening never counts), never what you typed on this page, once per detail.
  // One check per message you send, once the reply has been quiet for a moment: the page controls
  // what appears, so more checks would let it test guess after guess (S24).
  const REPLY_WINDOW_MS = 90000;
  const REPLY_QUIET_MS = 3000;
  const OWN_WORD_TYPES = new Set(["my_name", "family_name", "employer", "watch_list"]);
  const typedHere = new Set(); // fingerprints of everything detected in the chat box on this page
  const mentioned = new Set(); // fingerprints already pointed out
  const replyNodes = new Set();
  let replyChat = null; // the Bandage chat the message was sent in: its labels are marked while it's still the chat
  let replyWindowUntil = 0;
  let replyTimer = null;
  let replyObserver = null;
  let replyChecked = false; // this message's reply check is done (one per message you send, S24)

  function fpOf(r, m) {
    return saltValue ? fingerprint(saltValue, r.id, m) : null;
  }
  function noteTyped(results) {
    for (const r of results)
      for (const m of r.matches) {
        const fp = fpOf(r, m);
        if (fp) typedHere.add(fp);
      }
  }
  const isOwn = (r, m) => OWN_WORD_TYPES.has(r.id) || (vaultMode(r.id, m) !== null && vaultMode(r.id, m) !== "allow");

  function openReplyWindow() {
    // Nothing to look for: reply check is off (or nothing of yours in the vault yet), and Bandage
    // hasn't covered anything in this chat either.
    const wantsReplyCheck = replyCheck && saltValue && vaultEntries.length;
    const wantsBandage = bandageOn() && bandageChat().byLabel.size;
    if (!wantsReplyCheck && !wantsBandage) return;
    replyChat = wantsBandage ? bandageChat() : null;
    replyWindowUntil = Date.now() + REPLY_WINDOW_MS;
    replyChecked = false;
    if (replyObserver || !document.body) return;
    replyObserver = new MutationObserver((records) => {
      if (Date.now() > replyWindowUntil) {
        replyObserver.disconnect();
        replyObserver = null;
        replyNodes.clear();
        return;
      }
      for (const rec of records) {
        const nodes = rec.type === "characterData" ? [rec.target.parentElement] : [...rec.addedNodes];
        for (const n of nodes) if (n && replyNodes.size < 500) replyNodes.add(n.nodeType === 3 ? n.parentElement : n);
      }
      clearTimeout(replyTimer);
      replyTimer = setTimeout(safely(checkReply), REPLY_QUIET_MS); // streaming: wait for a pause
    });
    replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function closeReplyWindow() {
    replyWindowUntil = 0;
    replyObserver?.disconnect();
    replyObserver = null;
  }

  function validReplyNode(n) {
    if (
      !n?.isConnected ||
      (activeEditor && (n === activeEditor || n.contains(activeEditor) || activeEditor.contains(n)))
    )
      return false;
    return !n.closest?.("textarea, input, [contenteditable='true'], [contenteditable='']");
  }

  function checkReply() {
    if (isPaused() || health.uiRemoved) return;
    const nodes = [...replyNodes].filter(validReplyNode);
    replyNodes.clear();
    // Bandage looks at every pause until the window ends: an AI can go quiet for seconds before its answer (Copilot
    // builds a new chat's own page first, BN17), and finding Clotr's own labels tells the page nothing.
    // Only while the chat the message was sent in is still the page's chat (bandageSwitched).
    const labelsToFind = bandageOn() && replyChat === bandageChat() && replyChat.byLabel.size > 0;
    if (labelsToFind) bandageMarkLabels(nodes, replyChat);
    if (!replyCheck || replyChecked) {
      if (!labelsToFind) closeReplyWindow();
      return;
    }
    let text = "";
    for (const n of nodes) {
      text += `${n.innerText || n.textContent || ""}\n`;
      if (text.length > 100000) break;
    }
    if (!text.trim()) return; // nothing to read yet: keep waiting for the answer
    replyChecked = true;
    if (!labelsToFind) closeReplyWindow();
    const own = filterMatches(splitOwnIds(detect(text)), (r, m) => {
      const fp = fpOf(r, m);
      return fp && isOwn(r, m) && !typedHere.has(fp) && !mentioned.has(fp);
    });
    if (!own.length) return;
    for (const r of own) for (const m of r.matches) mentioned.add(fpOf(r, m));
    report(own, "mentioned"); // kind and fingerprint only, for the mind map (D63, D75); even when a warning has priority
    if (ui.isDialogOpen() || (ui.isNoticeOpen() && ui.noticeKind() !== "offer")) return; // a warning has priority
    console.info(
      LOG,
      "a reply mentions your own details",
      own.map((r) => r.id),
    );
    ui.tellReplyMentions(own);
  }

  // ---------- Bandage step 2 (D93, D99): hover a label in the AI's answer to see the real detail ----------
  // The AI's page is never changed: rewriting a reply's text under a site's own framework (React and the like) can
  // break the chat (D30). Clotr finds each known label with a live Range, and warning-ui.js lays its own invisible,
  // focusable hotspot over it, with a small bubble that shows the real detail. The label ↔ detail map is only the
  // in-memory one from step 1 (bandageChat().byLabel): nothing new is stored.
  const LABEL_RE = /\[[^[\]]{1,60}\]/g;

  function bandageMarkLabels(nodes, chat) {
    if (retired || !chat.byLabel.size) return; // retired: the updated copy marks labels now
    for (const root of nodes) {
      try {
        bandageFindLabels(root, chat);
      } catch (err) {
        console.warn(LOG, "Bandage couldn't look for labels in a reply", err);
      }
    }
    if (ui.hasSpots()) ui.placeSpots();
  }

  // Text nobody sees: a screen-reader-only copy of a message ("You said: …", in a 1-pixel clipped box) or a hidden
  // one. A hotspot there would draw an underline over empty page (seen on claude.ai, BN15).
  function unseenText(elm) {
    for (let e = elm, i = 0; e && e !== document.body && i < 6; e = e.parentElement, i++) {
      const s = getComputedStyle(e);
      if (s.visibility === "hidden" || s.opacity === "0") return true;
      if ((s.clip && s.clip !== "auto") || /inset\(50%/.test(s.clipPath || "")) return true;
      const r = e.getBoundingClientRect();
      if ((r.width <= 1 || r.height <= 1) && s.overflow !== "visible") return true;
    }
    return false;
  }

  // Remembers where each known label sits in `root`'s text, without touching it.
  function bandageFindLabels(root, chat) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.nodeValue;
      if (!text || !text.includes("[")) continue;
      if (unseenText(t.parentElement)) continue;
      LABEL_RE.lastIndex = 0;
      for (let m = LABEL_RE.exec(text); m; m = LABEL_RE.exec(text)) {
        if (!chat.byLabel.has(m[0]) || ui.hasSpot(t, m.index)) continue;
        ui.addSpot(t, m.index, m[0], root, chat);
      }
    }
  }

  // The answer's text with every label's real detail back in, from the chat the answer belongs to (for the clipboard
  // only, never for the page).
  function bandageRealText(root, chat) {
    return (root.textContent || "").replace(LABEL_RE, (m) => chat?.byLabel.get(m) ?? m);
  }

  // ---------- Attached files (warn only; the upload itself isn't held, D19) ----------
  // attachments.js reads text files, PDFs and Office documents, with hard caps (hostile files).

  // Several files at once get one notice naming each file with something in it. A drop of
  // hundreds of files: the first MAX_FILES are read (each is capped), the rest pass unchecked.
  const MAX_FILES = 50;

  // Results for the same kind of data, from different files, as one entry per kind.
  function mergeResults(a, b) {
    const out = a.map((r) => ({ ...r, matches: [...r.matches] }));
    for (const r of b) {
      const same = out.find((o) => o.id === r.id);
      if (same) same.matches.push(...r.matches);
      else out.push({ ...r, matches: [...r.matches] });
    }
    return out;
  }

  async function scanFiles(files) {
    if (isPaused()) return;
    const list = [...(files || [])];
    if (list.length > MAX_FILES)
      console.info(LOG, "checking the first", MAX_FILES, "of", list.length, "attached files");
    const names = [];
    let found = [];
    let lines = 0;
    for (const f of list.slice(0, MAX_FILES)) {
      const text = await readAttachment(f); // null: not a kind Clotr reads, or unreadable (fail open)
      if (!text) continue;
      const all = splitOwnIds(detect(text));
      const silenced = filterMatches(all, (r, m) => respFor(r, m) === "log");
      if (silenced.length) report(silenced, "suppressed");
      const hits = filterMatches(all, (r, m) => respFor(r, m) !== "log" && !allowedValues.has(m));
      if (!hits.length) continue;
      console.info(
        LOG,
        "attached file",
        (f.name.match(/\.\w+$/) || [""])[0],
        "contains",
        hits.map((r) => r.id),
      ); // extension only: a file name can be personal
      names.push(f.name);
      lines += text.split("\n").length;
      found = mergeResults(found, hits);
    }
    if (!found.length) return;
    fileWarnings = mergeResults(fileWarnings, found); // an earlier file not yet acknowledged stays counted
    const shown =
      names
        .slice(0, 3)
        .map((n) => `“${n}”`)
        .join(", ") + (names.length > 3 ? ` ${msg("andMore", "and $1 more", names.length - 3)}` : "");
    if (!ui.isDialogOpen())
      warn(found, names.length === 1 ? { name: names[0], lines } : { name: shown, lines, count: names.length });
  }

  window.addEventListener(
    "change",
    safely((e) => {
      const t = realTarget(e);
      if (t instanceof HTMLInputElement && t.type === "file")
        scanFiles(t.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );
  window.addEventListener(
    "drop",
    safely((e) => {
      if (e.dataTransfer?.files?.length)
        scanFiles(e.dataTransfer.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );
  window.addEventListener(
    "paste",
    safely((e) => {
      if (e.clipboardData?.files?.length)
        scanFiles(e.clipboardData.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );

  // The background asks before an update reload. Only a frame showing a dialog or a
  // warning answers; if none does, the reload goes ahead.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "clotr:busy?" && (ui.isDialogOpen() || (ui.isNoticeOpen() && ui.noticeKind() !== "offer")))
      sendResponse(true);
    if (msg?.type === "clotr:focusNotice" && IS_TOP) ui.focusNotice();
    if (msg?.type === "clotr:settingsChanged" && !retired) loadSettings();
    if (msg?.type === "clotr:showChatBox" && IS_TOP && !retired) {
      try {
        sendResponse(showChatBox());
      } catch (err) {
        console.warn(LOG, "couldn't show the chat box", err);
        sendResponse({ found: false });
      }
    }
    // Still here after an in-page navigation: tell the background again (HC4).
    if (msg?.type === "clotr:ping" && IS_TOP && !retired) sendResponse({ alive: true, paused: isPaused(), ...health });
    return false;
  });

  window.addEventListener(
    "submit",
    safely((e) => {
      if (byUser(e) && shouldBlock({ via: e.target instanceof HTMLFormElement ? e.target : null }))
        block(e, "form submit");
    }),
    true,
  );
})();
