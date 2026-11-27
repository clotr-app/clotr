"use strict";
/* global require, module, console */

const { IMPLEMENTED_TOOL_NAMES, hasOwn } = require("../limits-and-messages.js");

// The options each command a person types takes, and whether one is followed by a value. Hook commands aren't listed:
// an assistant runs those, and a stray option there must never stop a prompt.
const COMMAND_OPTIONS = {
  check: { "--json": false, "--min-severity": true },
  "commit-check": { "--personal-details": false },
  "ignore-value": { "--kind": true },
  setup: {
    "--project": false,
    "--dry-run": false,
    "--min-severity": true,
    "--personal-details": false,
    "--windsurf-jetbrains": false,
  },
  remove: {
    "--project": false,
    "--dry-run": false,
    "--min-severity": true,
    "--personal-details": false,
    "--windsurf-jetbrains": false,
  },
  mcp: { "--print-config": true },
};

// ---------- Listing hooks and help ----------

function printHelp() {
  console.log(
    `Clotr checks prompts before they reach an AI coding assistant.\n\nUsage\n  clotr-guard check [file] [--json] [--min-severity low|medium|high]\n  clotr-guard hook <tool> [--min-severity low|medium|high]\n  clotr-guard read <tool> [--min-severity low|medium|high]\n  clotr-guard setup <tool> [--project] [--dry-run] [--min-severity low|medium|high]\n  clotr-guard remove <tool> [--project]\n  clotr-guard commit-check [--personal-details]\n  clotr-guard ignore-value [--kind <kind>]\n  clotr-guard setup git [--project] [--dry-run]\n  clotr-guard remove git\n  clotr-guard mcp [--print-config <host>]\n  clotr-guard --version\n  clotr-guard --help\n\nTools: ${IMPLEMENTED_TOOL_NAMES.join(", ")}`,
  );
}

// The first option a typed command doesn't take, or null. A value after an option that takes one is skipped.
function unknownOption(action, args) {
  const known = COMMAND_OPTIONS[action];
  if (!known) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!hasOwn(known, arg)) return arg;
    if (known[arg]) index += 1;
  }
  return null;
}

module.exports = {
  COMMAND_OPTIONS,
  printHelp,
  unknownOption,
};
