"use strict";
/* global module */

// ---------- Add-on tool calls ----------

// How deep a tool call's arguments may nest. JSON.stringify, which checks them serialized, needs the stack
// for each level and ran out of it at 10,000 levels, which let the call through as a failed check. Real tool
// calls nest a few levels; a thousand is far past them and well inside the stack.
const TOOL_ARGS_MAX_DEPTH = 1000;

// The tool names that read a file whatever add-on server they come from, and where each takes what it reads:
// "path" for one path under `file_path`, `absolute_path` or `path`, "paths" for a list under `paths`.
const ADDON_FILE_READS = new Map([
  ["read_file", "path"],
  ["read_text_file", "path"],
  ["read_media_file", "path"],
  ["get_file_contents", "path"],
  ["view_file", "path"],
  ["open_file", "path"],
  ["read_multiple_files", "paths"],
  ["read_many_files", "paths"],
]);
const MCP_FILE_READS = new Set(ADDON_FILE_READS.keys());
// The add-on reads Claude Code's tool hook opens itself; a file it can't open gets the "couldn't check" note.
const CLAUDE_OPENED_READS = new Set(["read_file", "read_text_file", "read_media_file", "read_multiple_files"]);
// Cursor's tool hook reads 16 KiB of each file, 50 ms in all, for a secret file's shape only, to keep its
// speed.
const CURSOR_DISK_READ = { bytes: 16 * 1024, ms: 50 };

// The last `__` part of a name: `read_file` in `mcp__fs__read_file`.
function lastPart(name) {
  return name.split("__").pop();
}

// For each assistant whose hooks see add-on server tools, the read name in what the hook sends, or null.
// Claude's and Cursor's tool hooks and Gemini CLI's read hook use it; the reads are ADDON_FILE_READS for all
// three.
const FILE_READ_TABLE = {
  // Claude Code names an add-on tool `mcp__<server>__<tool>`; its own tools have names of their own.
  claude: (name) => (name.startsWith("mcp__") ? lastPart(name) : null),
  // Cursor's tool hook sees only add-on tools, by the tool's own name or as `mcp__<server>__<tool>`.
  cursor: (name) => lastPart(name),
  // Gemini CLI names one `mcp_<server>_<tool>` or `<server>__<tool>`. Its own bare `read_file` and
  // `read_many_files` keep their own checks.
  gemini: (name) => {
    if (name.includes("__")) return lastPart(name);
    if (!name.startsWith("mcp_")) return null;
    for (const read of ADDON_FILE_READS.keys()) {
      if (name.endsWith(`_${read}`) && name.length > `mcp__${read}`.length) return read;
    }
    return null;
  },
};

// The add-on read a tool call makes for this assistant, from FILE_READ_TABLE, or null.
function addOnFileRead(tool, name) {
  const known = Object.prototype.hasOwnProperty.call(FILE_READ_TABLE, tool) && typeof name === "string";
  const ownName = known ? FILE_READ_TABLE[tool] : null;
  const read = ownName && ownName(name.toLowerCase());
  return read && ADDON_FILE_READS.has(read) ? read : null;
}

module.exports = {
  TOOL_ARGS_MAX_DEPTH,
  ADDON_FILE_READS,
  MCP_FILE_READS,
  CLAUDE_OPENED_READS,
  CURSOR_DISK_READ,
  FILE_READ_TABLE,
  addOnFileRead,
};
