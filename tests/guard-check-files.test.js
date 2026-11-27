// `clotr-guard check` with more than one file checks every file, not just the first. The sample key is put together at
// run time, so this file holds no whole made-up credential.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Guard loads the engine from its own bundle, which npm's prepack builds; build it here when it's missing.
const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.strictEqual(built.status, 0, built.stderr);
}

const SCRIPT = path.join(GUARD_DIR, "bin", "clotr-guard.js");
const SAMPLE_KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");
const FINDING = "aws_access_key: AK…3N";

// A folder with a clean file and a file holding the sample key, removed after the test.
function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-check-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "meeting notes, nothing here\n");
  fs.writeFileSync(path.join(dir, "has-key.txt"), `key = ${SAMPLE_KEY}\n`);
  fs.writeFileSync(path.join(dir, "other-key.txt"), `backup = ${SAMPLE_KEY}\n`);
  return dir;
}

function check(dir, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "check", ...args], { cwd: dir, encoding: "utf8" });
}

test("check finds a key in the second of two files", (t) => {
  const result = check(files(t), "notes.txt", "has-key.txt");
  assert.strictEqual(result.status, 1, result.stderr);
  assert.strictEqual(result.stdout, `has-key.txt: ${FINDING}\n`);
});

test("check finds a key in the first of two files", (t) => {
  const result = check(files(t), "has-key.txt", "notes.txt");
  assert.strictEqual(result.status, 1, result.stderr);
  assert.strictEqual(result.stdout, `has-key.txt: ${FINDING}\n`);
});

test("check reports a key in both files, in the order given", (t) => {
  const result = check(files(t), "other-key.txt", "has-key.txt");
  assert.strictEqual(result.status, 1, result.stderr);
  assert.strictEqual(result.stdout, `other-key.txt: ${FINDING}\nhas-key.txt: ${FINDING}\n`);
});

test("check with two clean files prints nothing and exits 0", (t) => {
  const dir = files(t);
  fs.writeFileSync(path.join(dir, "more.txt"), "a shopping list\n");
  const result = check(dir, "notes.txt", "more.txt");
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("check names a missing second file and still checks the first", (t) => {
  const result = check(files(t), "has-key.txt", "missing.txt");
  assert.strictEqual(result.status, 2);
  assert.strictEqual(result.stdout, `has-key.txt: ${FINDING}\n`);
  assert.match(result.stderr, /couldn't check missing\.txt/);
});

test("check after a missing first file still checks the second", (t) => {
  const result = check(files(t), "missing.txt", "has-key.txt");
  assert.strictEqual(result.status, 2);
  assert.strictEqual(result.stdout, `has-key.txt: ${FINDING}\n`);
  assert.match(result.stderr, /couldn't check missing\.txt/);
});

test("check --json takes one file", (t) => {
  const result = check(files(t), "--json", "notes.txt", "has-key.txt");
  assert.strictEqual(result.status, 2);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, /--json.*one file/);
});

// The one-file case is what check printed before it took more than one file, byte for byte.
test("check with one file prints and exits as before", (t) => {
  const dir = files(t);
  const cases = [
    [["notes.txt"], 0, "", ""],
    [["has-key.txt"], 1, `${FINDING}\n`, ""],
    [["missing.txt"], 2, "", "Clotr couldn't check this text.\n"],
    [
      ["--json", "has-key.txt"],
      1,
      '{"findings":[{"kind":"aws_access_key","label":"AWS Access Key","severity":"high","masked":"AK…3N",' +
        '"start":6,"end":26}],"decision":"block"}\n',
      "",
    ],
    [["--json", "notes.txt"], 0, '{"findings":[],"decision":"allow"}\n', ""],
  ];
  for (const [args, status, stdout, stderr] of cases) {
    const result = check(dir, ...args);
    assert.deepStrictEqual([result.status, result.stdout, result.stderr], [status, stdout, stderr], args.join(" "));
  }
});

test("check with no file reads stdin as before", (t) => {
  const dir = files(t);
  const found = spawnSync(process.execPath, [SCRIPT, "check"], {
    cwd: dir,
    input: `key ${SAMPLE_KEY}`,
    encoding: "utf8",
  });
  assert.deepStrictEqual([found.status, found.stdout, found.stderr], [1, `${FINDING}\n`, ""]);
  const clean = spawnSync(process.execPath, [SCRIPT, "check"], { cwd: dir, input: "hello", encoding: "utf8" });
  assert.deepStrictEqual([clean.status, clean.stdout, clean.stderr], [0, "", ""]);
});

// UTF-16 files without a byte order mark that `check` used to give up on, answering that it couldn't check them.
// Each is one way such a file is written. The keys come from the made-up set, so this file holds none.
const { makeSecrets } = require("./fixtures/secrets.js");
const MADE_UP = Object.fromEntries(makeSecrets().map(({ kind, value }) => [kind, value]));
const AWS_KEY = MADE_UP.aws_access_key;
const STRIPE_KEY = MADE_UP.stripe_secret_key;
const le = (text) => Buffer.from(text, "utf16le");
const be = (text) => Buffer.from(text, "utf16le").swap16();
const utf8 = (text) => Buffer.from(text, "utf8");

// Checks one file of these bytes. It must be found, with each key shown only masked.
function checkBytes(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-check-utf16-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "data.txt"), bytes);
  return check(dir, "data.txt");
}

function assertFound(result, ...keys) {
  assert.strictEqual(result.status, 1, result.stderr);
  for (const key of keys) {
    assert.ok(result.stdout.includes(`…${key.slice(-2)}`), `masked key ending ${key.slice(-2)} in ${result.stdout}`);
    assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key), "a full key was shown");
  }
}

