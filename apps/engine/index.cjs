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
// The engine's own results from the last detect(), so redact() given a copy of them (filtered, say) hides values
// from that same scan. A new scan cut short by the time limit could stop at a different point and find less.
let lastScan = null;

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
  lastScan = { text, found };
  return results;
}

function redact(text, results = []) {
  if (typeof text !== "string" || !Array.isArray(results)) return "";
  // The scan these results came from supplies the engine's own findings; what to hide is always what the array
  // holds now, so a result taken out in place (splice) or a match cleared is left in the text.
  const cached = nativeResults.get(results);
  const scan = cached?.text === text ? cached : lastScan?.text === text ? lastScan : null;
  const selected = new Map(
    results
      .filter((result) => typeof result?.id === "string" && Array.isArray(result.matches))
      .map((result) => [result.id, new Set(result.matches.filter((match) => typeof match === "string"))]),
  );
  const found = (scan ? scan.found : clotr.detect(text))
    .map((result) => ({
      ...result,
      matches: result.matches.filter((match) => selected.get(result.id)?.has(match)),
    }))
    .filter((result) => result.matches.length);
  return clotr.redact(text, found);
}

module.exports = Object.freeze({ detect, redact, PATTERNS });
