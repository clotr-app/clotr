// This tests isChatComposer in extension/editor.js: the pure decision "Everywhere I type" uses to tell a chat
// box from an ordinary form field on a page with no dedicated setup of its own. composerInfo (the DOM-reading
// half) is covered by the e2e suite, where a real page exists to read from.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/editor.js");
const { isChatComposer, replacementSpans } = globalThis.Clotr.editor;

// Just enough of a page to cover text in place: text and element nodes, one selection, and an insertText that
// edits a single text node the way the browser does.
class TextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeName = "#text";
    this.nodeValue = value;
    this.parentNode = null;
  }
  get parentElement() {
    return this.parentNode;
  }
}
class ElementNode {
  constructor(tagName, children = []) {
    this.nodeType = 1;
    this.nodeName = tagName.toUpperCase();
    this.tagName = this.nodeName;
    this.childNodes = children;
    this.parentNode = null;
    this.isContentEditable = true;
    for (const child of children) child.parentNode = this;
  }
  get parentElement() {
    return this.parentNode;
  }
  get innerText() {
    return this.childNodes.map((child) => (child.nodeType === 3 ? child.nodeValue : child.innerText)).join("\n");
  }
  focus() {}
  contains(node) {
    return this === node || this.childNodes.some((child) => child === node || child.contains?.(node));
  }
}

async function withFakePage(fn) {
  const oldGlobals = { Node: globalThis.Node, document: globalThis.document, window: globalThis.window };
  let selected = null;
  const listeners = new Set();
  const range = {
    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset;
    },
    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset;
    },
  };
  const selection = {
    anchorNode: null,
    removeAllRanges() {
      selected = null;
    },
    addRange(value) {
      selected = value;
      this.anchorNode = value.startContainer;
      for (const listener of listeners) listener();
    },
  };
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  globalThis.window = { getSelection: () => selection };
  globalThis.document = {
    createRange: () => Object.create(range),
    addEventListener: (type, listener) => type === "selectionchange" && listeners.add(listener),
    removeEventListener: (type, listener) => type === "selectionchange" && listeners.delete(listener),
    execCommand: (command, _showUI, replacement) => {
      if (command !== "insertText" || !selected || selected.startContainer !== selected.endContainer) return false;
      const text = selected.startContainer;
      text.nodeValue =
        text.nodeValue.slice(0, selected.startOffset) + replacement + text.nodeValue.slice(selected.endOffset);
      return true;
    },
  };

  try {
    return await fn();
  } finally {
    globalThis.Node = oldGlobals.Node;
    globalThis.document = oldGlobals.document;
    globalThis.window = oldGlobals.window;
  }
}

