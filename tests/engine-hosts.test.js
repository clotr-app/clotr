// The apps around the engine. Guard maps each finding to its place in the text whatever order the engine lists
// them in, so "press Enter again" always lets a repeated prompt through. ClotrHost and Guard pass on "part of this
// wasn't checked". detect() answers the same text twice without scanning it twice, Guard keeps one engine per
// process, and a 10 KB message stays inside a time limit set against the machine's speed.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
const { build } = require("../tools/engine-bundle.js");

const ROOT = path.join(__dirname, "..");
const GUARD_ENGINE = path.join(ROOT, "apps", "guard", "dist", "clotr-engine.js");
const BUNDLE = build().text;
if (!fs.existsSync(GUARD_ENGINE)) {
  fs.mkdirSync(path.dirname(GUARD_ENGINE), { recursive: true });
  fs.writeFileSync(GUARD_ENGINE, BUNDLE);
}
const guardEngine = require("../apps/guard/lib/engine.js");
const { inspectPrompt } = require("../apps/guard/bin/clotr-guard.js");

// Made-up values, built from parts so no file holds them whole.
const SSN_A = ["529", "41", "7736"].join("");
const SSN_B = ["614", "27", "3958"].join("-");
const PASS_A = ["Sun", "shine", "42x"].join("");
const PASS_B = ["Hun", "ter-", "77zz"].join("");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-hosts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A pattern that pretends to take longer than the engine's whole time limit, on a fake clock in the given realm.
// Returns the undo.
function stallEngine(realm) {
  const { Clotr, Date: RealmDate } = realm;
  const realNow = RealmDate.now;
  let now = realNow();
  RealmDate.now = () => now;
  const slow = {
    id: "test_stalled",
    severity: "low",
    name: "stalled",
    find: () => ((now += Clotr.DETECT_BACKSTOP_MS + 200), []),
  };
  Clotr.PATTERNS.push(slow);
  return () => {
    RealmDate.now = realNow;
    Clotr.PATTERNS.splice(Clotr.PATTERNS.indexOf(slow), 1);
  };
}

// ---------- Guard: positions don't depend on the order of matches ----------

test("Guard places every match at its own spot even when the engine lists a later one first", () => {
  const context = guardEngine.engineContext();
  const text = `first ${SSN_A}, then ${SSN_B}, and ${SSN_A} again`;
  const findings = guardEngine.findingsFromDetections(context, text, [
    { id: "us_ssn", name: "SSN", severity: "high", matches: [SSN_B, SSN_A] },
    { id: "bank_account", name: "Bank", severity: "high", matches: [SSN_A] },
  ]);
  assert.equal(findings.length, 3);
  for (const finding of findings) {
    assert.ok(finding.start >= 0, `${finding.kind} got no position`);
    assert.equal(
      finding.end - finding.start,
      finding.kind === "us_ssn" && finding.start > 20 ? SSN_B.length : SSN_A.length,
    );
  }
  const [b, a, again] = findings;
  assert.equal(text.slice(b.start, b.end), SSN_B);
  assert.equal(a.start, text.indexOf(SSN_A), "the earlier value is found from the start of the text");
  assert.equal(again.start, text.lastIndexOf(SSN_A), "a second report of one value takes its next copy");
});

