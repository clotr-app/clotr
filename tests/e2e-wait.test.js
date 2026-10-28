"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const waitFor = require("./e2e/wait.js");

test("e2e wait reports when its condition call itself stalls", async () => {
  const stalled = Symbol("still waiting");
  const result = await Promise.race([
    waitFor(
      () => new Promise(() => {}),
      20,
      1,
      () => 1,
    ).then(
      () => ({ settled: true }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve(stalled), 100)),
  ]);

  assert.notEqual(result, stalled, "waitFor kept waiting on an unresolved page call");
  assert.match(result.error.message, /^waitFor condition timed out after \d+ ms$/);
});

test("e2e bounded call reports a stalled direct page call", async () => {
  const stalled = Symbol("still waiting");
  const result = await Promise.race([
    waitFor
      .bounded(() => new Promise(() => {}), 20, "EV4 welcome-card page.evaluate")
      .then(
        () => ({ settled: true }),
        (error) => ({ settled: true, error }),
      ),
    new Promise((resolve) => setTimeout(() => resolve(stalled), 100)),
  ]);

  assert.notEqual(result, stalled, "bounded call kept waiting on an unresolved page call");
  assert.equal(result.error.message, "EV4 welcome-card page.evaluate timed out after 20 ms");
});

test("e2e wait gives its final page call a bounded chance to finish", async () => {
  let calls = 0;
  const result = await waitFor(
    () => {
      calls++;
      return calls === 1 ? false : new Promise((resolve) => setTimeout(() => resolve(false), 80));
    },
    150,
    100,
  );

  assert.equal(result, null);
  assert.equal(calls, 2);
});
