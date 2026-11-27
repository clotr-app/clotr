"use strict";
/* global require, module, process, Buffer, setTimeout, clearTimeout */

const { MAX_STDIN_BYTES } = require("../limits-and-messages.js");

// ---------- Reading input ----------

// A name from the command line, shown back without anything that could steer the terminal.
function printable(value) {
  return String(value).replace(/[^\x20-\x7e]/g, "?");
}

// Windows PowerShell pipes text with a byte order mark: UTF-8, or UTF-16 when its output encoding is Unicode.
// Without decoding by the mark, JSON.parse fails and the hook stops the input it couldn't read.
function decodeInput(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return swapped.swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

// A hook's input, read until it closes. Given a deadline (a Date.now() time), input still open then is given
// up on with "stdin-late", and stdin is closed so the hook can exit once it has answered.
function parseInput(maxBytes = MAX_STDIN_BYTES, deadline) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    if (deadline !== undefined) {
      const timer = setTimeout(
        () => {
          reject(new Error("stdin-late"));
          process.stdin.destroy();
        },
        Math.max(0, deadline - Date.now()),
      );
      process.stdin.on("close", () => clearTimeout(timer));
      process.stdin.on("end", () => clearTimeout(timer));
    }
    process.stdin.on("data", (chunk) => {
      if (tooLarge) return;
      if (size + chunk.length > maxBytes) {
        chunks.length = 0;
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    process.stdin.on("end", () =>
      tooLarge ? reject(new Error("stdin-too-large")) : resolve(decodeInput(Buffer.concat(chunks))),
    );
    process.stdin.on("error", reject);
  });
}

module.exports = {
  printable,
  decodeInput,
  parseInput,
};
