// A large paste must keep each rule's input bounded, preserve a value at a window edge, and expose any skipped scan.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { grewMoreThan } = require("./timing.js");

test("oversized text reaches rules in bounded overlapping windows", () => {
  const source = String.raw`
    require("./extension/patterns.js");
    require("./extension/detector.js");
    const { PATTERNS, detect } = globalThis.Clotr;
    const windowChars = 40 * 1024;
    const marker = "boundary-marker-1234567890";
    const boundary = windowChars - 5;
    let largest = 0;
    PATTERNS.splice(0, PATTERNS.length, {
      id: "research_slow_rule",
      severity: "medium",
      find(text) {
        largest = Math.max(largest, text.length);
        return text.includes(marker) ? [marker] : [];
      },
    });
    const text = "x".repeat(boundary) + marker + "y".repeat(windowChars * 3);
    const results = detect(text);
    process.stdout.write(JSON.stringify({ largest, results, marker }));
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(
    child.error?.code,
    undefined,
    `an oversized rule call exceeded the cap: ${child.error?.code || "child failed"}`,
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.largest <= 40 * 1024, `a rule received ${result.largest} characters`);
  assert.ok(
    result.results.some((finding) => finding.matches.includes(result.marker)),
    "the boundary value was missed",
  );
});

test("hostile repeated-character input stays within the scan budget and grows linearly", () => {
  const source = String.raw`
    require("./extension/patterns.js");
    require("./extension/detector.js");
    const { bestOfPair } = require("./tests/timing.js");
    const make = (size) => "x".repeat(size);
    const results = globalThis.Clotr.detect(make(64 * 1024));
    const [small, big] = bestOfPair(
      () => globalThis.Clotr.detect(make(16 * 1024)),
      () => globalThis.Clotr.detect(make(64 * 1024)),
      8,
      5,
    );
    process.stdout.write(JSON.stringify({ small: small.wall, big: big.wall, truncated: results.truncated === true }));
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(
    child.error?.code,
    undefined,
    `the bounded hostile input was too slow: ${child.error?.code || "child failed"}`,
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.truncated, false);
  assert.ok(
    !grewMoreThan({ wall: result.small }, { wall: result.big }, 16),
    `the 64 KiB hostile check grew ${(result.big / result.small).toFixed(1)}× from 16 KiB`,
  );
});

test("a time-limited scan reports incomplete coverage across windows", () => {
  const source = String.raw`
    require("./extension/patterns.js");
    require("./extension/detector.js");
    const { PATTERNS, detect } = globalThis.Clotr;
    let now = 0;
    let calls = 0;
    Date.now = () => now;
    console.info = () => {};
    PATTERNS.splice(0, PATTERNS.length, {
      id: "research_deadline_rule",
      severity: "medium",
      find() {
        calls++;
        now += 10001;
        return [];
      },
    });
    const result = detect("x".repeat(64 * 1024 * 3));
    process.stdout.write(JSON.stringify({ calls, truncated: result.truncated }));
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error?.code, undefined, child.error?.code || "child failed");
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { calls: 1, truncated: true });
});
