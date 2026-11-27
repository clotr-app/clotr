// How Guard loads the engine: from the compiled code it saved last time when that code is safe to use, and with a
// plain load, giving the same answers, whenever it isn't.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}
const { loadEngine, codeFolder, ENGINE_PATH } = require("../apps/guard/lib/text-checks/engine-loader.js");

const BYTES = fs.readFileSync(ENGINE_PATH);
const POSIX = typeof process.getuid === "function";
// Made-up values only: a key in the documented AWS shape, a test card number and an address at a reserved domain.
const MADE_UP_KEY = ["AKIA", "4HPQ7XZ2R6TWLJ3N"].join("");
const TEXTS = [
  "npm test",
  `aws_access_key_id = ${MADE_UP_KEY}`,
  "my card is 4111 1111 1111 1111, exp 12/30",
  "write to jo.example@example.com about the invoice",
  "four one one one, one one one one, one one one one, one one one one",
];

function folder() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), "guard-engine-load-"));
  fs.chmodSync(made, 0o700);
  return made;
}
const answers = (context) => TEXTS.map((text) => JSON.stringify(context.Clotr.detect(text)));
const savedFile = (dir) => path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith("engine-code-")) || "-");
let plainAnswers;
function plain() {
  if (!plainAnswers) plainAnswers = answers(loadEngine(BYTES, { folder: null }).context);
  return plainAnswers;
}
// One load that saves its code, so a later load in the same folder can use it.
function saveOnce(dir) {
  const first = loadEngine(BYTES, { folder: dir });
  first.context.Clotr.detect("npm test");
  first.save();
  return savedFile(dir);
}

test("with nothing saved, a plain load saves its code once it has checked, and the next load uses it", () => {
  const dir = folder();
  const first = loadEngine(BYTES, { folder: dir });
  assert.equal(first.used, false);
  assert.deepEqual(answers(first.context), plain());
  first.save();
  const file = savedFile(dir);
  assert.ok(fs.existsSync(file), "the code is saved");
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const second = loadEngine(BYTES, { folder: dir });
  assert.equal(second.used, true);
  assert.deepEqual(answers(second.context), plain());
});

test("the saved file holds compiled code, never text Guard checked", () => {
  const dir = folder();
  const first = loadEngine(BYTES, { folder: dir });
  const checked = `deploy with ${MADE_UP_KEY} and pin 739164 for jo.example@example.com`;
  first.context.Clotr.detect(checked);
  first.save();
  const bytes = fs.readFileSync(savedFile(dir));
  for (const piece of [MADE_UP_KEY, "739164", "jo.example@example.com", "deploy with"]) {
    for (const encoding of ["utf8", "utf16le", "latin1"]) {
      assert.equal(bytes.includes(Buffer.from(piece, encoding)), false, `${piece} in ${encoding}`);
    }
  }
});

test("the saved file is named for this Node and carries the engine's hash", () => {
  const dir = folder();
  const file = saveOnce(dir);
  assert.ok(path.basename(file).includes(process.version), path.basename(file));
  const hash = require("node:crypto").createHash("sha256").update(BYTES).digest("hex");
  const header = fs.readFileSync(file).subarray(0, 300).toString("latin1");
  assert.ok(header.includes(hash) && header.includes(process.version), "the header names the engine and Node");
});

test("an empty, cut-short or broken file falls back to a plain load, and is saved again whole", () => {
  for (const spoil of [
    () => Buffer.alloc(0),
    (whole) => whole.subarray(0, 40),
    (whole) => whole.subarray(0, Math.floor(whole.length / 2)),
    (whole) => {
      const broken = Buffer.from(whole);
      broken.fill(0x41, broken.length - 5000);
      return broken;
    },
  ]) {
    const dir = folder();
    const file = saveOnce(dir);
    fs.writeFileSync(file, spoil(fs.readFileSync(file)), { mode: 0o600 });
    const loaded = loadEngine(BYTES, { folder: dir });
    assert.equal(loaded.used, false);
    assert.deepEqual(answers(loaded.context), plain());
    loaded.save();
    assert.equal(loadEngine(BYTES, { folder: dir }).used, true, "saved again whole");
  }
});

