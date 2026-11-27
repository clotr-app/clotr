"use strict";
/* global require, module */

const path = require("path");
const { isSecretFile } = require("../secret-files.js");
const { checkShellDeadline } = require("../check-budget.js");
const { foldGlobText, compileGlobLeaf, globLeafMatches, globMatchesPath } = require("../path-forms/glob-matching.js");
const { trimEndOf, withoutStream } = require("../path-forms/windows-paths.js");

// ---------- Secret name globs ----------

// The names below that count as secret files, worked out on first use.
let secretGlobCandidates = null;

// A shell check's `budget` (see shellWalkBudget) is checked between names: one glob of a megabyte is one
// operand.
function globCouldMatchSecret(filePath, budget) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!/[*?[]/.test(normalized)) return false;
  const basenamePattern = normalized.split("/").pop();
  // Compiled once per glob, not once per name it's tried against: a command can hold thousands of globs.
  const whole = compileBothReadings(normalized);
  if (budget) checkShellDeadline(budget);
  const lastPart = basenamePattern === normalized ? whole : compileBothReadings(basenamePattern);
  if (!secretGlobCandidates) secretGlobCandidates = secretNameCandidates();
  return secretGlobCandidates.some(({ candidate, name }) => {
    if (budget) checkShellDeadline(budget);
    return whole.test(candidate) || whole.test(name) || lastPart.test(name);
  });
}

// A glob compiled so a `[...]` is read both as a class and as brackets: the glob is stopped if either reading
// could name a secret file.
function compileBothReadings(pattern) {
  const leaves = compileGlobLeaf(pattern, true);
  return { test: (folded) => leaves.some((leaf) => globLeafMatches(leaf, folded)) };
}

// The names a glob is tried against, those that count as secret files kept (see secretNameCandidates).
const SECRET_NAME_EXAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_xmss",
  "id_rsa_sk",
  "id_ed25519_sk",
  "id_ecdsa_sk",
  "credentials",
  ".aws/credentials",
  "credentials.json",
  "secrets.json",
  "private.pem",
  "private.key",
  "private.p12",
  "private.pfx",
  "private.ppk",
  "private.ovpn",
  "private.tfvars",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
  ".pgpass",
  ".my.cnf",
  ".git-credentials",
  ".dockercfg",
  ".htpasswd",
  ".s3cfg",
  ".boto",
  ".vault-token",
  ".terraformrc",
  "terraform.rc",
  ".databrickscfg",
  "winscp.ini",
  "credentials.toml",
  "credentials.tfrc.json",
  "rclone.conf",
  ".credentials.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.toml",
  "secrets.ts",
  ".secrets",
  "wp-config.php",
  ".bash_history",
  ".zsh_history",
  "consolehost_history.txt",
  ".kube/config",
  ".docker/config.json",
  "gh/hosts.yml",
  "github cli/hosts.yml",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  "gcloud/credentials.db",
  "gcloud/access_tokens.db",
  "gcloud/application_default_credentials.json",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".azure/msal_token_cache.json",
  "private.keystore",
  "private.jks",
  "private.tfstate",
  "private.tfstate.backup",
];

// The secret names a glob is tried against, each with its last part, case-folded once.
function secretNameCandidates() {
  const candidates = SECRET_NAME_EXAMPLES;
  return candidates
    .filter((candidate) => isSecretFile(candidate))
    .map((candidate) => ({ candidate: foldGlobText(candidate), name: foldGlobText(path.posix.basename(candidate)) }));
}
// ---------- A process's environment ----------

// Whether a shell word could expand to `literal`, letter case aside: a `*` matches any run, a `?` or `[…]`
// class any one character, and a word with `$`, a backtick or a brace list in it could be anything. Linear in
// the word's length.
function looseWordCouldBe(word, literal) {
  const units = looseGlobUnits(word, literal.length);
  return units !== null && looseUnitsMatch(units, literal);
}

