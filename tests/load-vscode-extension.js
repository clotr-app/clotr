"use strict";

// The VS Code extension's own code, for the tests: which files it is, which files ship, and a way to load it
// with stand-ins for VS Code and child_process. Every list here is read from the folder, so a new file is
// checked and shipped without anyone adding it by hand.

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const espree = require("espree");

const APP = path.join(__dirname, "..", "apps", "vscode");

// ---------- The code files ----------

// Folders that hold no code of the extension's own: build.js writes guard/ before packaging.
const NOT_OWN_CODE = new Set(["guard", "node_modules"]);

// Every .js file of the extension's own, relative to its folder with forward slashes. build.js runs before
// packaging and never ships.
function codeFiles(root = APP) {
  return walk(root, root)
    .filter((file) => file.endsWith(".js") && file !== "build.js")
    .sort();
}

function walk(root, folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && NOT_OWN_CODE.has(entry.name) && folder === root) return [];
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return walk(root, full);
    return [path.relative(root, full).split(path.sep).join("/")];
  });
}

// All the code files' text, one after the other, for checks that look for a line wherever it lives.
function codeSource(root = APP) {
  return codeFiles(root)
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
}

// ---------- What ships ----------

// The files .vscodeignore lets into the package, apart from guard/ and LICENSE, which build.js writes.
// .vscodeignore starts with "**" and lets files back in with "!": the last pattern that names a file decides.
function shippedFiles(root = APP) {
  const patterns = fs
    .readFileSync(path.join(root, ".vscodeignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const built = (file) => file === "LICENSE" || file.startsWith("guard/");
  return walk(root, root)
    .filter((file) => !built(file) && ships(file, patterns))
    .sort();
}

function ships(file, patterns) {
  let shipped = true;
  for (const pattern of patterns) {
    const allow = pattern.startsWith("!");
    if (namedBy(file, allow ? pattern.slice(1) : pattern)) shipped = allow;
  }
  return shipped;
}

// The pattern shapes .vscodeignore uses: "**", "name", "folder/" and "folder/**". Any other shape fails loudly,
// so a new one gets matched on purpose rather than by accident.
function namedBy(file, pattern) {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (/[*?[\]{}]/.test(pattern)) throw new Error(`.vscodeignore pattern this helper doesn't read: ${pattern}`);
  return file === pattern;
}

// Copies the shipped files into a folder, making the folders they sit in.
function copyShippedFiles(target, root = APP) {
  for (const file of shippedFiles(root)) {
    const destination = path.join(target, ...file.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, ...file.split("/")), destination);
  }
}

// ---------- Loading it ----------

function inside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

// Loads extension.js and returns its exports. Every code file of the extension's own is loaded fresh, and gets
// `vscode` and, when given, `childProcess` for its require("vscode") and require("child_process"). Guard's files
// and the JSON files come through Node's own require, as before. With `contained`, a require that leaves the
// folder throws, as it would for someone who installed the package.
function loadVscodeExtension({ root = APP, vscode, childProcess, contained = false }) {
  const loaded = new Map();
  const guardFolder = path.join(root, "guard");
  const ownCode = (file) => file.endsWith(".js") && inside(root, file) && !inside(guardFolder, file);

  function load(file) {
    if (loaded.has(file)) return loaded.get(file).exports;
    const fileModule = new Module(file, module);
    fileModule.filename = file;
    fileModule.paths = Module._nodeModulePaths(path.dirname(file));
    loaded.set(file, fileModule);
    fileModule.require = (request) => requireFrom(fileModule, request);
    fileModule._compile(fs.readFileSync(file, "utf8"), file);
    fileModule.loaded = true;
    return fileModule.exports;
  }

  function requireFrom(parent, request) {
    if (request === "vscode") return vscode;
    if (childProcess && (request === "child_process" || request === "node:child_process")) return childProcess;
    if (Module.isBuiltin(request)) return require(request);
    const resolved = Module._resolveFilename(request, parent);
    if (contained && !inside(root, resolved)) throw new Error(`Extension dependency escaped its folder: ${request}`);
    if (ownCode(resolved)) return load(resolved);
    return require(resolved);
  }

  return withContainedRequires(root, vscode, contained, () => load(path.join(root, "extension.js")));
}

// While the package loads, a require from any file in it (Guard's too) that leaves the folder throws.
function withContainedRequires(root, vscode, contained, run) {
  if (!contained) return run();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (Module.isBuiltin(request)) return originalLoad.call(this, request, parent, isMain);
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (inside(root, parent?.filename || "") && !inside(root, resolved)) {
      throw new Error(`Extension dependency escaped its folder: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
}

// ---------- What the code says about itself ----------

function parse(root, file) {
  return espree.parse(fs.readFileSync(path.join(root, file), "utf8"), { ecmaVersion: "latest", loc: true });
}

// Each require(...) call in a file, with whether it sits inside a function.
function requireCalls(root, file) {
  const calls = [];
  const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  function visit(node, inFunction) {
    if (!node || typeof node.type !== "string") return;
    const isRequire = node.type === "CallExpression" && node.callee.type === "Identifier";
    if (isRequire && node.callee.name === "require") {
      const argument = node.arguments[0];
      const request = argument && argument.type === "Literal" ? argument.value : null;
      calls.push({ request, line: node.loc.start.line, inFunction });
    }
    const nextInFunction = inFunction || functionTypes.has(node.type);
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, nextInFunction));
      else if (value && typeof value.type === "string") visit(value, nextInFunction);
    }
  }
  visit(parse(root, file), false);
  return calls;
}

// The code files extension.js reaches through relative requires, itself included.
function reachedFiles(root = APP) {
  const reached = new Set();
  const pending = ["extension.js"];
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { request } of requireCalls(root, file)) {
      if (typeof request !== "string" || !request.startsWith(".")) continue;
      const target = path.join(root, path.dirname(file), request);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (relative.endsWith(".js") && !relative.startsWith("guard/")) pending.push(relative);
    }
  }
  return [...reached].sort();
}

module.exports = {
  APP,
  codeFiles,
  codeSource,
  shippedFiles,
  copyShippedFiles,
  loadVscodeExtension,
  requireCalls,
  reachedFiles,
};
