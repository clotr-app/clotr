// Hide it twice on one long paste, through the engine bundle the apps load. The host hands the engine a new copy
// of the text on every call, so a cache that checks "same text?" with === reads the whole copy each time it looks.
// With a saved word inside thousands of longer words, that was one read of 1 MB per copy, and the second Hide it
// took seconds where 1.6.1 took a blink.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { build } = require("../tools/engine-bundle.js");
const { bestOfPair, grewMoreThan, grewEveryTime } = require("./timing.js");

const SALT = "0123456789abcdef0123456789abcdef";
// Made up: a saved word, and a longer word that starts with it.
const WORD = ["Rose", "wood"].join("");
const COPIES = 20000;

// A bare engine with the bundle loaded, spoken to through ClotrHost.call as an app does (JSON in and out, so
// each call gets its own copy of the text).
function hostEngine() {
  const context = vm.createContext({});
  vm.runInContext(build().text, context, { filename: "clotr-engine.js" });
  const host = vm.runInContext("ClotrHost.call", context);
  return (method, ...args) => {
    const answer = JSON.parse(host(JSON.stringify({ method, args })));
    if (answer.error) throw new Error(`${method}: ${answer.error}`);
    return answer.result;
  };
}

// About 1 MB: the saved word once on its own, then 20,000 longer words that start with it, in text with an
// accent so the engine also reads a cleaned copy of it.
function longPaste(copies = COPIES) {
  const filler = " lorem ipsum café dolor sit amet ";
  const pieces = [`Meet at ${WORD} now.`];
  for (let i = 0; i < copies; i++) pieces.push(`${WORD}land${filler}`);
  return pieces.join(" ");
}

function timed(fn) {
  const started = performance.now();
  const out = fn();
  return { ms: performance.now() - started, out };
}

// The limit is 300 ms. On a 4-core cloud container with Node 22, 1.6.1's host takes about 30 ms for the second
// Hide it on this text, and the fixed engine about 50 ms (it also reads each longer word's edges, which 1.6.1
// didn't). 300 ms leaves room for a slow or busy machine, while the old cost was a second and up.
const LIMIT_MS = 300;

// An engine with the saved word in its vault.
function savedWordEngine() {
  const call = hostEngine();
  // The salt goes in first, since the word's fingerprint needs it.
  call("init", { salt: SALT });
  const fp = call("fingerprintFor", "watch_list", WORD);
  call("init", { salt: SALT, vault: [{ kind: "word", type: "watch_list", fp, words: 1 }] });
  return call;
}

test("a second Hide it on a long paste with a saved word inside thousands of longer words stays fast", () => {
  const call = savedWordEngine();
  const text = longPaste();
  assert.ok(text.length > 900000 && text.length < 1100000, "about 1 MB");
  const ids = call("check", text, { app: "chatgpt" }).findings.map((f) => f.id);
  assert.equal(ids.length, 1, "the saved word is found");

  const first = timed(() => call("redact", text, ids));
  assert.ok(!first.out.includes(`${WORD} now`), "the word on its own is hidden");
  assert.equal(first.out.split(`${WORD}land`).length - 1, COPIES, "every longer word stays");

  // Best of three: each call hands in a new copy, as an app does.
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const again = timed(() => call("redact", text, ids));
    assert.equal(again.out, first.out, "the second Hide it hides the same");
    best = Math.min(best, again.ms);
  }
  assert.ok(best < LIMIT_MS, `the second Hide it took ${Math.round(best)} ms (limit ${LIMIT_MS} ms)`);
});

// A count can't see a whole-text === inside each copy's check, so this one is timed: 4 times the copies may take at
// most 10 times as long, where a read of the whole text per copy takes 16. Each engine keeps to its own text, so
// every timed call is a second Hide it.
test("a second Hide it grows with the number of longer words, not its square", () => {
  const hideAgain = (copies) => {
    const call = savedWordEngine();
    const text = longPaste(copies);
    const ids = call("check", text, { app: "chatgpt" }).findings.map((f) => f.id);
    call("redact", text, ids);
    return () => call("redact", text, ids);
  };
  const slow = grewEveryTime(
    () => bestOfPair(hideAgain(COPIES / 4), hideAgain(COPIES), 4, 3),
    (s, b) => grewMoreThan(s, b, 10),
  );
  assert.equal(slow, null, `the second Hide it took ${slow?.map((m) => m.wall.toFixed(1)).join(" ms and ")} ms`);
});