// A word's units for looseWordCouldBe, or null when it holds more than `max` characters that each match one,
// so it can't expand to a word that short. "" stands for a run (`*`, `$…`, an extglob pattern list such as
// `@(…)`), "?" for any one character.
function looseGlobUnits(word, max) {
  if (/[$`{]|[@+?!*]\(/.test(word)) return [""];
  const units = [];
  let fixed = 0;
  let closes = true;
  const unclosed = new Set();
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index];
    if (char === "*") {
      if (units[units.length - 1] !== "") units.push("");
      continue;
    }
    fixed += 1;
    if (fixed > max) return null;
    if (char === "[" && closes) {
      const close = globClassEnd(word, index, unclosed);
      if (close >= 0) {
        units.push("?");
        index = close;
        continue;
      }
      closes = false;
    }
    units.push(char === "?" ? "?" : char.toLowerCase());
  }
  return units;
}

// Where the `[…]` class starting at `start` ends, or -1 when it doesn't. A `]` right after `[` or `[!` is a
// member of the class, not its end, and so is one inside a `[:alpha:]`, `[=e=]` or `[.e.]` in it. `unclosed`
// keeps the kinds of those found to have no end, so a word full of them is read once.
function globClassEnd(word, start, unclosed) {
  let at = start + 1;
  if (word[at] === "!" || word[at] === "^") at += 1;
  if (word[at] === "]") at += 1;
  for (; at < word.length; at += 1) {
    if (word[at] === "]") return at;
    const kind = word[at] === "[" ? word[at + 1] : "";
    if (kind !== ":" && kind !== "=" && kind !== ".") continue;
    const end = unclosed.has(kind) ? -1 : word.indexOf(`${kind}]`, at + 2);
    if (end < 0) unclosed.add(kind);
    else at = end + 1;
  }
  return -1;
}

function looseUnitsMatch(units, literal) {
  const target = literal.toLowerCase();
  let row = target.split("").map(() => false);
  row.unshift(true);
  for (const unit of units) {
    const next = row.map(() => false);
    let any = false;
    for (let at = 0; at <= target.length; at += 1) {
      if (unit === "") {
        any = any || row[at];
        next[at] = any;
      } else if (at > 0) next[at] = row[at - 1] && (unit === "?" || unit === target[at - 1]);
    }
    row = next;
  }
  return row[target.length];
}
// ---------- Credential folders and filters ----------

// The names of the credential stores known by their folder (`.kube/config`, see SECRET_PATHS in
// secret-files.js), none a secret file by its name alone.
const SECRET_FOLDER_FILES = [
  "config",
  "config.json",
  "hosts.yml",
  "auth.json",
  "oauth_creds.json",
  "credentials.db",
  "access_tokens.db",
  "application_default_credentials.json",
  "settings.xml",
  "gradle.properties",
  "msal_token_cache.json",
];

// Whether a folder's name alone says a recursive read of it reads a secret file: a folder holding a
// credential store known by its folder (`.kube`, `.config/gcloud`), `.ssh` or `.aws`. A folder Guard doesn't
// walk, on another computer, is judged this way, as its files can't be: as written, and with `.` and `..`
// resolved from the working folder (`.` in `\\host\home\.kube`, or `.kube\x\..`), as the system resolves
// them.
function secretFolderByName(folder, cwd) {
  if (typeof folder !== "string") return false;
  const text = folder.replace(/^\s*['"]|['"]\s*$/g, "");
  const forms = [text];
  if (typeof cwd === "string" && cwd) {
    try {
      forms.push(path.isAbsolute(text) ? path.normalize(text) : path.join(cwd, text || "."));
    } catch {
      // A path Node can't join is judged as written.
    }
  }
  return forms.some((form) => {
    const parts = resolvedParts(form);
    if (!parts.length) return false;
    const normalized = parts.join("/");
    const last = trimEndOf(withoutStream(parts[parts.length - 1]), ". ").toLowerCase();
    if (last === ".ssh" || last === ".aws") return true;
    return SECRET_FOLDER_FILES.some((name) => isSecretFile(`${normalized}/${name}`));
  });
}

// A path's parts with `.` and `..` resolved by name. A part of only dots and spaces is `..` or `.`, as
// Windows drops a part's last dots and spaces (`.kube\...` and `.kube\ ` are `.kube`).
function resolvedParts(value) {
  const resolved = [];
  for (const written of value.replace(/\\/g, "/").split("/")) {
    const part = asDotPart(written);
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return resolved;
}

// A part of only dots and spaces as the `..` or `.` it is; any other part as written.
function asDotPart(written) {
  if (!/^[. ]+$/.test(written)) return written;
  return /^\.\. *$/.test(written) ? ".." : ".";
}

// The names of the folders secretFolderByName knows. `gh`, `GitHub CLI` and `gcloud` are common words, so a
// glob counts them only below `.config` or `AppData\Roaming`, where they hold credentials.
const SECRET_FOLDER_NAMES = [".kube", ".docker", ".codex", ".gemini", ".m2", ".gradle", ".azure", ".ssh", ".aws"];

const SECRET_CONFIG_FOLDER_NAMES = ["gh", "github cli", "gcloud"];

const ORDINARY_NAME = "zz-clotr-sample";

// Common folder names: a wildcard that matches any of them is a project's, not one for a credentials folder
// (`*s` for `docs` as well as `.ssh`), and a filter that matches a secret name in a folder counts unless it
// matches the name in every one of these (`*/config`, but not `*e/config`).
const ORDINARY_FOLDER_NAMES = [
  ORDINARY_NAME,
  "src",
  "docs",
  "tests",
  "lib",
  "utils",
  "server",
  "users",
  "app",
  "build",
  "data",
  "q1",
  "x.y",
];

// Whether one part of a glob, below `parent`, singles out a credentials folder (see SECRET_FOLDER_NAMES):
// written out, or a wildcard that matches one and no ordinary name. A shell's wildcard doesn't match a
// leading dot, but a search filter's does (`?ssh`, `[.]ssh` and `*ssh` match `.ssh` in ripgrep and Gemini
// CLI): `dotWildcards`.
function partNamesSecretFolder(part, parent = "", { dotWildcards = false } = {}) {
  const folded = trimEndOf(withoutStream(part), ". ").toLowerCase();
  if (!/[*?[]/.test(part)) {
    return SECRET_FOLDER_NAMES.includes(folded) || SECRET_CONFIG_FOLDER_NAMES.includes(folded);
  }
  const matches = (name) => globMatchesPath(part, name, { classes: true });
  if (ORDINARY_FOLDER_NAMES.some(matches)) return false;
  if ((dotWildcards || part.startsWith(".")) && SECRET_FOLDER_NAMES.some(matches)) return true;
  return isConfigParent(parent) && SECRET_CONFIG_FOLDER_NAMES.some(matches);
}

// Whether a glob's part names `.config` or `AppData\Roaming`, where `gh` and `gcloud` hold credentials:
// written out, or a wildcard that matches one of them and no ordinary name.
function isConfigParent(parent) {
  if (!/[*?[]/.test(parent || "")) return /^(?:\.config|roaming)$/i.test(parent || "");
  const parentMatches = (name) => globMatchesPath(parent, name, { classes: true });
  return [".config", "roaming"].some(parentMatches) && !ORDINARY_FOLDER_NAMES.some(parentMatches);
}

// Whether a glob singles out a credentials folder (see secretFolderByName): a folder a recursive reader reads
// once the shell expands it, its `.` and `..` resolved (`.ku*`, `*/.kube`, `.ku*/.`), or a search's filter
// with such a folder above the files it matches (`.kube/*`, `Users/*/.ssh/id_e*`, `/.kube/config`). `*/*` and
// `**/*.json` don't.
function globNamesSecretFolder(glob, { whole = false } = {}) {
  if (typeof glob !== "string" || (!whole && !/[*?[]/.test(glob))) return false;
  const parts = resolvedParts(glob.replace(/^\s*['"]|['"]\s*$/g, ""));
  if (!parts.length) return false;
  if (whole) {
    return parts
      .slice(0, -1)
      .some((part, index) => partNamesSecretFolder(part, parts[index - 1], { dotWildcards: true }));
  }
  const last = parts[parts.length - 1];
  if (!/[*?[]/.test(last)) return secretFolderByName(parts.join("/"));
  return partNamesSecretFolder(last, parts[parts.length - 2]);
}

// A filter that matches an ordinary file with one of these endings names no secret file.
const ORDINARY_EXTENSIONS = ["", ".txt", ".md", ".json", ".js", ".ts", ".py", ".php", ".yml", ".xml", ".properties"];

// Whether a search's filter singles out a secret file by its name: it matches one (`**/id_e*`, `*.pem`,
// `.env*`), also below a folder it names (`proj/.env*`), and not an ordinary name (`*.json` matches
// `credentials.json`, but also any project's JSON file, and `**/*` any file). A secret name that holds only
// in its folder (`.kube/config`) counts only when the filter doesn't match that name in an ordinary folder
// too (`**/config`).
function filterNamesSecret(pattern) {
  if (typeof pattern !== "string" || !pattern) return false;
  const glob = pattern
    .replace(/^\s*['"]|['"]\s*$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "");
  if (isSecretFile(glob)) return true;
  if (!/[*?[]/.test(glob)) return false;
  if (!secretGlobCandidates) secretGlobCandidates = secretNameCandidates();
  const last = glob.replace(/\/+$/, "").split("/").pop();
  return [...new Set([glob, last])].some(readingNamesSecret);
}

// Whether one reading of a filter, whole or its last part, matches a secret name and no ordinary one.
function readingNamesSecret(reading) {
  if (!reading) return false;
  function matches(name) {
    if (globMatchesPath(reading, name, { classes: true })) return true;
    return globMatchesPath(reading, `home/${name}`, { classes: true });
  }
  function ordinary(extension) {
    const name = `${ORDINARY_NAME}${extension}`;
    if (isSecretFile(name)) return false;
    return matches(name) || ORDINARY_FOLDER_NAMES.some((folder) => matches(`${folder}/${name}`));
  }
  if (ORDINARY_EXTENSIONS.some(ordinary)) return false;
  return secretGlobCandidates.some(({ candidate, name }) => {
    if (candidate.includes("/")) {
      return matches(candidate) && !ORDINARY_FOLDER_NAMES.every((folder) => matches(`${folder}/${name}`));
    }
    return matches(candidate) && !ordinary(path.posix.extname(name));
  });
}
// ---------- Glob expansion ----------

// globCouldMatchSecret, asked once per glob in a shell check: an operand and the folders under it ask about
// the same one.
function globSecretByName(glob, budget) {
  const normalized = glob.replace(/\\/g, "/");
  if (!budget) return globCouldMatchSecret(normalized);
  const key = `glob\u0000${normalized}`;
  if (!budget.verdicts.has(key)) budget.verdicts.set(key, globCouldMatchSecret(normalized, budget));
  return budget.verdicts.get(key);
}

module.exports = {
  secretGlobCandidates,
  globCouldMatchSecret,
  secretNameCandidates,
  looseWordCouldBe,
  looseGlobUnits,
  globClassEnd,
  looseUnitsMatch,
  SECRET_FOLDER_FILES,
  secretFolderByName,
  resolvedParts,
  SECRET_FOLDER_NAMES,
  SECRET_CONFIG_FOLDER_NAMES,
  ORDINARY_NAME,
  ORDINARY_FOLDER_NAMES,
  partNamesSecretFolder,
  globNamesSecretFolder,
  ORDINARY_EXTENSIONS,
  filterNamesSecret,
  globSecretByName,
};
