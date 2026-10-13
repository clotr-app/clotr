// npm run coverage: how much of extension/ the tests run, line by line, read from V8's own coverage data so it
// needs no extra package. It counts every .js file in extension/, so a file no test loads counts as 0% instead of
// dropping out of the total. Blank lines and comment-only lines don't count either way.
// The unit tests alone leave the pages and content scripts mostly unmeasured, since the browser suite
// (npm run test:e2e) is what runs them. npm run coverage:all runs that suite too, with V8's coverage switched on in
// every page, frame, worker and service worker (tests/e2e/coverage.js), and counts a line as run when either suite
// ran it. It takes as long as the browser suite and needs the same browser, so it stays out of the required CI
// checks; a CI job can run it on its own and pass --min to hold the line.
// Usage: npm run coverage                       every unit test, then a line per file and the total
//        npm run coverage:all                   the unit tests and the browser suite, merged
//        npm run coverage -- --e2e-file <file>  the unit tests merged with a browser run already saved by
//                                               npm run test:e2e -- --coverage (tests/e2e/output/coverage.json)
//        npm run coverage -- --min 80           also fails when the total is under 80%
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
// Builds and tests a whole second copy of the repo, so its coverage would be someone else's.
const SKIP = ["tests/export.test.js"];

// One script's V8 coverage as a line list: true if any of the line's code ran, false if none did, null for a blank
// or comment-only line. Ranges are painted outermost first, so a block's own count overrides its function's.
function lineCoverage(source, functions) {
  const counts = new Int32Array(source.length).fill(-1);
  const ranges = functions
    .flatMap((f) => f.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, source.length));
  const lines = [];
  let start = 0;
  for (const text of source.split("\n")) {
    const trimmed = text.trim();
    if (!trimmed || /^(\/\/|\/\*|\*)/.test(trimmed)) lines.push(null);
    else {
      let ran = false;
      for (let i = start; i < start + text.length && !ran; i++) if (!/\s/.test(source[i]) && counts[i] > 0) ran = true;
      lines.push(ran);
    }
    start += text.length + 1;
  }
  return lines;
}

// The extension file a coverage entry belongs to, as "extension/name.js", or null. Tests that load a file with
// require() report its file URL; the ones that run it in a vm context report the bare name they gave it.
function extensionFile(url, root = ROOT) {
  let file;
  if (url.startsWith("file:")) file = fileURLToPath(url);
  else if (/^[\w.-]+\.js$/.test(url)) file = path.join(root, "extension", url);
  else return null;
  const rel = path.relative(path.join(root, "extension"), file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !rel.endsWith(".js") || !fs.existsSync(file)) return null;
  return `extension/${rel.replace(/\\/g, "/")}`;
}

// A script the browser suite ran from Clotr, as "extension/name.js", or null. Pages, content scripts and the service
// worker report chrome-extension://<id>/<path>. A run loads copies of extension/ from other folders, under other IDs,
// and other extensions beside it, so dirs maps each ID the run knows to the folder it was loaded from, and a script
// only counts when that folder's copy reads the same as the file here. That also keeps out a packaged build's
// rewritten files.
function browserFile(url, dirs, root = ROOT) {
  const m = /^chrome-extension:\/\/([a-p]{32})\/([^?#]+\.js)$/.exec(url);
  if (!m || !dirs.has(m[1])) return null;
  const rel = decodeURIComponent(m[2]);
  const file = extensionFile(pathToFileURL(path.join(root, "extension", rel)).href, root);
  if (!file) return null;
  const copy = path.join(dirs.get(m[1]), rel);
  const same =
    path.resolve(copy) === path.join(root, file) || (fs.existsSync(copy) && read(copy) === read(path.join(root, file)));
  return same ? file : null;
}

const sources = new Map();
function read(file) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(file, "utf8"));
  return sources.get(file);
}
const readSource = (file, root = ROOT) => read(path.join(root, file));

// Two line lists for the same file from different test processes: a line that ran in either one ran.
function merge(a, b) {
  if (!a) return b;
  return b.map((line, i) => (line === null ? null : line || a[i] === true));
}

function extensionFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith(".js")) out.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(path.join(root, "extension"));
  return out.sort();
}

// Every extension file with its covered and counted lines, plus the totals. A file with no coverage counts its
// own lines, with none of them covered.
function summary(root, byFile) {
  const files = extensionFiles(root).map((file) => {
    let lines = byFile[file];
    const loaded = Boolean(lines);
    if (!lines) lines = lineCoverage(fs.readFileSync(path.join(root, file), "utf8"), []);
    const counted = lines.filter((l) => l !== null);
    return { file, loaded, covered: counted.filter(Boolean).length, total: counted.length };
  });
  const covered = files.reduce((n, f) => n + f.covered, 0);
  const total = files.reduce((n, f) => n + f.total, 0);
  return { files, covered, total };
}

// Reads every coverage file V8 wrote into dir and merges what belongs to extension/.
function collect(dir, root = ROOT) {
  const byFile = {};
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    for (const entry of JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).result || []) {
      const file = extensionFile(entry.url, root);
      if (!file) continue;
      const lines = lineCoverage(fs.readFileSync(path.join(root, file), "utf8"), entry.functions);
      byFile[file] = merge(byFile[file], lines);
    }
  }
  return byFile;
}

const pct = (covered, total) => (total ? (100 * covered) / total : 100).toFixed(1);

// A browser run's saved lines (tests/e2e/coverage.js), merged into the unit tests' own.
function mergeBrowserRun(byFile, file) {
  const { lines } = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [name, list] of Object.entries(lines)) byFile[name] = merge(byFile[name], list);
  return byFile;
}

// Runs the browser suite with coverage on, saving its lines to file. True when every check passed.
function runBrowserSuite(file) {
  console.log("\nThe browser suite, with coverage on:");
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join("tests", "e2e", "run.js")], {
    cwd: ROOT,
    env: { ...process.env, CLOTR_E2E_COVERAGE: file },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.status !== 0) console.warn("Some browser checks failed, so the numbers below may be lower than usual.");
  if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < started) {
    throw new Error("The browser suite saved no coverage.");
  }
  return run.status === 0;
}

function main(args) {
  const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const min = valueOf("--min") === null ? null : Number(valueOf("--min"));
  const e2eFile = valueOf("--e2e-file");
  const withBrowser = args.includes("--e2e") || Boolean(e2eFile);
  const tests = fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => `tests/${f}`)
    .filter((f) => !SKIP.includes(f))
    .sort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-coverage-"));
  try {
    const env = { ...process.env, NODE_V8_COVERAGE: dir };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...tests], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (run.status !== 0) console.warn("Some tests failed, so the numbers below may be lower than usual.");
    const byFile = collect(dir);
    let browserPassed = true;
    if (withBrowser) {
      // Kept where npm run test:e2e -- --coverage puts it, so --e2e-file can merge it again without a second run.
      const file = e2eFile ? path.resolve(e2eFile) : path.join(ROOT, "tests", "e2e", "output", "coverage.json");
      if (!e2eFile) fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!e2eFile) browserPassed = runBrowserSuite(file);
      mergeBrowserRun(byFile, file);
    }
    const result = summary(ROOT, byFile);
    const width = Math.max(...result.files.map((f) => f.file.length));
    for (const f of result.files) {
      console.log(
        `${f.file.padEnd(width)}  ${pct(f.covered, f.total).padStart(5)}%  ${f.covered}/${f.total}` +
          (f.loaded ? "" : withBrowser ? "  (no test loads it)" : "  (no unit test loads it)"),
      );
    }
    const total = pct(result.covered, result.total);
    const who = withBrowser ? "the unit tests and the browser suite" : "the unit tests";
    console.log(`\nLines of extension/ ${who} run: ${total}% (${result.covered} of ${result.total}).`);
    if (min !== null && Number(total) < min) {
      console.error(`That's under the ${min}% asked for.`);
      return 1;
    }
    return run.status === 0 && browserPassed ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ROOT,
  lineCoverage,
  extensionFile,
  browserFile,
  readSource,
  merge,
  mergeBrowserRun,
  summary,
  collect,
};
