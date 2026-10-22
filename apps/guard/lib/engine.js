"use strict";
/* global require, module, __dirname */

const fs = require("node:fs");
const vm = require("node:vm");
const { valueFingerprint } = require("./clotrignore.js");
const ENGINE_PATH = require("node:path").join(__dirname, "..", "dist", "clotr-engine.js");

function loadEngine() {
  const context = vm.createContext({});
  const bundle = fs.readFileSync(ENGINE_PATH, "utf8");
  vm.runInContext(bundle, context, { filename: "clotr-engine.js" });
  return context;
}

function findingsFromDetections(context, text, detections, { ignoreSalt, ignoreFingerprints = [] } = {}) {
  const ignored = new Set(
    Array.isArray(ignoreFingerprints) ? ignoreFingerprints.filter((value) => /^[0-9a-f]{64}$/i.test(value)) : [],
  );
  const findings = [];
  for (const detection of detections) {
    let offset = 0;
    for (const value of detection.matches) {
      const fingerprint = valueFingerprint(ignoreSalt, value);
      if (fingerprint && ignored.has(fingerprint)) continue;
      const start = text.indexOf(value, offset);
      const end = start < 0 ? -1 : start + value.length;
      if (start >= 0) offset = end;
      findings.push({
        kind: detection.id,
        label: detection.name,
        severity: detection.severity,
        masked: context.Clotr.mask(value),
        start,
        end,
      });
    }
  }
  return findings;
}

function check(text, { ignoreSalt, ignoreFingerprints = [] } = {}) {
  if (typeof text !== "string") throw new TypeError("text-must-be-a-string");
  const context = loadEngine();
  const detections = context.Clotr.splitOwnIds(context.Clotr.detect(text), {});
  const findings = findingsFromDetections(context, text, detections, { ignoreSalt, ignoreFingerprints });
  return { findings, decision: findings.length ? "block" : "allow" };
}

module.exports = { check, findingsFromDetections, ENGINE_PATH };
