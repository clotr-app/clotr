// The Tauri command line with Rust's tools found by tools/rust.js:
// npm run dev (Clotr for Windows built from these files and started, rebuilt as the code changes) and npm run build
// (target/release/clotr.exe, no installer: the store package is made with its own signing, later).
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { env, cargo, CRATE } = require("./rust");

function defaultFeatures() {
  const source = fs.readFileSync(path.join(CRATE, "Cargo.toml"), "utf8");
  const defaults = source.match(/^default\s*=\s*\[([^\]]*)\]/m)?.[1] || "";
  return new Set(
    defaults
      .split(",")
      .map((name) => name.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  );
}

if (["dev", "build"].includes(process.argv[2])) {
  const features = defaultFeatures();
  const prepared = spawnSync(process.execPath, [path.join(__dirname, "prepare-ui.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...env(),
      CLOTR_ONE_CLOTR_ENABLED: String(features.has("one-clotr")),
      CLOTR_SCAN_TIMES_ENABLED: String(features.has("scan-times")),
    },
    stdio: "inherit",
  });
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);

  const profileIndex = process.argv.indexOf("--profile");
  const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
  if (features.has("one-clotr")) {
    const buildArgs = ["build", "--locked", "--bin", "clotr-bridge"];
    if (profile) buildArgs.push("--profile", profile);
    else if (process.argv[2] === "build") buildArgs.push("--release");
    const bridge = cargo(buildArgs);
    if (bridge.status !== 0) process.exit(bridge.status ?? 1);
  }
}

const cli = require.resolve("@tauri-apps/cli/tauri.js", { paths: [path.join(__dirname, "..")] });
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: path.join(__dirname, ".."),
  env: env(),
  stdio: "inherit",
});
if (r.status !== 0) process.exit(r.status ?? 1);