test("check finds a key in a UTF-16 file without a mark that has a UTF-8 line added", (t) => {
  // An odd number of UTF-8 bytes after the UTF-16, as `echo ... >>` from another tool adds.
  const bytes = Buffer.concat([le("# settings\r\nREGION=eu-west-1\r\n"), utf8(`AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)]);
  assertFound(checkBytes(t, bytes), AWS_KEY);
});

test("check finds a key in a UTF-16 file without a mark that is mostly Hindi", (t) => {
  const text = `AWS_ACCESS_KEY_ID=${AWS_KEY}\r\nयह फ़ाइल सेटिंग्स रखती है और इसमें कुछ और नहीं है\r\n`;
  assertFound(checkBytes(t, le(text)), AWS_KEY);
});

test("check finds a key in a big-endian UTF-16 file without a mark", (t) => {
  assertFound(checkBytes(t, be(`# settings\r\nAWS_ACCESS_KEY_ID=${AWS_KEY}\r\nREGION=eu-west-1\r\n`)), AWS_KEY);
});

test("check finds keys in a UTF-8 log with a run of UTF-16 lines in it", (t) => {
  const log = (from, to) =>
    Array.from({ length: to - from }, (_, step) => `2026-11-10 10:${String(from + step).padStart(2, "0")}:00 step\n`);
  const bytes = Buffer.concat([
    utf8(log(0, 20).join("")),
    le(`${log(20, 30).join("")}STRIPE_KEY=${STRIPE_KEY}\n`),
    utf8(`${log(30, 40).join("")}AWS_ACCESS_KEY_ID=${AWS_KEY}\n`),
  ]);
  assertFound(checkBytes(t, bytes), AWS_KEY, STRIPE_KEY);
});

test("check finds a key in a UTF-16 Japanese file without a mark that has a UTF-8 line added", (t) => {
  // Japanese UTF-16 holds a zero byte only in its few ASCII characters.
  const bytes = Buffer.concat([le("# 設定ファイル\r\n名前=東京の設定です"), utf8(`AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)]);
  assertFound(checkBytes(t, bytes), AWS_KEY);
});

test("check still says it couldn't check those files when they hold no key", (t) => {
  const clean = [
    Buffer.concat([le("# settings\r\nREGION=eu-west-1\r\n"), utf8("MODE=dev\nLOG=info\nCOLOR=auto\n")]),
    le("यह फ़ाइल सेटिंग्स रखती है और इसमें कुछ और नहीं है\r\n"),
    be("# settings\r\nREGION=eu-west-1\r\n"),
    Buffer.concat([le("# 設定ファイル\r\n名前=東京の設定です"), utf8("MODE=dev\n")]),
  ];
  for (const bytes of clean) {
    const result = checkBytes(t, bytes);
    assert.deepStrictEqual([result.status, result.stdout], [2, ""], result.stderr);
  }
});

// 16-bit binaries whose zero bytes sit almost all on one side of each byte pair, like unmarked UTF-16. `check` gives
// up on them, and must do it without reading them as UTF-16 first: the engine took a third of a second on the text
// that reading made of a 1 MiB WAV. The samples are built here.
const { readUnmarkedUtf16 } = require("../apps/guard/lib/text-checks/text-decode.js");

function samples16(count, value, bigEndian = false) {
  const bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    if (bigEndian) bytes.writeUInt16BE(value(index) & 0xffff, index * 2);
    else bytes.writeUInt16LE(value(index) & 0xffff, index * 2);
  }
  return bytes;
}

// A quiet mono WAV: a RIFF header, then small 16-bit samples, so most high bytes are zero.
function quietWav(size) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(size - 8, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(size - 44, 40);
  return Buffer.concat([header, samples16((size - 44) / 2, (index) => Math.round(40 * Math.sin(index / 7)) + 1)]);
}

function assertGivesUp(t, bytes) {
  assert.strictEqual(readUnmarkedUtf16(bytes).text, undefined, "read as unmarked UTF-16");
  const result = checkBytes(t, bytes);
  assert.deepStrictEqual([result.status, result.stdout], [2, ""], result.stderr);
}

test("check gives up on a quiet 16-bit WAV without reading it as UTF-16", (t) => {
  assertGivesUp(t, quietWav(256 * 1024));
});

test("check gives up on big-endian 16-bit gray pixels without reading them as UTF-16", (t) => {
  assertGivesUp(
    t,
    samples16(128 * 1024, (index) => 200 + ((index * 7) % 60), true),
  );
});

test("check still finds a key line added after a quiet 16-bit WAV", (t) => {
  const bytes = Buffer.concat([quietWav(64 * 1024), utf8(`LIST AWS_ACCESS_KEY_ID=${AWS_KEY}\n`)]);
  assertFound(checkBytes(t, bytes), AWS_KEY);
});
