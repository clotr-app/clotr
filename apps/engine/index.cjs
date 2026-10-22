"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const packageDir = path.dirname(require.resolve("./package.json"));
const sandbox = vm.createContext({ console: Object.freeze({ info() {} }) });
const bundle = fs.readFileSync(path.join(packageDir, "dist", "clotr-engine.js"), "utf8");
vm.runInContext(bundle, sandbox, { filename: "clotr-engine.js" });
const clotr = vm.runInContext("globalThis.Clotr", sandbox);
const nativeResults = new WeakMap();

const PATTERNS = Object.freeze(
  clotr.PATTERNS.map(({ id, group, name, severity }) => Object.freeze({ id, group, name, severity })),
);

function detect(text) {
  const found = clotr.detect(text);
  const results = found.map(({ id, group, name, severity, matches, asks }) => ({
    id,
    group,
    name,
    severity,
    matches: [...matches],
    ...(asks ? { asks: [...asks] } : {}),
  }));
  if (found.truncated) results.truncated = true;
  nativeResults.set(results, { text, found });
  return results;
}

function redact(text, results = []) {
  if (typeof text !== "string" || !Array.isArray(results)) return "";
  const cached = nativeResults.get(results);
  if (cached?.text === text) return clotr.redact(text, cached.found);

  const selected = new Map(
    results
      .filter((result) => typeof result?.id === "string" && Array.isArray(result.matches))
      .map((result) => [result.id, new Set(result.matches.filter((match) => typeof match === "string"))]),
  );
  const found = clotr
    .detect(text)
    .map((result) => ({
      ...result,
      matches: result.matches.filter((match) => selected.get(result.id)?.has(match)),
    }))
    .filter((result) => result.matches.length);
  return clotr.redact(text, found);
}

module.exports = Object.freeze({ detect, redact, PATTERNS });
