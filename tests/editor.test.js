// This tests isChatComposer in extension/editor.js: the pure decision "Everywhere I type" uses to tell a chat
// box from an ordinary form field on a page with no dedicated setup of its own. composerInfo (the DOM-reading
// half) is covered by the e2e suite, where a real page exists to read from.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/editor.js");
const { isChatComposer } = globalThis.Clotr.editor;

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
