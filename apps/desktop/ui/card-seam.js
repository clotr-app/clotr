// Clotr for Windows' card is the browser's corner warning itself: warning-ui.js and ui-styles.js, unchanged. This is
// the seam between them and the app, loaded after the engine bundle and before warning-ui.js. What differs here:
// - the warning's sentence is about what you copied: "What you copied contains … If you paste it here, this AI app
//   gets it." (decide.js's noticeWords with source "copied", the same words every app says);
// - two button labels ("Clot this leak" and "Leave it alone"), from apps/locales;
// - for what was typed in the AI app's box (the typing check), the browser's own typed wording comes back, with
//   that card's two buttons from apps/locales ("warning.typed…"), since the copy's words would be wrong there;
// - for a long paste the warning counts the chat box's lines: here the "box" is what was copied, and only its number
//   of lines is kept;
// - "Keep it general" needs the details themselves, which the card never keeps, so it isn't offered here;
// - the card's window fits the warning, so this keeps a hand on the warning's box to measure it (only this page's
//   own code can reach it: the page shows nothing else).
(() => {
  "use strict";
  const C = globalThis.Clotr;
  const W = globalThis.ClotrWords;

  const words = C.noticeWords;
  let source = "copied";
  C.desktopSource = (next) => {
    source = next === "typed" ? "typed" : "copied";
  };
  C.noticeWords = (results, options = {}) => words(results, { ...options, source });

  // The warning UI calls these noticeCover/noticeSendAsIs; desktop's wording is kept under coverIt/leaveIt.
  const COPY_WORDS = new Set([
    "coverIt",
    "leaveIt",
    "noticeCover",
    "noticeSendAsIs",
    "noticeSharedBulk",
    "bulkPaste",
    "bulkMessage",
    "whyBody",
  ]);
  const COPY_KEYS = { noticeCover: "coverIt", noticeSendAsIs: "leaveIt" };
  const base = C.msg;
  C.msg = (key, english, ...subs) => {
    if (source === "typed") {
      const own = `warning.typed${key[0].toUpperCase()}${key.slice(1)}`;
      if (W.has(own)) return W.t(own, ...subs);
      if (COPY_WORDS.has(key)) return base(key, english, ...subs);
    }
    const copyKey = COPY_KEYS[key] || key;
    return W.has(`warning.${copyKey}`) ? W.t(`warning.${copyKey}`, ...subs) : base(key, english, ...subs);
  };

  C.editor = { getText: (box) => "\n".repeat(Math.max(0, (Number(box?.lines) || 1) - 1)) };
  C.generalForms = () => [];

  let noticeRoot = null;
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = attach.call(this, init);
    if (this.localName === "clotr-notice") noticeRoot = root;
    return root;
  };
  C.desktopNoticeBox = () => noticeRoot?.querySelector(".notice") || null;
})();
