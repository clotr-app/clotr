// Clotr — the warning UI: everything Clotr shows inside an AI page. The "Ask before sending" dialog, the corner
// warning with its choices and first-time tips, the short offers after a choice, the reload prompt after an update,
// the "Test Clotr here" outline, and Bandage's hotspots with their hover-to-peek bubble. This file builds them in
// closed shadow roots, masks every value it shows, and handles their focus and keys. What a choice does (hide,
// keep, remember, send again) is content.js's job: it passes those in as callbacks when it creates the UI.
// Classic content script (loaded after editor.js, before content.js); shares Clotr.ui.
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

  // Never echo a full secret back into the page.
  function mask(value) {
    if (value.length <= 8) return "•".repeat(value.length);
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
  }

  // One line per type; with many values, a count and a couple of masked examples.
  function describeValues(r) {
    const shown = r.matches.slice(0, 3).map(mask).join(", ");
    return r.matches.length > 3 ? `×${r.matches.length}: ${shown}, …` : shown;
  }

  // Keys typed by habit never make a choice (D36): Space never
  // presses a button or ticks a box in Clotr's UI, and Enter does nothing in the first moment
  // after the UI appears (or while held down). After that, Enter presses the button the user
  // moved to with Tab, or else `enter`: the forward choice (D41). Mouse clicks always work.
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

  // ---------- "Why am I seeing this?" and first-time tips (D21, D43) ----------

  const YOURS = new Set(["phone_number", "email", "street_address"]); // kinds of data that can be "mine"
  const REPORT_URL = "https://github.com/clotr-app/clotr/issues/new";
  const aName = (name) => `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`; // "an Email Address"
  // Kinds a fake bank or "support" call asks for (codes, passwords, cards): the plain truth, once.
  const SCAM_TARGETS = new Set(["password", "credit_card", "us_ssn", "bank_account"]);

  // One warning UI per page copy of Clotr. `app` is content.js's side: what the UI needs to know (the chat box,
  // settings) and what the person's choices do. Nothing here records, stores or sends anything itself.
  function create(app) {
    const { msg, generalForms } = globalThis.Clotr;
    const { getText } = globalThis.Clotr.editor;
    const IS_TOP = window === window.top;
    // Helping someone (Settings → "Larger warnings"): bigger text and buttons in Clotr's boxes.
    const sized = (cls) => (app.largeText() ? `${cls} large` : cls);

    // ---------- Clotr's own boxes ----------
    // The dialog, the corner warning and the reload prompt sit directly under <html>. If one vanishes without
    // Clotr removing it, the page is removing Clotr's warnings (hostile, or a framework rebuilding the page):
    // content.js hears about it and stops holding messages there, so nobody is stuck (D30, HP1).
    const ownRemovals = new WeakMap(); // node → removals by Clotr not yet seen by the observer
    const CLOTR_HOSTS = new Set(["CLOTR-GUARD", "CLOTR-NOTICE", "CLOTR-RELOAD"]);
    function removeOwn(node) {
      if (!node?.isConnected) return;
      ownRemovals.set(node, (ownRemovals.get(node) || 0) + 1);
      node.remove();
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

    // "Test Clotr here" (popup): outline the chat box Clotr watches for a moment. The outline never takes clicks
    // and removes itself.
    function outline(box) {
      box.scrollIntoView({ block: "center", behavior: "instant" });
      const r = box.getBoundingClientRect();
      const host = document.createElement("clotr-flash");
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

    // ---------- The choices, in plain words (D40) ----------
    // Every warning offers: this time only (Hide it / Leave it in), and from now on, for this
    // item (vault fingerprint: "fine to share" or "always watch") or for this kind of data.

    // "More choices": each one is today's answer plus a lasting one. `cover` is null for a file; `general` swaps
    // details for a general version ("March 1948", "Springfield") and hides the rest.
    function moreChoices(results, { leave, cover, general = null }) {
      const perItem =
        !app.orphaned() &&
        app.canRemember() &&
        totalMatches(results) <= BULK_ITEMS &&
        !results.some((r) => app.isVaultType(r.id));
      const one = totalMatches(results) === 1;
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
        ...(perItem
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
        choice(msg("choiceLogKinds", "Leave it in, and stop warning me about: $1", kindsOf(results)), () => {
          app.setToLog(results.map((r) => r.id));
          leave();
        }),
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
      return el("details", { className: "more" }, [
        el("summary", { textContent: msg("moreChoices", "More choices") }),
        el("div", { className: "choices" }, buttons),
      ]);
    }

    // The "Ask before sending" dialog: one decision for everything listed. `resend`: it stopped a send, so leaving
    // it in sends the message (D121). `back` returns to the message without choosing (D41).
    function showDialog(results, { resend, leave, cover, general, back }) {
      if (!host) {
        host = document.createElement("clotr-guard");
        shadow = host.attachShadow({ mode: "closed" });
      }

      const items = results.map((r) =>
        el("li", {}, [
          el("span", { className: `sev ${r.severity}`, textContent: msg(`sev_${r.severity}`, r.severity) }),
          `${r.name}: `,
          el("code", { textContent: describeValues(r) }),
        ]),
      );
      const bulk = bulkSummary(results);

      const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
      const allowBtn = el("button", {
        textContent: resend ? msg("leaveItSend", "Leave it in and send") : msg("leaveIt", "Leave it in"),
      });
      const backBtn = el("button", {
        className: "link",
        textContent: msg("backToMessage", "Go back to my message (Esc)"),
      });

      const box = el("div", { className: sized("box"), tabIndex: -1 }, [
        el("h2", { textContent: msg("dialogTitle", "⚠️ This looks private") }),
        el("p", {
          textContent: app.everyday()
            ? msg("dialogLeadHere", "If you send this, the people who read it here will see:")
            : msg("dialogLead", "If you send this, the AI service will see:"),
        }),
        ...(bulk ? [el("p", { className: "bulk", textContent: bulk })] : []),
        el("ul", {}, items),
        el("div", {
          className: "note",
          textContent: msg(
            "dialogNote",
            "Clotr checked this on your computer, and nothing's been sent yet. Hide it swaps it for a label like $1.",
            `[REDACTED ${results[0].name.toUpperCase()}]`,
          ),
        }),
        el("div", { className: "actions" }, [allowBtn, redactBtn]),
        moreChoices(results, { leave, cover, general }),
        el("div", { className: "keys" }, [el("span", { textContent: msg("enterCovers", "Enter: Hide it") }), backBtn]),
      ]);
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");

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
      shadow.replaceChildren(el("style", { textContent: DIALOG_CSS }), overlay);
      if (!host.isConnected) document.documentElement.append(host);
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

    // ---------- Warn notice (doesn't block, doesn't take focus) ----------

    let noticeHost = null;
    let noticeShadow = null;
    let noticeFocus = null; // () => focuses the notice's main button (keyboard shortcut Alt+Shift+C)
    let noticeKind = null; // what the corner notice shows: "warn" | "file" | "offer"
    let noticeOpenedAt = 0; // when the current warning first appeared (fast-send check, D52)
    const SHORTCUT_HINT = msg(
      "keyboardHint",
      "Keyboard: Alt+Shift+C jumps here, Enter chooses, Esc goes back to your message.",
    );

    // Keyboard users reach the notice with Clotr's shortcut; Esc returns to the chat box.
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

    function whyText(results, file) {
      const names = [...new Set(results.map((r) => r.name))].join(", ");
      if (file?.count > 1)
        return (
          msg("whyFoundFiles", "Clotr found what looks like: $1, in the files $2. ", names, file.name) +
          scamLine(results) +
          msg(
            "whyBody",
            "Whatever you send an AI can stay on its servers, be read by the people who run it, or be used to train it. Nothing has left your computer yet, and it's your call: hide it, leave it in, or use More choices to decide how Clotr handles this from now on.",
          )
        );
      return (
        (file
          ? msg("whyFoundFile", "Clotr found what looks like: $1, in the file “$2”. ", names, file.name)
          : msg("whyFound", "Clotr found what looks like: $1. ", names)) +
        scamLine(results) +
        msg(
          "whyBody",
          "Whatever you send an AI can stay on its servers, be read by the people who run it, or be used to train it. Nothing has left your computer yet, and it's your call: hide it, leave it in, or use More choices to decide how Clotr handles this from now on.",
        )
      );
    }

    // The first time Clotr warns about a kind of data, it asks how to treat it from now on,
    // and for your own kinds of data whether this one is yours. Shown once per kind; kept
    // while the notice is open (it's rebuilt on every pause in typing).
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
      const done = (text) => {
        t.status = text;
        boxEl.replaceChildren(el("p", { textContent: text }));
      };
      if (t.status) {
        done(t.status);
        return boxEl;
      }
      const current = app.responseOf(t.id);
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
          choice(
            "warn",
            msg("tipWarn", "Warn me"),
            msg("tipWarnDone", "Got it. Clotr will keep warning you about $1.", aName(t.name), t.name),
          ),
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
          el("div", { className: "choices" }, [mine, share]),
        );
      }
      boxEl.replaceChildren(...parts);
      return boxEl;
    }

    // The first time a personal detail shows up on a site: offer Bandage in the warning (D93).
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

    // The corner warning. `file` = { name, lines } for an attached file: it can't be redacted, only removed by the
    // user. `leave` keeps what was found; `cover(general)` hides it.
    function showNotice(results, file, { leave, cover }) {
      if (!noticeHost) {
        noticeHost = document.createElement("clotr-notice");
        noticeShadow = noticeHost.attachShadow({ mode: "closed" });
      }
      const bulk = bulkSummary(results, file);
      // One <code> per item: an item never breaks, but the line wraps between items
      // instead of running past the notice's edge.
      const what = bulk
        ? []
        : results
            .flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`))
            .flatMap((item, i) => [...(i ? [", "] : []), el("code", { textContent: item })]);
      const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
      const keepBtn = el("button", { textContent: file ? msg("ok", "OK") : msg("leaveIt", "Leave it in") });
      const whyBtn = el("button", { className: "link", textContent: msg("why", "Why am I seeing this?") });
      whyBtn.setAttribute("aria-expanded", String(whyOpen));
      // "Wrong?" opens a prefilled GitHub issue with only the kind of data: never the value or
      // the site. It's a page the user chooses to open; Clotr itself sends nothing.
      const reportBtn = el("button", {
        className: "link",
        textContent: msg("reportFalseAlarm", "Wrong? Report a false alarm"),
      });
      reportBtn.addEventListener("click", () => {
        const kinds = [...new Set(results.map((r) => r.name))].join(", ");
        const url = `${REPORT_URL}?template=false-alarm.yml&title=${encodeURIComponent(`False alarm: ${kinds}`)}&kind=${encodeURIComponent(kinds)}`;
        window.open(url, "_blank", "noopener");
      });
      const why = el("div", { className: "why", hidden: !whyOpen }, [
        el("p", { textContent: whyText(results, file) }),
        reportBtn,
      ]);
      whyBtn.addEventListener("click", () => {
        whyOpen = !whyOpen;
        why.hidden = !whyOpen;
        whyBtn.setAttribute("aria-expanded", String(whyOpen));
      });
      const offerBandage =
        app.bandageUnasked() && !file && !bulk && !app.orphaned() && results.some((r) => r.group !== "credentials");
      const tipBox = offerBandage ? bandageOffer() : !file && !bulk ? firstTimeTip(results) : null;
      const everyday = app.everyday();
      const box = el("div", { className: sized("notice") }, [
        el("b", { textContent: msg("noticeTitle", "⚠️ Heads up") }),
        el(
          "p",
          {},
          bulk
            ? [
                bulk,
                everyday
                  ? msg("noticeSharedBulkHere", " If you send it, the people who read it here get it.")
                  : msg("noticeSharedBulk", " If you send it, this AI gets it."),
              ]
            : [
                msg("noticeContains", "Your message contains "),
                ...what,
                everyday
                  ? msg("noticeSharedHere", ". If you send it, the people who read it here get it.")
                  : msg("noticeShared", ". If you send it, this AI gets it."),
              ],
        ),
        ...(file
          ? [
              el("p", {
                className: "hint",
                textContent:
                  file.count > 1
                    ? msg("noticeFilesHint", "To keep them private, take those files off before you send.")
                    : msg("noticeFileHint", "To keep it private, take the file off before you send."),
              }),
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
        el("div", { className: "actions" }, file ? [keepBtn] : [keepBtn, redactBtn]),
        moreChoices(results, {
          leave: () => leave(),
          cover: file ? null : () => cover(),
          general: file ? null : () => cover(true),
        }),
        whyBtn,
        why,
        ...(tipBox ? [tipBox] : []),
      ]);
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");

      // Never hand the click itself to cover(): its first argument means "keep it general".
      redactBtn.addEventListener("click", () => cover());
      keepBtn.addEventListener("click", () => leave());

      keyboardReach(box, file ? keepBtn : redactBtn);
      if (!isNoticeOpen() || noticeKind !== (file ? "file" : "warn")) noticeOpenedAt = Date.now();
      noticeKind = file ? "file" : "warn";
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
    }

    function closeNotice() {
      noticeKind = null;
      tip = null;
      whyOpen = false;
      removeOwn(noticeHost);
    }

    // ---------- "Clotr was updated: reload this page" (D37) ----------
    // Shown by an orphaned copy that no updated copy replaced. The page is greyed out until
    // the user answers; "Later" keeps the old copy warning (never holding a message).

    let reloadHost = null;
    let reloadAsked = false;
    const RELOAD_CSS = globalThis.Clotr.styles.reload;

    function showReloadPrompt() {
      if (reloadAsked || app.retired() || !IS_TOP) return;
      reloadAsked = true;
      reloadHost = document.createElement("clotr-reload");
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
      // Enter goes forward (reload), Esc or Backspace goes back to the page (D41).
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
        noticeHost = document.createElement("clotr-notice");
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
      noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
      if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
      clearTimeout(offerTimer);
      offerTimer = setTimeout(() => {
        if (noticeKind === "offer") closeNotice();
      }, 30000);
    }

    // Bandage held a send while it covered the details: they're covered now.
    function tellCovered() {
      showOffer({
        title: msg("bandageHeldTitle", "🩹 Details covered"),
        text: msg("bandageHeldText", "Your details have cover names now. Press Enter again to send."),
        yes: msg("ok", "OK"),
        no: null,
      });
    }

    // Hide it didn't take: say so plainly, so nobody sends a key they think is gone (Kimi, M2).
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

    // The user deleted flagged items by hand before sending: offer to always watch for them. `items`:
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

    // A warned message went out before the warning could be read (D52): say what went, and offer to ask first.
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

    // An AI reply brought up your own details that you didn't type here (D63).
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

    // ---------- Bandage step 2 (D93, D99): hotspots over labels, and the hover-to-peek bubble ----------
    // The AI's page is never changed: content.js finds each known label with a live Range, and this lays Clotr's own
    // invisible, focusable hotspot over it, in a closed-shadow layer. Pointing at one, or tabbing to it, opens a small
    // Clotr bubble with the real detail; "Copy with real names" copies the whole answer with the details back.
    // An `older` label is one the conversation held before a reload: Clotr didn't keep its detail (D27), so its bubble
    // says so and never shows a detail. Each hotspot keeps the chat it was made for (content.js's, opaque here): the same
    // label means a different detail in another chat, so its detail comes from that chat only, and once the page's chat
    // changes (a switch without a reload) every hotspot goes, the bubble with them (BN20).
    const peekSpots = []; // { node, start, range, label, root, chat, older, btn }
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
      peekSpots.push({ node, start, range, label, root, chat, older, btn: null });
      return true;
    }
    // Asking for the page's chat notices a change (content.js then clears every hotspot): true while `sp` still
    // belongs to it.
    const sameChat = (sp) => app.currentChat() === sp.chat;

    function dropSpot(i) {
      const sp = peekSpots[i];
      if (peekTarget === sp) closePeek();
      sp.btn?.remove();
      peekSpots.splice(i, 1);
    }

    // Puts each hotspot over its label (once per frame; after scrolls, resizes and new replies, and once a second). A
    // label whose text changed or left the page loses its hotspot, and all of them go once the page's chat changed.
    function placeSpots() {
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
            return;
          }
          // A sidebar opening or an image loading moves the labels without a scroll or resize event.
          if (!spotTimer) spotTimer = setInterval(() => document.visibilityState === "visible" && placeSpots(), 1000);
          if (!spotHost?.isConnected) {
            spotHost = document.createElement("clotr-spots");
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
            const r = sp.range.getBoundingClientRect();
            sp.btn.hidden = !(r.width && r.height && r.bottom > 0 && r.top < innerHeight);
            Object.assign(sp.btn.style, {
              left: `${r.left}px`,
              top: `${r.top}px`,
              width: `${r.width}px`,
              height: `${r.height}px`,
            });
          }
          if (peekTarget) positionPeek();
        }),
      );
    }
    addEventListener("scroll", () => peekSpots.length && placeSpots(), { capture: true, passive: true });
    addEventListener("resize", () => peekSpots.length && placeSpots(), { passive: true });

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
    // An updated Clotr took over this page: the hotspots and an open bubble go with this copy, or they'd stay
    // on the page with nothing to move or close them (BN16). The same when the page's chat changes (BN20).
    function retireSpots() {
      closePeek();
      clearInterval(spotTimer);
      spotTimer = 0;
      cancelAnimationFrame(spotFrame);
      removeOwn(spotHost);
      spotHost = null;
      peekSpots.length = 0;
    }
    // A short delay before closing: moving the pointer from the label into the bubble (to reach its button) crosses
    // the gap between them.
    function schedulePeekClose() {
      clearTimeout(peekCloseTimer);
      peekCloseTimer = setTimeout(app.safely(closePeek), 300);
    }
    function cancelPeekClose() {
      clearTimeout(peekCloseTimer);
    }

    function positionPeek() {
      if (!peekBox || !peekTarget) return;
      const r = peekTarget.range.getBoundingClientRect();
      Object.assign(peekBox.style, {
        left: `${Math.max(4, Math.min(r.left, innerWidth - 336))}px`,
        top: `${r.bottom + 6}px`,
      });
    }

    function showPeek(sp) {
      cancelPeekClose();
      if (peekTarget === sp && peekHost?.isConnected) return;
      // A hotspot left from the chat you switched away from: it goes (with the others), it shows nothing.
      if (!sameChat(sp)) return retireSpots();
      const value = sp.older ? null : app.realValue(sp.label, sp.chat);
      if ((!value && !sp.older) || !sp.node.isConnected) return;
      closePeek();
      peekTarget = sp;
      peekHost = document.createElement("clotr-peek");
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

    // An updated Clotr took over this page (D39): everything this copy shows steps aside.
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
      shakeDialog,
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
