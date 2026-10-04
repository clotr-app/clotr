// Dev tool (not shipped): have the built-in AI sites or the everyday email/chat apps changed in a
// way that affects Clotr? Two modes:
//
//  - Default: opens every site logged out, in a throwaway headless Brave/Chrome profile with Clotr
//    loaded. For each built-in AI site it records where it ends up (and whether Clotr covers that
//    address), whether Clotr's self-check sees a chat box, and which kind of editor it uses. For
//    each everyday email/chat app (D134, EVERYDAY_SITES in sites.js — logged out, these mostly show
//    a sign-in page) it records where it ends up, whether that host is still the one its own
//    per-site permission would cover, and whether a sign-in wall was reached. Compares both groups
//    with the saved baseline and lists what changed: a site that moved (lmarena.ai → arena.ai), a
//    chat box Clotr can no longer see, a new editor (Kimi's async Lexical) that needs a real-site
//    check. Nothing is typed or sent; pages are only loaded. Sites behind a bot check show as
//    "blocked".
//
//  - `--hosts`: a fast pre-release check with no browser: plain HTTPS requests from Node (following
//    redirects) confirm every built-in host (ai-sites.json) and everyday host (EVERYDAY_SITES)
//    still answers on its exact host and doesn't redirect to a different one. Lists any moved host
//    with its new address.
//
// Usage: npm run site-check                   compare with tools/site-baseline.json
//        npm run site-check -- --update       save this run as the new baseline
//        npm run site-check -- --only grok.com,kimi
//        npm run site-check -- --hosts        the fast host-only check (no browser, no baseline)
//        npm run site-check -- --hosts --only discord.com
//        --browser <path>  --headed
// Report: tools/site-check-report.md (git-ignored, default mode only). Exit code 1 when something
// needs a look (default mode) or a host has moved or stopped answering (--hosts).
"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const BASELINE = path.join(__dirname, "site-baseline.json");
const REPORT = path.join(__dirname, "site-check-report.md");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// sites.js turns match patterns into regexes; it reads the manifest through chrome.runtime.
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
globalThis.chrome = { runtime: { getManifest: () => manifest } };
require(path.join(EXT, "sites.js"));
const Sites = globalThis.ClotrSites;
const BUILT_IN = manifest.content_scripts.flatMap((c) => c.matches);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A match pattern's host, e.g. "https://huggingface.co/chat/*" -> "huggingface.co".
function hostOf(pattern) {
  return new URL(pattern.replace(/\*$/, "")).hostname;
}

function findBrowser() {
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Brave/Chrome found; pass --browser <path>");
  return found;
}

function onlyFilter() {
  return option("--only")
    ?.split(",")
    .map((s) => s.trim().toLowerCase());
}

// One address per built-in site: its first match pattern, without the wildcard.
function sitesToCheck() {
  const list = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  const only = onlyFilter();
  return list
    .map((s) => ({ name: s.name, url: s.matches[0].replace(/\*$/, "") }))
    .filter((s) => !only || only.some((o) => s.url.includes(o) || s.name.toLowerCase().includes(o)));
}

// One address per everyday site (D134, EVERYDAY_SITES in sites.js): its first match to open, and
// all its own matches, since coverage for an everyday site is its own list, not the built-in one.
function everydaySitesToCheck() {
  const only = onlyFilter();
  return Sites.EVERYDAY_SITES.map((s) => ({
    name: s.name,
    url: s.matches[0].replace(/\*$/, ""),
    matches: s.matches,
  })).filter((s) => !only || only.some((o) => s.url.includes(o) || s.name.toLowerCase().includes(o)));
}

