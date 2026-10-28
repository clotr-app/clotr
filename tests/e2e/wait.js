"use strict";

async function bounded(fn, timeout, label) {
  let timer;
  const timedOut = Symbol("operation timed out");
  const value = await Promise.race([
    Promise.resolve().then(fn),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeout);
    }),
  ]).finally(() => clearTimeout(timer));

  if (value === timedOut) throw new Error(`${label} timed out after ${timeout} ms`);
  return value;
}

async function waitFor(fn, timeout, interval = 100, patience = () => 1) {
  const budget = Math.max(0, timeout * patience());
  const end = Date.now() + budget;
  // A call still running at the deadline gets a fixed few seconds to answer (a slow hover or evaluate on a busy CI
  // runner); only a call that is truly stuck past that throws. 500 ms was too short on CI.
  const finalCallWindow = waitFor.finalCallMs;
  for (;;) {
    const remaining = end - Date.now();
    if (remaining <= 0) return null;

    // A CDP read started near the deadline needs enough time to reply; it still has a fixed upper bound.
    const callWindow = remaining <= finalCallWindow ? finalCallWindow : remaining;
    const value = await bounded(fn, callWindow, "waitFor condition");
    if (value) return value;
    if (Date.now() >= end) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, end - Date.now())));
  }
}

waitFor.finalCallMs = 5000;
waitFor.bounded = bounded;

module.exports = waitFor;