test("email Cover it leaves an identical phone in the Outlook quote untouched", async () => {
  const phone = "555-555-0123";
  const replyText = new TextNode(`Jerry, My number is ${phone}.`);
  const quoteText = new TextNode(`Please write back. Call me at ${phone}.`);
  const reply = new ElementNode("div", [replyText]);
  const quoteBody = new ElementNode("div", [quoteText]);
  const appendMarker = new ElementNode("div");
  const signature = new ElementNode("div", [new ElementNode("p", [new TextNode("Best,")])]);
  const history = new ElementNode("div", [
    new ElementNode("div", [new TextNode("From: Professor Example")]),
    quoteBody,
  ]);
  const spacer = new ElementNode("hr");
  const editor = new ElementNode("div", [reply, appendMarker, spacer, signature, history]);
  new ElementNode("body", [editor]);
  const excluded = new Set([appendMarker, spacer, signature, history]);
  await withFakePage(async () => {
    const { richTextMap } = globalThis.Clotr.editor;
    assert.equal(richTextMap(editor, excluded).text, `Jerry, My number is ${phone}.`);
    const forwardMap = richTextMap([signature, history]);
    assert.equal(forwardMap.text, `${richTextMap(signature).text}\n${richTextMap(history).text}`);
    assert.equal(forwardMap.positions[richTextMap(signature).text.length], null);
    // A long forwarded thread, read as one of the parts: its map is built in a loop, since spreading 200,000
    // positions into one call overflowed the stack and Cover it stopped before changing anything.
    const longThread = new ElementNode("div", [new TextNode("x".repeat(200_000))]);
    new ElementNode("div", [longThread]);
    assert.equal(
      richTextMap([signature, longThread]).positions.length,
      richTextMap(signature).text.length + 1 + 200_000,
    );
    const result = await globalThis.Clotr.editor.replaceMatchesInPlace(editor, [
      { root: editor, excludedNodes: excluded, pairs: [[phone, "[REDACTED PHONE NUMBER]"]] },
    ]);
    assert.equal(result.changed, true);
    assert.match(replyText.nodeValue, /\[REDACTED PHONE NUMBER\]/);
    assert.match(quoteText.nodeValue, new RegExp(phone.replaceAll("-", "\\-")));

    const editedKey = "AKIA4HPQ7XZ2R6TWLJ3N";
    const forwardedKey = "AKIAZ7Q3M9WX2KD5HB8R";
    quoteText.nodeValue = `Edited key ${editedKey}. Forwarded key ${forwardedKey}.`;
    const quoteLength = globalThis.Clotr.editor.richTextMap(quoteBody).text.length;
    const overlapping = await globalThis.Clotr.editor.replaceMatchesInPlace(editor, [
      { kind: "edit", root: quoteBody, start: 0, end: quoteLength, pairs: [[editedKey, "[edited key]"]] },
      { kind: "forwarded", root: quoteBody, pairs: [[forwardedKey, "[forwarded key]"]] },
    ]);
    assert.equal(overlapping.changed, true);
    assert.deepEqual(overlapping.uncovered, []);
    assert.match(quoteText.nodeValue, /\[edited key\]/);
    assert.match(quoteText.nodeValue, /\[forwarded key\]/);
  });
});

// Bandage kept calling with the old { pairs, excluded } shape after the scopes came in, and got "nothing changed" back,
// so a typed number in a Gmail reply stayed (EV18). A wrong shape is Clotr's own bug and has to be loud.
test("in-place covering refuses anything but a list of scopes", async () => {
  const editor = { isContentEditable: true };
  await assert.rejects(
    globalThis.Clotr.editor.replaceMatchesInPlace(editor, {
      pairs: [["555-555-0123", "[phone]"]],
      excluded: new Set(),
    }),
    TypeError,
  );
  assert.deepEqual(await globalThis.Clotr.editor.replaceMatchesInPlace(editor, []), { changed: false, uncovered: [] });
});

test("replacement planning keeps editable matches when another value is outside the editable text", () => {
  const key = "AKIA4HPQ7XZ2R6TWLJ3N";
  const phone = "555-555-0123";
  assert.deepEqual(
    replacementSpans(`Call me at ${phone}.`, [
      [key, "[key]"],
      [phone, "[phone]"],
    ]),
    {
      spans: [{ start: 11, end: 23, replacement: "[phone]" }],
      missing: [key],
    },
  );
});

// A saved word (a pair's third item says so) is swapped only where it stands as a word, so Ann's cover never turns
// Annabelle into "[Me]abelle". Anything else is still swapped wherever it appears.
test("replacement planning swaps a saved word only where it stands as a word", () => {
  const text = "Ann wrote to Annabelle";
  assert.deepEqual(replacementSpans(text, [["Ann", "[Me]", true]]), {
    spans: [{ start: 0, end: 3, replacement: "[Me]" }],
    missing: [],
  });
  assert.deepEqual(replacementSpans("Annabelle wrote", [["Ann", "[Me]", true]]), {
    spans: [],
    missing: ["Ann"],
  });
  assert.equal(replacementSpans(text, [["Ann", "[x]"]]).spans.length, 2);
});

test("in-place covering leaves a saved word inside a longer word, and doesn't call it uncovered", async () => {
  const words = new TextNode("Ann wrote to Annabelle");
  const editor = new ElementNode("div", [new ElementNode("div", [words])]);
  new ElementNode("body", [editor]);
  await withFakePage(async () => {
    const result = await globalThis.Clotr.editor.replaceMatchesInPlace(editor, [
      { kind: "main", root: editor, excludedNodes: new Set(), pairs: [["Ann", "[Me]", true]] },
    ]);
    assert.equal(words.nodeValue, "[Me] wrote to Annabelle");
    assert.deepEqual(result, { changed: true, uncovered: [] });
  });
});