test("a file from another Node version or for another engine isn't used", () => {
  const dir = folder();
  const file = saveOnce(dir);
  const whole = fs.readFileSync(file);
  const end = whole.indexOf(0x0a) + 1;
  const header = whole.subarray(0, end).toString("latin1");
  const hash = require("node:crypto").createHash("sha256").update(BYTES).digest("hex");
  for (const changed of [header.replace(process.version, "v20.0.0"), header.replace(hash, "0".repeat(64))]) {
    fs.writeFileSync(file, Buffer.concat([Buffer.from(changed, "latin1"), whole.subarray(end)]), { mode: 0o600 });
    const loaded = loadEngine(BYTES, { folder: dir });
    assert.equal(loaded.used, false, changed);
    assert.deepEqual(answers(loaded.context), plain());
  }
  // The same file for a different engine: a changed byte in the bundle changes its hash.
  fs.writeFileSync(file, whole, { mode: 0o600 });
  const other = Buffer.concat([BYTES, Buffer.from("\n// one more line\n")]);
  assert.equal(loadEngine(other, { folder: dir }).used, false);
});

test("another user's file isn't used", { skip: !POSIX && "no user ids here" }, () => {
  const dir = folder();
  saveOnce(dir);
  assert.equal(loadEngine(BYTES, { folder: dir, uid: process.getuid() + 1 }).used, false, "as seen by another user");
  if (process.getuid() === 0) {
    const file = savedFile(dir);
    fs.chownSync(file, 12345, 12345);
    const loaded = loadEngine(BYTES, { folder: dir });
    assert.equal(loaded.used, false, "a file that belongs to someone else");
    assert.deepEqual(answers(loaded.context), plain());
  }
});

test(
  "a file or folder others can write is never used, and nothing is saved into such a folder",
  {
    skip: !POSIX && "no mode bits here",
  },
  () => {
    const dir = folder();
    const file = saveOnce(dir);
    fs.chmodSync(file, 0o622);
    assert.equal(loadEngine(BYTES, { folder: dir }).used, false, "a file others can write");
    fs.chmodSync(file, 0o600);
    assert.equal(loadEngine(BYTES, { folder: dir }).used, true);
    fs.chmodSync(dir, 0o777);
    assert.equal(loadEngine(BYTES, { folder: dir }).used, false, "a folder others can write");
    fs.rmSync(file);
    const loaded = loadEngine(BYTES, { folder: dir });
    loaded.save();
    assert.equal(fs.readdirSync(dir).length, 0, "nothing saved into it");
    // A folder inside one that others can write, and that isn't sticky, could be swapped for another.
    const open = fs.mkdtempSync(path.join(os.tmpdir(), "guard-engine-open-"));
    fs.chmodSync(open, 0o777);
    const inner = path.join(open, "guard");
    fs.mkdirSync(inner, { mode: 0o700 });
    const again = loadEngine(BYTES, { folder: inner });
    again.save();
    assert.equal(fs.readdirSync(inner).length, 0, "nothing saved under an open folder");
  },
);

test("a link at the saved file's place, or a linked folder, isn't followed", () => {
  const real = folder();
  const file = saveOnce(real);
  const dir = folder();
  try {
    fs.symlinkSync(file, path.join(dir, path.basename(file)));
  } catch (error) {
    if (process.platform === "win32") return; // making a link needs a privilege there
    throw error;
  }
  const loaded = loadEngine(BYTES, { folder: dir });
  assert.equal(loaded.used, false, "a linked file");
  assert.deepEqual(answers(loaded.context), plain());
  const linkedFolder = path.join(folder(), "guard");
  fs.symlinkSync(real, linkedFolder);
  assert.equal(loadEngine(BYTES, { folder: linkedFolder }).used, false, "a linked folder");
});

test("a folder that can't be written leaves the load and its answers as they are", () => {
  const blocker = path.join(folder(), "a-file");
  fs.writeFileSync(blocker, "");
  const loaded = loadEngine(BYTES, { folder: path.join(blocker, "guard") });
  assert.deepEqual(answers(loaded.context), plain());
  assert.doesNotThrow(() => loaded.save());
});

// A home of the test's own, so Guard's default data folder is a fresh one inside it, on every system.
function homeEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") };
  delete env.CLOTR_GUARD_DATA_DIR;
  delete env.XDG_STATE_HOME;
  return env;
}
function defaultFolder(home) {
  if (process.platform === "win32") return path.join(home, "AppData", "Local", "Clotr", "guard");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Clotr", "guard");
  return path.join(home, ".local", "state", "clotr", "guard");
}

