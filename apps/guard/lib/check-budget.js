"use strict";
/* global require, module */

const {
  SHELL_WALK_MAX_ENTRIES,
  SHELL_WALK_MAX_MS,
  SHELL_TREE_WALK_MAX_ENTRIES,
  SHELL_OPERAND_MAX_LOOKUPS,
  SHELL_OPERAND_MAX_MS,
  SHELL_DRIVE_PATH_MAX_MS,
  SHELL_CHECK_MAX_MS,
  SHELL_TOO_MANY_PATHS,
  SHELL_FOLDER_TOO_BIG,
} = require("./limits-and-messages.js");

// One budget for all the disk reading a shell command's check does, so a command that names many folders or operands
// can't run the hook past its own timeout: the folder entries that glob expansions and recursive walks read, the
// operands and folders looked up one by one, and a deadline past which the check stops the command.
function shellWalkBudget(options = {}) {
  const now = Date.now();
  return {
    deadline: now + (options.searchWalkMaxMs || SHELL_WALK_MAX_MS),
    entries: options.searchWalkMaxEntries || SHELL_WALK_MAX_ENTRIES,
    // The recursive readers' own (see SHELL_TREE_WALK_MAX_ENTRIES); a test's limit sets both.
    walkDeadline: now + (options.searchWalkMaxMs ?? options.shellCheckMaxMs ?? SHELL_CHECK_MAX_MS),
    walkEntries: options.searchWalkMaxEntries || SHELL_TREE_WALK_MAX_ENTRIES,
    // Each reader's own share of entries for its walks, as big as the above (see readerShare).
    walkShareSize: options.searchWalkMaxEntries || SHELL_TREE_WALK_MAX_ENTRIES,
    readerShares: new Map(),
    lookups: options.shellOperandMaxLookups ?? SHELL_OPERAND_MAX_LOOKUPS,
    lookupDeadline: now + (options.shellOperandMaxMs ?? SHELL_OPERAND_MAX_MS),
    // Within the operands' own time, which a caller giving that time (a test, for one) gives these too.
    drivePathDeadline:
      now +
      Math.min(
        options.shellOperandMaxMs ?? SHELL_OPERAND_MAX_MS,
        options.shellDrivePathMaxMs ?? options.shellOperandMaxMs ?? SHELL_DRIVE_PATH_MAX_MS,
      ),
    checkDeadline: now + (options.shellCheckMaxMs ?? SHELL_CHECK_MAX_MS),
    folders: new Map(),
    directories: new Map(),
    targets: new Set(),
    verdicts: new Map(),
    listings: new Map(),
    trees: new Map(),
    folderNames: new Map(),
    drivePaths: new Map(),
    // How many times a path was judged by its name where Guard couldn't look (see secretInFirstShellReading).
    byName: 0,
  };
}

function budgetSpent(budget) {
  return Boolean(budget) && (budget.entries <= 0 || Date.now() >= budget.deadline);
}

function walkSpent(budget) {
  return budget.walkEntries <= 0 || Date.now() >= budget.walkDeadline;
}

// The entries one recursive reader's walks may still read, keyed by how it walks (`grep -r` and a plain `rg` walk the
// same folder differently). A reader's walks share its share; another reader of the same folder gets one of its own.
// The walk's deadline still bounds them all together.
function readerShare(budget, key) {
  let share = budget.readerShares.get(key);
  if (!share) {
    share = { entries: budget.walkShareSize ?? budget.walkEntries };
    budget.readerShares.set(key, share);
  }
  return share;
}

function lookupsSpent(budget) {
  return budget.lookups <= 0 || Date.now() >= budget.lookupDeadline;
}

// Stops a shell check that ran out of time or budget; `location` says why (see secretFileMessage).
class ShellCheckTooLong extends Error {
  constructor(location = SHELL_TOO_MANY_PATHS) {
    super(location);
    this.location = location;
  }
}

function checkShellDeadline(budget) {
  if (Date.now() >= budget.checkDeadline) throw new ShellCheckTooLong();
}

// A recursive reader's folders can't be left unread once the walk's entries or time, or the lookups, are spent: a
// secret file could be past that point. So the command is stopped.
function stopIfSpent(budget) {
  checkShellDeadline(budget);
  if (lookupsSpent(budget)) throw new ShellCheckTooLong(SHELL_TOO_MANY_PATHS);
  if (walkSpent(budget)) throw new ShellCheckTooLong(SHELL_FOLDER_TOO_BIG);
}

module.exports = {
  shellWalkBudget,
  budgetSpent,
  walkSpent,
  readerShare,
  lookupsSpent,
  ShellCheckTooLong,
  checkShellDeadline,
  stopIfSpent,
};
