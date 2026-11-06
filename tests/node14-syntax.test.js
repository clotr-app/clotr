"use strict";

// The VS Code extension declares engines.vscode ^1.57.0, whose extension host is Node 14. Everything it loads (the
// engine bundle, Guard's bin and lib, the extension's own files) must parse and run there, so this parses each one as
// ES2021 (what Node 14 reads, logical assignment aside) and looks through the tree for newer syntax and for calls to
// methods Node 14 doesn't have. A plain text search would miss a regex flag or a class static block; a parse can't.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const espree = require("espree");
const { build } = require("../tools/engine-bundle.js");

const ROOT = path.join(__dirname, "..");
const LOADED = [
  "apps/guard/bin/clotr-guard.js",
  ...fs
    .readdirSync(path.join(ROOT, "apps", "guard", "lib"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `apps/guard/lib/${name}`),
  "apps/vscode/extension.js",
  "apps/vscode/ignore-once.js",
];

// Methods newer than Node 14, called as `x.name(...)`.
const NEWER_METHODS = new Set([
  "at",
  "findLast",
  "findLastIndex",
  "replaceAll",
  "toSorted",
  "toReversed",
  "toSpliced",
  "group",
  "groupBy",
  "groupToMap",
]);
const NEWER_STATICS = new Set(["Object.hasOwn", "Promise.any", "Object.groupBy", "Map.groupBy", "Array.fromAsync"]);
const NEWER_GLOBALS = new Set(["structuredClone", "AggregateError"]);

function memberName(node) {
  if (node.type !== "MemberExpression" || node.computed) return null;
  const object = node.object.type === "Identifier" ? node.object.name : null;
  return { object, property: node.property.name };
}

function problems(text) {
  let ast;
  try {
    // A bin's #! line is for the shell; Node skips it.
    ast = espree.parse(text.replace(/^#!/, "//"), { ecmaVersion: 2021, sourceType: "script", loc: true });
  } catch (error) {
    return [`line ${error.lineNumber}: doesn't parse as ES2021 (${error.message})`];
  }
  const found = [];
  const at = (node, what) => found.push(`line ${node.loc.start.line}: ${what}`);
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "AssignmentExpression" && /^(?:\?\?|\|\||&&)=$/.test(node.operator)) {
      at(node, `logical assignment ${node.operator}`);
    }
    if (node.type === "Literal" && node.regex && /[dv]/.test(node.regex.flags)) {
      at(node, `regex flag in /${node.regex.flags}/`);
    }
    if (node.type === "CallExpression") {
      const name = memberName(node.callee);
      if (name && NEWER_METHODS.has(name.property)) at(node, `.${name.property}()`);
      if (name && NEWER_STATICS.has(`${name.object}.${name.property}`)) at(node, `${name.object}.${name.property}()`);
    }
    if (node.type === "Identifier" && NEWER_GLOBALS.has(node.name)) at(node, node.name);
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      /Error$/.test(node.callee.name) &&
      node.arguments[1] &&
      node.arguments[1].type === "ObjectExpression" &&
      node.arguments[1].properties.some((p) => p.key && (p.key.name === "cause" || p.key.value === "cause"))
    ) {
      at(node, "Error cause");
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === "string") walk(value);
    }
  })(ast);
  return found;
}

test("the engine bundle uses nothing newer than VS Code 1.57's Node 14 host", () => {
  assert.deepEqual(problems(build().text), []);
});

for (const file of LOADED) {
  test(`${file} uses nothing newer than VS Code 1.57's Node 14 host`, () => {
    assert.deepEqual(problems(fs.readFileSync(path.join(ROOT, file), "utf8")), []);
  });
}

test("the Node 14 check finds what it's looking for", () => {
  assert.equal(problems("a ??= 1;").length, 1);
  assert.equal(problems("x.at(-1);").length, 1);
  assert.equal(problems("Object.hasOwn(a, 'b');").length, 1);
  assert.equal(problems("/a/d;").length, 1);
  assert.equal(problems("class A { static { } }").length, 1);
  assert.equal(problems("new Error('x', { cause: e });").length, 1);
  assert.deepEqual(problems("a ?? b; a?.b; 1_000; x.slice(-1);"), []);
});