test("isChatComposer: a chat composer, a multi-line box next to a Send button", () => {
  assert.equal(isChatComposer({ tag: "textarea", hasSendButton: true }), true);
  assert.equal(isChatComposer({ tag: "contenteditable", enterSends: true }), true);
});

test("isChatComposer: a support-widget box, enterkeyhint=send but no form at all", () => {
  assert.equal(isChatComposer({ tag: "textarea", enterSends: true, formAutocompletes: [] }), true);
});

test("isChatComposer: a checkout form's address box never qualifies, Send button or not", () => {
  assert.equal(
    isChatComposer({
      tag: "textarea",
      hasSendButton: true,
      formAutocompletes: ["street-address", "postal-code"],
    }),
    false,
  );
});

test("isChatComposer: a sign-up form's box never qualifies, for its own fields or its password", () => {
  assert.equal(
    isChatComposer({ tag: "textarea", hasSendButton: true, formAutocompletes: ["email", "given-name"] }),
    false,
  );
  assert.equal(isChatComposer({ tag: "textarea", hasSendButton: true, hasPasswordField: true }), false);
});

test("isChatComposer: a comment box with a plain Post or Submit button never qualifies", () => {
  assert.equal(isChatComposer({ tag: "textarea", hasSendButton: false, enterSends: false }), false);
});

test("isChatComposer: a search input never qualifies, even with a Send-labelled button nearby", () => {
  assert.equal(isChatComposer({ tag: "input", hasSendButton: true, enterSends: true }), false);
});

test("user input provenance reads edits, paste data, replacement text and bounded deletions", () => {
  const { sourceInputText, appendSourceText, removeSourceText, MAX_SOURCE_CHARS } = globalThis.Clotr.editor;
  assert.equal(sourceInputText("insertText", "Jane", null), "Jane");
  assert.equal(sourceInputText("insertReplacementText", "555-555-5636", null), "555-555-5636");
  assert.equal(sourceInputText("insertFromDictation", "Call me at 555-555-5636", null), "Call me at 555-555-5636");
  assert.equal(sourceInputText("insertFromPaste", null, "Jane\r\n555-555-5636"), "Jane\r\n555-555-5636");
  assert.equal(sourceInputText("insertFromDrop", null, "Jane Doe"), "Jane Doe");
  assert.equal(sourceInputText("insertParagraph", null, null), "\n");
  assert.equal(sourceInputText("deleteContentBackward", null, null), null);

  const entered = appendSourceText("Jane ", "555-555-5636");
  assert.equal(entered, "Jane 555-555-5636");
  assert.equal(removeSourceText(entered, "555-555-5636"), "Jane ");
  assert.equal(appendSourceText("x".repeat(MAX_SOURCE_CHARS), "Jane"), `${"x".repeat(MAX_SOURCE_CHARS - 4)}Jane`);
});

test("user input provenance keeps a fix made in the middle of the text in its place", () => {
  const { editSourceText } = globalThis.Clotr.editor;
  // A digit put back between two others, and a letter fixed inside a name.
  assert.equal(editSourceText("call 555-555-013", "call 555-555-013", 15, "", "2"), "call 555-555-0123");
  assert.equal(editSourceText("Hi, I'm Rwan", "Hi, I'm Rwan", 9, "", "o"), "Hi, I'm Rowan");
  // A wrong digit replaced in place.
  assert.equal(editSourceText("call 555-555-0923", "call 555-555-0923", 14, "9", "1"), "call 555-555-0123");
  // Text the page put in front never joins the stream, and the fix still lands in place after it.
  assert.equal(editSourceText("Rwan", "page text Rwan", 11, "", "o"), "Rowan");
  // Plain typing at the end, and a page-only box, work as before.
  assert.equal(editSourceText("Jane", "Jane", 4, "", " Doe"), "Jane Doe");
  assert.equal(editSourceText("", "page guess", 0, "", "x"), "x");
});
