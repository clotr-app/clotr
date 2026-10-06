// Everything Clotr shows inside an AI page: the dialog, the corner warning, the reload prompt, the "Test
// Clotr here" outline, and Bandage's hotspots. It builds all of it in closed shadow roots and masks every
// value it shows. Deciding what a choice actually does is content.js's job; this file just calls back into it.
(() => {
  "use strict";
  const LOG = "[Clotr]";

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
  function guardKeys(container, { enter = null } = {}) {
    const shownAt = Date.now();
    let tabbed = false;
    let deliberate = false; // reached with Clotr's keyboard shortcut
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Tab") {
          tabbed = true;
          return;
        }
        if ((e.key === " " || e.key === "Spacebar") && !deliberate) return stop(e);
        if (e.key !== "Enter") return;
        if (e.repeat || (!deliberate && Date.now() - shownAt < KEY_GRACE_MS)) return stop(e);
        const focused = container.getRootNode().activeElement;
        const control = focused instanceof HTMLButtonElement || focused?.tagName === "SUMMARY";
        if (control && focused !== enter && (tabbed || deliberate)) return; // presses (or opens) what the user moved to
        stop(e);
        if (enter) enter.click();
      },
      true,
    );
    container.addEventListener(
      "keyup",
      (e) => {
        if ((e.key === " " || e.key === "Spacebar") && !deliberate) stop(e);
      },
      true,
    );
    return () => {
      deliberate = true;
    }; // reaching a button with the keyboard shortcut is a deliberate choice
  }

  // ---------- Bulk pastes: summarize instead of listing every value ----------

  const BULK_ITEMS = 6; // more values than this → counts per type, no values
  const BULK_LINES = 20; // this many lines → mention the size

  const totalMatches = (results) => results.reduce((n, r) => n + r.matches.length, 0);
  const kindsOf = (results) => [...new Set(results.map((r) => r.name))].join(", ");

  // ---------- "Why am I seeing this?" and first-time tips ----------

  const YOURS = new Set(["phone_number", "email", "street_address"]); // kinds of data that can be "mine"
  const REPORT_URL = "https://github.com/clotr-app/clotr/issues/new";
  const aName = (name) => `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`; // "an Email Address"
  // Tourniquet's small shield, drawn beside its line in a warning.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SHIELD_PATH = "M8 1 14 3.4V8c0 3.4-2.5 6.1-6 7-3.5-.9-6-3.6-6-7V3.4Z";
  // The kinds a fake bank or tech-support call actually asks for, so the warning can say that plainly.
  const SCAM_TARGETS = new Set(["password", "credit_card", "card_code", "gift_card", "us_ssn", "bank_account"]);

  // Each copy of Clotr on the page gets one warning UI. app is content.js's side of things: it tells the UI
  // what it needs to know, like the chat box and the current settings, and what each choice should do.
  // Nothing in this file records, stores or sends anything on its own.
  function create(app) {
    const { msg, generalForms } = globalThis.Clotr;
    const { getText } = globalThis.Clotr.editor;
    const IS_TOP = window === window.top;
    // Turning on "Larger warnings" in Settings makes the text and buttons in Clotr's boxes bigger.
    const sized = (cls) => (app.largeText() ? `${cls} large` : cls);
    // A team's own kinds, named by the organization and set by its policy. The warning says so, the person
    // isn't offered to loosen them, and a public report never carries their names (one could name a client).
    const isTeam = (r) => Boolean(app.isTeamKind?.(r.id));
    function teamLine(results, className = "hint") {
      const names = [...new Set(results.filter(isTeam).map((r) => r.name))];
      if (!names.length) return [];
      const text =
        names.length === 1
          ? msg("teamKindLine", "$1 is a kind your organization added.", names[0])
          : msg("teamKindsLine", "$1 are kinds your organization added.", names.join(", "));
      return [el("p", { className, textContent: text })];
    }
    const publicName = (r) => (isTeam(r) ? msg("teamKindAnon", "A kind your organization added") : r.name);

    // ---------- Clotr's own boxes ----------
    // The dialog, the corner warning and the reload prompt all sit directly under <html>. If one of them
    // disappears without Clotr being the one that removed it, something on the page took it down, maybe a
    // hostile script, maybe just a framework rebuilding the page. Either way content.js hears about it and
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
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.removedNodes) {
          if (!CLOTR_HOSTS.has(node.nodeName)) continue;
          const mine = ownRemovals.get(node) || 0;
          if (mine) {
            ownRemovals.set(node, mine - 1);
            continue;
          }
          app.removedByPage(node);
        }
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
      for (const n of fitted) {
        if (n !== node && !n.isConnected) {
          fitted.delete(n);
          continue;
        }
        n.style.setProperty("--vv-top", `${view.offsetTop}px`);
        n.style.setProperty("--vv-height", `${view.height}px`);
      }
    }
    for (const type of ["resize", "scroll"])
      window.visualViewport?.addEventListener(type, () => fitted.size && fitToVisible(), { passive: true });

    // Draws a brief outline around the chat box Clotr is watching, for the popup's "Test Clotr here" button.
    // It never takes clicks, and it removes itself.
    function outline(box) {
      box.scrollIntoView({ block: "center", behavior: "instant" });
      const r = box.getBoundingClientRect();
      const host = ownHost("clotr-flash");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = globalThis.Clotr.styles.flash;
      const ring = document.createElement("div");
      ring.className = "ring";
      Object.assign(ring.style, {
        left: `${r.left - 6}px`,
        top: `${r.top - 6}px`,
        width: `${r.width + 12}px`,
        height: `${r.height + 12}px`,
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

    // "Large paste: 400 lines, with Email Address ×37, Phone Number ×12." or null.
    function bulkSummary(results, file = null) {
      const editor = app.editor();
      const lines = file ? file.lines : editor ? getText(editor).split("\n").length : 0;
      if (!file && totalMatches(results) <= BULK_ITEMS && lines < BULK_LINES) return null;
      const counts = results.map((r) => `${r.name} ×${r.matches.length}`).join(", ");
      if (file?.count > 1)
        return msg("bulkFiles", "$1 files you attached ($2) contain $3.", file.count, file.name, counts);
      if (file)
        return msg(
          "bulkFile",
          "The file “$1” you attached ($2) contains $3.",
          file.name,
          lines === 1 ? msg("linesOne", "1 line") : msg("linesMany", "$1 lines", lines),
          counts,
        );
      return lines >= BULK_LINES
        ? msg("bulkPaste", "Large paste: $1 lines, with $2.", lines, counts)
        : msg("bulkMessage", "This message has $1.", counts);
    }

    // A picture has no lines of text to count, so this just says plainly what kind of thing was found in it,
    // never the value itself, not even masked. It's also honest that Clotr can't actually read the words in
    // a picture, so the person has to look it over themselves. file.picture is "photo", or "scan" for a PDF
    // with no text, whenever one of the attached files turned out to be an image; null otherwise.
    function pictureLines(results, file) {
      if (!file?.picture) return null;
      const everyday = app.everyday();
      if (file.count > 1)
        return {
          lead: null,
          hint: null,
          honest: msg("picHonest", "Clotr can't read the words in a picture, so look it over yourself."),
        };
      const scan = file.picture === "scan";
      const honest = scan
        ? msg("picScanHonest", "Clotr can't read the words in a scan, so look it over yourself.")
        : msg("picHonest", "Clotr can't read the words in a picture, so look it over yourself.");
      const ids = new Set(results.map((r) => r.id));
      const place = ids.has("photo_location");
      const named = ids.has("id_picture");
      const only = ids.size === Number(place) + Number(named); // nothing else was found in it
      const sent = scan
        ? everyday
          ? msg("noticeSharedBulkHere", " If you send it, the people who read it here get it.")
          : msg("noticeSharedBulk", " If you send it, this AI gets it.")
        : everyday
          ? msg("picSentHere", " If you send it, the people who read it here get it.")
          : msg("picSent", " If you send it, this AI gets it.");
      if (only && named)
        return {
          lead: [
            scan
              ? msg(
                  "picFoundScan",
                  "The file “$1” looks like a scan of an ID or document, going by its name.",
                  file.name,
                )
              : place
                ? msg(
                    "picFoundBoth",
                    "The picture “$1” looks like a photo of an ID or document, going by its name, and has the place it was taken saved inside it.",
                    file.name,
                  )
                : msg(
                    "picFoundId",
                    "The picture “$1” looks like a photo of an ID or document, going by its name.",
                    file.name,
                  ),
            sent,
          ],
          hint: scan
            ? msg("noticeFileHint", "To keep it private, take the file off before you send.")
            : msg("picHint", "To keep it private, take the picture off before you send."),
          honest,
        };
      if (only && place)
        return {
          lead: [
            msg("picFoundPlace", "The photo “$1” has the place it was taken saved inside it.", file.name),
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
      return {
        lead: [msg("picFoundOther", "The picture “$1” has $2 in it.", file.name, kindsOf(results)), sent],
        hint: msg("picHint", "To keep it private, take the picture off before you send."),
        honest,
      };
    }

    // ---------- The choices, in plain words ----------
    // Every warning offers a choice for right now, hide it or leave it in, plus an optional lasting one:
    // remember this one item, or stop warning about this whole kind of data.

    // Builds the "More choices" section. Each button pairs today's answer with a lasting one. cover is null
    // for a file, since a file can't be remembered the way a typed value can. general swaps a detail for a
    // vaguer version, like a full address becoming just a city, and hides the rest. If a team policy holds
    // one of the listed kinds, or a PIN locks the settings, only the choices that add protection are offered,
    // and this returns null once none are left.
    function moreChoices(results, { leave, cover, general = null }) {
      const loosen = !results.some((r) => app.isFirm(r.id));
      const perItem =
        !app.orphaned() &&
        app.canRemember() &&
        totalMatches(results) <= BULK_ITEMS &&
        !results.some((r) => app.isVaultType(r.id));
      const one = totalMatches(results) === 1;
      const own = results.filter((r) => !isTeam(r)); // a team's kinds stay as its policy set them
      const choice = (text, fn) => {
        const b = el("button", { className: "choice", textContent: text });
        b.addEventListener("click", () => fn());
        return b;
      };
      const forms = general ? generalForms(results, navigator.language) : [];
      const shown = [...new Set(forms.map((f) => f.general))].slice(0, 3).join('", "');
      const buttons = [
        ...(forms.length
          ? [
              choice(
                forms.length === totalMatches(results)
                  ? forms.length === 1
                    ? msg("choiceGeneralOne", 'Say "$1" instead', shown)
                    : msg("choiceGeneralMany", 'Keep it general: "$1"', shown)
                  : msg("choiceGeneralMixed", 'Say "$1" instead, and hide the rest', shown),
                general,
              ),
            ]
          : []),
        ...(perItem && loosen
          ? [
              choice(
                one
                  ? msg("choiceAllowOne", "Leave it in, and don't warn me about this one again")
                  : msg("choiceAllowMany", "Leave it in, and don't warn me about these again"),
                () => {
                  app.addToVault(results, "allow");
                  leave();
                },
              ),
            ]
          : []),
        ...(loosen && own.length
          ? [
              choice(msg("choiceLogKinds", "Leave it in, and stop warning me about: $1", kindsOf(own)), () => {
                app.setToLog(own.map((r) => r.id));
                leave();
              }),
            ]
          : []),
        ...(perItem && cover
          ? [
              choice(
                one
                  ? msg("choiceProtectOne", "Hide it, and always watch for this one, however it's written")
                  : msg("choiceProtectMany", "Hide them, and always watch for these, however they're written"),
                () => {
                  app.addToVault(results, "protect");
                  cover();
                },
              ),
            ]
          : []),
      ];
      if (!buttons.length) return null;
      return el("details", { className: "more" }, [
        el("summary", { textContent: msg("moreChoices", "More choices") }),
        el("div", { className: "choices" }, buttons),
      ]);
    }

    // One short line in the warning that says why this matters for the person Tourniquet is protecting. It's
    // the codes line whenever a password, key or sign-in code is listed, and otherwise whichever preset's own
    // line applies, such as the scam-recovery warning for someone who was already scammed once. The text is
    // always fixed, never a value, and an old copy of Clotr running after an update just skips this line.
    function tourniquetLine(results) {
      const word = app.tourniquet();
      if (!word || app.orphaned()) return null;
      const codes = results.some((r) => r.group === "credentials" && r.severity === "high");
      const text = codes
        ? msg(
            "tqLineCodes",
            "Passwords and sign-in codes are only for you. With one, someone else can get into your account.",
          )
        : word === "child"
          ? msg(
              "tqLineChild",
              "Only share this with people you know in real life. If someone online asks for it, tell an adult you trust.",
            )
          : word === "after_scam"
            ? msg(
                "tqLineAfterScam",
                "Scammers often come back, saying they can get your money back. Anyone who asks for a fee or your details to do that is a scammer too.",
              )
            : msg(
                "tqLineAdult",
                "If someone says they're from a bank, an insurer or the government and asks for this, stop. Call them on a number you already know.",
              );
      return el("p", { className: "tq" }, [shieldIcon(), el("span", { textContent: text })]);
    }

    // ---------- Who really asks for this ----------
    // A card's security code, a gift card's numbers and the codes a scammer reads out loud each get one extra
    // line under the lead, a question and its answer about who actually asks for that kind of thing. decide.js's
    // whoAsks holds the wording and the sources behind it. The tone stays calm rather than saying "you're being
    // scammed," and it's wrapped in its own try so that if anything here goes wrong, the warning just shows
    // without this line instead of getting stuck.
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
      for (const [k, v] of Object.entries({ class: "disc", cx: 8, cy: 8, r: 8 })) disc.setAttribute(k, v);
      const mark = document.createElementNS(SVG_NS, "path");
      mark.setAttribute("class", "mark");
      mark.setAttribute("d", "M5.8 6.2a2.2 2.2 0 1 1 3.1 2c-.6.3-.9.7-.9 1.3v.4");
      const dot = document.createElementNS(SVG_NS, "circle");
      for (const [k, v] of Object.entries({ class: "dot", cx: 8, cy: 12.2, r: 1 })) dot.setAttribute(k, v);
      icon.append(disc, mark, dot);
      return icon;
    }
    // A question (bold, on its own line) and its answer, in Tourniquet's warm box.
    const askBox = (icon, question, answer, extra = "") =>
      el("p", { className: `tq ask${extra}` }, [
        icon,
        el("span", {}, [el("b", { textContent: question }), ` ${answer}`]),
      ]);

    // Picks the single line that goes under the lead. Normally it's who really asks for the first kind or
    // code listed, shown with Tourniquet's shield instead of a question mark when Tourniquet is on, which
    // also takes the place of Tourniquet's own codes line. If there's no such question, it falls back to
    // Tourniquet's line, or shows nothing at all.
    function warningLine(results, asks = whoAsksIn(results)) {
      const ask = asks[0];
      if (!ask) return tourniquetLine(results);
      const tq = Boolean(app.tourniquet()) && !app.orphaned();
      return askBox(tq ? shieldIcon() : askIcon(), ask.q, ask.a);
    }

    // The "Ask before sending" dialog, where one decision covers everything listed. resend means this dialog
    // actually stopped a send, so leaving it in now sends the message. back returns to the message unchanged.
    function showDialog(results, { resend, leave, cover, general, back }) {
      if (!host) {
        host = ownHost("clotr-guard");
        shadow = host.attachShadow({ mode: "closed" });
      }

      const shown = shownOf(results);
      const items = shown.map((r) =>
        el("li", {}, [
          el("span", { className: `sev ${r.severity}`, textContent: msg(`sev_${r.severity}`, r.severity) }),
          `${r.name}: `,
          el("code", { textContent: describeValues(r) }),
        ]),
      );
      const bulk = bulkSummary(shown);
      const line = warningLine(results);
      const more = moreChoices(results, { leave, cover, general });

      const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
      const allowBtn = el("button", {
        textContent: resend ? msg("leaveItSend", "Leave it in and send") : msg("leaveIt", "Leave it in"),
      });
      const backBtn = el("button", {
        className: "link",
        textContent: msg("backToMessage", "Go back to my message (Esc)"),
      });

      const box = el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", { id: "title", textContent: msg("dialogTitle", "⚠️ This looks private") }),
        el("p", {
          textContent: app.everyday()
            ? msg("dialogLeadHere", "If you send this, the people who read it here will see:")
            : msg("dialogLead", "If you send this, the AI service will see:"),
        }),
        ...(bulk ? [el("p", { className: "bulk", textContent: bulk })] : []),
        el("ul", {}, items),
        ...(line ? [line] : []),
        ...teamLine(results, "note"),
        el("div", {
          className: "note",
          textContent: msg(
            "dialogNote",
            "Clotr checked this on your computer, and nothing's been sent yet. Hide it swaps it for a label like $1.",
            `[REDACTED ${results[0].name.toUpperCase()}]`,
          ),
        }),
        el("div", { className: "actions" }, [allowBtn, redactBtn]),
        ...(more ? [more] : []),
        el("div", { className: "keys" }, [el("span", { textContent: msg("enterCovers", "Enter: Hide it") }), backBtn]),
      ]);
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "title"); // its own shadow root, so the id can't meet the page's

      backBtn.addEventListener("click", () => back());
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" && e.key !== "Backspace") return;
        if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        e.stopPropagation();
        back();
      });
      redactBtn.addEventListener("click", () => cover());
      allowBtn.addEventListener("click", () => leave());

      const overlay = el("div", { className: "overlay" }, [box]);
      // Clicking outside doesn't dismiss: the user has to choose.
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) shakeDialog();
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
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" && e.key !== "Backspace") return;
        e.preventDefault();
        e.stopPropagation();
        back();
      });
      const overlay = el("div", { className: "overlay" }, [box]);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) shakeDialog();
      });
      guardKeys(box, { enter });
      shadow.replaceChildren(el("style", { textContent: DIALOG_CSS }), overlay);
      if (!host.isConnected) document.documentElement.append(host);
      dialogKind = kind;
      box.focus();
    }

    // Under an organization's policy, this adds one plain line in the same colors as Clotr's other offers.
    // It only ever says "your organization," so the AI site has no way to learn the employer's name from Clotr.
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

    // The dialog about files Clotr is holding back. The first time, it shows what's inside them (masked),
    // warns that the site may already have a copy, and makes "Go back to remove it" the main button, so
    // both Enter and Esc go back. A later send asks "Is the file off?" instead, where both buttons send and
    // only differ in what gets counted. file holds the name, names, count and whether this is that second ask.
    function showFileHold(results, file, { send, off, back }) {
      const many = file.count > 1;
      const here = app.everyday();
      const sendBtn = el("button", {
        textContent: many ? msg("fileSendWithMany", "Send with the files") : msg("fileSendWith", "Send with the file"),
      });
      sendBtn.addEventListener("click", () => send());
      let box;
      let enter;
      if (!file.second) {
        enter = el("button", {
          className: "primary",
          textContent: many
            ? msg("fileGoBackMany", "Go back to remove them")
            : msg("fileGoBack", "Go back to remove it"),
        });
        enter.addEventListener("click", () => back());
        const items = shownOf(results).map((r) =>
          el("li", {}, [
            el("span", { className: `sev ${r.severity}`, textContent: msg(`sev_${r.severity}`, r.severity) }),
            `${r.name}: `,
            el("code", { textContent: describeValues(r) }),
          ]),
        );
        const line = warningLine(results);
        box = el("div", { className: sized("box"), tabIndex: -1 }, [
          el("h2", {
            id: "title",
            textContent: many
              ? msg("fileHoldTitleMany", "⚠️ These files look private")
              : msg("fileHoldTitle", "⚠️ This file looks private"),
          }),
          el("p", {
            textContent: many
              ? here
                ? msg(
                    "fileHoldLeadManyHere",
                    "If you send your message, the people who read it here get the files you attached, and they contain:",
                  )
                : msg(
                    "fileHoldLeadMany",
                    "If you send your message, this AI service gets the files you attached, and they contain:",
                  )
              : here
                ? msg(
                    "fileHoldLeadHere",
                    "If you send it, the people who read it here get the file you attached, and it contains:",
                  )
                : msg("fileHoldLead", "If you send it, this AI service gets the file you attached, and it contains:"),
          }),
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
          el("div", {
            className: "note",
            textContent: many
              ? here
                ? msg(
                    "fileHoldNoteManyHere",
                    "Most sites upload a file as soon as you attach it, so this site may already have copies. To keep them from the people who read it here, remove the files before you send.",
                  )
                : msg(
                    "fileHoldNoteMany",
                    "Most sites upload a file as soon as you attach it, so this AI service may already have copies. To keep them out of the chat, remove the files before you send.",
                  )
              : here
                ? msg(
                    "fileHoldNoteHere",
                    "Most sites upload a file as soon as you attach it, so this site may already have a copy. To keep it from the people who read it here, remove the file before you send.",
                  )
                : msg(
                    "fileHoldNote",
                    "Most sites upload a file as soon as you attach it, so this AI service may already have a copy. To keep it out of the chat, remove the file before you send.",
                  ),
          }),
          el("div", { className: "actions" }, [sendBtn, enter]),
          el("div", { className: "keys" }, [
            el("span", { textContent: msg("fileHoldKeys", "Enter or Esc: back to your message") }),
          ]),
        ]);
      } else {
        enter = el("button", {
          className: "primary",
          textContent: many ? msg("fileOffSendMany", "They're off, send") : msg("fileOffSend", "It's off, send"),
        });
        enter.addEventListener("click", () => off());
        const backBtn = el("button", {
          className: "link",
          textContent: msg("backToMessage", "Go back to my message (Esc)"),
        });
        backBtn.addEventListener("click", () => back());
        box = el("div", { className: sized("box"), tabIndex: -1 }, [
          el("h2", {
            id: "title",
            textContent: many
              ? msg("fileOffTitleMany", "⚠️ Are the files off?")
              : msg("fileOffTitle", "⚠️ Is the file off?"),
          }),
          el("p", {
            textContent: many
              ? here
                ? msg(
                    "fileOffLeadManyHere",
                    "If you removed $1, your message can go. If they're still attached, the people who read it here get them.",
                    file.name,
                  )
                : msg(
                    "fileOffLeadMany",
                    "If you removed $1, your message can go. If they're still attached, this AI service gets them.",
                    file.name,
                  )
              : here
                ? msg(
                    "fileOffLeadHere",
                    "If you removed $1, your message can go. If it's still attached, the people who read it here get it.",
                    file.name,
                  )
                : msg(
                    "fileOffLead",
                    "If you removed $1, your message can go. If it's still attached, this AI service gets it.",
                    file.name,
                  ),
          }),
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
      }
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
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" && e.key !== "Backspace") return;
        e.preventDefault();
        e.stopPropagation();
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

    let whyOpen = false;
    let tip = null; // the first-time tip in the current notice: { id, name, match, single, status }

    const scamLine = (results) =>
      results.some((r) => SCAM_TARGETS.has(r.id))
        ? msg("whyScam", "No real bank, company or help line will ever ask you for this. ")
        : "";

    function whyFound(results, file) {
      const names = [...new Set(results.map((r) => r.name))].join(", ");
      if (file?.count > 1)
        return msg("whyFoundFiles", "Clotr found what looks like: $1, in the files $2. ", names, file.name);
      return file
        ? msg("whyFoundFile", "Clotr found what looks like: $1, in the file “$2”. ", names, file.name)
        : msg("whyFound", "Clotr found what looks like: $1. ", names);
    }
    const whyBody = () =>
      msg(
        "whyBody",
        "Whatever you send an AI can stay on its servers, be read by the people who run it, or be used to train it. Nothing has left your computer yet, and it's your call: hide it, leave it in, or use More choices to decide how Clotr handles this from now on.",
      );

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
        ...asks.slice(1).map((a) => askBox(askIcon(), a.q, a.a)),
        ...(second ? [second] : []),
        el("p", { textContent: whyBody() }),
      ];
    }
    // Adds the "Got a message asking for this? Get a second opinion" link, which has the background worker
    // open the "Is this a scam?" page in a new tab; nothing from the page or the message goes with it. An old
    // copy of Clotr left running after an update can't reach the background, so it skips offering this.
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

    // The first time Clotr warns about a kind of data, it asks how to treat it from now on, and for a kind
    // like a phone number or address, whether this particular one is the user's own. It's shown once per
    // kind, and stays while the notice is open even though the notice itself gets rebuilt on every pause in typing.
    function firstTimeTip(results) {
      if (app.orphaned()) return null;
      if (!tip || !results.some((r) => r.id === tip.id)) {
        const fresh = results.find((r) => !app.isGuided(r.id) && !app.isVaultType(r.id));
        if (!fresh) {
          tip = null;
          return null;
        }
        tip = {
          id: fresh.id,
          name: fresh.name,
          match: fresh.matches[0],
          single: fresh.matches.length === 1,
          status: "",
        };
        app.markGuided(fresh.id);
      }
      const t = tip;
      const boxEl = el("div", { className: "tip" });
      if (app.tourniquet() && app.isFirm(t.id)) {
        // Tourniquet holds this kind, so the tip just explains what that means, with no choices offered,
        // since every choice here would loosen it.
        boxEl.append(
          el("p", {
            textContent:
              app.responseOf(t.id) === "block"
                ? msg(
                    "tqTipAsks",
                    "Tourniquet is on, so Clotr asks before $1 goes out. You can always leave it in.",
                    aName(t.name),
                    t.name,
                  )
                : msg(
                    "tqTipNotes",
                    "Tourniquet is on, so Clotr warns about $1 every time. You can always leave it in.",
                    aName(t.name),
                    t.name,
                  ),
          }),
        );
        return boxEl;
      }
      const done = (text) => {
        t.status = text;
        boxEl.replaceChildren(el("p", { textContent: text }));
      };
      if (t.status) {
        done(t.status);
        return boxEl;
      }
      const current = app.responseOf(t.id);
      // If a PIN locks the settings, or an organization's policy holds this kind, only the choices that keep
      // or add protection are offered, so there's no way to use this tip to get around the PIN.
      const held = app.isFirm(t.id);
      const keeps = (value) => !held || globalThis.Clotr.stricter(value, current) === value;
      const choice = (value, label, after) => {
        const b = el("button", { className: value === current ? "chosen" : "", textContent: label });
        b.setAttribute("aria-pressed", String(value === current));
        b.addEventListener("click", () => {
          app.setResponse([t.id], value);
          done(after);
        });
        return b;
      };
      const parts = [
        el("p", {}, [
          el("b", { textContent: msg("tipNew", "New: ") }),
          msg("tipHow", "How should Clotr handle $1 from now on?", aName(t.name), t.name),
        ]),
        el("div", { className: "choices" }, [
          ...(keeps("warn")
            ? [
                choice(
                  "warn",
                  msg("tipWarn", "Warn me"),
                  msg("tipWarnDone", "Got it. Clotr will keep warning you about $1.", aName(t.name), t.name),
                ),
              ]
            : []),
          ...(keeps("log")
            ? [
                choice(
                  "log",
                  msg("tipLog", "Just count it"),
                  msg(
                    "tipLogDone",
                    "Got it. Clotr will just count $1 quietly. You can change that in Settings whenever you like.",
                    aName(t.name),
                    t.name,
                  ),
                ),
              ]
            : []),
          choice(
            "block",
            msg("tipBlock", "Ask before sending"),
            msg(
              "tipBlockDone",
              "Got it. Clotr will ask you before $1 gets sent. You can change that in Settings whenever you like.",
              aName(t.name),
              t.name,
            ),
          ),
        ]),
      ];
      if (YOURS.has(t.id) && t.single && app.canRemember()) {
        const vault = (mode, after) => () => {
          app.addToVault([{ id: t.id, matches: [t.match] }], mode);
          done(after);
        };
        const mine = el("button", { textContent: msg("tipMine", "Always watch it") });
        mine.addEventListener(
          "click",
          vault(
            "protect",
            msg(
              "tipMineDone",
              "Saved to your vault. Clotr will always watch for this $1, however it's written.",
              t.name,
            ),
          ),
        );
        const share = el("button", { textContent: msg("tipShare", "It's fine to share") });
        share.addEventListener(
          "click",
          vault("allow", msg("tipShareDone", "Saved. This $1 is fine to share, so Clotr will only count it.", t.name)),
        );
        parts.push(
          el("p", { textContent: msg("tipYours", "Is this $1 yours?", t.name) }),
          el("div", { className: "choices" }, held ? [mine] : [mine, share]),
        );
      }
      boxEl.replaceChildren(...parts);
      return boxEl;
    }

    // Offers Bandage in the warning the first time a personal detail shows up on a site.
    function bandageOffer() {
      const yes = el("button", { className: "primary", textContent: msg("bandageYes", "Yes, use cover names") });
      const no = el("button", { textContent: msg("bandageNo", "No thanks") });
      yes.addEventListener("click", () => app.answerBandage(true));
      no.addEventListener("click", () => app.answerBandage(false));
      return el("div", { className: "tip" }, [
        el("p", {
          textContent: msg(
            "bandageOffer",
            "🩹 Want Clotr to swap details like this for a cover name, like [Phone 1], on this site from now on? The AI still follows what you mean. It just never sees the real thing.",
          ),
        }),
        el("div", { className: "actions" }, [no, yes]),
      ]);
    }

    // Builds the corner warning. file holds a name and line count when the warning is about an attached
    // file, since a file can't be redacted, only removed by the user. leave keeps what was found, and
    // cover hides it, or keeps it general if called with true.
    function showNotice(results, file, { leave, cover }) {
      if (!noticeHost) {
        noticeHost = ownHost("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      // Named as people know them ("Sign-in Code"), and who really asks for them.
      const shown = shownOf(results);
      const asks = whoAsksIn(results);
      const bulk = bulkSummary(shown, file);
      const pic = pictureLines(results, file);
      // decide.js builds the sentence every site uses, with one <code> element per item, so a single item
      // never breaks across lines and the whole sentence wraps between items instead of overflowing the notice.
      const words = bulk ? null : noticeWords(shown, { everyday: app.everyday() });
      const what = bulk
        ? []
        : words.items.flatMap((item, i) => [...(i ? [", "] : []), el("code", { textContent: item })]);
      const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
      const keepBtn = el("button", { textContent: file ? msg("ok", "OK") : msg("leaveIt", "Leave it in") });
      const whyBtn = el("button", { className: "link", textContent: msg("why", "Why am I seeing this?") });
      whyBtn.setAttribute("aria-expanded", String(whyOpen));
      // "Wrong?" opens a prefilled GitHub issue naming only the kind of data, never the value or the site.
      // It's a page the user has to choose to open themselves; Clotr itself never sends anything.
      const reportBtn = el("button", {
        className: "link",
        textContent: msg("reportFalseAlarm", "Wrong? Report a false alarm"),
      });
      reportBtn.addEventListener("click", () => {
        const kinds = [...new Set(results.map(publicName))].join(", ");
        const url = `${REPORT_URL}?template=false-alarm.yml&title=${encodeURIComponent(`False alarm: ${kinds}`)}&kind=${encodeURIComponent(kinds)}`;
        window.open(url, "_blank", "noopener");
      });
      const why = el("div", { className: "why", hidden: !whyOpen }, [
        ...whyParts(results, shown, file, asks),
        reportBtn,
      ]);
      whyBtn.addEventListener("click", () => {
        whyOpen = !whyOpen;
        why.hidden = !whyOpen;
        whyBtn.setAttribute("aria-expanded", String(whyOpen));
      });
      const offerBandage =
        app.bandageUnasked() &&
        !file &&
        !bulk &&
        !app.orphaned() &&
        results.some((r) => r.group !== "credentials" && r.bandage !== false);
      const tipBox = offerBandage ? bandageOffer() : !file && !bulk ? firstTimeTip(results) : null;
      const everyday = app.everyday();
      const line = warningLine(results, asks);
      const more = moreChoices(results, {
        leave: () => leave(),
        cover: file ? null : () => cover(),
        general: file ? null : () => cover(true),
      });
      const box = el("div", { className: sized("notice") }, [
        el("b", { textContent: msg("noticeTitle", "⚠️ Heads up") }),
        el(
          "p",
          {},
          pic?.lead
            ? pic.lead
            : bulk
              ? [
                  bulk,
                  everyday
                    ? msg("noticeSharedBulkHere", " If you send it, the people who read it here get it.")
                    : msg("noticeSharedBulk", " If you send it, this AI gets it."),
                ]
              : [words.lead, ...what, words.tail],
        ),
        ...teamLine(results),
        ...(file
          ? [
              el("p", {
                className: "hint",
                textContent:
                  pic?.hint ||
                  (file.count > 1
                    ? msg("noticeFilesHint", "To keep them private, take those files off before you send.")
                    : msg("noticeFileHint", "To keep it private, take the file off before you send.")),
              }),
              ...(pic ? [el("p", { className: "hint", textContent: pic.honest })] : []),
            ]
          : []),
        ...(app.orphaned()
          ? [
              el("p", {
                className: "hint",
                textContent: msg("noticeUpdated", "Clotr just updated. Reload this page so it can save your choices."),
              }),
            ]
          : []),
        ...(line ? [line] : []),
        el("div", { className: "actions" }, file ? [keepBtn] : [keepBtn, redactBtn]),
        ...(more ? [more] : []),
        whyBtn,
        why,
        ...(tipBox ? [tipBox] : []),
      ]);
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");

      // Calling cover() with no arguments, rather than passing the click event, since a truthy first
      // argument there means "keep it general".
      redactBtn.addEventListener("click", () => cover());
      keepBtn.addEventListener("click", () => leave());

      keyboardReach(box, file ? keepBtn : redactBtn);
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
      const later = () => {
        closeReloadPrompt();
        app.editor()?.focus();
      };
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
      laterBtn.addEventListener("click", later);
      // Enter goes forward (reload), Esc or Backspace goes back to the page.
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          later();
        }
      });
      box.addEventListener("keyup", (e) => e.stopPropagation());
      guardKeys(box, { enter: reloadBtn });
      const overlay = el("div", { className: "overlay" }, [box]);
      fitToVisible(overlay);
      root.replaceChildren(el("style", { textContent: DIALOG_CSS + RELOAD_CSS }), overlay);
      document.documentElement.append(reloadHost);
      box.focus();
    }

    function closeReloadPrompt() {
      removeOwn(reloadHost);
    }

    // ---------- Offers (local only): "add to your vault?", "warn less?", and short notes after a choice ----------

    let offerTimer = null;
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
      const done = (fn) => () => {
        clearTimeout(offerTimer);
        closeNotice();
        fn?.();
        app.editor()?.focus();
      };
      yesBtn.addEventListener("click", done(onYes));
      noBtn?.addEventListener("click", done(onNo));
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

    // Hide it didn't take: say so plainly, so nobody sends a key they think is gone.
    function tellCoverFailed(results) {
      const names = [...new Set(results.map((r) => r.name))].join(", ");
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
      const what = items.map((f) => `${f.name} (${mask(f.value)})`).join(", ");
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

    // A warned message went out before the warning could be read: say what went, and offer to ask first.
    function tellJustSent(results, onAskFirst) {
      const items = results.flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`));
      const everyday = app.everyday();
      showOffer({
        title: everyday ? msg("justSentTitleHere", "⚠️ Just sent") : msg("justSentTitle", "⚠️ Just sent to this AI"),
        text: everyday
          ? msg(
              "justSentTextHere",
              "Your message had $1 in it. If that was a mistake, delete or unsend it if you can. Next time, Clotr can ask you first.",
              items.join(", "),
            )
          : msg(
              "justSentText",
              "Your message had $1 in it. If that was a mistake, delete the message in the chat. Next time, Clotr can ask you first.",
              items.join(", "),
            ),
        yes: msg("askFirstNextTime", "Ask me first next time"),
        no: msg("ok", "OK"),
        onYes: onAskFirst,
      });
    }

    // An AI reply brought up your own details that you didn't type here.
    function tellReplyMentions(results) {
      const names = [...new Set(results.map((r) => r.name))].join(", ");
      showOffer({
        title: msg("replyTitle", "ℹ️ The AI's reply mentions your $1", names),
        text: msg(
          "replyText",
          "You didn't type it here, so this AI probably has it from an earlier chat or its memory. You can delete old chats and turn its memory off in the AI's settings.",
        ),
        yes: msg("ok", "OK"),
        no: null,
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

    // Builds the content for the command-check note, shown when a command copied on an AI chat matches the
    // "verify you're human, press Win+R and paste this" trick. It says plainly what the command would do and
    // who really asks for this, and offers "Clear what I copied" or "Keep it" without ever stopping or
    // changing the copy itself. shape is just "download" or "hidden"; the actual command is never stored or
    // logged, and this shows at most once per copied command.
    function commandCopiedNote(shape) {
      const title = msg("cmdTitle", "⚠️ Heads up: you copied a command");
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
      circle.setAttribute("cx", "8");
      circle.setAttribute("cy", "8");
      circle.setAttribute("r", "7");
      const mark = document.createElementNS(SVG_NS, "text");
      mark.setAttribute("x", "8");
      mark.setAttribute("y", "12");
      mark.setAttribute("text-anchor", "middle");
      mark.textContent = "?";
      icon.append(circle, mark);
      const qbox = el("div", { className: "qbox" }, [
        icon,
        el("div", {}, [el("b", { textContent: question }), el("p", { textContent: answer })]),
      ]);
      return { title, what, qbox };
    }

    // Shows the note. clear empties the clipboard; content.js passes it in, and it runs from this click so
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
      const close = () => {
        closeNotice();
        app.editor()?.focus();
      };
      keepBtn.addEventListener("click", close);
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
    // content.js finds each cover-name label on the page with a live Range, and this lays an invisible,
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
    const hasSpot = (node, start) => peekSpots.some((sp) => sp.node === node && sp.start === start);
    const notKept = (label) =>
      msg(
        "bandageNotKept",
        "Clotr didn't keep the real detail behind $1: real details are forgotten when the page reloads.",
        label,
      );

    // A label found at `start` in the text node `node`, inside the reply `root`, in the chat `chat`. False when there
    // are enough already.
    function addSpot(node, start, label, root, chat, older = false) {
      if (older && peekSpots.filter((sp) => sp.older).length >= MAX_OLDER_SPOTS) return false;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + label.length);
      peekSpots.push({ node, start, range, label, root, chat, older, btn: null, covered: false, checked: 0 });
      return true;
    }
    // True while sp still belongs to the page's current chat. Checking the current chat is also how a chat
    // switch gets noticed, which is what makes content.js go clear every hotspot.
    const sameChat = (sp) => app.currentChat() === sp.chat;

    function dropSpot(i) {
      const sp = peekSpots[i];
      if (peekTarget === sp) closePeek();
      sp.btn?.remove();
      peekSpots.splice(i, 1);
    }

    // Repositions each hotspot over its label, once per frame, after scrolls and resizes, after a new reply,
    // and once a second besides. A label that changed or left the page loses its hotspot, every hotspot
    // goes once the chat changes, and a hotspot also hides while something on the page covers its label,
    // which checkCovers below figures out.
    function placeSpots() {
      coverAsked = true;
      placeNextFrame();
    }
    function placeNextFrame() {
      cancelAnimationFrame(spotFrame);
      spotFrame = requestAnimationFrame(
        app.safely(() => {
          const chat = app.currentChat(); // first: a changed chat has cleared every hotspot by the time this returns
          for (let i = peekSpots.length - 1; i >= 0; i--) {
            const sp = peekSpots[i];
            if (!sp.node.isConnected || sp.range.toString() !== sp.label || sp.chat !== chat) dropSpot(i);
          }
          if (!peekSpots.length) {
            removeOwn(spotHost);
            spotHost = null;
            clearInterval(spotTimer);
            spotTimer = 0;
            watchCovers(false);
            return;
          }
          // A sidebar opening or an image loading moves the labels without a scroll or resize event.
          if (!spotTimer) spotTimer = setInterval(() => document.visibilityState === "visible" && placeSpots(), 1000);
          if (!spotHost?.isConnected) {
            spotHost = ownHost("clotr-spots");
            const root = spotHost.attachShadow({ mode: "closed" });
            spotLayer = el("div", { className: "layer" });
            root.append(el("style", { textContent: globalThis.Clotr.styles.spots }), spotLayer);
            document.documentElement.append(spotHost);
            for (const sp of peekSpots) sp.btn = null; // the old layer went away with its buttons
          }
          for (const sp of peekSpots) {
            if (!sp.btn) {
              sp.btn = el("button", { type: "button", className: sp.older ? "spot older" : "spot" });
              sp.btn.setAttribute(
                "aria-label",
                sp.older ? notKept(sp.label) : msg("bandagePeekLabel", "Show the real detail for $1", sp.label),
              );
              sp.btn.addEventListener("pointerenter", () => showPeek(sp));
              sp.btn.addEventListener("pointerleave", schedulePeekClose);
              sp.btn.addEventListener("focus", () => showPeek(sp));
              sp.btn.addEventListener("blur", schedulePeekClose);
              sp.btn.addEventListener("click", () => showPeek(sp));
              spotLayer.append(sp.btn);
            }
          }
          // Every label's place is read first and every hotspot moved after, so the page is laid out once per frame
          // however many labels there are.
          for (const sp of peekSpots) {
            const r = sp.range.getBoundingClientRect();
            sp.rect = r;
            sp.onScreen = Boolean(r.width && r.height && r.bottom > 0 && r.top < innerHeight);
          }
          watchCovers(true);
          const more = checkCovers();
          for (const sp of peekSpots) {
            const r = sp.rect;
            const hide = !sp.onScreen || sp.covered;
            if (sp.btn.hidden !== hide) sp.btn.hidden = hide;
            Object.assign(sp.btn.style, {
              left: `${r.left}px`,
              top: `${r.top}px`,
              width: `${r.width}px`,
              height: `${r.height}px`,
            });
          }
          // An open bubble would point at nothing you can see once its label is covered.
          if (peekTarget?.onScreen && peekTarget.covered) closePeek();
          if (peekTarget) positionPeek(peekTarget.rect);
          if (more) placeNextFrame(); // more labels on screen than one frame checks: the rest on the next frame
        }),
      );
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
      const shown = peekSpots.filter((sp) => sp.onScreen);
      if (shown.length > COVER_CHECKS) shown.sort((a, b) => a.checked - b.checked);
      for (const sp of shown.slice(0, COVER_CHECKS)) {
        sp.covered = labelCovered(sp);
        sp.checked = coverTick;
      }
      return shown.some((sp) => sp.checked < coverRound);
    }

    // True when something else on the page sits on top of either end of the label, checked halfway up its
    // line, or when that end has scrolled outside the window. Asking from the label's own root means a
    // label inside a shadow root still gets checked correctly against whatever the page draws over it; the
    // label's own element, anything inside it, and its surrounding text all count as not covering it.
    function labelCovered(sp) {
      try {
        const own = sp.node.parentElement;
        const scope = sp.node.getRootNode();
        const hitter = typeof scope.elementsFromPoint === "function" ? scope : document;
        const lines = [...sp.range.getClientRects()].filter((r) => r.width && r.height);
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
          const top = hitter.elementsFromPoint(x, y).find((e) => !ownHosts.has(e));
          const fine = top && (top === own || own.contains(top) || (top.contains(own) && sp.root.contains(top)));
          if (!fine) return true;
        }
        return false;
      } catch (err) {
        if (!coverWarned) console.warn(LOG, "Bandage couldn't check what covers a label", err);
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

    // r is where the label is. Passing it in avoids a second layout pass in the same frame right after
    // the hotspots were just placed.
    function positionPeek(r = peekTarget?.range.getBoundingClientRect()) {
      if (!peekBox || !peekTarget) return;
      Object.assign(peekBox.style, {
        left: `${Math.max(4, Math.min(r.left, innerWidth - 336))}px`,
        top: `${r.bottom + 6}px`,
      });
    }

    function showPeek(sp) {
      cancelPeekClose();
      if (peekTarget === sp && peekHost?.isConnected) return;
      // This hotspot is left over from a chat the user switched away from, so it and the rest get cleared
      // and nothing shows.
      if (!sameChat(sp)) return retireSpots();
      const value = sp.older ? null : app.realValue(sp.label, sp.chat);
      if ((!value && !sp.older) || !sp.node.isConnected) return;
      closePeek();
      peekTarget = sp;
      peekHost = ownHost("clotr-peek");
      const root = peekHost.attachShadow({ mode: "closed" });
      let inside;
      if (sp.older) inside = [el("p", { className: "note", textContent: notKept(sp.label) })];
      else {
        const copied = el("p", { className: "copied", hidden: true, textContent: msg("bandageCopied", "Copied.") });
        const copy = el("button", { type: "button", textContent: msg("bandageCopyReal", "Copy with real names") });
        copy.addEventListener("click", async () => {
          if (!sameChat(sp)) return retireSpots(); // the chat changed while the bubble was open
          try {
            await navigator.clipboard.writeText(app.realText(sp.root, sp.chat));
            copied.hidden = false;
          } catch (err) {
            console.warn(LOG, "Bandage couldn't copy the answer", err);
          }
        });
        inside = [el("div", { className: "value", textContent: value }), copy, copied];
      }
      peekBox = el("div", { className: "box" }, inside);
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
      offerVault,
      offerRelax,
      tellJustSent,
      tellReplyMentions,
      tellCantReadPictures,
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
