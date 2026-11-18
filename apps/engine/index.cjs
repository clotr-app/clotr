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

// A String object (new String(...)), from this realm or another, is read as the text String() gives for it, so its
// own toString or Symbol.toPrimitive counts. If that throws, the text it holds is used. Anything else
// that isn't a string gives undefined. The brand check runs none of the object's own code, so a faked toStringTag
// can't pass. It does look up String, String.prototype.valueOf and Function.prototype.call each time, so a caller who
// replaced one of them gets their version run.
function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  let held;
  try {
    held = String.prototype.valueOf.call(value);
  } catch {
    return undefined;
  }
  try {
    return String(value);
  } catch {
    return held;
  }
}

function detect(input) {
  // Callers' own code can hand over anything; only text has anything to find, so the rest gives [].
  const text = asText(input);
  if (text === undefined) return [];
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
