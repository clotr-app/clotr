"use strict";
/* global require, module */

const fs = require("fs");
const path = require("path");
const { isSecretFile } = require("../secret-files.js");
const { isSecretOperand } = require("../secret-paths/secret-path-check.js");
const {
  secretFolderByName,
  globNamesSecretFolder,
  filterNamesSecret,
} = require("../secret-paths/secret-name-matching.js");
const { globMatchesPath } = require("../path-forms/glob-matching.js");
const {
  GIT_TIMEOUT_MS,
  SEARCH_FILTER_MAX_COUNT,
  SHELL_RIPGREP_MAX_BUFFER,
  RIPGREP_IGNORE_FILES,
  SEARCH_WALK_MAX_MS,
  SEARCH_WALK_MAX_ENTRIES,
  SHELL_RG_IGNORED_ASK_AT,
} = require("../limits-and-messages.js");
const {
  isRemotePath,
  isDirectoryTarget,
  remoteLocation,
  driveSharePaths,
  localDevicePaths,
  dotsMayLeaveRoot,
  opensUnknownDevice,
  driveRelativeFromRemote,
  windowsTidiedPaths,
} = require("../path-forms/windows-paths.js");
const { readerShare } = require("../check-budget.js");
const { networkMountOf, networkPathAnswers } = require("../path-forms/network-mounts.js");
const {
  searchFiltersTooBig,
  searchFileFilters,
  filePassesSearchFilters,
  compileSearchFilters,
} = require("./search-filters.js");
const {
  ripgrepListing,
  gitIgnoreAnswers,
  gitIgnoredFolders,
  walkProbeDeadline,
  searchProbeDeadline,
  ripgrepIgnoreFileAbove,
  searchFileIsReachable,
} = require("./ripgrep-and-git-listing.js");

// ---------- Patterns that name a secret file ----------

// The secret names a glob pattern is shown as, when it matches one (see namedSecretForPattern).
const NAMED_SECRET_EXAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "secrets.json",
  "private.pem",
  "private.key",
];

function patternNamesSecret(value, cwd) {
  if (typeof value !== "string" || !value) return false;
  const normalized = value
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^!/, "");
  if (/[*?]/.test(path.posix.basename(normalized))) return false;
  return isSecretOperand(normalized, cwd);
}

function namedSecretForPattern(pattern) {
  const normalized = pattern
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^!/, "");
  if (!/[*?[]/.test(normalized)) return normalized;
  const match = NAMED_SECRET_EXAMPLES.find(
    (candidate) => isSecretFile(candidate) && globMatchesPath(normalized, candidate, { classes: true }),
  );
  return match || path.posix.basename(normalized) || "the matched secret file";
}

// ---------- The tree walk ----------

// The names public certificate bundles ship under (certifi's, requests', and the system's own copies), and
// the folders a package manager installs them into. Such a bundle holds only public CA certificates, so it
// isn't a secret file.
const PUBLIC_CERTIFICATE_BUNDLES = new Set(["cacert.pem", "ca-bundle.crt", "ca-bundle.pem", "ca-certificates.crt"]);
const PACKAGE_FOLDERS = new Set([
  ".venv",
  "venv",
  "site-packages",
  "dist-packages",
  "__pypackages__",
  ".tox",
  ".nox",
  "node_modules",
]);

// Whether a file the search reads is a public certificate bundle inside a virtual env or package folder:
// certifi's `cacert.pem` under `.venv/lib/.../site-packages`, say. Only the search root's own folder and
// those below it count, and names match in exact case, the way package managers write them. A private key
// there is still one. The root counts only when its name as given and its name on disk both name a package
// folder, so a link called `venv` to a plain folder doesn't make it one.
function publicCertificateBundle(rootNames, relativePath) {
  const parts = relativePath.split("/");
  if (!PUBLIC_CERTIFICATE_BUNDLES.has(parts[parts.length - 1])) return false;
  if (rootNames.every((rootName) => PACKAGE_FOLDERS.has(rootName))) return true;
  return parts.slice(0, -1).some((part) => PACKAGE_FOLDERS.has(part));
}

