"use strict";
/* global require, module */

const { isSecretOperand } = require("../secret-paths/secret-path-check.js");
const { gitBashDriveRoot, pathReadings, listedPaths } = require("../path-forms/path-readings.js");
const { recursiveTargetKey, secretInRecursiveRead } = require("./recursive-read-check.js");

// ---------- Words to verdict ----------

// A reader's words without anything that looks like a redirection (`2>/dev/null`, `> out.txt`, `2>&1`,
// `&>log`, PowerShell's `2>$null` and `*>&1`), and a target in a word of its own after one; with `input`
// false, an input redirection (`< f`, `0<f`, `<<<`) is kept. This is a second reading of a reader's words,
// walked as well as the words as Guard always read them, never instead: what looks like a redirection reaches
// the reader as a word, or part of one, in some shell or wrapper (PowerShell's `0>` and `1<`, a quote,
// `eval`).
function withoutRedirections(args, { input = true } = {}) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const found = /^(?:\d+|\*|&)?(?:>>?|<)[&|]?/.exec(args[index]);
    if (!found || (!input && found[0].includes("<"))) kept.push(args[index]);
    else if (found[0] === args[index]) index += 1;
  }
  return kept;
}

// The words after a reader's words as Guard always read them (see firstReadingPass) when those end at a
// redirection of one stream to another or to a file (`2>&1`, `>&2`, `<&0`, `&>log`, `>|log`) rather than at
// the end of the command, up to the end of the line or the next `;`, `&`, `|`, `(`, `)` or backtick. They're
// only ever read as well as the reader's words, so the commands after them are still found as before.
function wordsPastRedirections(command, end) {
  let at = end;
  for (;;) {
    const unescaped = !/[\\^]/.test(command[at - 2] || "");
    const redirection =
      (command[at] === "&" && /[<>]/.test(command[at - 1] || "") && unescaped) ||
      (command[at] === "&" && command[at + 1] === ">") ||
      (command[at] === "|" && command[at - 1] === ">" && unescaped);
    if (!redirection) return command.slice(end, at);
    at += 1;
    while (at < command.length && !/[;&|()`\r\n\u2028\u2029]/.test(command[at])) at += 1;
  }
}

// The paths of a PowerShell list a word may name (see listedPaths): none in Git Bash, where a comma is part
// of a name.
function shellListedPaths(word, shellGlobs) {
  return shellGlobs.gitBash ? [] : listedPaths(word);
}

// Every path a word may open: as written, each path of a PowerShell list (see shellListedPaths), and each of
// those as the shell opens it (see pathReadings): `~/kj/config`.
function opensAs(word, shellGlobs) {
  const options = { gitBash: Boolean(shellGlobs.gitBash) };
  const each = [word, ...shellListedPaths(word, shellGlobs)];
  return [...new Set(each.flatMap((item) => [item, ...pathReadings(item, options)]))];
}

// Whether a reader's operand, as written or as any path it opens (see opensAs), is a secret file.
function secretOperandOpened(word, cwd, shellGlobs) {
  return opensAs(word, shellGlobs).some((reading) => isSecretOperand(reading, cwd, shellGlobs));
}

// The first secret file under the folders a recursive reader is given (see recursiveReadTargets), or null. A
// whole drive in Git Bash (`grep -r x /c`) is stopped by its name: walking it can't finish in time, and the
// letter may be a drive mapped to another computer, which Guard doesn't look up. A target named again (`rg x
// a a a ...`) is read once. Each folder of a PowerShell list is walked, and a folder under the home folder,
// or a Git Bash drive path, where the shell opens it (see opensAs).
function secretInReaderTargets(targets, reader, cwd, shellGlobs) {
  const driveRoot = shellGlobs.gitBash && targets.find((target) => gitBashDriveRoot(target.path));
  if (driveRoot) return driveRoot.path;
  const name = reader.toLowerCase();
  const unique = [...new Map(targets.map((target) => [recursiveTargetKey(name, target), target])).values()];
  const readingOptions = { gitBash: Boolean(shellGlobs.gitBash) };
  const withReadings = unique.flatMap((target) =>
    [target.path, ...shellListedPaths(target.path, shellGlobs)].flatMap((each, at) => {
      const base = at ? { ...target, path: each } : target;
      return [
        base,
        ...pathReadings(each, readingOptions).map((reading, index) => ({
          ...base,
          path: reading,
          glob: base.glob && (pathReadings(base.glob, readingOptions)[index] ?? base.glob),
        })),
      ];
    }),
  );
  return secretInRecursiveRead(withReadings, reader, cwd, shellGlobs);
}

// Where cmd could split a command that Bash and PowerShell don't. `caret`: a `^`, cmd's escape, outside
// quotes (inside them, as in grep '^import', it's a pattern's anchor). `midWord`: a single quote that opens
// mid-word, as in `type x' .env '`, whose blank space cmd splits at, since a single quote is a letter to cmd.
// One right after another quote, as in Bash's `'\''`, doesn't count. Each alternative starts with a different
// character, so the pattern can't backtrack. A handle copy with more after its digit (`<&1.env`, `>&2.env`),
// which cmd splits after the digit, counts as a `caret` too.
function cmdReadsDifferently(command) {
  let midWord = false;
  const bare = command.replace(/\\[^]|'[^']*'|"(?:[^"\\]|\\[^])*"/g, (quoted, at) => {
    if (quoted[0] === "'" && at > 0 && !/[\s;&|('"]/.test(command[at - 1])) midWord = true;
    return quoted[0] === "\\" ? quoted : " ";
  });
  return { caret: bare.includes("^") || /[<>]&\d[^\s;&|<>()]/.test(bare), midWord };
}

module.exports = {
  withoutRedirections,
  wordsPastRedirections,
  shellListedPaths,
  opensAs,
  secretOperandOpened,
  secretInReaderTargets,
  cmdReadsDifferently,
};
