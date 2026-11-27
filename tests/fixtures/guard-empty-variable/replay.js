"use strict";

// Runs a fixed list of shell commands through Guard's shell check and prints one line an answer, so two copies of
// Guard can be compared with a plain diff. A move should change no line. A fix should change only its own lines.
//
//   node replay.js <apps\guard> [cases.json] > answers.tsv
//
// Each case is { id, t: "bash" | "ps" | "cursor", c: the command, d: "proj" | "plain" }. "proj" is a small project
// with a .env, a .kube\config and an example env file. "plain" has no secret file in it. Both are made new each run
// under the system's temp folder, and the value in them is made up.
// Every case runs three times: as the hook does it, then with only the first reading, then with only the new one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const guardRoot = path.resolve(process.argv[2] || "");
const casesFile = path.resolve(process.argv[3] || path.join(__dirname, "shell-cases.json"));
if (!process.argv[2] || !fs.existsSync(path.join(guardRoot, "bin", "clotr-guard.js"))) {
  console.error("usage: node replay.js <apps\\guard> [cases.json]");
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "guard-replay-"));
const made = ["made", "up", "value", "for", "replay"].join("-");
function put(folder, name, text) {
  const full = path.join(home, folder, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
put("proj", ".env", `APP_TOKEN=${made}\nPORT=3000\n`);
put("proj", "sub/.env", `APP_TOKEN=${made}\n`);
put("proj", ".kube/config", `token: ${made}\n`);
put("proj", ".env.example", "APP_TOKEN=\nPORT=3000\n");
put("proj", "README.md", "# demo\nCopy .env.example to .env first.\n");
put("proj", "notes.txt", "notes\n");
put("proj", "package.json", '{"name":"demo","version":"1.0.0"}\n');
put("proj", ".gitignore", "node_modules\n.env\n");
put("proj", "src/app.js", "console.log(process.env.PORT);\n");
put("proj", "src/util.js", "module.exports = {};\n");
put("proj", "docs/guide.md", "guide\n");
put("proj", "logs/app.log", "started\n");
for (const name of ["package.json", "tsconfig.json", "config.json", "notes.txt", "src/config.ts", "src/server.js"]) {
  put("plain", name, "{}\n");
}

const guard = require(path.join(guardRoot, "bin", "clotr-guard.js"));
const rows = [];
for (const each of JSON.parse(fs.readFileSync(casesFile, "utf8"))) {
  const cwd = path.join(home, each.d || "proj");
  const tool = each.t === "cursor" ? "cursor" : "claude";
  const event =
    each.t === "cursor"
      ? { command: each.c, cwd }
      : { tool_name: each.t === "ps" ? "PowerShell" : "Bash", tool_input: { command: each.c } };
  const answers = [];
  for (const reading of ["", "first", "new"]) {
    let outcome;
    try {
      outcome = guard.inspectShell(tool, event, reading ? { cwd, shellReading: reading } : { cwd });
    } catch (error) {
      outcome = { action: "THROW", location: String(error && error.message) };
    }
    const why = outcome.location ?? outcome.reason ?? (outcome.internalError ? "internalError" : "");
    answers.push(`${outcome.action}${why ? ` ${String(why).split(home).join("<tmp>").slice(0, 60)}` : ""}`);
  }
  rows.push([each.id, each.t, ...answers].join("\t"));
}
fs.rmSync(home, { recursive: true, force: true });
process.stdout.write(`${rows.join("\n")}\n`);