// A shell check lists a folder at least this big on disk a piece at a time, so the walk can stop inside it. A
// folder whose size reads as 0, as every folder does on Windows, is listed in one call.
const FOLDER_READ_IN_PIECES_AT = 256 * 1024;

function findSecretInSearchTree(root, filters, tool, toolName, args, options = {}) {
  if (isRemotePath(root)) return { limited: true };
  const rootParts = path.resolve(root).split(path.sep);
  if (rootParts.some((part) => [".git", "node_modules"].includes(part.toLowerCase()))) return {};
  const walk = startSearchWalk(root, filters, tool, toolName, args, options);
  if (walk.outcome) return walk.outcome;
  const known = walk.budget?.trees.get(walk.treeKey);
  if (known) return knownTreeSecret(walk, known);
  return walkTreeForSecret(walk);
}

// A search walk's state, as one object its steps share, or `{ outcome }` when the walk can't start.
function startSearchWalk(root, filters, tool, toolName, args, options) {
  // A shared budget (see shellWalkBudget) bounds every walk one shell command starts, together.
  const budget = options.budget;
  // The read hook's own deadline (see hookDeadline) bounds what comes before the walk, and the walk's checks
  // of whether the search reads a secret file it found. When those run out, the search is one whose check
  // didn't finish: a secret file passes its filters. A shell command's walks answer to its budget instead.
  const hookLate = () => options.deadline !== undefined && Date.now() >= options.deadline;
  // A shell rg leaves out hidden folders below its own, and searchFileIsReachable takes a file under one as
  // out of its reach anyway, so the walk skips them too and keeps its budget for the rest.
  const shellRg = Boolean(budget) && tool === "shell" && toolName === "rg" && !args.globbed;
  const skipHidden = shellRg && !args.hidden;
  // It leaves out the folders its ignore rules leave out below its own too (a Rust `target`, say), and
  // searchFileIsReachable judges a file under one by the same rules, so the walk skips them as well once rg's
  // own listing, or without rg Git, has said which they are.
  const skipIgnored = shellRg && !args.noIgnore;
  const walkKind = `${skipHidden ? "rg" : ""}${skipIgnored ? "-ignored" : ""}`;
  // The entries this reader's walks may read (see readerShare): a reader that walks the same way shares them.
  const share = budget && readerShare(budget, `${toolName}\u0000${walkKind}`);
  const filtersLate = budget
    ? () => share.entries <= 0 || Date.now() >= budget.walkDeadline || Date.now() >= budget.checkDeadline
    : hookLate;
  if (!compileSearchFilters(filters, filtersLate)) {
    return { outcome: budget ? { limited: true } : { unfinished: true } };
  }
  // Under it a folder is walked once, its secret files kept for the next reader of it (findstr's file names,
  // each looked for in every folder below), and judged against each one's own filters.
  const treeKey = budget && `${path.resolve(root)}\u0000${walkKind}`;
  const walk = { root, filters, tool, toolName, args, options, budget, skipHidden, skipIgnored, share, treeKey };
  walk.entries = 0;
  walk.listing = walkListing(walk);
  // A folder on a network share is looked at first where the look can be ended (see networkPathAnswers):
  // within a shell command's walk time, or the read hook's own deadline, before the walk's clock starts.
  // `options.mountTypeOf` stands in for the mount table, for tests.
  if (options.networkLooked !== path.resolve(root) && (options.mountTypeOf || networkMountOf)(path.resolve(root))) {
    const lookDeadline = budget ? budget.walkDeadline : options.deadline;
    if (!networkPathAnswers(path.resolve(root), lookDeadline)) {
      return { outcome: budget ? { limited: true } : { unfinished: true } };
    }
  }
  walk.deadline = budget ? budget.walkDeadline : Date.now() + (options.searchWalkMaxMs || SEARCH_WALK_MAX_MS);
  // A read hook's walk that runs out of time after a probe took longer than the walk alone would have let it
  // is held, as it was when that probe was cut at the walk's time; otherwise it's `limited` (see
  // probeWalkReachable).
  walk.heldWhenSpent = false;
  // A read hook's probe may wait on a slow Git past the walk's time (see searchProbeDeadline). The walk
  // doesn't pay for the wait: it keeps what it had left when the probe started, inside the hook's own
  // deadline, until the search's probes have taken GIT_TIMEOUT_MS in all. Then the walk's time is up, so a
  // search over many ignored secret files, each answered quickly, waits on Git that long at most.
  walk.waited = 0;
  // A shell rg's secret files are judged once the walk is done, so Git is asked about them all at once (see
  // gitIgnoreAnswers), since asking one at a time runs a folder of ignored ones out of the walk's time.
  walk.deferred = Boolean(budget) && tool === "shell" && toolName === "rg";
  return walk;
}

