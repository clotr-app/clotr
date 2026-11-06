"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const waitFor = require("./e2e/wait.js");

test("e2e wait reports when its condition call itself stalls", async (t) => {
  const stalled = Symbol("still waiting");
  const saved = waitFor.finalCallMs;
  waitFor.finalCallMs = 20;
  t.after(() => (waitFor.finalCallMs = saved));
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

// The second call starts long before the deadline, so a timer that fires late on a busy runner can't skip it, and it
// answers 80 ms after the deadline, so it is still running when the time is up.
test("e2e wait gives its final page call a bounded chance to finish", async () => {
  let calls = 0;
  let answered = false;
  const deadline = Date.now() + 1000;
  const result = await waitFor(
    () => {
      calls++;
      if (calls === 1) return false;
      return new Promise((resolve) =>
        setTimeout(
          () => {
            answered = true;
            resolve(false);
          },
          deadline + 80 - Date.now(),
        ),
      );
    },
    1000,
    10,
  );

  assert.equal(result, null);
  assert.equal(calls, 2);
  assert.ok(answered, "waitFor returned before its last call answered");
});
