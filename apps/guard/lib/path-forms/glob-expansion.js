"use strict";
/* global require, module */

const fs = require("fs");
const path = require("path");
const { SEARCH_WALK_MAX_ENTRIES, SHELL_FOLDER_TOO_BIG } = require("../limits-and-messages.js");
const { budgetSpent, lookupsSpent, ShellCheckTooLong, checkShellDeadline, stopIfSpent } = require("../check-budget.js");
const { compileGlob, compiledGlobMatches } = require("./glob-matching.js");
const { remoteLocation } = require("./windows-paths.js");

// ---------- Glob expansion ----------

// A glob whose last part starts with a wildcard, in a folder without one: the only kind Guard once expanded,
// and the only kind it doesn't also judge by the secret names it could match (Bash's `*` matching `.env`
// reads nothing).
function broadShellGlob(pattern) {
  const slash = pattern.lastIndexOf("/");
  const folder = slash < 0 ? "" : pattern.slice(0, slash);
  return /^[*?]/.test(pattern.slice(slash + 1)) && !/[*?[\]{}$~`]/.test(folder);
}

// Whether a glob's folder of `count` entries can be matched, and if so it's charged to the budget. An
// operand's glob past SEARCH_WALK_MAX_ENTRIES is judged by name instead; a recursive reader's (`walk`) is
// charged to the walk's own budget, and past what's left of it the command is stopped, since the folders it
// matches couldn't all be walked.
function chargeGlobListing(budget, count, walk) {
  if (walk) {
    if (count > Math.max(budget.walkEntries, 0)) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
    budget.walkEntries -= count;
    return true;
  }
  if (count > SEARCH_WALK_MAX_ENTRIES) return false;
  if (budget) budget.entries -= count;
  return true;
}

// The paths a shell glob expands to, or null when Guard can't tell (see shellGlobReadsSecret). With `walk`,
// for a recursive reader's glob, a budget spent before it's matched stops the command instead (see
// chargeGlobListing).
function expandShellGlob(pattern, cwd, { posix, staysInFolder, budget }, walk = false) {
  const slash = pattern.lastIndexOf("/");
  const folder = slash < 0 ? "." : pattern.slice(0, slash) || "/";
  const name = pattern.slice(slash + 1);
  if (!staysInFolder || !/[*?[]/.test(name) || /[*?[\]{}$~`]/.test(folder)) return null;
  if (remoteLocation(folder, cwd)) return null;
  if (walk) stopIfSpent(budget);
  else if (budgetSpent(budget)) return null;
  const directory = path.resolve(cwd, folder);
  let listing = budget?.folders.get(directory);
  if (!listing) {
    try {
      listing = { entries: fs.readdirSync(directory) };
    } catch (error) {
      // A missing folder relative to the working one leaves the shell nothing to expand, so nothing is read.
      const missing =
        ["ENOENT", "ENOTDIR"].includes(error.code) && !path.isAbsolute(folder) && !/^[A-Za-z]:/.test(folder);
      listing = { entries: missing ? [] : null };
    }
    budget?.folders.set(directory, listing);
  }
  const { entries } = listing;
  if (!entries) return null;
  // The shell reads `[...]` as a class; trying the brackets too only adds names to check.
  const glob = shellNameGlob(name);
  if (!glob || !chargeGlobListing(budget, entries.length, walk)) return null;
  const matches = [];
  for (const entry of entries) {
    if (walk) {
      if (Date.now() >= budget.walkDeadline) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
    } else if (budget && Date.now() >= budget.deadline) return null;
    if (budget) checkShellDeadline(budget);
    // Bash's wildcards leave dotfiles out unless the name itself starts with the dot.
    if (posix && entry.startsWith(".") && !name.startsWith(".")) continue;
    if (glob.matches(entry)) matches.push(path.posix.join(folder, entry));
  }
  return matches;
}

// One part of a shell glob, compiled. compileGlob drops a leading `!` as a negation, as ignore files do; to
// Bash and PowerShell it's a letter, and cmd with delayed expansion drops it. So such a glob matches the
// names either reads.
function shellNameGlob(name) {
  const compiled = compileGlob(name, true);
  if (!compiled) return null;
  if (!name.startsWith("!")) return { matches: (entry) => compiledGlobMatches(compiled, entry) };
  const lettered = compileGlob(`?${name.slice(1)}`, true);
  function matchesEither(entry) {
    if (compiledGlobMatches(compiled, entry)) return true;
    return Boolean(lettered) && entry.startsWith("!") && compiledGlobMatches(lettered, entry);
  }
  return { matches: matchesEither };
}

// The paths a recursive reader's glob names, one folder level at a time, for the globs expandShellGlob leaves
// alone: `ke*`, `*/`, `n*/in*`. Folders are what such a reader walks; files it names were checked as its
// operands. Null when Guard can't tell within the walk's budget; with `walk`, a budget spent before it's done
// stops the command instead.
function expandFolderGlob(pattern, cwd, { posix, staysInFolder, budget }, walk = false) {
  if (!staysInFolder || !budget || /[{}$~`]/.test(pattern) || /^(?:\/|[A-Za-z]:)/.test(pattern)) return null;
  if (remoteLocation(pattern, cwd)) return null;
  const segments = pattern.split("/").filter(Boolean);
  if (segments.some((segment) => segment.includes("**"))) return null;
  let found = ["."];
  // A run of plain folders is joined on in one go: joined one at a time, a long path is read again for each.
  let plain = [];
  for (const [index, segment] of segments.entries()) {
    if (!/[*?[]/.test(segment)) {
      plain.push(segment);
      continue;
    }
    if (plain.length) {
      const run = plain.join("/");
      found = found.map((base) => path.posix.join(base, run));
      plain = [];
    }
    // Only folders lead on; the last level keeps every match, since the walk checks which are folders.
    const foldersOnly = index < segments.length - 1 || pattern.endsWith("/");
    const glob = shellNameGlob(segment);
    if (!glob) return null;
    const next = [];
    for (const base of found) {
      if (walk) stopIfSpent(budget);
      else if (budgetSpent(budget) || lookupsSpent(budget)) return null;
      checkShellDeadline(budget);
      const entries = typedEntries(path.resolve(cwd, base), budget);
      if (entries === null) return null;
      if (!chargeGlobListing(budget, entries.length, walk)) return null;
      for (const entry of entries) {
        if (posix && entry.name.startsWith(".") && !segment.startsWith(".")) continue;
        // A link may lead to a folder; the walk looks.
        if (foldersOnly && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (glob.matches(entry.name)) next.push(path.posix.join(base, entry.name));
      }
      // A recursive reader's matches are bounded by the entries charged for them.
      if (!walk && next.length > SEARCH_WALK_MAX_ENTRIES) return null;
    }
    found = next;
  }
  if (plain.length) found = found.map((base) => path.posix.join(base, plain.join("/")));
  return found;
}

// A folder's entries with their types, listed once a check, one lookup each; null when it can't be read. A
// folder that isn't there, or a file, has nothing in it for the shell to expand.
function typedEntries(directory, budget) {
  const key = `types\u0000${directory}`;
  let entries = budget.folders.get(key);
  if (entries !== undefined) return entries;
  budget.lookups -= 1;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    entries = [];
  }
  budget.folders.set(key, entries);
  return entries;
}

module.exports = {
  broadShellGlob,
  chargeGlobListing,
  expandShellGlob,
  shellNameGlob,
  expandFolderGlob,
};
