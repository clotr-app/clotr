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

// A value that crosses a seam between two windows, or sits right next to one, is found once, whole and as its own
// kind: the window that cuts it off, or starts partway into it, doesn't add a piece of it as another finding.
test("a value at each offset across a window seam is found exactly once, whole, as its own kind", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const { makeSecrets } = require("./fixtures/secrets.js");
  const { detect, DETECT_WINDOW_CHARS, DETECT_WINDOW_OVERLAP } = globalThis.Clotr;
  const line = "the quick brown fox jumps over the lazy dog and keeps running far away\n";
  const filler = (n) => line.repeat(Math.ceil(n / line.length)).slice(0, n);
  const openai = makeSecrets(20261020).find((fixture) => fixture.kind === "openai_key").value;
  const values = [
    ["openai_key", openai],
    ["credit_card", "4917 6103 8473 2210"],
    ["email", "ann.lee@example.org"],
    ["phone_number", "(415) 555-0132"],
  ];
  // The first window's end, the second window's start, and the second window's end.
  const seams = [
    DETECT_WINDOW_CHARS,
    DETECT_WINDOW_CHARS - DETECT_WINDOW_OVERLAP,
    2 * DETECT_WINDOW_CHARS - DETECT_WINDOW_OVERLAP,
  ];
  const wrong = [];
  for (const [kind, value] of values) {
    for (const [index, seam] of seams.entries()) {
      // Every other offset, alternating between seams, so each cut point of the value is tried at some seam.
      for (let shift = -value.length - 2 + (index % 2); shift <= 2; shift += 2) {
        const at = seam + shift;
        // Just long enough to reach the window on the seam's other side, to keep the sweep quick.
        const text = `${filler(at)} ${value} ${filler(Math.max(seam, DETECT_WINDOW_CHARS) + 2048 - at)}`;
        const results = detect(text);
        const exact = results.length === 1 && results[0].id === kind && results[0].matches.join() === value;
        if (!exact) {
          wrong.push(`${kind} at seam ${seam}${shift}: ${JSON.stringify(results.map((r) => [r.id, r.matches]))}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});

// A window that cuts an everyday value in half, or starts partway into one, can read the piece as something else:
// the first 11 digits of a millisecond timestamp, or the tail of an order number or a request id, as a phone
// number. The window on the seam's other side reads the whole value, so a piece is never kept, and a message cut
// at any offset by either seam gives what it gives on its own: nothing for an everyday message from the quiet
// corpus, its one real value for a message that has one. Two different messages share each paste, one across the
// second window's start and one across the first window's end, to keep the sweep quick.
test("a message cut at any offset by a window seam gives what it gives on its own", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const { detect, DETECT_WINDOW_CHARS, DETECT_WINDOW_OVERLAP } = globalThis.Clotr;
  const corpus = ["normal-messages.txt", "normal-messages-es.txt"].flatMap((file) =>
    fs
      .readFileSync(path.join(__dirname, "corpus", file), "utf8")
      .split(/\r?\n---\r?\n/)
      .slice(1)
      .map((m) => m.trim()),
  );
  // Quiet-corpus messages with pieces that read as a phone number, an SSN or an address.
  const quiet = [
    "Order #445-2231987 from Amazon",
    '{"timestamp":1760881507123',
    "Write a regex that matches US ZIP codes",
    "He won, too: one seven",
    "2026-10-19 13:45:07,123 INFO server ready",
    "La carrera 7 es la avenida",
  ].map((start) => {
    const named = corpus.filter((m) => m.startsWith(start));
    assert.equal(named.length, 1, `one quiet-corpus message starts "${start}"`);
    return named[0];
  });
  const messages = [
    ...quiet,
    "Timestamp 1715949296123 and 1715949296 seconds",
    "Invoice 4839201773 total 1,234,567.89 due 2024-06-01",
    "request id 550e8400-e29b-41d4-a716-446655440000 failed",
    // One real value each, found once and whole.
    "Call me on 5fivefive5five5five63six tonight",
    "We moved to Twelve Oak Street with our dog last spring.",
  ];
  const found = (text) => {
    detect.forget();
    return [...new Set(detect(text).flatMap((r) => r.matches.map((m) => `${r.id} ${m}`)))].sort();
  };
  const alone = new Map(messages.map((m) => [m, found(m)]));
  assert.deepEqual(
    messages.slice(0, -2).filter((m) => alone.get(m).length),
    [],
  );
  assert.deepEqual(
    messages.slice(-2).map((m) => alone.get(m).length),
    [1, 1],
  );
  const line = "The weather was mild today, so we walked to the market and bought apples, bread and some cheese ok.\n";
  const lines = line.repeat(Math.ceil(DETECT_WINDOW_CHARS / line.length) + 1);
  const filler = (n) => (n > 0 ? lines.slice(lines.length - n) : "");
  const startSeam = DETECT_WINDOW_CHARS - DETECT_WINDOW_OVERLAP;
  const endSeam = DETECT_WINDOW_CHARS;
  const cuts = messages.flatMap((m) => Array.from({ length: m.length - 1 }, (_, i) => [m, i + 1]));
  const half = Math.floor(cuts.length / 2); // so no message shares a paste with itself
  const wrong = [];
  for (let i = 0; i < cuts.length; i++) {
    const [first, firstCut] = cuts[i];
    const [second, secondCut] = cuts[(i + half) % cuts.length];
    let text = filler(startSeam - firstCut) + first + "\n";
    text += filler(endSeam - secondCut - text.length) + second + "\n" + filler(2048);
    const want = [...new Set([...alone.get(first), ...alone.get(second)])].sort();
    const got = found(text);
    if (got.join("\n") !== want.join("\n")) {
      wrong.push(`${JSON.stringify(first.slice(0, firstCut))} | ${JSON.stringify(second.slice(0, secondCut))}: ${got}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// A seed phrase is only flagged with its label ("seed phrase") somewhere in the message, and in a large paste that
// label can sit in one window while the phrase sits within reach of a seam. The window that read the label has to
// keep what it found even though the window on the seam's other side, which can't see the label, finds nothing;
// and the window that did see the label can't drop what it found as already read by a window that never saw it.
// The 12 words are the BIP-39 test vector, not anyone's wallet.
const SEED_TEST_VECTOR =
  "zoo, legal, winner, thank, year, wave, sausage, worth, useful, legal, winner, thank, yellow, zone";
const PROSE_LINE =
  "The weather was mild today, so we walked to the market and bought apples, bread and some cheese ok. ";
const prose = (n) => PROSE_LINE.repeat(Math.ceil(n / PROSE_LINE.length) + 1).slice(0, Math.max(0, n));

test("a labelled seed phrase that ends right before a window's end is still found", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const { detect, DETECT_WINDOW_CHARS } = globalThis.Clotr;
  const label = "My seed phrase is below.\n";
  const missed = [];
  for (const end of [
    DETECT_WINDOW_CHARS - 1010,
    DETECT_WINDOW_CHARS - 960,
    DETECT_WINDOW_CHARS - 500,
    DETECT_WINDOW_CHARS - 10,
  ]) {
    const text = label + prose(end - SEED_TEST_VECTOR.length - label.length) + SEED_TEST_VECTOR + "\n" + prose(30000);
    detect.forget();
    const found = detect(text).filter((r) => r.id === "crypto_secret");
    if (found.length !== 1 || found[0].matches.length !== 1) missed.push(`${end}: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, []);
});

test("a seed phrase labelled further on is still found right after the next window's start", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const { detect, DETECT_WINDOW_CHARS, DETECT_WINDOW_OVERLAP } = globalThis.Clotr;
  const secondStart = DETECT_WINDOW_CHARS - DETECT_WINDOW_OVERLAP;
  const missed = [];
  for (const start of [secondStart + 32, secondStart + 232, secondStart + 932]) {
    let text = prose(start) + SEED_TEST_VECTOR;
    text += prose(60000 - text.length) + "\nThat list above is my seed phrase.\n" + prose(5000);
    detect.forget();
    const found = detect(text).filter((r) => r.id === "crypto_secret");
    if (found.length !== 1 || found[0].matches.length !== 1) missed.push(`${start}: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, []);
});

// A seed phrase or a backup-code file counts only with its label in the window that holds it, as a large paste was
// always read: a passing "MFA codes" or "mnemonic" a window or more away from a column of codes or a word list says
// nothing about them, and a paste of several MB is likely to hold one somewhere. Near a seam, the window that holds
// both the label and the value keeps what it found, though the window on the seam's other side can't see the label,
// and that window reads the value whole once told about the label, so a value cut in half isn't kept as a piece.
const SEED_CODES =
  "\n" +
  ["10293847 56473829", "28374651 91827364", "37465182 64738291", "46571829 73829164", "55182937 82917364"].join("\n") +
  "\n";
const seamKinds = (text) => {
  const { detect } = globalThis.Clotr;
  detect.forget();
  return detect(text)
    .map((r) => `${r.id}:${r.matches.length}`)
    .sort()
    .join();
};

test("a seed phrase or backup-code file near a seam is found with its label in the window that holds it", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const { DETECT_WINDOW_CHARS, DETECT_WINDOW_OVERLAP } = globalThis.Clotr;
  const secondStart = DETECT_WINDOW_CHARS - DETECT_WINDOW_OVERLAP;
  const missed = [];
  // Ending right before the first window's end, labelled the ways a short message reads through (cleanText): with
  // an invisible character or a soft hyphen inside it, in full-width letters, or URL-encoded in a link.
  for (const written of [
    "My seed phrase is below.\n",
    "My seed​phrase is below.\n",
    "My seed­phrase is below.\n",
    "My ｓｅｅｄ ｐｈｒａｓｅ is below.\n",
    "Saved at https://example.com/notes?title=my%20seed%20phrase today.\n",
  ]) {
    const end = DETECT_WINDOW_CHARS - 500;
    const text =
      written + prose(end - SEED_TEST_VECTOR.length - written.length) + SEED_TEST_VECTOR + "\n" + prose(30000);
    if (seamKinds(text) !== "crypto_secret:1") missed.push(`seed before a window's end, ${JSON.stringify(written)}`);
  }
  // A link that starts before the second window's start, with its URL-encoded label after it: the second window
  // reads the label as the first one does, though it never saw the link's "://", and it holds the phrase as well.
  for (const lead of [100, 32]) {
    const link = "https://notes.example/view?doc=" + "a".repeat(200) + "&title=my%20seed%20phrase \n";
    const crossing = prose(secondStart - lead) + link;
    const text = crossing + prose(45000 - crossing.length) + SEED_TEST_VECTOR + "\n" + prose(2000);
    if (seamKinds(text) !== "crypto_secret:1") missed.push(`a link's label across the second window's start, ${lead}`);
  }
  // Backup codes right before the first window's end, titled at its start; and right after the second window's
  // start, titled further on in that window.
  const title = "Recovery codes for my account\n";
  const before = title + prose(DETECT_WINDOW_CHARS - 500 - SEED_CODES.length - title.length);
  if (seamKinds(before + SEED_CODES + prose(30000)) !== "backup_codes:1") missed.push("codes before a window's end");
  for (const lead of [40, 400]) {
    const after = prose(secondStart + lead) + SEED_CODES;
    const text = after + prose(60000 - after.length) + "\nThose are my recovery codes.\n" + prose(2000);
    if (seamKinds(text) !== "backup_codes:1") missed.push(`codes after a window's start, ${lead}`);
  }
  assert.deepEqual(missed, []);
  // Without any label, the same list in the same place is still just words, and the same grid just numbers.
  assert.equal(seamKinds(prose(DETECT_WINDOW_CHARS - 500) + SEED_TEST_VECTOR + "\n" + prose(30000)), "");
  assert.equal(seamKinds(prose(secondStart + 40) + SEED_CODES + prose(30000)), "");
});

test("a label a window or more away from a word list or a column of codes doesn't count, as before", () => {
  require("../extension/patterns.js");
  require("../extension/detector.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "patterns.js"), "utf8");
  const at = source.indexOf("const BIP39 = new Set(");
  const open = source.indexOf("`", at);
  const words = source
    .slice(open + 1, source.indexOf("`", open + 1))
    .trim()
    .split(/\s+/);
  assert.equal(words.length, 2048);
  const CODE = "function add(a, b) {\n  // adds two numbers and returns the total for the caller\n  return a + b;\n}\n";
  const code = (n) => CODE.repeat(Math.ceil(n / CODE.length)).slice(0, n);
  const LOG = "2026-11-02 10:15:07,123 INFO request served in 12 ms for /api/items?page=2 status=200\n";
  const log = (n) => LOG.repeat(Math.ceil(n / LOG.length)).slice(0, n);
  const lines = (list) => "\n" + list.join("\n") + "\n";
  const shas = lines(["6ad404b", "b224646", "bcdd9c1", "bdd524c", "9911bcd", "2d647b2", "ad3c19f", "b85777b"]);
  const orders = lines(Array.from({ length: 12 }, (_, i) => String(48210000 + i * 37)));
  const dates = lines(Array.from({ length: 9 }, (_, i) => String(20261102 + i)));
  const ids = lines(["A1B2C3D4", "E5F6G7H8", "J9K0L1M2", "N3P4Q5R6", "S7T8U9V0", "W1X2Y3Z4", "AB12CD34", "EF56GH78"]);
  const quiet = {
    "a seed label 90K before the phrase":
      "My seed phrase is below.\n" + prose(90000) + SEED_TEST_VECTOR + "\n" + prose(500),
    "a seed label 60K after the phrase":
      prose(10000) + SEED_TEST_VECTOR + "\n" + prose(60000) + "\nThat list above is my seed phrase.\n" + prose(5000),
    "codes 60K after their title": "Recovery codes for my account\n" + prose(60000) + SEED_CODES + prose(2000),
    "codes titled 70K later":
      prose(2000) + SEED_CODES + prose(70000) + "\nThose are my recovery codes.\n" + prose(2000),
    "2FA, then commits": "Remember to turn on 2FA codes for the org.\n" + prose(60000) + shas + prose(3000),
    "commits, then 2FA": "git rev-list output:" + shas + log(70000) + "WARN user disabled 2FA codes\n" + log(2000),
    "códigos, then orders": "Guardé los códigos de respaldo en el cajón.\n" + prose(60000) + orders + prose(2000),
    "backup keys, then dates": "Rotate the backup keys every quarter.\n" + prose(60000) + dates + prose(3000),
    "recovery keys, then IDs": "Our BitLocker recovery keys are in the vault.\n" + prose(60000) + ids + prose(3000),
    "a bip39 library":
      "const { mnemonicToSeed } = require('./index');\n" + code(60000) + "\nmodule.exports = " + JSON.stringify(words),
    "a server log with one MFA mention":
      log(150000) + "INFO MFA codes regenerated for user 42\n" + log(150000) + "Invoice numbers" + orders + log(20000),
  };
  // Only these two kinds: the log on its own reads a piece of a line at a seam as a phone number, as it always has.
  const loud = Object.entries(quiet)
    .map(([name, text]) => [name, seamKinds(text).replace(/,?phone_number:\d+/, "")])
    .filter(([, found]) => found);
  assert.deepEqual(loud, []);
});

// The seam check for labelled kinds (detector.js' seamRescue) must cost next to nothing: a 1 MB paste of prose with
// one emoji in it (so it isn't plain ASCII and has to be cleaned) and a seed label at its end takes about as long and
// as much memory as with those kinds' labels unmarked, which turns the check off, the way a large paste was read
// before it.
test("a 1 MB paste with an emoji and a label costs about what it did before the seam check for labels", () => {
  const paste = String.raw`
    const line = "The weather was mild today, so we walked to the market and bought apples, bread and some cheese ok.\n";
    const size = 1000000;
    const plain = line.repeat(Math.ceil(size / line.length)).slice(0, size);
    const text = plain.slice(0, size / 2) + "\u{1F600}" + plain.slice(size / 2) + "Ask me about my seed phrase.\n";
  `;
  const run = (source) => {
    const child = spawnSync(process.execPath, ["-e", source], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout);
  };
  // Memory, in a fresh process each, with and without the seam check.
  const memory = (labels) =>
    run(String.raw`
      require("./extension/patterns.js");
      require("./extension/detector.js");
      const { PATTERNS, detect } = globalThis.Clotr;
      if (!${labels}) for (const pattern of PATTERNS) delete pattern.labelAnywhere;
      ${paste}
      const found = detect(text);
      process.stdout.write(JSON.stringify({ rss: process.memoryUsage().rss / 1e6, found: found.length }));
    `);
  const withLabels = memory(true);
  const without = memory(false);
  assert.equal(withLabels.found, 0);
  assert.ok(
    withLabels.rss <= without.rss * 1.15 + 15,
    `${Math.round(withLabels.rss)} MB with the seam check, ${Math.round(without.rss)} MB without`,
  );
  // Time, best of alternating runs in one process, measured again before calling it slow.
  const timing = run(String.raw`
    require("./extension/patterns.js");
    require("./extension/detector.js");
    const { bestOfPair, grewEveryTime } = require("./tests/timing.js");
    const { PATTERNS, detect } = globalThis.Clotr;
    ${paste}
    const labelled = PATTERNS.filter((pattern) => pattern.labelAnywhere);
    const labels = labelled.map((pattern) => pattern.labelAnywhere);
    const without = () => {
      for (const pattern of labelled) delete pattern.labelAnywhere;
      try {
        detect(text);
      } finally {
        labelled.forEach((pattern, i) => (pattern.labelAnywhere = labels[i]));
      }
    };
    const slow = grewEveryTime(
      () => bestOfPair(without, () => detect(text), 1, 3),
      (base, now) => now.wall > base.wall * 1.1,
    );
    process.stdout.write(JSON.stringify(slow && { base: slow[0].wall, now: slow[1].wall }));
  `);
  assert.equal(timing, null, `with the seam check: ${JSON.stringify(timing)} ms`);
});

test("a value next to a window's end is kept when the window after it can't finish", () => {
  const source = String.raw`
    require("./extension/patterns.js");
    require("./extension/detector.js");
    const { PATTERNS, detect, DETECT_WINDOW_CHARS } = globalThis.Clotr;
    const marker = "seam-marker-1234567890";
    let now = 0;
    let firstWindow = null;
    Date.now = () => now;
    console.info = () => {};
    PATTERNS.splice(0, PATTERNS.length, {
      id: "research_seam_rule",
      severity: "medium",
      find(text) {
        firstWindow ??= text;
        if (text !== firstWindow) {
          now += 10001; // the second window runs out of time before it finds anything
          return [];
        }
        return text.includes(marker) ? [marker] : [];
      },
    });
    const text = "x".repeat(DETECT_WINDOW_CHARS - 100) + marker + "y".repeat(DETECT_WINDOW_CHARS);
    const result = detect(text);
    process.stdout.write(JSON.stringify({ found: result.some((r) => r.matches.includes(marker)), truncated: result.truncated }));
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error?.code, undefined, child.error?.code || "child failed");
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { found: true, truncated: true });
});