// What rg has listed so far in a walk (see ripgrepCanList). A shell check's rg listing isn't charged to the
// walk on top of the walk itself: the deadline bounds its time and maxBuffer its size, big enough for a real
// project, since a listing cut short stops the command. A read hook's listing counts in the walk's entries.
function walkListing(walk) {
  const { budget } = walk;
  if (budget) {
    return { cache: budget.listings, charge() {}, maxBuffer: SHELL_RIPGREP_MAX_BUFFER, partial: !budget.elevated };
  }
  return {
    cache: new Map(),
    charge(count) {
      walk.entries += count;
    },
  };
}

function searchWalkOutOfTime(walk) {
  return walk.heldWhenSpent ? { unfinished: true } : { limited: true };
}

function probeWalkReachable(walk, relativePath) {
  const { tool, toolName, args, root, listing, options } = walk;
  if (walk.budget) return searchFileIsReachable(tool, toolName, args, root, relativePath, walk.deadline, listing);
  const started = Date.now();
  const ownEnd = walkProbeDeadline(walk.deadline, started);
  const left = Math.max(0, walk.deadline - started);
  const probeDeadline = searchProbeDeadline(walk.deadline, options.deadline, walk.waited);
  const reachable = searchFileIsReachable(tool, toolName, args, root, relativePath, probeDeadline, listing);
  const answered = Date.now();
  walk.waited += answered - started;
  if (walk.waited > GIT_TIMEOUT_MS) walk.deadline = Math.min(walk.deadline, answered);
  else walk.deadline = Math.min(options.deadline ?? Infinity, Math.max(walk.deadline, answered + left));
  if (answered > ownEnd) walk.heldWhenSpent = true;
  return reachable;
}

// Read before each file's filters and reachability are judged too: a slow filter costs a second a file.
function searchWalkLate(walk) {
  return Date.now() >= walk.deadline || (Boolean(walk.budget) && Date.now() >= walk.budget.checkDeadline);
}

function firstReachableFile(walk, files) {
  const { tool, toolName, args, root, listing } = walk;
  if (walk.deferred && files.length) {
    const relativePaths = files.map((file) => file.relativePath);
    listing.gitIgnore = gitIgnoreAnswers(root, relativePaths, walk.deadline);
  }
  for (const { relativePath } of files) {
    if (searchWalkLate(walk)) return { limited: true };
    const reachable = searchFileIsReachable(tool, toolName, args, root, relativePath, walk.deadline, listing);
    if (reachable.limited) return { limited: true };
    if (reachable.reachable) return { file: relativePath };
  }
  return {};
}

// A folder walked before in this shell check: its secret files, judged against this reader's filters.
function knownTreeSecret(walk, known) {
  const matching = [];
  for (const file of known) {
    if (searchWalkLate(walk)) return { limited: true };
    if (filePassesSearchFilters(file.relativePath, walk.filters, walk.root, file.absolutePath)) matching.push(file);
  }
  return firstReachableFile(walk, matching);
}