// Runs in the page: the first visible chat box and what kind of editor it is.
function editorKind() {
  const kind = (el) => {
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.closest("[data-lexical-editor]")) return "lexical";
    if (el.closest(".ProseMirror")) return "prosemirror";
    if (el.closest(".ql-editor")) return "quill";
    if (el.closest("[data-slate-editor]")) return "slate";
    if (el.closest(".cm-content")) return "codemirror";
    return "contenteditable";
  };
  const find = (root, depth) => {
    for (const el of root.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    )) {
      if (el.getClientRects().length) return el;
    }
    if (depth > 2) return null;
    for (const host of root.querySelectorAll("*")) {
      const found = host.shadowRoot && find(host.shadowRoot, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const el = find(document, 0);
  const text = (document.body?.innerText || "").slice(0, 3000);
  return {
    editor: el ? kind(el) : "none",
    inShadow: Boolean(el && el.getRootNode() !== document),
    title: document.title.slice(0, 80),
    botCheck: /just a moment|verify you are human|checking your browser|attention required|access denied/i.test(
      `${document.title} ${text.slice(0, 400)}`,
    ),
    signIn: /\b(sign|log) ?in\b/i.test(text),
  };
}

// Whether `url` lands on a sign-in page elsewhere (its own host, or the site's own address, isn't
// reached). Logged-out email and AI sites both do this; it's not the site moving.
function looksLikeSignIn(url) {
  const u = new URL(url);
  return (
    /^(accounts|login|auth|signin|sso|id)\./.test(u.hostname) || /\/(login|signin|sign-in|auth)\b/i.test(u.pathname)
  );
}

// Compares one run's results for a group of sites (built-in AI tools or everyday apps) with its
// saved baseline, and lists what needs a look. Pure, so fixtures can test it without a browser.
// `signInField` names the row's sign-in-wall flag: reaching one there isn't "not covered" or a
// move worth flagging on its own. `checkEditor` turns on the AI-only editor checks.
function compareToBaseline(results, baseline, { signInField, checkEditor, notCoveredHint }) {
  const findings = [];
  for (const r of results) {
    const was = baseline[r.url];
    if (r.error) {
      findings.push(`**${r.name}**: couldn't load (${r.error})`);
      continue;
    }
    if (!r.covered && !r[signInField])
      findings.push(`**${r.name}** now ends up at **${r.finalHost}**, ${notCoveredHint}`);
    if (r.botCheck) continue; // a bot check says nothing about the site itself
    if (checkEditor && r.editor !== "none" && r.clotrSees !== "yes")
      findings.push(`**${r.name}**: there's a chat box (${r.editor}) but Clotr reports "${r.clotrSees}"`);
    if (!was) continue;
    if (was.finalHost !== r.finalHost) findings.push(`**${r.name}** moved: ${was.finalHost} → ${r.finalHost}`);
    if (checkEditor && was.editor !== r.editor)
      findings.push(`**${r.name}** editor changed: ${was.editor} → ${r.editor} (check Cover it on the real site)`);
  }
  return findings;
}

// --hosts mode's comparison: does each host still answer as itself? `results`: one row per host
// checked ({ name, host, finalHost, error }). Pure, so fixtures can test it without a network call.
function diffHosts(results) {
  return {
    moved: results.filter((r) => !r.error && r.finalHost && r.finalHost !== r.host),
    errors: results.filter((r) => r.error),
  };
}

async function main() {
  // Loaded only here, for the browser run: the comparison helpers and --hosts need no browser, so the unit tests
  // pass without puppeteer installed (as in the public export's own test run, from a folder with no node_modules).
  const puppeteer = require("puppeteer-core");
  const browserPath = option("--browser") || findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-sitecheck-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
  );
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: !flag("--headed"),
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 850 },
    args: ["--no-first-run", "--no-default-browser-check", "--enable-unsafe-extension-debugging"],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 15000 },
  );
  const sw = await swTarget.createCDPSession();
  const inWorker = async (fn, ...a) => {
    const r = await sw.send("Runtime.evaluate", {
      expression: `(${fn})(...${JSON.stringify(a)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const ua = (await browser.userAgent()).replace("HeadlessChrome", "Chrome"); // look like the browser it is

  const results = [];
  for (const site of sitesToCheck()) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    const row = { name: site.name, url: site.url };
    try {
      const response = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      row.status = response?.status() ?? 0;
      await sleep(7000); // let the app render and Clotr's self-check look (it checks every 2 s)
      const finalUrl = page.url();
      row.finalHost = new URL(finalUrl).hostname;
      row.covered = Sites.urlMatchesAny(finalUrl, BUILT_IN);
      // Logged out, some sites send you to a sign-in page elsewhere: that's not a move.
      row.signInRedirect = !row.covered && looksLikeSignIn(finalUrl);
      Object.assign(row, await page.evaluate(editorKind));
      row.clotrSees = await inWorker(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
        const h = tab && protectedTabs[tab.id];
        return h ? (h.editor ? "yes" : "no chat box") : "not running";
      }, finalUrl);
    } catch (err) {
      row.error = String(err.message || err).slice(0, 120);
    }
    await page.close();
    results.push(row);
    console.log(
      `${site.name.padEnd(22)} ${row.error ? `error: ${row.error}` : `${row.finalHost} · editor ${row.editor} · Clotr ${row.clotrSees}${row.botCheck ? " · bot check" : ""}`}`,
    );
  }

  // Everyday email/chat apps (D134): not run by background.js's self-check, so no "Clotr sees it"
  // signal — just where the page lands, whether its own per-site permission would still cover
  // that host, and whether a sign-in wall was reached (expected, logged out).
  const everydayResults = [];
  for (const site of everydaySitesToCheck()) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    const row = { name: site.name, url: site.url };
    try {
      const response = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      row.status = response?.status() ?? 0;
      await sleep(4000); // just needs to settle; there's no self-check to wait for here
      const finalUrl = page.url();
      row.finalHost = new URL(finalUrl).hostname;
      row.covered = Sites.urlMatchesAny(finalUrl, site.matches);
      row.signInRedirect = !row.covered && looksLikeSignIn(finalUrl);
      const evaluated = await page.evaluate(editorKind);
      row.signInWall = row.signInRedirect || evaluated.signIn;
    } catch (err) {
      row.error = String(err.message || err).slice(0, 120);
    }
    await page.close();
    everydayResults.push(row);
    console.log(
      `${site.name.padEnd(22)} ${row.error ? `error: ${row.error}` : `${row.finalHost} · covered ${row.covered} · sign-in wall ${row.signInWall}`}`,
    );
  }

  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const baselineData = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
  const findings = compareToBaseline(results, baselineData.sites || {}, {
    signInField: "signInRedirect",
    checkEditor: true,
    notCoveredHint: "which Clotr doesn't cover: add it to ai-sites.json",
  });
  const everydayFindings = compareToBaseline(everydayResults, baselineData.everyday || {}, {
    signInField: "signInWall",
    checkEditor: false,
    notCoveredHint: "which its own host permission wouldn't cover: check EVERYDAY_SITES in sites.js",
  });
  const allFindings = [...findings, ...everydayFindings];

  const lines = [
    "# Built-in AI sites: change check",
    "",
    `Run ${new Date().toISOString()} · Clotr ${manifest.version} · logged out, nothing typed`,
    "",
    allFindings.length ? "## Needs a look" : "## Nothing changed that needs a look",
    ...allFindings.map((f) => `- ${f}`),
    "",
    "## Built-in AI sites",
    "",
    "| Site | Ends up at | Covered | Editor | Clotr sees the chat box | Notes |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.finalHost || "—"} | ${r.error ? "—" : r.covered ? "yes" : r.signInRedirect ? "sign-in page" : "**no**"} | ${r.editor || "—"}${r.inShadow ? " (shadow)" : ""} | ${r.clotrSees || "—"} | ${[r.error, r.botCheck && "bot check", r.signInRedirect && "sends you to sign in", r.editor === "none" && r.signIn && !r.signInRedirect && "sign-in page"].filter(Boolean).join("; ")} |`,
    ),
    "",
    "## Email and chat apps (D134, switched on by the user; mostly reached as a sign-in page here)",
    "",
    "| Site | Ends up at | Covered | Sign-in wall reached | Notes |",
    "|---|---|---|---|---|",
    ...everydayResults.map(
      (r) =>
        `| ${r.name} | ${r.finalHost || "—"} | ${r.error ? "—" : r.covered ? "yes" : "**no**"} | ${r.error ? "—" : r.signInWall ? "yes" : "no"} | ${[r.error].filter(Boolean).join("; ")} |`,
    ),
  ];
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
  console.log(
    `\n${allFindings.length ? `${allFindings.length} to look at` : "Nothing to look at"}. Report: ${path.relative(ROOT, REPORT)}`,
  );

  if (flag("--update")) {
    const sites = Object.fromEntries(
      results.filter((r) => !r.error && !r.botCheck).map((r) => [r.url, { finalHost: r.finalHost, editor: r.editor }]),
    );
    const everyday = Object.fromEntries(
      everydayResults
        .filter((r) => !r.error)
        .map((r) => [r.url, { finalHost: r.finalHost, covered: r.covered, signInWall: r.signInWall }]),
    );
    fs.writeFileSync(
      BASELINE,
      `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sites, everyday }, null, 2)}\n`,
    );
    console.log(`Baseline saved: ${path.relative(ROOT, BASELINE)}`);
  }
  process.exitCode = allFindings.length ? 1 : 0;
}

