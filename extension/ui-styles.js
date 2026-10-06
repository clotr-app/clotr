// Styles for Clotr's warnings, dialog and reload prompt (content script).
// They live in closed shadow roots, so the page's CSS can't touch them and they can't touch the page.
// Loaded before warning-ui.js, which reads Clotr.styles. Brand: plum on light steel, flat finish, no
// gradients or glow. The box itself stays the same light-steel card in both themes; only the host page
// around it is dark or light.
(() => {
  "use strict";

  const PLUM = "#5b3a63"; // buttons, pad and accent rails: the same value in both themes
  const ON_PLUM = "#ffffff"; // white on plum, 9.4:1
  const INK = "#1f2226"; // the box's own text: the same value in both themes
  const NOTE_PAPER = "#d9dde1"; // the warning box's paper
  const NOTE_EDGE = "#9ea4ab"; // the warning box's edge

  // Tourniquet's line in a warning: a plum edge, a plum-tinted wash and the small shield. Ink on the wash
  // stays well over 4.5:1. The who-asks line is the same box: its question bold on a line of its own, then
  // the answer, beside a question mark in a plum disc, or Tourniquet's shield while it's on. "What to do",
  // behind "Why am I seeing this?", is drawn the same way.
  const TQ = `
    .tq { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 12px; padding: 8px 10px; border-left: 3px solid ${PLUM}; border-radius: 6px; background: #ece4ef; color: ${INK}; }
    .tq svg { flex: none; width: 1.1em; height: 1.1em; margin-top: .15em; fill: ${PLUM}; }
    .tq b { display: block; margin: 0 0 2px; font-size: inherit; }
    .tq svg.ask-icon .disc { fill: ${PLUM}; }
    .tq svg.ask-icon .mark { fill: none; stroke: #fff; stroke-width: 1.7; stroke-linecap: round; }
    .tq svg.ask-icon .dot { fill: #fff; }
    .why .tq { margin: 6px 0; padding: 6px 8px; }
  `;

  // An attached file held for Ask before sending: each file as a chip with its kind on a small plum badge
  // (white on plum, 9.4:1).
  const FILES = `
    .files { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; }
    .file { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; box-sizing: border-box; padding: 4px 9px; border: 1px solid ${NOTE_EDGE}; border-radius: 8px; background: #fff; font-size: 13px; }
    .file b { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .03em; padding: 1px 4px; border-radius: 3px; background: ${PLUM}; color: ${ON_PLUM}; }
    .file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more-files { font-size: 13px; color: #555; }
    .box.large .file, .box.large .more-files { font-size: 16px; }
    .box.large .file b { font-size: 12px; }
    /* Under an organization's policy: its line on the same plum wash as Tourniquet's; the "still checking"
       question has the reload prompt's plum edge (a wait). */
    .team { margin: 0 0 12px; padding: 8px 10px; border-left: 3px solid ${PLUM}; border-radius: 6px; background: #ece4ef; color: ${INK}; }
    .box.wait { border-top-color: ${PLUM}; }
    .box.wait button.primary { background: ${PLUM}; border-color: ${PLUM}; color: ${ON_PLUM}; }
  `;

  // The "Ask before sending" dialog (and the base for the reload prompt).
  const dialog = `
    :host { all: initial; }
    /* It covers the part of the page you can see: warning-ui.js sets --vv-top and --vv-height from the browser's
       visualViewport, which an on-screen keyboard shrinks and moves. Text keeps its size on phones. */
    .overlay {
      position: fixed; left: 0; right: 0; top: var(--vv-top, 0px); height: var(--vv-height, 100%); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
      background: rgba(0, 0, 0, .45);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
    }
    /* The box stays this same light-steel card over a dark or a light page: only the host page's own
       theme changes, never Clotr's. */
    .box {
      width: min(440px, 100%); max-height: 100%; overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; outline: none;
      background: ${NOTE_PAPER}; color: ${INK};
      border: 1px solid ${NOTE_EDGE}; border-top: 5px solid ${PLUM};
      border-radius: 14px; padding: 18px 20px;
    }
    h2 { font-size: 17px; margin: 0 0 6px; }
    p { margin: 0 0 10px; }
    ul { margin: 0 0 12px; padding-left: 18px; }
    li { margin: 3px 0; }
    .sev { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
    .high { background: #fce8e6; color: #b3261e; }
    .medium { background: #fef3e0; color: #a05a00; }
    .low { background: #e8f0fe; color: #1a56c4; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    label { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; margin: 4px 0 14px; cursor: pointer; }
    input { margin-top: 3px; }
    .note { font-size: 12px; color: #555; margin-bottom: 14px; }
    .bulk { font-weight: 600; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    /* Larger warnings (settings → helping someone) */
    .box.large { width: min(560px, 100%); font-size: 18px; padding: 22px 24px; }
    .box.large h2 { font-size: 22px; }
    .box.large button { font-size: 17px; padding: 10px 18px; }
    .box.large code, .box.large .more summary { font-size: 16px; }
    .box.large .note, .box.large .keys { font-size: 15px; }
    .box.large button.link { font-size: 16px; padding: 2px 0; }
    /* The main action in plum; the second, outlined, reads as ink on the box's own paper. */
    button { font: inherit; cursor: pointer; border-radius: 8px; padding: 7px 14px; border: 1px solid ${NOTE_EDGE}; background: #fff; color: ${INK}; }
    button:focus-visible { outline: 3px solid ${PLUM}; outline-offset: 2px; }
    button.primary { background: ${PLUM}; border-color: ${PLUM}; color: ${ON_PLUM}; }
    .more { margin: 12px 0 0; font-size: 13px; }
    .more summary { cursor: pointer; color: ${INK}; width: fit-content; }
    .more .choices { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    button.choice { text-align: left; padding: 5px 10px; font-size: 13px; }
    .keys { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; color: #555; }
    button.link { border: none; background: none; padding: 2px 0; font-size: 12px; text-decoration: underline; color: ${PLUM}; }
    ${TQ}
    ${FILES}
    .shake { animation: shake .3s ease-in-out; }
    @keyframes shake { 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    @media (prefers-reduced-motion: reduce) {
      .shake { animation: none; }
    }
 /* Phones and touch screens: every target at least 44 px for a thumb, the two choices side by side and
       48 px tall, 16 px text. Larger warnings grow here too. */
    @media (pointer: coarse), (max-width: 480px) {
      .box { font-size: 16px; }
      h2 { font-size: 19px; }
      .note, label, .more, .keys { font-size: 15px; }
      code { font-size: 14px; }
      button { min-height: 44px; min-width: 44px; }
      .actions { flex-wrap: nowrap; }
      .actions button { flex: 1 1 0; min-height: 48px; }
      .more summary { min-height: 44px; padding: 10px 0; box-sizing: border-box; }
      button.choice { min-height: 44px; padding: 8px 12px; font-size: 15px; }
      button.link { padding: 0; font-size: 15px; }
      .box.large { font-size: 19px; }
      .box.large h2 { font-size: 23px; }
      .box.large code, .box.large .more summary, .box.large button.link, .box.large button.choice { font-size: 17px; }
    }
    @media (max-width: 480px) {
      .overlay { padding: 8px; }
      .box, .box.large { padding: 16px; }
    }
    /* No keyboard to press Enter on. */
    @media (hover: none) and (pointer: coarse) {
      .keys > span { display: none; }
    }
  `;

  // The warning notice in the corner (doesn't block, doesn't take focus).
  const notice = `
    :host { all: initial; }
    /* Near the top, which keeps the chat box and send button clear: the top of the part of the page you can see,
       from --vv-top (warning-ui.js, from the browser's visualViewport, which an on-screen keyboard moves).
       Text keeps its size on phones. */
    .notice {
      position: fixed; right: 16px; top: calc(var(--vv-top, 0px) + 16px); z-index: 2147483647;
      width: min(340px, calc(100vw - 32px)); box-sizing: border-box;
      -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
 /* The same light-steel card as the dialog, over a dark or a light page. */
      background: ${NOTE_PAPER}; color: ${INK}; border-left: 5px solid ${PLUM};
      border-radius: 12px; padding: 12px 14px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    b { display: block; margin-bottom: 4px; font-size: 14px; }
    .hint { font-size: 12px; color: #5e5b5f; }
    .checking p { margin: 0; } /* "Checking your file": a note, nothing to press */
    p { margin: 0 0 10px; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: nowrap; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button { font: inherit; cursor: pointer; border-radius: 8px; padding: 5px 12px; border: 1px solid ${NOTE_EDGE}; background: #fff; color: ${INK}; }
    button:focus-visible { outline: 3px solid ${PLUM}; outline-offset: 2px; }
    button.primary { background: ${PLUM}; border-color: ${PLUM}; color: ${ON_PLUM}; }
    .notice .actions { flex-wrap: wrap; }
    /* Larger warnings (settings → helping someone): easier to read and to hit */
    .notice.large { width: min(440px, calc(100vw - 32px)); font-size: 17px; padding: 16px 18px; }
    .notice.large b { font-size: 19px; }
    .notice.large .hint { font-size: 15px; }
    .notice.large button { font-size: 16px; padding: 9px 16px; }
    /* Everything grows, not just the headline; text links stay links (no button padding). */
    .notice.large code, .notice.large .more summary, .notice.large .why { font-size: 15px; }
    .notice.large button.link { font-size: 15px; padding: 2px 0 0; }
    .notice button { white-space: nowrap; }
    .why { font-size: 12px; color: #555; margin: 6px 0 0; }
    .why p { margin: 0 0 4px; }
    .why button.link { text-align: left; flex-basis: auto; }
    .more { margin: 8px 0 0; font-size: 12px; }
    .more summary { cursor: pointer; color: #555; width: fit-content; }
    .more .choices { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
    button.choice { text-align: left; padding: 4px 9px; font-size: 12px; white-space: normal; }
    .tip { margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 12px; }
    .tip p { margin: 0 0 6px; }
    .tip b { display: inline; font-size: inherit; margin: 0; }
    .tip .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .tip button { padding: 3px 9px; font-size: 12px; }
    .tip button.chosen { border-color: ${PLUM}; box-shadow: inset 0 0 0 1px ${PLUM}; }
    /* The command check's note: the plain notice, with a question box for who asks for this. */
    .qbox { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0 10px; padding: 8px 10px; border-left: 3px solid ${PLUM}; border-radius: 6px; background: ${NOTE_PAPER}; color: ${INK}; }
    .qbox svg { flex: none; width: 1.25em; height: 1.25em; margin-top: .1em; }
    .qbox svg circle { fill: ${PLUM}; }
    .qbox svg text { fill: #fff; font: 700 11px system-ui, sans-serif; }
    .qbox b { display: block; margin-bottom: 2px; font-size: inherit; }
    .qbox p { margin: 0; }
    ${TQ}
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    button.link { order: 1; flex-basis: 100%; text-align: right; border: none; background: none; padding: 2px 0 0; font-size: 12px; text-decoration: underline; color: #555; }
 /* Phones and touch screens: every target at least 44 px for a thumb, the two choices side by side and
       48 px tall, 16 px text. Larger warnings grow here too. */
    @media (pointer: coarse), (max-width: 480px) {
      /* No taller than the part you can see (--vv-height): it scrolls inside. Only here, as Firefox makes a box that
         can scroll a stop of its own when you Tab through the warning. */
      .notice {
        font-size: 16px; padding: 14px 16px;
        max-height: calc(var(--vv-height, 100vh) - 32px); overflow-y: auto; overscroll-behavior: contain;
      }
      b { font-size: 17px; }
      .hint, .why, .more, .tip { font-size: 15px; }
      code { font-size: 14px; }
      button { min-height: 44px; min-width: 44px; }
      .actions { flex-wrap: nowrap; }
      .actions button { flex: 1 1 0; min-height: 48px; white-space: normal; }
      .more summary { min-height: 44px; padding: 10px 0; box-sizing: border-box; }
      button.choice, .tip button { min-height: 44px; padding: 8px 12px; font-size: 15px; }
      button.link { padding: 0; font-size: 15px; }
      .notice.large { font-size: 19px; padding: 16px 18px; }
      .notice.large b { font-size: 21px; }
      .notice.large .actions button { font-size: 18px; }
      .notice.large .hint, .notice.large code, .notice.large .more summary, .notice.large .why,
      .notice.large button.link, .notice.large button.choice, .notice.large .tip button { font-size: 17px; }
    }
    /* A phone's width: the warning spans the screen, 8 px below the top of the part you can see. Wider touch
       screens (tablets) keep the corner. */
    @media (max-width: 480px) {
      .notice, .notice.large {
        left: 16px; right: 16px; width: auto;
        top: calc(var(--vv-top, 0px) + 8px); max-height: calc(var(--vv-height, 100vh) - 16px);
      }
    }
  `;

  // "Clotr was updated: reload this page": the dialog, in Clotr's plum.
  const reload = `
    .box { border-top-color: ${PLUM}; }
  `;

  // "Test Clotr here" (popup): a plum outline over the chat box Clotr watches; never catches clicks.
  const flash = `
    :host { all: initial; }
    .ring {
      position: fixed; pointer-events: none; z-index: 2147483647; box-sizing: border-box;
      border: 3px solid ${PLUM}; border-radius: 10px;
      animation: clotr-flash 1.8s ease-in-out forwards;
    }
    @keyframes clotr-flash {
      0% { opacity: 0; } 12% { opacity: 1; } 35% { opacity: 0.35; } 58% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ring { animation: none; }
    }
  `;

  // Bandage step 2: the small bubble that shows a label's real detail when you point at it
  // (or focus it with the keyboard) in the AI's answer. The same light-steel card in both themes.
  const peek = `
    :host { all: initial; }
    .box {
      position: fixed; z-index: 2147483647; max-width: min(320px, calc(100vw - 32px)); box-sizing: border-box;
      background: ${NOTE_PAPER}; color: ${INK}; border: 1px solid ${NOTE_EDGE}; border-left: 5px solid ${PLUM};
      border-radius: 12px; padding: 10px 12px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .value { font-weight: 600; margin-bottom: 8px; word-break: break-word; }
    .note { margin: 0; }
    button { font: inherit; cursor: pointer; border-radius: 8px; padding: 5px 10px; border: 1px solid ${NOTE_EDGE}; background: #fff; color: ${INK}; }
    button:focus-visible { outline: 3px solid ${PLUM}; outline-offset: 2px; }
    .copied { font-size: 12px; color: #1f7a3f; margin-top: 6px; }
  `;

  // Bandage step 2: the invisible hotspots Clotr lays over each label in the AI's answer (the page itself is
  // never changed). A dotted plum underline says "point here"; a clear ring shows keyboard focus. A label from before
  // a reload, whose detail Clotr didn't keep, gets a grey one.
  const spots = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .spot {
      position: fixed; pointer-events: auto; margin: 0; padding: 0; border: 0; background: transparent;
      border-bottom: 2px dotted ${PLUM}; cursor: help;
    }
    .spot.older { border-bottom-color: #8a8a8a; }
    .spot:focus-visible { outline: 3px solid ${PLUM}; outline-offset: 2px; border-radius: 3px; }
  `;

  globalThis.Clotr.styles = { dialog, notice, reload, flash, peek, spots };
})();
