// The helpers run.js and the files in ./checks share to drive a real browser with Clotr loaded. Each check types
// into a fake AI chat, clicks the dialog, or opens the popup, the way a person actually would.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --browser "C:/path/to/chrome.exe"
//
// This also runs in a Linux container, so CI and cloud sessions fall back to the Playwright Chromium build and add
// --no-sandbox when running as root.
//
// Nothing here touches the network. The browser gets a throwaway profile, never a real one, and every request is
// either answered by a fake page in ./pages or blocked outright.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "..");
const PAGES = path.join(__dirname, "pages");
const OUT = path.join(__dirname, "output");

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXT = path.resolve(argValue("--ext") || path.join(ROOT, "extension"));
// --all-on means every held-back feature is switched on (npm run test:e2e:all-on builds extension/ that way first,
// into dist/e2e-all-on). sections.js only runs a feature's own checks in this mode, since the default build hides
// the doors to them.
const ALL_ON = argv.includes("--all-on");
const HEADED = argv.includes("--headed");
// Quiet mode prints only failures, skips, and the summary, though the report file still lists every check. It's the
// default whenever the output isn't a real terminal, so a script or CI run stays short; --verbose turns it back on.
const QUIET = argv.includes("--quiet") || (!process.stdout.isTTY && !argv.includes("--verbose"));
const ONLY = (argValue("--only") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BROWSER = argValue("--browser") || process.env.CLOTR_BROWSER || findBrowser();

// Both keys are random-looking fakes. AWS's own docs use a well-known example key that Clotr deliberately ignores,
// so these aren't it.
const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
const KEY2 = "AKIAZ7Q3M9WX2KD5HB8R";
const DIALOG_WAIT = 2500; // Clotr's scan runs about 0.4 s after you stop typing, so this gives it plenty of room.
const QUIET_WAIT = 1200; // How long a check waits before it's confident no dialog is coming.

// Each fake site uses a real AI chat's address, so Clotr treats it as the real thing, but the page itself comes from
// ./pages and never touches the network.
const SITES = {
  chatgpt: {
    url: "https://chatgpt.com/",
    page: "textarea-chat.html",
    editor: `document.querySelector("#prompt-textarea")`,
    send: `document.querySelector('[data-testid="send-button"]')`,
  },
  claude: {
    url: "https://claude.ai/new",
    page: "richtext-chat.html",
    editor: `document.querySelector(".ProseMirror")`,
    send: `document.querySelector("#send")`,
  },
  notebook: {
    url: "https://notebook.google.com/notebook/test",
    page: "shadow-chat.html",
    editor: `document.querySelector("chat-box").shadowRoot.querySelector("textarea")`,
    send: `document.querySelector("chat-box").shadowRoot.querySelector("button")`,
  },
  perplexity: {
    url: "https://www.perplexity.ai/",
    page: "lexical-chat.html",
    editor: `document.querySelector("#ask-input")`,
    send: `document.querySelector("#send")`,
  },
  iconsend: {
    // send button without a "send" label (DeepSeek-style)
    url: "https://chat.deepseek.com/",
    page: "iconsend-chat.html",
    editor: `document.querySelector("#chat-input")`,
    send: `document.querySelector("#send")`,
  },
  copilot: {
    // Like Microsoft Copilot's editor, this keeps an invisible marker at the end of the box (CP1).
    url: "https://copilot.microsoft.com/",
    page: "marker-chat.html",
    editor: `document.querySelector("#m365-chat-editor-target-element")`,
    send: `document.querySelector("#send")`,
  },
  eager: {
    // The page handles Enter itself, through a window-level listener it registers early.
    url: "https://www.meta.ai/",
    page: "eager-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  keyup: {
    // Sends on Enter key-up instead of key-down.
    url: "https://pi.ai/",
    page: "keyup-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  asynced: {
    // Like Kimi's editor, applies an edit a moment later at its own caret instead of right away (KM1, KM2).
    url: "https://www.kimi.com/",
    page: "async-lexical-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  cancelling: {
    // Like Slate or CKEditor 5, this cancels every beforeinput event and edits its own model instead, so it never
    // fires an input event (BI1-BI3).
    url: "https://chat.qwen.ai/",
    page: "beforeinput-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  cancellingLexical: {
    // The same trick, but it only learns the selection from an async selectionchange event, the way Lexical does (BI2).
    url: "https://aistudio.google.com/",
    page: "beforeinput-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  history: {
    // Shows the conversation and brings it back a moment after a reload, the way a real AI chat does.
    url: "https://gemini.google.com/app/5d2c8a91f0b34e67",
    page: "history-chat.html",
    editor: `document.querySelector("#prompt")`,
    send: `document.querySelector("#composer button")`,
  },
  nochat: {
    // An AI site's page that has no chat box at all (HC2).
    url: "https://grok.com/settings",
    page: "no-chat.html",
  },
  hostile: {
    // Removes Clotr's UI from its DOM and scripts its own chat box.
    url: "https://chat.mistral.ai/",
    page: "hostile-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  login: {
    // An AI site's sign-in page. Clotr has to leave its fields alone here (LG1).
    url: "https://character.ai/login",
    page: "login-form.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  demo: {
    // A neutral, unbranded chat for store and README screenshots (--store).
    url: "https://poe.com/",
    page: "demo-chat.html",
    editor: `document.querySelector("#prompt")`,
    send: `document.querySelector("#send")`,
  },
  phone: {
    // An AI chat on a phone. It sends on a tap, on Enter, or on the new-line key a phone keyboard shows in place of Enter.
    url: "https://lmarena.ai/",
    page: "phone-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  phoneTextarea: {
    // The same page, but with a plain textarea, where that new-line key just breaks the line instead of sending.
    url: "https://lmarena.ai/?box=textarea",
    page: "phone-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  newtool: {
    url: "https://chat.newtool.ai/",
    page: "unknown-ai-chat.html",
    editor: `document.querySelector("textarea")`,
  },
  // An AI chat showing two answers to the command check: a lure asking the person to paste a "verify you're human"
  // command, and an honest installer beside it. The lure's command is defanged so it does nothing if it's ever run.
  command: {
    url: "https://huggingface.co/chat/",
    page: "command-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  ordinary: {
    url: "https://github.com/example/project/issues/42",
    page: "ordinary-site.html",
    editor: `document.querySelector("textarea")`,
  },
  // Email and chat apps only get Clotr once you switch the site on yourself.
  gmail: {
    url: "https://mail.google.com/mail/u/0/#inbox?compose=new",
    page: "email-compose.html",
    editor: `document.querySelector("#body")`,
    send: `document.querySelector("#send")`,
  },
  discord: {
    url: "https://discord.com/channels/1/2",
    page: "people-chat.html",
    editor: `document.querySelector("#box")`,
  },
  // A neutral, unbranded webmail and group chat, again for store and README screenshots (--store).
  demomail: {
    url: "https://outlook.live.com/mail/0/",
    page: "demo-mail.html",
    editor: `document.querySelector("#body")`,
    send: `document.querySelector("#send")`,
  },
  demogroup: {
    url: "https://app.slack.com/client/T1/C2",
    page: "demo-group-chat.html",
    editor: `document.querySelector("#box")`,
  },
};

// Nothing blocks out of the box. Most checks want to see the blocking dialog though, so they reset state as if the
// person had already chosen Block for every high-risk kind of data.
const HIGH_RISK = [
  "private_key",
  "aws_access_key",
  "github_token",
  "stripe_secret_key",
  "anthropic_key",
  "openai_key",
  "google_api_key",
  "slack_token",
  "password",
  "us_ssn",
  "credit_card",
];
const USER_BLOCKS_HIGH = Object.fromEntries(HIGH_RISK.map((id) => [id, "block"]));

// A first-time tip shows once per kind of data. Checks start with every tip already seen, so a notice looks the
// same no matter which check runs it; the GD checks turn the tips back on to test them.
require(path.join(__dirname, "..", "..", "extension", "patterns.js"));
const ALL_GUIDED = Object.fromEntries(globalThis.Clotr.PATTERNS.map((p) => [p.id, 1]));

// Every raw value a check types during the run. None of them should ever turn up in extension storage.
const TYPED_VALUES = new Set();

// ---------- Small utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// patience() says how many times slower this computer is right now than a quiet one, from 1 to 8. The browser shares
// its processors with everything else running, so a busy computer makes a scan, a dialog, or a setting on its way to
// a tab take longer. I time a small, fixed piece of work at the usual priority to catch that slowdown, then every
// wait below grows by the same factor. I only measure again every two seconds, and I keep the middle of three
// timings so one lucky run can't shorten a wait.
const PIECE_TEXT = Array.from(
  { length: 1500 },
  (_, i) => `Line ${i}: call 555-555-${1000 + i} or p${i}@example.com. `,
).join("");
const QUIET_PIECE_MS = 16; // What the piece takes on a quiet computer: 13 to 16 ms on a 2024 laptop.
let pieceRuns = 0;
// Runs regular expressions over text the way a real scan does, on a fresh text each time so a cached answer can't
// shorten it.
function piece() {
  let n = 0;
  for (let pass = 0; pass < 20; pass++) {
    const text = PIECE_TEXT + pieceRuns++;
    for (const m of text.matchAll(/\b\d{3}-\d{3}-\d{4}\b|[\w.]+@[\w.]+\.\w+/g)) n += m.index & 1;
    n += text.replace(/\d/g, "#").length;
  }
  return n;
}
let patienceAt = 0;
let patienceNow = 1;
function patience() {
  if (Date.now() - patienceAt < 2000) return patienceNow;
  const times = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    piece();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  patienceNow = Math.min(8, Math.max(1, times[1] / QUIET_PIECE_MS));
  patienceAt = Date.now();
  return patienceNow;
}

// Waits for something to settle, like a setting reaching a tab or a scan finishing after typing. `ms` is how long
// that takes on a quiet computer; a busy one gets more time through patience().
const settle = (ms) => sleep(ms * patience());

// Waits until fn() returns something truthy, for up to `timeout` ms on a quiet computer (longer on a busy one).
async function waitFor(fn, timeout, interval = 100) {
  const end = Date.now() + timeout * patience();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function findBrowser() {
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    `${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium`,
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Brave/Chrome/Edge found; pass --browser <path>");
  return found;
}

async function describeConsole(msg) {
  const parts = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => String(a))));
  return parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
}

