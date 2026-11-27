"use strict";
/* global require, module, Buffer */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { MAX_BYTES, pathIgnored, parseClotrIgnore } = require("../clotrignore.js");
const {
  SEARCH_REACHABILITY_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  RIPGREP_MISSING,
  SHELL_RIPGREP_MAX_BUFFER,
  RIPGREP_IGNORE_FILES,
} = require("../limits-and-messages.js");
const { searchFileFilters } = require("./search-filters.js");

// ---------- What rg and Git list ----------

// What `rg --files` would list, worked out without ripgrep: hidden paths only when the tool searches them,
// never `.git` or `node_modules`, a `.geminiignore` read with the gitignore-style rules Guard already uses
// for `.clotrignore`, and Git's own answer for `.gitignore`. ripgrep applies ignore rules only to what it
// finds inside the folder it's asked to search, never to that folder, but Git calls a file ignored when any
// folder above it is: so Git's answer counts only when the search's own folder isn't ignored. When it is, Git
// can't tell whether the file is also ignored on its own, and the file is taken to be listed.
function ripgrepRulesCanList(root, relativePath, { hidden, geminiIgnore, respectGitIgnore, deadline, listing }) {
  // A walk that found many secret files has Git asked about them all at once (see gitIgnoreAnswers).
  const gitIgnore = listing?.gitIgnore || ((wanted) => gitGrepCanList(root, wanted, deadline));
  const wanted = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = wanted.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules")) return { reachable: false };
  if (!hidden && parts.some((part) => part.startsWith("."))) return { reachable: false };
  if (geminiIgnore) {
    try {
      const file = path.join(root, ".geminiignore");
      const small = fs.statSync(file).size <= MAX_BYTES;
      if (small && pathIgnored(parseClotrIgnore(fs.readFileSync(file, "utf8")), wanted)) return { reachable: false };
    } catch {
      // No .geminiignore, or one that can't be read: nothing it leaves out.
    }
  }
  if (respectGitIgnore) {
    const ignored = gitIgnore(wanted);
    if (ignored.limited) return ignored;
    if (!ignored.unavailable && !ignored.reachable) {
      // Asked from inside the folder, so a folder at the top of its repository is outside it, and not
      // ignored.
      const folder = path.basename(path.resolve(root));
      const folderIgnored = folder ? gitIgnore(`../${folder}`) : { reachable: true };
      if (folderIgnored.limited) return folderIgnored;
      if (folderIgnored.reachable) return { reachable: false };
    }
  }
  return { reachable: true };
}

