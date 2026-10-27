// Clotr for Windows' own checks, with Rust's tools (tools/rust.js finds them):
//   node tools/run-cargo.js test  the unit tests (cargo test), the licence and ban check (cargo deny), NOTICE current
//   node tools/run-cargo.js dk    the DK checks on this PC's real desktop (tests/dk.rs; about a minute, and it takes
//                                 the front window, the clipboard, the keyboard and the mouse for a moment)
//   node tools/run-cargo.js cpu   the idle processor-use guard (tests/cpu.rs; about 5 minutes, no screen needed)
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { cargo, env } = require("./rust");

function run(label, ok) {
  if (!ok) {
    console.error(`[Clotr] ${label}: failed`);
    process.exit(1);
  }
}

const what = process.argv[2];
if (what === "test") {
  run("cargo test", cargo(["test", "--locked"]).status === 0);
  const deny = spawnSync("cargo", ["deny", "--version"], { env: env(), encoding: "utf8" });
  if (deny.status === 0) run("cargo deny", cargo(["deny", "check", "licenses", "bans", "sources"]).status === 0);
  else {
    console.warn("[Clotr] cargo deny isn't installed here: licences not checked (cargo install cargo-deny --locked)");
  }
  const notice = spawnSync(process.execPath, [path.join(__dirname, "notice.js"), "--check"], { stdio: "inherit" });
  run("NOTICE", notice.status === 0);
} else if (what === "dk") {
  // One test at a time: each starts its own Clotr, and only one Clotr runs at once.
  const args = ["test", "--locked", "--features", "dk-test-app", "--test", "dk", "--"];
  args.push("--ignored", "--nocapture", "--test-threads=1");
  run("the DK checks", cargo(args).status === 0);
} else if (what === "cpu") {
  // Needs no screen, so unlike dk it isn't --ignored: this is meant to fail the build on its own.
  const args = [
    "test",
    "--locked",
    "--features",
    "dk-test-app",
    "--test",
    "cpu",
    "--",
    "--nocapture",
    "--test-threads=1",
  ];
  run("the idle processor-use guard", cargo(args).status === 0);
} else {
  console.error("Usage: node tools/run-cargo.js test|dk|cpu");
  process.exit(2);
}
