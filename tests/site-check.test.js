// tools/site-check.js's pure comparison logic, with fixtures standing in for a browser run or an
// HTTPS probe. No network and no browser here (npm test must stay offline); the real checks run by
// hand with `npm run site-check` and `npm run site-check -- --hosts`.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareToBaseline, diffHosts, hostOf, looksLikeSignIn } = require("../tools/site-check.js");

const AI_OPTS = {
  signInField: "signInRedirect",
  checkEditor: true,
  notCoveredHint: "which Clotr doesn't cover: add it to ai-sites.json",
};
const EVERYDAY_OPTS = {
  signInField: "signInWall",
  checkEditor: false,
  notCoveredHint: "which its own host permission wouldn't cover: check EVERYDAY_SITES in sites.js",
};

test("hostOf: a match pattern's host, wildcard and all", () => {
  assert.equal(hostOf("https://huggingface.co/chat/*"), "huggingface.co");
  assert.equal(hostOf("https://chatgpt.com/*"), "chatgpt.com");
});

test("looksLikeSignIn: an accounts/login host or path, not an ordinary page", () => {
  assert.equal(looksLikeSignIn("https://accounts.google.com/signin/v2"), true);
  assert.equal(looksLikeSignIn("https://outlook.live.com/login"), true);
  assert.equal(looksLikeSignIn("https://chatgpt.com/"), false);
});

test("compareToBaseline: a site that still matches the baseline raises nothing", () => {
  const results = [
    {
      name: "ChatGPT",
      url: "https://chatgpt.com/",
      finalHost: "chatgpt.com",
      covered: true,
      editor: "textarea",
      clotrSees: "yes",
    },
  ];
  const baseline = { "https://chatgpt.com/": { finalHost: "chatgpt.com", editor: "textarea" } };
  assert.deepEqual(compareToBaseline(results, baseline, AI_OPTS), []);
});

test("compareToBaseline: an error short-circuits the rest of that row's checks", () => {
  const results = [{ name: "Grok", url: "https://grok.com/", error: "timeout after 30000ms" }];
  const findings = compareToBaseline(results, {}, AI_OPTS);
  assert.deepEqual(findings, ["**Grok**: couldn't load (timeout after 30000ms)"]);
});

test("compareToBaseline: a host Clotr doesn't cover, not explained by a sign-in wall", () => {
  const results = [
    {
      name: "Arena (LMArena)",
      url: "https://arena.ai/",
      finalHost: "lmarena.ai",
      covered: false,
      signInRedirect: false,
      editor: "none",
    },
  ];
  const findings = compareToBaseline(results, {}, AI_OPTS);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /now ends up at \*\*lmarena\.ai\*\*, which Clotr doesn't cover/);
});

test("compareToBaseline: a sign-in wall is not treated as 'not covered'", () => {
  const results = [
    {
      name: "NotebookLM",
      url: "https://notebooklm.google.com/",
      finalHost: "accounts.google.com",
      covered: false,
      signInRedirect: true,
      editor: "none",
    },
  ];
  assert.deepEqual(compareToBaseline(results, {}, AI_OPTS), []);
});

test("compareToBaseline: a bot check swallows the editor findings but not the coverage one", () => {
  const results = [
    {
      name: "Kimi",
      url: "https://www.kimi.com/",
      finalHost: "www.kimi.com",
      covered: true,
      signInRedirect: false,
      botCheck: true,
      editor: "none",
      clotrSees: "not running",
    },
  ];
  const baseline = { "https://www.kimi.com/": { finalHost: "www.kimi.com", editor: "lexical" } };
  // covered is true, so there is nothing to flag here either: the bot check hides the editor drift.
  assert.deepEqual(compareToBaseline(results, baseline, AI_OPTS), []);
});

test("compareToBaseline: a chat box Clotr no longer sees", () => {
  const results = [
    {
      name: "Perplexity",
      url: "https://www.perplexity.ai/",
      finalHost: "www.perplexity.ai",
      covered: true,
      signInRedirect: false,
      editor: "lexical",
      clotrSees: "no chat box",
    },
  ];
  const findings = compareToBaseline(results, {}, AI_OPTS);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /there's a chat box \(lexical\) but Clotr reports "no chat box"/);
});

test("compareToBaseline: a moved host and a changed editor, both against the baseline", () => {
  const results = [
    {
      name: "Arena (LMArena)",
      url: "https://arena.ai/",
      finalHost: "arena.example.com",
      covered: true,
      signInRedirect: false,
      editor: "prosemirror",
      clotrSees: "yes",
    },
  ];
  const baseline = { "https://arena.ai/": { finalHost: "arena.ai", editor: "textarea" } };
  const findings = compareToBaseline(results, baseline, AI_OPTS);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /moved: arena\.ai → arena\.example\.com/);
  assert.match(findings[1], /editor changed: textarea → prosemirror/);
});

test("compareToBaseline: checkEditor off (everyday sites) never raises an editor finding", () => {
  const results = [
    {
      name: "Discord",
      url: "https://discord.com/channels/@me",
      finalHost: "discord.com",
      covered: true,
      signInWall: false,
      editor: "textarea", // present on the row, but irrelevant with checkEditor: false
      clotrSees: "yes",
    },
  ];
  const baseline = { "https://discord.com/channels/@me": { finalHost: "discord.com", editor: "none" } };
  assert.deepEqual(compareToBaseline(results, baseline, EVERYDAY_OPTS), []);
});

test("compareToBaseline: an everyday app whose host a per-site permission wouldn't cover", () => {
  const results = [
    {
      name: "WhatsApp",
      url: "https://web.whatsapp.com/",
      finalHost: "chat.whatsapp.com",
      covered: false,
      signInWall: false,
    },
  ];
  const findings = compareToBaseline(results, {}, EVERYDAY_OPTS);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /which its own host permission wouldn't cover/);
});

test("compareToBaseline: an everyday app's sign-in wall isn't 'not covered' either", () => {
  const results = [
    {
      name: "Gmail",
      url: "https://mail.google.com/",
      finalHost: "accounts.google.com",
      covered: false,
      signInWall: true,
    },
  ];
  assert.deepEqual(compareToBaseline(results, {}, EVERYDAY_OPTS), []);
});

test("diffHosts: everything still answers as itself raises nothing", () => {
  const results = [
    { name: "ChatGPT", host: "chatgpt.com", finalHost: "chatgpt.com" },
    { name: "Gmail", host: "mail.google.com", finalHost: "mail.google.com" },
  ];
  assert.deepEqual(diffHosts(results), { moved: [], errors: [] });
});

test("diffHosts: a moved host is reported, an error is reported separately", () => {
  const results = [
    { name: "Arena (LMArena)", host: "lmarena.ai", finalHost: "arena.ai" },
    { name: "Pi", host: "pi.ai", error: "ENOTFOUND" },
    { name: "Grok", host: "grok.com", finalHost: "grok.com" },
  ];
  const { moved, errors } = diffHosts(results);
  assert.deepEqual(moved, [{ name: "Arena (LMArena)", host: "lmarena.ai", finalHost: "arena.ai" }]);
  assert.deepEqual(errors, [{ name: "Pi", host: "pi.ai", error: "ENOTFOUND" }]);
});

test("diffHosts: an errored row is never also counted as moved", () => {
  const results = [{ name: "Pi", host: "pi.ai", error: "timed out" }];
  assert.deepEqual(diffHosts(results).moved, []);
});