// `listing` carries what rg has listed so far in this search, so each folder is listed once, and charges what
// it lists to the search's budget: rg reads every folder below to list it, as the walk does.
function ripgrepCanList(
  root,
  relativePath,
  {
    hidden = false,
    geminiIgnore = false,
    respectGitIgnore = true,
    deadline = Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS,
    listing,
  } = {},
) {
  // A path Node couldn't spell (U+FFFD in it) isn't spelled the way rg or Git spell it, so neither can say
  // it's left out.
  if (relativePath.includes("\uFFFD")) return { reachable: true };
  const rules = { hidden, geminiIgnore, respectGitIgnore, deadline, listing };
  const listed = ripgrepListing(root, rules);
  // Most machines have no ripgrep on PATH (assistants that use it carry their own copy), so answer the same
  // question from ripgrep's own rules instead of letting every search through. The same when rg lists more
  // than the read hook keeps of its output (`tooBig`): a big repository is still searched.
  if (listed.missing || listed.tooBig) return ripgrepRulesCanList(root, relativePath, rules);
  if (listed.limited) return listed;
  return { reachable: listed.files.has(relativePath.replace(/\\/g, "/").replace(/^\.\//, "")) };
}

// What rg itself lists in `root` under these rules: `files`, each relative to it with `/` between its parts;
// `missing` when there's no rg on PATH; `tooBig` when the read hook's listing is past its buffer; `limited`
// when it couldn't list it all in time.
function ripgrepListing(root, { hidden, geminiIgnore, respectGitIgnore, deadline, listing }) {
  // The search check's own budget (250 ms unless a caller sets another) bounds every probe it starts.
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const args = ["--files", "--null", "--no-config"];
  if (hidden) args.push("--hidden");
  if (!respectGitIgnore) args.push("--no-ignore-vcs");
  if (geminiIgnore) args.push("--no-ignore-dot", "--no-ignore-parent");
  args.push("--glob", "!**/.git/**", "--glob", "!**/node_modules/**");
  if (geminiIgnore && fs.existsSync(path.join(root, ".geminiignore"))) {
    args.push("--ignore-file", ".geminiignore");
  }
  args.push("--", ".");
  const key = `${path.resolve(root)}\0${args.join("\0")}`;
  const listed = listing?.cache.get(key);
  if (listed) return { files: listed };
  // No rg on PATH is found out once a search, not once a file.
  if (listing?.cache.get(RIPGREP_MISSING)) return { missing: true };
  const tooBigKey = `${key}\0too big`;
  if (listing?.cache.get(tooBigKey)) return { tooBig: true };
  const result = spawnSync("rg", args, {
    cwd: root,
    encoding: "buffer",
    timeout,
    maxBuffer: listing?.maxBuffer || 512 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") {
    listing?.cache.set(RIPGREP_MISSING, true);
    return { missing: true };
  }
  // The read hook keeps half a megabyte of the listing; a repository listing more is answered from ripgrep's
  // rules (see ripgrepCanList). A shell check sets its own, larger buffer, and a listing past that is still
  // `limited`.
  if (result.error?.code === "ENOBUFS" && !listing?.maxBuffer) {
    listing?.cache.set(tooBigKey, true);
    return { tooBig: true };
  }
  // rg exits 2 when it couldn't open a folder, and lists the rest. A shell check's own reader, run as this
  // account, can't open that folder either (`listing.partial`), so the rest is what it reads.
  const partial = result.status === 2 && Boolean(listing?.partial);
  if (result.error || (result.status !== 0 && result.status !== 1 && !partial)) return { limited: true };
  const files = new Set(
    (result.stdout || Buffer.alloc(0))
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")),
  );
  if (listing) {
    listing.cache.set(key, files);
    listing.charge(files.size);
  }
  return { files };
}

function gitGrepCanList(root, relativePath, deadline = Date.now() + SEARCH_REACHABILITY_TIMEOUT_MS, noIndex = false) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const args = ["check-ignore", "-q"];
  if (noIndex) args.push("--no-index");
  args.push("--", relativePath);
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") return { limited: true };
  if (result.error) return { unavailable: true };
  if (result.status === 0) return { reachable: false };
  // Not ignored, or outside a Git worktree, where Gemini's grep fallback can read ignored-looking files.
  return { reachable: true };
}

// gitGrepCanList's answer for each of a walk's secret `files` (relative to `root`), with Git asked about them
// all in one process, the first time one is wanted. Any other path, the folder's own (`../name`) among them,
// is asked on its own, once; so is every file when Git can't answer the batch.
function gitIgnoreAnswers(root, files, deadline) {
  const wanted = new Set(files);
  const asked = new Map();
  let batch;
  return (relativePath) => {
    if (wanted.has(relativePath)) {
      if (batch === undefined) batch = gitIgnoredBatch(root, [...wanted], deadline);
      if (batch?.limited || batch?.unavailable) return batch;
      if (batch) return { reachable: !batch.ignored.has(relativePath) };
    }
    if (!asked.has(relativePath)) asked.set(relativePath, gitGrepCanList(root, relativePath, deadline));
    return asked.get(relativePath);
  };
}

function gitIgnoredBatch(root, files, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return { limited: true };
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: root,
    input: files.map((file) => `${file}\0`).join(""),
    encoding: "utf8",
    timeout,
    maxBuffer: SHELL_RIPGREP_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") return { limited: true };
  if (result.error?.code === "ENOENT") return { unavailable: true };
  // 0: some are ignored, 1: none are. Anything else (outside a repository, say) is asked a file at a time
  // instead.
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  return { ignored: new Set(result.stdout.split("\0").filter(Boolean)) };
}

// The folders below `root` that Git ignores whole (`target/`, or one holding nothing but ignored files),
// relative to it, for a walk to leave out; null when Git can't say, or when `root` is ignored itself, which
// rg reads all the same.
function gitIgnoredFolders(root, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return null;
  const result = spawnSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: SHELL_RIPGREP_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const folders = new Set();
  for (const entry of result.stdout.split("\0")) {
    if (!entry.endsWith("/")) continue;
    const folder = entry.slice(0, -1).replace(/^\.\//, "");
    if (folder === "." || folder === "" || folder.startsWith("../")) return null;
    folders.add(folder);
  }
  return folders;
}

// The time a walk's probe gets on its own: what's left of the walk, or SEARCH_REACHABILITY_TIMEOUT_MS if
// that's more.
function walkProbeDeadline(walkDeadline, now) {
  return Math.max(walkDeadline, now + SEARCH_REACHABILITY_TIMEOUT_MS);
}

// How long a read hook's search may wait on one Git or rg probe. Inside a hook it may wait longer than its
// own time, since Git can take more than 250 ms just to start on a busy computer: up to GIT_TIMEOUT_MS, the
// time any one Git call gets, less what the search's earlier probes took (`waited`), and never past the
// hook's own deadline. A probe that doesn't answer by then is ended and the search is held. The walk doesn't
// pay for the wait until the search's probes have taken GIT_TIMEOUT_MS in all: till then, it keeps the time
// it had left when each probe started (see findSecretInSearchTree). After that, its time is up, and a search
// over many ignored secret files is answered as one whose walk ran out. The hook's deadline counts from a
// time with a fraction of a millisecond, and a child process's time limit must be whole, so the deadline is
// rounded down.
function searchProbeDeadline(walkDeadline, hookDeadline, waited = 0) {
  const now = Date.now();
  const own = walkProbeDeadline(walkDeadline, now);
  if (hookDeadline === undefined) return own;
  return Math.floor(Math.min(hookDeadline, Math.max(own, now + GIT_TIMEOUT_MS - waited)));
}

// Whether rg reads an `.ignore` or `.rgignore` file in `folder` or a folder above it: one can take back a
// folder Git ignores (`!target/`), which Git wouldn't know.
function ripgrepIgnoreFileAbove(folder) {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    if (RIPGREP_IGNORE_FILES.some((name) => fs.existsSync(path.join(current, name)))) return true;
    if (path.dirname(current) === current) return false;
  }
}

function searchFileIsReachable(tool, toolName, args, root, relativePath, deadline, listing) {
  const claudeGrep = tool === "claude" && toolName === "grep";
  const usesRipgrep = claudeGrep || (tool === "cline" && toolName === "search_files");
  if (usesRipgrep) {
    // The walk only asks about a file that passes the caller's globs, and a ripgrep --glob that matches a
    // file overrides every ignore and hidden-file rule, so a git-ignored .env under `--glob '*'` is searched
    // all the same.
    if (searchFileFilters(tool, toolName, args).include.length) return { reachable: true };
    const hidden = tool === "claude";
    if (tool === "cline" && !hidden && relativePath.split("/").some((part) => part.startsWith("."))) {
      return { reachable: false };
    }
    return ripgrepCanList(root, relativePath, { hidden, deadline, listing });
  }
  if (tool === "gemini" && ["search_file_content", "grep_search"].includes(toolName)) {
    if (args.no_ignore === true) return { reachable: true };
    const ignored = gitGrepCanList(root, relativePath, deadline);
    if (ignored.limited) return ignored;
    if (ignored.unavailable) return { reachable: true };
    if (!ignored.reachable) return ignored;
    return { reachable: true };
  }
  if (tool === "gemini" && toolName === "read_many_files") {
    const filtering = args.file_filtering_options || {};
    if (filtering.respect_git_ignore !== false) {
      const ignored = gitGrepCanList(root, relativePath, deadline, true);
      if (ignored.limited) return ignored;
      // An ignored file is one Gemini leaves out, so the walk goes on to the next; without Git there's no
      // answer.
      if (!ignored.unavailable && !ignored.reachable) return { reachable: false };
    }
    if (filtering.respect_gemini_ignore !== false) {
      return ripgrepCanList(root, relativePath, {
        hidden: true,
        geminiIgnore: true,
        respectGitIgnore: false,
        deadline,
        listing,
      });
    }
    return { reachable: true };
  }
  // A shell `rg` skips hidden and ignored files unless its flags or a --glob that matches say otherwise.
  if (tool === "shell" && toolName === "rg") {
    if (args.globbed) return { reachable: true };
    if (!args.hidden && relativePath.split("/").some((part) => part.startsWith("."))) return { reachable: false };
    if (args.noIgnore) return { reachable: true };
    return ripgrepCanList(root, relativePath, { hidden: args.hidden, deadline, listing });
  }
  return { reachable: true };
}

module.exports = {
  ripgrepRulesCanList,
  ripgrepCanList,
  ripgrepListing,
  gitGrepCanList,
  gitIgnoreAnswers,
  gitIgnoredBatch,
  gitIgnoredFolders,
  walkProbeDeadline,
  searchProbeDeadline,
  ripgrepIgnoreFileAbove,
  searchFileIsReachable,
};
