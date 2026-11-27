"use strict";
/* global require, module */

const path = require("path");
const { globMatchesPath, withUnescapedGlobs, compileGlob } = require("../path-forms/glob-matching.js");
const { SEARCH_FILTER_MAX_LENGTH, SEARCH_FILTER_MAX_COUNT } = require("../limits-and-messages.js");

// ---------- Search filters ----------

// The filter keys searchFileFilters reads, for any tool.
const SEARCH_FILTER_KEYS = ["glob", "include_pattern", "file_pattern", "include", "exclude"];

// Whether a search's filters, as given, are past SEARCH_FILTER_MAX_LENGTH or SEARCH_FILTER_MAX_COUNT.
// Measured before they're split or copied, so a list of millions costs no more than its length.
function searchFiltersTooBig(args) {
  let length = 0;
  let count = 0;
  for (const key of SEARCH_FILTER_KEYS) {
    const items = filterItems(args[key]);
    count += items.length;
    if (count > SEARCH_FILTER_MAX_COUNT) return true;
    for (const item of items) {
      if (typeof item === "string") length += item.length;
      if (length > SEARCH_FILTER_MAX_LENGTH) return true;
    }
  }
  return false;
}

// A filter given as one string or a list of them, as a list; any other value as none.
function filterItems(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

// Gemini's read_many_files' own excludes, unless `useDefaultExcludes` is false.
const GEMINI_DEFAULT_EXCLUDES = [
  "**/bower_components/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/.vscode/**",
  "**/.idea/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/*.bin",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.class",
  "**/*.jar",
  "**/*.war",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.bz2",
  "**/*.rar",
  "**/*.7z",
  "**/*.pak",
  "**/*.rpa",
  "**/*.doc",
  "**/*.docx",
  "**/*.xls",
  "**/*.xlsx",
  "**/*.ppt",
  "**/*.pptx",
  "**/*.odt",
  "**/*.ods",
  "**/*.odp",
  "**/*.pyc",
  "**/*.pyo",
  "**/.DS_Store",
  "**/.env",
];

// Whether a piece of Claude's Grep glob holds a `{...}`, which Claude Code doesn't split on commas.
function hasBracePair(piece) {
  const open = piece.indexOf("{");
  return open >= 0 && piece.indexOf("}", open) > open;
}

function searchFileFilters(tool, toolName, args) {
  let include = [];
  const exclude = [];
  // Claude Code splits Grep's glob on blank space, then each piece without a `{...}` on commas, and passes
  // each to ripgrep as a glob of its own (`*.md,.env` reads `.env`). A glob given more than once is checked
  // once.
  if (tool === "claude" && toolName === "grep" && typeof args.glob === "string") {
    const pieces = args.glob.split(/\s+/).filter(Boolean);
    include = [...new Set(pieces.flatMap((piece) => (hasBracePair(piece) ? [piece] : piece.split(","))))];
  }
  if (tool === "gemini" && ["search_file_content", "grep_search"].includes(toolName)) {
    if (typeof args.include_pattern === "string") include = [args.include_pattern];
  }
  if (tool === "cline" && toolName === "search_files" && typeof args.file_pattern === "string") {
    include = [args.file_pattern];
  }
  if (tool === "gemini" && toolName === "read_many_files") {
    include = filterItems(args.include);
    exclude.push(...(Array.isArray(args.exclude) ? args.exclude : []));
    if (args.useDefaultExcludes !== false) exclude.push(...GEMINI_DEFAULT_EXCLUDES);
  }
  include = [...new Set(include.filter((pattern) => typeof pattern === "string" && pattern))];
  for (let index = exclude.length - 1; index >= 0; index -= 1) {
    if (typeof exclude[index] !== "string" || !exclude[index]) exclude.splice(index, 1);
  }
  for (let index = include.length - 1; index >= 0; index -= 1) {
    if (include[index].startsWith("!")) exclude.push(include.splice(index, 1)[0]);
  }
  return { include: withUnescapedGlobs(include), exclude };
}

// An include glob is read in the way that matches more (a `[...]` class or the brackets themselves, and every
// file when it's too big to compile), an exclude glob in the way that leaves out less, so a file is never
// skipped by a misreading.
function filePassesSearchFilters(file, filters, root, absoluteFile) {
  const cache = searchFilterCache(filters);
  function matches(pattern, include) {
    const unprefixed = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    const options = { classes: include, unsure: include, cache };
    if (!path.isAbsolute(unprefixed)) return globMatchesPath(pattern, file, options);
    // ripgrep reads one leading slash (`/.env*`) as the folder searched, so an include is read that way too.
    const rootRelative = include && /^\/(?!\/)/.test(unprefixed);
    if (rootRelative && globMatchesPath(unprefixed.slice(1), file, options)) return true;
    return globMatchesPath(pattern, absoluteFile || path.resolve(root, file), options);
  }
  const included = !filters.include.length || filters.include.some((pattern) => matches(pattern, true));
  if (!included) return false;
  return !filters.exclude.some((pattern) => matches(pattern, false));
}

// One search's filters, compiled once for its whole walk: a glob too long for compileGlob's own cache would
// otherwise be compiled again for each file, and run the walk out of time.
const searchFilterCaches = new WeakMap();
function searchFilterCache(filters) {
  let cache = searchFilterCaches.get(filters);
  if (!cache) {
    cache = new Map();
    searchFilterCaches.set(filters, cache);
  }
  return cache;
}

// Compiles a search's filters before its walk's clock starts, false if `late()` says the hook's time is up
// first.
function compileSearchFilters(filters, late) {
  const cache = searchFilterCache(filters);
  for (const [patterns, include] of [
    [filters.include, true],
    [filters.exclude, false],
  ]) {
    for (const pattern of patterns) {
      if (late()) return false;
      compileGlob(pattern, include, cache);
      const unprefixed = pattern.startsWith("!") ? pattern.slice(1) : pattern;
      if (include && /^\/(?!\/)/.test(unprefixed)) compileGlob(unprefixed.slice(1), include, cache);
    }
  }
  return true;
}

module.exports = {
  searchFiltersTooBig,
  searchFileFilters,
  filePassesSearchFilters,
  searchFilterCaches,
  searchFilterCache,
  compileSearchFilters,
};
