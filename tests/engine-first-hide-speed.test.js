// The first Hide it on a long paste with a saved word inside thousands of longer words, through the engine bundle
// the apps load. Each longer word that starts with the saved word has its edge read, and that read used to clean
// the whole text first (about a second's worth on a slow machine), even where the letter after the word is a plain
// one cleaning keeps as it is. 1.6.1's host took about 30 ms here.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { COUNTED, meter, assertCounted } = require("./work-child.js");
const work = meter(); // in the counting child, before the engine, so the meter counts its steps
const { build } = require("../tools/engine-bundle.js");

const SALT = "0123456789abcdef0123456789abcdef";
// Made up: a saved word, and a longer word that starts with it.
const WORD = ["Rose", "wood"].join("");
const COPIES = 20000;

// A fresh engine for each try, so each try's Hide it is a first one.
function hostEngine(bundle) {
  const context = vm.createContext({});
  vm.runInContext(bundle, context, { filename: "clotr-engine.js" });
  const host = vm.runInContext("ClotrHost.call", context);
  return (method, ...args) => {
    const answer = JSON.parse(host(JSON.stringify({ method, args })));
    if (answer.error) throw new Error(`${method}: ${answer.error}`);
    return answer.result;
  };
}

// About 1 MB with an accent in it, so the text does need cleaning somewhere.
function longPaste(copies = COPIES) {
  const filler = " lorem ipsum café dolor sit amet ";
  const pieces = [`Meet at ${WORD} now.`];
  for (let i = 0; i < copies; i++) pieces.push(`${WORD}land${filler}`);
  return pieces.join(" ");
}

// The limit is 150 ms. On a 4-core cloud container with Node 22, 1.6.1's host takes about 30 ms for the first Hide
// it on this text, and the engine before this fix 330 to 400 ms. 150 ms leaves room for a slow or busy machine.
const LIMIT_MS = 150;

test("a first Hide it on a long paste with a saved word inside thousands of longer words stays fast", () => {
  const bundle = build().text;
  const text = longPaste();
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const call = hostEngine(bundle);
    call("init", { salt: SALT });
    const fp = call("fingerprintFor", "watch_list", WORD);
    call("init", { salt: SALT, vault: [{ kind: "word", type: "watch_list", fp, words: 1 }] });
    const ids = call("check", text, { app: "chatgpt" }).findings.map((f) => f.id);
    assert.equal(ids.length, 1, "the saved word is found");
    const started = performance.now();
    const out = call("redact", text, ids);
    best = Math.min(best, performance.now() - started);
    assert.ok(!out.includes(`${WORD} now`), "the word on its own is hidden");
    assert.equal(out.split(`${WORD}land`).length - 1, COPIES, "every longer word stays");
  }
  assert.ok(best < LIMIT_MS, `the first Hide it took ${Math.round(best)} ms (limit ${LIMIT_MS} ms)`);
});

// The meter can't see into the bundle's vm context, so this reads the engine's own files in the counting child, where
// 4 times the copies may make at most WORK_GROWTH times the work. Cleaning the whole text for each longer word grows
// with the square. Only the counting child declares it, so a plain run skips nothing; the test below runs it there.
if (COUNTED) {
  test("a first Hide it on thousands of longer words makes linear work", () => {
    require("./load-engine.js")("rules", "detect");
    const C = globalThis.Clotr;
    C.setVault({
      salt: SALT,
      entries: [{ kind: "word", type: "watch_list", fp: C.fingerprint(SALT, "watch_list", WORD), words: 1 }],
    });
    const hide = (text) => C.redact(text, C.detect(text));
    work.assertWorkLinear(hide, (_unit, copies) => longPaste(copies), [WORD], 500, undefined, [__filename]);
  });
}

test("a first Hide it on thousands of longer words is counted too", { skip: COUNTED }, () => {
  assertCounted(__filename, ["a first Hide it on thousands of longer words makes linear work"]);
});