// A value that is also part of a longer finding: a commit check reports the line a finding starts on, so the short
// one belongs on its own line, not inside the long one, whichever the engine lists first. When the short one is
// only ever inside the long one, it still gets that place rather than none.
test("Guard places a value that's also inside a longer finding at its own copy, wherever the engine lists it", () => {
  const context = guardEngine.engineContext();
  const long = `postgres://u:${PASS_A}@h.example`;
  const text = `first line ${long}\nsecond line ${PASS_A}\n`;
  for (const detections of [
    [
      { id: "password", name: "Password", severity: "high", matches: [PASS_A] },
      { id: "connection_string", name: "Connection", severity: "high", matches: [long] },
    ],
    [
      { id: "connection_string", name: "Connection", severity: "high", matches: [long] },
      { id: "password", name: "Password", severity: "high", matches: [PASS_A] },
    ],
  ]) {
    const findings = guardEngine.findingsFromDetections(context, text, detections);
    const at = Object.fromEntries(findings.map((finding) => [finding.kind, finding]));
    assert.equal(at.connection_string.start, text.indexOf(long));
    assert.equal(at.password.start, text.lastIndexOf(PASS_A), "the password was placed inside the longer finding");
    assert.equal(findings[0].kind, detections[0].id, "findings keep the engine's order");
  }
  const inside = `only ${long}\n`;
  const [password, connection] = guardEngine.findingsFromDetections(context, inside, [
    { id: "password", name: "Password", severity: "high", matches: [PASS_A] },
    { id: "connection_string", name: "Connection", severity: "high", matches: [long] },
  ]);
  assert.equal(connection.start, inside.indexOf(long));
  assert.equal(password.start, inside.indexOf(PASS_A), "a value only inside the longer one still gets that place");
});

test("Guard lets a repeated prompt through when the engine lists two SSNs out of order", (t) => {
  const dataDir = tempDir(t);
  // The phone keyboard's dot ("is. ") hides the first one from the first reading; the second reading adds it last.
  const prompt = `Her ssn is. ${SSN_A}, mine is ssn ${SSN_B}`;
  const options = { dataDir, includePersonalDetails: true, cwd: dataDir };
  const first = inspectPrompt("claude", prompt, { ...options, now: 10_000 });
  assert.equal(first.action, "block");
  assert.equal(first.findings.filter((f) => f.kind === "us_ssn").length, 2, "both SSNs should be found");
  assert.ok(
    first.findings.every((f) => f.start >= 0),
    "every finding needs a position",
  );
  const again = inspectPrompt("claude", prompt, { ...options, now: 11_000 });
  assert.equal(again.action, "allow", "the repeat within two minutes must go through");
  assert.equal(again.repeated, true);
});

test("Guard lets a repeated prompt through when a password is found only by the second reading", (t) => {
  const dataDir = tempDir(t);
  const prompt = `My password is. ${PASS_A} and the backup password: ${PASS_B}`;
  const first = inspectPrompt("claude", prompt, { dataDir, cwd: dataDir, now: 10_000 });
  assert.equal(first.action, "block");
  assert.equal(first.findings.filter((f) => f.kind === "password").length, 2);
  assert.equal(inspectPrompt("claude", prompt, { dataDir, cwd: dataDir, now: 11_000 }).action, "allow");
});

// ---------- "Part of this wasn't checked" ----------

test("Guard's check() reports a scan its time limit cut short, and a whole one stays unmarked", () => {
  assert.equal(guardEngine.check("nothing to see here").truncated, undefined);
  const undo = stallEngine(vm.runInContext("globalThis", guardEngine.engineContext()));
  let result;
  try {
    result = guardEngine.check("a message the engine runs out of time on");
  } finally {
    undo();
  }
  assert.equal(result.truncated, true);
  // Part of the text wasn't checked, so it isn't called clean.
  assert.equal(result.decision, "block");
});