// ---------- Browser & extension ----------

async function launch(ext = EXT, extraArgs = [], extraEnv = null) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-e2e-"));
  // Turn on Developer mode, the way anyone who used "Load unpacked" would have it. Chrome and Brave 153+ won't
  // reload an unpacked extension without it, and U2 tests exactly that reload.
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
  );
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: !HEADED,
    pipe: true,
    enableExtensions: Array.isArray(ext) ? ext : [ext], // An array here lets Extension check load fake extensions beside Clotr.
    userDataDir: profile,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}), // Linux Chrome reads its UI language from LANGUAGE.
    defaultViewport: { width: 1000, height: 700 },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging", // Older Chromium builds need this to load an extension over CDP.
      ...extraArgs,
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), // A container runs as root, so it needs this flag.
    ],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 15000 },
  );
  const swSession = await swTarget.createCDPSession();
  // Runs fn(...args) in the service worker. I use raw CDP here instead of puppeteer's own WebWorker wrapper, because
  // that wrapper's evaluate() hangs on some Chromium builds.
  const worker = {
    async evaluate(fn, ...args) {
      const expression = `(${fn})(...${JSON.stringify(args)})`;
      const r = await swSession.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails)
        throw new Error(`service worker: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
  };
  // The CDP session can attach before the extension's own APIs are bound, which once showed up as "chrome is not
  // defined" in CI on U2. Waiting here confirms the worker is really running before anything else uses it.
  const ready = await waitFor(
    () => worker.evaluate(() => typeof chrome === "object" && Boolean(chrome.runtime?.id)).catch(() => false),
    10000,
  );
  if (!ready) throw new Error("the extension's service worker never became ready");
  const ctx = { browser, profile, swTarget, worker, problems: [], version: await browser.version() };

  // Any error or warning the background logs to its console counts as a problem.
  await swSession.send("Runtime.enable");
  swSession.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error" || e.type === "warning") {
      ctx.problems.push(`service worker ${e.type}: ${e.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  swSession.on("Runtime.exceptionThrown", (e) =>
    ctx.problems.push(`service worker exception: ${e.exceptionDetails.text}`),
  );
  return ctx;
}

// A write goes through the background's own write queue, but only after I give the previous check's last events
// time to arrive. Without that wait, a late event could read the old history after this write lands, then write
// the old events straight back over it.
const store = {
  get: (ctx, keys) => ctx.worker.evaluate((k) => chrome.storage.local.get(k), keys ?? null),
  set: async (ctx, obj) => {
    await settle(200);
    await ctx.worker.evaluate((o) => enqueue(() => chrome.storage.local.set(o)), obj);
    // An open tab learns about a setting change by message, not by reading storage directly, so I give that
    // message a moment to arrive before a check starts typing into the tab.
    if (
      ["responses", "paused", "vault", "siteModes", "guided", "largeText", "bandage", "commandCheck"].some(
        (k) => k in obj,
      )
    )
      await settle(300);
  },
  events: async (ctx) => (await store.get(ctx, "events")).events || [],
};

// Widens the background's get-then-set window for one storage key, so a check can prove that a second write queued
// while the first is still in flight lands in order instead of getting lost or reviving stale data. I scope the
// delay to one key so the extension's own background chatter, like refreshing the toolbar, doesn't queue up behind it.
async function slowBackgroundReads(ctx, ms, key) {
  await ctx.worker.evaluate(
    (delay, k) => {
      globalThis.__realGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async (keys) => {
        const hit = keys === k || (Array.isArray(keys) && keys.includes(k));
        const result = await globalThis.__realGet(keys);
        if (hit) await new Promise((resolve) => setTimeout(resolve, delay));
        return result;
      };
    },
    ms,
    key,
  );
}
async function restoreBackgroundReads(ctx) {
  await ctx.worker.evaluate(() => {
    chrome.storage.local.get = globalThis.__realGet;
  });
}

async function resetState(ctx, responses = USER_BLOCKS_HIGH) {
  await store.set(ctx, {
    events: [],
    responses,
    paused: {},
    vault: [],
    siteModes: {},
    ignores: {},
    relaxDeclined: {},
    guided: ALL_GUIDED,
    // Bandage starts answered "no" on every site, so checks that don't care about it just see the plain warning.
    // The BN checks set their own state instead.
    bandage: Object.fromEntries(Object.values(SITES).map((s) => [new URL(s.url).hostname, false])),
  });
}

async function activeBadge(ctx) {
  return ctx.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return {
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  });
}

// ---------- Fake site pages ----------

// `viewport` has to be set before the page loads, since a phone's isMobile and hasTouch flags can't change on a
// page that's already open.
async function openSite(ctx, key, { viewport = null } = {}) {
  const site = SITES[key];
  const page = await ctx.browser.newPage();
  if (viewport) await page.setViewport(viewport);
  page.site = site;
  page.logs = [];
  page.on("console", async (msg) => {
    const text = await describeConsole(msg);
    page.logs.push(text);
    if (text.includes("[Clotr]") && (msg.type() === "error" || msg.type() === "warn")) {
      ctx.problems.push(`${key} page ${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => ctx.problems.push(`${key} page error: ${err.message}`));

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const match = Object.values(SITES).find(
      (s) => req.resourceType() === "document" && req.url().startsWith(new URL(s.url).origin + "/"),
    );
    if (match) {
      return req.respond({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fs.readFileSync(path.join(PAGES, match.page)),
      });
    }
    return req.abort(); // Nothing else, like a favicon request, ever leaves the machine.
  });

  await page.goto(site.url, { waitUntil: "load" });
  await page.bringToFront();
  // A tab runs on the default settings until the background answers it, so typing too early would test those
  // defaults instead of whatever the check just stored. I saw this happen under load before adding this wait.
  // A page where Clotr never runs won't log anything either, which is why this eventually gives up.
  await settle(300);
  await waitFor(() => page.logs.some((l) => l.startsWith("[Clotr] responses:")), 2700);
  return page;
}

const clotrActive = (page) => page.logs.some((l) => l.startsWith("[Clotr] active on"));

// Runs `expr` inside Clotr's own content-script world, which the page's own JS can't reach.
async function evalInClotr(page, expr) {
  page.cdp ??= await page.createCDPSession();
  if (!page.clotrWorld) {
    const { frameTree } = await page.cdp.send("Page.getFrameTree");
    const contexts = [];
    const onCtx = (e) => contexts.push(e.context);
    page.cdp.on("Runtime.executionContextCreated", onCtx);
    await page.cdp.send("Runtime.enable"); // This replays the contexts that already existed, but only the first time.
    page.cdp.off("Runtime.executionContextCreated", onCtx);
    page.clotrWorld = contexts.find(
      (c) =>
        c.origin.startsWith("chrome-extension://") &&
        c.auxData?.type === "isolated" &&
        c.auxData?.frameId === frameTree.frame.id,
    );
  }
  const world = page.clotrWorld; // This stays valid until the page navigates; checks open a fresh page instead.
  expect(world, "Clotr's content-script world not found");
  const { result, exceptionDetails } = await page.cdp.send("Runtime.evaluate", {
    expression: expr,
    contextId: world.id,
    returnByValue: true,
    awaitPromise: true,
  });
  expect(!exceptionDetails, `evaluating in Clotr's world failed: ${exceptionDetails?.exception?.description}`);
  return result.value;
}

// Simulates what an update reload leaves behind on a page: Clotr's copy there keeps running, but every extension
// API call now throws.
const ORPHAN_CLOTR = `(() => {
  const dead = () => { throw new Error("Extension context invalidated."); };
  globalThis.chrome = { runtime: { id: undefined, sendMessage: dead, getURL: dead, onMessage: { addListener() {} } },
    storage: { local: { get: dead, set: dead }, onChanged: { addListener() {} } } };
  return true;
})()`;

async function focusEditor(page) {
  await page.evaluate(`${page.site.editor}.focus()`);
}

// Inserts text the way a paste or IME commit does.
async function typeText(page, text) {
  TYPED_VALUES.add(text);
  await focusEditor(page);
  await page.keyboard.sendCharacter(text);
}

async function clearEditor(page) {
  await focusEditor(page);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await settle(600);
}

const editorText = (page) =>
  page.evaluate(`(e => e.tagName === "TEXTAREA" ? e.value : e.innerText)(${page.site.editor})`);
const sentMessages = (page) => page.evaluate(() => window.__sent.slice());

async function pressEnter(page) {
  await focusEditor(page);
  await page.keyboard.press("Enter");
}

async function clickSend(page) {
  const box = await page.evaluate(
    `(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })(${page.site.send})`,
  );
  await page.mouse.click(box.x, box.y);
}

// ---------- The Clotr dialog and warn notice (closed shadow roots, read through DevTools) ----------

const readDialog = (page) => readUI(page, "CLOTR-GUARD");
const readNotice = (page) => readUI(page, "CLOTR-NOTICE");
const readReloadPrompt = (page) => readUI(page, "CLOTR-RELOAD");

async function readUI(page, tag) {
  page.cdp ??= await page.createCDPSession();
  const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let host = null;
  (function find(n) {
    if (host) return;
    if (n.nodeName === tag) host = n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
  })(root);
  if (!host) return null;

  const texts = [];
  const buttons = [];
  let checkbox = null;
  const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(""));
  // DevTools lists an element's attributes as a flat [name, value, name, value, …] array, so I check every even
  // index for the name "hidden". That attribute marks a Bandage hotspot Clotr has put away, because its label went
  // off screen or something on the page covered it.
  const isHidden = (n) => (n.attributes || []).some((a, i) => i % 2 === 0 && a === "hidden");
  (function walk(n) {
    if (n.nodeName === "STYLE") return;
    if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
    if (n.nodeName === "BUTTON" || n.nodeName === "SUMMARY")
      buttons.push({ text: textOf(n).trim(), nodeId: n.nodeId, hidden: isHidden(n) });
    if (n.nodeName === "INPUT") checkbox = n.nodeId;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  })(host);
  return { text: texts.join(" | "), buttons, checkbox };
}

// Runs axe-core against one of Clotr's own UI elements, like the corner notice or the hover-to-peek bubble, even
// though it lives inside a closed shadow root. axe-core can't see into a closed shadow root on its own, since only
// code holding the exact reference `attachShadow()` returned can reach it, so I use CDP to get that reference
// instead. I clone the shadow root's content, style tag and all, into a plain element in the page's regular DOM and
// audit the clone there, then remove it again. That's close enough for structure and contrast, because Clotr's own
// shadow styles never depend on the host page's CSS.
async function auditShadow(page, tag) {
  page.cdp ??= await page.createCDPSession();
  const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let shadowRootNode = null;
  (function find(n) {
    if (shadowRootNode) return;
    if (n.nodeName === tag) shadowRootNode = (n.shadowRoots || [])[0];
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
  })(root);
  if (!shadowRootNode) return null;
  if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
  const { object } = await page.cdp.send("DOM.resolveNode", { nodeId: shadowRootNode.nodeId });
  const { result, exceptionDetails } = await page.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `async function() {
      const clone = document.createElement("div");
      for (const child of this.children) clone.appendChild(child.cloneNode(true));
      document.body.appendChild(clone);
      try {
        const r = await axe.run(clone, { resultTypes: ["violations"] });
        return r.violations.filter(v => v.impact === "serious" || v.impact === "critical")
          .map(v => v.id + " (" + v.nodes.length + "): " + v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", "));
      } finally {
        clone.remove();
      }
    }`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(!exceptionDetails, `axe on ${tag} failed: ${exceptionDetails?.exception?.description}`);
  return result.value;
}

// Runs fn inside the closed shadow root of one of Clotr's own elements (CLOTR-NOTICE, CLOTR-GUARD, and so on),
// with `this` set to that shadow root, and returns whatever fn returns. Returns null if that UI isn't on the page
// at all. I use this mostly to measure Clotr's own boxes.
async function inClotrUI(page, tag, fn) {
  page.cdp ??= await page.createCDPSession();
  const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let shadowRootNode = null;
  (function find(n) {
    if (shadowRootNode) return;
    if (n.nodeName === tag) shadowRootNode = (n.shadowRoots || [])[0];
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
  })(root);
  if (!shadowRootNode) return null;
  const { object } = await page.cdp.send("DOM.resolveNode", { nodeId: shadowRootNode.nodeId });
  const { result, exceptionDetails } = await page.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: fn.toString(),
    awaitPromise: true,
    returnByValue: true,
  });
  expect(!exceptionDetails, `in ${tag}: ${exceptionDetails?.exception?.description}`);
  return result.value;
}

// A finger's tap on one of Clotr's buttons, for a page that was opened with hasTouch.
async function tapNode(page, nodeId) {
  const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId });
  const q = model.border;
  await page.touchscreen.tap((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}

async function clickNode(page, nodeId) {
  const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId });
  const q = model.border;
  await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}

