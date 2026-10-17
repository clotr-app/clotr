// Finding the chat box and editing it the way the page's own framework expects.
// Classic content script (loaded after ui-styles.js, before warning-ui.js and content.js); shares Clotr.editor.
(() => {
  "use strict";
  const LOG = "[Clotr]";

  // The real event target, even when it sits inside a web component's shadow DOM
  // (Gemini and NotebookLM); plain e.target only points at the outer component.
  function realTarget(event) {
    const path = event.composedPath();
    return path.length ? path[0] : event.target;
  }

  // Sign-in fields on an AI site's own pages (username, a password shown as text, one-time codes,
  // card forms) go to the site on purpose: Clotr never watches or records them.
  const SIGN_IN_AUTOCOMPLETE = /\b(username|current-password|new-password|one-time-code|cc-[a-z-]+)\b/i;
  const SIGN_IN_WORDS = /pass(word|code|phrase)?|pwd|otp|verification|2fa|mfa/i;
  function isSignInField(input) {
    if (SIGN_IN_AUTOCOMPLETE.test(input.getAttribute("autocomplete") || "")) return true;
    if (SIGN_IN_WORDS.test(`${input.name} ${input.id} ${input.getAttribute("aria-label") || ""}`)) return true;
    return Boolean(input.form?.querySelector("input[type='password']"));
  }

  // Returns the textarea/input or contenteditable root (ProseMirror, Quill) for a node. type="search" is a
  // search box's own input type (Google, Bing and DuckDuckGo all use it, or plain text); it behaves like
  // type="text" for everything Clotr does here, so it's treated the same way.
  function findEditor(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches("input[type='text'], input[type='search'], input:not([type])")) {
      return isSignInField(node) ? null : node;
    }
    if (node.matches("textarea")) return node;
    if (!node.isContentEditable) return null;
    let root = node;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  function getText(editor) {
    return editor.isContentEditable ? editor.innerText : editor.value;
  }

  // ---------- "Everywhere I type": is this really a chat-style composer? ----------
  // Only matters on a page covered by the broad switch, with no dedicated setup of its own: there, Clotr has
  // to tell a message box from an ordinary form field by itself, since nothing names the page in advance.
  // autocomplete values that mark an address, a payment card, a name, an email, a phone number, a username or
  // a password: a box sitting in the same form as one of these is a form field, however many lines it has.
  const FORM_FIELD_AUTOCOMPLETE =
    /^(street-address|address-line[1-3]|address-level[1-4]|postal-code|country(-name)?|organization|cc-[a-z-]+|name|given-name|additional-name|family-name|honorific-(prefix|suffix)|nickname|email|tel(-[a-z-]+)?|username|current-password|new-password)$/i;
  // A nearby control whose label reads like it sends the message, the same wording a built-in AI site's own
  // send button uses, never "post" or "submit" alone on a page that never says "send": comment forms and
  // other ordinary submit buttons don't use this wording, so they're left for the autocomplete check instead.
  const SEND_LIKE = /\b(send|enviar)\b/i; // English and Spanish, Clotr's two languages

  // A pure decision, so it can be tested without a real page: true only for a multi-line box (never a plain
  // input) that looks like it sends a message and isn't sitting in a form built for someone's name, address,
  // payment details or sign-in.
  function isChatComposer({
    tag,
    hasSendButton = false,
    enterSends = false,
    formAutocompletes = [],
    hasPasswordField = false,
  } = {}) {
    if (tag !== "textarea" && tag !== "contenteditable") return false;
    if (hasPasswordField) return false;
    if ((formAutocompletes || []).some((ac) => FORM_FIELD_AUTOCOMPLETE.test(String(ac || "").trim()))) return false;
    return Boolean(hasSendButton || enterSends);
  }

  // Reads what isChatComposer needs off the real page: the box's own kind, whether its enclosing form (if
  // any) holds a password or one of the form-field autocomplete values, whether a send-labeled control sits
  // within a few levels of it, and whether it's set to send on Enter itself (enterkeyhint, the same attribute
  // phone keyboards read to show a send icon instead of a return arrow).
  function composerInfo(editor) {
    const tag = editor.isContentEditable ? "contenteditable" : editor.matches?.("textarea") ? "textarea" : "input";
    const form = typeof editor.closest === "function" ? editor.closest("form") : null;
    const formAutocompletes = form
      ? [...form.querySelectorAll("[autocomplete]")].map((f) => f.getAttribute("autocomplete") || "")
      : [];
    const hasPasswordField = Boolean(form?.querySelector("input[type='password']"));
    const enterSends = (editor.getAttribute?.("enterkeyhint") || "").toLowerCase() === "send";
    let hasSendButton = false;
    let area = editor;
    for (let i = 0; i < 4 && area?.parentElement && !hasSendButton; i++) {
      area = area.parentElement;
      for (const btn of area.querySelectorAll('button, [role="button"], input[type="submit"]')) {
        if (btn === editor || btn.contains(editor)) continue;
        const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.textContent || ""}`;
        if (SEND_LIKE.test(label)) {
          hasSendButton = true;
          break;
        }
      }
    }
    return { tag, formAutocompletes, hasPasswordField, enterSends, hasSendButton };
  }

  // execCommand is deprecated: if a browser drops it (or a command), this returns false instead of throwing.
  function command(name, value) {
    try {
      return document.execCommand(name, false, value);
    } catch {
      return false;
    }
  }

  function selectAll(editor) {
    editor.focus();
    if (editor.isContentEditable) {
      // The browser's own Select All (like Ctrl+A) is what rich editors track most reliably;
      // a plain range is the fallback if the command isn't handled.
      if (!command("selectAll") || !editor.contains(window.getSelection().anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      editor.select();
    }
  }

  // Spaces and invisible characters don't count: some editors keep a zero-width marker of their own at the end of the
  // box and put it back after an edit (Microsoft Copilot does this), so the text differs only by characters nobody sees.
  const plain = (s) =>
    s
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const sameText = (a, b) => plain(a) === plain(b);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Resolves once the editor's text differs from `before` (or after `ms`): some editors
  // (Lexical on Kimi) apply an edit a moment after the input event, not straight away.
  async function settled(editor, before, ms = 400) {
    for (let t = 0; t < ms && getText(editor) === before; t += 25) await wait(25);
  }
  // The next selectionchange (or `ms`), so an editor that tracks the selection itself has seen ours.
  const selectionSeen = (ms = 150) =>
    new Promise((r) => {
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener("selectionchange", done);
        r();
      };
      const timer = setTimeout(done, ms);
      document.addEventListener("selectionchange", done);
    });

  // True while Clotr edits the chat box itself: the input events that edit causes (and any
  // half-done state an async editor shows on the way) aren't the user typing.
  let editing = false;

  // The fallback if a browser drops execCommand("insertText"). A text box gets its new value plus the input
  // event its framework listens for. A rich editor gets the beforeinput event it handles itself (Lexical,
  // Slate, CKEditor 5); its page content is never written directly, because the editor's own copy of the
  // text would still hold (and send) what the page then shows as hidden.
  async function insertWithoutCommand(editor, text) {
    if (!editor.isContentEditable) {
      // The browser's own setter, as React expects: its value tracker then sees the input event as a change.
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value").set.call(editor, text);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }));
      return;
    }
    // Like the retry above: an editor that learns the selection only from selectionchange (Lexical) must
    // have seen the new one first, or the replacement lands at its old caret.
    const seen = selectionSeen();
    selectAll(editor);
    await seen;
    await wait(0);
    const init = { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text };
    editor.dispatchEvent(new InputEvent("beforeinput", init));
  }

  // Replaces the chat box's text and resolves true only if it really changed to `text`.
  async function replaceText(editor, text) {
    editing = true;
    try {
      const before = getText(editor);
      selectAll(editor);
      // execCommand is deprecated, but it is still the one edit path that the page's
      // own framework (React, Angular, ProseMirror, Lexical) treats as genuine user input.
      command("insertText", text);
      await settled(editor, before);
      if (sameText(getText(editor), text)) return true;
      // Lexical keeps its own copy of the caret and only updates it from the async
      // selectionchange event, so the first edit can land at the old caret (Perplexity,
      // Kimi). Select everything again, wait until the editor has seen it, replace once more.
      const now = getText(editor);
      const seen = selectionSeen();
      selectAll(editor);
      await seen;
      await wait(0);
      if (sameText(getText(editor), text)) return true;
      command("insertText", text);
      await settled(editor, now);
      if (sameText(getText(editor), text)) return true;
      // Without a working insertText, edit the way the page itself listens for.
      const last = getText(editor);
      await insertWithoutCommand(editor, text);
      await settled(editor, last);
      if (sameText(getText(editor), text)) return true;
    } catch (err) {
      console.warn(LOG, "editing the chat box failed", err);
    } finally {
      editing = false;
    }
    console.warn(LOG, "couldn't edit this chat box");
    return false;
  }

  globalThis.Clotr.editor = {
    realTarget,
    findEditor,
    getText,
    replaceText,
    isEditing: () => editing,
    isChatComposer,
    composerInfo,
  };
})();
