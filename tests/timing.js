"use strict";

// detect() keeps its last answer, so a repeated call on one text would time the cache, not the scan. Each timed call
// starts without it.
const fresh = () => globalThis.Clotr?.detect?.forget?.();

function measure(fn, repeats = 1) {
  let spent = 0;
  for (let i = 0; i < repeats; i++) {
    fresh();
    const started = performance.now();
    fn();
    spent += performance.now() - started;
  }
  return spent / repeats;
}

// Warm both input sizes, then take the best of several alternating measurements. Repeating the smaller input
// `times` times makes each sample take about as long as the large input on linear work, and averaging it keeps
// timer resolution from distorting the comparison.
function bestOfPair(small, big, times = 4, runs = 3) {
  small();
  big();
  const s = { wall: Infinity };
  const b = { wall: Infinity };
  for (let i = 0; i < runs; i++) {
    if (i % 2) {
      s.wall = Math.min(s.wall, measure(small, times));
      b.wall = Math.min(b.wall, measure(big));
    } else {
      b.wall = Math.min(b.wall, measure(big));
      s.wall = Math.min(s.wall, measure(small, times));
    }
  }
  return [s, b];
}

// Same comparison for checks that return promises.
async function bestOfAsyncPair(small, big, times = 4, runs = 3) {
  const measureAsync = async (fn, repeats = 1) => {
    let spent = 0;
    for (let i = 0; i < repeats; i++) {
      fresh();
      const started = performance.now();
      await fn();
      spent += performance.now() - started;
    }
    return spent / repeats;
  };
  await small();
  await big();
  const s = { wall: Infinity };
  const b = { wall: Infinity };
  for (let i = 0; i < runs; i++) {
    if (i % 2) {
      s.wall = Math.min(s.wall, await measureAsync(small, times));
      b.wall = Math.min(b.wall, await measureAsync(big));
    } else {
      b.wall = Math.min(b.wall, await measureAsync(big));
      s.wall = Math.min(s.wall, await measureAsync(small, times));
    }
  }
  return [s, b];
}

// A floor prevents timer noise on very short work from making the growth ratio look larger than it is.
function grewMoreThan(small, big, limit, floor = 0.5) {
  return big.wall >= floor && big.wall / Math.max(small.wall, floor) >= limit;
}

// Measures a pair again before calling it slow. Quadratic work goes over the limit on every attempt, while a pause
// on a busy machine rarely lands on the same side three times running, so a limit well under quadratic growth
// doesn't make the check flaky. Returns the last measurement when every attempt grew too much, or null.
function grewEveryTime(measurePair, grew, attempts = 3) {
  let pair = null;
  for (let i = 0; i < attempts; i++) {
    pair = measurePair();
    if (!grew(...pair)) return null;
  }
  return pair;
}

module.exports = { bestOfPair, bestOfAsyncPair, grewMoreThan, grewEveryTime };
