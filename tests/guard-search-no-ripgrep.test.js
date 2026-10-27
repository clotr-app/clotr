// Most machines have no ripgrep on PATH, since the assistants that search with it carry their own copy. Guard's search
// check must still tell a reachable secret file from an ignored one there, not let every search through.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const GUARD_DIR = path.join(__dirname, "..", "apps", "guard");
if (!fs.existsSync(path.join(GUARD_DIR, "dist", "clotr-engine.js"))) {
  const built = spawnSync(process.execPath, ["../../tools/engine-bundle.js", "--out", "dist/clotr-engine.js"], {
    cwd: GUARD_DIR,
    encoding: "utf8",
  });
  assert.strictEqual(built.status, 0, built.stderr);
}
const guard = require("../apps/guard/bin/clotr-guard.js");

function withoutRipgrep(t) {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const original = process.env.PATH;
  process.env.PATH = original
    .split(path.delimiter)
    .filter((dir) => dir && !fs.existsSync(path.join(dir, name)))
    .join(path.delimiter);
  t.after(() => {
    process.env.PATH = original;
  });
}

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-no-rg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

const grep = (root, extra = {}) =>
  guard.inspectRead(
    "claude",
    { tool_name: "Grep", tool_input: { pattern: "TOKEN", path: root, output_mode: "content", ...extra } },
    { cwd: root, searchWalkMaxMs: 10000 },
  );

test("without ripgrep, a content search that can reach .env is still stopped", (t) => {
  withoutRipgrep(t);
  const root = repo(t, { ".env": "TOKEN=not-used\n", "app.js": "// TOKEN\n" });
  const outcome = grep(root);
  assert.equal(outcome.action, "block");
  assert.equal(outcome.location, ".env");
  assert.equal(grep(root, { glob: "**/*.js" }).action, "allow");
  assert.equal(grep(root, { output_mode: "files_with_matches" }).action, "allow");
});

test("without ripgrep, a git-ignored .env doesn't stop the search", (t) => {
  withoutRipgrep(t);
  const root = repo(t, { ".env": "TOKEN=not-used\n", ".gitignore": ".env\n", "app.js": "// TOKEN\n" });
  assert.equal(grep(root).action, "allow");
});

test("without ripgrep, Gemini's read_many_files follows .geminiignore", (t) => {
  withoutRipgrep(t);
  const root = repo(t, { ".env": "TOKEN=not-used\n", ".geminiignore": ".env\n" });
  const readMany = (options = {}) =>
    guard.inspectRead(
      "gemini",
      { tool_name: "read_many_files", tool_input: { include: ["**/*"], useDefaultExcludes: false, ...options } },
      { cwd: root, searchWalkMaxMs: 10000 },
    ).action;
  assert.equal(readMany(), "allow");
  assert.equal(readMany({ file_filtering_options: { respect_gemini_ignore: false } }), "block");
});
