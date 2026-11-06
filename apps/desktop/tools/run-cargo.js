// Clotr for Windows' own checks, with Rust's tools (tools/rust.js finds them):
//   node tools/run-cargo.js test  the unit tests (cargo test), the licence and ban check (cargo deny), NOTICE current
//   node tools/run-cargo.js dk    the DK checks on this PC's real desktop (tests/dk.rs; each in its own test process,
//                                 one Clotr at a time; it takes the front window, clipboard, keyboard and mouse)
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
  // One test process at a time: UI Automation can retain WebView2 provider state between test functions, so a
  // fresh process per check keeps each real desktop run independent and still lets only one Clotr run at once.
  const base = ["test", "--locked", "--features", "dk-test-app", "--test", "dk"];
  const listed = cargo([...base, "--", "--list"], { capture: true });
  run("listing the DK checks", listed.status === 0);
  const tests = listed.stdout
    .split(/\r?\n/)
    .filter((line) => /^dk_[\w]+: test$/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
  run("finding the DK checks", tests.length > 0);
  for (const test of tests) {
    const args = [...base, test, "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"];
    run(`the DK check ${test}`, cargo(args).status === 0);
  }
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
