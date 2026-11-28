// Clotr for Windows' card: checks what was copied while an AI app is in front and shows the browser's own
// corner warning beside the app, never taking focus from it.
//
// The flow: Clotr for Windows hears the clipboard change (or an AI app come to the front) and tells this page
// which copy to check ("clip": its number and the app, never the text). The page asks for the text, checks it
// with the engine (ClotrHost, the extension's own detection and decisions) and lets go of it at once: the
// card shows only masked previews. Two choices, neither of which ever takes the keyboard from the AI app:
// - "Clot this leak" reads the copy again, swaps the details for labels, puts the safe version on the
//   clipboard and pastes that -- but only into the box the card appeared over, and only if it still has the
//   keyboard (a real Ctrl+V, main.rs's paste_clip); otherwise the text just waits on the clipboard and the
//   card says so.
// - "Leave it alone" leaves the copy alone and tries the same paste.
// Either way the history gets the kinds and fingerprints only. Closing the card has no recorded choice. Any
// error and the card simply doesn't appear: the AI app is never touched.
//
// The typing check (typing_check.rs) does the same for what's typed in the AI app's own box, read about 400 ms
// after typing pauses ("typed": its number and the app, never the text). That card has two choices, "Clot
// this leak and copy" (the message with its details swapped for labels, on the clipboard, to paste over the
// message with Ctrl+A, Ctrl+V) and "It's mine". Clotr never writes into the box from outside.
(() => {
  "use strict";

  // ---------- Setup ----------

  // C, W and Host are the names every Windows page gives these.
  const C = globalThis.Clotr;
  const Host = globalThis.ClotrHost;
  const W = globalThis.ClotrWords;
  const { call, on } = globalThis.ClotrApp;
  const LOG = "[Clotr]";
  // The vault's own kinds (content.js): never offered "fine to share" (and the card offers no vault choices
  // anyway).
  const VAULT_TYPES = new Set(["my_name", "family_name", "employer", "my_id", "watch_list"]);
  // The warning sits 16 px in from the window's top and right (ui-styles.js). Its soft shadow reaches about
  // 30 px to the left and 50 px below, so the see-through window leaves that much room: a shadow cut off by
  // the window's edge would show as a faint box around the card.
  const INSET = 16;
  const SHADOW_LEFT = 32;
  const SHADOW_BELOW = 52;

  // ---------- The card's look ----------

  // The card's look is the browser warning's own (ui-styles.js, Clotr.styles.notice): the one place a shared
  // design kit for the whole suite would plug in. On a phone, or a page narrower than 480 px, the warning
  // spans the screen and grows to thumb size. The card's window is narrow on purpose (only as wide as the
  // warning) and isn't a phone's screen, so here only a touch screen counts, never the width.
  const NARROW = "(max-width: 480px)";
  if (C.styles.notice.includes(NARROW)) C.styles.notice = C.styles.notice.replaceAll(NARROW, "(max-width: 0px)");
  else console.warn(LOG, "the warning's styles changed: the card may look like a phone's");

  // The close control belongs only to the Windows card; the extension's shared warning keeps its own
  // behavior.
  C.styles.notice += `
    .notice.card .head .desktop-close {
      flex: none; width: 28px; height: 28px; min-width: 28px; min-height: 28px; margin-left: auto; padding: 0;
      border-color: rgba(255, 255, 255, .55); border-radius: 50%; background: transparent; color: #fff;
      font-size: 20px; line-height: 1;
    }
    .notice.offer > .desktop-close {
      position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; min-width: 28px; min-height: 28px;
      padding: 0; border-radius: 50%; font-size: 20px; line-height: 1;
    }
    .notice.offer > b:first-of-type { margin-right: 34px; }
  `;

  // ---------- Settings ----------

  let settings = {};
  let locale = "en";
  let systemLocale = "en";
  let current = null; // the copy on the card: { seq, app, findings, lines, typed } or { seq, note, typed }

  // Tourniquet's floor, if it's on, applied over the person's own responses.
  function effectiveSettings() {
    return globalThis.ClotrTourniquet?.effectiveSettings(settings) || settings;
  }

  // Tourniquet's floor goes over the person's own responses before the engine ever sees them (the same order
  // main-window.js and the browser's background.js use): `settings` itself stays the person's own choices, saved as
  // they were chosen.
  function initHost() {
    const effective = effectiveSettings();
    Host.init({ ...settings, locale, responses: effective.responses, largeText: effective.largeText });
  }

  function setResponses(kinds, response) {
    settings = { ...settings, responses: { ...settings.responses } };
    for (const kind of kinds) settings.responses[kind] = response;
    initHost();
    call("set_responses", { kinds, response }).catch(() => console.warn(LOG, "could not save a choice"));
  }

  // Settings' Language wins when it's English or Spanish, so a change there reaches the card without a
  // restart.
  function useSettings(next) {
    settings = next || {};
    locale = W.use(W.pick(settings.language, systemLocale));
    initHost();
  }

  // ---------- The warning's host ----------

  // What the warning asks of its host (warning-ui.js, create()). The card offers this time's choices and
  // "stop warning me about this kind"; the vault, first-time tips, Bandage and Tourniquet live in the main
  // window or the browser.
  const host = {
    largeText: () => settings.largeText === true,
    removedByPage: () => {},
    editor: () => (current ? { lines: current.lines || 1, focus: () => backToApp() } : null),
    everyday: () => false,
    // An AI app's own box, never a search box, so the warning keeps its AI wording.
    search: () => false,
    bandageUnasked: () => false,
    orphaned: () => false,
    retired: () => false,
    isGuided: () => true,
    isVaultType: (id) => VAULT_TYPES.has(id),
    markGuided: () => {},
    tourniquet: () => globalThis.ClotrTourniquet?.wordFor(settings) || null,
    isFirm: (id) => globalThis.ClotrTourniquet?.firmIds(settings).has(id) || false,
    isTeamKind: () => false,
    responseOf: (id) => C.responseOf(id, { responses: effectiveSettings().responses || {}, siteMode: null }),
    setResponse: (ids, value) => setResponses(ids, value),
    setToLog: (ids) => setResponses(ids, "log"),
    canRemember: () => false,
    addToVault: () => {},
    answerBandage: () => {},
    currentChat: () => null,
    safely: (handler) => handler,
    // The browser's own pages (the scam check, the tracking explainer) and the vault's stand-ins: the card
    // offers none of them, so these are never reached, but the warning finds an answer if they ever are.
    openCheck: () => {},
    openTracking: () => {},
    realText: () => "",
    realValue: () => null,
  };
  const warning = C.ui.create(host);

  // "Wrong? Report a false alarm" opens a prefilled GitHub issue (kinds only) in the person's own browser.
  // Clotr for Windows checks the address and hands it to Windows; it sends nothing itself.
  window.open = (url) => {
    call("open_report", { url: String(url) }).catch(() => {});
    return null;
  };

  function backToApp() {
    call("back_to_app").catch(() => {});
  }

  // ---------- Findings as the warning reads them ----------

  // A found detail as a stand-in that masks again to ClotrHost's preview, made from the preview alone, so the
  // card holds no detail. A preview with an ellipsis shows 2 to 4 characters around it, and mask shows that
  // many of a value 4 times as long plus 3, so the stand-in is those characters with dots for the rest. A
  // preview of dots only (a password, or a short value) masks to itself.
  function standIn(preview) {
    const shown = preview.length - 1;
    const head = Math.ceil(shown / 2);
    if (shown < 2 || shown > 4 || preview[head] !== "…") return preview;
    return `${preview.slice(0, head)}${"•".repeat(3 * shown + 3)}${preview.slice(head + 1)}`;
  }

  // The engine's findings as the warning reads them: kind by kind, in the order found.
  function resultsFor(findings) {
    const out = [];
    for (const finding of findings) {
      const last = out.at(-1);
      if (last?.id === finding.type) {
        last.matches.push(standIn(finding.preview));
        continue;
      }
      const { name, severity, group } = finding;
      out.push({ id: finding.type, name, severity, group, matches: [standIn(finding.preview)] });
    }
    return out;
  }

  function record(findings, action, app) {
    const events = Host.eventsFor(findings, action, app);
    if (events.length) call("record", { events }).catch(() => console.warn(LOG, "could not record a choice"));
  }

  function kindsOf(findings) {
    return [...new Set(findings.map((finding) => finding.type))].join(",");
  }

  // ---------- The card's window: as big as the warning, shown beside the AI app ----------

  // The warning is 340 px wide (440 for larger warnings, ui-styles.js).
  const WIDTH = 340;
  const LARGE_WIDTH = 440;
  const NOTE_SECONDS = 30;

  let note = null; // the box of a short note (below), when one is showing
  let noteTimer = null;
  let watching = null;

  function box() {
    return note || C.desktopNoticeBox();
  }

  // The window is the warning's width plus its margins, so only the height follows what the warning holds.
  async function fit(first) {
    const shownBox = box();
    if (!shownBox || !current) return;
    const rect = shownBox.getBoundingClientRect();
    const width = (shownBox.classList.contains("large") ? LARGE_WIDTH : WIDTH) + INSET + SHADOW_LEFT;
    const size = { width, height: Math.ceil(rect.height) + INSET + SHADOW_BELOW };
    if (!first) {
      await call("resize_card", size);
      return;
    }
    watching?.disconnect();
    watching = new ResizeObserver(() => fit(false));
    watching.observe(shownBox);
    const shown = await call("show_card", { seq: current.seq, ...size });
    if (!shown) close();
  }

  function close() {
    clearTimeout(noteTimer);
    noteTimer = null;
    watching?.disconnect();
    watching = null;
    warning.closeNotice();
    note?.getRootNode().host.remove();
    note = null;
    const seq = current?.seq;
    current = null;
    if (seq !== undefined) call("card_done", { seq }).catch(() => {});
  }

  function closeButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desktop-close";
    button.textContent = "×";
    button.setAttribute("aria-label", W.t("card.close"));
    button.addEventListener("click", close);
    return button;
  }

  function addNoticeCloseButton() {
    const head = box()?.querySelector(".head");
    if (head) head.append(closeButton());
  }

  function dismissOnEscape(target) {
    target.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      backToApp();
    });
  }

  // ---------- The card's own notes, in the warning's style ----------

  function makeButton(text, className, onClick) {
    const button = document.createElement("button");
    if (className) button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function makeText(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function actionsRow(...buttons) {
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(...buttons);
    return actions;
  }

  // Takes the card over with a box of its own: whatever was showing goes, `onCard` becomes the card's copy,
  // and the box holds a close control and then `parts`, in a closed shadow with the warning's own styles.
  function showOwnBox(onCard, parts) {
    warning.closeNotice();
    note?.getRootNode().host.remove();
    current = onCard;
    const holder = document.createElement("clotr-note");
    const shadow = holder.attachShadow({ mode: "closed" });
    note = document.createElement("div");
    note.className = settings.largeText ? "notice offer large" : "notice offer";
    note.setAttribute("role", "status");
    note.append(closeButton(), ...parts);
    dismissOnEscape(note);
    const style = document.createElement("style");
    style.textContent = C.styles.notice;
    shadow.append(style, note);
    document.documentElement.append(holder);
  }

  // A short note in the warning's own style: what you copied was marked private, or Windows' clipboard
  // history may still hold the original after Clot this leak. One button; it goes by itself after 30 seconds.
  function showNote(seq, title, text) {
    const ok = makeButton(W.t("card.ok"), "primary", close);
    showOwnBox({ seq, note: true }, [makeText("b", title), makeText("p", text), actionsRow(ok)]);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => current?.note && current.seq === seq && close(), NOTE_SECONDS * 1000);
    fit(true);
  }

  // Replaces whatever's showing with the note itself (extension/ask-someone.js), the same takeover showNote
  // already does for "Windows' clipboard history" -- this is a fourth, equally final choice, not a detour
  // back to the three above. "Copy the note" writes it the same way "Clot this leak" does
  // (hide_in_clipboard); it's fixed text built from sign names only, never a value, so showing or copying it
  // is never the thing Clotr warned about in the first place.
  function showAskSomeone(seq, text) {
    const copy = makeButton(W.t("card.copyNote"), "primary", () => copyNote(seq, text));
    const ok = makeButton(W.t("card.ok"), "", close);
    const parts = [makeText("b", W.t("card.askSomeoneTitle")), makeText("p", text), actionsRow(copy, ok)];
    showOwnBox({ seq, note: true }, parts);
    fit(true);
  }

  async function copyNote(seq, text) {
    try {
      const done = await call("hide_in_clipboard", { seq, text });
      if (done?.ok) showNote(done.seq, W.t("card.noteCopiedTitle"), W.t("card.noteCopiedText"));
    } catch {
      console.warn(LOG, "could not copy the note");
    }
  }

  // Adds "Ask someone first" to the warning's own .actions div; left out entirely when there's no note to
  // show (an id ask-someone.js doesn't have a phrase for yet).
  function addAskSomeone(seq, text) {
    const actions = box()?.querySelector(".actions");
    if (!actions || !text) return;
    actions.append(makeButton(W.t("card.askSomeone"), "link", () => showAskSomeone(seq, text)));
  }

  // ---------- The choices ----------

  // Tries the real paste (main.rs's paste_clip): a reply of `false` means the box the card appeared over no
  // longer has the keyboard, so the text stays on the clipboard and the card says it's ready instead of just
  // closing.
  async function maybePaste(seq) {
    let pasted = false;
    try {
      pasted = await call("paste_clip", { seq });
    } catch {
      /* the text is still on the clipboard either way */
    }
    if (pasted) {
      close();
      return;
    }
    if (current?.seq === seq) showNote(seq, W.t("card.readyTitle"), W.t("card.readyText"));
  }

  // Swaps what was found for labels and puts the safe version on the clipboard. Returns main.rs's reply once
  // it's in place, or closes the card and returns null.
  async function hideInClipboard(onCard) {
    if (!onCard?.findings) return null;
    try {
      const copy = await call("read_clip", { seq: onCard.seq });
      if (copy.kind !== "text") {
        close();
        return null;
      }
      const ids = onCard.findings.map((finding) => finding.id);
      const safe = Host.redact(copy.text, ids);
      const done = await call("hide_in_clipboard", { seq: onCard.seq, text: safe });
      if (!done.ok) {
        close();
        return null;
      }
      if (current === onCard) current = { ...onCard, seq: done.seq }; // the safe copy is the card's now
      record(onCard.findings, "redacted", onCard.app);
      return done;
    } catch {
      console.warn(LOG, "could not hide it in the clipboard");
      close();
      return null;
    }
  }

  // "Leave it alone": the copy on the clipboard is left alone.
  async function leaveAndPaste() {
    const onCard = current;
    if (!onCard?.findings) return;
    record(onCard.findings, "allowed", onCard.app);
    await maybePaste(onCard.seq);
  }

  // "Clot this leak": the safe version replaces the copy, then Clotr tries to paste that.
  async function coverAndPaste() {
    const done = await hideInClipboard(current);
    if (!done) return;
    // Windows' clipboard history may still hold the original either way; that's worth saying more than a
    // paste is, so it takes the note instead when both apply.
    if (done.history) showNote(done.seq, W.t("card.historyTitle"), W.t("card.historyText"));
    else await maybePaste(done.seq);
  }

  // ---------- Checking a copy ----------

  // Reads the copy with this number. Returns its text, or null when there's nothing to check: a copy marked
  // private gets its note, anything else that isn't text just ends the check.
  async function readCopy(seq) {
    const copy = await call("read_clip", { seq });
    if (copy.kind === "private") {
      showNote(seq, W.t("card.privateTitle"), W.t("card.privateText"));
      return null;
    }
    if (copy.kind !== "text") {
      await call("card_done", { seq });
      return null;
    }
    return copy;
  }

  function isLogged(finding) {
    return finding.response === "log";
  }

  async function check({ seq, app }) {
    try {
      if (current) close();
      C.desktopSource("copied");
      const copy = await readCopy(seq);
      if (!copy) return;
      const lines = copy.text.split("\n").length;
      const found = Host.check(copy.text, { app, source: "copied" });
      copy.text = null; // never kept after the check
      // The engine ran out of time before the end: the card says so, and never lets the copy through in
      // silence.
      const partial = found.truncated === true;
      const counted = found.findings.filter(isLogged);
      const shown = found.findings.filter((finding) => !isLogged(finding) && !typedMine.has(keyOf(app, finding)));
      if (counted.length) record(counted, "suppressed", app);
      if (!shown.length) {
        if (partial) showNote(seq, W.t("card.partTitle"), W.t("card.partText"));
        else await call("card_done", { seq });
        return;
      }
      current = { seq, app, findings: shown, lines };
      warning.showNotice(resultsFor(shown), null, { leave: leaveAndPaste, cover: coverAndPaste, truncated: partial });
      addNoticeCloseButton();
      dismissOnEscape(box());
      addAskSomeone(seq, C.askSomeoneNoteForShare(locale));
      await fit(true);
      console.info(LOG, "card:", kindsOf(shown));
    } catch (err) {
      console.warn(LOG, "check skipped:", err?.name || "error");
      close();
    }
  }

  // ---------- Checking a command ----------

  // A command pasted into the Run box, a terminal, or a browser's file box, instead of an AI app: checked
  // against the extension's own command trick (commands.js), never the credential detector.
  async function clearCopied(seq) {
    try {
      const done = await call("hide_in_clipboard", { seq, text: "" });
      if (done?.ok) close();
    } catch {
      console.warn(LOG, "could not clear what was copied");
    }
  }

  function showCommandCard(seq, shape) {
    const bodyKey = shape === "hidden" ? "card.commandHidden" : "card.commandDownload";
    const why = document.createElement("div");
    why.className = "why";
    why.append(makeText("p", W.t("card.commandQuestion")), makeText("p", W.t("card.commandAnswer")));
    const clear = makeButton(W.t("card.clearCopied"), "primary", () => clearCopied(seq));
    const mine = makeButton(W.t("card.itsMine"), "", close);
    const askNote = () => showAskSomeone(seq, C.askSomeoneNoteForCommand(locale));
    const ask = makeButton(W.t("card.askSomeone"), "link", askNote);
    const parts = [makeText("b", W.t("card.commandTitle")), makeText("p", W.t(bodyKey)), why];
    showOwnBox({ seq, surface: true }, [...parts, actionsRow(clear, mine, ask)]);
    fit(true);
  }

  async function checkSurface({ seq, surface }) {
    try {
      if (current) close();
      const copy = await readCopy(seq);
      if (!copy) return;
      const trick = C.commandTrick(copy.text, "");
      copy.text = null; // never kept after the check
      if (!trick) {
        await call("card_done", { seq });
        return;
      }
      showCommandCard(seq, trick.shape);
      console.info(LOG, "card: command", surface, trick.shape);
    } catch (err) {
      console.warn(LOG, "check skipped:", err?.name || "error");
      close();
    }
  }

  // ---------- Checking what was typed ----------

  // Details the person said were theirs ("It's mine") in this app's box, and the counted ones already
  // recorded, so the next pause in the same message doesn't ask or count again, and copying that same detail
  // from the box right after doesn't raise the copy card either. Cleared once the box is empty (the message
  // went). Kinds and fingerprints only, never a value.
  const typedMine = new Set();
  const typedCounted = new Set();
  let typedPartNoted = false; // this message's "part of it wasn't checked" note was already shown

  function keyOf(app, finding) {
    return `${app}:${finding.type}:${finding.fp || finding.preview}`;
  }

  function sameFindings(before, now) {
    if (!Array.isArray(before) || before.length !== now.length) return false;
    return before.every((finding, i) => finding.type === now[i].type && finding.fp === now[i].fp);
  }

  // The first typed card says, once, what Clotr just did.
  function firstTypedNote() {
    if (settings.typedNoteSeen) return;
    const actions = box()?.querySelector(".actions");
    if (!actions) return;
    const line = makeText("p", W.t("card.typedNote"));
    line.className = "hint";
    actions.before(line);
    settings = { ...settings, typedNoteSeen: true };
    call("typed_note_seen").catch(() => {});
  }

  // "Clot this leak and copy": the box read once more (what's there now, not what was checked), its details
  // swapped for labels, and the result put on the clipboard. The person pastes it over their message.
  async function copySafe() {
    const onCard = current;
    if (!onCard?.typed || !onCard.findings) return;
    try {
      const again = await call("read_box_again", { seq: onCard.seq });
      if (again.kind !== "text") {
        close();
        return;
      }
      const ids = Host.check(again.text, { app: onCard.app, source: "typed" })
        .findings.filter((finding) => !isLogged(finding))
        .map((finding) => finding.id);
      const safe = Host.redact(again.text, ids);
      again.text = null;
      const done = await call("copy_safe", { seq: onCard.seq, text: safe });
      if (!done?.ok) {
        close();
        return;
      }
      record(onCard.findings, "redacted", onCard.app);
      showNote(onCard.seq, W.t("card.typedCopiedTitle"), W.t("card.typedCopiedText"));
      current.typed = true;
    } catch {
      console.warn(LOG, "could not copy the message with it hidden");
      close();
    }
  }

  function itsMine() {
    const onCard = current;
    if (!onCard?.typed || !onCard.findings) return;
    for (const finding of onCard.findings) typedMine.add(keyOf(onCard.app, finding));
    record(onCard.findings, "allowed", onCard.app);
    close();
  }

  // An empty box means the message went, so what this message's checks remembered is cleared.
  function forgetSentMessage() {
    typedMine.clear();
    typedCounted.clear();
    typedPartNoted = false;
  }

  // The kinds only counted (set to log) are recorded once per message.
  function recordCountedOnce(findings, app) {
    const counted = findings.filter((finding) => isLogged(finding) && !typedCounted.has(keyOf(app, finding)));
    for (const finding of counted) typedCounted.add(keyOf(app, finding));
    if (counted.length) record(counted, "suppressed", app);
  }

  // The last typed card's own box goes, so the new warning takes its place.
  function clearLastTypedCard() {
    watching?.disconnect();
    warning.closeNotice();
    note?.getRootNode().host.remove();
    note = null;
  }

  async function checkTyped({ seq, app }) {
    // A copy's card waits for its own choice (brain.rs asks for no typed check then), so a card here is the
    // last typed one, or its note.
    const prev = current?.typed ? current : null;
    // Done with this check, nothing to say: the card goes, or (none showing) the brain hears it's over.
    async function quiet() {
      if (!prev) {
        await call("card_done", { seq });
        return;
      }
      current.seq = seq;
      close();
    }
    try {
      if (current && !prev) close();
      const typed = await call("read_typed", { seq });
      if (typed.kind !== "text") {
        await quiet();
        return;
      }
      const lines = typed.text.split("\n").length;
      C.desktopSource("typed");
      const found = Host.check(typed.text, { app, source: "typed" });
      if (!typed.text.trim()) forgetSentMessage();
      typed.text = null; // never kept after the check
      const partial = found.truncated === true;
      recordCountedOnce(found.findings, app);
      const shown = found.findings.filter((finding) => !isLogged(finding) && !typedMine.has(keyOf(app, finding)));
      if (!shown.length) {
        if (partial && !typedPartNoted) {
          typedPartNoted = true;
          showNote(seq, W.t("card.partTitle"), W.t("card.partText"));
        } else await quiet();
        return;
      }
      if (prev && !prev.note && prev.partial === partial && sameFindings(prev.findings, shown)) {
        // The same details as the card already says: it stays as it is, under this check's number.
        current = { ...prev, seq, lines };
        await fit(true);
        return;
      }
      if (prev) clearLastTypedCard();
      current = { seq, app, findings: shown, lines, typed: true, partial };
      warning.showNotice(resultsFor(shown), null, { leave: itsMine, cover: copySafe, truncated: partial });
      addNoticeCloseButton();
      dismissOnEscape(box());
      firstTypedNote();
      await fit(true);
      console.info(LOG, "card: typed", kindsOf(shown));
    } catch (err) {
      console.warn(LOG, "typed check skipped:", err?.name || "error");
      close();
    }
  }

  // ---------- Starting up ----------

  // main.rs's act() sends { seq, app } for an AI app's copy, { seq, surface } for a surface's: never both.
  function clip(ask) {
    return ask.surface !== undefined ? checkSurface(ask) : check(ask);
  }

  function focusCard() {
    if (note) note.querySelector(".actions button")?.focus();
    else warning.focusNotice();
  }

  async function start() {
    // Listening for checks first, then saying hello: card_hello is when Clotr starts sending checks straight
    // here, and Tauri drops an event whose listener isn't registered yet. A check that comes before hello's
    // answer waits for it, so it's read with the settings hello brings.
    let said;
    const helloSaid = new Promise((resolve) => (said = resolve));
    function afterHello(handler) {
      return async (ask) => {
        await helloSaid;
        return handler(ask);
      };
    }
    await Promise.all([on("clip", afterHello(clip)), on("typed", afterHello(checkTyped))]);
    const hello = await call("card_hello");
    systemLocale = hello.systemLocale || hello.locale;
    useSettings(hello.settings);
    said();
    on("settings", useSettings);
    on("hide", () => close());
    on("reach", focusCard);
    if (hello.pending) (hello.pending.typed ? checkTyped : clip)(hello.pending);
  }

  start().catch(() => console.warn(LOG, "the card couldn't start"));
})();
