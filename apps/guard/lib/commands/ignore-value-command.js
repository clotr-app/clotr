"use strict";
/* global require, module, Buffer */

const { check } = require("../text-checks/engine-loader.js");
const { gitRoot } = require("../git-repository.js");
const { isPersonalDetail } = require("../text-checks/check-text.js");
const { parseInput } = require("./piped-input.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readClotrIgnore, valueFingerprint } = require("../clotrignore.js");
const { atomicWriteFile } = require("../safe-file-writes.js");

// ---------- Ignored values ----------

function isGuessableIgnoreKind(kind) {
  return (
    typeof kind === "string" &&
    (isPersonalDetail(kind) ||
      /password|passphrase|passcode|pin|card|bank|medical|backup|recovery|tax|security.?answer/i.test(kind))
  );
}

function repeatsShortPattern(value) {
  for (let size = 1; size <= Math.min(12, Math.floor(value.length / 2)); size += 1) {
    let repeats = true;
    for (let index = size; index < value.length; index += 1) {
      if (value[index] !== value[index % size]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

// The salt is committed beside each fingerprint, so people can try likely values offline. Only long, varied
// tokens are safe to fingerprint; natural language, personal details and values labeled as passwords stay
// out.
function guessableValue(value, kind) {
  const kinds = check(value, { site: "clotr-guard" }).findings.map((finding) => finding.kind);
  if (isGuessableIgnoreKind(kind) || kinds.some(isGuessableIgnoreKind)) return true;
  if (/\s/.test(value) || repeatsShortPattern(value)) return true;
  const characters =
    (/[0-9]/.test(value) ? 10 : 0) +
    (/[a-z]/.test(value) ? 26 : 0) +
    (/[A-Z]/.test(value) ? 26 : 0) +
    (/[^0-9a-zA-Z]/.test(value) ? 33 : 0);
  if (characters < 2 || value.length * Math.log2(characters) < 64 || new Set(value).size < 10) return true;
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits * value.length < 64;
}

// The one way a value's fingerprint gets into .clotrignore, for the CLI and the editor plugins alike.
function addIgnoredValue(root, value, kind) {
  if (!value) throw new Error("empty-value");
  if (guessableValue(value, kind)) throw new Error("guessable-value");
  return appendIgnoredValue(root, value);
}

async function ignoreValue(cwd, kind) {
  const value = (await parseInput()).replace(/\r?\n$/, "");
  addIgnoredValue(gitRoot(cwd), value, kind);
  return 0;
}

function appendIgnoredValue(root, value) {
  const file = path.join(root, ".clotrignore");
  const config = readClotrIgnore(root);
  if (!config.valid) throw new Error(config.reason || "invalid-ignore-file");
  const salt = config.salt || crypto.randomBytes(32).toString("hex");
  const fingerprint = valueFingerprint(salt, value);
  if (!fingerprint) throw new Error("invalid-value");
  if (config.fingerprints.has(fingerprint)) return false;
  let content = config.content;
  if (!config.salt) content = `salt: ${salt}\n${content}`;
  content += `${content && !content.endsWith("\n") ? "\n" : ""}fingerprint: ${fingerprint}\n`;
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("ignore-file-too-large");
  let mode = 0o644;
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("unsafe-ignore-file");
    mode = existing.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  atomicWriteFile(file, content, { mode });
  return true;
}

module.exports = {
  addIgnoredValue,
  ignoreValue,
  appendIgnoredValue,
};
