// Holds apps/engine/docs/how-it-works.md to the code it describes: the files and functions it names, the order of the
// steps in detectWindow(), the window, overlap and clock numbers, the sections of extension/patterns.js in order, the
// example rule, and its length.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../extension/patterns.js");

const ROOT = path.join(__dirname, "..");
const PAGE = path.join(ROOT, "apps", "engine", "docs", "how-it-works.md");
const DETECTOR = path.join(ROOT, "extension", "detector.js");
const MAX_LINES = 150;

const page = () => (fs.existsSync(PAGE) ? fs.readFileSync(PAGE, "utf8") : "");
const lines = (text) => text.split(/\r?\n/);

// The lines under the "## " heading that starts with `title`, up to the next "## " heading.
function section(text, title) {
  const all = lines(text);
  const at = all.findIndex((line) => line.startsWith(`## ${title}`));
  if (at < 0) return null;
  const end = all.findIndex((line, i) => i > at && line.startsWith("## "));
  return all.slice(at + 1, end < 0 ? all.length : end);
}

// Words in code spans and code blocks that look like a path in the repo: a folder and a file with an extension, or a
// folder ending in "/".
const PATH = /^[\w.-]+(?:\/[\w.-]+)*\/(?:[\w.-]+\.\w+)?$/;
function namedPaths(text) {
  const blocks = [...text.matchAll(/```\w*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const spans = [...text.replace(/```\w*\n[\s\S]*?```/g, "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return [...blocks, ...spans].flatMap((code) => code.split(/\s+/)).filter((word) => PATH.test(word));
}

// A function declared at the top of the file, or at the top of the one arrow function a classic script wraps itself
// in, the way extension/patterns.js and extension/detector.js do.
function isTopLevelFunction(source, name) {
  const wrapped = /^\(\(\) => \{$/m.test(source);
  const indent = wrapped ? "(?:|  )" : "";
  return new RegExp(`^${indent}(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`, "m").test(source);
}

// The text of a top-level function in a wrapped classic script, from its "function" line to its closing brace.
function functionBody(source, name) {
  const at = new RegExp(`^  function ${name}\\(`, "m").exec(source)?.index;
  if (at === undefined) return "";
  const end = /\n {2}\}\r?\n/.exec(source.slice(at));
  return source.slice(at, end ? at + end.index : source.length);
}

// Where `name(` is first called in `body`, or -1.
const callAt = (body, name) => body.search(new RegExp(`(?<![\\w$.])${name}\\(`));

// The value of `const NAME = 40 * 1024;` in the source, for a product of plain numbers.
function constant(source, name) {
  const expr = new RegExp(`^\\s*const ${name} = ([\\d_ *]+);`, "m").exec(source)?.[1];
  assert.ok(expr, `no plain number for ${name} in extension/detector.js`);
  return expr.split("*").reduce((product, n) => product * Number(n.replace(/_/g, "")), 1);
}

test("the how-it-works page exists and fits in 150 lines", () => {
  const text = page();
  assert.ok(text, "missing apps/engine/docs/how-it-works.md");
  const count = lines(text.replace(/\r?\n$/, "")).length;
  assert.ok(count <= MAX_LINES, `the page has ${count} lines, more than ${MAX_LINES}`);
});

test("every file path the page names exists", () => {
  const text = page();
  const paths = namedPaths(text);
  assert.ok(paths.length > 0, "the page names no file");
  const links = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z]+:/i.test(target))
    .map((target) => path.relative(ROOT, path.resolve(path.dirname(PAGE), target)).replaceAll(path.sep, "/"));
  const missing = [...new Set([...paths, ...links])].filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(missing, [], "paths the page names that don't exist");
});

test("every function the page names is a top-level function in the file it names beside it", () => {
  const text = page();
  const calls = [...text.matchAll(/`[A-Za-z_$][\w$]*\(\)`/g)];
  const pairs = [...text.matchAll(/`([A-Za-z_$][\w$]*)\(\)`\s+in\s+`([^`]+)`/g)].map((m) => ({
    name: m[1],
    file: m[2],
  }));
  assert.ok(pairs.length > 0, "the page names no function");
  assert.equal(calls.length, pairs.length, "each `name()` on the page is followed by in `its file`");
  const wrong = pairs
    .filter(({ name, file }) => {
      const full = path.join(ROOT, file);
      return !fs.existsSync(full) || !isTopLevelFunction(fs.readFileSync(full, "utf8"), name);
    })
    .map(({ name, file }) => `${name}() in ${file}`);
  assert.deepEqual(wrong, [], "functions that aren't top-level functions in the file the page names");
});

test("the page lists the sections of extension/patterns.js, in order", () => {
  const source = fs.readFileSync(path.join(ROOT, "extension", "patterns.js"), "utf8");
  const headings = [...source.matchAll(/^\s*\/\/ -{10} (.+?) -{10}\s*$/gm)].map((m) => m[1]);
  const part = section(page(), "The sections of");
  assert.ok(part, 'no "## The sections of" heading on the page');
  const listed = part.map((line) => /^\d+\. `([^`]+)`/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(listed, headings);
});

test("the example rule is a real rule, written as the table has it", () => {
  const part = section(page(), "What one rule is made of");
  assert.ok(part, 'no "## What one rule is made of" heading on the page');
  const text = part.join("\n");
  const block = /```js\n([\s\S]*?)\n```/.exec(text)?.[1];
  assert.ok(block, "no js code block in that section");
  const id = /\bid: "([^"]+)"/.exec(block)?.[1];
  const ids = globalThis.Clotr.PATTERNS.map((rule) => rule.id);
  assert.ok(ids.includes(id), `the example rule's id ${id} isn't a built-in rule`);
  const trim = (s) => lines(s).map((line) => line.trim());
  const shown = trim(block).filter(Boolean).join("\n");
  const source = trim(fs.readFileSync(path.join(ROOT, "extension", "patterns.js"), "utf8")).join("\n");
  assert.ok(source.includes(shown), "the example rule differs from its entry in extension/patterns.js");
});

test("the steps under detectWindow() are in the order the code calls them", () => {
  const part = section(page(), "The path a message takes");
  assert.ok(part, 'no "## The path a message takes" heading on the page');
  const from = part.findIndex((line) => /^\d+\. `detectWindow\(\)`/.test(line));
  assert.ok(from >= 0, "no numbered step for detectWindow() on the page");
  const to = part.findIndex((line, i) => i > from && /^\d+\. /.test(line));
  const steps = part.slice(from + 1, to < 0 ? part.length : to).join("\n");
  const named = [...steps.matchAll(/`([A-Za-z_$][\w$]*)\(\)`\s+in\s+`extension\/detector\.js`/g)].map((m) => m[1]);
  const listed = [...new Set(named)];
  assert.ok(listed.length > 1, "the detectWindow() step names fewer than two detector.js functions");
  const source = fs.readFileSync(DETECTOR, "utf8");
  const body = functionBody(source, "detectWindow");
  // A function the window calls through the step before it, like withoutPhoneDots() in secondReading(), takes that
  // step's place.
  const placed = [];
  for (const name of listed) {
    let at = callAt(body, name);
    const caller = placed.at(-1);
    if (at < 0 && caller && callAt(functionBody(source, caller.name), name) >= 0) at = caller.at;
    assert.ok(at >= 0, `${name}() isn't called in detectWindow() or in the step before it`);
    placed.push({ name, at });
  }
  const called = [...placed].sort((a, b) => a.at - b.at).map((step) => step.name);
  assert.deepEqual(listed, called, "the page's steps, against the order detectWindow() calls them");
});

test("the page's window, overlap and clock numbers are the code's", () => {
  const source = fs.readFileSync(DETECTOR, "utf8");
  const chars = (n) => `${n.toLocaleString("en-US")} characters`;
  const windowChars = chars(constant(source, "DETECT_WINDOW_CHARS"));
  const overlapChars = chars(constant(source, "DETECT_WINDOW_OVERLAP"));
  const clock = `${constant(source, "DETECT_BACKSTOP_MS") / 1000}-second clock`;
  const part = section(page(), "The path a message takes");
  assert.ok(part, 'no "## The path a message takes" heading on the page');
  const text = part.join(" ").replace(/\s+/g, " ");
  for (const phrase of [`up to ${windowChars}`, `windows of ${windowChars}`, `overlap by ${overlapChars}`, clock]) {
    assert.ok(text.includes(phrase), `the page doesn't say "${phrase}"`);
  }
  const numbers = [...text.matchAll(/[\d,.]+(?: characters|-second clock)/g)].map((m) => m[0]);
  const other = numbers.filter((n) => ![windowChars, overlapChars, clock].includes(n));
  assert.deepEqual(other, [], "numbers on the page that aren't the code's");
});

test("the second-reading step names the rules that skip it", () => {
  const skipping = globalThis.Clotr.PATTERNS.filter((rule) => rule.find?.fromVault).map((rule) => rule.id);
  assert.ok(skipping.length > 0, "no built-in rule's find is marked fromVault");
  const part = section(page(), "The path a message takes");
  assert.ok(part, 'no "## The path a message takes" heading on the page');
  const from = part.findIndex((line) => /^\s+\d+\. `secondReading\(\)`/.test(line));
  assert.ok(from >= 0, "no numbered step for secondReading() on the page");
  const to = part.findIndex((line, i) => i > from && /^\s*\d+\. /.test(line));
  const step = part.slice(from, to < 0 ? part.length : to).join(" ");
  assert.match(step, /\bskip/, "the secondReading() step doesn't say which rules skip it");
  const unnamed = skipping.filter((id) => !step.includes(`\`${id}\``));
  assert.deepEqual(unnamed, [], "rules marked fromVault that the secondReading() step doesn't name");
});
