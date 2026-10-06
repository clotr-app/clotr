// Generates tests/fixtures/move-file.clotr: settings sealed by the extension's own backup.js with a known
// password, so every Clotr that brings settings in, the extension itself, Clotr for Windows, and the Android
// keyboard, is tested against the same file and must recover the same settings, recorded in move-file.json.
// Run this again only if the move file's format changes: node tests/fixtures/make-move-file.js
"use strict";

const fs = require("fs");
const path = require("path");
require("../../extension/backup.js");
const { Backup } = globalThis.Clotr;

const PASSWORD = "clotr fixture password";
const SETTINGS = {
  responses: { credit_card: "log", phone_number: "block", email: "warn" },
  paused: { "chatgpt.com": true },
  siteModes: { "claude.ai": "log" },
  guided: { email: 1727600000000 },
  keepDays: 90,
  largeText: true,
  lock: { salt: "ab".repeat(16), iterations: 150000, hash: "cd".repeat(32) },
  salt: "00112233445566778899aabbccddeeff",
  vault: [
    { kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "protect", added: 1727600000000 },
    { kind: "value", type: "email", fp: "fedcba9876543210", mode: "allow", added: 1727600000001 },
    { kind: "shape", type: "my_id", shape: "AB-####", added: 1727600000002 },
    { kind: "word", type: "watch_list", fp: "a1b2c3d4e5f60718", words: 2, added: 1727600000003 },
  ],
  bandage: { "chatgpt.com": true },
  tourniquet: { for: "adult", since: 1727800000000 },
};

async function main() {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, "move-file.clotr"), `${await Backup.seal(SETTINGS, PASSWORD)}\n`);
  fs.writeFileSync(
    path.join(dir, "move-file.json"),
    `${JSON.stringify({ password: PASSWORD, settings: SETTINGS }, null, 2)}\n`,
  );
}

if (require.main === module) main();
