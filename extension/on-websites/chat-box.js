// Finding the chat box and editing it the way the page's own framework expects.
// Classic content script (loaded after on-websites/warning-styles.js, before on-websites/warning-ui.js and on-websites/content.js).
// Shares Clotr.editor.
(() => {
  "use strict";
  const LOG = "[Clotr]";

  // ---------- Finding the chat box ----------

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

  // ---------- What the person typed ----------

  // The text a person has supplied to a chat box, kept only while that draft is in memory.
  const MAX_SOURCE_CHARS = 100000;

  function lastChars(text) {
    return text.length > MAX_SOURCE_CHARS ? text.slice(-MAX_SOURCE_CHARS) : text;
  }

  function sourceInputText(inputType, data, clipboardText) {
    if (/^insert(?:Paragraph|LineBreak)$/i.test(inputType || "")) return "\n";
    if (!/^insert/i.test(inputType || "")) return null;
    if (typeof data === "string" && data) return data;
    if (/^insertFrom(?:Paste|Drop)$/i.test(inputType || "")) {
      return typeof clipboardText === "string" && clipboardText ? clipboardText : null;
    }
    return null;
  }
  function appendSourceText(current, inserted) {
    return lastChars(String(current || "") + String(inserted || ""));
  }
  function removeSourceText(current, removed) {
    const text = String(current || "");
    const part = String(removed || "");
    if (!part) return text;
    const at = text.lastIndexOf(part);
    return at < 0 ? text : text.slice(0, at) + text.slice(at + part.length);
  }
  // How many characters two texts share at the start, and then at the end (never overlapping).
  function sharedEnds(text, box) {
    const most = Math.min(text.length, box.length);
    let same = 0;
    while (same < most && text[same] === box[same]) same++;
    let sameEnd = 0;
    while (sameEnd < most - same && text[text.length - 1 - sameEnd] === box[box.length - 1 - sameEnd]) sameEnd++;
    return { same, sameEnd };
  }

  // An edit at `at` in the box text `before`: removed is what it took out there, inserted what the person
  // supplied. Where the supplied text matches the box up to the edit, or from the edit to the end, the
  // change goes in at that same place, so a fix in the middle of a detail keeps the detail whole. Anywhere
  // else it falls back to removing the last copy and adding the new text at the end.
  function editSourceText(current, before, at, removed, inserted) {
    const text = String(current || "");
    const box = String(before || "");
    const part = String(removed || "");
    const add = String(inserted || "");
    const { same, sameEnd } = sharedEnds(text, box);
    let place = -1;
    if (at + part.length <= same) place = at;
    else if (at >= box.length - sameEnd) place = text.length - (box.length - at);
    if (place < 0) {
      const without = removeSourceText(text, part);
      return add ? appendSourceText(without, add) : without;
    }
    return lastChars(text.slice(0, place) + add + text.slice(place + part.length));
  }

  // ---------- "Everywhere I type": is this really a chat-style composer? ----------
  // Only matters on a page covered by the broad switch, with no dedicated setup of its own: there, Clotr
  // has to tell a message box from an ordinary form field by itself, since nothing names the page in
  // advance.

  // autocomplete values that mark an address, a payment card, a name, an email, a phone number, a username
  // or a password: a box sitting in the same form as one of these is a form field, however many lines it
  // has.
  const FORM_FIELD_AUTOCOMPLETE =
    /^(street-address|address-line[1-3]|address-level[1-4]|postal-code|country(-name)?|organization|cc-[a-z-]+|name|given-name|additional-name|family-name|honorific-(prefix|suffix)|nickname|email|tel(-[a-z-]+)?|username|current-password|new-password)$/i;
  // A nearby control whose label reads like it sends the message, the same wording a built-in AI site's
  // own send button uses, never "post" or "submit" alone on a page that never says "send": comment forms
  // and other ordinary submit buttons don't use this wording, so they're left for the autocomplete check.
  const SEND_LIKE = /\b(send|enviar)\b/i; // English and Spanish, Clotr's two languages

  // A pure decision, so it can be tested without a real page: true only for a multi-line box (never a
  // plain input) that looks like it sends a message and isn't sitting in a form built for someone's name,
  // address, payment details or sign-in.
  function isChatComposer({
    tag,
    hasSendButton = false,
    enterSends = false,
    formAutocompletes = [],
    hasPasswordField = false,
  } = {}) {
    if (tag !== "textarea" && tag !== "contenteditable") return false;
    if (hasPasswordField) return false;
    const formField = (formAutocompletes || []).some((value) =>
      FORM_FIELD_AUTOCOMPLETE.test(String(value || "").trim()),
    );
    if (formField) return false;
    return Boolean(hasSendButton || enterSends);
  }

  // Reads what isChatComposer needs off the real page: the box's own kind, whether its enclosing form (if
  // any) holds a password or one of the form-field autocomplete values, whether a send-labeled control sits
  // within a few levels of it, and whether it's set to send on Enter itself (enterkeyhint, the same attribute
  // phone keyboards read to show a send icon instead of a return arrow).
  // How many parent levels up a send button may sit.
  const SEND_BUTTON_LEVELS = 4;

  function tagOf(editor) {
    if (editor.isContentEditable) return "contenteditable";
    return editor.matches?.("textarea") ? "textarea" : "input";
  }

  // Whether a control other than the box, in this area, is labelled like a send button.
  function hasSendLike(area, editor) {
    for (const button of area.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      if (button === editor || button.contains(editor)) continue;
      const ariaLabel = button.getAttribute("aria-label") || "";
      const title = button.getAttribute("title") || "";
      if (SEND_LIKE.test(`${ariaLabel} ${title} ${button.textContent || ""}`)) return true;
    }
    return false;
  }

  function composerInfo(editor) {
    const tag = tagOf(editor);
    const form = typeof editor.closest === "function" ? editor.closest("form") : null;
    const formAutocompletes = form
      ? [...form.querySelectorAll("[autocomplete]")].map((field) => field.getAttribute("autocomplete") || "")
      : [];
    const hasPasswordField = Boolean(form?.querySelector("input[type='password']"));
    const enterSends = (editor.getAttribute?.("enterkeyhint") || "").toLowerCase() === "send";
    let hasSendButton = false;
    let area = editor;
    for (let level = 0; level < SEND_BUTTON_LEVELS && area?.parentElement && !hasSendButton; level++) {
      area = area.parentElement;
      hasSendButton = hasSendLike(area, editor);
    }
    return { tag, formAutocompletes, hasPasswordField, enterSends, hasSendButton };
  }

  // ---------- Selecting and comparing ----------

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

  // Spaces and invisible characters don't count: some editors keep a zero-width marker of their own at the
  // end of the box and put it back after an edit (Microsoft Copilot does this), so the text differs only by
  // characters nobody sees.
  function plain(text) {
    return text
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sameText(a, b) {
    return plain(a) === plain(b);
  }

  // ---------- The rich box's text, mapped back to its nodes ----------

  const BLOCK_TEXT_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "BLOCKQUOTE",
    "DIV",
    "LI",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TR",
  ]);

  // Several roots' maps joined, a line break between each.
  function joinedTextMap(roots, excludedNodes) {
    let text = "";
    const mapped = [];
    for (const root of roots) {
      const part = richTextMap(root, excludedNodes);
      if (!part.text) continue;
      if (text) {
        text += "\n";
        mapped.push(null);
      }
      text += part.text;
      // One at a time: a long forwarded thread has more positions than a call can take as arguments.
      for (const position of part.positions) mapped.push(position);
    }
    return { text, positions: mapped };
  }

  // The places just before and just after a node, in its parent.
  function pointBefore(node) {
    return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
  }

  function pointAfter(node) {
    return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) + 1 };
  }

  // Builds the same text stream the email check scans, with each character pointing back to its text node.
  function richTextMap(editor, excludedNodes = new Set()) {
    if (Array.isArray(editor)) return joinedTextMap(editor, excludedNodes);
    let raw = "";
    const positions = [];
    function lineBreak(point) {
      if (raw && !raw.endsWith("\n")) {
        raw += "\n";
        positions.push(point);
      }
    }
    function walk(node) {
      if (excludedNodes.has(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || "";
        for (let i = 0; i < value.length; i++) {
          raw += value[i];
          positions.push({ node, offset: i });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        lineBreak(pointAfter(node));
        return;
      }
      const block = BLOCK_TEXT_TAGS.has(node.tagName);
      if (block) lineBreak(pointBefore(node));
      for (const child of node.childNodes) walk(child);
      if (block) lineBreak(pointAfter(node));
    }
    walk(editor);
    return collapseLineBreaks(raw, positions);
  }

  // At most two line breaks in a row, and none at the start or the end, each kept char's place kept.
  function collapseLineBreaks(raw, positions) {
    let text = "";
    const mapped = [];
    for (let i = 0; i < raw.length;) {
      if (raw[i] !== "\n") {
        text += raw[i];
        mapped.push(positions[i]);
        i++;
        continue;
      }
      let end = i + 1;
      while (end < raw.length && raw[end] === "\n") end++;
      for (let j = i; j < Math.min(end, i + 2); j++) {
        text += "\n";
        mapped.push(positions[j]);
      }
      i = end;
    }
    while (text.startsWith("\n")) {
      text = text.slice(1);
      mapped.shift();
    }
    while (text.endsWith("\n")) {
      text = text.slice(0, -1);
      mapped.pop();
    }
    return { text, positions: mapped };
  }

  // ---------- Planning the replacements ----------

  // Where `value` stands in `text`. A pair's third item marks a saved word, which counts only where it
  // stands as a word (cover-values.js wordStarts), never inside a longer one; anything else counts wherever it
  // appears.
  function startsOf(text, value, whole) {
    return globalThis.Clotr.wordStarts(text, String(value), Boolean(whole));
  }

  function replacementSpans(text, pairs) {
    const spans = [];
    const missing = [];
    const seen = new Set();
    for (const [value, replacement, whole] of pairs) {
      const match = String(value);
      if (!match || seen.has(match)) continue;
      seen.add(match);
      let found = false;
      for (const start of startsOf(text, match, whole)) {
        found = true;
        const end = start + match.length;
        if (!spans.some((span) => start < span.end && end > span.start)) {
          spans.push({ start, end, replacement: String(replacement) });
        }
      }
      if (!found) missing.push(match);
    }
    return { spans, missing };
  }

  // ---------- Editing the box ----------

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Resolves once the editor's text differs from `before` (or after `ms`): some editors
  // (Lexical on Kimi) apply an edit a moment after the input event, not straight away.
  async function settled(editor, before, ms = 400) {
    for (let waited = 0; waited < ms && getText(editor) === before; waited += 25) await wait(25);
  }

  // The next selectionchange (or `ms`), so an editor that tracks the selection itself has seen ours.
  function selectionSeen(ms = 150) {
    return new Promise((resolve) => {
      function done() {
        clearTimeout(timer);
        document.removeEventListener("selectionchange", done);
        resolve();
      }
      const timer = setTimeout(done, ms);
      document.addEventListener("selectionchange", done);
    });
  }

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

  function scopedTextMap(scope) {
    const mapped = richTextMap(scope.root, scope.excludedNodes || new Set());
    if (scope.start === undefined || scope.end === undefined) return mapped;
    return {
      text: mapped.text.slice(scope.start, scope.end),
      positions: mapped.positions.slice(scope.start, scope.end),
    };
  }

  // Selects one planned span in the box, from its first character's node to its last, and resolves once the
  // editor has seen the new selection (or after its wait).
  function selectSpan(editor, first, last) {
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    editor.focus();
    const selection = window.getSelection();
    const seenSelection = selectionSeen();
    selection.removeAllRanges();
    selection.addRange(range);
    return seenSelection;
  }

  // After one span's edit: true to go on to the next span, false when the scope's text no longer matches
  // the plan.
  function recordReplacement(state, span) {
    const next = state.expected.slice(0, span.start) + span.replacement + state.expected.slice(span.end);
    const after = scopedTextMap(state).text;
    if (after === state.expected) return true;
    state.expected = next;
    if (state.end !== undefined) state.end += span.replacement.length - (span.end - span.start);
    if (scopedTextMap(state).text !== state.expected) return false;
    return true;
  }

  // Replaces one scope's planned spans, last first, as long as its text still matches the plan.
  async function replaceInScope(editor, state) {
    // Earlier scopes can edit the same root, as an edited email quote can also be forwarded. Plan each
    // scope against the text that's there now instead of its stale snapshot from the start of the send.
    state.expected = scopedTextMap(state).text;
    const plan = replacementSpans(state.expected, state.pairs || []);
    plan.spans.sort((a, b) => b.start - a.start);
    for (const span of plan.spans) {
      const current = scopedTextMap(state);
      if (current.text !== state.expected) break;
      const points = current.positions.slice(span.start, span.end);
      if (points.some((point) => !point?.node)) continue;
      const first = points[0];
      const last = points[points.length - 1];
      const beforeSpan = getText(editor);
      await selectSpan(editor, first, last);
      await wait(0);
      const accepted = command("insertText", span.replacement);
      if (accepted) await settled(editor, beforeSpan);
      else await wait(0);
      if (!recordReplacement(state, span)) break;
    }
  }

  // The values still in the text after the edits, each once.
  function uncoveredValues(states) {
    const uncovered = [];
    for (const scope of states) {
      const text = scopedTextMap(scope).text;
      for (const [value, , whole] of scope.pairs || []) {
        if (value && startsOf(text, value, whole).length && !uncovered.includes(value)) uncovered.push(value);
      }
    }
    return uncovered;
  }

  // Replaces findings in the same DOM parts the email check scanned, preserving every excluded part and
  // format.
  async function replaceMatchesInPlace(editor, scopes) {
    // A caller passing anything but a list of scopes is a bug in Clotr, not a box that won't change, so it
    // says so rather than looking like nothing needed covering.
    if (!Array.isArray(scopes)) throw new TypeError("replaceMatchesInPlace takes a list of scopes");
    if (!editor?.isContentEditable || !scopes.length) return { changed: false, uncovered: [] };
    const before = getText(editor);
    const states = scopes.map((scope) => ({ ...scope, end: scope.end, expected: scopedTextMap(scope).text }));
    editing = true;
    try {
      for (const state of states) {
        try {
          await replaceInScope(editor, state);
        } catch {
          console.warn(LOG, "editing part of the rich message failed");
        }
      }
    } finally {
      editing = false;
    }
    const uncovered = uncoveredValues(states);
    return { changed: getText(editor) !== before, uncovered };
  }

  globalThis.Clotr.editor = {
    realTarget,
    findEditor,
    getText,
    sourceInputText,
    appendSourceText,
    removeSourceText,
    editSourceText,
    MAX_SOURCE_CHARS,
    replaceText,
    replaceMatchesInPlace,
    replacementSpans,
    richTextMap,
    isEditing: () => editing,
    isChatComposer,
    composerInfo,
  };
})();
