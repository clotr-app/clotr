// Tests extension/csv.js, the small quote-aware CSV reader Look back's Copilot export uses.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.Clotr = {};
require("../extension/csv.js");
const { parseCsv, csvRecords } = globalThis.Clotr;

test("a plain row splits on commas", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("a quoted field can hold a comma, a newline, and an escaped quote", () => {
  const text = 'Date,Prompt\n2026-01-02,"a comma, a ""quoted"" word, and\na line break"\n';
  const { header, records } = csvRecords(text);
  assert.deepEqual(header, ["Date", "Prompt"]);
  assert.deepEqual(records, [{ Date: "2026-01-02", Prompt: 'a comma, a "quoted" word, and\na line break' }]);
});

test("\\r\\n line endings end a row, with the \\r dropped", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("a header row with an extra, unrecognized column still reads the known ones", () => {
  const { header, records } = csvRecords("Date,Prompt,Mood\n2026-01-02,hello,happy\n");
  assert.deepEqual(header, ["Date", "Prompt", "Mood"]);
  assert.deepEqual(records, [{ Date: "2026-01-02", Prompt: "hello", Mood: "happy" }]);
});

test("a row with the wrong number of fields is skipped, not guessed at", () => {
  const { records } = csvRecords("Date,Prompt\n2026-01-02,hello\n2026-01-03,too,many,fields\n");
  assert.deepEqual(records, [{ Date: "2026-01-02", Prompt: "hello" }]);
});

test("a trailing blank line doesn't become an empty record", () => {
  const { records } = csvRecords("Date,Prompt\n2026-01-02,hello\n\n");
  assert.deepEqual(records, [{ Date: "2026-01-02", Prompt: "hello" }]);
});

test("a truncated file, cut off mid quoted field, still returns what it read instead of throwing", () => {
  assert.doesNotThrow(() => parseCsv('Date,Prompt\n2026-01-02,"started but never closed'));
  const rows = parseCsv('Date,Prompt\n2026-01-02,"started but never closed');
  assert.deepEqual(rows, [
    ["Date", "Prompt"],
    ["2026-01-02", "started but never closed"],
  ]);
});

test("an empty file and a header-only file both read as no records", () => {
  assert.deepEqual(csvRecords(""), { header: [], records: [] });
  assert.deepEqual(csvRecords("Date,Prompt\n"), { header: ["Date", "Prompt"], records: [] });
});

test("a leading byte-order mark doesn't become part of the first header name", () => {
  const { header } = csvRecords("﻿Date,Prompt\n2026-01-02,hello\n");
  assert.deepEqual(header, ["Date", "Prompt"]);
});
