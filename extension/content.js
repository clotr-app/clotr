// Watches AI chat inputs and scans their text locally against Clotr.PATTERNS. Each pattern's response, set
// in patterns.js, decides what happens next. A block holds the message in a dialog until the person answers
// it, a warn shows a corner notice without holding anything, a log just counts it, and an off skips it.
// Nothing leaves the browser, and the detected values themselves never get stored, only settings and event
// metadata in chrome.storage.local. warning-ui.js draws what the person sees; this file decides when to
// show it and what each choice does.
(() => {
  "use strict";

  const LOG = "[Clotr]";

  // This can run twice if the user adds a site and Chrome injects into an already-open tab.
  if (globalThis.__clotrActive) return;
  globalThis.__clotrActive = true;

  const {
    detect,
    redact,
    generalize,
    fingerprint,
    setVault,
    vaultKinds,
    isPicture,
    readPicture,
    namedDocument,
    readBandageLabels,
    bandageKindOf,
    msg,
  } = globalThis.Clotr;
  const { realTarget, findEditor, getText, replaceText } = globalThis.Clotr.editor;
  const IS_TOP = window === window.top;
  // Which held-back features this build ships (`clotr_features` in manifest.json).
  const FEATURES = chrome.runtime.getManifest().clotr_features || {};

  console.info(LOG, "active on", location.href, IS_TOP ? "(top frame)" : "(iframe)");

  // ---------- Fail open ----------
  // After an update, this page's copy of Clotr keeps running but is cut off from the extension: every call
  // into chrome.* now throws "Extension context invalidated". These helpers catch that so it never throws
  // into the chat or into Clotr's own UI.
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

  // An orphaned copy keeps protecting with whatever settings it last loaded, but only warns. It never holds
  // a message or records anything, since reloading the page is what brings in the new version.
  let orphanLogged = false;
  function noteOrphaned() {
    if (!orphanLogged)
      console.info(LOG, "Clotr was updated; this page keeps warning with the old copy until it's reloaded");
    orphanLogged = true;
  }

  // After an update the background starts the new version in open tabs without a reload. The new copy runs
  // in a fresh script world, so it announces itself with a page event, and an orphaned older copy hears
  // that and steps aside. A page faking the event can't switch off a working copy, because only an
  // orphaned one is listening for it.
  let retired = false;
  document.addEventListener("clotr:hello", () => {
    if (!retired && orphaned()) retire();
  });
  document.dispatchEvent(new CustomEvent("clotr:hello"));

  function retire() {
    retired = true;
    clearTimeout(scanTimer);
    stopWatchingLabels();
    try {
      tabPort?.disconnect();
    } catch {
      /* already gone */
    }
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
  // It draws what the person sees. The callbacks below are what each of their choices does. I create it
  // here, after the hello above, so an older copy's warnings stepping aside don't get mistaken for the
  // page removing Clotr's own UI.
  const ui = globalThis.Clotr.ui.create({
    safely,
    orphaned,
    retired: () => retired,
    editor: () => activeEditor,
    largeText: () => largeText,
    everyday: () => everyday,
    tourniquet: () => tourniquet,
    isFirm: (id) => holds(id),
    bandageUnasked: () => bandage === undefined,
    canRemember: () => Boolean(saltValue),
    isVaultType: (id) => isVaultType(id),
    isTeamKind: (id) => isTeamKind(id),
    isGuided: (id) => Boolean(guided[id]),
    markGuided,
    responseOf: (id) => responseOf(id),
    setResponse,
    setToLog,
    addToVault,
    answerBandage,
    removedByPage,
    // A warning's "Get a second opinion": the background opens Clotr's Is this a scam? page. Fails quietly.
    // Held back in this build: no function here means no door (warning-ui.js checks).
    openCheck: FEATURES.scamcheck ? () => message({ type: "clotr:openCheck" }).catch(() => {}) : undefined,
    // A hotspot keeps the chat it was made for: its detail comes from that chat only.
    currentChat: () => bandageChat(),
    realValue: (label, chat) => chat?.byLabel.get(label),
    realText: bandageRealText,
  });

  // One of Clotr's own boxes vanished without Clotr removing it, so the page itself removed it: maybe on
  // purpose, maybe because a framework like React rebuilt around it. I stop holding messages there so
  // nobody gets stuck, and log what happened.
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
  // Looks for the chat box right after load without waiting for the user to type, including inside open
  // shadow roots where sites like Gemini keep theirs. I keep trying for a while, since focus and typing
  // events catch anything that shows up later. Returns the chat box, or null.
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

  // The popup's "Test Clotr here" button calls this to outline the chat box for a moment. Nothing gets
  // typed, sent, or recorded, and the outline removes itself and never blocks clicks.
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

  // Matches the send buttons on ChatGPT, Claude, Gemini, and NotebookLM, plus a generic fallback for
  // ordinary form submit buttons.
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
    'form button[type="submit"]',
  ].join(",");

  const SCAN_DELAY_MS = 400; // wait for typing to pause so half-typed keys don't trigger

  // Checks whether a real person triggered this, not a script. Without that check, a page could type
  // guesses into its own chat box, fire a fake keystroke or Enter, and watch whether Clotr's warning
  // appears, which would tell it what's in your vault. I still count events a script re-dispatches right
  // after a real key or click, since some sites genuinely do that, and I fall back to reacting as before
  // wherever the browser can't tell the difference.
  const byUser = (e) => e.isTrusted || navigator.userActivation?.isActive !== false;

  // ---------- Per-pattern responses (set in the popup, or "stop warning me about this kind" = log) ----------

  let responses = {}; // overrides only: { [patternId]: "block" | "warn" | "log" }

  // Per-site mode (popup → per-site view): "block" = stricter here, "log" = quieter here.
  let siteMode = null; // this site's mode, or null
  // What each found value does is decided in decide.js, the same on every host, from what this page knows.
  const known = () => ({ salt: saltValue, vault: vaultEntries, responses, siteMode, cache: vaultCache });
  const responseOf = (patternId) => globalThis.Clotr.responseOf(patternId, { responses, siteMode });

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
  // A team's own kinds from its policy: [{ id, name, cover }], their words among the vault's entries as
  // fingerprints. Never stored here; they come with the settings each time.
  let teamKinds = [];
  const vaultCache = new Map(); // "type\0match" → "protect" | "allow" | null, hashed once per page

  function applyVault() {
    vaultCache.clear();
    setVault({ salt: saltValue, entries: vaultEntries, kinds: teamKinds });
  }
  const isTeamKind = (id) => vaultKinds().some((k) => k.id === id);

  // Your vault's word on one value: "protect", "allow" or null, hashed once per page (cleared with the vault).
  const vaultMode = (patternId, match) => globalThis.Clotr.vaultMode(patternId, match, known());

  // With a fingerprint of your own ID in the vault, IDs that only share its format are
  // named apart ("Account/ID Number") and ranked lower than yours ("Your Account/ID Number").
  const splitOwnIds = (results) => globalThis.Clotr.splitOwnIds(results, known());

  // The response for one detected value: the type's response, adjusted by the vault.
  const respFor = (r, m) => globalThis.Clotr.respFor(r, m, known());

  // Kinds of data the user has already gotten a first-time tip about.
  let guided = {};
  function markGuided(id) {
    guided = { ...guided, [id]: Date.now() };
    message({ type: "clotr:guided", id }).catch(() => {});
  }
  // Bigger text and buttons in Clotr's boxes, turned on from settings → "Larger warnings".
  let largeText = false;
  let replyCheck = true; // Settings → "Check the AI's replies for my details"
  let commandCheck = true; // Settings → "Check commands I copy on AI chats"
  let bandage; // Bandage on this site: true on, false the user said no, undefined not asked yet
  let everyday = false; // an email or chat app you switched on: your words go to people, not to an AI
  let pictureNoted = false; // the "can't read pictures" note was already shown on this site
  // Tourniquet mode: "child", "adult", or "after_scam" for the 30 days after a scam, while it's on. Whatever
  // kinds it or an organization's policy holds, and whether settings are locked, the warning never offers a
  // way to loosen those, so there's no route around the PIN.
  let tourniquet = null;
  let firm = new Set();
  let locked = false;
  const holds = (id) => locked || firm.has(id);

  // A reload's content script starts out knowing nothing, and normally has to wait for loadSettings() to
  // come back before it knows whether Bandage is on here. In Firefox, though, the background can be an
  // asleep event page, and waking it can take several seconds, during which an old label already on the
  // page would show no hotspot at all. I open a port instead of just sending a message, because holding a
  // port open also keeps the background from going back to sleep in the first place, so most reloads never
  // hit that wake delay to begin with. The port doesn't touch chrome.storage directly; the background
  // answers with just the Bandage flag, from its own fast, separate lookup, the moment the port connects.
  // loadSettings() below still runs right after and is the real answer, confirming this guess or switching
  // the watch off if Bandage was turned off for this site since.
  let tabPort;
  try {
    tabPort = chrome.runtime.connect({ name: "clotr:tab" });
    tabPort.onMessage.addListener((m) => {
      if (m?.type === "clotr:bandage" && m.on === true && bandage === undefined && !retired) {
        bandage = true;
        safely(watchLabels)();
      }
    });
    tabPort.onDisconnect.addListener(() => {
      tabPort = null;
    });
  } catch {
    /* fail open: no port, loadSettings() below is still the answer */
  }

  // Settings come from the background, just the slice this frame needs, including this site's own pause
  // state and mode. I fetch them at start, whenever the background says something changed, and whenever
  // the tab is shown again.
  let settingsLoaded = false;
  let prepFailed = false; // asking the background for settings or the salt failed before they came: nothing waits
  function loadSettings() {
    return message({ type: "clotr:getSettings" })
      .then((r) => {
        if (!r || r.error) throw new Error(r?.error || "no settings");
        const wasPaused = isPaused();
        guided = r.guided || {};
        largeText = r.largeText === true;
        replyCheck = r.replyCheck !== false;
        commandCheck = r.commandCheck !== false;
        bandage = typeof r.bandage === "boolean" ? r.bandage : undefined;
        safely(watchLabels)(); // turns the label watch on (picking up labels from a reload) or off
        everyday = r.everyday === true;
        pictureNoted = r.pictureNoted === true;
        teamHold = r.teamHold === true;
        tourniquet = ["child", "adult", "after_scam"].includes(r.tourniquet) ? r.tourniquet : null;
        firm = new Set(Array.isArray(r.firm) ? r.firm : []);
        locked = r.locked === true;
        if (!replyCheck) closeReplyWindow(); // off: don't read a reply already on its way, either
        responses = r.responses || {};
        siteMode = r.siteMode || null;
        vaultEntries = Array.isArray(r.vault) ? r.vault : [];
        teamKinds = Array.isArray(r.kinds) ? r.kinds : [];
        // The salt comes with the settings, so the words they fingerprinted can be matched at once.
        if (!saltValue && typeof r.salt === "string" && /^[0-9a-f]{32}$/.test(r.salt)) saltValue = r.salt;
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
          dropFileHold();
        }
      })
      .catch((err) => {
        if (!settingsLoaded) prepFailed = true;
        console.warn(LOG, "could not load preferences", err);
      });
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
        if (!saltValue) prepFailed = true;
        throw err;
      });
    return saltPromise;
  }

  getSalt().catch((err) => console.warn(LOG, "could not load salt", err));

  // Records one event per detected value. The `via` field says how a "redacted" event happened, whether
  // Bandage covered it automatically or the person hid it by hand, so reports can tell the two apart.
  async function report(results, action, via) {
    if (orphaned()) return; // nothing can be recorded after an update
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

  // Both only last for the message currently being written. Once it's sent or the box is cleared, the next
  // message warns and logs again like normal.
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
  // Vault-only types have nothing left to learn, and a team's own kinds are set by its policy, so I never
  // offer the person a way to loosen or remember either one.
  const VAULT_TYPES = new Set(["my_name", "family_name", "employer", "my_id", "watch_list"]);
  const isVaultType = (id) => VAULT_TYPES.has(id) || isTeamKind(id);
  let scanTimer = null;
  let backToEdit = false; // the user went back to the message from the dialog: don't reopen it until they send
  let heldVia = null; // while a send attempt is checked: what it used (the chat box for Enter, a button, a form)

  // ---------- Bandage: cover names while you type ----------
  // On a site where the user turned Bandage on, personal details turn into bracketed labels like [Phone 1]
  // or [Me] as soon as typing pauses, and the same detail keeps the same label for the rest of that chat.
  // Passwords and keys are never covered, so they still get the normal warning. The label-to-detail map
  // lives only in this page's memory, keyed by fingerprint, and nothing gets stored. A reload forgets that
  // map, but the labels already given are still visible in the conversation itself, so Clotr reads them
  // back off the page and numbers new details after them. That's what keeps one label from ever standing
  // for two different details.
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
  // While an IME composition is in progress (Japanese, Chinese, Korean...), I never swap the text, since that
  // would scramble it mid-composition. The scan right after it ends covers whatever was typed.
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

  // A chat's page has no id in its path before the first message goes out, just something like "/", "/new",
  // or "/app". Once the first message sends, the page moves to the conversation's own path, and I carry
  // the labels already given over to it so they don't reset.
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

  // Called when the conversation changes without a reload: the site's sidebar, back and forward, or a new
  // chat. The first send that moves a new chat to its own address keeps the same chat, so it doesn't call
  // this. Every hotspot gets cleared right away, since each one was made for the chat just left and could
  // otherwise show that chat's details here. The old chat's messages can also linger on the page for a
  // moment, so I read the whole page again for this chat's own labels. Any reply Clotr was still waiting on
  // belonged to the chat just left, so its labels never get marked here.
  function bandageSwitched(chat) {
    ui.clearSpots();
    chat.read = false;
    labelWatch.nodes.clear();
    labelWatch.unseen.clear();
    if (labelWatch.observer && !labelWatch.timer) labelWatch.timer = setTimeout(safely(bandageReadPage), LABEL_READ_MS);
    replyChat = null;
    replyNodes.clear();
  }

  // Picks the label word for a kind of detail. Anything else personal just becomes "ID". The kind also
  // serves as the numbering key, so a "[Teléfono 1]" label read from an earlier message still makes the
  // next phone "[Phone 2]", no matter the language.
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
      default: {
        // A team's own kind has its own word ("[Matter 1]"), numbered as detector.js reads it back.
        const own = vaultKinds().find((k) => k.id === id);
        if (own) return [bandageKindOf(own.cover), own.cover];
        return ["bl_id", msg("bl_id", "ID")];
      }
    }
  }

  // Returns the same id for a label regardless of language or case, using detector.js's own matcher, or
  // the label text itself if it isn't a recognized label.
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
      // "Me" and "My company" stand alone. Everything else gets a number.
      label = (r.id === "my_name" || r.id === "employer") && n === 1 ? `[${word}]` : `[${word} ${n}]`;
    }
    chat.byKey.set(key, label);
    chat.byLabel.set(label, value);
    chat.given.add(labelId(label));
    return label;
  }

  // ---------- Bandage after a reload: the labels the conversation already holds ----------
  // Nothing gets stored, so after a reload Clotr no longer knows which detail an earlier label stood for,
  // though the page itself still shows those labels in your messages and the AI's replies. While Bandage is
  // on, I read the whole page once per chat, then only what changed since: a mutation observer collects
  // changed nodes, and I read them at most twice a second, plus once more right before handing out a new
  // label. Each kind's numbering picks up after the highest number already found, and a label this page
  // didn't give gets a hotspot whose bubble explains that Clotr never kept its real detail. A label that
  // isn't visible yet gets retried every LABEL_READ_MS for up to UNSEEN_TRIES tries, about 10 seconds,
  // because a plain fade-in only changes a CSS style that the observer can't see; on ChatGPT the hotspot
  // usually waits for some other page change, 4 to 5 seconds. Text that stays hidden, like a screen reader's
  // own copy of a message, just runs out of tries and never gets one.
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

  // Bandage covers personal details and watch words the user hasn't already marked fine to share. It never
  // covers the codes a scammer asks for, since those are marked `bandage: false` in patterns.js and keep
  // their normal warning.
  const bandageOn = () => bandage === true && !orphaned();
  const coverable = (r, m) =>
    r.group !== "credentials" &&
    r.bandage !== false &&
    !bandageFailed.has(m) &&
    !allowedValues.has(m) &&
    respFor(r, m) !== "log";

  // Swaps the details in `text` (the chat box's text right now) for their labels. If the box won't take the edit,
  // those details fall back to the normal warning.
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

  // The answer to the Bandage offer in the warning, the first time a personal detail shows up on a site.
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

  // Replaces the chat box's text, returning true only if it really changed. Clotr's own edit isn't
  // something to rescan, and nothing in it counts as removed by hand.
  async function setText(editor, text) {
    try {
      return await replaceText(editor, text);
    } finally {
      clearTimeout(scanTimer);
      flagged.clear();
    }
  }

  // Hides the found items in the chat box. With `general` set, a birth date becomes just its month and year
  // and an address becomes just its town, with everything else still hidden outright. This only counts as
  // hidden once the text actually changed; if it didn't, I say so plainly, so nobody sends a detail believing
  // it's gone. Either way, the exact detail itself never goes out.
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
  // Every warning offers a choice for just this once, Hide it or Leave it in, plus a lasting choice: either
  // for this exact item, saved to the vault as "fine to share" or "always watch", or for this whole kind of
  // data.

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
    // Opened by a send attempt: leaving it in sends the message.
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
      // Back to the message without choosing: the dialog comes back when you send.
      back: () => {
        ui.closeDialog();
        backToEdit = true;
        activeEditor?.focus();
      },
    });
  }

  // Shows the corner warning, which never blocks or takes focus. The `file` argument is { name, lines } for
  // an attached file, which can't be redacted in place, only removed by the user.
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
      (f) => !offered.has(f.value) && !isVaultType(f.id) && vaultMode(f.id, f.value) === null,
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

  // The user kept, or ignored, a warning. After a few of the same type, I offer to relax it. The background's
  // answer can come back late, and if some other warning is already showing by then, like one for the next
  // picture or for what's currently being typed, that one has priority and stays. The relax offer just
  // waits for the next kept warning, which asks the background again.
  function noteIgnored(results) {
    if (orphaned()) return;
    const types = [...new Set(results.map((r) => r.id).filter((id) => !isTeamKind(id)))];
    if (!types.length) return;
    message({ type: "clotr:ignored", types })
      .then((r) => {
        const id = r?.offer;
        const p = id && results.find((x) => x.id === id);
        if (!p || holds(id) || !["warn", "block"].includes(responseOf(id)) || ui.isDialogOpen()) return;
        if (ui.isNoticeOpen() && ui.noticeKind() !== "offer") return; // a warning has priority
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
    const lost = orphaned(); // after an update: warn only, record nothing
    if (lost) {
      noteOrphaned();
      // No updated copy took over: ask for a reload.
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

    // Bandage turns personal details into labels, so they're never warned about or held.
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

    // A flagged value that disappeared while the message was still being written was removed by hand,
    // which is worth learning from.
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
      if (ui.isDialogOpen() && ui.dialogKind() === "ask") ui.closeDialog(); // a file's question stays: the file's still there
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

  // Re-checks right before a send, in case the debounced scan hasn't run yet. Block-level items stop the
  // send, while warn-level items go through and count as allowed. The `unsure` flag means the click landed
  // on an unlabeled button in the chat box that may or may not actually send. This can only hold a message
  // for an Ask-before-sending item; for warnings, nothing gets recorded until the box actually empties in
  // confirmSent, so clicking Attach or the microphone never counts as sending.
  function shouldBlock(opts) {
    const held = shouldHold(opts);
    if (!held && activeEditor) openReplyWindow();
    if (!held && !opts?.unsure) filesWentOut();
    return held;
  }

  // ---------- Ready before the first send ----------
  // A word a team's policy or your vault says to ask about can only be matched once this page has its
  // settings and the salt loaded. Right after a page loads, a send can come in before the background has
  // answered, maybe the computer's busy or the background is still waking up, so that send waits for them,
  // for at most 3 seconds, then gets the normal check anyway. If settings don't arrive in time, or asking
  // for them failed outright, the message goes the way it would have without Clotr. Getting ready can
  // delay a message a little, but it never stops one.
  const READY_WAIT_MS = 3000;
  let readyWait = 0; // the timer of the send that's waiting now
  let readyGaveUp = false; // waited the full 3 s once: later sends don't wait again
  let passThrough = false; // the send being let through after the wait: already checked
  const ready = () => settingsLoaded && Boolean(saltValue);
  const shouldWait = () => !ready() && !prepFailed && !readyGaveUp && !orphaned();
  function waitUntilReady(via) {
    if (readyWait) return true; // another Enter while waiting: still the one wait
    const started = Date.now();
    const check = safely(() => {
      if (shouldWait() && Date.now() - started < READY_WAIT_MS) {
        readyWait = setTimeout(check, 50);
        return;
      }
      readyWait = 0;
      if (!ready()) {
        readyGaveUp = true;
        console.info(LOG, "settings didn't come in time; the message goes");
      }
      if (!via?.isConnected) return; // the chat box or its button is gone: nothing to send
      try {
        if (!orphaned() && shouldBlock({ via })) return; // the normal check asks first
      } catch (err) {
        console.warn(LOG, "the check after waiting failed; the message goes", err);
      }
      passThrough = true;
      try {
        sendAgain(via);
      } finally {
        passThrough = false;
      }
    });
    readyWait = setTimeout(check, 50);
    return true;
  }

  function shouldHold({ unsure = false, via = null } = {}) {
    if (passThrough) return false;
    if (isPaused() || health.uiRemoved) return false; // a page removing Clotr's dialog must not leave you stuck
    if (ui.isDialogOpen()) {
      if (!orphaned()) return true;
      ui.closeDialog(); // opened before the update: an orphaned copy never holds a message
    }
    // Nothing typed: an attached file can still be sent on its own.
    if (!activeEditor || !activeEditor.isConnected) return holdForFiles(via, unsure);
    if (!unsure && shouldWait()) return waitUntilReady(via || activeEditor);
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
      // Typed fast enough that the details are still being covered right now, so this send waits and the
      // next one sends the labels instead.
      bandageHeldSend = true;
      return true;
    }
    if (pending.length) return true;
    // Text comes first: a held file is asked about once the typed details are answered (the next send).
    if (holdForFiles(via || activeEditor, unsure)) return true;
    if (warnings.length && (!seen || unsure)) {
      confirmSent(activeEditor, warnings.slice(), !seen);
      return false;
    }
    if (unsure) return false;
    allowWarnings();
    flagged.clear(); // the message is going out: an emptied box isn't a removal
    // After this send attempt, not during it: a form's send button is two attempts (the click, then the
    // submit), and the second must still see what you allowed.
    setTimeout(() => retired || newMessage(), 0);
    return false;
  }

  // Warn never holds a message. When it went out before the warning could be read,
  // say what went, right after, and offer to ask first next time.
  const SEEN_MS = 1500;
  const CONFIRM_MS = 1200;
  // Only say "Just sent", and record it, once the message really left. Some sites ignore an Enter pressed
  // too soon, Gemini among them, so if the text is still sitting in the box, I show the normal warning
  // instead, now that there's time to read it.
  function confirmSent(editor, results, tell = true) {
    const before = getText(editor).replace(/\s+/g, " ").trim();
    ui.closeNotice(); // the half-shown warning, which comes back if the message didn't go
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

  // When "Leave it in and send" answers a dialog that stopped a send, I send the message the same way it
  // was originally sent: the button or form the user used, or for Enter, the site's own send button near
  // the chat box, since a script click works on every site, and failing that, Enter again. If none of that
  // actually sends anything, the text stays in the box and the next real Enter goes through on its own,
  // now that its details are allowed.
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
  // Editors that cancel beforeinput and apply the edit themselves, Slate and CKEditor 5 do this, never fire
  // input. The scan still works, since it waits for typing to pause, so the edit has already landed by the
  // time it reads the text.
  window.addEventListener("beforeinput", onTyping, true);

  let enterDown = false; // true while Enter is physically down, so its own check decides, not the new line it types
  window.addEventListener(
    "keydown",
    safely((e) => {
      enterDown = e.key === "Enter";
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || !byUser(e)) return;
      const editor = findEditor(realTarget(e));
      if (!editor) return;
      activeEditor = editor;
      if (shouldBlock({ via: editor })) block(e, "Enter key");
    }),
    true,
  );
  window.addEventListener(
    "keyup",
    safely(() => (enterDown = false)),
    true,
  );

  // Some phone keyboards never send a real Enter keydown, only the keyCode 229 placeholder, and just type
  // the new line directly. A phone chat built on an editor like ProseMirror treats that new line as if it
  // were Enter, on Android at least. So I treat a new line typed without an Enter key as a send and check
  // it the same way Enter gets checked. Shift+Enter and an actual Enter keydown never reach this listener.
  window.addEventListener(
    "beforeinput",
    safely((e) => {
      const newLine =
        e.inputType === "insertParagraph" ||
        e.inputType === "insertLineBreak" ||
        (e.inputType === "insertText" && /^\r?\n$/.test(e.data || ""));
      if (!newLine || enterDown || e.isComposing || !e.cancelable || !byUser(e)) return;
      if (globalThis.Clotr.editor.isEditing()) return;
      const editor = findEditor(realTarget(e));
      if (!editor) return;
      activeEditor = editor;
      if (shouldBlock({ via: editor })) block(e, "a phone keyboard's new line");
    }),
    true,
  );

  // Finds a send button with no "send" label at all, just an icon in a div the way DeepSeek does it: any
  // button close around the chat box whose label doesn't match one of the chat box's other tools.
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

  // ---------- Reply check: the AI mentions your own details that you didn't type here ----------
  // Checks only for your own vault details, matched by fingerprint, and only in text that shows up within
  // 90 seconds of you sending, so an old conversation loading back up never counts. It never flags anything
  // you typed yourself on this page, and each detail only ever gets flagged once. I run one check per
  // message you send, after the reply has gone quiet for a moment, because the page controls what appears
  // on screen and more frequent checks would let it test guess after guess against your vault.
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
  let replyChecked = false; // this message's reply check is done

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
    // Nothing to look for: reply check is off or the vault is still empty, and Bandage hasn't covered
    // anything in this chat either.
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
    // Bandage checks every quiet pause until the window ends, since an AI can go quiet for several seconds
    // before answering at all (Copilot builds a new chat's own page first, for instance), and finding
    // Clotr's own labels on the page tells it nothing useful anyway. This only runs while the chat the
    // message was sent in is still the page's current chat; bandageSwitched clears it once that's no
    // longer true.
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
    report(own, "mentioned"); // kind and fingerprint only, for the mind map, recorded even when a warning has priority
    if (ui.isDialogOpen() || (ui.isNoticeOpen() && ui.noticeKind() !== "offer")) return; // a warning has priority
    console.info(
      LOG,
      "a reply mentions your own details",
      own.map((r) => r.id),
    );
    ui.tellReplyMentions(own);
  }

  // ---------- The command check: a copied "paste this command" trick ----------
  // A page shows a fake "verify you're human" step, puts a command on the clipboard, and tells the person to
  // press Win+R, paste it, and run it. Microsoft calls this ClickFix, and it now shows up in AI chats too.
  // Clotr looks only at what the person copies, right at the moment they copy it: the copied text and the
  // message it came from, checked once, only on the person's own action. Nothing can run until it's
  // actually pasted somewhere. The copy itself is never stopped or changed, and nothing about it gets
  // stored, counted, or logged outside this function. This never runs on email and chat apps or on Clotr's
  // own pages. commands.js decides whether something looks like a trick; this just watches for copies and
  // shows the note.
  const MAX_AROUND = 4000;
  const noted = new Set(); // copied commands already pointed out on this page (in memory only, bounded; never stored)

  // Anything Clotr itself drew on the page. A copy from inside one of its own boxes isn't the person
  // copying a command.
  function inOwnUI(node) {
    for (let e = node instanceof Element ? node : node?.parentElement; e; e = e.parentElement)
      if (/^CLOTR-/.test(e.nodeName)) return true;
    return false;
  }

  // A copy made inside the chat box or any editable field is the person's own text: skip it.
  function inEditable(node) {
    for (let e = node instanceof Element ? node : node?.parentElement; e; e = e.parentElement) {
      if (e.isContentEditable) return true;
      if (e.nodeName === "TEXTAREA" || e.nodeName === "INPUT") return true;
    }
    return false;
  }

  // Finds the message a copy came from, using the nearest message container's text, so the instruction
  // sitting beside a code block gets read without reaching into other messages. AI chats usually wrap each
  // turn in one of these containers. Without one, I climb up a short, bounded distance and stop before any
  // ancestor that holds a second code block, since that would mean another message. Either way the result
  // is capped at MAX_AROUND.
  const MESSAGE_CONTAINER =
    "[data-message-author-role],[data-message-id],[data-testid*='message' i],[data-testid*='conversation-turn' i],article,li,[role='listitem'],[role='article']";
  function messageAround(node) {
    const start = node instanceof Element ? node : node?.parentElement;
    if (!start) return "";
    const container = start.closest?.(MESSAGE_CONTAINER);
    if (container) return (container.textContent || "").slice(0, MAX_AROUND);
    let best = start.textContent || "";
    for (let e = start.parentElement, i = 0; e && i < 6; e = e.parentElement, i++) {
      if ((e.querySelectorAll?.("pre, code")?.length || 0) > 1) break; // reached a block holding another message's code
      const text = e.textContent || "";
      if (text.length > MAX_AROUND) break;
      best = text;
    }
    return best.slice(0, MAX_AROUND);
  }

  // Finds the page's own Copy button beside a code block, which is how AI chats usually offer commands. A
  // page script that writes to the clipboard directly fires no copy event under the W3C spec, so watching
  // clicks is the only way to see those copies.
  const COPY_NAMES = /^(copy|copy code|copiar|copiar c[oó]digo)$/i;
  function copyButton(node) {
    for (let e = node instanceof Element ? node : node?.parentElement; e; e = e.parentElement) {
      if (e.nodeName !== "BUTTON" && e.getAttribute?.("role") !== "button") continue;
      const name = (e.textContent || e.getAttribute("aria-label") || e.getAttribute("title") || "").trim();
      if (COPY_NAMES.test(name)) return e;
    }
    return null;
  }
  // The nearest code block to a Copy button: a <pre> or <code>, at most four levels up.
  function codeNear(button) {
    for (let e = button, i = 0; e && i < 5; e = e.parentElement, i++) {
      if (e.nodeName === "PRE" || e.nodeName === "CODE") return e;
      const found = e.querySelector?.("pre, code");
      if (found) return found;
    }
    return null;
  }

  function checkCopiedCommand(copied, source) {
    // Held back in this build: commands.js isn't even in the package then.
    if (!FEATURES.commandcheck || !commandCheck || everyday || isPaused() || retired || orphaned() || !settingsLoaded)
      return;
    if (typeof copied !== "string" || !copied.trim() || inOwnUI(source)) return;
    if (ui.isDialogOpen() || (ui.isNoticeOpen() && ui.noticeKind() !== "offer" && ui.noticeKind() !== "command"))
      return; // a warning about the person's own details has priority
    const trick = globalThis.Clotr.commandTrick(copied, messageAround(source));
    if (!trick || noted.has(copied)) return;
    if (noted.size > 50) noted.clear();
    noted.add(copied);
    console.info(LOG, "a copied command looks like a paste-a-command trick", trick.shape); // the shape only, never the command
    ui.tellCommandCopied(trick.shape, {
      // Clearing the clipboard uses this click's user gesture (no permission). Returns whether it worked, for the note.
      clear: () =>
        navigator.clipboard.writeText("").then(
          () => true,
          () => false,
        ),
    });
  }

  window.addEventListener(
    "copy",
    safely((e) => {
      const target = realTarget(e);
      if (inEditable(target)) return; // the person's own text, not a copied command
      const sel = window.getSelection?.();
      const copied = sel ? sel.toString() : "";
      const source = sel?.anchorNode || target;
      checkCopiedCommand(copied, source);
    }),
    true,
  );

  window.addEventListener(
    "click",
    safely((e) => {
      const button = copyButton(realTarget(e));
      if (!button) return;
      const code = codeNear(button);
      if (code) checkCopiedCommand(code.innerText || code.textContent || "", code);
    }),
    true,
  );

  // ---------- Bandage step 2: hover a label in the AI's answer to see the real detail ----------
  // The AI's page itself never gets changed, since rewriting a reply's text under a site's own framework,
  // React and the like, can break the chat outright. Instead, Clotr finds each known label with a live
  // Range, and warning-ui.js lays its own invisible, focusable hotspot over it, with a small bubble that
  // shows the real detail on hover. The label-to-detail map is just the in-memory one built in step 1,
  // bandageChat().byLabel, so nothing new gets stored here.
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

  // Text nobody actually sees, like a screen-reader-only copy of a message in a 1-pixel clipped box, or
  // anything else hidden outright. A hotspot placed there would just draw an underline over empty page.
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

  // Returns the answer's text with every label's real detail swapped back in, using the chat the answer
  // belongs to. This is only for the clipboard, never written back to the page.
  function bandageRealText(root, chat) {
    return (root.textContent || "").replace(LABEL_RE, (m) => chat?.byLabel.get(m) ?? m);
  }

  // ---------- Attached files ----------
  // attachments.js reads text files, PDFs and Office documents, with hard caps (hostile files).

  // Several files dropped at once get one notice that names each file with something in it. If someone
  // drops hundreds of files, only the first MAX_FILES get read, each one capped, and the rest pass through
  // unchecked.
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

  // Clotr can't read the words inside a picture. The first time someone attaches a picture on an AI site
  // and nothing else in the drop triggered a warning, a short note says so, once per site. It waits for a
  // better time, leaving the site unmarked, if a warning, a dialog, or another note is already open, if
  // this frame doesn't know its settings yet, or if this is an orphaned copy left behind by an update. It
  // never runs on email and chat apps, since people there can already see the picture themselves, or while
  // Clotr is paused. Only the site's name gets kept, and only by the background, taken from this frame's
  // own address.
  function notePictures() {
    if (pictureNoted || everyday || !settingsLoaded || isPaused() || retired || orphaned()) return;
    if (ui.isDialogOpen() || ui.isNoticeOpen()) return;
    pictureNoted = true;
    message({ type: "clotr:pictureNoted" }).catch(() => {});
    ui.tellCantReadPictures();
  }

  // Reads what an attached file holds, in detect()'s shape, plus its length in lines: either a document's
  // actual text, or just a picture's name when there's nothing else to go on. The `picture` field is
  // "photo" for an actual picture, or "scan" for a PDF with no readable text, usually one with a picture
  // scanned into it, where the file name is all there is to check. Returns null when there's nothing Clotr
  // can read in the file at all. A document that can't be read, or doesn't finish in time, gets added to
  // `unchecked` by readChecked instead.
  async function readFindings(f, unchecked) {
    if (isPicture(f)) return { all: await readPicture(f), lines: 0, picture: "photo" };
    const text = await readChecked(f, unchecked); // null: not a kind Clotr reads, unreadable or too slow (fail open)
    if (!text?.trim())
      return /\.pdf$/i.test(f.name) || f.type === "application/pdf"
        ? { all: namedDocument(f), lines: 0, picture: "scan" }
        : null;
    return { all: splitOwnIds(detect(text)), lines: text.split("\n").length, picture: false };
  }

  async function scanFiles(files) {
    if (isPaused()) return;
    const list = [...(files || [])];
    if (list.length > MAX_FILES)
      console.info(LOG, "checking the first", MAX_FILES, "of", list.length, "attached files");
    // While these are read, a send that they could hold waits for them (waitForFiles).
    const reading = { names: list.slice(0, MAX_FILES).map((f) => f.name), late: false };
    fileReads.add(reading);
    const names = [];
    const unchecked = [];
    let found = [];
    let lines = 0;
    let pictures = 0;
    let picture = false; // "photo" or "scan": a picture is among the files with something found
    try {
      for (const f of list.slice(0, MAX_FILES)) {
        if (isPicture(f)) pictures++; // its words can't be read
        const read = await readFindings(f, unchecked);
        if (!read) continue;
        const { all } = read;
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
        // Something inside it is set to Ask before sending, so the whole file waits for an answer at the
        // next send attempt. A picture gets its own separate note instead, since whatever's found in a
        // picture never gets shown, not even masked.
        if (holdsSend(hits) && !read.picture && !reading.late && !orphaned()) {
          holdFile(f.name, hits);
          continue;
        }
        names.push(f.name);
        lines += read.lines;
        picture ||= read.picture;
        found = mergeResults(found, hits);
      }
      if (unchecked.length && !found.length) tellUnchecked(unchecked);
      if (!found.length) {
        if (pictures) notePictures();
        return;
      }
      fileWarnings = mergeResults(fileWarnings, found); // an earlier file not yet acknowledged stays counted
      if (!ui.isDialogOpen())
        warn(
          found,
          names.length === 1
            ? { name: names[0], lines, picture }
            : { name: quoted(names), lines, count: names.length, picture },
        );
    } finally {
      fileReads.delete(reading);
      fileReadEnded();
    }
  }

  // ---------- Files held for Ask before sending ----------
  // An attached file holding a kind set to Ask before sending waits for the person's answer at the next
  // send attempt, the same as a typed detail would. Most sites upload a file as soon as it's attached,
  // though, so holding the message can't actually take the file back; the dialog explains that and asks
  // the person to remove it themselves. What was found and the files' names stay only in this page's
  // memory, until the person answers or the message goes out. Events still get recorded as kind and
  // fingerprint, just like for typed text.
  const SCAN_WAIT_MS = 3000; // a send made while a file is still being read waits this long for it
  const READ_CEILING_MS = 20000; // a read that takes longer counts as not checked
  let fileHold = null; // { results, names, asked }: what attached files hold that waits for an answer
  const fileReads = new Set(); // files being read: { names, late } (late: the message went without waiting for them)
  let fileWait = null; // a send waiting for files still being read: { via, reading, timer, asking }
  // An organization's policy can ask before sending for some kind. In that case, a held file's question
  // says the organization is the one asking, and a file still being read after SCAN_WAIT_MS turns into a
  // question too, never a silent send.
  let teamHold = false;

  // Something is set to Ask before sending here, so a file could hold a message.
  const couldHoldFiles = () => (siteMode ? siteMode === "block" : Object.values(responses).includes("block"));
  const holdsSend = (hits) => hits.some((r) => r.matches.some((m) => respFor(r, m) === "block"));
  // “a.pdf”, “b.txt”, “c.csv” and 2 more
  const quoted = (names) =>
    names
      .slice(0, 3)
      .map((n) => `“${n}”`)
      .join(", ") + (names.length > 3 ? ` ${msg("andMore", "and $1 more", names.length - 3)}` : "");

  // Returns the text of one attached file, or null. A read that throws, or takes longer than
  // READ_CEILING_MS, gets listed in `unchecked` and counts as nothing found, so a message never gets held
  // waiting for it.
  async function readChecked(file, unchecked) {
    let timer = 0;
    try {
      const tooSlow = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("too slow")), READ_CEILING_MS);
      });
      // Looked up at each read, so a test can stand in a slow or broken reader.
      return await Promise.race([globalThis.Clotr.readAttachment(file), tooSlow]);
    } catch {
      const kind = (file.name.match(/\.\w+$/) || [""])[0];
      console.info(LOG, "couldn't check an attached file", kind); // the kind of file only, never its name
      unchecked.push(file.name);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // A file holding something set to Ask before sending joins the set of held files, with the same file
  // added twice still only counting once. Adding a new one brings the first question back up again.
  function holdFile(name, hits) {
    const results = mergeResults(fileHold?.results || [], hits).map((r) => ({
      ...r,
      matches: [...new Set(r.matches)],
    }));
    const names = (fileHold?.names || []).filter((n) => n !== name).concat(name);
    fileHold = { results, names, asked: false };
  }

  // The message went out, so whatever was held went out with it. A file still being read just gets noted
  // once it finishes.
  function filesWentOut() {
    fileHold = null;
    for (const r of fileReads) r.late = true;
  }

  function dropFileHold() {
    filesWentOut();
    if (fileWait) endFileWait(fileWait);
  }

  // Holds a send that has files attached, either because a file is already waiting for an answer, or
  // because one is still being read and could end up holding it. This never applies to a button that might
  // not even be a send, to an orphaned copy, or anywhere the page has removed Clotr's dialog.
  function holdForFiles(via, unsure = false) {
    if (unsure || orphaned() || isPaused() || health.uiRemoved) return false;
    if (fileWait) {
      fileWait.via = via || fileWait.via; // pressed again while waiting: the same message
      return true;
    }
    if (fileHold) {
      askAboutFiles(via);
      return true;
    }
    const reading = [...fileReads].filter((r) => !r.late);
    if (!reading.length || !couldHoldFiles()) return false;
    waitForFiles(via, reading);
    return true;
  }

  // Waits up to SCAN_WAIT_MS for the files still being read, showing a small note in the corner meanwhile.
  // After that, it asks the question if one of them holds something, or lets the message go the way it
  // was originally sent.
  function waitForFiles(via, reading) {
    const wait = { via, reading, timer: 0 };
    fileWait = wait;
    const names = reading.flatMap((r) => r.names);
    ui.showChecking(quoted(names), names.length);
    console.info(LOG, "a send waits for an attached file being checked");
    wait.timer = setTimeout(
      safely(() => fileWaitTimedOut(wait)),
      SCAN_WAIT_MS,
    );
  }

  function endFileWait(wait) {
    clearTimeout(wait.timer);
    if (fileWait === wait) fileWait = null;
    ui.closeChecking();
    if (wait.asking && ui.isDialogOpen() && ui.dialogKind() === "wait") ui.closeDialog();
  }

  // A file just finished reading. If a send was waiting only on files that are now read, it goes on.
  function fileReadEnded() {
    const wait = fileWait;
    if (!wait || wait.reading.some((r) => fileReads.has(r))) return;
    endFileWait(wait);
    if (fileHold && !orphaned() && !health.uiRemoved) askAboutFiles(wait.via);
    else if (wait.via)
      setTimeout(
        safely(() => sendAgain(wait.via)),
        0,
      );
  }

  // The files took too long to check. The message goes anyway, and whatever they find later just gets
  // noted.
  function fileWaitTimedOut(wait) {
    if (fileWait !== wait) return;
    if (teamHold && !orphaned() && !health.uiRemoved) return askStillChecking(wait);
    for (const r of wait.reading) r.late = true;
    endFileWait(wait);
    console.info(LOG, "an attached file took too long to check; the message goes");
    if (wait.via) sendAgain(wait.via);
  }

  // Under an organization's policy, a file still being read after SCAN_WAIT_MS turns into a question
  // instead of just a wait. Wait for the check (Enter) keeps waiting, with the corner note still up. Send
  // now sends without waiting, and whatever the file turns out to hold just gets noted afterward. Esc goes
  // back to the message, and the next send attempt asks the same question again. If the read finishes
  // while this question is still open, the file's own question takes over, or the message just goes if
  // nothing turned up, through fileReadEnded. A read never takes longer than READ_CEILING_MS, so the wait
  // always ends one way or another.
  function askStillChecking(wait) {
    wait.asking = true;
    ui.closeChecking();
    const names = wait.reading.flatMap((r) => r.names);
    ui.showFileWait(quoted(names), names.length, {
      wait: () => {
        ui.closeDialog();
        wait.asking = false;
        if (fileWait === wait) ui.showChecking(quoted(names), names.length);
      },
      now: () => {
        for (const r of wait.reading) r.late = true;
        endFileWait(wait);
        ui.closeDialog();
        console.info(LOG, "user sent without waiting for an attached file's check");
        if (wait.via)
          setTimeout(
            safely(() => sendAgain(wait.via)),
            0,
          );
      },
      back: () => {
        endFileWait(wait);
        ui.closeDialog();
        focusChatBox();
      },
    });
  }

  // Asks about the held files. The first time, it says "This file looks private" with a Go back to remove
  // it option; a later send instead asks "Is the file off?".
  function askAboutFiles(via) {
    const hold = fileHold;
    ui.showFileHold(
      hold.results,
      { name: quoted(hold.names), names: hold.names, count: hold.names.length, second: hold.asked, team: teamHold },
      {
        send: () => answerFiles(hold, false, via),
        off: () => answerFiles(hold, true, via),
        back: () => {
          ui.closeDialog();
          hold.asked = true;
          focusChatBox();
        },
      },
    );
  }

  // Either Send with the file, counted as allowed, or It's off, send, counted as taken out by hand. Either
  // way, the message goes out the same way it was originally sent.
  function answerFiles(hold, off, via) {
    ui.closeDialog();
    if (fileHold === hold) fileHold = null;
    report(hold.results, off ? "redacted" : "allowed");
    if (!off) {
      for (const r of hold.results) for (const m of r.matches) allowedValues.add(m);
      noteIgnored(hold.results);
    }
    console.info(
      LOG,
      off ? "user took the file off" : "user sent the file",
      hold.results.map((r) => r.id),
    );
    if (via)
      setTimeout(
        safely(() => sendAgain(via)),
        0,
      );
    else focusChatBox();
  }

  // Back to writing: the chat box Clotr last saw, or the one on the page (a file can be sent before anything's typed).
  function focusChatBox() {
    const box = activeEditor?.isConnected ? activeEditor : findChatBox();
    box?.focus();
  }

  // A file Clotr couldn't read: said plainly where a file could have held the message.
  function tellUnchecked(names) {
    if (orphaned() || !couldHoldFiles()) return;
    ui.tellFileUnchecked(quoted(names), names.length);
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

  // The background asks before an update reload. Only a frame currently showing a dialog or a warning
  // answers back; if none does, the reload goes ahead.
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
    // Still here after an in-page navigation: tell the background again.
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