const waitForDialog = (page) => waitFor(() => readDialog(page), DIALOG_WAIT);
const waitForNotice = (page) => waitFor(() => readNotice(page), DIALOG_WAIT);

async function clickDialogButton(page, label, read = readDialog) {
  const dialog = await read(page);
  const btn = dialog?.buttons.find((b) => b.text === label);
  expect(btn, `dialog button "${label}" not found (dialog: ${dialog?.text})`);
  await clickNode(page, btn.nodeId);
  await settle(300);
}

async function expectNoDialog(page, why) {
  await settle(QUIET_WAIT);
  const dialog = await readDialog(page);
  expect(!dialog, `${why}, but the dialog appeared: ${dialog?.text}`);
}

async function expectNoUI(page, why) {
  await expectNoDialog(page, why);
  const notice = await readNotice(page);
  expect(!notice, `${why}, but the warn notice appeared: ${notice?.text}`);
}

// Sets a pattern's response the way the user does: the popup's Settings dropdown.
async function chooseResponse(ctx, patternId, value) {
  const popup = await openPopup(ctx);
  await popup.click("#tab-settings");
  const ok = await popup.evaluate(
    (id, v) => {
      const sel = document.querySelector(`select.resp[data-pattern="${id}"]`);
      if (!sel) return false;
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
      return true;
    },
    patternId,
    value,
  );
  expect(ok, `no response dropdown for ${patternId}`);
  await settle(300);
  await popup.close();
}

