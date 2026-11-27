"use strict";
/* global require, module, process, Buffer */

const fs = require("fs");
const path = require("path");
const {
  SEVERITIES,
  MAX_STDIN_BYTES,
  MAX_SETTINGS_BYTES,
  MAX_READ_STDIN_BYTES,
  HOOK_TIMEOUT_SECONDS,
  GUARD_SCRIPT,
} = require("../limits-and-messages.js");
const { removeFile, atomicWriteFile, assertNoSymlinkComponents } = require("../safe-file-writes.js");
const { minSeverity } = require("../text-checks/check-text.js");
const { userHome } = require("./assistant-settings-paths.js");
const { shellQuote, nodeCommand } = require("./hook-command-writer.js");
const { isGuardScriptPath } = require("./hook-command-reader.js");
const { readConfigIfThere } = require("./git-hook-setup.js");

// ---------- Cline's hook files ----------

function clineHookSource(
  { name, backup, script, node, minimum, includePersonalDetails, chain },
  includeLimitMessage = true,
) {
  const action = name === "UserPromptSubmit" ? "hook" : "read";
  const maxBytes = action === "read" ? MAX_READ_STDIN_BYTES : MAX_STDIN_BYTES;
  const boundary = action === "hook" ? "prompt" : "read";
  const failure = JSON.stringify({
    cancel: true,
    errorMessage: `Clotr couldn't check this ${boundary}, so it was stopped. Check it by hand, then try again.`,
  });
  const tooLarge = JSON.stringify({
    cancel: true,
    errorMessage: `This ${boundary} exceeded Clotr Guard's ${action === "read" ? "64 MiB" : "1 MiB"} hook-input limit, so it was stopped. Shorten it or check it by hand, then try again.`,
  });
  const metadata = {
    version: 1,
    name,
    backup: path.resolve(backup),
    script: path.resolve(script),
    node: path.resolve(node),
    minimum: minSeverity(minimum),
    includePersonalDetails: Boolean(includePersonalDetails),
    chain: Boolean(chain),
  };
  const encodedMetadata = Buffer.from(JSON.stringify(metadata)).toString("base64");
  const args = [
    metadata.script,
    action,
    "cline",
    "--min-severity",
    metadata.minimum,
    ...(metadata.includePersonalDetails ? ["--personal-details"] : []),
  ];
  const previousHook = metadata.chain
    ? `const first=spawnSync(${JSON.stringify(metadata.backup)},{input,encoding:"utf8",timeout:${HOOK_TIMEOUT_SECONDS * 1000},maxBuffer:65536});if(first.error||first.status===null){process.stdout.write(bad);proceed=false}else if(first.status!==0){process.exitCode=first.status;proceed=false}else{try{if(JSON.parse(first.stdout||"{}").cancel){if(first.stdout)process.stdout.write(first.stdout);proceed=false}}catch{}}`
    : "";
  const limitBinding = includeLimitMessage ? `,limit=${JSON.stringify(tooLarge)}` : "";
  const limitOutput = includeLimitMessage ? "limit" : "bad";
  const source = `const fs=require("node:fs"),{spawnSync}=require("node:child_process"),bad=${JSON.stringify(failure)}${limitBinding};const chunks=[];const buffer=Buffer.alloc(65536);let size=0,tooLarge=false;for(;;){const length=Math.min(buffer.length,${maxBytes + 1}-size);if(length<=0){tooLarge=true;break}const count=fs.readSync(0,buffer,0,length,null);if(!count)break;size+=count;chunks.push(Buffer.from(buffer.subarray(0,count)));if(size>${maxBytes}){tooLarge=true;break}}if(tooLarge)process.stdout.write(${limitOutput});else{const input=Buffer.concat(chunks,size).toString("utf8");let proceed=true;${previousHook}if(proceed){const out=spawnSync(${JSON.stringify(metadata.node)},${JSON.stringify(args)},{input,encoding:"utf8",timeout:${HOOK_TIMEOUT_SECONDS * 1000},maxBuffer:65536});if(out.error||out.status!==0)process.stdout.write(bad);else{if(out.stdout)process.stdout.write(out.stdout);if(out.stderr)process.stderr.write(out.stderr)}}}`;
  return `#!/bin/sh\n# clotr-guard-hook:v1:${encodedMetadata}\nexec ${shellQuote(metadata.node)} -e ${shellQuote(source)}\n`;
}

function clineLegacyHookInfo(source, name, backup, cwd) {
  const start =
    '#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const input=require("node:fs").readFileSync(0,"utf8");';
  const outputStart = source.indexOf("const out=spawnSync(", start.length);
  if (outputStart < start.length) return null;
  const chain = source.slice(start.length, outputStart);
  const legacyChain = `const first=spawnSync(${JSON.stringify(backup)},{input,encoding:"utf8"});if(first.status!==0)process.exit(first.status||0);try{if(JSON.parse(first.stdout||"{}").cancel){process.stdout.write(first.stdout);process.exit(0)}}catch{}`;
  if (chain !== "" && chain !== legacyChain) return null;
  const match =
    /^const out=spawnSync\(("(?:[^"\\]|\\.)*"),(\[.*\]),\{input,encoding:"utf8"\}\);if\(out\.stdout\)process\.stdout\.write\(out\.stdout\);if\(out\.stderr\)process\.stderr\.write\(out\.stderr\);process\.exit\(out\.status\|\|0\);\n$/.exec(
      source.slice(outputStart),
    );
  if (!match) return null;
  let executable;
  let args;
  try {
    executable = JSON.parse(match[1]);
    args = JSON.parse(match[2]);
  } catch {
    return null;
  }
  const action = name === "UserPromptSubmit" ? "hook" : "read";
  if (
    typeof executable !== "string" ||
    !(path.isAbsolute(executable) || executable === "node") ||
    (executable !== "node" && !/^node(?:\.exe)?$/i.test(path.basename(executable))) ||
    !Array.isArray(args) ||
    args.length < 5 ||
    args.length > 6 ||
    !isGuardScriptPath(args[0], cwd) ||
    args[1] !== action ||
    args[2] !== "cline" ||
    args[3] !== "--min-severity" ||
    !SEVERITIES.includes(args[4]) ||
    (args.length === 6 && args[5] !== "--personal-details")
  ) {
    return null;
  }
  return { script: args[0], minimum: args[4], includePersonalDetails: args.length === 6, legacy: true };
}