function searchWalkSpent(walk) {
  const { budget, share } = walk;
  return (
    walk.entries >= walk.maxEntries ||
    Date.now() >= walk.deadline ||
    (budget && (share.entries <= 0 || Date.now() >= budget.checkDeadline))
  );
}

// Walks the tree from its root, a folder at a time, for a secret file the search reads.
function walkTreeForSecret(walk) {
  const { root, budget, share, skipIgnored } = walk;
  walk.secretFiles = [];
  walk.matching = [];
  // Each walk costs one entry at least, the folder it starts from, so a command can't start more than the
  // budget.
  if (budget) {
    budget.walkEntries -= 1;
    share.entries -= 1;
  }
  walk.maxEntries = budget ? Infinity : walk.options.searchWalkMaxEntries || SEARCH_WALK_MAX_ENTRIES;
  // Each folder with its path from the root, so a file's is one join, not a path.relative call. The
  // secret-file rules that name a folder (see SECRET_PATHS) name one at most, so the root's own is all a file
  // needs from above it. A folder's third part says an `.ignore` or `.rgignore` file in it or above it (in
  // the walk) could take back a folder Git ignores, so nothing below it is skipped for Git.
  walk.pending = [[root, "", false]];
  // Which folders the walk leaves out for rg: undefined until asked (see SHELL_RG_IGNORED_ASK_AT), null when
  // none are.
  walk.skipFolder = skipIgnored ? undefined : null;
  walk.rootNames = rootNamesOf(root);
  while (walk.pending.length) {
    if (searchWalkSpent(walk)) return searchWalkOutOfTime(walk);
    const [directory, relativeDirectory, parentTakesBack] = walk.pending.pop();
    const opened = openWalkFolder(walk, directory, relativeDirectory);
    if (opened.skip) continue;
    if (opened.outcome) return opened.outcome;
    const found = readWalkFolder(walk, { directory, relativeDirectory, parentTakesBack }, opened);
    if (found) return found;
  }
  if (budget) budget.trees.set(walk.treeKey, walk.secretFiles);
  return firstReachableFile(walk, walk.matching);
}

// The root's name as given and as it is on disk, so a junction to `.kube`, or its short name `KUBE~1`,
// counts.
function rootNamesOf(root) {
  const rootNames = [path.basename(path.resolve(root))];
  try {
    const real = path.basename(fs.realpathSync.native(root));
    if (!rootNames.includes(real)) rootNames.push(real);
  } catch {
    // A root that can't be resolved is walked under the name it was given; the walk reports what it can't
    // read.
  }
  return rootNames;
}

// A shell check reads a small folder in one call: a real project has thousands, and reading each in pieces
// made the whole shell check about 1.4 times as slow on 20,000 small folders. One call can't be stopped
// partway, so a folder big enough to hold up the walk past its time (see FOLDER_READ_IN_PIECES_AT) is read in
// pieces. Gives `folderEntries` or a `folderHandle`, `skip` for a folder the walk passes over, or an `outcome`.
function openWalkFolder(walk, directory, relativeDirectory) {
  const { budget } = walk;
  try {
    if (budget && fs.statSync(directory).size < FOLDER_READ_IN_PIECES_AT) {
      return { folderEntries: fs.readdirSync(directory, { withFileTypes: true }) };
    }
    return {
      folderEntries: null,
      folderHandle: budget ? fs.opendirSync(directory, { bufferSize: 1024 }) : fs.opendirSync(directory),
    };
  } catch (error) {
    // A search of one file has no tree to walk; its own name was checked before the walk, and a folder
    // removed since it was listed has nothing left to read. Under a shell check, a folder whose name Node
    // couldn't spell (it reads back with U+FFFD in it) can't be passed over: the reader can open it.
    const misspelled = Boolean(budget) && relativeDirectory.includes("�");
    if ((error.code === "ENOENT" || error.code === "ENOTDIR") && !misspelled) return { skip: true };
    // A folder this account isn't allowed to open, a reader it runs can't open either, so the walk goes on
    // past it; not when the command runs as another user.
    if (budget && !budget.elevated && (error.code === "EACCES" || error.code === "EPERM")) return { skip: true };
    return { outcome: { limited: true } };
  }
}