// ---------- Popup ----------

// Opens popup.html in its own tab at the popup's width, since chrome.action.openPopup() is unreliable headless.
// A scripted open wouldn't get the activeTab grant anyway, so the site card always reads "No web page in this tab"
// here; I check that card by hand instead.
async function openPopup(ctx) {
  const popup = await ctx.browser.newPage();
  popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
  await popup.setViewport({ width: 380, height: 700 });
  await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
  await popup.waitForSelector("#hero-value");
  await settle(400);
  return popup;
}

// Opens any extension page, like the vault, in its own tab.
async function openExtPage(ctx, file) {
  const page = await ctx.browser.newPage();
  page.on("pageerror", (err) => ctx.problems.push(`${file} error: ${err.message}`));
  await page.setViewport({ width: 700, height: 900 });
  await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/${file}`);
  await settle(400);
  return page;
}

// A popup is a small window, so I size the page to fit its content and pick the theme myself rather than rely on
// whatever the system is set to.
async function shot(popup, name, theme = "light") {
  await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  const height = await popup.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await popup.setViewport({ width: 380, height: Math.min(height, 1400) });
  await settle(400); // A new width redraws the mind map, and it takes a moment to settle into place.
  await popup.waitForFunction(() => !document.querySelector("svg[data-moving]"), { timeout: 2500 }).catch(() => {});
  await popup.screenshot({ path: path.join(OUT, name) });
}

// A picture at the exact size a person would see: the popup at its real size, 380 wide and at most 600 tall (the
// browser's own limit for a popup), or a page at a phone's width. `selector` crops the shot to one element.
async function shotAt(page, name, { width = 380, height = 600, theme = "light", selector = null } = {}) {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.setViewport({ width, height });
  await settle(300);
  const target = selector ? await page.$(selector) : null;
  await (target || page).screenshot({ path: path.join(OUT, name) });
}

// ---------- Test runner ----------

const results = [];

// A check throws this when the current browser can't run it under automation. It's reported as SKIP with the
// reason, never as PASS, and only for things I've already verified some other way.
class Skip extends Error {}

async function check(id, title, fn) {
  if (ONLY.length && !ONLY.some((p) => id.startsWith(p))) return;
  const line = `  ${id.padEnd(4)} ${title} … `;
  if (!QUIET) process.stdout.write(line);
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1); // Shows up in the report, since this is where CI minutes go.
  try {
    const note = await fn();
    results.push({ id, title, ok: true, note: note || "", secs: secs() });
    if (!QUIET) console.log("PASS" + (note ? `  (${note})` : ""));
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, title, ok: true, skipped: true, note: err.message, secs: secs() });
      console.log(`${QUIET ? line : ""}SKIP\n       → ${err.message}`);
      return;
    }
    results.push({ id, title, ok: false, note: err.message.split("\n")[0], secs: secs() });
    console.log(`${QUIET ? line : ""}FAIL\n       → ${err.message.split("\n")[0]}`);
  }
}

async function withSite(ctx, key, fn, options) {
  const page = await openSite(ctx, key, options);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// Builds synthetic history for dashboard checks, with known counts spread across several days.
function seedEvents() {
  const DAY = 86400000;
  const now = Date.now();
  const today = new Date(now).setHours(0, 0, 0, 0);
  // An event marked "today" has to stay today even if the run crosses midnight while it's going. C2 once failed in
  // CI this way, at 00:00:13.
  const ev = (daysAgo, action, type, name, severity, site, fp) => ({
    t: daysAgo === 0 ? Math.max(today, now - 60000) : now - daysAgo * DAY - 60000,
    site,
    type,
    name,
    severity,
    action,
    fp,
  });
  return [
    ev(20, "redacted", "email", "Email Address", "low", "chatgpt.com", "1000000000000001"),
    ev(20, "allowed", "phone_number", "Phone Number", "medium", "chatgpt.com", "1000000000000002"),
    ev(5, "redacted", "aws_access_key", "AWS Access Key", "high", "claude.ai", "aaaaaaaaaaaaaaaa"),
    ev(4, "redacted", "aws_access_key", "AWS Access Key", "high", "claude.ai", "aaaaaaaaaaaaaaaa"),
    ev(3, "allowed", "credit_card", "Credit Card Number", "high", "chatgpt.com", "1000000000000003"),
    ev(2, "suppressed", "email", "Email Address", "low", "notebook.google.com", "1000000000000004"),
    ev(1, "redacted", "phone_number", "Phone Number", "medium", "notebook.google.com", "1000000000000005"),
    ev(0, "redacted", "us_ssn", "US Social Security Number", "high", "chatgpt.com", "1000000000000006"),
    ev(0, "allowed", "email", "Email Address", "low", "gemini.google.com", "1000000000000007"),
  ].sort((a, b) => a.t - b.t);
}

function writeReport(ctx) {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  const skipNote = skipped ? ` (${skipped} skipped: see notes)` : "";
  const lines = [
    `# Clotr end-to-end run`,
    ``,
    `- When: ${new Date().toLocaleString()}`,
    `- Browser: ${BROWSER} (${ctx.version}, ${HEADED ? "headed" : "headless"})`,
    `- Result: **${results.length - failed.length}/${results.length} passed**${skipNote}`,
    ``,
    `| ID | Check | Result | Seconds | Notes |`,
    `|----|-------|--------|---------|-------|`,
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.skipped ? "SKIP" : r.ok ? "PASS" : "**FAIL**"} | ${r.secs} | ${r.note.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")} |`,
    ),
    ``,
    `Screenshots: ${fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith(".png"))
      .join(", ")}`,
  ];
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
  console.log(
    `\n${results.length - failed.length}/${results.length} passed${skipNote}. Report: ${path.relative(ROOT, path.join(OUT, "report.md"))}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

module.exports = {
  ALL_GUIDED,
  ALL_ON,
  BROWSER,
  DIALOG_WAIT,
  EXT,
  HEADED,
  HIGH_RISK,
  KEY,
  KEY2,
  ONLY,
  ORPHAN_CLOTR,
  OUT,
  PAGES,
  QUIET_WAIT,
  ROOT,
  SITES,
  Skip,
  TYPED_VALUES,
  USER_BLOCKS_HIGH,
  activeBadge,
  argValue,
  argv,
  auditShadow,
  check,
  chooseResponse,
  clearEditor,
  clickDialogButton,
  clickNode,
  clickSend,
  clotrActive,
  describeConsole,
  editorText,
  evalInClotr,
  expect,
  expectNoDialog,
  expectNoUI,
  findBrowser,
  focusEditor,
  fs,
  inClotrUI,
  launch,
  openExtPage,
  openPopup,
  openSite,
  os,
  path,
  patience,
  pressEnter,
  puppeteer,
  readDialog,
  readNotice,
  readReloadPrompt,
  readUI,
  resetState,
  restoreBackgroundReads,
  results,
  seedEvents,
  settle,
  sentMessages,
  shot,
  shotAt,
  slowBackgroundReads,
  sleep,
  store,
  tapNode,
  typeText,
  waitFor,
  waitForDialog,
  waitForNotice,
  withSite,
  writeReport,
};
