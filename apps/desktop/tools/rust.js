// Runs Rust's tools for Clotr for Windows with the toolchain this PC keeps for Clotr (%LOCALAPPDATA%\Clotr\toolchains,
// set for this run only, never on the system or user PATH), or the one already on the PATH elsewhere.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const engineBundle = require(path.join(__dirname, "..", "..", "..", "tools", "engine-bundle.js"));

const CRATE = path.join(__dirname, "..", "src-tauri");

function env() {
  const out = { ...process.env };
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Clotr", "toolchains", "rust");
  if (base && fs.existsSync(path.join(base, "cargo", "bin"))) {
    out.RUSTUP_HOME = path.join(base, "rustup");
    out.CARGO_HOME = path.join(base, "cargo");
    const key = Object.keys(out).find((k) => k.toLowerCase() === "path") || "PATH";
    out[key] = `${path.join(base, "cargo", "bin")}${path.delimiter}${out[key] || ""}`;
  }
  // Rust writes the build machine's own folders into a program's error messages, and anyone can read them in the
  // published clotr.exe. Map them to neutral names, so the user's folder name never ships. The encoded form takes
  // paths with spaces (this repo's folder has one). Later flags win, so the general home folder goes first.
  const remaps = [
    [process.env.USERPROFILE, "~"],
    [out.RUSTUP_HOME, "rustup"],
    [out.CARGO_HOME, "cargo"],
    [path.join(__dirname, "..", "..", ".."), "clotr"],
  ].filter(([from]) => from);
  out.CARGO_ENCODED_RUSTFLAGS = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join("\x1f");
  return out;
}

function ensureEngineBundlesFresh(files, now) {
  const stale =
    files === undefined
      ? [
          ...engineBundle.staleBundles([engineBundle.WRITTEN[0]], engineBundle.build()),
          ...engineBundle.staleBundles([engineBundle.WRITTEN[1]], engineBundle.build({ scans: true })),
        ]
      : engineBundle.staleBundles(files, now);
  if (stale.length) throw new Error(stale.map((bundle) => bundle.message).join("\n"));
}

// cargo <args> in src-tauri. Returns { status, stdout } (stdout only when `capture`).
function runCargo(args, { capture = false, checkFresh = ensureEngineBundlesFresh, spawn = spawnSync } = {}) {
  checkFresh();
  const r = spawn("cargo", args, {
    cwd: CRATE,
    env: env(),
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || "" };
}

function cargo(args, options) {
  return runCargo(args, options);
}

module.exports = { cargo, runCargo, ensureEngineBundlesFresh, env, CRATE };
