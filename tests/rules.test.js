// These are Clotr's hard rules, checked by scanning the shipped extension's source directly. A broken rule fails
// npm test right away, instead of waiting for a review or a real site to catch it.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const scripts = fs.readdirSync(EXT).filter((f) => f.endsWith(".js"));
const htmls = fs.readdirSync(EXT).filter((f) => f.endsWith(".html"));

// Strips comments out of the source first, so a rule explained in a comment doesn't trip its own scan.
function code(file) {
  return fs
    .readFileSync(path.join(EXT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

function offenders(re, files = scripts) {
  return files.flatMap((f) =>
    code(f)
      .split("\n")
      .map((line, i) => (re.test(line) ? `${f}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean),
  );
}

test("every script parses as a classic script (no import/export)", () => {
  for (const f of scripts) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(EXT, f), "utf8"), { filename: f }), f);
  }
  assert.deepEqual(offenders(/^\s*(import|export)\s/), []);
  assert.notEqual(manifest.background?.type, "module", "background must stay a classic service worker");
});

test("manifest: MV3, valid version, files exist", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(\.[1-9]\d*)?$/); // a fourth number for a build between releases
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
});

test("scope: only specific https AI-site origins, never broad patterns", () => {
  const broad = (p) => p === "<all_urls>" || /^(\*|https?):\/\/\*(\/|\.)/.test(p);
  const matches = manifest.content_scripts.flatMap((c) => c.matches);
  for (const m of matches) {
    assert.match(m, /^https:\/\/[a-z0-9.-]+\.[a-z]+\/.*$/, `content script match: ${m}`);
    assert.ok(!broad(m), `broad content script match: ${m}`);
  }
  for (const p of manifest.host_permissions || []) assert.ok(!broad(p), `broad host permission: ${p}`);
  // Per-site opt-in is requested at runtime from this optional set. Nothing broad is granted up front.
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.ok(!(manifest.permissions || []).some(broad), "broad pattern in permissions");
});

// A permission like webRequest, declarativeNetRequest, debugger, tabs, cookies or history would let a
// compromised copy of Clotr read or reroute traffic across the whole browser, far beyond the AI sites it
// protects. This checks every manifest the build produces: the one Chrome and Edge ship from extension/, and
// Firefox's own transform of it.
test("scope: no manifest the build produces gains a permission that can read or reroute traffic", () => {
  const { firefoxManifest, build } = require("../tools/package.js");
  const banned = ["webRequest", "webRequestBlocking", "debugger", "history", "tabs", "cookies"];
  // Only Extension check's management permission, read-only and asked for only when someone clicks to check.
  const allowedOptional = new Set(["management"]);
  for (const m of [manifest, firefoxManifest(JSON.parse(JSON.stringify(manifest)))]) {
    for (const p of m.permissions || [])
      assert.ok(!banned.includes(p) && !p.startsWith("declarativeNetRequest"), `required permission gained: ${p}`);
    for (const p of m.optional_permissions || []) assert.ok(allowedOptional.has(p), `optional permission gained: ${p}`);
  }
  // In the build Clotr ships, Extension check is held back, so there's no optional permission at all.
  const shipped = build({ zip: false }).manifest;
  assert.deepEqual(shipped.optional_permissions ?? [], []);
  // In the all-on build used for the browser suite's held-back-feature checks, that management permission comes back.
  const allOn = build({ zip: false, features: { extcheck: true } }).manifest;
  assert.deepEqual(allOn.optional_permissions, ["management"]);
});

// Email and chat apps are never built in. Each one runs Clotr only after the person switches it on and the
// browser grants that one site, so the install prompt never mentions them.
test("scope: everyday sites (email, chat apps) are specific https hosts and never built in", () => {
  globalThis.chrome ??= {};
  require("../extension/sites.js");
  const { EVERYDAY_SITES } = globalThis.ClotrSites;
  assert.ok(EVERYDAY_SITES.length >= 4, "the everyday list is there");
  const builtIn = new Set(
    [...manifest.content_scripts.flatMap((c) => c.matches), ...(manifest.host_permissions || [])].map(
      (p) => new URL(p.replace(/\*$/, "")).hostname,
    ),
  );
  for (const s of EVERYDAY_SITES) {
    assert.ok(s.name && ["email", "chat"].includes(s.kind), `${s.name}: a name and a kind`);
    for (const m of s.matches) {
      assert.match(m, /^https:\/\/[a-z0-9.-]+\.[a-z]+\/\*$/, `${s.name}: ${m} is one whole https host`);
      assert.ok(!builtIn.has(new URL(m.replace(/\*$/, "")).hostname), `${s.name}: ${m} is built in`);
    }
  }
});

// Clotr only ever asks the browser for a new permission in four places. requestEverydayApps in sites.js asks for
// listed email and chat apps by name, so it can only request addresses already on that list. protectSite in
// popup.js asks for the single site the popup is open on. askForAiChats in vault.js, on the welcome page's card,
// asks for built-in AI chats the browser hasn't granted yet, and ignores anything not on the manifest's own list.
// startCheck in extcheck.js asks for the optional management permission, reads it once, and hands it straight
// back; a test below checks it's never kept or used to change an extension. Any other ask, anywhere, fails here.
const ASK_ALLOWED = {
  "sites.js": ["requestEverydayApps"],
  "popup.js": ["protectSite"],
  "vault.js": ["askForAiChats"],
  "extcheck.js": ["startCheck"],
};

// Finds where a function's body starts and ends in a source string, counting braces and skipping over quoted
// strings.
function functionSpan(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index);
  const start = i;
  for (let depth = 0, quote = null; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return [start, i];
  }
  return null;
}

// Finds every place in sources (a map of file name to code) that asks for a permission outside the allowed
// functions above: a call to permissions.request, a permissions[...] lookup, or chrome.permissions passed around
// as a whole object, since an alias to it could ask later. Reading grants, removing them, and their events are
// fine anywhere, so those are left alone.
const ASK =
  /permissions\s*(\.\s*request\b|\[)|\b(chrome|browser)\s*\.\s*permissions\b(?!\s*\??\.\s*(getAll|contains|remove|onAdded|onRemoved|request)\b)/g;
function permissionAsks(sources) {
  const bad = [];
  for (const [file, src] of Object.entries(sources)) {
    const spans = (ASK_ALLOWED[file] || []).map((name) => functionSpan(src, name)).filter(Boolean);
    for (const m of src.matchAll(ASK)) {
      if (!spans.some(([a, b]) => m.index > a && m.index < b))
        bad.push(`${file}:${src.slice(0, m.index).split("\n").length}: ${m[0]}`);
    }
  }
  return bad;
}

test("scope: Clotr asks only for listed email and chat apps or the open tab", () => {
  const sources = Object.fromEntries(scripts.map((f) => [f, code(f)]));
  assert.deepEqual(permissionAsks(sources), []);
  for (const [file, names] of Object.entries(ASK_ALLOWED))
    for (const name of names) assert.ok(functionSpan(sources[file], name), `${file}: ${name} is gone`);
  // The welcome page's card never asks for a new permission. It only asks for sites the manifest already lists,
  // dropping anything that isn't on that list.
  const [a, b] = functionSpan(sources["vault.js"], "askForAiChats");
  const ask = sources["vault.js"].slice(a, b);
  assert.match(ask, /const builtIn = new Set\(chrome\.runtime\.getManifest\(\)\.host_permissions\b/);
  assert.equal(ask.match(/permissions\.request\b/g).length, 1);
  assert.match(ask, /permissions\.request\(\{ origins: origins\.filter\(\(o\) => builtIn\.has\(o\)\) \}\)/);
  // An ask planted anywhere else in the code gets caught.
  const planted = (file, line) => permissionAsks({ ...sources, [file]: `${sources[file]}\n${line}\n` });
  assert.equal(planted("content.js", 'chrome.permissions.request({ origins: ["https://*/*"] });').length, 1);
  assert.equal(planted("popup.js", "async function x() { await chrome.permissions.request({ origins }); }").length, 1);
  assert.equal(planted("vault.js", 'chrome.permissions["request"]({ origins });').length, 1);
  assert.equal(planted("sites.js", "chrome.permissions . request({ origins: o });").length, 1);
  assert.equal(planted("warning-ui.js", "const p = chrome.permissions; p.request({ origins });").length, 1);
  assert.equal(
    planted("background.js", "chrome.permissions.getAll(); chrome.permissions.remove({ origins });").length,
    0,
  );
});

// Firefox only shows its permission prompt when the ask happens in the same turn as the click; after any await
// it refuses, and the button just does nothing. So every function that asks for a permission has to do it before
// anything else runs.
const waitsBeforeAsking = (body) => {
  const ask = body.search(/(\bawait\s+)?\b(chrome|browser)\s*\.\s*permissions\s*\.\s*request\b/);
  return ask < 0 ? null : /\bawait\b/.test(body.slice(0, ask));
};
test("scope: every ask comes first, in the click's own turn", () => {
  for (const [file, names] of Object.entries(ASK_ALLOWED)) {
    const src = code(file);
    for (const name of names) {
      const [a, b] = functionSpan(src, name);
      const waits = waitsBeforeAsking(src.slice(a, b));
      assert.notEqual(waits, null, `${file}: ${name} no longer asks`);
      assert.equal(waits, false, `${file}: ${name} waits for something before it asks`);
    }
  }
  // The check itself.
  assert.equal(waitsBeforeAsking("{ await x(); await chrome.permissions.request({ origins }); }"), true);
  assert.equal(waitsBeforeAsking("{ const p = chrome.permissions.request({ origins }); await p; }"), false);
  assert.equal(waitsBeforeAsking("{ return Boolean(await chrome.permissions.request({ origins })); }"), false);
});

// The same rule applies everywhere requestEverydayApps gets called: the welcome page's card, the popup's
// switches, the setup page's apps step. Whatever calls it, usually a click handler, has to do so before
// anything else runs.

// Finds where the function body enclosing a given index starts: the innermost still-open `{` that belongs to a
// function, whether it opens after `=>`, a `function(...)` keyword, or a plain `name(...)` call. Strings and
// comments are skipped along the way.
function enclosingBody(src, index) {
  const open = [];
  for (let i = 0, quote = null; i < index; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") {
      const head = src.slice(Math.max(0, i - 200), i);
      const fn =
        /=>\s*$/.test(head) ||
        /\bfunction\b[\w\s$]*\([^()]*\)\s*$/.test(head) ||
        /(^|[\s,{;])(?!(?:if|for|while|switch|catch|with)\b)[A-Za-z_$][\w$]*\s*\([^()]*\)\s*$/.test(head);
      open.push({ at: i, fn });
    } else if (c === "}") open.pop();
  }
  return [...open].reverse().find((b) => b.fn)?.at ?? -1;
}
const CALL_ASK = /(\bawait\s+)?\b(?:[\w$]+\.)*requestEverydayApps\s*\(/g;
function waitsBeforeEverydayAsk(src) {
  const bad = [];
  for (const m of src.matchAll(CALL_ASK)) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition itself
    const start = enclosingBody(src, m.index);
    if (start < 0 || /\bawait\b/.test(src.slice(start, m.index))) bad.push(src.slice(0, m.index).split("\n").length);
  }
  return bad;
}
test("scope: every page that asks for email and chat apps asks first, in the click's own turn", () => {
  const callers = scripts.filter((f) => f !== "sites.js" && /requestEverydayApps\s*\(/.test(code(f)));
  assert.ok(callers.length >= 2, `callers: ${callers}`);
  for (const f of callers) assert.deepEqual(waitsBeforeEverydayAsk(code(f)), [], `${f} waits before it asks`);
  // The check itself.
  const ok = 'b.addEventListener("click", () => { const n = pick(); Sites.requestEverydayApps(n).then(done); });';
  assert.deepEqual(waitsBeforeEverydayAsk(ok), []);
  assert.deepEqual(
    waitsBeforeEverydayAsk("async function on(s) { if (s) { await Sites.requestEverydayApps([s]); } }"),
    [],
  );
  assert.equal(
    waitsBeforeEverydayAsk("async function go() { await load(); Sites.requestEverydayApps(names); }").length,
    1,
  );
  assert.equal(
    waitsBeforeEverydayAsk('b.onclick = async () => { await x; if (y) { requestEverydayApps(["Gmail"]); } };').length,
    1,
  );
});

// Extension check's management permission is optional, asked for only when someone presses the button, and
// never kept afterward. This proves it stays read-only: no file anywhere may call a management method that
// changes or removes an extension or app, so Clotr could never end up able to turn one off or uninstall it.
const DESTRUCTIVE =
  /\bmanagement\s*\.\s*(setEnabled|uninstallSelf|uninstall|install|launchApp|createAppShortcut|generateAppForLink|setLaunchType)\s*\(/;
test("scope: the management permission is optional only, and Clotr never changes an extension", () => {
  assert.ok(!(manifest.permissions || []).includes("management"), "management is a permission Clotr always has");
  assert.ok((manifest.optional_permissions || []).includes("management"), "management isn't offered at all");
  assert.deepEqual(offenders(DESTRUCTIVE), []);
  // Plants each forbidden call in a throwaway script and checks it gets caught. The file's name is unique to this
  // process and run, rather than a fixed name, because two test runs over the same checkout at once could
  // otherwise race and read back each other's planted line, which has happened before.
  const plantedName = `zz-rule-check-planted-${process.pid}-${Date.now()}.js`;
  const planted = path.join(EXT, plantedName);
  try {
    for (const bad of [
      "chrome.management.setEnabled(id, false);",
      "chrome.management.uninstall(id);",
      "chrome.management.uninstallSelf();",
      "chrome.management.install(opts);",
      "chrome.management.launchApp(id);",
      "chrome.management.createAppShortcut(id);",
      "chrome.management.generateAppForLink(url, title);",
      "chrome.management.setLaunchType(id, type);",
    ]) {
      fs.writeFileSync(planted, `${bad}\n`);
      assert.equal(offenders(DESTRUCTIVE, [plantedName]).length, 1, bad);
    }
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

// Neither scan writes anything to storage.
test("Look back and Extension check write nothing to storage", () => {
  assert.deepEqual(
    offenders(/chrome\.storage\.(local|sync)\.set\s*\(/, [
      "lookback.js",
      "lookback-worker.js",
      "lookback-core.js",
      "letter.js",
      "extcheck.js",
      "extcheck-core.js",
      "reported-extensions.js",
      "scan-words.js",
      "zip.js",
    ]),
    [],
  );
});

test("no innerHTML-style HTML injection (Trusted Types)", () => {
  assert.deepEqual(offenders(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/), []);
});

test("100% local: no network calls, no remote code", () => {
  assert.deepEqual(offenders(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\(\s*["'`]http/), []);
  // fetch is only allowed for the extension's own files.
  assert.deepEqual(offenders(/fetch\((?!\s*chrome\.runtime\.getURL\()/), []);
  assert.deepEqual(offenders(/<script[^>]+src=["']https?:/i, htmls), []);
  assert.deepEqual(offenders(/<link[^>]+href=["']https?:/i, htmls), []);
  // Code can't be built from strings. The CSP forbids that outright on Clotr's own pages, and content scripts
  // run under each AI site's own policy instead.
  assert.deepEqual(offenders(/\beval\s*\(|\bnew\s+Function\s*\(|\bset(Timeout|Interval)\(\s*["'`]/), []);
});

// Clotr's scripts inside an AI page share that page with the site's own code, so a message that removes or
// loosens a protected detail, replaces every setting, or clears history only gets accepted from Clotr's own pages.
test("vault edits, backups and clearing history are accepted only from Clotr's own pages", () => {
  const bg = code("background.js");
  assert.match(
    bg,
    /const fromClotrPage = \(sender\) => \(sender\.url \|\| ""\)\.startsWith\(chrome\.runtime\.getURL\(""\)\);/,
  );
  for (const type of ["clotr:vaultUpdate", "clotr:importBackup", "clotr:clearHistory"]) {
    const at = bg.indexOf(`case "${type}":`);
    assert.ok(at > 0, type);
    const body = bg.slice(at, bg.indexOf("return reply(", at));
    assert.match(body, /if \(!fromClotrPage\(sender\)\) return false;/, `${type} checks the sender first`);
  }
  // And the scripts inside AI pages never send them.
  assert.deepEqual(
    offenders(
      /clotr:(vaultUpdate|importBackup|clearHistory)/,
      manifest.content_scripts.flatMap((c) => c.js),
    ),
    [],
  );
});

test("chrome.action.setIcon always passes a tabId", () => {
  const calls = scripts.flatMap((f) => code(f).match(/chrome\.action\.setIcon\(\{[^}]*\}/g) || []);
  for (const c of calls) assert.match(c, /tabId/, c);
});

test("user-added sites get the same scripts as built-in ones", () => {
  const listed = code("sites.js").match(/const CONTENT_JS = (\[[^\]]*\])/);
  assert.ok(listed, "CONTENT_JS not found in sites.js");
  assert.deepEqual(JSON.parse(listed[1].replace(/,\s*\]$/, "]")), manifest.content_scripts[0].js); // a formatter may add a trailing comma
  // The popup shows detection types and fingerprints, so it needs the detection pair loaded and nothing else.
  const popup = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  for (const f of ["patterns.js", "detector.js"]) {
    assert.ok(manifest.content_scripts[0].js.includes(f), `content scripts don't include ${f}`);
    assert.ok(popup.includes(`<script src="${f}">`), `popup.html doesn't load ${f}`);
  }
});

// The background registers Clotr under clotr-user-sites for sites people add, and starts it in open tabs using
// that same CONTENT_JS list rather than one of its own, so every way Clotr reaches a page loads the same scripts
// in the manifest's order. The warning UI comes after what it reads, the styles and chat-box helpers, and before
// content.js.
test("the dynamic registration and every injection use CONTENT_JS, in the manifest's order", () => {
  const bg = code("background.js");
  assert.match(bg, /\{\s*CONTENT_JS,[\s\S]*?\}\s*=\s*globalThis\.ClotrSites;/, "CONTENT_JS comes from sites.js");
  const script = /const script = \{[\s\S]*?\};/.exec(bg)?.[0] || "";
  assert.match(script, /id: USER_SCRIPT_ID,/, "the user-site registration");
  assert.match(script, /\bjs: CONTENT_JS,/, "the user-site registration loads CONTENT_JS");
  assert.match(bg, /registerContentScripts\(\[script\]\)/);
  assert.match(bg, /updateContentScripts\(\[script\]\)/);
  const injections = bg.match(/executeScript\(\{[^;]*\}\)/g) || [];
  assert.ok(injections.length >= 2, `found ${injections.length} injections into open tabs`);
  for (const call of injections) assert.match(call, /\bfiles: CONTENT_JS \}/, call);
  const js = manifest.content_scripts[0].js;
  assert.deepEqual(js.slice(-3), ["editor.js", "warning-ui.js", "content.js"]);
  assert.ok(js.indexOf("ui-styles.js") < js.indexOf("warning-ui.js"), "the styles load before the warning UI");
});

// decide.js is the one pure module that decides what each found detail does and holds the words for it. Every
// host runs it right after the detection pair, and it touches no page, no storage and no browser API, so other
// hosts can run it unchanged.
test("decide.js: right after the detection pair everywhere, and pure", () => {
  const js = manifest.content_scripts[0].js;
  assert.deepEqual(js.slice(0, 3), ["patterns.js", "detector.js", "decide.js"], "the content scripts");
  const bg = code("background.js");
  assert.ok(
    bg.indexOf('importScripts("decide.js")') > bg.indexOf('importScripts("patterns.js", "detector.js")'),
    "the background loads it after the detection pair",
  );
  const { BACKGROUND_SCRIPTS } = require("../tools/package.js");
  assert.deepEqual(BACKGROUND_SCRIPTS.slice(0, 3), ["patterns.js", "detector.js", "decide.js"], "Firefox and Safari");
  assert.deepEqual(
    offenders(/\b(document|window|chrome|navigator|localStorage|fetch|console|setTimeout)\b/, ["decide.js"]),
    [],
  );
  const vault = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
  assert.ok(vault.indexOf('<script src="decide.js">') > vault.indexOf('<script src="detector.js">'), "the vault page");
});

// commands.js loads wherever Clotr runs on a page, after the detection trio and before the warning UI and
// content.js that use it. It's pure: it only reads the two strings it's given, so it touches no page, no
// storage, no network and no browser API, and logs nothing.
test("commands.js: in the content scripts before what uses it, and pure", () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes("commands.js"), "the content scripts load commands.js");
  assert.ok(js.indexOf("commands.js") > js.indexOf("decide.js"), "after the detection trio");
  assert.ok(js.indexOf("commands.js") < js.indexOf("warning-ui.js"), "before the warning UI");
  assert.ok(js.indexOf("commands.js") < js.indexOf("content.js"), "before content.js");
  const src = code("commands.js");
  const bad = [
    /\b(?:document|window|navigator|location)\s*[.[]/,
    /\bchrome\.|\bbrowser\.|localStorage|sessionStorage|indexedDB/,
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|sendMessage/,
    /\bconsole\./,
  ].filter((re) => re.test(src));
  assert.deepEqual(
    bad.map((re) => re.source),
    [],
  );
  assert.match(src, /C\.commandTrick = commandTrick;/);
});

test("built-in AI-site list (ai-sites.json) matches the manifest", () => {
  const sites = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  const names = sites.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const s of sites) {
    assert.ok(typeof s.name === "string" && s.name.trim(), `site without a name: ${JSON.stringify(s)}`);
    assert.ok(Array.isArray(s.matches) && s.matches.length, `${s.name}: no matches`);
  }
  assert.deepEqual(
    sites.flatMap((s) => s.matches),
    manifest.content_scripts[0].matches,
    "out of sync: run `npm run sites` after editing ai-sites.json",
  );
  // Host access to the same sites lets an update start the new version in open tabs.
  assert.deepEqual(
    manifest.host_permissions,
    manifest.content_scripts[0].matches,
    "host_permissions out of sync: run `npm run sites`",
  );
});

test("every pattern belongs to a Settings group", () => {
  require("../extension/patterns.js");
  for (const p of globalThis.Clotr.PATTERNS)
    assert.ok(["credentials", "personal", "custom"].includes(p.group), `${p.id}: group ${p.group}`);
});

test("changelog.json has notes for the current version", () => {
  const log = JSON.parse(fs.readFileSync(path.join(EXT, "changelog.json"), "utf8"));
  const minor = manifest.version.split(".").slice(0, 2).join(".");
  assert.ok(Array.isArray(log[minor]) && log[minor].length, `add a "${minor}" entry to extension/changelog.json`);
  // Every interface language gets the notes too, with the same number of notes in the same order.
  for (const lang of fs.readdirSync(path.join(EXT, "_locales")).filter((l) => l !== "en")) {
    const notes = log.translations?.[lang]?.[minor];
    assert.ok(
      Array.isArray(notes) && notes.length === log[minor].length,
      `add translations.${lang}["${minor}"] (${log[minor].length} notes) to changelog.json`,
    );
  }
});

// Windows PowerShell 5.1 writes UTF-8 with a byte-order mark, and the extension's own JSON reads, like the
// self-update check fetching manifest.json, fail on one.
test("extension JSON files have no byte-order mark", () => {
  for (const f of fs.readdirSync(EXT).filter((n) => n.endsWith(".json"))) {
    assert.notEqual(fs.readFileSync(path.join(EXT, f))[0], 0xef, `${f} starts with a BOM`);
  }
});

// The same code ships to Firefox, desktop and Android, through `npm run package -- --firefox`, so any
// Chrome-only API has to be guarded for the background to keep running there.
test("background works in Firefox: Chrome-only APIs are guarded", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(
    bg,
    /typeof importScripts === "function"/,
    "importScripts must be optional (Firefox background scripts)",
  );
  assert.match(bg, /if \(!chrome\.declarativeContent\) return;/, "declarativeContent doesn't exist in Firefox");
  assert.match(bg, /chrome\.commands\?\.onCommand/, "commands don't exist on Firefox for Android");
  assert.doesNotMatch(bg.replace(/chrome\.commands\?\./g, ""), /chrome\.commands\./, "unguarded chrome.commands");
});

// The same code ships to Safari, iPhone, iPad and Mac, through `npm run package -- --safari`. Safari has no
// managed storage, no action.getUserSettings, no storage lock, and no colour string for the badge; it only got
// session storage in 16.4, and its installs always come from an app, never a folder. tests/background.test.js
// runs the background with only the APIs Safari actually has.
test("background works in Safari: what Safari lacks is guarded", () => {
  const bg = code("background.js");
  // Managed storage, the toolbar-pin check and the storage lock are only ever used where they exist, with `?.`,
  // in every script.
  const unguarded = (re) => scripts.flatMap((f) => [...code(f).matchAll(re)].map((m) => `${f}: ${m[0]}`));
  assert.deepEqual(unguarded(/storage\.managed(?!\s*\?\.)/g), [], "unguarded storage.managed");
  assert.deepEqual(unguarded(/getUserSettings(?!\?\.\()/g), [], "unguarded action.getUserSettings");
  assert.deepEqual(unguarded(/setAccessLevel(?!\?\.\()/g), [], "unguarded storage lock");
  // The background reads and writes session storage through one fallback, never directly.
  assert.match(bg, /chrome\.storage\.session \|\| /, "session storage needs its in-memory fallback");
  assert.deepEqual(
    offenders(/chrome\.storage\.session\.\w+\(/, ["background.js"]),
    [],
    "background uses chrome.storage.session directly",
  );
  // The one-minute local update check is for a folder copy on a computer, never a Safari install.
  assert.match(bg, /const IS_UNPACKED =[^;]*browser_specific_settings\?\.safari/, "Safari must skip the update check");
  // A refused badge colour mustn't take the tab's state with it.
  assert.match(bg, /try \{\s*await chrome\.action\.setBadgeBackgroundColor\(/, "the badge colour must fail alone");
  // Before Safari 18, a keyboard shortcut doesn't name a tab, so Alt+Shift+C has to go to the tab in front.
  assert.match(bg, /tab\?\.id \?\?/, "the shortcut needs the tab in front when none is given");
});

// Shipped files must never contain raw invisible or bidirectional-control characters. They can make code read
// differently from what it actually does, an attack known as Trojan Source, so write them as \u escapes instead.
test("no invisible or bidi-control characters in shipped files", () => {
  const bad = [];
  for (const f of fs.readdirSync(EXT).filter((n) => /\.(js|html|css|json)$/.test(n))) {
    const text = fs.readFileSync(path.join(EXT, f), "utf8");
    const m = text.match(/\p{Cf}/u);
    if (m)
      bad.push(
        `${f}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} at line ${text.slice(0, m.index).split("\n").length}`,
      );
  }
  assert.deepEqual(bad, []);
});

// Logs end up in bug reports, so a log line may name kinds of data by their ids, but never a detected value, the
// draft text, or a file name.
test("console output never includes detected values, drafts or file names", () => {
  const bad = [];
  for (const f of [
    "content.js",
    "warning-ui.js",
    "vault.js",
    "popup.js",
    "background.js",
    "stored.js",
    "pictures.js",
    "lookback.js",
    "lookback-worker.js",
    "lookback-core.js",
    "letter.js",
    "extcheck.js",
    "extcheck-core.js",
  ]) {
    const text = fs.readFileSync(path.join(EXT, f), "utf8");
    for (const m of text.matchAll(/console\.(log|info|warn|error|debug)\(/g)) {
      // Reads the whole call, even one spanning several lines, up to its closing parenthesis, skipping over strings.
      let depth = 0;
      let end = m.index;
      for (let i = m.index + m[0].length - 1, quote = null; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) {
          end = i + 1;
          break;
        }
      }
      const call = text.slice(m.index, end);
      if (
        /\.matches\b(?!\.length)|\bgetText\(|\bdraft\b|\bvalue\b|\.name\b(?!\.match)|\btext\b(?!\s*\))/.test(
          call.replace(/"[^"]*"|`[^`]*`/g, ""),
        )
      )
        bad.push(`${f}:${text.slice(0, m.index).split("\n").length}: ${call.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, []);
});

// The picture code only reads the file the person attached, inside the page's own frame. It never loads a
// picture from anywhere else, never sends or stores anything beyond its own variables, like a path or file name,
// and never draws the picture itself, so there's no AI reader or text reader involved at all.
test("the picture code reads only the attached file: no network, no picture loads, no storage, no drawing", () => {
  const src = code("pictures.js").replace(/^\s*\/\/.*$/gm, "");
  const bad = [
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/,
    /new\s+Image\b|createElement\(\s*["'`]img|\.src\s*=|createImageBitmap|getContext\(|OffscreenCanvas/,
    /chrome\.storage|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|sendMessage/,
  ].filter((re) => re.test(src));
  assert.deepEqual(
    bad.map((re) => re.source),
    [],
  );
});

// Clotr's own pages, the popup, vault and What Clotr stores, run under a strict policy: they can load only the
// extension's own files and can't connect anywhere else.
test("extension pages have a strict content security policy", () => {
  const csp = manifest.content_security_policy?.extension_pages || "";
  for (const d of [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(csp.includes(d), `missing ${d} in ${JSON.stringify(csp)}`);
  }
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https?:|\*/, "no unsafe sources or remote hosts");
});

// Firefox for Android opens Clotr's pages, including the popup, full screen. Without a viewport line a phone
// lays the page out at desktop width and shrinks it, and without text-size-adjust it may enlarge some text on
// its own.
test("phones: every Clotr page is as wide as the phone and keeps its text size, and so does the warning", () => {
  for (const f of htmls) {
    assert.match(
      fs.readFileSync(path.join(EXT, f), "utf8"),
      /<meta name="viewport" content="width=device-width, initial-scale=1">/,
      `${f} has no viewport line`,
    );
  }
  assert.match(fs.readFileSync(path.join(EXT, "popup.css"), "utf8"), /\nhtml \{[^}]*\stext-size-adjust: 100%/);
  const ui = code("ui-styles.js");
  for (const box of ["overlay", "notice"]) {
    const rule = new RegExp(`\\.${box} \\{[^}]*\\stext-size-adjust: 100%`);
    assert.match(ui, rule, `the warning's .${box} doesn't keep its text size`);
  }
});

// CI runs with a read-only token, and third-party actions are pinned to exact commits, so a moved tag can't
// change what runs.
test("CI: read-only token and actions pinned to commits", () => {
  // Every workflow is read-only by default, pins its actions to commits, and never stores checkout credentials.
  const dir = path.join(__dirname, "..", ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes("test.yml"));
  for (const f of files) {
    const wf = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(wf, /^permissions:\s*\n\s+contents: read/m, `${f}: default permissions must be read-only`);
    const uses = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u} is not pinned to a commit`);
    if (/actions\/checkout@/.test(wf))
      assert.match(wf, /persist-credentials: false/, `${f}: checkout keeps credentials`);
  }
});

// Clotr has to register its Enter and click listeners before the page's own scripts do, or a site's early
// handler could send a message before Ask before sending gets a chance to hold it.
test("Clotr starts at document_start (built-in and user-added sites)", () => {
  for (const cs of manifest.content_scripts) assert.equal(cs.run_at, "document_start");
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(bg, /runAt:\s*"document_start"/);
  assert.doesNotMatch(bg, /runAt:\s*"document_(idle|end)"/);
});

// No source file, shipped or not, may contain a stray control character, like a backspace from a mistyped "\b".
// They're invisible, and silently change what regexes and strings actually mean.
test("no control characters in source files (extension, tests, tools)", () => {
  const dirs = [EXT, __dirname, path.join(__dirname, "e2e"), path.join(__dirname, "..", "tools")];
  const bad = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => /\.(js|html|css|json|ps1|sh)$/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const m = text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
      if (m)
        bad.push(
          `${path.relative(path.join(__dirname, ".."), path.join(dir, f))}: U+${m[0].charCodeAt(0).toString(16).padStart(4, "0")} at line ${text.slice(0, m.index).split("\n").length}`,
        );
    }
  }
  assert.deepEqual(bad, []);
});

test("content scripts never touch storage directly; the background locks it to Clotr's own pages", () => {
  const contentFiles = manifest.content_scripts.flatMap((c) => c.js);
  assert.deepEqual(offenders(/chrome\.storage/, contentFiles), []);
  assert.match(
    code("background.js"),
    /chrome\.storage\.local\s*\.setAccessLevel\?\.\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/,
  );
});

// Nothing Clotr knows goes into the page's own storage, where the site could read it or fake it back. An
// earlier draft of the Firefox wake-delay fix once cached Bandage's state in sessionStorage and got rejected for
// exactly this reason.
test("content scripts never write to the page's own storage: sessionStorage, localStorage or cookies", () => {
  const contentFiles = manifest.content_scripts.flatMap((c) => c.js);
  assert.deepEqual(
    offenders(/\b(?:sessionStorage|localStorage)\s*(?:\.\s*(?:setItem|removeItem|clear)\s*\(|\[|=(?!=))/, contentFiles),
    [],
  );
  assert.deepEqual(offenders(/document\s*\.\s*cookie\s*=/, contentFiles), []);
});

// Only the background writes event history or response overrides, each through its own queue in
// background.js. If a page wrote one of these directly, it could race a report arriving from another AI tab and
// lose or revive data mid-write.
test("only the background writes event history or response overrides to storage directly", () => {
  const re = /chrome\.storage\.local\.set\(\s*\{[^}]*\b(events|mentions|responses)\s*[:,}]/;
  assert.deepEqual(
    offenders(
      re,
      scripts.filter((f) => f !== "background.js"),
    ),
    [],
  );
});

// The welcome page's note is the author's own words, so a copy edit elsewhere must never change it.
test("welcome page: the no-AI line stays as written", () => {
  const html = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
  const line = /data-i18n="vault_noteNoAi">([^<]*)</.exec(html)?.[1];
  assert.equal(line, "Clotr has absolutely NO AI, it defeats the point.");
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.equal(
    es.vault_noteNoAi.message,
    "Clotr no tiene absolutamente NADA de IA, eso iría en contra de su propósito.",
  );
});

test("welcome page: the note's first sentence stays as written", () => {
  const html = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
  const body = /data-i18n="vault_noteBody">([^<]*)</.exec(html)?.[1] || "";
  assert.ok(
    body.startsWith(
      'I made Clotr after I noticed how much I was telling AI chats without a second thought, I immediately wanted a Tony Stark style "Suit of armor around the world" to exist. So, here we are.',
    ),
    body.slice(0, 160),
  );
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.ok(es.vault_noteBody.message.includes("Tony Stark"), "the Spanish note says the same");
});

// Every message the code asks for exists in Spanish, and every kind of data has a Spanish name. English is
// written directly in the code, and is the fallback.
test("every translated string has a Spanish message; placeholders are well formed", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const used = new Set(scripts.flatMap((f) => [...code(f).matchAll(/\bmsg\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1])));
  const missing = [...used].filter((k) => !es[k]);
  assert.deepEqual(missing, [], `no Spanish for: ${missing.join(", ")}`);
  require("../extension/patterns.js");
  for (const p of globalThis.Clotr.PATTERNS) assert.ok(es[`type_${p.id}`], `no Spanish name for ${p.id}`);
  for (const [k, v] of Object.entries(es)) {
    for (const [, name] of v.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
      assert.ok(v.placeholders?.[name], `${k}: $${name}$ has no placeholder`);
    }
  }
  assert.equal(manifest.default_locale, "en");
});

test('the manifest\'s name is exactly "Clotr: clot your data leaks"', () => {
  assert.equal(manifest.name, "Clotr: clot your data leaks");
});

test("every data-i18n key in Clotr's pages, and every self-check message, has a Spanish message", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const keys = htmls.flatMap((f) =>
    [...fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)].map(
      (m) => `${f}: ${m[1]}`,
    ),
  );
  keys.push(...[...code("sites.js").matchAll(/key: "([A-Za-z0-9_]+)"/g)].map((m) => `sites.js: ${m[1]}`));
  const missing = keys.filter((k) => !es[k.split(": ")[1]]);
  assert.deepEqual(missing, []);
  for (const f of htmls.filter((f) => /data-i18n/.test(fs.readFileSync(path.join(EXT, f), "utf8")))) {
    assert.match(
      fs.readFileSync(path.join(EXT, f), "utf8"),
      /<script src="page-i18n\.js">/,
      `${f} uses data-i18n but doesn't load page-i18n.js`,
    );
  }
});

// The scam feature's words stay calm and honest. None of them calls a detail or a message "safe", "fine",
// "legit" or "not a scam", and none puts a number on it, whether in the code's own English strings, the pages,
// or Spanish.
test("the scam feature's words never call anything safe, fine or not a scam, and give no percentage", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const ours = (k) => k.startsWith("ss_");
  const english = [
    ...scripts.flatMap((f) =>
      [...code(f).matchAll(/\bmsg\(\s*"([A-Za-z0-9_]+)",\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
    ),
    ...htmls.flatMap((f) =>
      [...fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/data-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)</g)].map(
        (m) => [m[1], m[2]],
      ),
    ),
  ].filter(([k]) => ours(k));
  assert.ok(english.length >= 20, `found only ${english.length} English strings: has the msg() format changed?`);
  const badEnglish = english.filter(([, t]) => /\b(safe|fine|legit)\b|not a scam|\d\s*%/i.test(t));
  assert.deepEqual(badEnglish, []);
  const badSpanish = Object.entries(es)
    .filter(([k, v]) => ours(k) && /\bsegur[oa]s?\b|está bien|no es una estafa|%/i.test(v.message))
    .map(([k]) => k);
  assert.deepEqual(badSpanish, []);
});

// The printed card, "Never read these out," has six rows, each naming something scammers ask people to read out
// and who actually asks for it, in both languages. Every row's advice carries the source it stands on, a public
// page, or "plain fact" when it's just what the detail itself does. The card is printed paper, so nothing on it
// is typed or kept.
test("the printed card: six rows in both languages, each carrying its source", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const html = fs.readFileSync(path.join(EXT, "share.html"), "utf8");
  const card = /<article class="card-sheet"[\s\S]*?<\/article>/.exec(html)?.[0];
  assert.ok(card, "share.html has no card-sheet article");
  const rows = [...card.matchAll(/<div class="card-row" data-source="([^"]+)">([\s\S]*?)<\/div>/g)];
  assert.equal(rows.length, 6);
  const SOURCES = new Set([
    "https://consumer.ftc.gov/consumer-alerts/2024/03/whats-verification-code-why-would-someone-ask-me-it",
    "https://consumer.ftc.gov/consumer-alerts/2021/10/google-voice-scam-how-verification-code-scam-works-how-avoid-it",
    "https://consumer.georgia.gov/credit-card-scams",
    "https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams",
    "https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams",
    "https://consumer.ftc.gov/consumer-alerts/2024/03/never-move-your-money-protect-it-thats-scam",
    "https://consumer.ftc.gov/articles/how-recognize-and-avoid-phishing-scams",
    "https://consumer.ftc.gov/articles/how-avoid-scam",
  ]);
  for (const [, source, row] of rows) {
    const keys = [...row.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    assert.equal(keys.length, 2, `a row without its two parts: ${row}`);
    for (const k of keys) assert.ok(es[k], `no Spanish for ${k}`);
    if (source === "plain fact") continue;
    for (const url of source.split(" "))
      assert.ok(SOURCES.has(url), `${keys[0]}: not a source the design cites: ${url}`);
  }
  // The box's advice stands on the FTC too. The name and number are blanks on paper, never actual form fields.
  assert.match(card, /<div class="card-box" data-source="https:\/\/consumer\.ftc\.gov\/articles\/how-avoid-scam">/);
  assert.doesNotMatch(card, /<(input|textarea|select)\b/);
  // The second row is the card company's own words, now with the Georgia Attorney General's line behind it.
  assert.match(rows[1][1], /consumer\.georgia\.gov\/credit-card-scams/);
});

// Spanish nouns agree with the number ("1 enviado", "2 enviados"). Lines that combine counts which can be
// 0 or 1 use the label form ("enviados: 1") instead of a count before a plural word ("1 enviados").
test("Spanish: counts that can be 1 aren't written before a plural word", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const COMBINED = [
    "pp_heroSub",
    "pp_digest",
    "pp_daySummary",
    "pp_nFound",
    "db_weekLabel",
    "db_card",
    "mp_mentionedToo",
    "mp_openDetail",
    "mp_more",
  ];
  for (const key of COMBINED) {
    assert.ok(es[key], `${key} is missing`);
    assert.doesNotMatch(es[key].message, /\$p\d\$\s+\p{L}+s\b/u, `${key}: "${es[key].message}"`);
  }
});

// The public repo lives at clotr-app/clotr now. Its old address only keeps forwarding there as long as no new
// repository takes the old name, so new links never use that old address. History files keep whatever they
// already said.
test("links point to the public repo's home, clotr-app/clotr, never its old address", () => {
  const root = path.join(__dirname, "..");
  const history =
    /^(CHANGELOG\.md|DECISIONS\.md|TESTING\.md|QUESTIONS\.md|docs[\\/]security-review\.md|docs[\\/]release-review[\\/])/;
  const skip = /^(node_modules|dist|\.git|tests[\\/]e2e[\\/]output|extension[\\/]bravelogs)([\\/]|$)/;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (skip.test(rel) || history.test(rel)) continue;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|json|html|md|ya?ml|ps1|sh|txt|css)$/.test(e.name)) {
        if (/github\.com\/BilliamBaSH\/clotr\b/.test(fs.readFileSync(path.join(root, rel), "utf8"))) hits.push(rel);
      }
    }
  };
  walk("");
  assert.deepEqual(hits, [], `these link the old address; use github.com/clotr-app/clotr: ${hits.join(", ")}`);
});

// A release gets three numbers, major.minor.patch, chosen when it's cut. A build between releases adds a
// fourth, like 1.1.1.1 then 1.1.1.2, so an unpacked copy still reloads and builds stay distinguishable, while
// the public list of versions only grows at a release.
test("the manifest's version is a release (three numbers) or a build between releases (a fourth)", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(\.[1-9]\d*)?$/);
});

// CHANGELOG.md is the public record of what changed, so its newest section has to be the version currently
// being built. A build between releases collects its notes under "## Unreleased" until the release gives them a
// name.
test("CHANGELOG.md's newest section is the manifest's version, or Unreleased for a build", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const log = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
  const newest = (log.match(/^## .*/m) || [""])[0];
  if (version.split(".").length === 4) assert.equal(newest, "## Unreleased", "a build's notes go under ## Unreleased");
  else assert.ok(newest.startsWith(`## ${version} `), `CHANGELOG.md's newest section isn't "## ${version}"`);
});

// The public versioning standard has to exist, name the three kinds of release, and be linked from the public
// README; its numbering is the one the checks above enforce. In this repo it lives in public/, and the exporter
// writes the README's link to it; the export then copies public/ to the public repo's root, so it ends up as
// VERSIONING.md there with README.md linking to it.
test("the public versioning standard is there and linked", () => {
  const root = path.join(__dirname, "..");
  const inPublic = path.join(root, "public", "VERSIONING.md");
  const std = fs.readFileSync(fs.existsSync(inPublic) ? inPublic : path.join(root, "VERSIONING.md"), "utf8");
  for (const kind of ["**Minor**", "**Patch**", "**Major**", "MAJOR.MINOR.PATCH"])
    assert.ok(std.includes(kind), `VERSIONING.md lost "${kind}"`);
  const exporter = path.join(root, "tools", "export-public.js");
  assert.match(
    fs.readFileSync(fs.existsSync(exporter) ? exporter : path.join(root, "README.md"), "utf8"),
    /\[VERSIONING\.md\]\(VERSIONING\.md\)/,
  );
});

// The history reads newest first, each release above the one before it.
test("CHANGELOG.md's versions go down from top to bottom", () => {
  const log = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
  const versions = [...log.matchAll(/^## (\d+)\.(\d+)(?:\.(\d+))?/gm)].map((m) => [+m[1], +m[2], +(m[3] || 0)]);
  const below = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  for (let i = 1; i < versions.length; i++)
    assert.ok(below(versions[i], versions[i - 1]) < 0, `${versions[i].join(".")} is listed under an older version`);
});

// Every e2e check has its own ID, since --only and the test notes refer to them by it.
test("e2e check IDs are unique", () => {
  // run.js plus one file per area in e2e/checks
  const dir = path.join(__dirname, "e2e", "checks");
  const run = [path.join(__dirname, "e2e", "run.js"), ...fs.readdirSync(dir).map((f) => path.join(dir, f))]
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
  const ids = [...run.matchAll(/await check\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 100, `found only ${ids.length} checks: has the check() call format changed?`);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `duplicate check IDs: ${dup.join(", ")}`);
});

// The browser suite discovers its check files instead of naming them all in run.js, so adding a new area never
// means editing the same shared list. Files run in number order, with the --stress and --store sections last. A
// held-back feature's own checks, marked FEATURE_ONLY, run only against an all-on build instead, since their
// doors are hidden in the default one; across the two runs, every check file still runs exactly once.
test("the e2e runner runs every check file, in number order, with the stress and store sections last", () => {
  const run = fs.readFileSync(path.join(__dirname, "e2e", "run.js"), "utf8");
  assert.match(run, /^const SECTIONS = sections\(undefined, ALL_ON\);$/m, "run.js names its sections by hand");
  const { sections, FEATURE_ONLY } = require("./e2e/sections.js");
  const files = fs
    .readdirSync(path.join(__dirname, "e2e", "checks"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.slice(0, -3));
  const found = sections();
  const allOn = sections(undefined, true);
  assert.deepEqual(allOn.slice().sort(), FEATURE_ONLY.slice().sort(), "the all-on run is exactly FEATURE_ONLY");
  assert.deepEqual([...found, ...allOn].sort(), files.sort(), "each check file once, between the two runs");
  assert.deepEqual(
    found.filter((f) => FEATURE_ONLY.includes(f)),
    [],
    "a held-back feature's own check runs in the default build too",
  );
  assert.deepEqual(found.slice(-2), ["16-stress", "17-store-screenshots"]);
  const numbered = found.slice(0, -2);
  assert.deepEqual(numbered, numbered.slice().sort(), "in number order");
});

// The website keeps the extension's promise: no script, nothing loaded from other sites, and every local file
// it points to actually exists. Links to other sites in an <a href> are fine, since they load nothing until
// clicked.
const SITE = path.join(__dirname, "..", "site");
test(
  "the website runs no script and loads nothing from other sites",
  { skip: !fs.existsSync(SITE) && "the website has its own repo" },
  () => {
    const site = SITE;
    // Every page, index.html and the printable guide, carries the same strict policy.
    const pages = fs.readdirSync(site).filter((f) => f.endsWith(".html"));
    assert.ok(pages.includes("index.html") && pages.length >= 2, `pages: ${pages}`);
    for (const page of pages.filter((p) => p !== "index.html")) {
      const other = fs.readFileSync(path.join(site, page), "utf8");
      assert.doesNotMatch(other, /<script|\son[a-z]+=|javascript:/i, `${page}: no scripts or inline handlers`);
      assert.match(
        other,
        /Content-Security-Policy[^>]*default-src 'none'/,
        `${page}: a strict content security policy`,
      );
      for (const [, ref] of other.matchAll(
        /<(?:img|link|source|iframe|video|audio)\b[^>]*\s(?:src|href)="([^"]+)"/gi,
      )) {
        assert.doesNotMatch(ref, /^(https?:)?\/\//i, `${page} loads from another site: ${ref}`);
        assert.ok(fs.existsSync(path.join(site, ref.split(/[?#]/)[0])), `${page}: missing file site/${ref}`);
      }
    }
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(site, "style.css"), "utf8");
    assert.doesNotMatch(html, /<script|\son[a-z]+=|javascript:/i, "no scripts or inline handlers");
    assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/, "a strict content security policy");
    const loads = [
      ...[...html.matchAll(/<(?:img|link|source|iframe|video|audio)\b[^>]*\s(?:src|href)="([^"]+)"/gi)].map(
        (m) => m[1],
      ),
      ...[...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]),
    ];
    assert.ok(loads.length >= 8, `found only ${loads.length} loaded files: has the markup changed?`);
    for (const ref of loads) {
      assert.doesNotMatch(ref, /^(https?:)?\/\//i, `loads from another site: ${ref}`);
      assert.ok(fs.existsSync(path.join(site, ref.split(/[?#]/)[0])), `missing file: site/${ref}`);
    }
  },
);

// Clotr is rules and tests, with no AI inside. No model file and no model runtime may ever reach the extension,
// and the README, the site and the store all point to this exact check.
const MODEL_FILES = /\.(onnx|safetensors|bin|gguf|pt|pth|wasm|tflite|mlmodel)$/i;
const MAX_FILE = 2 * 1024 * 1024; // a model file is never this small, and nothing Clotr ships comes near 2 MB
const MODEL_RUNTIMES = [
  "@huggingface/transformers",
  "onnxruntime-web",
  "onnxruntime-node",
  "@xenova/transformers",
  "@mlc-ai/web-llm",
  "@tensorflow/tfjs",
];
function aiInsideOffenders(extDir, pkgFile) {
  const found = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (MODEL_FILES.test(d.name)) found.push(path.relative(extDir, full));
      else if (fs.statSync(full).size > MAX_FILE) found.push(`${path.relative(extDir, full)} (over 2 MB)`);
    }
  };
  walk(extDir);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const name of MODEL_RUNTIMES) if (deps[name]) found.push(`package.json: ${name}`);
  return found;
}
test("no AI inside: no model files or model runtimes in the extension", () => {
  assert.deepEqual(aiInsideOffenders(EXT, path.join(__dirname, "..", "package.json")), []);
  // Plants a model file and a model runtime and checks both get caught.
  const os = require("os");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-noai-"));
  fs.mkdirSync(path.join(fixture, "ext", "models"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "ext", "models", "privacy-filter.onnx"), "fake");
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ dependencies: { "onnxruntime-web": "1.0.0" } }),
  );
  try {
    assert.deepEqual(aiInsideOffenders(path.join(fixture, "ext"), path.join(fixture, "package.json")), [
      path.join("models", "privacy-filter.onnx"),
      "package.json: onnxruntime-web",
    ]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// Tourniquet's rules live in Clotr's code, never in storage. Each preset holds only kind ids with a response, a
// larger-warnings flag, and app names from Clotr's own list, so no field could ever carry text from a page.
test("Tourniquet's presets hold only requiredResponses, largeText and apps", () => {
  const box = { chrome: { runtime: { getManifest: () => manifest } }, URL };
  box.globalThis = box;
  vm.runInNewContext(fs.readFileSync(path.join(EXT, "sites.js"), "utf8"), box);
  const { TOURNIQUET, EVERYDAY_SITES } = box.ClotrSites;
  assert.deepEqual(Object.keys(TOURNIQUET).sort(), ["adult", "after_scam", "child"]);
  const apps = new Set(EVERYDAY_SITES.map((s) => s.name));
  for (const [word, preset] of Object.entries(TOURNIQUET)) {
    for (const key of Object.keys(preset))
      assert.ok(["requiredResponses", "largeText", "apps"].includes(key), `${word}.${key}`);
    for (const [id, v] of Object.entries(preset.requiredResponses)) {
      assert.match(id, /^[a-z0-9_]{1,64}$/, `${word}: ${id}`);
      assert.ok(v === "block" || v === "warn", `${word}.${id}: ${v}`);
    }
    if ("largeText" in preset) assert.equal(preset.largeText, true, `${word}.largeText`);
    for (const name of preset.apps) assert.ok(apps.has(name), `${word}: ${name} isn't on Clotr's list`);
  }
});

// Tourniquet's presets are "for a child" and "for a grown-up," and the word "elder" is never said to anyone. The
// seed-phrase word list in patterns.js is exempt, since that's a list of words Clotr looks for, not words it
// says to people.
test('no words to people say "elder": messages, Clotr\'s pages, the website, the English in the code', () => {
  const hits = [];
  const look = (where, text) => {
    if (/elder/i.test(text)) hits.push(where);
  };
  for (const lang of fs.readdirSync(path.join(EXT, "_locales")))
    for (const [k, v] of Object.entries(
      JSON.parse(fs.readFileSync(path.join(EXT, "_locales", lang, "messages.json"), "utf8")),
    ))
      look(`_locales/${lang}: ${k}`, v.message);
  for (const f of htmls) look(f, fs.readFileSync(path.join(EXT, f), "utf8"));
  const site = path.join(__dirname, "..", "site"); // the website (not in the public export)
  for (const f of fs.existsSync(site) ? fs.readdirSync(site).filter((n) => n.endsWith(".html")) : [])
    look(`site/${f}`, fs.readFileSync(path.join(site, f), "utf8"));
  for (const f of scripts.filter((n) => n !== "patterns.js"))
    for (const m of code(f).matchAll(/\bmsg\(\s*"[A-Za-z0-9_]+",\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) look(f, m[2]);
  assert.deepEqual(hits, []);
});

// Tourniquet's words leave room for later. Each one says only what this version does, never promises what
// Clotr or the helper will never do, and the protected person's own screens never say who the setup is for. The
// English comes straight from the code and the pages; the Spanish comes from _locales.
function englishByKey() {
  const en = {};
  for (const f of scripts)
    for (const m of code(f).matchAll(/\bmsg\(\s*"([A-Za-z0-9_]+)",\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) en[m[1]] ??= m[3];
  for (const f of htmls)
    for (const m of fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/data-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]+)</g))
      en[m[1]] ??= m[2];
  return en;
}
test("Tourniquet's words: factual, no promises, and never who it's for on the protected person's own screens", () => {
  const en = englishByKey();
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const keys = [...new Set([...Object.keys(en), ...Object.keys(es)])].filter((k) =>
    /^(tq[A-Z]|pp_tq|sj_tq|sh_tq|hp_tq|vt_tq)/.test(k),
  );
  const said = (k) => [en[k] && `en ${k}: ${en[k]}`, es[k] && `es ${k}: ${es[k].message}`].filter(Boolean);
  assert.ok(keys.length >= 70, `only ${keys.length} Tourniquet strings found`);
  // No promises about what Clotr or the helper will never do, only what it does now, in the present tense.
  const PROMISE =
    /\b(never|won't|will not|will never)\b[^.]{0,40}\b(reports?|tells?|shows? (you|anyone|them)|sees?)\b|including you|\bnunca\b[^.]{0,40}\b(informa|cuenta|dice|muestra|ve)\b|incluido tú/i;
  const promises = keys.flatMap(said).filter((s) => PROMISE.test(s));
  assert.deepEqual(promises, []);
  // The protected person's own screens are the warning's tips, the popup, What Clotr stores, and the printed
  // guide. The preset names only appear where someone is actually choosing one: the setup page and the popup's
  // switch.
  const WHO = /child|grown-up|adult|teen|\bkids?\b|older|niñ|adolescen|menor/i;
  const theirs = keys.filter((k) => /^(tqTip|pp_tq|sj_tq|sh_tq)/.test(k) && !/^pp_tqFor/.test(k));
  assert.deepEqual(
    theirs.flatMap(said).filter((s) => WHO.test(s.split(": ").slice(1).join(": "))),
    [],
  );
  // The grown-up line shows for phone numbers and email addresses too, which banks and offices do ask for, so it
  // can't say they never ask for "this".
  assert.doesNotMatch(en.tqLineAdult, /\bnever\b/i);
  assert.doesNotMatch(es.tqLineAdult.message, /\bnunca\b/i);
});

// There's no admin view of any kind, and nothing Clotr finds ever leaves the computer. A team policy only sets
// rules on each computer, one way, and whatever Clotr detects is never shown to, counted for, or sent to anyone
// else, no matter who's paying for the team plan. Three checks below keep it that way, each proven on a planted
// bad case, so loosening any one of them takes a deliberate change rather than a quiet slip. The no-network check
// above covers the way out; these cover what an admin could even ask for in the first place.

// 1. A team policy sets rules, never reporting. The managed schema has exactly these eight fields, and nothing
// in a field's name, title, description or allowed values asks for an address, an endpoint, or anything sent
// back. The only field with fields of its own is a team's kinds, and each kind has exactly these six, all rules
// for this computer. Whatever else an admin writes, the policy Clotr builds from it carries only these fields.
const POLICY_FIELDS = {
  preset: "string",
  orgName: "string",
  requiredResponses: "object",
  watchWords: "array",
  lockSettings: "boolean",
  allowPause: "boolean",
  largeText: "boolean",
  kinds: "array",
};
const KIND_FIELDS = {
  name: "string",
  words: "array",
  formats: "array",
  near: "array",
  response: "string",
  cover: "string",
};
// Clotr adds one field of its own to each kind it keeps: the id it makes from the name.
const KIND_MADE = new Set(["id"]);
const REPORTING =
  /\b(urls?|uris?|endpoints?|webhooks?|servers?|telemetry|analytics|beacons?|upload\w*|collect\w*|report\w*|(send|sends|sent|sending) back|phone home)\b|https?:\/\//i;
// "reportUrl" and "report_url" read as the words "report Url" and "report url".
const asWords = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
const KINDS_ITEMS = "schema.properties.kinds.items";
function reportingOffenders(schema, mergePolicy) {
  const found = [];
  const fields = schema.properties || {};
  for (const name of Object.keys(fields)) if (!Object.hasOwn(POLICY_FIELDS, name)) found.push(`a new field: ${name}`);
  for (const [name, type] of Object.entries(POLICY_FIELDS))
    if (fields[name]?.type !== type) found.push(`${name}: ${fields[name] ? `type ${fields[name].type}` : "missing"}`);
  const kindFields = fields.kinds?.items?.properties || {};
  if (fields.kinds?.items?.type !== "object") found.push("kinds: each one isn't an object");
  for (const name of Object.keys(kindFields))
    if (!Object.hasOwn(KIND_FIELDS, name)) found.push(`a new field in a kind: ${name}`);
  for (const [name, type] of Object.entries(KIND_FIELDS))
    if (kindFields[name]?.type !== type)
      found.push(`kinds.${name}: ${kindFields[name] ? `type ${kindFields[name].type}` : "missing"}`);
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${where}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && where !== "schema" && where !== KINDS_ITEMS)
        found.push(`${where}: fields inside a field`);
      if (key === "properties" || key === "patternProperties")
        for (const name of Object.keys(value))
          if (REPORTING.test(asWords(name))) found.push(`${where}.${key}.${name}: name`);
      if ((key === "title" || key === "description") && typeof value === "string" && REPORTING.test(value))
        found.push(`${where}: ${key}`);
      if (key === "enum" && Array.isArray(value))
        for (const v of value) if (typeof v === "string" && REPORTING.test(asWords(v))) found.push(`${where}: "${v}"`);
      walk(value, `${where}.${key}`);
    }
  };
  walk(schema, "schema");
  const merged = mergePolicy({
    preset: "clinic",
    orgName: "Example Clinic",
    requiredResponses: { email: "warn" },
    watchWords: ["project falcon"],
    lockSettings: true,
    allowPause: false,
    largeText: true,
    kinds: [
      {
        name: "Matter number",
        words: ["globex"],
        formats: ["MAT-######"],
        near: ["matter"],
        response: "block",
        cover: "Matter",
        reportUrl: "https://example.com/collect",
      },
    ],
    reportUrl: "https://example.com/collect",
    webhook: "https://example.com/hook",
  });
  for (const key of Object.keys(merged))
    if (!Object.hasOwn(POLICY_FIELDS, key)) found.push(`the merged policy carries ${key}`);
  for (const kind of Array.isArray(merged.kinds) ? merged.kinds : [])
    for (const key of Object.keys(kind))
      if (!Object.hasOwn(KIND_FIELDS, key) && !KIND_MADE.has(key)) found.push(`a merged kind carries ${key}`);
  return found;
}
test("a team policy sets rules, never reporting: the managed schema's eight fields and a kind's six, nothing sent back", () => {
  globalThis.chrome ??= {};
  require("../extension/sites.js");
  const { mergePolicy } = globalThis.ClotrSites;
  assert.equal(manifest.storage?.managed_schema, "managed_schema.json", "the schema the browser reads");
  const schema = JSON.parse(fs.readFileSync(path.join(EXT, "managed_schema.json"), "utf8"));
  assert.deepEqual(reportingOffenders(schema, mergePolicy), []);
  // Plants a reporting field, a reporting value, a reporting field inside a kind, fields nested inside another
  // field, and a policy that passes everything through, and checks each one gets caught.
  const planted = structuredClone(schema);
  planted.properties.reportUrl = { title: "Report address", description: "Where findings go.", type: "string" };
  planted.properties.requiredResponses.additionalProperties.enum.push("report");
  planted.properties.kinds.items.properties.webhook = { type: "string" };
  planted.properties.watchWords.items.properties = { sendBack: { type: "boolean" } };
  assert.deepEqual(
    reportingOffenders(planted, (raw) => ({ ...raw, kinds: raw.kinds.map((k) => ({ ...k })) })).sort(),
    [
      "a new field: reportUrl",
      "a new field in a kind: webhook",
      "schema.properties.watchWords.items: fields inside a field",
      "schema.properties.watchWords.items.properties.sendBack: name",
      'schema.properties.requiredResponses.additionalProperties: "report"',
      "schema.properties.kinds.items.properties.webhook: name",
      "schema.properties.reportUrl: name",
      "schema.properties.reportUrl: title",
      "the merged policy carries reportUrl",
      "the merged policy carries webhook",
      "a merged kind carries reportUrl",
    ].sort(),
  );
});

// 2. "There is no admin dashboard, by design." stays word for word in the public team rollout guide, and the
// website's Teams section keeps saying there is no admin dashboard too. When the website isn't in this repo,
// only the guide gets checked.
const NO_DASHBOARD = "There is no admin dashboard, by design.";
function dashboardOffenders(guide, siteHtml) {
  const flat = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const found = [];
  if (!flat(guide).includes(NO_DASHBOARD)) found.push("docs/team-rollout.md");
  if (siteHtml !== null) {
    const teams = /<section id="teams"[\s\S]*?<\/section>/.exec(siteHtml)?.[0] || "";
    if (!flat(teams).includes("There is no admin dashboard")) found.push("the website's Teams section");
  }
  return found;
}
test('"There is no admin dashboard, by design." stays in the rollout guide and on the website', () => {
  const guide = fs.readFileSync(path.join(__dirname, "..", "docs", "team-rollout.md"), "utf8");
  const sitePage = path.join(SITE, "index.html");
  const siteHtml = fs.existsSync(sitePage) ? fs.readFileSync(sitePage, "utf8") : null;
  assert.deepEqual(dashboardOffenders(guide, siteHtml), []);
  // Takes the sentence out of a copy of the guide, or moves it out of the Teams section, and checks both get caught.
  assert.deepEqual(dashboardOffenders(guide.split(NO_DASHBOARD).join(""), null), ["docs/team-rollout.md"]);
  const moved =
    '<section id="teams"><p>Clotr is free at work too.</p></section>' +
    '<section id="who"><p>There is no admin dashboard.</p></section>';
  assert.deepEqual(dashboardOffenders(guide, moved), ["the website's Teams section"]);
});

// 3. Clotr is the same for everyone, so no file under extension/ may name a price. A price is a dollar sign
// before two or more digits, or before a number with a separator, and the numbered placeholders of translated
// strings, like $1 or $p1$, never match that pattern. The browser logs a tester saves in bravelogs/ never ship
// anyway.
const PRICE = /\$\s?(\d{2,}|\d(?:[.,]\d+)+)|[€£]\s?\d|\bUS\$|\b\d[\d,.]*\s?(dollars?|USD|euros?)\b/;
const NOT_TEXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
function priceOffenders(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "bravelogs") walk(full);
      } else if (!NOT_TEXT.test(entry.name)) {
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (PRICE.test(line)) found.push(`${path.relative(dir, full).replace(/\\/g, "/")}:${i + 1}`);
          });
      }
    }
  };
  walk(dir);
  return found.sort();
}
test("no prices inside the extension", () => {
  assert.deepEqual(priceOffenders(EXT), []);
  // Plants a price in a copy of an extension file, written either way, and checks it gets caught, while a
  // translated string's placeholder doesn't.
  const os = require("os");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-prices-"));
  try {
    const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
    fs.writeFileSync(path.join(fixture, "popup.js"), `${popup}\nconst pack = "Team pack: $299";\n`);
    fs.writeFileSync(path.join(fixture, "messages.json"), '{ "it": { "message": "IT providers: $1,499" } }\n');
    fs.writeFileSync(path.join(fixture, "ok.js"), 'msg("andMore", "and $1 more", 3);\n');
    assert.deepEqual(priceOffenders(fixture), ["messages.json:1", `popup.js:${popup.split("\n").length + 1}`]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// 4. A Buy link on the website is a plain https link to the payment service's own checkout page and goes
// nowhere else, and the website loads nothing from the payment service, so its overlay script never runs. Buying
// isn't open yet, since payment comes last, so no checkout host is set and any Buy link fails for now; once the
// payment service is set up, its exact checkout host goes in CHECKOUT_HOST. A Buy link is an <a> whose words or
// label start with "Buy" or "Comprar", whose class names it `buy`, or any link to a payment service at all.
const CHECKOUT_HOST = null; // e.g. "clotr.lemonsqueezy.com", from the payment service's hosted checkout links
const PAYMENT_HOSTS = /(^|\.)(lemonsqueezy\.com|paddle\.com|paddle\.io|stripe\.com|gumroad\.com|paypal\.com)$/i;
function hostOfLink(href) {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null; // a page of the site itself, or #part of one
  }
}
function buyLinkOffenders(pages, checkoutHost) {
  const found = [];
  for (const [page, raw] of Object.entries(pages)) {
    const html = raw.replace(/<!--[\s\S]*?-->/g, ""); // a commented-out example isn't a link
    for (const [, attrs, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const words = inner
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const label = /\saria-label="([^"]*)"/i.exec(attrs)?.[1] || "";
      const href = /\shref="([^"]*)"/i.exec(attrs)?.[1] || "";
      const host = hostOfLink(href);
      const isBuy =
        /^(buy|comprar)\b/i.test(words) || /^(buy|comprar)\b/i.test(label) || /\sclass="[^"]*\bbuy\b/i.test(attrs);
      if (!isBuy && !(host && PAYMENT_HOSTS.test(host))) continue;
      if (!checkoutHost) found.push(`${page}: a Buy link before buying is open: ${href || "(no address)"}`);
      else if (!href.startsWith("https://") || host !== checkoutHost)
        found.push(`${page}: a Buy link that isn't https://${checkoutHost}: ${href || "(no address)"}`);
    }
    for (const [, ref] of html.matchAll(
      /<(?:script|img|link|source|iframe|video|audio)\b[^>]*\s(?:src|href)="([^"]+)"/gi,
    )) {
      const host = hostOfLink(ref);
      if (host && (PAYMENT_HOSTS.test(host) || host === checkoutHost))
        found.push(`${page} loads from the payment service: ${ref}`);
    }
  }
  return found;
}
test(
  "every Buy link on the website goes only to the payment service's checkout page",
  { skip: !fs.existsSync(SITE) && "the website has its own repo" },
  () => {
    const pages = Object.fromEntries(
      fs
        .readdirSync(SITE)
        .filter((f) => f.endsWith(".html"))
        .map((f) => [f, fs.readFileSync(path.join(SITE, f), "utf8")]),
    );
    assert.deepEqual(buyLinkOffenders(pages, CHECKOUT_HOST), []);
    // Plants Buy links and checks each one, judged both with no checkout host yet and with one set.
    const host = "clotr.lemonsqueezy.com";
    const buy = '<a class="buy" href="https://clotr.lemonsqueezy.com/buy/1" aria-label="Buy the Team pack">Buy</a>';
    const offenders = (html, h) => buyLinkOffenders({ "x.html": html }, h).length;
    assert.equal(offenders(buy, null), 1, "no checkout host yet: any Buy link fails");
    assert.equal(offenders(buy, host), 0, "a Buy link to the checkout host passes");
    assert.equal(offenders(buy.replace("https://clotr.lemonsqueezy.com", "https://pay.example.com"), host), 1);
    assert.equal(offenders(buy.replace("https://", "http://"), host), 1, "not https");
    assert.equal(offenders('<a href="https://pay.example.com/team">Buy the Team pack</a>', host), 1, "by its words");
    assert.equal(offenders('<a href="https://other.lemonsqueezy.com/x">Get the pack</a>', host), 1, "by its address");
    assert.equal(offenders('<script src="https://clotr.lemonsqueezy.com/js/lemon.js"></script>', host), 1);
    assert.equal(offenders(`<!-- ${buy} -->`, null), 0, "a commented-out example");
    assert.equal(offenders('<a href="terms.html">Terms of sale</a> <b>Buy</b> Pick a pack', null), 0);
  },
);

// Draft pages, like the terms of sale or the buyers' privacy note, say so at the top, in both a comment and on
// the page itself. The website export leaves a draft out rather than publishing it, but still refuses outright
// if a published page keeps a link to one, so none goes live and nothing links to a page that didn't.
test(
  "a draft page on the website says so at the top; the export leaves it out, and a link to it from a published page fails",
  { skip: !fs.existsSync(SITE) && "the website has its own repo" },
  () => {
    const { DRAFT, draftPages, brokenDraftLinks } = require("../tools/export-site.js");
    for (const f of fs.readdirSync(SITE).filter((n) => n.endsWith(".html"))) {
      const html = fs.readFileSync(path.join(SITE, f), "utf8");
      if (!html.includes(DRAFT)) continue;
      const head = html.split("<head>")[0];
      assert.ok(head.includes(`<!-- ${DRAFT}`), `${f}: the draft line in a comment at the top`);
      assert.match(html, new RegExp(`<main[^>]*>\\s*<p class="draft"[^>]*>${DRAFT}\\.</p>`), `${f}: shown first`);
    }
    const page = (marked) => `<!doctype html><main>${marked ? `<p class="draft">${DRAFT}.</p>` : ""}</main>`;
    const pages = { "site/terms.html": page(true), "site/index.html": page(false) };
    assert.deepEqual(draftPages(pages), ["site/terms.html"]);
    // A published page with no link to the draft doesn't stop the export.
    assert.deepEqual(brokenDraftLinks(pages), []);
    // A published page that still links to the left-out draft makes the export fail, instead of shipping a dead link.
    const linked = { ...pages, "site/index.html": `<a href="terms.html">Terms</a>` };
    assert.deepEqual(brokenDraftLinks(linked), ["site/index.html -> terms.html"]);
  },
);

// ---------- The apps: the same promises outside the browser ----------
// Whatever runs outside the browser keeps the extension's hard rules, in every language it's written in: nothing
// goes online, nothing detected gets stored, no AI inside, and no HTML or script built from strings in any web
// view. Each check reads a folder, so each one is proven on a planted fixture as well as run over the real apps
// folder; a checkout without that folder simply has nothing to check, but the fixtures still run.
const APPS = path.join(__dirname, "..", "apps");
const NOT_SOURCE = new Set(["node_modules", ".git", "dist", "build", "target", ".gradle", ".idea", "DerivedData"]);

// Lists every file under dir, skipping built output, as paths like "a/b.kt".
function appFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!NOT_SOURCE.has(e.name)) walk(path.join(d, e.name));
      } else out.push(path.relative(dir, path.join(d, e.name)).replace(/\\/g, "/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const LANGS = [
  ["gradle", /(^|\/)(build|settings)\.gradle(\.kts)?$|\.versions\.toml$/],
  ["cargolock", /(^|\/)Cargo\.lock$/],
  ["cargo", /(^|\/)Cargo\.toml$/],
  ["android", /(^|\/)AndroidManifest\.xml$/],
  ["tauri", /(^|\/)tauri\.conf\.json$/],
  ["npm", /(^|\/)package\.json$/],
  ["js", /\.(m?js|cjs|jsx|tsx?)$/],
  ["html", /\.html?$/],
  ["kotlin", /\.(kt|kts|java)$/],
  ["swift", /\.swift$/],
  ["rust", /\.rs$/],
  ["plist", /\.plist$/],
];
const langOf = (rel) => LANGS.find(([, re]) => re.test(rel))?.[0] || null;

// Strips a file's comments out while keeping its line numbers lined up: // and /* */ in C-like languages,
// <!-- --> in XML and HTML, # in TOML. That way a rule explained in a comment doesn't trip its own check.
function appCode(dir, rel) {
  const text = fs.readFileSync(path.join(dir, rel), "utf8");
  const blank = (m) => m.replace(/[^\n]/g, "");
  if (/\.(xml|plist|html?)$/i.test(rel)) return text.replace(/<!--[\s\S]*?-->/g, blank);
  if (/\.(toml|lock)$/i.test(rel)) return text.replace(/(^|\s)#.*$/gm, "$1");
  if (/\.json$/i.test(rel)) return text;
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/\s.*$/gm, "");
}

// Line rules: [{ langs, what, re }] → "file:line: what".
function lineOffenders(dir, rules) {
  const found = [];
  for (const rel of appFiles(dir)) {
    const lang = langOf(rel);
    const mine = rules.filter((r) => r.langs.includes(lang));
    if (!mine.length) continue;
    appCode(dir, rel)
      .split("\n")
      .forEach((line, i) => {
        for (const r of mine) if (r.re.test(line)) found.push(`${rel}:${i + 1}: ${r.what}`);
      });
  }
  return found;
}
const crate = (names) => new RegExp(`^\\s*(?:name\\s*=\\s*)?"?(?:${names})"?\\s*(?:=|$)`);
const NETWORK_CRATE = crate(
  "reqwest|hyper(?:-util)?|ureq|curl|isahc|surf|attohttpc|tauri-plugin-(?:http|updater|websocket|upload)",
);
const usesPermissions = (xml) => [...xml.matchAll(/<uses-permission\b[^>]*>/g)].map((m) => m[0]);
const appManifest = (xml) => /<application\b/.test(xml);

// 1. Nothing goes online. No language has network code or a network library, and each platform has its own lock
// besides: Android's app removes the internet permission so no library can add it back, the iPhone keyboard
// never asks for Full Access, and Tauri's web view runs under `default-src 'self'` with no network plugin.
const NETWORK_RULES = [
  {
    langs: ["js", "html"],
    what: "a network call",
    // An importScripts call for a same-folder relative path is fine, since the web view's CSP, default-src
    // 'self', already blocks anything else. Only a planted remote one, http(s): or a protocol-relative //,
    // trips this, the same way the extension's own offenders rule above already reads it.
    re: /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\s*\(\s*["'`](?:https?:|\/\/)|\bimport\s*\(\s*["'`]https?:/,
  },
  {
    langs: ["html"],
    what: "a file from the internet",
    re: /<[a-z]+\b[^>]*\s(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i,
  },
  {
    // java.net's address readers, URI, URLDecoder, URLEncoder and IDN, open nothing, but everything else there can.
    langs: ["kotlin"],
    what: "a network call",
    re: /\bjavax?\.net\.(?!(?:URI|URISyntaxException|URLDecoder|URLEncoder|IDN)\b)|\.openConnection\s*\(|\.openStream\s*\(|\.toURL\s*\(\s*\)|\bInetAddress\b|\bHttpsURLConnection\b|\bHttpURLConnection\b|\bSocket\s*\(|\bokhttp3?\b|\bio\.ktor\.client\b|\bretrofit2?\b|\bcom\.android\.volley\b|\bloadUrl\s*\(\s*"https?:|\bDownloadManager\b|\bWebSocket\b/,
  },
  {
    langs: ["gradle"],
    what: "a network library",
    re: /okhttp|ktor-client|retrofit|volley|firebase|play-services|com\.google\.android\.gms|sentry|crashlytics/i,
  },
  {
    langs: ["swift"],
    what: "a network call",
    re: /\bURLSession\b|\bNWConnection\b|\bNWPathMonitor\b|\bURLRequest\b|\bNSURLConnection\b|\bCFStream\w*|^\s*import\s+Network\b/,
  },
  {
    langs: ["rust"],
    what: "a network call",
    re: /\bstd::net\b|\btokio::net\b|\breqwest\b|\bhyper\b|\bureq\b|\bTcpStream\b|\bUdpSocket\b|\bTcpListener\b/,
  },
  {
    langs: ["cargo"],
    what: "a network crate",
    re: NETWORK_CRATE,
  },
];
// Cargo.lock names the crates every system would build, not only the ones the app is actually built from.
// Tauri's phone builds, for instance, pull in a network crate just to reach their development server. A network
// crate may appear there only when the cargo deny config beside it bans that crate for the systems the app ships
// to, so cargo deny fails the moment one gets built in. Cargo.toml, what the app itself asks for, may never name
// one at all.
function deniedCrates(dir, rel) {
  const file = path.join(dir, path.dirname(rel), "deny.toml");
  if (!fs.existsSync(file)) return new Set();
  const text = fs.readFileSync(file, "utf8").replace(/(^|\s)#.*$/gm, "$1");
  const section = (name) => text.split(`[${name}]`)[1]?.split(/^\[/m)[0] || "";
  if (!/^\s*targets\s*=\s*\[\s*"/m.test(section("graph"))) return new Set();
  return new Set([...section("bans").matchAll(/\bcrate\s*=\s*"([^"@]+)"/g)].map((m) => m[1]));
}
function appsNetworkOffenders(dir) {
  const found = lineOffenders(dir, NETWORK_RULES);
  for (const rel of appFiles(dir)) {
    const lang = langOf(rel);
    const text = lang && appCode(dir, rel);
    if (lang === "cargolock") {
      const denied = deniedCrates(dir, rel);
      text.split("\n").forEach((line, i) => {
        const name = /^\s*name\s*=\s*"([^"]+)"/.exec(line)?.[1];
        if (name && NETWORK_CRATE.test(line) && !denied.has(name)) found.push(`${rel}:${i + 1}: a network crate`);
      });
    }
    if (lang === "android") {
      const perms = usesPermissions(text).filter((t) => /android\.permission\.INTERNET\b/.test(t));
      if (perms.some((t) => !/tools:node\s*=\s*"remove"/.test(t))) found.push(`${rel}: asks for the internet`);
      else if (appManifest(text) && !perms.length) found.push(`${rel}: doesn't remove the internet permission`);
    }
    if (lang === "plist" && /<key>\s*RequestsOpenAccess\s*<\/key>\s*<true\s*\/>/.test(text))
      found.push(`${rel}: the keyboard asks for Full Access`);
    if (lang === "tauri") {
      const conf = JSON.parse(text);
      const csp = conf.app?.security?.csp ?? conf.tauri?.security?.csp;
      const policy =
        csp && typeof csp === "object"
          ? Object.entries(csp)
              .map(([k, v]) => `${k} ${v}`)
              .join("; ")
          : csp;
      if (typeof policy !== "string" || !/default-src 'self'/.test(policy) || /https?:|\*/.test(policy))
        found.push(`${rel}: the web view's policy isn't default-src 'self'`);
      for (const p of Object.keys(conf.plugins || {}).filter((k) => /^(http|updater|websocket|upload)$/.test(k)))
        found.push(`${rel}: the ${p} plugin`);
    }
  }
  return found;
}

// 2. Nothing detected gets stored anywhere but the app's one writer, fed through ClotrHost's clean and
// eventsFor. App backups stay off, there's no word learning or store that syncs, and logs only ever name kinds.
const STORAGE_RULES = [
  {
    langs: ["js", "html"],
    what: "a store besides the app's one writer",
    re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\.open\b|\bchrome\.storage\b|\bopenDatabase\s*\(/,
  },
  { langs: ["kotlin"], what: "the system's word learning", re: /\bUserDictionary\b/ },
  // These are FlorisBoard's own stores of what was copied or typed, taken out of the keyboard since they'd come
  // back on an update otherwise.
  {
    langs: ["kotlin"],
    what: "a clipboard history or a word store",
    re: /\bClipboardHistory(?:Dao|Database)\b|\bClipboardFile(?:Storage|sDao|sDatabase)\b|\bClipboardMediaProvider\b|\bFlorisUserDictionary\w*|\bUserDictionaryDao\b/,
  },
  { langs: ["swift"], what: "word learning or a store that syncs", re: /\blearnWord\b|\bNSUbiquitousKeyValueStore\b/ },
];
const LOG_CALLS = {
  js: /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/g,
  html: /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/g,
  kotlin: /\b(?:Log\.[vdiwe]|println|print|Timber\.[vdiwe])\s*\(/g,
  swift: /\b(?:print|debugPrint|NSLog|os_log|dump)\s*\(|\blogger\.\w+\s*\(/g,
  rust: /\b(?:println|eprintln|print|eprint|dbg|log|trace|debug|info|warn|error)!\s*\(/g,
};
// Pulls out what a log line's strings actually interpolate, their ${…}, $name, \(…) and {name} parts; the
// surrounding literal words themselves don't count.
const QUOTED = /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
const STRING_PARTS = {
  js: [QUOTED, /\$\{([^}]*)\}/g],
  html: [QUOTED, /\$\{([^}]*)\}/g],
  kotlin: [/"(?:\\.|[^"\\\n])*"/g, /\$\{([^}]*)\}|\$([A-Za-z_]\w*)/g],
  swift: [/"(?:\\.|[^"\\\n])*"/g, /\\\(([^)]*)\)/g],
  rust: [/"(?:\\.|[^"\\\n])*"/g, /\{([A-Za-z_]\w*)(?::[^}]*)?\}/g],
};
const VALUE_WORDS = /\b(?:text|value|values|draft|clipboard|matches|typed|input|content|secret|word|words)\b/i;
function logOffenders(dir) {
  const found = [];
  for (const rel of appFiles(dir)) {
    const lang = langOf(rel);
    if (!LOG_CALLS[lang]) continue;
    const src = appCode(dir, rel);
    for (const m of src.matchAll(LOG_CALLS[lang])) {
      // Reads the whole call up to its closing bracket, skipping over strings.
      let depth = 0;
      let end = m.index + m[0].length;
      for (let i = m.index + m[0].length - 1, quote = null; i < src.length; i++) {
        const c = src[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || (c === "'" && lang !== "rust") || c === "`") quote = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) {
          end = i + 1;
          break;
        }
      }
      const [strings, parts] = STRING_PARTS[lang];
      const said = src
        .slice(m.index + m[0].length, end)
        .replace(strings, (s) => [...s.matchAll(parts)].map((p) => ` ${p[1] ?? p[2] ?? ""} `).join(""))
        .replace(/\b\w+(?:\.(?:length|count|size|len\(\)))+/g, "");
      if (VALUE_WORDS.test(said)) found.push(`${rel}:${src.slice(0, m.index).split("\n").length}: a log with a value`);
    }
  }
  return found;
}
function appsStorageOffenders(dir) {
  const found = [...lineOffenders(dir, STORAGE_RULES), ...logOffenders(dir)];
  for (const rel of appFiles(dir).filter((r) => langOf(r) === "android")) {
    const text = appCode(dir, rel);
    if (/android:allowBackup\s*=\s*"true"/.test(text)) found.push(`${rel}: app backups on`);
    else if (appManifest(text) && !/android:allowBackup\s*=\s*"false"/.test(text))
      found.push(`${rel}: app backups not turned off`);
  }
  return found;
}

// 3. No AI inside: no model file anywhere under the apps folder, apart from a big file whose exact SHA-256 is
// pinned here for an approved word list, and no model runtime in any language's dependencies.
const APP_MODEL_FILES =
  /\.(onnx|safetensors|bin|gguf|pt|pth|ptl|pte|wasm|tflite|litertlm|task|mlmodel|mlmodelc|mlpackage)$/i;
const PINNED_BIG_FILES = {}; // "android/…/words.txt": "<sha256>", each an approved word list; none yet
const MODEL_RULES = [
  {
    langs: ["gradle"],
    what: "a model runtime",
    re: /tensorflow|tflite|litert|mlkit|onnxruntime|mediapipe|pytorch|executorch|llama|aicore|generativeai|ai\.edge/i,
  },
  {
    langs: ["swift"],
    what: "a model runtime",
    re: /^\s*import\s+(?:CoreML|CreateML|NaturalLanguage|FoundationModels|Vision)\b|\bMLModel\b/,
  },
  {
    langs: ["cargo", "cargolock"],
    what: "a model runtime",
    re: crate(
      "ort|tract(?:-[a-z]+)?|candle(?:-[a-z]+)?|burn(?:-[a-z]+)?|tch|llama(?:[-_][a-z]+)*|rust-bert|tokenizers|whisper-rs|onnxruntime",
    ),
  },
  {
    langs: ["js", "html"],
    what: "a model runtime",
    re: new RegExp(
      `(?:require\\s*\\(|from\\s+|import\\s*\\()\\s*["'\`](?:${MODEL_RUNTIMES.map((n) => n.replace(/[/.]/g, "\\$&")).join("|")})`,
    ),
  },
];
function appsModelOffenders(dir, pinned = PINNED_BIG_FILES) {
  const found = lineOffenders(dir, MODEL_RULES);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (APP_MODEL_FILES.test(e.name)) found.push(`${rel}: a model file`);
      else if (e.isDirectory()) {
        // Built output and the build tools' caches aren't the source. A model a library brings in gets caught by
        // the runtime rules above instead, and the Android build checks its own app separately.
        if (!NOT_SOURCE.has(e.name)) walk(full);
      } else if (fs.statSync(full).size > MAX_FILE) {
        const sum = require("crypto").createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        if (pinned[rel] !== sum) found.push(`${rel}: over 2 MB and not pinned`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  for (const rel of appFiles(dir).filter((r) => langOf(r) === "npm")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const name of MODEL_RUNTIMES) if (deps[name]) found.push(`${rel}: ${name}`);
  }
  return found.sort();
}

// 4. No HTML or script may be built from strings in any web view: the desktop's pages, an Android or iPhone web
// view, or what Rust hands the web view.
const HTML_RULES = [
  {
    langs: ["js", "html"],
    what: "HTML built from a string",
    re: /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write(?:ln)?\s*\(|\bsrcdoc\b|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe/,
  },
  { langs: ["kotlin"], what: "HTML built from a string", re: /\.loadData(?:WithBaseURL)?\s*\(/ },
  { langs: ["swift"], what: "HTML built from a string", re: /\bloadHTMLString\s*\(/ },
  { langs: ["rust"], what: "a script built from a string", re: /\.eval\s*\(/ },
];
const appsHtmlOffenders = (dir) => lineOffenders(dir, HTML_RULES);

// A folder of planted files, removed after `fn`.
function withPlanted(files, fn) {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-apps-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Apps code that keeps every rule, with comments naming what's banned, so none of the checks above should trip on it.
const GOOD_APP = {
  "engine/check.js": [
    "// Never fetch( anything; never innerHTML = or localStorage; console.log(text) would be wrong.",
    "const n = found.length;",
    'console.info("[Clotr]", "kinds:", kinds.join(","), n, text.length);',
    "box.textContent = words.lead;",
    'const link = "see https://clotr.app"; // a link in a string is not a call',
    "",
  ].join("\n"),
  "android/app/src/main/AndroidManifest.xml": [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
    '  <!-- <uses-permission android:name="android.permission.INTERNET" /> stays out -->',
    '  <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />',
    '  <application android:allowBackup="false" android:label="Clotr" />',
    "</manifest>",
    "",
  ].join("\n"),
  "android/clotr/src/main/java/app/clotr/Strip.kt": [
    "package app.clotr",
    "import java.net.URI // reading an address is not going online",
    "// No java.net.URL here, and no Log.d(TAG, text).",
    'val theme = URI.create("flex:/theme.json").path',
    'fun show(kinds: List<String>) { Log.d("Clotr", "kinds: ${kinds.size}") }',
    'fun load(view: WebView) { view.loadUrl("file:///android_asset/engine.html") }',
    "",
  ].join("\n"),
  "android/clotr/build.gradle.kts":
    'dependencies { implementation("androidx.javascriptengine:javascriptengine:1.0.0") }\n',
  // Gradle's own caches and the built app aren't the source.
  "android/.gradle/9.2.0/checksums/sha1-checksums.bin": "cache",
  "android/app/build/intermediates/x/y.bin": "built",
  "ios/Keyboard/Info.plist": "<plist><dict><key>RequestsOpenAccess</key><false/></dict></plist>\n",
  "ios/Keyboard/Strip.swift":
    'import UIKit\n// URLSession is never used.\nfunc show(_ kinds: [String]) { print("kinds: \\(kinds.count)") }\n',
  "desktop/src-tauri/src/main.rs": [
    '// std::net stays out; println!("{text}") would be wrong.',
    'fn main() { let n = kinds.len(); println!("{} kinds, {n}", n); }',
    "",
  ].join("\n"),
  "desktop/src-tauri/Cargo.toml": '[dependencies]\ntauri = "2"\nserde_json = "1"\n# reqwest = "0.12" stays out\n',
  // Tauri's phone builds name a network crate in the lock, and cargo deny bans it for the systems the app ships to.
  "desktop/src-tauri/Cargo.lock": '[[package]]\nname = "reqwest"\nversion = "0.13.0"\n\n[[package]]\nname = "tauri"\n',
  "desktop/src-tauri/deny.toml":
    '[graph]\ntargets = ["x86_64-pc-windows-msvc"]\n\n[bans]\ndeny = [\n  { crate = "reqwest", reason = "network" },\n]\n',
  "desktop/src-tauri/target/debug/clotr.exe": Buffer.alloc(3 * 1024 * 1024, 1), // built output, not a source
  "desktop/src-tauri/tauri.conf.json": JSON.stringify({
    app: { security: { csp: "default-src 'self'" } },
    plugins: {},
  }),
  "desktop/ui/index.html": '<!doctype html><script src="card.js"></script><link href="card.css" rel="stylesheet">\n',
  // A same-folder relative importScripts, loading the worker's own files, is never flagged.
  "desktop/ui/worker.js": 'importScripts("dist/clotr-engine.js", "dist/attachments.js");\n',
};

test("apps: the engine bundle's scripts parse as classic scripts (no import/export), like the content scripts", () => {
  const dir = path.join(APPS, "engine");
  for (const rel of appFiles(dir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    assert.doesNotThrow(() => new vm.Script(text, { filename: rel }), rel);
    assert.doesNotMatch(appCode(dir, rel), /^\s*(import|export)\s/m, rel);
  }
});

test("apps: nothing goes online (network code, network libraries, the internet permission, Full Access, the web view)", () => {
  assert.deepEqual(appsNetworkOffenders(APPS), []);
  withPlanted(GOOD_APP, (dir) => assert.deepEqual(appsNetworkOffenders(dir), []));
  const bad = {
    "engine/a.js": 'fetch("https://example.com");\nconst ws = new WebSocket("wss://x");\n',
    "desktop/ui/page.html": '<script src="https://cdn.example.com/x.js"></script>\n',
    "android/clotr/src/main/java/app/clotr/Net.kt":
      "import java.net.URL\nval c = URL(u).openConnection() as HttpURLConnection\nval s = URI.create(u).toURL().openStream()\n",
    "android/clotr/build.gradle.kts": 'dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }\n',
    "android/app/src/main/AndroidManifest.xml":
      '<manifest>\n  <uses-permission android:name="android.permission.INTERNET" />\n  <application android:allowBackup="false" />\n</manifest>\n',
    "android/other/src/main/AndroidManifest.xml":
      '<manifest>\n  <application android:allowBackup="false" />\n</manifest>\n',
    "ios/Keyboard/Info.plist": "<plist><dict><key>RequestsOpenAccess</key>\n<true/></dict></plist>\n",
    "ios/Keyboard/Sync.swift": "let task = URLSession.shared.dataTask(with: url)\n",
    "desktop/src-tauri/src/net.rs": "use std::net::TcpStream;\n",
    "desktop/src-tauri/Cargo.toml": '[dependencies]\nreqwest = { version = "0.12" }\ntauri-plugin-updater = "2"\n',
    // A lock naming network crates with no cargo deny ban, including one that's only half banned, with no
    // systems named.
    "desktop/src-tauri/Cargo.lock": '[[package]]\nname = "hyper-util"\n\n[[package]]\nname = "reqwest"\n',
    "desktop/src-tauri/deny.toml": '[bans]\ndeny = [{ crate = "reqwest" }]\n',
    "desktop/src-tauri/tauri.conf.json": JSON.stringify({
      app: { security: { csp: "default-src 'self' https://api.example.com" } },
      plugins: { updater: {} },
    }),
    // A remote importScripts is still caught, even though a same-folder one in GOOD_APP isn't.
    "desktop/ui/worker.js": 'importScripts("https://evil.example/x.js");\n',
  };
  withPlanted(bad, (dir) =>
    assert.deepEqual(appsNetworkOffenders(dir).sort(), [
      "android/app/src/main/AndroidManifest.xml: asks for the internet",
      "android/clotr/build.gradle.kts:1: a network library",
      "android/clotr/src/main/java/app/clotr/Net.kt:1: a network call",
      "android/clotr/src/main/java/app/clotr/Net.kt:2: a network call",
      "android/clotr/src/main/java/app/clotr/Net.kt:3: a network call",
      "android/other/src/main/AndroidManifest.xml: doesn't remove the internet permission",
      "desktop/src-tauri/Cargo.lock:2: a network crate",
      "desktop/src-tauri/Cargo.lock:5: a network crate",
      "desktop/src-tauri/Cargo.toml:2: a network crate",
      "desktop/src-tauri/Cargo.toml:3: a network crate",
      "desktop/src-tauri/src/net.rs:1: a network call",
      "desktop/src-tauri/tauri.conf.json: the updater plugin",
      "desktop/src-tauri/tauri.conf.json: the web view's policy isn't default-src 'self'",
      "desktop/ui/page.html:1: a file from the internet",
      "desktop/ui/worker.js:1: a network call",
      "engine/a.js:1: a network call",
      "engine/a.js:2: a network call",
      "ios/Keyboard/Info.plist: the keyboard asks for Full Access",
      "ios/Keyboard/Sync.swift:1: a network call",
    ]),
  );
});

test("apps: nothing detected is stored (one writer, backups off, no word learning, logs that name kinds only)", () => {
  assert.deepEqual(appsStorageOffenders(APPS), []);
  withPlanted(GOOD_APP, (dir) => assert.deepEqual(appsStorageOffenders(dir), []));
  const bad = {
    "engine/a.js":
      'localStorage.setItem("last", draft);\nconsole.log("[Clotr] found", value);\nconsole.info(`typed ${text}`);\n',
    "android/app/src/main/AndroidManifest.xml":
      '<manifest>\n  <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />\n  <application android:allowBackup="true" />\n</manifest>\n',
    "android/other/src/main/AndroidManifest.xml":
      '<manifest>\n  <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />\n  <application />\n</manifest>\n',
    "android/clotr/src/main/java/app/clotr/Learn.kt":
      'UserDictionary.Words.addWord(context, word, 1, null, null)\nLog.d("Clotr", "saw $text")\n',
    "android/app/src/main/kotlin/ime/Keep.kt":
      "val db = ClipboardHistoryDatabase.new(context)\nval words: FlorisUserDictionaryDatabase? = null\n",
    "ios/Keyboard/Learn.swift": 'checker.learnWord(word)\nprint("typed \\(input)")\n',
    "desktop/src-tauri/src/main.rs": 'fn f() { println!("{clipboard}"); eprintln!("{}", content); }\n',
  };
  withPlanted(bad, (dir) =>
    assert.deepEqual(appsStorageOffenders(dir).sort(), [
      "android/app/src/main/AndroidManifest.xml: app backups on",
      "android/app/src/main/kotlin/ime/Keep.kt:1: a clipboard history or a word store",
      "android/app/src/main/kotlin/ime/Keep.kt:2: a clipboard history or a word store",
      "android/clotr/src/main/java/app/clotr/Learn.kt:1: the system's word learning",
      "android/clotr/src/main/java/app/clotr/Learn.kt:2: a log with a value",
      "android/other/src/main/AndroidManifest.xml: app backups not turned off",
      "desktop/src-tauri/src/main.rs:1: a log with a value",
      "desktop/src-tauri/src/main.rs:1: a log with a value",
      "engine/a.js:1: a store besides the app's one writer",
      "engine/a.js:2: a log with a value",
      "engine/a.js:3: a log with a value",
      "ios/Keyboard/Learn.swift:1: word learning or a store that syncs",
      "ios/Keyboard/Learn.swift:2: a log with a value",
    ]),
  );
});

test("apps: no AI inside (no model file, no model runtime in any language, big files only when pinned)", () => {
  assert.deepEqual(appsModelOffenders(APPS), []);
  withPlanted(GOOD_APP, (dir) => assert.deepEqual(appsModelOffenders(dir), []));
  const big = Buffer.alloc(MAX_FILE + 1, 97);
  const bigSum = require("crypto").createHash("sha256").update(big).digest("hex");
  const bad = {
    "android/clotr/src/main/assets/filter.tflite": "fake",
    "ios/Keyboard/Model.mlpackage/Data/weights.json": "fake",
    "android/clotr/build.gradle.kts": 'dependencies { implementation("com.google.mediapipe:tasks-text:0.10.0") }\n',
    "ios/Keyboard/Read.swift": "import Vision\nlet r = VNRecognizeTextRequest()\n",
    "desktop/src-tauri/Cargo.toml": '[dependencies]\nort = "2"\n',
    "desktop/ui/ai.js": 'import { pipeline } from "@huggingface/transformers";\n',
    "desktop/ui/package.json": JSON.stringify({ dependencies: { "onnxruntime-web": "1.0.0" } }),
    "android/clotr/src/main/assets/words-en.txt": big,
    "android/clotr/src/main/assets/words-es.txt": big,
  };
  withPlanted(bad, (dir) =>
    assert.deepEqual(appsModelOffenders(dir, { "android/clotr/src/main/assets/words-es.txt": bigSum }), [
      "android/clotr/build.gradle.kts:1: a model runtime",
      "android/clotr/src/main/assets/filter.tflite: a model file",
      "android/clotr/src/main/assets/words-en.txt: over 2 MB and not pinned",
      "desktop/src-tauri/Cargo.toml:2: a model runtime",
      "desktop/ui/ai.js:1: a model runtime",
      "desktop/ui/package.json: onnxruntime-web",
      "ios/Keyboard/Model.mlpackage: a model file",
      "ios/Keyboard/Read.swift:1: a model runtime",
    ]),
  );
});

test("apps: no HTML or script built from strings in any web view", () => {
  assert.deepEqual(appsHtmlOffenders(APPS), []);
  withPlanted(GOOD_APP, (dir) => assert.deepEqual(appsHtmlOffenders(dir), []));
  const bad = {
    "desktop/ui/card.js": 'card.innerHTML = "<b>" + words.lead + "</b>";\nbox.insertAdjacentHTML("beforeend", x);\n',
    "desktop/ui/frame.html": '<iframe srcdoc="<p>hi</p>"></iframe>\n',
    "android/clotr/src/main/java/app/clotr/View.kt":
      'view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)\n',
    "ios/Keyboard/View.swift": "webView.loadHTMLString(html, baseURL: nil)\n",
    "desktop/src-tauri/src/card.rs": 'window.eval(&format!("show({})", text));\n',
  };
  withPlanted(bad, (dir) =>
    assert.deepEqual(appsHtmlOffenders(dir).sort(), [
      "android/clotr/src/main/java/app/clotr/View.kt:1: HTML built from a string",
      "desktop/src-tauri/src/card.rs:1: a script built from a string",
      "desktop/ui/card.js:1: HTML built from a string",
      "desktop/ui/card.js:2: HTML built from a string",
      "desktop/ui/frame.html:1: HTML built from a string",
      "ios/Keyboard/View.swift:1: HTML built from a string",
    ]),
  );
});

// The "Is this a scam?" page, check.html, never tells anyone a message is fine. No string of the page (sc_), of
// Scam Shield's shared words (ss_), or of the command check (cg_), in English or Spanish, says "safe", "fine",
// "legit", "not a scam", "100%", or gives a percentage, except the one footnote that says what the page never
// does (sc_never), which has to say it as a "never".
const UNSAID =
  /\b(?:safe|safely|fine|legit|legitimate)\b|not\s+a\s+scam|100\s?%|%|(?<![\p{L}])(?:seguro|segura|est[aá]\s+bien|no\s+es\s+una\s+estafa)(?![\p{L}])/iu;
// Look back and Extension check (lb_, ec_) share the same honesty, but with one word allowed back in: "fine" is
// fine there, since ec_noLead says "That's fine" about the permission being declined, not about a chat's safety.
// "Safe" and the rest of UNSAID still never describe a result, and neither page ever calls an extension "spying"
// or gives it a score: no word of either page, in either language, says "spy", "spying", "malicious", "spyware",
// "infected", "threat" or "score".
const SCAN_UNSAID =
  /\b(?:safe|safely|legit|legitimate)\b|not\s+a\s+scam|100\s?%|%|(?<![\p{L}])(?:seguro|segura|no\s+es\s+una\s+estafa)(?![\p{L}])/iu;
const SPY_WORDS =
  /\b(?:spy|spying|malicious|spyware|infected|threat|score)\b|(?<![\p{L}])(?:esp[ií]a[a-z]*|espiando|malicios[oa]|malintencionad[oa]|infectad[oa]|amenaza[a-z]*|puntuaci[oó]n)(?![\p{L}])/iu;
function honestWordsOffenders(en, es) {
  const keys = [...new Set([...Object.keys(en), ...Object.keys(es)])].filter((k) =>
    /^(?:sc|ss|cg|lb|ec)_|^cmd[A-Z]/.test(k),
  );
  const out = [];
  for (const k of keys)
    for (const [lang, text] of [
      ["en", en[k]],
      ["es", es[k]?.message],
    ]) {
      if (!text) continue;
      if (k === "sc_never") {
        if (!/\bnever\b|\bnunca\b/i.test(text)) out.push(`${lang} ${k}: doesn't say it as a never`);
      } else if (/^(?:lb|ec)_/.test(k)) {
        if (SCAN_UNSAID.test(text) || SPY_WORDS.test(text)) out.push(`${lang} ${k}: ${text}`);
      } else if (UNSAID.test(text)) out.push(`${lang} ${k}: ${text}`);
    }
  return out;
}
test("Is this a scam?: no word says a message is fine, in English or Spanish", () => {
  const en = englishByKey();
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.ok(Object.keys(en).filter((k) => k.startsWith("sc_")).length >= 40, "the page's English strings");
  assert.ok(Object.keys(es).filter((k) => k.startsWith("sc_")).length >= 40, "the page's Spanish strings");
  assert.ok(en.sc_never && es.sc_never, "the footnote");
  assert.deepEqual(honestWordsOffenders(en, es), []);
  // Plants each forbidden word and checks it gets caught, and makes sure the footnote keeps its "never".
  for (const bad of ["This message looks safe.", "It's fine to reply.", "100% legit", "Score: 80%", "Es seguro."])
    assert.equal(honestWordsOffenders({ sc_x: bad }, {}).length, 1, bad);
  assert.equal(honestWordsOffenders({}, { sc_x: { message: "No es una estafa." } }).length, 1);
  assert.deepEqual(honestWordsOffenders({ sc_never: "It says a message is fine." }, {}), [
    "en sc_never: doesn't say it as a never",
  ]);
  assert.deepEqual(honestWordsOffenders({ sc_x: "Security code" }, { sc_x: { message: "Seguridad Social" } }), []);
});

// Look back and Extension check, in lb_ and ec_, extension/scan-words.js, share the same honesty with their own
// word list. "Fine" stays allowed there, since ec_noLead means "That's fine" about the permission being
// declined, not about a result, but "safe" and the rest still never describe what Clotr found, and neither page
// ever calls an extension "spying" or "malicious" or gives it a score.
test("Look back and Extension check: every word exists in both languages, and the honest-words rule covers them too", () => {
  require("../extension/scan-words.js");
  const keys = globalThis.Clotr.SCAN_WORD_KEYS;
  const en = englishByKey();
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.ok(keys.length >= 100, "the words table");
  for (const k of keys) {
    assert.equal(typeof en[k], "string", `no English for ${k}`);
    assert.ok(es[k]?.message, `no Spanish for ${k}`);
  }
  assert.deepEqual(honestWordsOffenders(en, es), []);
  // Plants each one and checks it's caught, for either page, in either language.
  for (const bad of ["Looks safe to use.", "Spying on your extensions.", "Score: 4 of 11", "Malicious code found."])
    for (const prefix of ["lb_x", "ec_x"])
      assert.equal(honestWordsOffenders({ [prefix]: bad }, {}).length, 1, `${prefix}: ${bad}`);
  assert.deepEqual(honestWordsOffenders({ ec_x: "That's fine, nothing changed." }, {}), []);
  assert.equal(honestWordsOffenders({}, { lb_x: { message: "Es una app espía." } }).length, 1);
});

test("Is this a scam?: the page loads only Clotr's own scripts, and keeps, sends and logs nothing", () => {
  const html = fs.readFileSync(path.join(EXT, "check.html"), "utf8");
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["page-i18n.js", "patterns.js", "detector.js", "scam-signs.js", "report.js", "check.js"]);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/, "an inline script");
  // The box turns off autofill and spell check, since the browser's spell check could send words away.
  assert.match(html, /<textarea\b[^>]*\bautocomplete="off"/);
  assert.match(html, /<textarea\b[^>]*\bspellcheck="false"/);
  // check.js reads the salt and the vault's fingerprints, and never writes, sends, fetches or logs.
  const src = code("check.js");
  for (const [re, what] of [
    [/storage\.\w+\.(?:set|remove|clear)\b/, "a storage write"],
    [/\bsendMessage\b|\bconnect\(/, "a message out of the page"],
    [/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/, "a request"],
    [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/, "the page's own storage"],
    [/\bconsole\.(?:log|info|warn|error|debug)\(/, "a log"],
    [/\.innerHTML\b|insertAdjacentHTML|document\.write/, "HTML from a string"],
  ])
    assert.doesNotMatch(src, re, `check.js: ${what}`);
  assert.match(src, /chrome\.storage\.local\s*\.get\(\s*\[\s*"salt",\s*"vault"\s*\]\s*\)/, "reads the salt and vault");
  assert.equal((src.match(/storage\.\w+\s*\.get\(/g) || []).length, 1, "reads storage once, for those two");
});

test("the command check never stores, sends or logs the copied command or the message it came from", () => {
  const raw = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  const start = raw.indexOf("The command check: a copied");
  const end = raw.indexOf("Bandage step 2");
  assert.ok(start > -1 && end > start, "could not find the command-check section in content.js");
  const section = raw
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const [re, what] of [
    [/storage\.\w+\.(?:set|remove|clear)\b/, "a storage write"],
    [/\bsendMessage\b|\bconnect\(/, "a message out of the page"],
    [/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/, "a request"],
    [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/, "the page's own storage"],
  ])
    assert.doesNotMatch(section, re, `content.js command check: ${what}`);
  // The one log in this section names the shape only, never the copied command or the message around it.
  const logs = [...section.matchAll(/console\.(?:log|info|warn|error|debug)\([^)]*\)/g)].map((m) => m[0]);
  assert.equal(logs.length, 1, `expected exactly one log in the command-check section, found ${logs.length}`);
  assert.match(logs[0], /^console\.info\(LOG, "a copied command looks like a paste-a-command trick", trick\.shape\)$/);
  // commands.js (the trick detector itself) stores, sends and logs nothing either.
  const cmdSrc = code("commands.js");
  for (const [re, what] of [
    [/storage\.\w+\.(?:set|get|remove|clear)\b/, "a storage call"],
    [/\bsendMessage\b|\bconnect\(/, "a message out of the page"],
    [/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/, "a request"],
    [/\bconsole\.(?:log|info|warn|error|debug)\(/, "a log"],
  ])
    assert.doesNotMatch(cmdSrc, re, `commands.js: ${what}`);
});

test("Is this a scam?: every sign has its name, its meaning and a source, in English and Spanish", () => {
  require("../extension/patterns.js");
  require("../extension/scam-signs.js");
  const en = englishByKey();
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const src = code("check.js");
  for (const { id, group } of globalThis.Clotr.SCAM_SIGNS) {
    for (const key of [`sc_${id}`, `sc_${id}_means`]) {
      assert.ok(en[key], `no English for ${key}`);
      assert.ok(es[key], `no Spanish for ${key}`);
    }
    assert.ok(en[`sc_group_${group}`] && es[`sc_group_${group}`], `no words for the group ${group}`);
    assert.match(src, new RegExp(`\\b${id}:\\s*\\[\\s*\\d+`), `${id} has no source`);
  }
});