// Reads one folder's entries: the folders below go on `pending`, and a secret file the search reads ends the
// walk. Null when the folder is done.
function readWalkFolder(walk, { directory, relativeDirectory, parentTakesBack }, { folderEntries, folderHandle }) {
  const takesBack = walk.skipIgnored && (parentTakesBack || holdsIgnoreFile(directory, folderEntries));
  try {
    let entry;
    let index = 0;
    while ((entry = folderEntries ? (folderEntries[index++] ?? null) : folderHandle.readSync()) !== null) {
      walk.entries += 1;
      if (walk.budget) walk.share.entries -= 1;
      if (skipsRestOfFolder(walk, relativeDirectory, parentTakesBack)) break;
      if (searchWalkSpent(walk)) return searchWalkOutOfTime(walk);
      const found = visitWalkEntry(walk, entry, { directory, relativeDirectory, takesBack });
      if (found) return found;
    }
  } catch {
    return { limited: true };
  } finally {
    folderHandle?.closeSync();
  }
  return null;
}

// Asks once which folders rg leaves out, and drops those waiting to be read. Whether the rest of the folder
// being read now is left out too (a big `target`, say).
function skipsRestOfFolder(walk, relativeDirectory, parentTakesBack) {
  const askNow =
    walk.skipFolder === undefined &&
    (walk.entries >= SHELL_RG_IGNORED_ASK_AT || walk.share.entries < SHELL_RG_IGNORED_ASK_AT);
  if (!askNow) return false;
  walk.skipFolder = rgSkipFolder(walk.root, walk.args.hidden, walk.deadline, walk.listing);
  const { skipFolder } = walk;
  if (!skipFolder) return false;
  walk.pending = walk.pending.filter(
    ([, waiting, waitingTakesBack]) => waiting.includes("�") || !skipFolder(waiting, waitingTakesBack),
  );
  return Boolean(
    relativeDirectory && !relativeDirectory.includes("�") && skipFolder(relativeDirectory, parentTakesBack),
  );
}

// One entry of a folder: a folder below goes on `pending`, a secret file is judged. Gives an outcome that ends
// the walk, or null.
function visitWalkEntry(walk, entry, { directory, relativeDirectory, takesBack }) {
  const { skipHidden, skipFolder, budget } = walk;
  const name = entry.name;
  if (name === "." || name === "..") return null;
  const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
  if (entry.isDirectory()) {
    if (
      name !== ".git" &&
      name !== "node_modules" &&
      !(skipHidden && name.startsWith(".")) &&
      // A name Node couldn't spell (U+FFFD in it) isn't spelled the way rg or Git spell it, so
      // neither's answer leaves it out.
      !(skipFolder && !relativePath.includes("�") && skipFolder(relativePath, takesBack))
    ) {
      walk.pending.push([path.join(directory, name), relativePath, takesBack]);
    }
    return null;
  }
  // A file right in the root is named with the root's own folder too, so `.kube/config` is found when
  // `.kube` is the folder read; a deeper one has its folder in its own path.
  if (!entry.isFile() || !walkSecretName(walk, relativeDirectory, relativePath)) return null;
  const file = { relativePath, absolutePath: path.join(directory, name) };
  // A public certificate bundle a package installed isn't a secret file, so the search may read it.
  if (publicCertificateBundle(walk.rootNames, relativePath)) return null;
  if (budget) walk.secretFiles.push(file);
  if (!filePassesSearchFilters(relativePath, walk.filters, walk.root, file.absolutePath)) return null;
  if (walk.deferred) {
    walk.matching.push(file);
    return null;
  }
  const reachable = probeWalkReachable(walk, relativePath);
  if (reachable.limited) return budget ? { limited: true } : { unfinished: true };
  if (reachable.reachable) return { file: relativePath };
  return null;
}

