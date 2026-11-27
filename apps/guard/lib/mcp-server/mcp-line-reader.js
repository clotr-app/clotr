"use strict";
/* global require, module, process, Buffer */

const { MAX_TEXT_BYTES } = require("./mcp-tools.js");
const { rpcError, replies } = require("./mcp-requests.js");

// ---------- The server and its tools ----------

// JSON can write any character as \uXXXX, so a text costs at most 6 bytes on the line for each of its UTF-8
// bytes (a 1-byte control character becomes 6, a 4-byte one two escapes of 6). 6 x 64 KiB = 384 KiB, plus 16
// KiB for the rest of the call, makes 400 KiB (409,600 bytes): any text the cap allows fits, however it's
// escaped.
const MAX_LINE_BYTES = 6 * MAX_TEXT_BYTES + 16 * 1024;
// An oversized line is never parsed, but its top-level "id" is read on the way past if it's this short.
const MAX_ID_BYTES = 1024;
// ---------- Stdio framing ----------

function send(value) {
  if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
}

// The request id of an oversized line, read a byte at a time as the line goes past, so none of the line is
// kept. It follows strings and nesting and takes the last top-level "id" whose value is a string, a number or
// null, at most MAX_ID_BYTES long. Bytes are read as latin1 characters and the id is decoded as UTF-8 at the
// end.
function idReader() {
  const reading = {
    depth: 0,
    inString: false,
    escaped: false,
    expectKey: false,
    key: "",
    raw: null,
    readable: true,
    id: undefined,
    done: false,
  };
  return {
    feed(bytes) {
      for (let index = 0; index < bytes.length && !reading.done && reading.readable; index += 1) {
        stepIdReader(reading, String.fromCharCode(bytes[index]));
      }
    },
    id: () => (reading.readable ? reading.id : undefined),
  };
}

// The id value read so far, kept when it parses as one an answer can carry.
function endIdValue(reading) {
  if (reading.raw === null) return;
  try {
    const value = JSON.parse(Buffer.from(reading.raw, "latin1").toString("utf8"));
    if (value === null || ["string", "number"].includes(typeof value)) reading.id = value;
  } catch {
    // Not a value an answer can carry.
  }
  reading.raw = null;
}

// One character of the line.
function stepIdReader(reading, char) {
  if (reading.raw !== null && reading.depth >= 1) {
    reading.raw = reading.raw.length < MAX_ID_BYTES ? reading.raw + char : null;
  }
  if (reading.inString) {
    if (reading.escaped) reading.escaped = false;
    else if (char === "\\") reading.escaped = true;
    else if (char === '"') reading.inString = false;
    if (reading.expectKey && reading.depth === 1 && reading.key.length < 8) reading.key += char;
    return;
  }
  if (char === '"') {
    reading.inString = true;
    if (reading.expectKey && reading.depth === 1) reading.key = char;
  } else if (char === "{" || char === "[") {
    if (reading.depth === 0 && char === "[") reading.readable = false;
    reading.depth += 1;
    if (reading.depth === 1) reading.expectKey = true;
  } else if (char === "}" || char === "]") {
    reading.depth -= 1;
    if (reading.depth === 0) {
      if (reading.raw !== null) reading.raw = reading.raw.slice(0, -1);
      endIdValue(reading);
      reading.done = true;
    }
  } else if (char === ":" && reading.depth === 1 && reading.expectKey) {
    reading.expectKey = false;
    reading.raw = reading.key === '"id"' ? "" : null;
  } else if (char === "," && reading.depth === 1) {
    if (reading.raw !== null) reading.raw = reading.raw.slice(0, -1);
    endIdValue(reading);
    reading.expectKey = true;
    reading.key = "";
  }
}

function answerLine(line) {
  let message;
  try {
    message = JSON.parse(line.toString("utf8"));
  } catch {
    send(rpcError(null, -32700, "Parse error"));
    return;
  }
  for (const reply of replies(message)) send(reply);
}

// Reads one line at a time and never holds more than MAX_LINE_BYTES of one line. A longer line is dropped as
// it arrives, and its error carries the id read on the way past, or none when it can't be read.
function serve() {
  let pending = Buffer.alloc(0);
  let oversized = null;
  function take(chunk) {
    let rest = chunk;
    while (rest.length) {
      const newline = rest.indexOf(0x0a);
      const part = newline < 0 ? rest : rest.subarray(0, newline);
      if (!oversized && pending.length + part.length > MAX_LINE_BYTES) {
        oversized = idReader();
        oversized.feed(pending);
        pending = Buffer.alloc(0);
      }
      if (oversized) oversized.feed(part);
      else pending = Buffer.concat([pending, part]);
      if (newline < 0) return;
      rest = rest.subarray(newline + 1);
      endLine();
    }
  }
  function endLine() {
    if (oversized) send(rpcError(oversized.id(), -32700, "Request is too large"));
    else answerLine(pending);
    oversized = null;
    pending = Buffer.alloc(0);
  }
  process.stdin.on("data", take);
  process.stdin.on("end", () => {
    if (oversized || pending.length) endLine();
  });
}

module.exports = {
  serve,
};