// Plain HTTPS GET, no browser and nothing typed: does `host` still answer as itself? Follows up to
// 5 redirects; a redirect to a different host is exactly what --hosts is for.
function fetchHost(host, redirectsLeft = 5) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: host,
        path: "/",
        headers: { "user-agent": "Mozilla/5.0 (compatible; ClotrSiteCheck/1.0)" },
        timeout: 10000,
        maxHeaderSize: 65536, // some sites (seen on Google's) send header blocks past Node's 16 KB default
      },
      (res) => {
        res.resume(); // discard the body; only the status and any redirect matter here
        const location = res.headers.location;
        if (location && res.statusCode >= 300 && res.statusCode < 400 && redirectsLeft > 0) {
          const next = new URL(location, `https://${host}/`);
          resolve(fetchHost(next.hostname, redirectsLeft - 1));
        } else {
          resolve({ finalHost: host, status: res.statusCode });
        }
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ error: String(err.message || err).slice(0, 120) }));
  });
}

async function checkHost(name, host) {
  const result = await fetchHost(host);
  return result.error ? { name, host, error: result.error } : { name, host, finalHost: result.finalHost };
}

// Every built-in host (ai-sites.json, all its matches) and every everyday host (EVERYDAY_SITES,
// all its matches), each host once, keeping the first site name that uses it.
function hostsToCheck() {
  const aiSites = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  const seen = new Map();
  for (const s of [...aiSites, ...Sites.EVERYDAY_SITES]) {
    for (const p of s.matches) {
      const host = hostOf(p);
      if (!seen.has(host)) seen.set(host, s.name);
    }
  }
  const only = onlyFilter();
  return [...seen]
    .map(([host, name]) => ({ name, host }))
    .filter((s) => !only || only.some((o) => s.host.includes(o) || s.name.toLowerCase().includes(o)));
}