test("clotr-guard check says when part of the text wasn't checked, in JSON and in words", (t) => {
  const dir = tempDir(t);
  // A preload stalls the engine the same way inside the CLI's own process.
  const preload = path.join(dir, "stall.js");
  fs.writeFileSync(
    preload,
    `const engine = require(${JSON.stringify(path.join(ROOT, "apps", "guard", "lib", "engine.js"))});
     const realm = require("node:vm").runInContext("globalThis", engine.engineContext());
     let now = realm.Date.now(); realm.Date.now = () => now;
     realm.Clotr.PATTERNS.push({ id: "test_stalled", severity: "low", name: "stalled",
       find: () => ((now += realm.Clotr.DETECT_BACKSTOP_MS + 200), []) });\n`,
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ["--require", preload, path.join(ROOT, "apps", "guard", "bin", "clotr-guard.js"), "check", ...args],
      {
        input: "a message the engine runs out of time on",
        cwd: dir,
        encoding: "utf8",
      },
    );
  // A text not checked to the end returns 1, as a finding does: a script must not take it as clean.
  const json = run("--json");
  assert.equal(json.status, 1, json.stderr);
  assert.equal(JSON.parse(json.stdout).truncated, true);
  assert.equal(JSON.parse(json.stdout).decision, "block");
  assert.match(json.stderr, /part of this text wasn't checked/i);
  const words = run();
  assert.equal(words.status, 1, words.stderr);
  assert.match(words.stderr, /part of this text wasn't checked/i);
});

// ---------- detect() remembers its last answer ----------

// Counts the rule runs of one probe pattern added for the test; returns { calls, undo }.
function probe() {
  const { PATTERNS } = globalThis.Clotr;
  const counter = { calls: 0 };
  const pattern = { id: "test_probe", severity: "low", name: "probe", find: () => (counter.calls++, []) };
  PATTERNS.push(pattern);
  counter.undo = () => PATTERNS.splice(PATTERNS.indexOf(pattern), 1);
  return counter;
}

test("detect() gives the same text's answer again without running any rule", () => {
  const { detect } = globalThis.Clotr;
  const counter = probe();
  try {
    const text = `send it to me at someone.made.up@example.org or call ${["555", "867", "5309"].join("-")}`;
    const first = detect(text);
    const ran = counter.calls;
    assert.ok(ran > 0);
    const second = detect(text);
    assert.equal(counter.calls, ran, "the second call ran the rules again");
    assert.deepEqual(
      second.map((r) => [r.id, r.name, r.severity, [...r.matches]]),
      first.map((r) => [r.id, r.name, r.severity, [...r.matches]]),
    );
    // Each caller gets its own copy: changing one answer leaves the next one whole.
    second[0].matches.length = 0;
    second.length = 0;
    const third = detect(text);
    assert.equal(counter.calls, ran);
    assert.deepEqual(
      third.map((r) => [r.id, [...r.matches]]),
      first.map((r) => [r.id, [...r.matches]]),
    );
    detect(`${text} `);
    assert.ok(counter.calls > ran, "a different text is scanned");
  } finally {
    counter.undo();
  }
});

test("detect() scans again after the rules, the vault or the kinds' names change", () => {
  const { detect, setVault, PATTERNS } = globalThis.Clotr;
  const text = "write to someone.made.up@example.org about the visit";
  const counter = probe();
  try {
    detect(text);
    let ran = counter.calls;
    setVault({ entries: [] });
    detect(text);
    assert.ok(counter.calls > ran, "a new vault didn't scan again");
    ran = counter.calls;
    const email = PATTERNS.find((p) => p.id === "email");
    const name = email.name;
    email.name = "Correo";
    try {
      assert.equal(detect(text).find((r) => r.id === "email")?.name, "Correo");
      assert.ok(counter.calls > ran, "renamed kinds didn't scan again");
    } finally {
      email.name = name;
    }
  } finally {
    counter.undo();
  }
  // The probe is gone, so the rules changed again: the answer no longer carries it.
  assert.equal(
    detect(text).some((r) => r.id === "test_probe"),
    false,
  );
});

test("detect() doesn't keep an answer its time limit cut short, and forget() clears the last one", () => {
  const { detect } = globalThis.Clotr;
  const text = "a message the engine runs out of time on, once";
  const undo = stallEngine(globalThis);
  let cut;
  try {
    cut = detect(text);
  } finally {
    undo();
  }
  assert.equal(cut.truncated, true);
  const counter = probe();
  try {
    const whole = detect(text);
    assert.notEqual(whole.truncated, true, "the cut-short answer was handed out again");
    const ran = counter.calls;
    assert.ok(ran > 0);
    detect.forget();
    detect(text);
    assert.ok(counter.calls > ran, "forget() didn't clear the last answer");
  } finally {
    counter.undo();
  }
});

// ---------- Speed ----------

// Ten thousand characters of everyday prose with sentence breaks (". "), the case the phone-dot reading doubles.
function prose(size) {
  const sentences = [
    "We met at the cafe on the corner and talked about the plans for the summer trip.",
    "She said the train leaves early, so we should pack the night before and sleep well.",
    "The weather looked fine for most of the week, with a little rain on Thursday afternoon.",
    "Can you send me the list of things to bring? I always forget the charger and a towel.",
    "Last time the hotel was lovely, but the walk to the beach took longer than we thought.",
    "My brother wants to come along too, if there is room in the car for one more bag.",
  ];
  let out = "";
  for (let i = 0; out.length < size; i++) out += `${sentences[i % sentences.length]} `;
  return out.slice(0, size);
}

// A fixed amount of plain regular-expression and string work on the same text, to measure the machine's speed at
// that moment. It takes about as long as a scan of it, so a busy or slow machine slows both alike.
const YARDSTICK = [
  /\b[A-Z][a-z]+\b/g,
  /\b\w+@\w+\.\w+\b/g,
  /\d{3}[-. ]?\d{4}/g,
  /\b(?:the|and|for)\b/gi,
  /[.!?]\s+/g,
  /\b\w{6,}\b/g,
  /(\w)\1/g,
  /\s{2,}/g,
];
function yardstick(text) {
  let sink = 0;
  for (let round = 0; round < 20; round++) {
    for (const pattern of YARDSTICK) {
      for (const match of text.matchAll(pattern)) sink += match.index;
    }
    sink += text
      .toLowerCase()
      .split(" ")
      .map((word) => word.replace(/[^a-z]/g, ""))
      .join("|").length;
  }
  return sink;
}

// A limit on the scan's own cost, not just on its growth: the median of nine fresh scans of 10 KB of prose, each
// measured against the yardstick run just before and just after it. A limit in milliseconds (40, about five times the
// 7.5 ms the scan took on an idle development PC) failed while the whole suite ran beside it, where the scan took 15 ms
// and more. Measured against the yardstick, the scan costs 1.6 to 1.8 times as much idle and 1.7 to 1.9 times under
// 26 busy processes, on any machine speed, so a limit of 4 catches the scan growing to more than about twice its cost.
test("10 KB of everyday prose scans inside a time limit set against the machine's speed", () => {
  const { detect } = globalThis.Clotr;
  const text = prose(10_000);
  const LIMIT = 4;
  const time = (fn) => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };
  detect.forget();
  detect(text); // warm up
  yardstick(text);
  const ratios = [];
  for (let i = 0; i < 9; i++) {
    const before = time(() => yardstick(text));
    detect.forget();
    const scan = time(() => detect(text));
    const after = time(() => yardstick(text));
    ratios.push(scan / ((before + after) / 2));
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  assert.ok(median < LIMIT, `10 KB prose took ${median.toFixed(2)} times the yardstick (median of 9), over ${LIMIT}`);
});

test("Guard keeps one engine for the whole process", () => {
  assert.equal(guardEngine.engineContext(), guardEngine.engineContext());
  const started = performance.now();
  for (let i = 0; i < 20; i++) guardEngine.check(`a short prompt number ${i}`);
  const each = (performance.now() - started) / 20;
  // Loading the engine costs tens of milliseconds; a warm check of a short prompt costs well under one.
  assert.ok(each < 15, `each check took ${each.toFixed(1)} ms; the engine is being loaded again`);
});

// ---------- Versions ----------

test("clotr-engine's package version is the version in its bundle's header", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "engine", "package.json"), "utf8"));
  const header = /^\/\/ Clotr engine (\d+(?:\.\d+){2,3}):/.exec(BUNDLE)?.[1];
  assert.ok(header, "the bundle header names no engine version");
  assert.equal(pkg.version, header);
});
