// Everything Clotr shows inside an AI page: the dialog, the corner warning, the reload prompt, the "Test
// Clotr here" outline, and Bandage's hotspots. It builds all of it in closed shadow roots and masks every
// value it shows. Deciding what a choice actually does is on-websites/content.js's job; this file just calls back
// into it.
(() => {
  "use strict";
  const LOG = "[Clotr]";

  // ---------- Building and keys ----------

  // Built with DOM APIs only: Google sites enforce Trusted Types, which rejects innerHTML.
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // A value never gets echoed back into the page in full; it's always masked, one line per kind, and the
  // warning's wording itself comes from decide.js so every site says the same thing.
  const { mask, describeValues, noticeWords } = globalThis.Clotr;

  // A key pressed out of habit shouldn't make a choice for someone. Space never presses a button or ticks a
  // box here, and Enter does nothing for a short moment after the UI appears, or while it's held down.
  // After that, Enter presses whatever button the user tabbed to, or the forward choice if they didn't.
  // Clicking with the mouse always works.
  const KEY_GRACE_MS = 600;

  function stopKey(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function isSpace(event) {
    return event.key === " " || event.key === "Spacebar";
  }

  function guardKeys(container, { enter = null } = {}) {
    const shownAt = Date.now();
    let tabbed = false;
    let deliberate = false; // reached with Clotr's keyboard shortcut
    container.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Tab") {
          tabbed = true;
          return;
        }
        if (isSpace(event) && !deliberate) {
          stopKey(event);
          return;
        }
        if (event.key !== "Enter") return;
        if (event.repeat || (!deliberate && Date.now() - shownAt < KEY_GRACE_MS)) {
          stopKey(event);
          return;
        }
        const focused = container.getRootNode().activeElement;
        const control = focused instanceof HTMLButtonElement || focused?.tagName === "SUMMARY";
        // Presses (or opens) what the user moved to.
        if (control && focused !== enter && (tabbed || deliberate)) return;
        stopKey(event);
        if (enter) enter.click();
      },
      true,
    );
    container.addEventListener(
      "keyup",
      (event) => {
        if (isSpace(event) && !deliberate) stopKey(event);
      },
      true,
    );
    // Reaching a button with the keyboard shortcut is a deliberate choice.
    return () => {
      deliberate = true;
    };
  }

  // ---------- Bulk pastes: summarize instead of listing every value ----------

  const BULK_ITEMS = 6; // more values than this → counts per type, no values
  const BULK_LINES = 20; // this many lines → mention the size

  const totalMatches = (results) => results.reduce((count, result) => count + result.matches.length, 0);
  const kindsOf = (results) => [...new Set(results.map((result) => result.name))].join(", ");

  // ---------- "Why am I seeing this?" and first-time tips ----------

  const YOURS = new Set(["phone_number", "email", "street_address"]); // kinds of data that can be "mine"
  const REPORT_URL = "https://github.com/clotr-app/clotr/issues/new";
  const aName = (name) => `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`; // "an Email Address"
  // Tourniquet's small shield, drawn beside its line in a warning.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SHIELD_PATH = "M8 1 14 3.4V8c0 3.4-2.5 6.1-6 7-3.5-.9-6-3.6-6-7V3.4Z";
  // The kinds a fake bank or tech-support call actually asks for, so the warning can say that plainly.
  const SCAM_TARGETS = new Set(["password", "credit_card", "card_code", "gift_card", "us_ssn", "bank_account"]);

  // Each copy of Clotr on the page gets one warning UI. app is on-websites/content.js's side of things: it tells the UI
  // what it needs to know, like the chat box and the current settings, and what each choice should do.
  // Nothing in this file records, stores or sends anything on its own.
  function create(app) {
    const { msg, generalForms } = globalThis.Clotr;
    const { getText } = globalThis.Clotr.editor;
    const IS_TOP = window === window.top;

    // ---------- Shared lines ----------

    // Turning on "Larger warnings" in Settings makes the text and buttons in Clotr's boxes bigger.
    const sized = (cls) => (app.largeText() ? `${cls} large` : cls);
    // A team's own kinds, named by the organization and set by its policy. The warning says so, the person
    // isn't offered to loosen them, and a public report never carries their names (one could name a client).
    const isTeam = (result) => Boolean(app.isTeamKind?.(result.id));
    function teamLine(results, className = "hint") {
      const names = [...new Set(results.filter(isTeam).map((result) => result.name))];
      if (!names.length) return [];
      const text =
        names.length === 1
          ? msg("teamKindLine", "$1 is a kind your organization added.", names[0])
          : msg("teamKindsLine", "$1 are kinds your organization added.", names.join(", "));
      return [el("p", { className, textContent: text })];
    }
    const publicName = (result) =>
      isTeam(result) ? msg("teamKindAnon", "A kind your organization added") : result.name;
    // The ten-second backstop in detect.js cut this check short. Shown alongside whatever else the warning
    // already says, so staying quiet about the cut-off part never reads as "all clear."
    function truncatedLine(truncated, className = "hint") {
      if (!truncated) return [];
      return [
        el("p", {
          className,
          textContent: msg(
            "truncatedLine",
            "This message was too long to check all the way through, so part of it wasn't checked.",
          ),
        }),
      ];
    }

    // ---------- Clotr's own boxes ----------
    // The dialog, the corner warning and the reload prompt all sit directly under <html>. If one of them
    // disappears without Clotr being the one that removed it, something on the page took it down, maybe a
    // hostile script, maybe just a framework rebuilding the page. Either way on-websites/content.js hears about it and
    // stops holding messages there, so nobody gets stuck waiting on a warning that's already gone.
    const ownRemovals = new WeakMap(); // node → removals by Clotr not yet seen by the observer
    const CLOTR_HOSTS = new Set(["CLOTR-GUARD", "CLOTR-NOTICE", "CLOTR-RELOAD"]);
    function removeOwn(node) {
      if (!node?.isConnected) return;
      ownRemovals.set(node, (ownRemovals.get(node) || 0) + 1);
      node.remove();
    }
    // Tracks every box this copy of Clotr puts on the page by the actual element, not by its tag name, so a
    // page that happens to use a tag called clotr-something doesn't get mistaken for Clotr's own. Bandage's
    // underlines never hide under these.
    const ownHosts = new WeakSet();
    function ownHost(tag) {
      const node = document.createElement(tag);
      ownHosts.add(node);
      return node;
    }
    // One removed node: Clotr's own removal is counted off, anything else is the page's doing.
    function noteRemoved(node) {
      if (!CLOTR_HOSTS.has(node.nodeName)) return;
      const mine = ownRemovals.get(node) || 0;
      if (mine) {
        ownRemovals.set(node, mine - 1);
        return;
      }
      app.removedByPage(node);
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) noteRemoved(node);
      }
    }).observe(document.documentElement || document, { childList: true });

    // ---------- Phones: the part of the page you can see ----------
    // On a phone the on-screen keyboard shrinks the visible part of the page and can scroll it, so a box
    // fixed to the top of the page can end up out of sight. The browser's visualViewport API reports what's
    // actually visible, and Clotr's boxes read it through two CSS variables to stay just below the visible
    // top and follow it as it moves. Without visualViewport, the CSS just places them the old way.
    const fitted = new Set(); // the corner warning's box and the dialogs' overlays
    function fitToVisible(node = null) {
      const view = window.visualViewport;
      if (!view) return;
      if (node) fitted.add(node);
      for (const box of fitted) {
        if (box !== node && !box.isConnected) {
          fitted.delete(box);
          continue;
        }
        box.style.setProperty("--vv-top", `${view.offsetTop}px`);
        box.style.setProperty("--vv-height", `${view.height}px`);
      }
    }
    for (const type of ["resize", "scroll"]) {
      window.visualViewport?.addEventListener(type, () => fitted.size && fitToVisible(), { passive: true });
    }

    // Draws a brief outline around the chat box Clotr is watching, for the popup's "Test Clotr here" button.
    // It never takes clicks, and it removes itself.
    function outline(box) {
      box.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = box.getBoundingClientRect();
      const host = ownHost("clotr-flash");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = globalThis.Clotr.styles.flash;
      const ring = document.createElement("div");
      ring.className = "ring";
      Object.assign(ring.style, {
        left: `${rect.left - 6}px`,
        top: `${rect.top - 6}px`,
        width: `${rect.width + 12}px`,
        height: `${rect.height + 12}px`,
      });
      shadow.append(style, ring);
      document.documentElement.append(host);
      setTimeout(() => host.remove(), 1900);
    }

    // ---------- Dialog (closed shadow DOM so site CSS/scripts can't interfere) ----------

    let host = null;
    let shadow = null;
    let dialogKind = null; // what the dialog asks about: "ask" (typed details) | "file" | "wait" (attached files)

    const DIALOG_CSS = globalThis.Clotr.styles.dialog;

    function isDialogOpen() {
      return Boolean(host && host.isConnected);
    }

    // ---------- What was found, in words ----------

    // How many lines the message or the file has.
    function linesIn(file, text) {
      if (file) return file.lines;
      if (text) return text.split("\n").length;
      return 0;
    }

    // "Large paste: 400 lines, with Email Address ×37, Phone Number ×12." or null.
    function bulkSummary(results, file = null) {
      const editor = app.editor();
      const text = app.messageText?.() || (editor ? getText(editor) : "");
      const lines = linesIn(file, text);
      const pasted = app.largeInput?.() === true;
      if (!file && totalMatches(results) <= BULK_ITEMS && (lines < BULK_LINES || !pasted)) return null;
      const counts = results.map((result) => `${result.name} ×${result.matches.length}`).join(", ");
      if (file?.count > 1) {
        return msg("bulkFiles", "$1 files you attached ($2) contain $3.", file.count, file.name, counts);
      }
      if (file) {
        return msg(
          "bulkFile",
          "The file “$1” you attached ($2) contains $3.",
          file.name,
          lines === 1 ? msg("linesOne", "1 line") : msg("linesMany", "$1 lines", lines),
          counts,
        );
      }
      if (lines >= BULK_LINES && pasted) return msg("bulkPaste", "Large paste: $1 lines, with $2.", lines, counts);
      return app.search()
        ? msg("bulkSearch", "This search has $1.", counts)
        : msg("bulkMessage", "This message has $1.", counts);
    }

    // ---------- Pictures ----------

    // What happens if the picture or scan is sent.
    function pictureSentLine(scan, everyday) {
      if (scan) {
        if (everyday) return msg("noticeSharedBulkHere", " If you send it, the people who read it here get it.");
        return msg("noticeSharedBulk", " If you send it, this AI gets it.");
      }
      if (everyday) return msg("picSentHere", " If you send it, the people who read it here get it.");
      return msg("picSent", " If you send it, this AI gets it.");
    }

    // The lead for a picture or scan that looks like an ID, going by its name.
    function idPictureLead(name, scan, place) {
      if (scan) {
        return msg("picFoundScan", "The file “$1” looks like a scan of an ID or document, going by its name.", name);
      }
      if (place) {
        return msg(
          "picFoundBoth",
          "The picture “$1” looks like a photo of an ID or document, going by its name, and has the place it was taken saved inside it.",
          name,
        );
      }
      return msg("picFoundId", "The picture “$1” looks like a photo of an ID or document, going by its name.", name);
    }

    // The lines for a photo whose only finding is the place it was taken.
    function placePictureLines(name, everyday, honest) {
      return {
        lead: [
          msg("picFoundPlace", "The photo “$1” has the place it was taken saved inside it.", name),
          everyday
            ? msg("picPlaceSentHere", " If you send it, the people who read it here can get that place too.")
            : msg("picPlaceSent", " If you send it, that place can go with it."),
        ],
        hint: msg(
          "picPlaceHint",
          "To keep the place private, take the photo off before you send. A screenshot of the photo doesn't carry the place.",
        ),
        honest,
      };
    }

    // A picture has no lines of text to count, so this just says plainly what kind of thing was found in it,
    // never the value itself, not even masked. It's also honest that Clotr can't actually read the words in
    // a picture, so the person has to look it over themselves. file.picture is "photo", or "scan" for a PDF
    // with no text, whenever one of the attached files turned out to be an image; null otherwise.
    function pictureLines(results, file) {
      if (!file?.picture) return null;
      const everyday = app.everyday();
      if (file.count > 1) {
        return {
          lead: null,
          hint: null,
          honest: msg("picHonest", "Clotr can't read the words in a picture, so look it over yourself."),
        };
      }
      const scan = file.picture === "scan";
      const honest = scan
        ? msg("picScanHonest", "Clotr can't read the words in a scan, so look it over yourself.")
        : msg("picHonest", "Clotr can't read the words in a picture, so look it over yourself.");
      const ids = new Set(results.map((result) => result.id));
      const place = ids.has("photo_location");
      const named = ids.has("id_picture");
      const only = ids.size === Number(place) + Number(named); // nothing else was found in it
      const sent = pictureSentLine(scan, everyday);
      if (only && named) {
        return {
          lead: [idPictureLead(file.name, scan, place), sent],
          hint: scan
            ? msg("noticeFileHint", "To keep it private, take the file off before you send.")
            : msg("picHint", "To keep it private, take the picture off before you send."),
          honest,
        };
      }
      if (only && place) return placePictureLines(file.name, everyday, honest);
      return {
        lead: [msg("picFoundOther", "The picture “$1” has $2 in it.", file.name, kindsOf(results)), sent],
        hint: msg("picHint", "To keep it private, take the picture off before you send."),
        honest,
      };
    }

    // ---------- The choices, in plain words ----------
    // Every warning offers a choice for right now, clot this leak or leave it alone, plus an optional
    // lasting one: remember this one item, or stop warning about this whole kind of data.

    function moreChoiceButton(text, onChoose) {
      const button = el("button", { className: "choice", textContent: text });
      button.addEventListener("click", () => onChoose());
      return button;
    }

    // The words of the "say it in general" choice, from the general forms found.
    function generalChoiceWords(forms, total, shown) {
      if (forms.length !== total) return msg("choiceGeneralMixed", 'Say "$1" instead, and hide the rest', shown);
      if (forms.length === 1) return msg("choiceGeneralOne", 'Say "$1" instead', shown);
      return msg("choiceGeneralMany", 'Keep it general: "$1"', shown);
    }

    // Builds the "More choices" section. Each button pairs today's answer with a lasting one. cover is null
    // for a file, since a file can't be remembered the way a typed value can. general swaps a detail for a
    // vaguer version, like a full address becoming just a city, and hides the rest.
    // If a team policy holds one of the listed kinds, or a PIN locks the settings, only the choices that add
    // protection are offered, and this returns null once none are left. A lasting choice that warns less
    // only takes effect once the person says yes on Clotr's own page, which opens beside the chat for it
    // (background.js askOnClotrPage).
    function moreChoices(results, { leave, cover, general = null }) {
      const loosen = !results.some((result) => app.isFirm(result.id));
      const perItem =
        !app.orphaned() &&
        app.canRemember() &&
        totalMatches(results) <= BULK_ITEMS &&
        !results.some((result) => app.isVaultType(result.id));
      const one = totalMatches(results) === 1;
      const own = results.filter((result) => !isTeam(result)); // a team's kinds stay as its policy set them
      const forms = general ? generalForms(results, navigator.language) : [];
      const shown = [...new Set(forms.map((form) => form.general))].slice(0, 3).join('", "');

      const buttons = [];
      if (forms.length) {
        buttons.push(moreChoiceButton(generalChoiceWords(forms, totalMatches(results), shown), general));
      }
      if (perItem && loosen) {
        const words = one
          ? msg("choiceAllowOne", "Leave it alone, and don't warn me about this one again")
          : msg("choiceAllowMany", "Leave them alone, and don't warn me about these again");
        buttons.push(
          moreChoiceButton(words, () => {
            app.addToVault(results, "allow");
            leave();
          }),
        );
      }
      if (loosen && own.length) {
        const words = msg("choiceLogKinds", "Leave it alone, and stop warning me about: $1", kindsOf(own));
        buttons.push(
          moreChoiceButton(words, () => {
            app.setToLog(own.map((result) => result.id));
            leave();
          }),
        );
      }
      if (perItem && cover) {
        const words = one
          ? msg("choiceProtectOne", "Clot this leak, and always watch for this one, however it's written")
          : msg("choiceProtectMany", "Clot these leaks, and always watch for these, however they're written");
        buttons.push(
          moreChoiceButton(words, () => {
            app.addToVault(results, "protect");
            cover();
          }),
        );
      }
      if (!buttons.length) return null;
      return el("details", { className: "more" }, [
        el("summary", { textContent: msg("moreChoices", "More choices") }),
        el("div", { className: "choices" }, buttons),
      ]);
    }

    // ---------- Tourniquet's line ----------

    // Tourniquet's words: the codes line first, then the preset's own line.
    function tourniquetWords(codes, word) {
      if (codes) {
        return msg(
          "tqLineCodes",
          "Passwords and sign-in codes are only for you. With one, someone else can get into your account.",
        );
      }
      if (word === "child") {
        return msg(
          "tqLineChild",
          "Only share this with people you know in real life. If someone online asks for it, tell an adult you trust.",
        );
      }
      if (word === "after_scam") {
        return msg(
          "tqLineAfterScam",
          "Scammers often come back, saying they can get your money back. Anyone who asks for a fee or your details to do that is a scammer too.",
        );
      }
      return msg(
        "tqLineAdult",
        "If someone says they're from a bank, an insurer or the government and asks for this, stop. Call them on a number you already know.",
      );
    }

    // One short line in the warning that says why this matters for the person Tourniquet is protecting. It's
    // the codes line whenever a password, key or sign-in code is listed, and otherwise whichever preset's own
    // line applies, such as the scam-recovery warning for someone who was already scammed once. The text is
    // always fixed, never a value, and an old copy of Clotr running after an update just skips this line.
    function tourniquetLine(results) {
      const word = app.tourniquet();
      if (!word || app.orphaned()) return null;
      const codes = results.some((result) => result.group === "credentials" && result.severity === "high");
      const text = tourniquetWords(codes, word);
      return el("p", { className: "tq" }, [shieldIcon(), el("span", { textContent: text })]);
    }

    // ---------- Who really asks for this ----------
    // A card's security code, a gift card's numbers and the codes a scammer reads out loud each get one extra
    // line under the lead, a question and its answer about who actually asks for that kind of thing.
    // decide.js's whoAsks holds the wording and the sources behind it. The tone stays calm rather than saying
    // "you're being scammed," and it's wrapped in its own try so that if anything here goes wrong, the
    // warning just shows without this line instead of getting stuck.
    function whoAsksIn(results) {
      try {
        return globalThis.Clotr.whoAsks(results);
      } catch {
        console.warn(LOG, "the who-asks line was skipped");
        return [];
      }
    }
    // Renames what a warning lists to the name people actually know, like "Sign-in Code," but only for the
    // words on screen. What History records still keeps the kind's real name.
    function shownOf(results) {
      try {
        return globalThis.Clotr.asShown(results);
      } catch {
        return results;
      }
    }

    // ---------- Icons ----------

    function setAttributes(node, attributes) {
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    }
    function svgIcon(className) {
      const icon = document.createElementNS(SVG_NS, "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("class", className);
      return icon;
    }
    function shieldIcon() {
      const icon = svgIcon("tq-icon");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", SHIELD_PATH);
      icon.append(path);
      return icon;
    }
    // A question mark in a disc, drawn: no font to wait for.
    function askIcon() {
      const icon = svgIcon("ask-icon");
      const disc = document.createElementNS(SVG_NS, "circle");
      setAttributes(disc, { class: "disc", cx: 8, cy: 8, r: 8 });
      const mark = document.createElementNS(SVG_NS, "path");
      mark.setAttribute("class", "mark");
      mark.setAttribute("d", "M5.8 6.2a2.2 2.2 0 1 1 3.1 2c-.6.3-.9.7-.9 1.3v.4");
      const dot = document.createElementNS(SVG_NS, "circle");
      setAttributes(dot, { class: "dot", cx: 8, cy: 12.2, r: 1 });
      icon.append(disc, mark, dot);
      return icon;
    }
    // Clotr's own mark, drawn small and white for the notice's label strip: the same C with the bandage
    // across its mouth as the toolbar icon, simplified to one colour.
    function plasterIcon() {
      const icon = svgIcon("plaster-icon");
      const ring = document.createElementNS(SVG_NS, "path");
      setAttributes(ring, { d: "M9.8 4.3a4.3 4.3 0 1 0 0 7.4", class: "plaster-ring" });
      const plaster = document.createElementNS(SVG_NS, "g");
      plaster.setAttribute("transform", "translate(11.2 8) rotate(-45)");
      const outer = document.createElementNS(SVG_NS, "rect");
      setAttributes(outer, { x: -2.1, y: -4, width: 4.2, height: 8, rx: 2.1, class: "plaster-outer" });
      const pad = document.createElementNS(SVG_NS, "rect");
      setAttributes(pad, { x: -1.1, y: -1.3, width: 2.2, height: 2.6, rx: 0.5, class: "plaster-pad" });
      plaster.append(outer, pad);
      icon.append(ring, plaster);
      return icon;
    }
    // A question (bold, on its own line) and its answer, in Tourniquet's warm box.
    function askBox(icon, question, answer, extra = "") {
      return el("p", { className: `tq ask${extra}` }, [
        icon,
        el("span", {}, [el("b", { textContent: question }), ` ${answer}`]),
      ]);
    }

    // Picks the single line that goes under the lead. Normally it's who really asks for the first kind or
    // code listed, shown with Tourniquet's shield instead of a question mark when Tourniquet is on, which
    // also takes the place of Tourniquet's own codes line. If there's no such question, it falls back to
    // Tourniquet's line, or shows nothing at all.
    function warningLine(results, asks = whoAsksIn(results)) {
      const ask = asks[0];
      if (!ask) return tourniquetLine(results);
      const withTourniquet = Boolean(app.tourniquet()) && !app.orphaned();
      return askBox(withTourniquet ? shieldIcon() : askIcon(), ask.q, ask.a);
    }

    // ---------- The Ask before sending dialog ----------

    // One line per kind found: how serious it is, its name and its values, masked.
    function foundItems(shown) {
      return shown.map((result) =>
        el("li", {}, [
          el("span", {
            className: `sev ${result.severity}`,
            textContent: msg(`sev_${result.severity}`, result.severity),
          }),
          `${result.name}: `,
          el("code", { textContent: describeValues(result) }),
        ]),
      );
    }

    function askDialogLeadWords() {
      if (app.search()) {
        return msg("dialogLeadSearch", "If you search for this, it goes out as part of your search:");
      }
      if (app.everyday()) return msg("dialogLeadHere", "If you send this, the people who read it here will see:");
      return msg("dialogLead", "If you send this, the AI service will see:");
    }

    // "Clot this leak" is the brand's verb, so each choice's tooltip says plainly what it does.
    function askDialogButtons(resend) {
      const redactBtn = el("button", {
        className: "primary",
        textContent: msg("coverIt", "Clot this leak"),
        title: msg("coverItHint", "Covers the detail before it's sent"),
      });
      const allowBtn = el("button", {
        textContent: resend ? msg("leaveItSend", "Leave it and send") : msg("leaveIt", "Leave it alone"),
        title: resend
          ? msg("leaveItSendHint", "Sends your message as it is, with nothing covered")
          : msg("leaveItHint", "Closes this warning and leaves your message as it is"),
      });
      const backBtn = el("button", {
        className: "link",
        textContent: app.search()
          ? msg("backToSearch", "Go back to my search (Esc)")
          : msg("backToMessage", "Go back to my message (Esc)"),
      });
      return { redactBtn, allowBtn, backBtn };
    }

    function askDialogBox(results, { items, bulk, line, more, truncated, buttons }) {
      const { redactBtn, allowBtn, backBtn } = buttons;
      return el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", { id: "title", textContent: msg("dialogTitle", "⚠️ This looks private") }),
        el("p", { textContent: askDialogLeadWords() }),
        ...(bulk ? [el("p", { className: "bulk", textContent: bulk })] : []),
        el("ul", {}, items),
        ...(line ? [line] : []),
        ...teamLine(results, "note"),
        ...truncatedLine(truncated, "note"),
        el("div", {
          className: "note",
          textContent: msg(
            "dialogNote",
            "Clotr checked this on your computer, and nothing's been sent yet. Clot this leak swaps it for a label like $1.",
            `[REDACTED ${results[0].name.toUpperCase()}]`,
          ),
        }),
        el("div", { className: "actions" }, [allowBtn, redactBtn]),
        ...(more ? [more] : []),
        el("div", { className: "keys" }, [
          el("span", { textContent: msg("enterCovers", "Enter: Clot this leak") }),
          backBtn,
        ]),
      ]);
    }

    // The "Ask before sending" dialog, where one decision covers everything listed. resend means this dialog
    // actually stopped a send, so leaving it in now sends the message. back returns to the message unchanged.
    function showDialog(results, { resend, leave, cover, general, back, truncated = false }) {
      if (!host) {
        host = ownHost("clotr-guard");
        shadow = host.attachShadow({ mode: "closed" });
      }

      const shown = shownOf(results);
      const items = foundItems(shown);
      const bulk = bulkSummary(shown);
      const line = warningLine(results);
      const more = moreChoices(results, { leave, cover, general });
      const buttons = askDialogButtons(resend);
      const { redactBtn, allowBtn, backBtn } = buttons;
      const box = askDialogBox(results, { items, bulk, line, more, truncated, buttons });
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "title"); // its own shadow root, so the id can't meet the page's

      backBtn.addEventListener("click", () => back());
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" && event.key !== "Backspace") return;
        if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        event.stopPropagation();
        back();
      });
      redactBtn.addEventListener("click", () => cover());
      allowBtn.addEventListener("click", () => leave());

      const overlay = el("div", { className: "overlay" }, [box]);
      // Clicking outside doesn't dismiss: the user has to choose.
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) shakeDialog();
      });

      guardKeys(box, { enter: redactBtn });
      fitToVisible(overlay);
      shadow.replaceChildren(el("style", { textContent: DIALOG_CSS }), overlay);
      if (!host.isConnected) document.documentElement.append(host);
      dialogKind = "ask";
      // Pull focus out of the chat box so further typing/Enter can't slip through.
      box.focus();
    }

    function closeDialog() {
      removeOwn(host);
    }

    function shakeDialog() {
      const box = shadow && shadow.querySelector(".box");
      if (!box) return;
      box.classList.remove("shake");
      void box.offsetWidth; // restart the animation
      box.classList.add("shake");
    }

    // ---------- Attached files held for Ask before sending ----------
    // Most sites upload a file the moment it's attached, so Clotr can only hold the message, not the file
    // itself, and these dialogs say so plainly. They're built like the one above, same box, same keys.

    // A file's name with its kind ("PDF") on a small badge.
    function fileChip(name) {
      const ext = (name.match(/\.([A-Za-z0-9]{1,4})$/) || [])[1];
      return el("span", { className: "file" }, [
        ...(ext ? [el("b", { textContent: ext.toUpperCase() })] : []),
        el("span", { textContent: name }),
      ]);
    }

    // Opens Clotr's dialog box with the given content and takes focus. Esc or Backspace goes back, and
    // clicking outside just shakes the dialog instead of closing it.
    function openFileDialog(box, { enter, back, kind }) {
      if (!host) {
        host = document.createElement("clotr-guard");
        shadow = host.attachShadow({ mode: "closed" });
      }
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "title"); // its own shadow root, so the id can't meet the page's
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" && event.key !== "Backspace") return;
        event.preventDefault();
        event.stopPropagation();
        back();
      });
      const overlay = el("div", { className: "overlay" }, [box]);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) shakeDialog();
      });
      guardKeys(box, { enter });
      shadow.replaceChildren(el("style", { textContent: DIALOG_CSS }), overlay);
      if (!host.isConnected) document.documentElement.append(host);
      dialogKind = kind;
      box.focus();
    }

    // Under an organization's policy, this adds one plain line in the same colors as Clotr's other offers.
    // It only ever says "your organization," so the AI site has no way to learn the employer's name from
    // Clotr.
    function orgFileLine(here) {
      return el("p", {
        className: "team",
        textContent: here
          ? msg(
              "fileTeamLineHere",
              "Your organization asks Clotr to check files with these details before they're sent. Sending is still your choice.",
            )
          : msg(
              "fileTeamLine",
              "Your organization asks Clotr to check files with these details before they go into an AI chat. Sending is still your choice.",
            ),
      });
    }

    // Under an organization's policy, a file that's still being read after a few seconds gets its own dialog,
    // styled like the reload prompt rather than a warning, since it's a wait and not a problem. "Wait for the
    // check" is the main button, reached with Enter, "Send now" sends without waiting, and Esc goes back to
    // the message. name is the attached files' names, already quoted for display.
    function showFileWait(name, count, { wait, now, back }) {
      const many = count > 1;
      const nowBtn = el("button", { textContent: msg("fileWaitNow", "Send now, without the check") });
      nowBtn.addEventListener("click", () => now());
      const waitBtn = el("button", { className: "primary", textContent: msg("fileWaitWait", "Wait for the check") });
      waitBtn.addEventListener("click", () => wait());
      const backBtn = el("button", {
        className: "link",
        textContent: msg("backToMessage", "Go back to my message (Esc)"),
      });
      backBtn.addEventListener("click", () => back());
      const box = el("div", { className: sized("box wait"), tabIndex: -1 }, [
        el("h2", {
          id: "title",
          textContent: many
            ? msg("fileWaitTitleMany", "Clotr is still checking your files")
            : msg("fileWaitTitle", "Clotr is still checking your file"),
        }),
        el("p", {
          textContent: many
            ? msg(
                "fileWaitLeadMany",
                "$1 are large, and Clotr hasn't finished reading them. Your organization asks Clotr to check files before they're sent.",
                name,
              )
            : msg(
                "fileWaitLead",
                "$1 is large, and Clotr hasn't finished reading it. Your organization asks Clotr to check files before they're sent.",
                name,
              ),
        }),
        el("div", {
          className: "note",
          textContent: msg(
            "fileWaitNote",
            "This usually takes a few seconds. If nothing private turns up, your message goes out on its own. If something does, you'll see what it is first.",
          ),
        }),
        el("div", { className: "actions" }, [nowBtn, waitBtn]),
        el("div", { className: "keys" }, [
          el("span", { textContent: msg("enterKey", "Enter: $1", waitBtn.textContent) }),
          backBtn,
        ]),
      ]);
      openFileDialog(box, { enter: waitBtn, back, kind: "wait" });
    }

    // ---------- The file hold's words ----------

    function holdLeadWords(many, here) {
      if (many && here) {
        return msg(
          "fileHoldLeadManyHere",
          "If you send your message, the people who read it here get the files you attached, and they contain:",
        );
      }
      if (many) {
        return msg(
          "fileHoldLeadMany",
          "If you send your message, this AI service gets the files you attached, and they contain:",
        );
      }
      if (here) {
        return msg(
          "fileHoldLeadHere",
          "If you send it, the people who read it here get the file you attached, and it contains:",
        );
      }
      return msg("fileHoldLead", "If you send it, this AI service gets the file you attached, and it contains:");
    }

    function holdNoteWords(many, here) {
      if (many && here) {
        return msg(
          "fileHoldNoteManyHere",
          "Most sites upload a file as soon as you attach it, so this site may already have copies. To keep them from the people who read it here, remove the files before you send.",
        );
      }
      if (many) {
        return msg(
          "fileHoldNoteMany",
          "Most sites upload a file as soon as you attach it, so this AI service may already have copies. To keep them out of the chat, remove the files before you send.",
        );
      }
      if (here) {
        return msg(
          "fileHoldNoteHere",
          "Most sites upload a file as soon as you attach it, so this site may already have a copy. To keep it from the people who read it here, remove the file before you send.",
        );
      }
      return msg(
        "fileHoldNote",
        "Most sites upload a file as soon as you attach it, so this AI service may already have a copy. To keep it out of the chat, remove the file before you send.",
      );
    }

    function offLeadWords(many, here, name) {
      if (many && here) {
        return msg(
          "fileOffLeadManyHere",
          "If you removed $1, your message can go. If they're still attached, the people who read it here get them.",
          name,
        );
      }
      if (many) {
        return msg(
          "fileOffLeadMany",
          "If you removed $1, your message can go. If they're still attached, this AI service gets them.",
          name,
        );
      }
      if (here) {
        return msg(
          "fileOffLeadHere",
          "If you removed $1, your message can go. If it's still attached, the people who read it here get it.",
          name,
        );
      }
      return msg(
        "fileOffLead",
        "If you removed $1, your message can go. If it's still attached, this AI service gets it.",
        name,
      );
    }

    // ---------- The file hold ----------

    // The first ask: what's inside the files, masked, with going back to remove them as the main button.
    function firstHoldBox(results, file, { many, here, sendBtn, back }) {
      const enter = el("button", {
        className: "primary",
        textContent: many ? msg("fileGoBackMany", "Go back to remove them") : msg("fileGoBack", "Go back to remove it"),
      });
      enter.addEventListener("click", () => back());
      const items = foundItems(shownOf(results));
      const line = warningLine(results);
      const box = el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", {
          id: "title",
          textContent: many
            ? msg("fileHoldTitleMany", "⚠️ These files look private")
            : msg("fileHoldTitle", "⚠️ This file looks private"),
        }),
        el("p", { textContent: holdLeadWords(many, here) }),
        el("div", { className: "files" }, [
          ...file.names.slice(0, 3).map(fileChip),
          ...(file.count > 3
            ? [el("span", { className: "more-files", textContent: msg("andMore", "and $1 more", file.count - 3) })]
            : []),
        ]),
        el("ul", {}, items),
        ...(line ? [line] : []),
        ...teamLine(results, "note"),
        ...(file.team ? [orgFileLine(here)] : []),
        el("div", { className: "note", textContent: holdNoteWords(many, here) }),
        el("div", { className: "actions" }, [sendBtn, enter]),
        el("div", { className: "keys" }, [
          el("span", { textContent: msg("fileHoldKeys", "Enter or Esc: back to your message") }),
        ]),
      ]);
      return { box, enter };
    }

    // The later ask, "Is the file off?": both buttons send, and differ only in what gets counted.
    function offHoldBox(file, { many, here, sendBtn, off, back }) {
      const enter = el("button", {
        className: "primary",
        textContent: many ? msg("fileOffSendMany", "They're off, send") : msg("fileOffSend", "It's off, send"),
      });
      enter.addEventListener("click", () => off());
      const backBtn = el("button", {
        className: "link",
        textContent: msg("backToMessage", "Go back to my message (Esc)"),
      });
      backBtn.addEventListener("click", () => back());
      const box = el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", {
          id: "title",
          textContent: many
            ? msg("fileOffTitleMany", "⚠️ Are the files off?")
            : msg("fileOffTitle", "⚠️ Is the file off?"),
        }),
        el("p", { textContent: offLeadWords(many, here, file.name) }),
        el("div", {
          className: "note",
          textContent: msg("fileOffNote", "Clotr can't see a site's attachments, so it takes your word for it."),
        }),
        el("div", { className: "actions" }, [sendBtn, enter]),
        el("div", { className: "keys" }, [
          el("span", { textContent: msg("enterKey", "Enter: $1", enter.textContent) }),
          backBtn,
        ]),
      ]);
      return { box, enter };
    }

    // The dialog about files Clotr is holding back. The first time, it shows what's inside them (masked),
    // warns that the site may already have a copy, and makes "Go back to remove it" the main button, so
    // both Enter and Esc go back. A later send asks "Is the file off?" instead, where both buttons send and
    // only differ in what gets counted. file holds the name, names, count and whether this is that second
    // ask.
    function showFileHold(results, file, { send, off, back }) {
      const many = file.count > 1;
      const here = app.everyday();
      const sendBtn = el("button", {
        textContent: many ? msg("fileSendWithMany", "Send with the files") : msg("fileSendWith", "Send with the file"),
      });
      sendBtn.addEventListener("click", () => send());
      const { box, enter } = file.second
        ? offHoldBox(file, { many, here, sendBtn, off, back })
        : firstHoldBox(results, file, { many, here, sendBtn, back });
      openFileDialog(box, { enter, back, kind: "file" });
    }

    // ---------- Warn notice (doesn't block, doesn't take focus) ----------

    let noticeHost = null;
    let noticeShadow = null;
    let noticeFocus = null; // () => focuses the notice's main button (keyboard shortcut Alt+Shift+C)
    let noticeKind = null; // what the corner notice shows: "warn" | "file" | "offer"
    let noticeOpenedAt = 0; // when the current warning first appeared
    const SHORTCUT_HINT = msg(
      "keyboardHint",
      "Keyboard: Alt+Shift+C jumps here, Enter chooses, Esc goes back to your message.",
    );

    // Keyboard users reach the notice with Clotr's shortcut, and Esc returns to the chat box.
    function keyboardReach(box, main) {
      const arm = guardKeys(box, { enter: main });
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" && event.key !== "Backspace") return;
        event.preventDefault();
        event.stopPropagation();
        app.editor()?.focus();
      });
      box.append(el("p", { className: "sr-only", textContent: SHORTCUT_HINT }));
      noticeFocus = () => {
        arm();
        main.focus();
      };
    }

    // The keyboard shortcut (Alt+Shift+C) moves to the open notice's main button.
    function focusNotice() {
      if (isNoticeOpen() && noticeFocus) noticeFocus();
    }

    const NOTICE_CSS = globalThis.Clotr.styles.notice;

    function isNoticeOpen() {
      return Boolean(noticeHost && noticeHost.isConnected);
    }

    // ---------- Why am I seeing this? ----------

    let whyOpen = false;
    let tip = null; // the first-time tip in the current notice: { id, name, match, single, status }

    function scamLine(results) {
      if (!results.some((result) => SCAM_TARGETS.has(result.id))) return "";
      return msg("whyScam", "No real bank, company or help line will ever ask you for this. ");
    }

    function whyFound(results, file) {
      const names = [...new Set(results.map((result) => result.name))].join(", ");
      if (file?.count > 1) {
        return msg("whyFoundFiles", "Clotr found what looks like: $1, in the files $2. ", names, file.name);
      }
      return file
        ? msg("whyFoundFile", "Clotr found what looks like: $1, in the file “$2”. ", names, file.name)
        : msg("whyFound", "Clotr found what looks like: $1. ", names);
    }
    function whyBody() {
      return msg(
        "whyBody",
        "Whatever you send an AI can stay on its servers, be read by the people who run it, or be used to train it. Nothing has left your computer yet, and it's your call: clot this leak, leave it alone, or use More choices to decide how Clotr handles this from now on.",
      );
    }

    // Builds what's behind "Why am I seeing this?": what Clotr found and what happens next if it's sent. If
    // one of the listed kinds is something a scammer typically asks for, "What to do" replaces the general
    // sentence, and every other such kind adds its own question and answer below it. It ends with a link to
    // Clotr's "Is this a scam?" page, for whoever's message actually asked for the detail.
    function whyParts(results, shown, file, asks) {
      if (!asks.length) return [el("p", { textContent: whyFound(shown, file) + scamLine(results) + whyBody() })];
      const second = secondOpinion();
      return [
        el("p", { textContent: whyFound(shown, file) }),
        askBox(askIcon(), msg("ss_askWhatToDo", "What to do"), asks[0].todo, " todo"),
        ...asks.slice(1).map((ask) => askBox(askIcon(), ask.q, ask.a)),
        ...(second ? [second] : []),
        el("p", { textContent: whyBody() }),
      ];
    }
    // Adds the "Got a message asking for this? Get a second opinion" link, which has the background worker
    // open the "Is this a scam?" page in a new tab; nothing from the page or the message goes with it. An
    // old copy of Clotr left running after an update can't reach the background, so it skips offering this.
    function secondOpinion() {
      if (!app.openCheck || app.orphaned()) return null;
      const open = el("button", {
        className: "link",
        type: "button",
        textContent: msg("ss_secondOpinion", "Get a second opinion"),
      });
      open.addEventListener("click", () => app.openCheck());
      return el("p", { className: "second-opinion" }, [
        msg("ss_secondOpinionQ", "Got a message asking for this?"),
        " ",
        open,
      ]);
    }

    // ---------- First-time tips ----------

    // Keeps the tip that's showing, or picks the first kind not yet guided. Returns false when there's none.
    function chooseTip(results) {
      if (tip && results.some((result) => result.id === tip.id)) return true;
      const fresh = results.find((result) => !app.isGuided(result.id) && !app.isVaultType(result.id));
      if (!fresh) {
        tip = null;
        return false;
      }
      tip = {
        id: fresh.id,
        name: fresh.name,
        match: fresh.matches[0],
        single: fresh.matches.length === 1,
        status: "",
      };
      app.markGuided(fresh.id);
      return true;
    }

    // Tourniquet holds this kind, so the tip just explains what that means, with no choices offered,
    // since every choice here would loosen it.
    function tourniquetTip(tipBox, kind) {
      tipBox.append(
        el("p", {
          textContent:
            app.responseOf(kind.id) === "block"
              ? msg(
                  "tqTipAsks",
                  "Tourniquet is on, so Clotr asks before $1 goes out. You can always leave it alone.",
                  aName(kind.name),
                  kind.name,
                )
              : msg(
                  "tqTipNotes",
                  "Tourniquet is on, so Clotr warns about $1 every time. You can always leave it alone.",
                  aName(kind.name),
                  kind.name,
                ),
        }),
      );
      return tipBox;
    }

    // A choice that warns less, on every site, only takes effect once the person says yes on Clotr's own
    // page, which opens beside the chat for it (background.js), since this page could have steered the click.
    function tipAskedThere() {
      return msg("tipAskedThere", "To change this on every site, say yes on the Clotr page that just opened.");
    }

    // "How should Clotr handle this from now on?" with Warn me, Just count it and Ask before sending.
    // keeps(value) says whether a choice may be offered; done(text) shows the answer in place of the tip.
    function tipChoices(kind, { current, keeps, done }) {
      function tipChoiceButton(value, label, after) {
        const button = el("button", { className: value === current ? "chosen" : "", textContent: label });
        button.setAttribute("aria-pressed", String(value === current));
        button.addEventListener("click", () => {
          done(app.setResponse([kind.id], value) ? tipAskedThere() : after);
        });
        return button;
      }
      const buttons = [];
      if (keeps("warn")) {
        const after = msg("tipWarnDone", "Got it. Clotr will keep warning you about $1.", aName(kind.name), kind.name);
        buttons.push(tipChoiceButton("warn", msg("tipWarn", "Warn me"), after));
      }
      if (keeps("log")) {
        const after = msg(
          "tipLogDone",
          "Got it. Clotr will just count $1 quietly. You can change that in Settings whenever you like.",
          aName(kind.name),
          kind.name,
        );
        buttons.push(tipChoiceButton("log", msg("tipLog", "Just count it"), after));
      }
      const blockAfter = msg(
        "tipBlockDone",
        "Got it. Clotr will ask you before $1 gets sent. You can change that in Settings whenever you like.",
        aName(kind.name),
        kind.name,
      );
      buttons.push(tipChoiceButton("block", msg("tipBlock", "Ask before sending"), blockAfter));
      return [
        el("p", {}, [
          el("b", { textContent: msg("tipNew", "New: ") }),
          msg("tipHow", "How should Clotr handle $1 from now on?", aName(kind.name), kind.name),
        ]),
        el("div", { className: "choices" }, buttons),
      ];
    }

    // "Is this phone number yours?" for one detail of a kind that can be someone's own.
    function tipYoursPart(kind, { held, done }) {
      function saveTipAnswer(mode, after) {
        return () => {
          app.addToVault([{ id: kind.id, matches: [kind.match] }], mode);
          done(after);
        };
      }
      const mine = el("button", { textContent: msg("tipMine", "Always watch it") });
      mine.addEventListener(
        "click",
        saveTipAnswer(
          "protect",
          msg(
            "tipMineDone",
            "Saved to your vault. Clotr will always watch for this $1, however it's written.",
            kind.name,
          ),
        ),
      );
      const share = el("button", { textContent: msg("tipShare", "It's fine to share") });
      share.addEventListener("click", saveTipAnswer("allow", tipAskedThere()));
      return [
        el("p", { textContent: msg("tipYours", "Is this $1 yours?", kind.name) }),
        el("div", { className: "choices" }, held ? [mine] : [mine, share]),
      ];
    }

    // The first time Clotr warns about a kind of data, it asks how to treat it from now on, and for a kind
    // like a phone number or address, whether this particular one is the user's own. It's shown once per
    // kind, and stays while the notice is open even though the notice itself gets rebuilt on every pause
    // in typing.
    function firstTimeTip(results) {
      if (app.orphaned()) return null;
      if (!chooseTip(results)) return null;
      const kind = tip;
      const tipBox = el("div", { className: "tip" });
      if (app.tourniquet() && app.isFirm(kind.id)) return tourniquetTip(tipBox, kind);
      function done(text) {
        kind.status = text;
        tipBox.replaceChildren(el("p", { textContent: text }));
      }
      if (kind.status) {
        done(kind.status);
        return tipBox;
      }
      const current = app.responseOf(kind.id);
      // If a PIN locks the settings, or an organization's policy holds this kind, only the choices that keep
      // or add protection are offered, so there's no way to use this tip to get around the PIN.
      const held = app.isFirm(kind.id);
      const keeps = (value) => !held || globalThis.Clotr.stricter(value, current) === value;
      const parts = tipChoices(kind, { current, keeps, done });
      if (YOURS.has(kind.id) && kind.single && app.canRemember()) parts.push(...tipYoursPart(kind, { held, done }));
      tipBox.replaceChildren(...parts);
      return tipBox;
    }

    // Offers Bandage in the warning the first time a personal detail shows up on a site.
    function bandageOffer() {
      const yesButton = el("button", { className: "primary", textContent: msg("bandageYes", "Yes, use cover names") });
      const noButton = el("button", { textContent: msg("bandageNo", "No thanks") });
      yesButton.addEventListener("click", () => app.answerBandage(true));
      noButton.addEventListener("click", () => app.answerBandage(false));
      return el("div", { className: "tip" }, [
        el("p", {
          textContent: msg(
            "bandageOffer",
            "🩹 Want Clotr to swap details like this for a cover name, like [Phone 1], on this site from now on? The AI still follows what you mean. It just never sees the real thing.",
          ),
        }),
        el("div", { className: "actions" }, [noButton, yesButton]),
      ]);
    }

    // ---------- The notice's words ----------

    // noticeWords (decide.js) only knows "everyday" or an AI; a search engine is neither, so its own words
    // are built here instead, in the same shape, rather than teaching decide.js a third audience.
    function noticeWordsForSearch(results) {
      return {
        lead: msg("noticeContainsSearch", "Your search contains "),
        items: results.flatMap((result) => result.matches.map((match) => `${result.name} (${mask(match, result.id)})`)),
        tail: msg("noticeSharedSearch", ". If you send it, it goes out as part of your search."),
      };
    }

    // decide.js builds the sentence every site uses, with one <code> element per item, so the sentence
    // wraps between items instead of overflowing the notice. Each item reads "name (masked)"; the masked
    // part never has a space in it, so letting the item itself wrap (on-websites/warning-styles.js) only ever breaks
    // between words of a long translated name, never inside the masked part.
    function noticeWordsFor(bulk, shown) {
      if (bulk) return null;
      if (app.search()) return noticeWordsForSearch(shown);
      return noticeWords(shown, { everyday: app.everyday() });
    }

    // The share codes in a paste that's nothing but links, named for the notice.
    function linkOnlyParams(shown) {
      const params = shown.flatMap((result) =>
        result.matches.flatMap((match) => globalThis.Clotr.cleanableParamsOf(match)),
      );
      return [...new Set(params)].join(", ");
    }

    function bulkTailWords(everyday) {
      if (app.search()) return msg("noticeSharedBulkSearch", " If you send it, it goes out as part of your search.");
      if (everyday) return msg("noticeSharedBulkHere", " If you send it, the people who read it here get it.");
      return msg("noticeSharedBulk", " If you send it, this AI gets it.");
    }

    // A link with a share code: what the code tells the app, and that only the code goes.
    function linkBody(everyday, linkParams) {
      return [
        el("p", {}, [
          msg(
            everyday ? "cl_leadPeople" : "cl_leadAi",
            everyday
              ? "Your message has a link with a share code ($1) that the app added when you copied it. It can tell the app, and sometimes whoever opens the link, that you're the one who shared it."
              : "Your message has a link with a share code ($1) that the app added when you copied it. It can tell the app the link came from you.",
            linkParams,
          ),
        ]),
        el("p", { className: "hint" }, [
          el("b", { textContent: msg("cl_lineTitle", "Only the code goes") }),
          ` ${msg(
            "cl_lineText",
            "Clotr removes the share code and the ad-tracking parts it knows. The rest of the link stays as it is.",
          )}`,
        ]),
      ];
    }

    // The lead sentence (what was found) and the tail (what happens if it's sent) read as two short lines
    // instead of one run-on paragraph; decide.js still owns both sentences' words.
    function noticeBody({ pic, bulk, linkOnly, everyday, words, what, linkParams }) {
      if (pic?.lead) return [el("p", {}, pic.lead)];
      if (bulk) return [el("p", {}, [bulk, bulkTailWords(everyday)])];
      if (linkOnly) return linkBody(everyday, linkParams);
      return [el("p", {}, [words.lead, ...what]), el("p", {}, [words.tail.replace(/^\.\s*/, "")])];
    }

    // For an attached file: how to keep it private, and, for a picture, that Clotr can't read its words.
    function noticeFileHints(file, pic) {
      if (!file) return [];
      const hint =
        pic?.hint ||
        (file.count > 1
          ? msg("noticeFilesHint", "To keep them private, take those files off before you send.")
          : msg("noticeFileHint", "To keep it private, take the file off before you send."));
      return [
        el("p", { className: "hint", textContent: hint }),
        ...(pic ? [el("p", { className: "hint", textContent: pic.honest })] : []),
      ];
    }

    function noticeActions(file, { stripBtn, keepBtn, redactBtn }) {
      if (!file) return [redactBtn, keepBtn];
      if (stripBtn) return [stripBtn, keepBtn];
      return [keepBtn];
    }

    // ---------- The notice's buttons ----------

    function noticeButtons(results, { file, linkOnly, strip }) {
      const redactBtn = el("button", {
        className: "primary",
        textContent: linkOnly ? msg("cl_remove", "Remove the share code") : msg("noticeCover", "Clot this leak"),
        ...(linkOnly ? {} : { title: msg("coverItHint", "Covers the detail before it's sent") }),
      });
      const keepBtn = el("button", {
        textContent: file ? msg("ok", "OK") : msg("noticeSendAsIs", "Leave it alone"),
        ...(file ? {} : { title: msg("leaveItHint", "Closes this warning and leaves your message as it is") }),
      });
      // Offered only for one attached photo whose place was found, and only when on-websites/content.js actually has a
      // way to rebuild it. strip is null for every other warning, and for HEIC or WebP, which aren't
      // rebuilt.
      const stripOffered =
        Boolean(strip) && file && !file.count && results.some((result) => result.id === "photo_location");
      const stripBtn = stripOffered
        ? el("button", { className: "primary", textContent: msg("picStripIt", "Remove the place, keep the photo") })
        : null;
      return { redactBtn, keepBtn, stripBtn };
    }

    // "Wrong?" opens a prefilled GitHub issue naming only the kind of data, never the value or the site.
    // It's a page the user has to choose to open themselves; Clotr itself never sends anything.
    function reportButton(results) {
      const reportBtn = el("button", {
        className: "link",
        textContent: msg("reportFalseAlarm", "Wrong? Report a false alarm"),
      });
      reportBtn.addEventListener("click", () => {
        const kinds = [...new Set(results.map(publicName))].join(", ");
        const title = encodeURIComponent(`False alarm: ${kinds}`);
        const url = `${REPORT_URL}?template=false-alarm.yml&title=${title}&kind=${encodeURIComponent(kinds)}`;
        window.open(url, "_blank", "noopener");
      });
      return reportBtn;
    }

    // A button, not a link: this is a content script running on the chat page, not Clotr's own page, so
    // opening clotr-pages/how-ads-follow-you/how-ads-follow-you.html goes through the background (app.openTracking()) the same way "Get a second
    // opinion" reaches clotr-pages/scam-check/scam-check.html, instead of a raw chrome-extension:// href the chat page can't navigate to.
    function learnMoreButton(linkOnly) {
      if (!linkOnly) return null;
      const learnMoreLink = el("button", {
        className: "link",
        type: "button",
        textContent: msg("cl_learnMore", "How ads follow you"),
      });
      learnMoreLink.addEventListener("click", () => app.openTracking());
      return learnMoreLink;
    }

    // The "Why?" button and the section it opens, which stays open across rebuilds while the notice is up.
    function whySection(results, { shown, file, asks, linkOnly }) {
      const whyBtn = el("button", { className: "link", textContent: msg("noticeWhy", "Why?") });
      whyBtn.setAttribute("aria-expanded", String(whyOpen));
      const reportBtn = reportButton(results);
      const learnMoreLink = learnMoreButton(linkOnly);
      const why = el("div", { className: "why", hidden: !whyOpen }, [
        ...whyParts(results, shown, file, asks),
        ...(learnMoreLink ? [learnMoreLink] : []),
        reportBtn,
      ]);
      whyBtn.addEventListener("click", () => {
        whyOpen = !whyOpen;
        why.hidden = !whyOpen;
        whyBtn.setAttribute("aria-expanded", String(whyOpen));
      });
      return { whyBtn, why };
    }

    // The Bandage offer, or else the first-time tip, for typed details only.
    function noticeTipBox(results, file, bulk) {
      const offerBandage =
        app.bandageUnasked() &&
        !file &&
        !bulk &&
        !app.orphaned() &&
        results.some((result) => result.group !== "credentials" && result.bandage !== false);
      if (offerBandage) return bandageOffer();
      if (!file && !bulk) return firstTimeTip(results);
      return null;
    }

    // ---------- The corner warning ----------

    // The notice's box, in reading order.
    function noticeBox(results, { head, body, truncated, file, pic, line, buttons, more, tipBox, whyBtn, why }) {
      const box = el("div", { className: sized("notice card") }, [
        head,
        ...body,
        ...teamLine(results),
        ...truncatedLine(truncated),
        ...noticeFileHints(file, pic),
        ...(app.orphaned()
          ? [
              el("p", {
                className: "hint",
                textContent: msg("noticeUpdated", "Clotr just updated. Reload this page so it can save your choices."),
              }),
            ]
          : []),
        ...(line ? [line] : []),
        el("div", { className: "actions" }, noticeActions(file, buttons)),
        ...(more ? [more] : []),
        ...(tipBox ? [tipBox] : []),
        whyBtn,
        why,
      ]);
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      return box;
    }

    function wireNoticeButtons({ redactBtn, keepBtn, stripBtn }, { leave, cover, strip }) {
      // Calling cover() with no arguments, rather than passing the click event, since a truthy first
      // argument there means "keep it general".
      redactBtn.addEventListener("click", () => cover());
      keepBtn.addEventListener("click", () => leave());
      // on-websites/content.js does the actual work (reading the file, rebuilding it, trying to put it back) and only
      // tells this box what to show once it knows the outcome; clicking twice while that's in flight would
      // just read the same file again, so the button goes quiet until it's done.
      stripBtn?.addEventListener("click", () => {
        stripBtn.disabled = true;
        stripBtn.textContent = msg("picStripping", "Removing the place…");
        Promise.resolve(strip()).catch(() => {});
      });
    }

    // Builds the corner warning. file holds a name and line count when the warning is about an attached
    // file, since a file can't be redacted, only removed by the user. leave keeps what was found, and
    // cover hides it, or keeps it general if called with true.
    function showNotice(results, file, { leave, cover, truncated = false, strip = null }) {
      if (!noticeHost) {
        noticeHost = ownHost("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      // Named as people know them ("Sign-in Code"), and who really asks for them.
      const shown = shownOf(results);
      const asks = whoAsksIn(results);
      const bulk = bulkSummary(shown, file);
      const pic = pictureLines(results, file);
      // A paste that's nothing but a link with a share code reads differently: there's no "detail" to
      // hide, just a tracking part to strip, so the notice calls that out by name instead of the generic
      // wording.
      const linkOnly = !file && !bulk && shown.length > 0 && shown.every((result) => result.id === "share_link");
      const linkParams = linkOnly ? linkOnlyParams(shown) : "";
      const words = noticeWordsFor(bulk, shown);
      const what = bulk
        ? []
        : words.items.flatMap((item, index) => [...(index ? [", "] : []), el("code", { textContent: item })]);
      const buttons = noticeButtons(results, { file, linkOnly, strip });
      const { redactBtn, keepBtn, stripBtn } = buttons;
      const { whyBtn, why } = whySection(results, { shown, file, asks, linkOnly });
      const tipBox = noticeTipBox(results, file, bulk);
      const everyday = app.everyday();
      const line = warningLine(results, asks);
      const more = moreChoices(results, {
        leave: () => leave(),
        cover: file ? null : () => cover(),
        general: file ? null : () => cover(true),
      });
      // The label strip names the one kind found; with several kinds, a file or a bulk paste, it stays
      // general.
      const headText =
        !file && !bulk && shown.length === 1 ? shown[0].name : msg("noticeTitle", "Before you send this");
      const head = el("div", { className: "head" }, [plasterIcon(), el("b", { textContent: headText })]);
      const body = noticeBody({ pic, bulk, linkOnly, everyday, words, what, linkParams });
      const box = noticeBox(results, { head, body, truncated, file, pic, line, buttons, more, tipBox, whyBtn, why });

      wireNoticeButtons(buttons, { leave, cover, strip });

      keyboardReach(box, stripBtn || (file ? keepBtn : redactBtn));
      if (!isNoticeOpen() || noticeKind !== (file ? "file" : "warn")) noticeOpenedAt = Date.now();
      noticeKind = file ? "file" : "warn";
      fitToVisible(box);
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
    }

    function closeNotice() {
      noticeKind = null;
      tip = null;
      whyOpen = false;
      removeOwn(noticeHost);
    }

    // Shows a quiet note in the corner while a send waits on an attached file that's still being read. It's
    // read out politely and has nothing to press. name is the file names, already quoted for display.
    function showChecking(name, count) {
      if (!noticeHost) {
        noticeHost = document.createElement("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      const box = el("div", { className: sized("notice checking") }, [
        el("b", {
          textContent:
            count > 1 ? msg("fileCheckingMany", "Checking your files") : msg("fileChecking", "Checking your file"),
        }),
        el("p", {
          textContent: msg(
            "fileCheckingBody",
            "Clotr is reading $1 before your message goes. This takes a few seconds at most, then it sends or asks you.",
            name,
          ),
        }),
      ]);
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      noticeFocus = null;
      noticeKind = "checking";
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
    }

    function closeChecking() {
      if (noticeKind === "checking") closeNotice();
    }

    // ---------- "Clotr was updated: reload this page" ----------
    // Shown by an old, orphaned copy of Clotr that an update left running without replacing. The page is
    // greyed out until the user answers, and choosing "Later" lets the old copy keep warning as before,
    // though it never holds a message back.

    let reloadHost = null;
    let reloadAsked = false;
    const RELOAD_CSS = globalThis.Clotr.styles.reload;

    function reloadPromptBox(draft, { reloadBtn, laterBtn, status }) {
      const box = el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", { textContent: msg("reloadTitle", "🔄 Clotr was updated") }),
        el("p", {
          textContent: msg("reloadLead", "Clotr needs this page reloaded to keep protecting you here."),
        }),
        ...(draft
          ? [
              el("p", {
                textContent: msg(
                  "reloadDraft",
                  "Reloading can wipe what you're writing, so Clotr copies it first. Paste it back with Ctrl+V.",
                ),
              }),
            ]
          : []),
        el("div", {
          className: "note",
          textContent: msg("reloadNote", "Until you do, Clotr still warns you here. It just can't save your choices."),
        }),
        status,
        el("div", { className: "actions" }, [laterBtn, reloadBtn]),
      ]);
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      return box;
    }

    function laterReload() {
      closeReloadPrompt();
      app.editor()?.focus();
    }

    // Enter goes forward (reload), Esc or Backspace goes back to the page.
    function watchReloadKeys(box, reloadBtn) {
      box.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          laterReload();
        }
      });
      box.addEventListener("keyup", (event) => event.stopPropagation());
      guardKeys(box, { enter: reloadBtn });
    }

    function showReloadPrompt() {
      if (reloadAsked || app.retired() || !IS_TOP) return;
      reloadAsked = true;
      reloadHost = ownHost("clotr-reload");
      const root = reloadHost.attachShadow({ mode: "closed" });
      const editor = app.editor();
      const draft = editor?.isConnected ? getText(editor).trim() : "";
      const reloadBtn = el("button", {
        className: "primary",
        textContent: draft ? msg("reloadCopy", "Copy my message and reload") : msg("reloadPage", "Reload this page"),
      });
      const laterBtn = el("button", { textContent: msg("later", "Later") });
      const status = el("p", { className: "bulk", role: "status" });
      const box = reloadPromptBox(draft, { reloadBtn, laterBtn, status });
      let copyFailed = false;
      reloadBtn.addEventListener("click", async () => {
        if (draft && !copyFailed) {
          const copied = await navigator.clipboard.writeText(draft).then(
            () => true,
            () => false,
          );
          if (!copied) {
            // never lose the user's message: let them copy it themselves first
            copyFailed = true;
            status.textContent = msg(
              "reloadCopyFailed",
              "Clotr couldn't copy your message. Copy it yourself first (select it, then Ctrl+C), then reload.",
            );
            reloadBtn.textContent = msg("reloadAnyway", "Reload anyway");
            return;
          }
        }
        location.reload();
      });
      laterBtn.addEventListener("click", laterReload);
      watchReloadKeys(box, reloadBtn);
      const overlay = el("div", { className: "overlay" }, [box]);
      fitToVisible(overlay);
      root.replaceChildren(el("style", { textContent: DIALOG_CSS + RELOAD_CSS }), overlay);
      document.documentElement.append(reloadHost);
      box.focus();
    }

    function closeReloadPrompt() {
      removeOwn(reloadHost);
    }

    // ---------- Offers ----------
    // Local only: "add to your vault?", "warn less?", and short notes after a choice.

    let offerTimer = null;

    // A click on an offer's button: close it, then run the answer, then go back to the chat box.
    function offerAnswer(onAnswer) {
      return () => {
        clearTimeout(offerTimer);
        closeNotice();
        onAnswer?.();
        app.editor()?.focus();
      };
    }

    function showOffer({ title, text, yes, no, onYes, onNo }) {
      if (!noticeHost) {
        noticeHost = ownHost("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      const yesBtn = el("button", { className: "primary", textContent: yes });
      const noBtn = no ? el("button", { textContent: no }) : null;
      const box = el("div", { className: sized("notice offer") }, [
        el("b", { textContent: title }),
        el("p", { textContent: text }),
        el("div", { className: "actions" }, noBtn ? [noBtn, yesBtn] : [yesBtn]),
      ]);
      box.setAttribute("role", "status");
      yesBtn.addEventListener("click", offerAnswer(onYes));
      noBtn?.addEventListener("click", offerAnswer(onNo));
      keyboardReach(box, yesBtn);
      noticeKind = "offer";
      fitToVisible(box);
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
      clearTimeout(offerTimer);
      offerTimer = setTimeout(() => {
        if (noticeKind === "offer") closeNotice();
      }, 30000);
    }

    // Tells the user Bandage has finished covering the details that held their send.
    function tellCovered() {
      showOffer({
        title: msg("bandageHeldTitle", "🩹 Details covered"),
        text: msg("bandageHeldText", "Your details have cover names now. Press Enter again to send."),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // Clotr took the place out of the photos before the page's own handler ever saw them, so the site only
    // has the copies without it. `name` is the photo's name when there's one, `onPutBack` hands the site the
    // originals too.
    function tellPlaceRemovedFirst(name, count, onPutBack) {
      showOffer({
        title: msg("picStripDoneTitle", "🩹 Place removed"),
        text: name
          ? msg(
              "picStripFirstText",
              "The photo “$1” had the place it was taken saved inside it. Clotr took the place out before the site got the photo, and the photo itself looks the same.",
              name,
            )
          : msg(
              "picStripFirstMany",
              "$1 photos had the place they were taken saved inside them. Clotr took the places out before the site got them, and the photos themselves look the same.",
              String(count),
            ),
        yes: msg("ok", "OK"),
        no: msg("picPutBack", "Put the place back"),
        onNo: onPutBack,
      });
    }

    // The site got the originals as well, next to the copies it already had.
    function tellPlaceBack(count) {
      showOffer({
        title: msg("picPutBackTitle", "ℹ️ The place is back"),
        text:
          count > 1
            ? msg(
                "picPutBackMany",
                "Clotr gave the site the photos with their places too. If the copies without them are still in your message, you can take those off.",
              )
            : msg(
                "picPutBackText",
                "Clotr gave the site the photo with its place too. If the copy without the place is still in your message, you can take that one off.",
              ),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    function tellPlaceNotBack() {
      showOffer({
        title: msg("picPutBackFailedTitle", "⚠️ Clotr couldn't put the place back"),
        text: msg(
          "picPutBackFailedText",
          "The site didn't take the original photo from Clotr. Attach it again and it goes in with its place.",
        ),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // Clotr held a drop or paste to check it, and the page didn't take it back. Whatever Clotr cleaned can be
    // saved; the next drop or paste here goes straight to the site.
    function tellNotTaken(onSave) {
      showOffer({
        title: msg("picNotTakenTitle", "⚠️ The site didn't take your photo"),
        text: onSave
          ? msg(
              "picNotTakenSave",
              "Clotr took the place out of your photo, but this site didn't take the copy from Clotr. Save the copy without the place, then add it again.",
            )
          : msg(
              "picNotTakenText",
              "This site didn't take the photo when Clotr passed it on. Add it again and it goes straight in.",
            ),
        yes: onSave ? msg("picStripFallbackSave", "Save a copy without the place") : msg("ok", "OK"),
        no: null,
        onYes: onSave,
      });
    }

    // The warning's "Remove the place, keep the photo", for a photo the site got before Clotr could hold it:
    // the original may already be uploaded, so a copy to attach instead is what Clotr can offer.
    function tellStripFallback(onSave) {
      showOffer({
        title: msg("picStripFallbackTitle", "🩹 Here's the cleaned photo"),
        text: msg(
          "picStripFallbackText",
          "The site may already have the original photo with its place. Take that photo off your message, then save this copy and attach it instead.",
        ),
        yes: msg("picStripFallbackSave", "Save a copy without the place"),
        no: null,
        onYes: onSave,
      });
    }

    // Nothing was built at all: an odd or unsupported file. The usual advice still stands.
    function tellStripFailed() {
      showOffer({
        title: msg("picStripFailedTitle", "⚠️ Clotr couldn't remove the place"),
        text: msg(
          "picStripFailedText",
          "This photo didn't rebuild the way Clotr expected. Take it off before you send, the way you would otherwise.",
        ),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // Clot this leak didn't take: say so plainly, so nobody sends a key they think is gone.
    function tellCoverFailed(results) {
      const names = [...new Set(results.map((result) => result.name))].join(", ");
      showOffer({
        title: msg("coverFailTitle", "⚠️ Clotr couldn't hide it here"),
        text: msg(
          "coverFailText",
          "This chat box wouldn't let Clotr change your message, so it still has $1 in it. Please delete it yourself before you send.",
          names,
        ),
        yes: msg("coverFailOk", "OK, I'll delete it"),
        no: null,
      });
    }

    // Offers to always watch for items the user deleted by hand before sending. items is
    // [{ id, name, value }].
    function offerVault(items, onYes) {
      const what = items.map((item) => `${item.name} (${mask(item.value, item.id)})`).join(", ");
      showOffer({
        title: msg("offerVaultTitle", "💡 Always watch for this?"),
        text:
          items.length === 1
            ? msg(
                "offerVaultOne",
                "You took $1 out before sending. Want Clotr to always catch it, however it's written? Add it to your vault. Only a fingerprint is saved, never the thing itself.",
                what,
              )
            : msg(
                "offerVaultMany",
                "You took $1 out before sending. Want Clotr to always catch them, however they're written? Add them to your vault. Only fingerprints are saved, never the things themselves.",
                what,
              ),
        yes: msg("offerVaultYes", "Add to my vault"),
        no: msg("noThanks", "No thanks"),
        onYes,
      });
    }

    // The user kept warnings about one kind of data several times lately: offer to just count it.
    function offerRelax(name, count, onYes, onNo) {
      showOffer({
        title: msg("relaxTitle", "💡 Warn less about $1?", name),
        text: msg(
          "relaxText",
          'You\'ve kept $1 $2 times lately. Switch it to "Just count": still counted in your history, but no more notices. You can change it back in Settings.',
          name,
          count,
        ),
        yes: msg("tipLog", "Just count it"),
        no: msg("keepWarning", "Keep warning"),
        onYes,
        onNo,
      });
    }

    function justSentWords(search, everyday, items) {
      if (search) {
        return msg(
          "justSentTextSearch",
          "Your search had $1 in it. If that was a mistake, clear it from your search history if you can. Next time, Clotr can ask you first.",
          items.join(", "),
        );
      }
      if (everyday) {
        return msg(
          "justSentTextHere",
          "Your message had $1 in it. If that was a mistake, delete or unsend it if you can. Next time, Clotr can ask you first.",
          items.join(", "),
        );
      }
      return msg(
        "justSentText",
        "Your message had $1 in it. If that was a mistake, delete the message in the chat. Next time, Clotr can ask you first.",
        items.join(", "),
      );
    }

    // A warned message went out before the warning could be read: say what went, and offer to ask first.
    function tellJustSent(results, onAskFirst) {
      const items = results.flatMap((result) =>
        result.matches.map((match) => `${result.name} (${mask(match, result.id)})`),
      );
      const everyday = app.everyday();
      const search = app.search();
      showOffer({
        title:
          everyday || search
            ? msg("justSentTitleHere", "⚠️ Just sent")
            : msg("justSentTitle", "⚠️ Just sent to this AI"),
        text: justSentWords(search, everyday, items),
        yes: msg("askFirstNextTime", "Ask me first next time"),
        no: msg("ok", "OK"),
        onYes: onAskFirst,
      });
    }

    // Tells the user a file wasn't checked, either because Clotr couldn't read it or ran out of time, so
    // the message was never held back for it.
    function tellFileUnchecked(name, count) {
      showOffer({
        title:
          count > 1
            ? msg("fileUncheckedTitleMany", "ℹ️ Clotr couldn't check some files")
            : msg("fileUncheckedTitle", "ℹ️ Clotr couldn't check a file"),
        text:
          count > 1
            ? msg(
                "fileUncheckedTextMany",
                "Clotr couldn't read $1, so they weren't checked. If they hold anything private, take them out of the chat.",
                name,
              )
            : msg(
                "fileUncheckedText",
                "Clotr couldn't read $1, so it wasn't checked. If it holds anything private, take it out of the chat.",
                name,
              ),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // The first picture attached on an AI site, with nothing found in it: Clotr can't read the words in a
    // picture, so it says so, once per site, and the person looks it over themselves.
    function tellCantReadPictures() {
      showOffer({
        title: msg("picNoteTitle", "ℹ️ Clotr can't read pictures"),
        text: msg(
          "picNoteText",
          "Clotr checks the words you type and the text in files you attach. It can't read the words in a picture or a screenshot, so look this one over for your details before you send it.",
        ),
        yes: msg("picNoteOk", "OK, I'll look"),
        no: null,
      });
    }

    // The message was too long for detect() to check all the way through (ten-second backstop in
    // detect.js), and nothing turned up in the part it did check. Staying quiet here would read as "all
    // clear" for the whole message, so this says so on its own, the same corner and look as any other notice.
    function tellTruncated() {
      showOffer({
        title: msg("truncatedTitle", "ℹ️ Part of this wasn't checked"),
        text: msg(
          "truncatedText",
          "This message was too long to check all the way through, so part of it wasn't checked. Nothing turned up in the part Clotr did check, so look over the rest yourself before you send it.",
        ),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // Builds the content for the command-check note, shown when a command copied on an AI chat matches the
    // "verify you're human, press Win+R and paste this" trick. It says plainly what the command would do and
    // who really asks for this, and offers "Clear what I copied" or "Keep it" without ever stopping or
    // changing the copy itself. shape is just "download" or "hidden"; the actual command is never stored or
    // logged, and this shows at most once per copied command.
    function commandCopiedNote(shape) {
      const title = msg("cmdTitle", "⚠️ You copied a command");
      const what =
        shape === "hidden"
          ? msg("cmdHidden", "It runs hidden instructions on your computer.")
          : msg("cmdDownload", "It downloads something and runs it on your computer.");
      const question = msg("cmdQuestion", "Who asks you to paste a command to prove you're human?");
      const answer = msg(
        "cmdAnswer",
        "No real check does: it's a common trick to put harmful software on a computer. Only run a command you asked for and understand.",
      );
      const icon = document.createElementNS(SVG_NS, "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("aria-hidden", "true");
      const circle = document.createElementNS(SVG_NS, "circle");
      setAttributes(circle, { cx: "8", cy: "8", r: "7" });
      const mark = document.createElementNS(SVG_NS, "text");
      setAttributes(mark, { x: "8", y: "12", "text-anchor": "middle" });
      mark.textContent = "?";
      icon.append(circle, mark);
      const qbox = el("div", { className: "qbox" }, [
        icon,
        el("div", {}, [el("b", { textContent: question }), el("p", { textContent: answer })]),
      ]);
      return { title, what, qbox };
    }

    function closeCommandNote() {
      closeNotice();
      app.editor()?.focus();
    }

    // Shows the note. clear empties the clipboard; on-websites/content.js passes it in, and it runs from this click so
    // it still counts as a user gesture.
    function tellCommandCopied(shape, { clear }) {
      if (!noticeHost) {
        noticeHost = ownHost("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      const { title, what, qbox } = commandCopiedNote(shape);
      const clearBtn = el("button", { className: "primary", textContent: msg("cmdClear", "Clear what I copied") });
      const keepBtn = el("button", { textContent: msg("cmdKeep", "Keep it") });
      const status = el("p", { className: "hint", role: "status" });
      const whyBtn = el("button", { className: "link", textContent: msg("why", "Why am I seeing this?") });
      whyBtn.setAttribute("aria-expanded", "false");
      const why = el("div", { className: "why", hidden: true }, [
        el("p", {
          textContent: msg(
            "cmdWhy",
            "Clotr looks at commands you copy on AI chats. This one is the kind a “verify you're human” trick hands out: it runs something on your computer without showing what. Clotr only read what you copied, on this computer, and keeps nothing.",
          ),
        }),
      ]);
      whyBtn.addEventListener("click", () => {
        const open = why.hidden;
        why.hidden = !open;
        whyBtn.setAttribute("aria-expanded", String(open));
      });
      keepBtn.addEventListener("click", closeCommandNote);
      let cleared = false;
      clearBtn.addEventListener("click", async () => {
        if (cleared) return;
        const ok = await clear();
        cleared = true;
        clearBtn.disabled = true;
        status.textContent = ok
          ? msg("cmdCleared", "Done: there's nothing to paste now.")
          : msg("cmdClearFailed", "Clotr couldn't clear it. As long as you don't paste it, it can't run.");
      });
      const box = el("div", { className: sized("notice command") }, [
        el("b", { textContent: title }),
        el("p", { textContent: what }),
        qbox,
        status,
        el("div", { className: "actions" }, [keepBtn, clearBtn]),
        whyBtn,
        why,
      ]);
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      keyboardReach(box, clearBtn);
      noticeKind = "command";
      fitToVisible(box);
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
    }

    // ---------- Bandage step 2: hotspots over labels, and the hover-to-peek bubble ----------
    // on-websites/content.js finds each cover-name label on the page with a live Range, and this lays an invisible,
    // focusable hotspot over it in its own shadow layer, without touching the page itself. Hovering or
    // tabbing to a hotspot opens a small bubble with the real detail, and "Copy with real names" copies the
    // whole answer back with details restored. A label from before a reload is marked older, since Clotr no
    // longer has its detail, and its bubble says so instead of showing anything. Every hotspot remembers
    // which chat it belongs to, so the same label in a different chat still shows that chat's own detail,
    // and switching chats without a reload clears every hotspot and bubble at once.
    const peekSpots = []; // { node, start, range, label, root, chat, older, btn, rect, onScreen, covered, checked }
    let spotHost = null;
    let spotLayer = null;
    let spotFrame = 0;
    let spotTimer = 0; // re-places the hotspots once a second while there are any: layouts shift without a scroll
    const MAX_OLDER_SPOTS = 200; // a long chat from before a reload: the first labels found are enough

    const hasSpots = () => peekSpots.length > 0;
    const hasSpot = (node, start) => peekSpots.some((spot) => spot.node === node && spot.start === start);
    function notKept(label) {
      return msg(
        "bandageNotKept",
        "Clotr didn't keep the real detail behind $1: real details are forgotten when the page reloads.",
        label,
      );
    }

    // A label found at `start` in the text node `node`, inside the reply `root`, in the chat `chat`. False
    // when there are enough already.
    function addSpot(node, start, label, root, chat, older = false) {
      if (older && peekSpots.filter((spot) => spot.older).length >= MAX_OLDER_SPOTS) return false;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + label.length);
      peekSpots.push({ node, start, range, label, root, chat, older, btn: null, covered: false, checked: 0 });
      return true;
    }
    // True while spot still belongs to the page's current chat. Checking the current chat is also how a chat
    // switch gets noticed, which is what makes on-websites/content.js go clear every hotspot.
    const sameChat = (spot) => app.currentChat() === spot.chat;

    function dropSpot(index) {
      const spot = peekSpots[index];
      if (peekTarget === spot) closePeek();
      spot.btn?.remove();
      peekSpots.splice(index, 1);
    }

    // Repositions each hotspot over its label, once per frame, after scrolls and resizes, after a new reply,
    // and once a second besides. A label that changed or left the page loses its hotspot, every hotspot
    // goes once the chat changes, and a hotspot also hides while something on the page covers its label,
    // which checkCovers below figures out.
    function placeSpots() {
      coverAsked = true;
      placeNextFrame();
    }
    // A label that changed, left the page or belongs to another chat loses its hotspot.
    function dropStaleSpots(chat) {
      for (let index = peekSpots.length - 1; index >= 0; index--) {
        const spot = peekSpots[index];
        if (!spot.node.isConnected || spot.range.toString() !== spot.label || spot.chat !== chat) dropSpot(index);
      }
    }

    // No hotspots left: the layer, the timer and the watch all go.
    function stopSpots() {
      removeOwn(spotHost);
      spotHost = null;
      clearInterval(spotTimer);
      spotTimer = 0;
      watchCovers(false);
    }

    function newSpotLayer() {
      spotHost = ownHost("clotr-spots");
      const root = spotHost.attachShadow({ mode: "closed" });
      spotLayer = el("div", { className: "layer" });
      root.append(el("style", { textContent: globalThis.Clotr.styles.spots }), spotLayer);
      document.documentElement.append(spotHost);
      for (const spot of peekSpots) spot.btn = null; // the old layer went away with its buttons
    }

    function spotButton(spot) {
      const button = el("button", { type: "button", className: spot.older ? "spot older" : "spot" });
      button.setAttribute(
        "aria-label",
        spot.older ? notKept(spot.label) : msg("bandagePeekLabel", "Show the real detail for $1", spot.label),
      );
      button.addEventListener("pointerenter", () => showPeek(spot));
      button.addEventListener("pointerleave", schedulePeekClose);
      button.addEventListener("focus", () => showPeek(spot));
      button.addEventListener("blur", schedulePeekClose);
      button.addEventListener("click", () => showPeek(spot));
      return button;
    }

    function addSpotButtons() {
      for (const spot of peekSpots) {
        if (spot.btn) continue;
        spot.btn = spotButton(spot);
        spotLayer.append(spot.btn);
      }
    }

    // Every label's place is read first and every hotspot moved after, so the page is laid out once per
    // frame however many labels there are.
    function measureSpots() {
      for (const spot of peekSpots) {
        const rect = spot.range.getBoundingClientRect();
        spot.rect = rect;
        spot.onScreen = Boolean(rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight);
      }
    }

    function moveSpotButtons() {
      for (const spot of peekSpots) {
        const rect = spot.rect;
        const hide = !spot.onScreen || spot.covered;
        if (spot.btn.hidden !== hide) spot.btn.hidden = hide;
        Object.assign(spot.btn.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      }
    }

    // One frame's placement.
    function placeFrame() {
      const chat = app.currentChat(); // first: a changed chat has cleared every hotspot by the time this returns
      dropStaleSpots(chat);
      if (!peekSpots.length) {
        stopSpots();
        return;
      }
      // A sidebar opening or an image loading moves the labels without a scroll or resize event.
      if (!spotTimer) spotTimer = setInterval(() => document.visibilityState === "visible" && placeSpots(), 1000);
      if (!spotHost?.isConnected) newSpotLayer();
      addSpotButtons();
      measureSpots();
      watchCovers(true);
      const more = checkCovers();
      moveSpotButtons();
      // An open bubble would point at nothing you can see once its label is covered.
      if (peekTarget?.onScreen && peekTarget.covered) closePeek();
      if (peekTarget) positionPeek(peekTarget.rect);
      if (more) placeNextFrame(); // more labels on screen than one frame checks: the rest on the next frame
    }
    function placeNextFrame() {
      cancelAnimationFrame(spotFrame);
      spotFrame = requestAnimationFrame(app.safely(placeFrame));
    }
    addEventListener("scroll", () => peekSpots.length && placeSpots(), { capture: true, passive: true });
    addEventListener("resize", () => peekSpots.length && placeSpots(), { passive: true });

    // ---------- Underlines under the page's own pop-ups ----------
    // A site's sign-up pop-up, a menu, or its own header and input box can sit on top of a label, which would
    // draw the dotted underline right over them. So for each label on screen, Clotr asks the browser what's
    // drawn on top near both ends of the label and hides the hotspot when that's something else on the
    // page, ignoring Clotr's own boxes. Checking costs two hit tests per label, so only COVER_CHECKS labels
    // get checked each frame, the ones that have waited longest first, and the rest just keep their last
    // answer until their turn. If a check ever fails, that hotspot just shows as it always did.
    const COVER_CHECKS = 24;
    let coverTick = 0; // counts the frames that checked labels
    let coverAsked = false; // something asked for a fresh look (a scroll, a new reply, a click, the one-second timer)
    let coverRound = 0; // the frame that took the last ask: every label on screen is checked from there on
    let coverWarned = false;

    // Checks the labels on screen that waited longest. True while some still wait for this round's check.
    function checkCovers() {
      coverTick++;
      if (coverAsked) coverRound = coverTick;
      coverAsked = false;
      const shown = peekSpots.filter((spot) => spot.onScreen);
      if (shown.length > COVER_CHECKS) shown.sort((first, second) => first.checked - second.checked);
      for (const spot of shown.slice(0, COVER_CHECKS)) {
        spot.covered = labelCovered(spot);
        spot.checked = coverTick;
      }
      return shown.some((spot) => spot.checked < coverRound);
    }

    // True when something else on the page sits on top of either end of the label, checked halfway up its
    // line, or when that end has scrolled outside the window. Asking from the label's own root means a
    // label inside a shadow root still gets checked correctly against whatever the page draws over it; the
    // label's own element, anything inside it, and its surrounding text all count as not covering it.
    function labelCovered(spot) {
      try {
        const own = spot.node.parentElement;
        const scope = spot.node.getRootNode();
        const hitter = typeof scope.elementsFromPoint === "function" ? scope : document;
        const lines = [...spot.range.getClientRects()].filter((rect) => rect.width && rect.height);
        if (!own || !lines.length) return false;
        const first = lines[0];
        const last = lines[lines.length - 1];
        const ends = [
          [first.left + Math.min(2, first.width / 4), first],
          [last.right - Math.min(2, last.width / 4), last],
        ];
        for (const [x, line] of ends) {
          const y = line.top + line.height / 2;
          if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return true;
          const top = hitter.elementsFromPoint(x, y).find((element) => !ownHosts.has(element));
          const fine = top && (top === own || own.contains(top) || (top.contains(own) && spot.root.contains(top)));
          if (!fine) return true;
        }
        return false;
      } catch (error) {
        if (!coverWarned) console.warn(LOG, "Bandage couldn't check what covers a label", error);
        coverWarned = true;
        return false;
      }
    }

    // Watches for two cheap signs that a pop-up just opened or closed, a new child added to <body> or the
    // end of a click, key press or animation, so the underlines move right away instead of waiting for the
    // next one-second check. This only runs while there are hotspots, and each sign just asks for the next
    // frame's placement.
    let coverWatch = null;
    let coverBody = null;
    const COVER_EVENTS = ["pointerup", "keyup", "transitionend", "animationend"];
    const coverSign = () => peekSpots.length && placeSpots();
    function watchCovers(on) {
      const opts = { capture: true, passive: true };
      if (!on) {
        if (!coverWatch) return;
        coverWatch.disconnect();
        coverWatch = null;
        coverBody = null;
        for (const type of COVER_EVENTS) removeEventListener(type, coverSign, opts);
        return;
      }
      if (!coverWatch) {
        coverWatch = new MutationObserver(coverSign);
        for (const type of COVER_EVENTS) addEventListener(type, coverSign, opts);
      }
      if (document.body && coverBody !== document.body) {
        coverWatch.disconnect(); // a page that swapped its <body> is watched on the new one
        coverBody = document.body;
        coverWatch.observe(coverBody, { childList: true });
      }
    }

    let peekHost = null;
    let peekBox = null;
    let peekTarget = null;
    let peekCloseTimer = null;

    function closePeek() {
      clearTimeout(peekCloseTimer);
      removeOwn(peekHost);
      peekHost = null;
      peekBox = null;
      peekTarget = null;
    }
    // Clears every hotspot and closes any open bubble, so an updated copy of Clotr taking over the page
    // doesn't leave them stranded with nothing left to move or close them. Also runs when the chat changes.
    function retireSpots() {
      closePeek();
      clearInterval(spotTimer);
      spotTimer = 0;
      cancelAnimationFrame(spotFrame);
      removeOwn(spotHost);
      spotHost = null;
      peekSpots.length = 0;
      watchCovers(false);
    }
    // Waits a short moment before closing, since moving the pointer from the label to the bubble's button
    // has to cross the gap between them.
    function schedulePeekClose() {
      clearTimeout(peekCloseTimer);
      peekCloseTimer = setTimeout(app.safely(closePeek), 300);
    }
    function cancelPeekClose() {
      clearTimeout(peekCloseTimer);
    }

    // rect is where the label is. Passing it in avoids a second layout pass in the same frame right after
    // the hotspots were just placed.
    function positionPeek(rect = peekTarget?.range.getBoundingClientRect()) {
      if (!peekBox || !peekTarget) return;
      Object.assign(peekBox.style, {
        left: `${Math.max(4, Math.min(rect.left, innerWidth - 336))}px`,
        top: `${rect.bottom + 6}px`,
      });
    }

    // What the bubble holds: the real detail and a copy button, or, for an older label, why there's none.
    function peekInside(spot, value) {
      if (spot.older) return [el("p", { className: "note", textContent: notKept(spot.label) })];
      const copied = el("p", { className: "copied", hidden: true, textContent: msg("bandageCopied", "Copied.") });
      const copy = el("button", { type: "button", textContent: msg("bandageCopyReal", "Copy with real names") });
      copy.addEventListener("click", async () => {
        if (!sameChat(spot)) {
          retireSpots(); // the chat changed while the bubble was open
          return;
        }
        try {
          await navigator.clipboard.writeText(app.realText(spot.root, spot.chat));
          copied.hidden = false;
        } catch (error) {
          console.warn(LOG, "Bandage couldn't copy the answer", error);
        }
      });
      return [el("div", { className: "value", textContent: value }), copy, copied];
    }

    function showPeek(spot) {
      cancelPeekClose();
      if (peekTarget === spot && peekHost?.isConnected) return;
      // This hotspot is left over from a chat the user switched away from, so it and the rest get cleared
      // and nothing shows.
      if (!sameChat(spot)) {
        retireSpots();
        return;
      }
      const value = spot.older ? null : app.realValue(spot.label, spot.chat);
      if ((!value && !spot.older) || !spot.node.isConnected) return;
      closePeek();
      peekTarget = spot;
      peekHost = ownHost("clotr-peek");
      const root = peekHost.attachShadow({ mode: "closed" });
      peekBox = el("div", { className: "box" }, peekInside(spot, value));
      peekBox.addEventListener("pointerenter", cancelPeekClose);
      peekBox.addEventListener("pointerleave", schedulePeekClose);
      peekBox.addEventListener("focusin", cancelPeekClose);
      peekBox.addEventListener("focusout", schedulePeekClose);
      root.append(el("style", { textContent: globalThis.Clotr.styles.peek }), peekBox);
      document.documentElement.append(peekHost);
      positionPeek();
    }

    // Steps everything this copy shows aside, for when an updated copy of Clotr takes over the page.
    function retire() {
      clearTimeout(offerTimer);
      closeDialog();
      closeNotice();
      closeReloadPrompt();
      retireSpots();
    }

    return {
      outline,
      showDialog,
      closeDialog,
      isDialogOpen,
      dialogKind: () => dialogKind,
      shakeDialog,
      showFileHold,
      showFileWait,
      showChecking,
      closeChecking,
      tellFileUnchecked,
      showNotice,
      closeNotice,
      isNoticeOpen,
      noticeKind: () => noticeKind,
      noticeOpenedAt: () => noticeOpenedAt,
      focusNotice,
      showReloadPrompt,
      reloadAsked: () => reloadAsked,
      tellCovered,
      tellCoverFailed,
      tellPlaceRemovedFirst,
      tellPlaceBack,
      tellPlaceNotBack,
      tellNotTaken,
      tellStripFallback,
      tellStripFailed,
      offerVault,
      offerRelax,
      tellJustSent,
      tellCantReadPictures,
      tellTruncated,
      tellCommandCopied,
      hasSpots,
      hasSpot,
      addSpot,
      placeSpots,
      clearSpots: retireSpots,
      retire,
    };
  }

  globalThis.Clotr.ui = { create, mask };
})();