function walkSecretName(walk, relativeDirectory, relativePath) {
  if (relativeDirectory) return isSecretFile(relativePath);
  return walk.rootNames.some((rootName) => isSecretFile(rootName ? `${rootName}/${relativePath}` : relativePath));
}

// Whether a folder holds an `.ignore` or `.rgignore` file, from its entries when they were read whole.
function holdsIgnoreFile(directory, folderEntries) {
  if (folderEntries) return folderEntries.some((folderEntry) => RIPGREP_IGNORE_FILES.includes(folderEntry.name));
  return RIPGREP_IGNORE_FILES.some((name) => fs.existsSync(path.join(directory, name)));
}

// Which folders a shell rg's walk leaves out (see SHELL_RG_IGNORED_ASK_AT): a test of a folder's path, or
// null for none.
function rgSkipFolder(root, hidden, deadline, listing) {
  // With rg on PATH, its own listing says: a folder holding none of the files it lists has none rg reads,
  // and searchFileIsReachable asks the same listing (the same rules, so the same cache entry) about each
  // file.
  const listed = ripgrepListing(root, {
    hidden,
    geminiIgnore: false,
    respectGitIgnore: true,
    deadline,
    listing,
  });
  if (listed.files) {
    const reached = new Set();
    for (const file of listed.files) {
      for (let end = file.lastIndexOf("/"); end > 0; end = file.lastIndexOf("/", end - 1)) {
        const folder = file.slice(0, end);
        if (reached.has(folder)) break;
        reached.add(folder);
      }
    }
    return (relativePath) => !reached.has(relativePath);
  }
  if (!listed.missing) return null;
  // Without it, ripgrepRulesCanList takes Git's word for a file under a folder Git ignores, so the walk
  // does too, unless an `.ignore` or `.rgignore` file could take the folder back.
  const ignored = ripgrepIgnoreFileAbove(root) ? null : gitIgnoredFolders(root, deadline);
  if (!ignored) return null;
  return (relativePath, takesBack) => {
    if (takesBack) return false;
    for (let end = relativePath.length; end > 0; end = relativePath.lastIndexOf("/", end - 1)) {
      if (ignored.has(relativePath.slice(0, end))) return true;
    }
    return false;
  };
}

// ---------- The search tools' check ----------

function secretSearchFile(tool, name, args, cwd, given = {}) {
  let options = given;
  const toolName = String(name || "")
    .toLowerCase()
    .split("__")
    .pop();
  // The first folder given as text (see inspectReadInvocation).
  const pathValue = [args.path, args.dir_path, args.directory, args.root, args.file_path, args.absolute_path].find(
    (value) => typeof value === "string" && value,
  );
  // Filters past the caps are a search that can't be checked in time (see SEARCH_FILTER_MAX_LENGTH).
  if (searchFiltersTooBig(args)) return { unfinished: true };
  const filters = searchFileFilters(tool, toolName, args);
  if (filters.include.length + filters.exclude.length > SEARCH_FILTER_MAX_COUNT) return { unfinished: true };
  const location = typeof pathValue === "string" && pathValue ? pathValue : cwd;
  const root = path.isAbsolute(location) ? location : path.resolve(cwd, location);
  // The folder searched is looked up below, so one on a network share is looked at first where the look can
  // be ended (see networkPathAnswers), once for the walk as well.
  if ((options.mountTypeOf || networkMountOf)(path.resolve(root))) {
    if (!networkPathAnswers(path.resolve(root), options.deadline)) return { unfinished: true };
    options = { ...options, networkLooked: path.resolve(root) };
  }
  if (namedPathIsSecret(pathValue, cwd, filters, root)) return { file: pathValue };
  // The hook's deadline holds across the filters, each of which may be looked up: a search given more than
  // can be checked in time is stopped as one that didn't finish.
  const deadline = options.deadline;
  const late = () => deadline !== undefined && Date.now() >= deadline;
  const named = includeNamesSecretFile(filters, cwd, root, late);
  if (named) return named;
  const reached = searchRoots(location, root, cwd, filters, late);
  if (reached.outcome) return reached.outcome;
  let { limited } = reached;
  const roots = reached.roots.flatMap((item) => [item, ...(windowsTidiedPaths(item, cwd) || [])]);
  for (const walked of roots) {
    const found = findSecretInSearchTree(walked, filters, tool, toolName, args, options);
    if (found.file || found.unfinished) return found;
    if (late()) return { unfinished: true };
    limited = limited || Boolean(found.limited);
  }
  return limited ? { limited: true } : null;
}

