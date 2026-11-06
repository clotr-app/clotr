"use strict";
/* global require, module, __dirname */

const fs = require("fs");
const vm = require("vm");
const { valueFingerprint } = require("./clotrignore.js");
const ENGINE_PATH = require("path").join(__dirname, "..", "dist", "clotr-engine.js");

// One engine per process: loading it costs tens of milliseconds and a warm check well under one, so the MCP server,
// a commit check's many files and VS Code's copy of Guard all reuse the first load. The engine keeps no text between
// checks beyond its own last-answer cache. Its only log line (a scan that ran out of time) goes nowhere.
let engine;
function engineContext() {
  if (!engine) {
    const context = vm.createContext({ console: Object.freeze({ info() {} }) });
    vm.runInContext(fs.readFileSync(ENGINE_PATH, "utf8"), context, { filename: "clotr-engine.js" });
    engine = context;
  }
  return engine;
}

// Where each distinct value first sits in the text, or -1. Values that share a length are looked for together, in one
// pass over the text with a rolling hash, so tens of thousands of them cost a few passes rather than a search from the
// start for each: that search took about 25 seconds for a megabyte of email addresses, past a hook's timeout. A
// length only a few values have is searched for directly.
const FEW_OF_A_LENGTH = 4;
const HASH_BASE = 0x01000193;
function firstPlaces(text, values) {
  const first = new Map();
  const byLength = new Map();
  for (const value of values) {
    const group = byLength.get(value.length);
    if (group) group.push(value);
    else byLength.set(value.length, [value]);
  }
  for (const [length, group] of byLength) {
    if (group.length < FEW_OF_A_LENGTH || length > text.length) {
      for (const value of group) first.set(value, text.indexOf(value));
      continue;
    }
    const hashOf = (value) => {
      let hash = 0;
      for (let i = 0; i < length; i += 1) hash = (Math.imul(hash, HASH_BASE) + value.charCodeAt(i)) | 0;
      return hash;
    };
    const byHash = new Map();
    // A quick first look before the map: most places in the text start no value.
    const seen = new Uint8Array(65536);
    for (const value of group) {
      const hash = hashOf(value);
      seen[hash & 0xffff] = 1;
      const same = byHash.get(hash);
      if (same) same.push(value);
      else byHash.set(hash, [value]);
      first.set(value, -1);
    }
    let power = 1;
    for (let i = 1; i < length; i += 1) power = Math.imul(power, HASH_BASE);
    let left = group.length;
    let hash = hashOf(text.slice(0, length));
    for (let at = 0; ; at += 1) {
      if (seen[hash & 0xffff]) {
        for (const value of byHash.get(hash) || []) {
          if (first.get(value) < 0 && text.startsWith(value, at)) {
            first.set(value, at);
            left -= 1;
          }
        }
      }
      if (!left || at + length >= text.length) break;
      hash =
        (Math.imul((hash - Math.imul(text.charCodeAt(at), power)) | 0, HASH_BASE) + text.charCodeAt(at + length)) | 0;
    }
  }
  return first;
}

// Prefix maxima over the text's places with point updates (a Fenwick tree): the furthest end of any place taken that
// starts at or before a given place, so whether a copy sits inside a place already taken is a short walk, not a look at
// every place taken.
function takenEnds(size) {
  const tree = new Int32Array(size + 1);
  return {
    add(start, end) {
      for (let i = start + 1; i <= size; i += i & -i) if (tree[i] < end) tree[i] = end;
    },
    furthestFrom(start) {
      let furthest = 0;
      for (let i = start + 1; i > 0; i -= i & -i) if (tree[i] > furthest) furthest = tree[i];
      return furthest;
    },
  };
}

// Past this much searching for later copies (a multiple of the text's length), a value takes the best copy found so
// far: where a finding sits only names the line a commit check reports, and the check must answer on time.
const PLACE_SEARCH_FACTOR = 64;
// What one search for a value's next copy costs, beyond the characters it moves past: it compares the value's whole
// length again at the copy it finds (in text that repeats, copies overlap one character apart, so this is most of the
// work), and the step itself, the copy kept and the lookups around it, counted as this many characters. The last also
// bounds how many copies are kept: tens of millions of them took most of a gigabyte.
const PLACE_STEP_COST = 32;

