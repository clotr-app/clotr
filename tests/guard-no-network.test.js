// Guard's whole pitch is that it never leaves this computer. This file scans every file Guard actually ships (its
// package.json "files"/"bin" entries, followed through their own requires, plus the engine bundle those files load
// at runtime) for any sign of networking, and spawns clotr-mcp.js with net and fetch patched to throw, to show the
// stdio exchange still completes without either.
"use strict";
/* global require, module, process, __dirname */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(ROOT, "apps", "guard");
const SERVER = path.join(GUARD, "bin", "clotr-mcp.js");

// child_process shows up in clotr-guard.js's own require()s, and again inside the pre-commit hook scripts it writes
// as string templates. Both uses shell out to `git` and `rg` on this machine to scan a commit or a search locally;
// neither ever reaches a network, so it's left off the forbidden list below rather than failed and re-allowed.
const FORBIDDEN = [
  { name: "net", re: /\brequire\(\s*["'](?:node:)?net["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?net["']/g },
  { name: "http", re: /\brequire\(\s*["'](?:node:)?http["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?http["']/g },
  { name: "https", re: /\brequire\(\s*["'](?:node:)?https["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?https["']/g },
  { name: "http2", re: /\brequire\(\s*["'](?:node:)?http2["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?http2["']/g },
  { name: "dgram", re: /\brequire\(\s*["'](?:node:)?dgram["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?dgram["']/g },
  { name: "tls", re: /\brequire\(\s*["'](?:node:)?tls["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?tls["']/g },
  {
    name: "dns",
    re: /\brequire\(\s*["'](?:node:)?dns(?:\/promises)?["']\s*\)|\bimport\b[^;\n]*["'](?:node:)?dns["']/g,
  },
  { name: "undici", re: /\brequire\(\s*["']undici["']\s*\)|\bimport\b[^;\n]*["']undici["']/g },
  { name: "fetch(", re: /\bfetch\s*\(/g },
  { name: "WebSocket", re: /\bWebSocket\b/g },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/g },
];

function findForbidden(text) {
  const hits = [];
  for (const { name, re } of FORBIDDEN) {
    const matches = text.match(re);
    if (matches) hits.push(`${name} (${matches.length}×)`);
  }
  return hits;
}

// require() specifiers that point at a local file, resolved the way Node would: an extension added if missing, or
// an index.js read for a bare directory.
function resolveRequireTarget(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [resolved, `${resolved}.js`, `${resolved}.json`, path.join(resolved, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function listJsFilesUnder(dir) {
  const out = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // the directory doesn't exist on this checkout (e.g. "dist" before it's built)
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /\.(js|json)$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

// Every file Guard ships: package.json's own "files" and "bin" entries, plus anything those files require locally
// (so a new lib file reached only through a require still gets scanned, not just the ones listed by directory).
function shippedGuardFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(GUARD, "package.json"), "utf8"));
  const visited = new Set();
  const queue = [];
  const add = (file) => {
    const normalized = path.normalize(file);
    if (!visited.has(normalized)) {
      visited.add(normalized);
      queue.push(normalized);
    }
  };
  for (const entry of pkg.files) {
    const full = path.join(GUARD, entry);
    if (!fs.existsSync(full)) continue; // "dist" doesn't exist until prepack builds it
    if (fs.statSync(full).isDirectory()) listJsFilesUnder(full).forEach(add);
    else if (/\.js$/i.test(full)) add(full);
  }
  for (const binScript of Object.values(pkg.bin)) add(path.join(GUARD, binScript));

  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (!/\.js$/i.test(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = resolveRequireTarget(file, match[1]);
      if (target) add(target);
    }
  }
  return [...visited];
}

// dist/clotr-engine.js (Guard's "dist" files entry) is built from the extension's own source files by
// tools/engine-bundle.js and isn't checked in. Built here, in memory, so the test covers the real bundle contents
// whether or not a previous build left a copy on disk, and never writes into the working tree.
function engineBundleSource() {
  const { build } = require(path.join(ROOT, "tools", "engine-bundle.js"));
  return { label: "apps/guard/dist/clotr-engine.js (built in memory from its source files)", text: build().text };
}

test("Guard's shipped files resolve to a real, non-trivial set", () => {
  const files = shippedGuardFiles();
  assert.ok(files.length >= 5, `expected several shipped files, found ${files.length}`);
  assert.ok(files.some((file) => file.endsWith(path.join("bin", "clotr-mcp.js"))));
  assert.ok(files.some((file) => file.endsWith(path.join("bin", "clotr-guard.js"))));
  assert.ok(files.some((file) => file.endsWith(path.join("lib", "engine.js"))));
  assert.ok(files.some((file) => file.endsWith(path.join("lib", "secret-files.js"))));
  assert.ok(files.some((file) => file.endsWith(path.join("lib", "clotrignore.js"))));
});

test("no file Guard ships, or loads from its engine bundle, uses a network API", () => {
  const sources = shippedGuardFiles().map((file) => ({ label: file, text: fs.readFileSync(file, "utf8") }));
  sources.push(engineBundleSource());
  const violations = [];
  for (const { label, text } of sources) {
    const hits = findForbidden(text);
    if (hits.length) violations.push(`${label}: ${hits.join(", ")}`);
  }
  assert.deepEqual(violations, [], `network use found:\n${violations.join("\n")}`);
});

// The behavioural half of the same claim: patch the network APIs Guard would need to leave this computer so they
// throw, then run a live stdio exchange. If Guard ever needed the network to answer, this would fail loudly instead
// of just passing by accident.
function writeNoNetworkPreload(dir) {
  const file = path.join(dir, "no-network-preload.js");
  fs.writeFileSync(
    file,
    [
      '"use strict";',
      'const net = require("node:net");',
      "net.Socket.prototype.connect = function () {",
      '  throw new Error("guard-no-network test: a socket tried to connect");',
      "};",
      "globalThis.fetch = function () {",
      '  throw new Error("guard-no-network test: fetch was called");',
      "};",
      "",
    ].join("\n"),
  );
  return file;
}

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

test("clotr-mcp answers initialize and tools/list with net.connect and fetch patched to throw", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-guard-no-network-"));
  try {
    const preload = writeNoNetworkPreload(temp);
    const lines = [
      rpc(
        "initialize",
        { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        1,
      ),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      rpc("tools/list", {}, 2),
    ];
    const child = spawnSync(process.execPath, ["--require", preload, SERVER], {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    const replies = child.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(replies.length, 2, JSON.stringify(replies));
    assert.equal(replies[0].result.serverInfo.name, "clotr");
    assert.deepEqual(
      replies[1].result.tools.map((tool) => tool.name),
      ["check_text", "clean_text", "is_secret_file"],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

module.exports = { shippedGuardFiles, findForbidden, FORBIDDEN };
