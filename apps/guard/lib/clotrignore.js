"use strict";
/* global Buffer, require, module */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 8192;
const MAX_PATTERN_LENGTH = 1024;
const EMPTY = Object.freeze({ valid: true, salt: null, fingerprints: new Set(), rules: [], reason: null, content: "" });

function valueFingerprint(salt, value) {
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/i.test(salt) || typeof value !== "string" || !value) return "";
  return crypto.createHash("sha256").update(salt.toLowerCase()).update("\0").update(value, "utf8").digest("hex");
}

// A rule compiles to steps that globMatches walks as a set of states, one character at a time, so its time grows with
// the path times the rule. A regex built from the rule backtracked instead, and a rule full of stars took minutes.
function globSteps(pattern) {
  const steps = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      steps.push({ type: "char", value: pattern[++index] });
    } else if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          steps.push({ type: "folders" });
          index += 1;
        } else steps.push({ type: "anything" });
      } else steps.push({ type: "star" });
    } else if (character === "?") steps.push({ type: "one" });
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      const body = end < 0 ? "" : pattern.slice(index + 1, end);
      if (end < 0 || /^[!^-]/.test(body) || body.includes("/")) steps.push({ type: "char", value: "[" });
      else {
        steps.push({ type: "set", ranges: classRanges(body) });
        index = end;
      }
    } else steps.push({ type: "char", value: character });
  }
  return steps;
}

function classRanges(body) {
  const ranges = [];
  for (let index = 0; index < body.length; index += 1) {
    const low = body.charCodeAt(index);
    if (body[index + 1] === "-" && index + 2 < body.length) {
      const high = body.charCodeAt(index + 2);
      if (low > high) throw new RangeError("range out of order");
      ranges.push([low, high]);
      index += 2;
    } else ranges.push([low, low]);
  }
  return ranges;
}

// "**" skips line breaks the way a regex's "." did, so a rule still matches exactly the paths it matched before.
const LINE_BREAK = /[\n\r\u2028\u2029]/;

function stepTakes(step, character) {
  if (step.type === "char") return character === step.value;
  if (step.type === "one" || step.type === "star") return character !== "/";
  if (step.type === "anything") return !LINE_BREAK.test(character);
  if (step.type === "set") {
    const code = character.charCodeAt(0);
    return step.ranges.some(([low, high]) => code >= low && code <= high);
  }
  return false;
}

// State i waits for step i, and state steps.length + 1 + i is a "**/" still reading toward its slash.
function enterState(steps, states, start) {
  for (let index = start; !states[index];) {
    states[index] = 1;
    if (index === steps.length) return;
    const type = steps[index].type;
    if (type === "folders") states[steps.length + 1 + index] = 1;
    else if (type !== "star" && type !== "anything") return;
    index += 1;
  }
}

// Walks text once and says, for each position in `ends` (ascending), whether the rule matches text up to there.
function globMatchesAt(steps, text, ends) {
  const count = steps.length;
  const matched = ends.map(() => false);
  let states = new Uint8Array(2 * count + 1);
  enterState(steps, states, 0);
  let end = 0;
  for (let at = 0; end < ends.length; at += 1) {
    while (end < ends.length && ends[end] === at) matched[end++] = states[count] === 1;
    if (at >= text.length || end >= ends.length) break;
    const character = text[at];
    const next = new Uint8Array(states.length);
    for (let index = 0; index < count; index += 1) {
      const step = steps[index];
      if (states[index] && step.type !== "folders" && stepTakes(step, character)) {
        enterState(steps, next, step.type === "star" || step.type === "anything" ? index : index + 1);
      }
      if (step.type === "folders" && states[count + 1 + index]) {
        if (!LINE_BREAK.test(character)) next[count + 1 + index] = 1;
        if (character === "/") enterState(steps, next, index + 1);
      }
    }
    if (!next.includes(1)) break;
    states = next;
  }
  return matched;
}

function globMatches(steps, text) {
  return globMatchesAt(steps, text, [text.length])[0];
}

function parseRule(raw) {
  let pattern = raw;
  let negate = false;
  if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1);
  else if (pattern.startsWith("#")) return null;
  else if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  }
  while (pattern.endsWith(" ") && !pattern.endsWith("\\ ")) pattern = pattern.slice(0, -1);
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || pattern === "!") return null;
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  if (!pattern) return null;
  const hasSlash = pattern.includes("/");
  try {
    return { negate, directoryOnly, hasSlash, steps: globSteps(pattern) };
  } catch {
    return null;
  }
}

