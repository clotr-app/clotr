// Clotr for Windows -- the note for your helper's UI: the one
// entry point, ClotrNote.open(scan). Built as its own overlay appended straight to <body>, never
// inside a .screen section, so this lands without touching results.js, settings.js or main.html's screens. The
// panel is drawn with createElement from results-note.js's report() (never innerHTML); the saved and printed
// artifacts are results-note.js's own HTML and plain-text strings, the same split summary.js already uses.
"use strict";

(() => {
  const { call } = globalThis.ClotrApp || {};
  const W = globalThis.ClotrWords;
  const N = globalThis.ClotrNote;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  let refs = null;
  let currentScan = null;
  let namesOn = false;
  let helperNameNow = null;
  let lastFocused = null;

  function opts() {
    return { names: namesOn, t: W.t, lang: document.documentElement.lang, helperName: helperNameNow };
  }

  function render() {
    if (!currentScan) return;
    const r = N.report(currentScan, opts());
    refs.heading.textContent = r.title;
    refs.lead.textContent = W.t("ws.noteLead");
    refs.namesLabel.textContent = W.t("ws.noteNamesSwitch");
    refs.namesSwitch.setAttribute("aria-checked", String(namesOn));
    refs.saveBtn.textContent = W.t("ws.noteSave");
    refs.printBtn.textContent = W.t("ws.notePrint");
    refs.emailBtn.textContent = W.t("ws.noteEmail");
    refs.closeBtn.textContent = W.t("ws.noteClose");

    const kids = [];
    if (r.for) kids.push(el("p", { className: "muted", textContent: r.for }));
    kids.push(el("p", { className: "small muted", textContent: r.meta }));
    if (r.intro) kids.push(el("p", { textContent: r.intro }));
    kids.push(el("p", { className: "note-count", textContent: r.count }));
    if (r.rows.length) {
      const head = el("tr", {}, [
        el("th", { scope: "col", className: "note-done", textContent: r.heads.done }),
        el("th", { scope: "col", textContent: r.heads.found }),
        el("th", { scope: "col", textContent: r.heads.where }),
        el("th", { scope: "col", textContent: r.heads.recommend }),
      ]);
      const body = r.rows.map((row) =>
        el("tr", {}, [
          el("td", { className: "note-done" }, [el("span", { className: "note-check", ariaHidden: "true" })]),
          el("td", { textContent: row.found }),
          el("td", { textContent: row.place }),
          el("td", { textContent: row.recommend }),
        ]),
      );
      kids.push(el("table", { className: "events" }, [el("thead", {}, [head]), el("tbody", {}, body)]));
    }
    if (r.stepSections.length) {
      kids.push(
        el("section", { className: "note-steps" }, [
          el("h3", { textContent: r.stepsTitle }),
          ...r.stepSections.map((s) =>
            el("div", { className: "note-step" }, [
              el("b", { textContent: s.recommend }),
              el(
                "ol",
                {},
                s.steps.split(" / ").map((line) => el("li", { textContent: line })),
              ),
            ]),
          ),
        ]),
      );
    }
    kids.push(
      el("section", { className: "note-is" }, [el("h3", { textContent: r.isTitle }), el("p", { textContent: r.is })]),
    );
    kids.push(el("p", { className: "small muted", textContent: r.namesLine }));
    kids.push(el("p", { className: "small muted", textContent: r.footer }));
    refs.preview.replaceChildren(...kids);

    const mail = N.mailto(currentScan, opts());
    refs.emailBtn.hidden = !mail.ok;
    refs.emailHint.hidden = mail.ok;
    refs.emailHint.textContent = mail.ok ? "" : W.t("ws.noteEmailTooLong");
    refs.emailHref = mail.href;
  }

  function buildPanel() {
    const heading = el("h2", { className: "sec-title", id: "note-heading", tabIndex: -1 });
    const lead = el("p", { className: "muted", id: "note-lead" });
    const namesLabel = el("span", { id: "note-names-label" });
    const namesSwitch = el("button", { className: "switch", id: "note-names", type: "button" });
    namesSwitch.setAttribute("role", "switch");
    namesSwitch.setAttribute("aria-checked", "false");
    namesSwitch.setAttribute("aria-labelledby", "note-names-label");
    namesSwitch.addEventListener("click", () => {
      namesOn = !namesOn;
      render();
    });
    const toggles = el("ul", { className: "toggles" }, [el("li", {}, [namesLabel, namesSwitch])]);
    const preview = el("div", { id: "note-preview" });
    const saveBtn = el("button", { className: "btn primary", type: "button", id: "note-save" });
    const printBtn = el("button", { className: "btn", type: "button", id: "note-print" });
    const emailBtn = el("button", { className: "btn", type: "button", id: "note-email" });
    const emailHint = el("span", { className: "small muted note-email-hint", id: "note-email-hint", hidden: true });
    const closeBtn = el("button", { className: "btn text", type: "button", id: "note-close" });
    const status = el("p", { className: "small muted", id: "note-status", role: "status" });

    saveBtn.addEventListener("click", async () => {
      status.textContent = "";
      const html = N.notePage(currentScan, opts());
      const r = (await call?.("save_summary", { html }).catch(() => ({ saved: false }))) || { saved: false };
      status.textContent = r.saved ? W.t("settings.saved") : "";
    });
    printBtn.addEventListener("click", () => {
      document.body.classList.add("printing-note");
      window.print();
    });
    emailBtn.addEventListener("click", async () => {
      if (!refs.emailHref) return;
      await call?.("open_mailto", { url: refs.emailHref }).catch(() => {});
    });
    closeBtn.addEventListener("click", close);

    const card = el("section", { className: "panel glass note-panel", id: "clotr-note-panel" }, [
      heading,
      lead,
      toggles,
      preview,
      el("p", { className: "btn-row" }, [saveBtn, printBtn, emailBtn, emailHint, closeBtn]),
      status,
    ]);
    const overlay = el("div", {
      className: "note-overlay",
      id: "clotr-note-overlay",
      hidden: true,
      role: "dialog",
      ariaModal: "true",
    });
    overlay.setAttribute("aria-labelledby", "note-heading");
    overlay.append(card);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    document.body.append(overlay);

    return {
      overlay,
      card,
      heading,
      lead,
      namesLabel,
      namesSwitch,
      preview,
      saveBtn,
      printBtn,
      emailBtn,
      emailHint,
      closeBtn,
      status,
    };
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  async function open(scan) {
    if (!N || !scan) return;
    if (!refs) refs = buildPanel();
    currentScan = scan;
    namesOn = false;
    helperNameNow = null;
    try {
      const view = await call?.("settings_hello");
      helperNameNow = N.helperName(view?.settings);
    } catch {
      helperNameNow = null;
    }
    render();
    refs.status.textContent = "";
    refs.overlay.hidden = false;
    lastFocused = document.activeElement;
    document.addEventListener("keydown", onKeydown);
    refs.heading.focus({ preventScroll: true });
  }

  function close() {
    if (!refs || refs.overlay.hidden) return;
    refs.overlay.hidden = true;
    document.body.classList.remove("printing-note");
    document.removeEventListener("keydown", onKeydown);
    lastFocused?.focus?.({ preventScroll: true });
  }

  window.addEventListener("afterprint", () => document.body.classList.remove("printing-note"));

  globalThis.ClotrNote = Object.assign(globalThis.ClotrNote || {}, { open, close });
})();