function hook(home, command) {
  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    cwd: home,
    tool_name: "Bash",
    tool_input: { command },
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(GUARD_DIR, "bin", "clotr-guard.js"), "shell", "claude"], {
      cwd: home,
      env: homeEnv(home),
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test("two hooks starting together with nothing saved both answer, and leave one whole saved file", async () => {
  const dir = folder();
  const command = `echo ${MADE_UP_KEY}`;
  const [a, b] = await Promise.all([hook(dir, command), hook(dir, command)]);
  assert.equal(a.code, 0);
  assert.equal(a.out, b.out);
  assert.match(a.out, /"permissionDecision":"(ask|deny)"/);
  const state = defaultFolder(dir);
  assert.deepEqual(
    fs.readdirSync(state).filter((name) => name.startsWith("engine-code-") || name.endsWith(".tmp")).length,
    1,
  );
  assert.equal(loadEngine(BYTES, { folder: state }).used, true);
  const third = await hook(dir, command);
  assert.equal(third.out, a.out);
});

// Loads the engine as a hook does, from the folder Guard picks itself, in a new process with this folder and these
// settings. Says whether saved code was used.
function hookLoad(cwd, env) {
  const code = `const { loadEngine, ENGINE_PATH } = require(${JSON.stringify(path.join(GUARD_DIR, "lib", "text-checks", "engine-loader.js"))});
const loaded = loadEngine(require("node:fs").readFileSync(ENGINE_PATH));
loaded.context.Clotr.detect("npm test");
loaded.save();
process.stdout.write(String(loaded.used));`;
  const run = spawnSync(process.execPath, ["-e", code], { cwd, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout === "true";
}

// A project as a clone or an unzip leaves it: the user's own folder and file, readable by others, holding a good saved
// file made somewhere else with this same Node.
function plantedProject(inner) {
  const project = folder();
  const good = saveOnce(folder());
  const place = path.join(project, inner);
  fs.mkdirSync(place, { recursive: true, mode: 0o755 });
  const planted = path.join(place, path.basename(good));
  fs.copyFileSync(good, planted);
  fs.chmodSync(planted, 0o644);
  return { project, planted, bytes: fs.readFileSync(planted) };
}
function assertNotUsed({ project, planted, bytes }, env) {
  for (const round of ["first", "second"]) assert.equal(hookLoad(project, env), false, `${round} load`);
  assert.deepEqual(fs.readFileSync(planted), bytes, "the planted file is left as it is");
  const beside = fs.readdirSync(path.dirname(planted)).filter((name) => name !== path.basename(planted));
  assert.deepEqual(beside, [], "nothing saved beside it");
  assert.equal(fs.existsSync(defaultFolder(env.HOME)), false, "nothing saved in the default folder either");
}

test("with nothing set, saved code goes in Guard's default data folder and is used from there", () => {
  const home = folder();
  const env = homeEnv(home);
  assert.equal(hookLoad(home, env), false);
  assert.ok(fs.readdirSync(defaultFolder(home)).some((name) => name.startsWith("engine-code-")));
  assert.equal(hookLoad(home, env), true);
});

test("a relative CLOTR_GUARD_DATA_DIR can't make Guard run code a project holds", () => {
  const planted = plantedProject(".clotr");
  assertNotUsed(planted, { ...homeEnv(folder()), CLOTR_GUARD_DATA_DIR: ".clotr" });
});

test("a CLOTR_GUARD_DATA_DIR set to a folder in a project isn't used for saved code either", () => {
  const planted = plantedProject(".clotr");
  assertNotUsed(planted, { ...homeEnv(folder()), CLOTR_GUARD_DATA_DIR: path.join(planted.project, ".clotr") });
});

test(
  "a relative XDG_STATE_HOME can't make Guard run code a project holds",
  { skip: ["win32", "darwin"].includes(process.platform) && "XDG_STATE_HOME isn't read here" },
  () => {
    const planted = plantedProject(path.join("state", "clotr", "guard"));
    assertNotUsed(planted, { ...homeEnv(folder()), XDG_STATE_HOME: "state" });
  },
);

test("the folder for saved code is the default one, worked out only from absolute paths", () => {
  const home = "/home/jo";
  assert.equal(codeFolder({}, "linux", home), "/home/jo/.local/state/clotr/guard");
  assert.equal(codeFolder({ XDG_STATE_HOME: "/var/jo" }, "linux", home), "/var/jo/clotr/guard");
  assert.equal(codeFolder({ XDG_STATE_HOME: "" }, "linux", home), "/home/jo/.local/state/clotr/guard");
  assert.equal(codeFolder({}, "darwin", home), "/home/jo/Library/Application Support/Clotr/guard");
  for (const env of [{ XDG_STATE_HOME: "state" }, { XDG_STATE_HOME: "./s" }, { CLOTR_GUARD_DATA_DIR: ".clotr" }]) {
    assert.equal(codeFolder(env, "linux", home), null, JSON.stringify(env));
  }
  assert.equal(codeFolder({ CLOTR_GUARD_DATA_DIR: "/home/jo/.clotr" }, "linux", home), null);
  assert.equal(codeFolder({}, "linux", "jo"), null, "a relative home");
  assert.equal(codeFolder({}, "darwin", ""), null, "no home");
  const win = "C:\\Users\\jo";
  assert.equal(
    codeFolder({ LOCALAPPDATA: `${win}\\AppData\\Local` }, "win32", win),
    `${win}\\AppData\\Local\\Clotr\\guard`,
  );
  assert.equal(codeFolder({}, "win32", win), `${win}\\AppData\\Local\\Clotr\\guard`);
  for (const local of ["AppData", "C:AppData", "\\AppData"]) {
    assert.equal(codeFolder({ LOCALAPPDATA: local }, "win32", win), null, local);
  }
  assert.equal(codeFolder({ LOCALAPPDATA: `${win}\\AppData\\Local`, CLOTR_GUARD_DATA_DIR: "x" }, "win32", win), null);
});

// V8 keeps compiled code for a source it has already seen in this process, so each load is timed in a new one.
function loadTime(dir) {
  const code = `const { loadEngine, ENGINE_PATH } = require(${JSON.stringify(path.join(GUARD_DIR, "lib", "text-checks", "engine-loader.js"))});
const bytes = require("node:fs").readFileSync(ENGINE_PATH);
const start = performance.now();
loadEngine(bytes, { folder: ${JSON.stringify(dir)} }).context.Clotr.detect("npm test");
process.stdout.write(String(performance.now() - start));`;
  return Number(spawnSync(process.execPath, ["-e", code], { encoding: "utf8" }).stdout);
}

test("a load from saved code is quicker than a plain load", () => {
  const dir = folder();
  saveOnce(dir);
  let plainBest = Infinity;
  let savedBest = Infinity;
  for (let i = 0; i < 3; i++) {
    plainBest = Math.min(plainBest, loadTime(null));
    savedBest = Math.min(savedBest, loadTime(dir));
  }
  assert.ok(savedBest < plainBest, `saved ${savedBest.toFixed(1)} ms, plain ${plainBest.toFixed(1)} ms`);
});

// Node's recursive mkdir never returns for a folder under /proc, which can't hold one, so a hook saving there ran to
// its deadline and stopped the command.
test("saving under a folder that can never hold one returns at once", { skip: process.platform !== "linux" }, () => {
  const code = `const { loadEngine, ENGINE_PATH } = require(${JSON.stringify(path.join(GUARD_DIR, "lib", "text-checks", "engine-loader.js"))});
const loaded = loadEngine(require("node:fs").readFileSync(ENGINE_PATH), { folder: "/proc/clotr-guard-test/guard" });
loaded.save();
process.stdout.write("saved");`;
  const run = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.stdout, "saved", run.error ? String(run.error) : run.stderr);
});

// Windows has no user ids or mode bits to check, so there the code is saved and used only inside the user's own
// profile folder, which only they can write unless they changed it. uid null stands for "no user ids here". The home
// here is the test's own: on Windows the temp folder sits inside the real one.
test("with no user ids, saved code is used only inside the user's own profile folder", () => {
  const top = folder();
  const home = path.join(top, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal(os.homedir(), home);
    // A folder beside the home, and one whose name only starts like it.
    for (const name of ["elsewhere", "home-not"]) {
      const outside = path.join(top, name);
      fs.mkdirSync(outside, { mode: 0o700 });
      saveOnce(outside);
      assert.equal(loadEngine(BYTES, { folder: outside, uid: null }).used, false, `${name} is outside the profile`);
      const empty = path.join(top, `${name}-empty`);
      fs.mkdirSync(empty, { mode: 0o700 });
      loadEngine(BYTES, { folder: empty, uid: null }).save();
      assert.deepEqual(fs.readdirSync(empty), [], `nothing saved in ${name}`);
    }
    saveOnce(home);
    assert.equal(loadEngine(BYTES, { folder: home, uid: null }).used, false, "not the profile folder itself");
    const inside = path.join(home, "inside");
    fs.mkdirSync(inside, { mode: 0o700 });
    loadEngine(BYTES, { folder: inside, uid: null }).save();
    assert.equal(loadEngine(BYTES, { folder: inside, uid: null }).used, true, "inside the profile");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