// Each match's place in the text. The engine lists a kind's matches in the order its readings found them, not the
// order they sit in the text, and one value can also sit inside a longer one, like a password inside a connection
// string. A commit check reports the line a finding starts on, so longer values are placed first and each value
// takes its first copy that isn't inside a place already taken (or overlapping an earlier report of the same value);
// failing that, its first copy no earlier report of the same value has taken; failing that, its first copy.
// A copy ruled out stays ruled out, since places are only ever added, so each value's copies are found once, in order,
// and each later report of it carries on from where the one before stopped.
function placesOf(text, values) {
  const starts = values.map(() => -1);
  const distinct = [...new Set(values.filter(Boolean))];
  const first = firstPlaces(text, distinct);
  const copiesOf = new Map();
  for (const value of distinct) {
    const at = first.get(value);
    // copies: the places found so far; free and fresh: the first copy each search hasn't ruled out yet; taken: the
    // starts of this value's own places, in order.
    copiesOf.set(value, { copies: at >= 0 ? [at] : [], done: at < 0, free: 0, fresh: 0, taken: [] });
  }
  const ends = takenEnds(text.length);
  let searchLeft = PLACE_SEARCH_FACTOR * text.length + 1_000_000;
  const copyAt = (record, value, index) => {
    while (index >= record.copies.length && !record.done) {
      const last = record.copies[record.copies.length - 1];
      const next = searchLeft > 0 ? text.indexOf(value, last + 1) : -1;
      searchLeft -= (next < 0 ? text.length : next) - last + value.length + PLACE_STEP_COST;
      if (next < 0) record.done = true;
      else record.copies.push(next);
    }
    return index < record.copies.length ? record.copies[index] : -1;
  };
  // Whether a copy at `at` overlaps one of this value's own places: one starting less than its length either side.
  const overlapsOwn = (record, at, length) => {
    const { taken } = record;
    let low = 0;
    let high = taken.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (taken[middle] <= at - length) low = middle + 1;
      else high = middle;
    }
    return low < taken.length && taken[low] < at + length;
  };
  const order = values.map((_, i) => i).sort((a, b) => values[b].length - values[a].length || a - b);
  for (const i of order) {
    const value = values[i];
    if (!value) {
      starts[i] = 0;
      continue;
    }
    const record = copiesOf.get(value);
    const length = value.length;
    let at = copyAt(record, value, record.free);
    while (at >= 0 && (overlapsOwn(record, at, length) || ends.furthestFrom(at) >= at + length)) {
      record.free += 1;
      at = copyAt(record, value, record.free);
    }
    if (at < 0) {
      at = copyAt(record, value, record.fresh);
      while (at >= 0 && overlapsOwn(record, at, length)) {
        record.fresh += 1;
        at = copyAt(record, value, record.fresh);
      }
    }
    if (at < 0 && record.copies.length) at = record.copies[0];
    if (at >= 0) {
      ends.add(at, at + length);
      let place = record.taken.length;
      while (place > 0 && record.taken[place - 1] > at) place -= 1;
      record.taken.splice(place, 0, at);
    }
    starts[i] = at;
  }
  return starts;
}

function findingsFromDetections(context, text, detections, { ignoreSalt, ignoreFingerprints = [] } = {}) {
  const ignored = new Set(
    Array.isArray(ignoreFingerprints) ? ignoreFingerprints.filter((value) => /^[0-9a-f]{64}$/i.test(value)) : [],
  );
  const kept = [];
  for (const detection of detections) {
    for (const value of detection.matches) {
      const fingerprint = valueFingerprint(ignoreSalt, value);
      if (!(fingerprint && ignored.has(fingerprint))) kept.push({ detection, value });
    }
  }
  const starts = placesOf(
    text,
    kept.map(({ value }) => value),
  );
  return kept.map(({ detection, value }, i) => ({
    kind: detection.id,
    label: detection.name,
    severity: detection.severity,
    masked: context.Clotr.mask(value),
    start: starts[i],
    end: starts[i] < 0 ? -1 : starts[i] + value.length,
  }));
}

// One engine run over the text: detect()'s own results, and whether its time limit cut the scan short. Anything that
// lists findings and then hides them passes this one run to check(), so what it lists and what it hides come from
// the same scan: two scans cut short can stop at different points.
function scan(text) {
  if (typeof text !== "string") throw new TypeError("text-must-be-a-string");
  const found = engineContext().Clotr.detect(text);
  // The flag sits on detect()'s own array, so it's read before anything maps or filters that array away.
  return { text, found, truncated: found.truncated === true };
}

function check(text, { ignoreSalt, ignoreFingerprints = [], scanned } = {}) {
  if (typeof text !== "string") throw new TypeError("text-must-be-a-string");
  const context = engineContext();
  const { found, truncated } = scanned?.text === text ? scanned : scan(text);
  const detections = context.Clotr.splitOwnIds(found, {});
  const findings = findingsFromDetections(context, text, detections, { ignoreSalt, ignoreFingerprints });
  // A scan cut short didn't check the rest of the text, which could hold anything, so it isn't called clean.
  return {
    findings,
    decision: findings.length || truncated ? "block" : "allow",
    ...(truncated ? { truncated: true } : {}),
  };
}

// The personal details that wait behind the personal-details option, shared by the hooks, the commit check and the
// MCP server: every kind the engine groups as personal (a driver's licence, a medical record number, a public IP), and
// the older names a caller may still pass. Card, gift-card and bank numbers sit in that group too, but they're money,
// so they stay checked like a credential.
const PERSONAL_KIND_WORDS =
  /email|phone|person|name|address|ssn|social|passport|license.?plate|national.?id|account.?id|student.?id|birth|dob|vin|ip.?address/i;
const MONEY_KINDS = new Set(["credit_card", "card_code", "gift_card", "bank_account"]);
let personalKinds;
function isPersonalKind(kind) {
  if (typeof kind !== "string") return false;
  if (!personalKinds) {
    personalKinds = new Set(
      engineContext()
        .Clotr.PATTERNS.filter((pattern) => pattern.group === "personal" && !MONEY_KINDS.has(pattern.id))
        .map((pattern) => pattern.id),
    );
  }
  return personalKinds.has(kind) || PERSONAL_KIND_WORDS.test(kind);
}

module.exports = { check, scan, findingsFromDetections, engineContext, isPersonalKind, ENGINE_PATH };
