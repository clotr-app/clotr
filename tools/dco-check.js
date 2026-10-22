// The sign-off check on pull requests (.github/workflows/dco.yml). Every commit needs a Signed-off-by line with its
// author's own name and email, which is how a contributor certifies the Developer Certificate of Origin
// (https://developercertificate.org/): they wrote the change or have the right to send it under the project's license.
// Usage: node tools/dco-check.js <base sha> <head sha>, with PR_AUTHOR set to the login that opened the pull request.
"use strict";

const { execFileSync } = require("child_process");

// Commits that need no sign-off: the project's own account, whose code is already its own, and GitHub's bots, which
// sign off under a different address than they commit with, or not at all. A commit is exempt only when its author
// email is on this list *and* one of these accounts opened the pull request. Anyone can type someone else's email
// into a commit, but GitHub itself records who opened a pull request, so a stranger's one never skips the check.
const EXEMPT = [
  { login: "BilliamBaSH", email: "250773794+BilliamBaSH@users.noreply.github.com" },
  { login: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" },
  { login: "github-actions[bot]", email: "41898283+github-actions[bot]@users.noreply.github.com" },
];

// One record per commit and one field per part, split on the ASCII separators git's %x1e and %x1f print, which never
// turn up in a name, an email or a commit message.
const RECORD = "\u001e";
const FIELD = "\u001f";
const FORMAT = "%H%x1f%an%x1f%ae%x1f%P%x1f%B%x1e";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SIGN_OFF = /^[ \t]*signed-off-by:[ \t]*(.*?)[ \t]*<([^<>\n]*)>[ \t]*$/gim;

const sameName = (a, b) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const sameEmail = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function parseLog(text) {
  return text
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, name, email, parents, ...message] = record.split(FIELD);
      return { sha, name, email, parents: parents.split(" ").filter(Boolean), message: message.join(FIELD) };
    });
}

function signOffs(message) {
  return [...message.matchAll(SIGN_OFF)].map((m) => ({ name: m[1], email: m[2] }));
}

function isExempt(commit, prAuthor) {
  return EXEMPT.some((e) => e.login === prAuthor) && EXEMPT.some((e) => sameEmail(e.email, commit.email));
}

// What's wrong with one commit, or null when it passes. A merge commit (GitHub's "Update branch" makes them) only
// joins work that's checked on its own, so it passes without a line of its own.
function problem(commit, prAuthor) {
  if (commit.parents.length > 1 || isExempt(commit, prAuthor)) return null;
  const lines = signOffs(commit.message);
  if (!lines.length) return "has no Signed-off-by line";
  if (lines.some((s) => sameName(s.name, commit.name) && sameEmail(s.email, commit.email))) return null;
  const signed = lines.map((s) => `${s.name} <${s.email}>`).join(", ");
  return `is signed off by ${signed}, but its author is ${commit.name} <${commit.email}>`;
}

function check(commits, prAuthor) {
  return commits
    .map((commit) => ({ commit, problem: problem(commit, prAuthor) }))
    .filter((r) => r.problem)
    .map(({ commit, problem: what }) => ({
      sha: commit.sha,
      subject: commit.message.split("\n")[0],
      problem: what,
    }));
}

function readCommits(base, head, cwd) {
  for (const sha of [base, head]) {
    if (!SHA.test(sha || "")) throw new Error(`not a commit id: ${JSON.stringify(sha)}`);
  }
  const log = execFileSync("git", ["log", "--no-color", `--format=${FORMAT}`, `${base}..${head}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseLog(log);
}

function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const [base, head] = argv;
  const commits = readCommits(base, head, cwd);
  const failed = check(commits, env.PR_AUTHOR || "");
  if (!failed.length) {
    console.log(`[dco] ${commits.length} commit(s) checked, every one signed off by its author.`);
    return 0;
  }
  for (const f of failed) console.log(`[dco] ${f.sha.slice(0, 7)} "${f.subject}" ${f.problem}.`);
  console.log(
    [
      "",
      "[dco] Each commit needs a line like this at the end of its message, with the same name and email as its author:",
      "[dco]   Signed-off-by: Your Name <you@example.com>",
      "[dco] git writes it for you. Use `git commit -s` for a new commit, or sign every commit on your branch with",
      "[dco]   git rebase --signoff origin/main",
      "[dco] and then `git push --force-with-lease`. CONTRIBUTING.md explains what signing off means.",
    ].join("\n"),
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`[dco] ${e.message}`);
    process.exitCode = 2;
  }
}

module.exports = { EXEMPT, FORMAT, parseLog, signOffs, isExempt, problem, check, readCommits, main };