function parseClotrIgnore(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    return { ...EMPTY, valid: false, reason: "too-large" };
  }
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length > MAX_LINES) return { ...EMPTY, valid: false, reason: "too-many-lines" };
  let salt = null;
  const fingerprints = new Set();
  const rules = [];
  for (const raw of lines) {
    const metadata = raw.trim();
    if (!metadata) continue;
    if (/^value\s*:/i.test(metadata)) return { ...EMPTY, valid: false, reason: "raw-value" };
    const saltLine = /^salt\s*:\s*(\S+)$/i.exec(metadata);
    if (saltLine) {
      if (!/^[0-9a-f]{64}$/i.test(saltLine[1]) || (salt && salt !== saltLine[1].toLowerCase())) {
        return { ...EMPTY, valid: false, reason: "invalid-salt" };
      }
      salt = saltLine[1].toLowerCase();
      continue;
    }
    if (/^salt\s*:/i.test(metadata)) return { ...EMPTY, valid: false, reason: "invalid-salt" };
    const fingerprintLine = /^fingerprint\s*:\s*(\S+)$/i.exec(metadata);
    if (fingerprintLine) {
      if (!/^[0-9a-f]{64}$/i.test(fingerprintLine[1])) {
        return { ...EMPTY, valid: false, reason: "invalid-fingerprint" };
      }
      fingerprints.add(fingerprintLine[1].toLowerCase());
      continue;
    }
    if (/^fingerprint\s*:/i.test(metadata)) return { ...EMPTY, valid: false, reason: "invalid-fingerprint" };
    const rule = parseRule(raw);
    if (rule) rules.push(rule);
  }
  if (fingerprints.size && !salt) return { ...EMPTY, valid: false, reason: "missing-salt" };
  return { valid: true, salt, fingerprints, rules, reason: null, content };
}

function readClotrIgnore(root) {
  const file = path.join(path.resolve(root), ".clotrignore");
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) {
      return { ...EMPTY, valid: false, reason: before.size > MAX_BYTES ? "too-large" : "unsafe-file" };
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_BYTES) return { ...EMPTY, valid: false, reason: "unsafe-file" };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) return { ...EMPTY, valid: false, reason: "too-large" };
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
    return parseClotrIgnore(content);
  } catch (error) {
    if (error.code === "ENOENT") return EMPTY;
    return { ...EMPTY, valid: false, reason: "unsafe-file" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizedRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.posix.isAbsolute(relativePath)) return null;
  if (/^(?:[a-z]:|\\\\)/i.test(relativePath)) return null;
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

// Whether the rule matches each of the path's prefixes (a, a/b, a/b/c), in one walk of the path: a rule with a slash
// matches a prefix when the walk accepts at that prefix's end, and one without matches once any part so far does.
// Matching each prefix again from its start cost the depth times the length times the rule.
function prefixMatches(rule, normalized, parts, ends) {
  let matched;
  if (rule.hasSlash) matched = globMatchesAt(rule.steps, normalized, ends);
  else {
    let any = false;
    matched = parts.map((part) => (any = any || globMatches(rule.steps, part)));
  }
  // A rule ending in a slash names folders, and every prefix but the whole path is one.
  if (rule.directoryOnly) matched[matched.length - 1] = false;
  return matched;
}

function pathIgnored(config, relativePath) {
  if (!config?.valid) return false;
  const normalized = normalizedRelative(relativePath);
  if (!normalized) return false;
  const parts = normalized.split("/");
  const ends = [];
  for (let index = 0, end = -1; index < parts.length; index += 1) ends.push((end += parts[index].length + 1));
  // The last rule to match a prefix decides it, and the path is ignored when any of its prefixes is.
  const ignored = parts.map(() => false);
  for (const rule of config.rules) {
    prefixMatches(rule, normalized, parts, ends).forEach((match, index) => {
      if (match) ignored[index] = !rule.negate;
    });
  }
  return ignored.includes(true);
}

function pathIgnoredForFile(config, root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return pathIgnored(config, relative);
}

module.exports = { MAX_BYTES, parseClotrIgnore, readClotrIgnore, valueFingerprint, pathIgnored, pathIgnoredForFile };
