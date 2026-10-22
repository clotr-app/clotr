// Tests for tools/dco-check.js, the sign-off check every pull request runs (.github/workflows/dco.yml).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { EXEMPT, parseLog, signOffs, check, readCommits, main } = require("../tools/dco-check.js");

const OWNER = EXEMPT.find((e) => e.login === "BilliamBaSH");
const DEPENDABOT = EXEMPT.find((e) => e.login === "dependabot[bot]");

let n = 0;
function commit(name, email, message, parents = ["a".repeat(40)]) {
  n++;
  return { sha: String(n).padStart(40, "0"), name, email, parents, message };
}

test("a commit signed off by its own author passes", () => {
  const c = commit("Sam Rivera", "sam@example.com", "Fix the tooltip\n\nSigned-off-by: Sam Rivera <sam@example.com>\n");
  assert.deepEqual(check([c], "samrivera"), []);
});

test("the sign-off ignores case and extra spaces in the name and email", () => {
  const c = commit("Sam Rivera", "Sam@Example.com", "Fix\n\nsigned-off-by:  sam  rivera   <sam@example.COM>  \n");
  assert.deepEqual(check([c], "samrivera"), []);
});

test("any one matching sign-off among several is enough", () => {
  const c = commit(
    "Sam Rivera",
    "sam@example.com",
    "Fix\n\nSigned-off-by: Lee Park <lee@example.com>\nSigned-off-by: Sam Rivera <sam@example.com>\n",
  );
  assert.deepEqual(check([c], "samrivera"), []);
});

test("a commit with no sign-off fails and says so", () => {
  const c = commit("Sam Rivera", "sam@example.com", "Fix the tooltip\n");
  const [failure] = check([c], "samrivera");
  assert.equal(failure.subject, "Fix the tooltip");
  assert.match(failure.problem, /no Signed-off-by line/);
});

test("a sign-off with someone else's email or name fails and names both", () => {
  const wrongEmail = commit("Sam Rivera", "sam@example.com", "A\n\nSigned-off-by: Sam Rivera <sam@work.example>\n");
  const wrongName = commit("Sam Rivera", "sam@example.com", "B\n\nSigned-off-by: Lee Park <sam@example.com>\n");
  const failures = check([wrongEmail, wrongName], "samrivera");
  assert.equal(failures.length, 2);
  assert.match(
    failures[0].problem,
    /signed off by Sam Rivera <sam@work\.example>, but its author is Sam Rivera <sam@example\.com>/,
  );
  assert.match(failures[1].problem, /signed off by Lee Park <sam@example\.com>/);
});

test("a sign-off line inside a sentence doesn't count", () => {
  const c = commit(
    "Sam Rivera",
    "sam@example.com",
    "Fix\n\nI forgot the Signed-off-by: Sam Rivera <sam@example.com> line\n",
  );
  assert.match(check([c], "samrivera")[0].problem, /no Signed-off-by line/);
});

test("the project's own account and the bots pass without a sign-off in their own pull requests", () => {
  assert.deepEqual(check([commit("BilliamBaSH", OWNER.email, "Clotr 1.6.0\n")], "BilliamBaSH"), []);
  const bump = commit(
    "dependabot[bot]",
    DEPENDABOT.email,
    "Bump x\n\nSigned-off-by: dependabot[bot] <support@github.com>\n",
  );
  assert.deepEqual(check([bump], "dependabot[bot]"), []);
});

test("an exempt author's email in a stranger's pull request still needs a sign-off", () => {
  // Anyone can put the owner's address on a commit; only GitHub decides who opened the pull request.
  const spoofed = commit("BilliamBaSH", OWNER.email, "Looks like the owner's\n");
  assert.equal(check([spoofed], "stranger").length, 1);
  assert.equal(check([spoofed], "").length, 1);
});

test("an exempt pull request still checks a contributor's commits inside it", () => {
  const theirs = commit("Sam Rivera", "sam@example.com", "Their fix\n");
  const mine = commit("BilliamBaSH", OWNER.email, "My follow-up\n");
  const failures = check([theirs, mine], "BilliamBaSH");
  assert.deepEqual(
    failures.map((f) => f.subject),
    ["Their fix"],
  );
});

test("a merge commit passes without its own sign-off", () => {
  const merge = commit("Sam Rivera", "sam@example.com", "Merge branch 'main' into fix\n", [
    "a".repeat(40),
    "b".repeat(40),
  ]);
  assert.deepEqual(check([merge], "samrivera"), []);
});

test("parseLog reads git's records, multi-line messages included", () => {
  const log =
    `${"1".repeat(40)}\u001fSam Rivera\u001fsam@example.com\u001f${"a".repeat(40)}\u001fFirst line\n\nBody\n\nSigned-off-by: Sam Rivera <sam@example.com>\n\u001e\n` +
    `${"2".repeat(40)}\u001fLee Park\u001flee@example.com\u001f${"a".repeat(40)} ${"b".repeat(40)}\u001fMerge\n\u001e\n`;
  const [first, second] = parseLog(log);
  assert.equal(first.name, "Sam Rivera");
  assert.deepEqual(signOffs(first.message), [{ name: "Sam Rivera", email: "sam@example.com" }]);
  assert.equal(second.parents.length, 2);
});

test("on a real repository, git's own -s passes and a plain commit fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-dco-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Sam Rivera");
  git("config", "user.email", "sam@example.com");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "Start");
  const base = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-s", "-m", "Signed off");
  const signed = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "Not signed off");
  const head = git("rev-parse", "HEAD");

  assert.equal(readCommits(base, head, dir).length, 2);
  const log = t.mock.method(console, "log", () => {});
  assert.equal(main([base, signed], { PR_AUTHOR: "samrivera" }, dir), 0);
  assert.equal(main([base, head], { PR_AUTHOR: "samrivera" }, dir), 1);
  assert.ok(log.mock.calls.some((c) => /"Not signed off" has no Signed-off-by line/.test(c.arguments[0])));
});

test("only commit ids reach git", () => {
  assert.throws(() => readCommits("--output=x", "a".repeat(40), "."), /not a commit id/);
  assert.throws(() => readCommits("main", "a".repeat(40), "."), /not a commit id/);
});