async function runHostsCheck() {
  const hosts = hostsToCheck();
  const results = [];
  for (const h of hosts) {
    const r = await checkHost(h.name, h.host);
    results.push(r);
    console.log(
      `${h.host.padEnd(28)} ${r.error ? `error: ${r.error}` : r.finalHost === h.host ? "ok" : `moved to ${r.finalHost}`}`,
    );
  }
  const { moved, errors } = diffHosts(results);
  console.log("");
  if (moved.length) {
    console.log(`${moved.length} moved:`);
    for (const m of moved) console.log(`  ${m.name}: ${m.host} -> ${m.finalHost}`);
  }
  if (errors.length) {
    console.log(`${errors.length} didn't answer:`);
    for (const e of errors) console.log(`  ${e.name}: ${e.host} (${e.error})`);
  }
  if (!moved.length && !errors.length) console.log(`All ${hosts.length} hosts still answer as themselves.`);
  process.exitCode = moved.length || errors.length ? 1 : 0;
}

module.exports = { compareToBaseline, diffHosts, hostOf, looksLikeSignIn };

if (require.main === module) {
  if (flag("--hosts")) {
    runHostsCheck().catch((err) => {
      console.error(err);
      process.exitCode = 2;
    });
  } else {
    main().catch((err) => {
      console.error(err);
      process.exitCode = 2;
    });
  }
}