function clineHookInfo(source, name, backup, cwd = process.cwd()) {
  if (typeof source !== "string" || source.length > MAX_SETTINGS_BYTES) return null;
  const marker = /^#!\/bin\/sh\n# clotr-guard-hook:v1:([A-Za-z0-9+/=]+)\n/.exec(source);
  if (!marker) return clineLegacyHookInfo(source, name, backup, cwd);
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
  const expectedKeys = ["backup", "chain", "includePersonalDetails", "minimum", "name", "node", "script", "version"];
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !== expectedKeys.join(",") ||
    metadata.version !== 1 ||
    metadata.name !== name ||
    metadata.backup !== path.resolve(backup) ||
    typeof metadata.chain !== "boolean" ||
    typeof metadata.includePersonalDetails !== "boolean" ||
    !SEVERITIES.includes(metadata.minimum) ||
    !path.isAbsolute(metadata.node) ||
    !/^node(?:\.exe)?$/i.test(path.basename(metadata.node)) ||
    !isGuardScriptPath(metadata.script, cwd)
  ) {
    return null;
  }
  if (source !== clineHookSource(metadata) && source !== clineHookSource(metadata, false)) return null;
  return {
    script: metadata.script,
    minimum: metadata.minimum,
    includePersonalDetails: metadata.includePersonalDetails,
  };
}

function isManagedClineHook(source, name, backup, cwd = process.cwd()) {
  return Boolean(clineHookInfo(source, name, backup, cwd));
}

function updateClineHooks({
  project = false,
  cwd = process.cwd(),
  home = userHome(),
  dryRun = false,
  remove = false,
  minimum = "medium",
  includePersonalDetails = false,
  platform = process.platform,
} = {}) {
  if (!remove && platform === "win32") throw new Error("cline-hooks-unsupported-on-windows");
  const directory = project ? path.join(cwd, ".clinerules", "hooks") : path.join(home, "Documents", "Cline", "Hooks");
  const root = path.resolve(project ? cwd : home);
  assertNoSymlinkComponents(root, directory);
  const cli = GUARD_SCRIPT;
  const node = nodeCommand();
  if (!node) throw new Error("node-not-found");
  const options = includePersonalDetails ? " --personal-details" : "";
  const definitions = {
    UserPromptSubmit: `hook cline --min-severity ${minSeverity(minimum)}${options}`,
    PreToolUse: `read cline --min-severity ${minSeverity(minimum)}${options}`,
  };
  const changed = [];
  if (!remove && !dryRun) {
    fs.mkdirSync(directory, { recursive: true });
    assertNoSymlinkComponents(root, directory);
  }
  const context = { directory, root, remove, dryRun, cli, node, minimum, includePersonalDetails, cwd };
  for (const name of Object.keys(definitions)) {
    if (updateClineHook(name, context)) changed.push(name);
  }
  return {
    file: directory,
    changed: changed.length > 0,
    dryRun,
    remove,
    event: "UserPromptSubmit, PreToolUse",
    hooks: Object.entries(definitions).map(([event, args]) => ({
      event,
      command: `${[node, cli, ...args.split(" ")].map(shellQuote).join(" ")}`,
    })),
    minimum: minSeverity(minimum),
  };
}

// Writes or removes one Cline hook file, `name`; whether it changed. Clotr's own hook is written again when its
// Guard path or options change, and keeps chaining to the backup.
function updateClineHook(name, { directory, root, remove, dryRun, cli, node, minimum, includePersonalDetails, cwd }) {
  const file = path.join(directory, name);
  const backup = `${file}.clotr-guard.bak`;
  assertNoSymlinkComponents(root, file);
  assertNoSymlinkComponents(root, backup);
  const current = readConfigIfThere(file);
  const previousBackup = readConfigIfThere(backup);
  const own = current && isManagedClineHook(current.content, name, backup, cwd);
  if (remove) {
    if (!own) return false;
    if (!dryRun) {
      removeFile(file);
      if (previousBackup) fs.renameSync(backup, file);
    }
    return true;
  }
  // Clotr's own hook is written again when its Guard path or options change, and keeps chaining to the
  // backup.
  const fileExists = Boolean(current);
  const existing = current?.content || "";
  if (previousBackup && !own) throw new Error("cline-hook-backup-exists");
  const prior = Boolean(previousBackup) || (fileExists && !own);
  const source = clineHookSource({
    name,
    backup,
    script: cli,
    node,
    minimum,
    includePersonalDetails,
    chain: prior,
  });
  if (existing === source) {
    if (!dryRun && process.platform !== "win32" && (current.stat.mode & 0o777) !== 0o755) {
      fs.chmodSync(file, 0o755);
    }
    return false;
  }
  if (!dryRun && fileExists && !own) atomicWriteFile(backup, existing, { mode: current.stat.mode & 0o777 });
  if (!dryRun) {
    assertNoSymlinkComponents(root, file);
    atomicWriteFile(file, source, { mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  }
  return true;
}

module.exports = {
  clineHookSource,
  clineLegacyHookInfo,
  clineHookInfo,
  isManagedClineHook,
  updateClineHooks,
};