// Whether the path a search is given names a secret file its filters pass, judged before any walk.
function namedPathIsSecret(pathValue, cwd, filters, root) {
  if (typeof pathValue !== "string" || !pathValue) return false;
  if (isDirectoryTarget(pathValue, cwd) || !patternNamesSecret(pathValue, cwd)) return false;
  const relativePath = path.relative(cwd, path.resolve(cwd, pathValue)).replace(/\\/g, "/");
  return filePassesSearchFilters(relativePath, filters, root, path.resolve(cwd, pathValue));
}

// An include filter that names a secret file the filters pass, as `{ file }`; `{ unfinished }` past the hook's
// deadline; null for none.
function includeNamesSecretFile(filters, cwd, root, late) {
  for (const pattern of filters.include) {
    if (late()) return { unfinished: true };
    if (patternNamesSecret(pattern, cwd)) {
      const namedFile = namedSecretForPattern(pattern);
      const absoluteFile = path.isAbsolute(namedFile) ? namedFile : path.resolve(root, namedFile);
      const relativeFile = path.relative(root, absoluteFile).replace(/\\/g, "/") || path.basename(absoluteFile);
      if (filePassesSearchFilters(relativeFile, filters, root, absoluteFile)) return { file: namedFile };
    }
  }
  return null;
}

// The folders a search walks, as `{ roots, limited }`, or an `outcome`. A folder on another computer isn't
// walked (see isRemotePath), but a device path to a drive (see localDevicePaths) and a drive's share on this
// computer (see driveSharePaths) are walked as the folder on the drive. A share path whose dots a search may
// pass on to another computer (see driveSharePaths) is walked on this computer's drive, and still noted as a
// search that may read past what was checked (`limited`).
function searchRoots(location, root, cwd, filters, late) {
  if (!remoteLocation(location, cwd)) return { roots: [root], limited: false };
  const shares = (driveSharePaths(location, cwd) || []).filter((item) => item.loopback);
  const roots = [...(localDevicePaths(location) || []), ...shares.map((item) => item.drive)];
  const limited = shares.some((item) => item.dotted) || dotsMayLeaveRoot(location);
  if (roots.length) return { roots, limited };
  return { outcome: unwalkedRemoteSecret(location, cwd, filters, late) };
}

// A remote folder with no drive path to walk. A folder through a device name Guard can't place could hold any
// secret file (see opensUnknownDevice), and so could a drive-relative one named from another computer's folder
// (see driveRelativeFromRemote); a credentials folder holds one by its name (see secretFolderByName), searched
// or named by the search's filter, and a filter can single out a secret file by its name (see
// filterNamesSecret).
function unwalkedRemoteSecret(location, cwd, filters, late) {
  if (opensUnknownDevice(location) || driveRelativeFromRemote(location, cwd) || secretFolderByName(location, cwd)) {
    return { file: location };
  }
  for (const pattern of filters.include) {
    if (late()) return { unfinished: true };
    if (globNamesSecretFolder(pattern, { whole: true }) || filterNamesSecret(pattern)) return { file: location };
  }
  return { limited: true };
}

module.exports = {
  patternNamesSecret,
  namedSecretForPattern,
  findSecretInSearchTree,
  secretSearchFile,
};
