// Drives Firefox over its own automation channel, Marionette, for the checks that need Clotr's welcome page and
// popup. Puppeteer speaks WebDriver BiDi, which can't open or script a moz-extension:// page, and Firefox only
// allows one automation session at a time, so these checks get a separate headless Firefox with its own throwaway
// profile and Clotr installed as a temporary add-on. Its clicks and typing are real input, so Firefox still holds
// Clotr to the rule that it can only ask for a site in the same turn as the click that triggered the ask, the same
// as for a person. --remote-allow-system-access lets Marionette script both an extension's pages and the browser
// chrome itself, for the parts only a toolbar click can reach. Nothing here touches the network, since the add-on
// is just a local folder.
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

// Each message on the wire looks like "<length>:<JSON>". A reply is [1, id, error, result], and the very first
// message Firefox sends is its hello.
function connect(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > until) reject(new Error("Firefox's Marionette didn't answer"));
        else setTimeout(attempt, 150);
      });
      sock.once("connect", () => resolve(sock));
    };
    attempt();
  });
}

function channel(sock) {
  let buf = Buffer.alloc(0);
  let next = 0;
  let hello;
  const helloSeen = new Promise((r) => (hello = r));
  const waiting = new Map();
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const colon = buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(buf.subarray(0, colon).toString("ascii"));
      if (buf.length < colon + 1 + len) return;
      const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString("utf8"));
      buf = buf.subarray(colon + 1 + len);
      if (!Array.isArray(msg)) {
        hello(msg);
        continue;
      }
      const [, id, error, result] = msg;
      const w = waiting.get(id);
      if (!w) continue;
      waiting.delete(id);
      clearTimeout(w.timer);
      if (error) w.reject(new Error(`${w.name}: ${error.error}: ${error.message}`));
      else w.resolve(result);
    }
  });
  sock.on("close", () => {
    for (const w of waiting.values()) w.reject(new Error(`${w.name}: Firefox closed the connection`));
    waiting.clear();
  });
  // Gives each step up to a minute, since a computer busy with other builds can really be that slow, and each
  // check already has its own waits on top of this.
  const send = (name, params = {}, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${name}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      waiting.set(id, { name, resolve, reject, timer });
      const body = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
      sock.write(Buffer.concat([Buffer.from(`${body.length}:`, "ascii"), body]));
    });
  return { send, helloSeen };
}

// Launches a headless Firefox with Clotr installed from `extension`, an unpacked folder, and drives it over
// Marionette.
async function launchFirefox({ firefox, extension, prefs = {} }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-pages-"));
  const port = await freePort();
  const all = {
    "marionette.port": port,
    // Asking for a site still has to happen in the click's own turn, but with no prompt to answer, Firefox just
    // says yes.
    "extensions.webextOptionalPermissionPrompts": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.aboutwelcome.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "app.update.disabledForTesting": true,
    // Nothing here reaches the real network. Every address is pointed at a proxy that isn't there, so any page
    // fails immediately.
    "network.proxy.type": 1,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": 9,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": 9,
    "network.proxy.no_proxies_on": "",
    ...prefs,
  };
  fs.writeFileSync(
    path.join(profile, "user.js"),
    Object.entries(all)
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`)
      .join(""),
  );
  const proc = spawn(
    firefox,
    ["--headless", "--marionette", "--remote-allow-system-access", "--no-remote", "--profile", profile, "about:blank"],
    { stdio: "ignore" },
  );
  let sock;
  let send;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const gone = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => proc.exitCode !== null)]);
  // Stops every Firefox process still attached to this profile. Firefox's own pages run in separate processes
  // that can outlive the main one, so killing just the main process isn't enough.
  const stopAll = () => {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true });
    else proc.kill("SIGKILL");
  };
  // Never throws. It asks Firefox to quit, falls back to killing every process it started if that doesn't work,
  // and removes the profile once nothing still holds its files, which can take a moment on a busy computer.
  const close = async () => {
    try {
      await send?.("Marionette:Quit", { flags: ["eForceQuit"] }, 5000);
    } catch {
      /* already gone */
    }
    sock?.destroy();
    if (!(await gone(10000))) {
      stopAll();
      await gone(5000);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    } catch (err) {
      console.warn(`(a Firefox test profile was left in ${profile}: ${err.code || err.message})`);
    }
  };
  try {
    sock = await connect(port, 60000);
    const ch = channel(sock);
    send = ch.send;
    await ch.helloSeen;
    // Accepts self-signed certificates, the standard WebDriver way, so a throwaway local https fixture works
    // without trusting Firefox's own certificate store for a test that never leaves this computer.
    const { capabilities } = await send("WebDriver:NewSession", { capabilities: {} });
    await send("WebDriver:SetTimeouts", { script: 60000 });
    await send("Addon:Install", { path: extension, temporary: true });
    return { ...driver(send), close, version: `firefox/${capabilities.browserVersion}` };
  } catch (err) {
    await close();
    throw err;
  }
}

// This is what the checks use: it finds tabs by address, runs scripts in the current tab or the browser itself,
// and sends real clicks and typing to elements found by CSS selector.
function driver(send) {
  // `body` is the body of an async function, run in the current tab with `args`. Whatever it returns comes back
  // as JSON.
  const exec = async (body, ...args) => {
    const { value } = await send("WebDriver:ExecuteAsyncScript", {
      script: `const done = arguments[arguments.length - 1];
        (async (...args) => { ${body} })(...Array.from(arguments).slice(0, -1)).then(
          (x) => done(JSON.stringify({ ok: x === undefined ? null : x })),
          (e) => done(JSON.stringify({ error: String((e && e.message) || e) })),
        );`,
      args,
    });
    // A missing answer means the tab's page changed while the script was running, which happens when a new tab
    // moves from about:blank to its real page.
    if (typeof value !== "string")
      throw Object.assign(new Error("the page changed while a script ran"), { gone: true });
    const r = JSON.parse(value);
    if ("error" in r) throw new Error(r.error);
    return r.ok;
  };
  const element = async (css) => {
    const { value } = await send("WebDriver:FindElement", { using: "css selector", value: css });
    return Object.values(value)[0];
  };
  const tabs = async () => send("WebDriver:GetWindowHandles");
  return {
    send,
    exec,
    tabs,
    // Switches to a tab without bringing it to the front, so whichever tab is in front stays the one a toolbar
    // click would act on.
    switchTo: (handle) => send("WebDriver:SwitchToWindow", { handle, focus: false }),
    url: async () => (await send("WebDriver:GetCurrentURL")).value,
    // Waits for a tab whose address matches `test` to open, and returns its handle.
    async tabWhere(test, timeoutMs = 15000) {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(150)) {
        for (const h of await tabs()) {
          await send("WebDriver:SwitchToWindow", { handle: h, focus: false });
          if (test((await send("WebDriver:GetCurrentURL")).value)) return h;
        }
      }
      return null;
    },
    // Waits for the tab that `open` creates, such as an extension page's chrome.tabs.create, and returns its
    // handle once it exists.
    async newTab(open, timeoutMs = 15000) {
      const before = new Set(await tabs());
      await open();
      for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(150)) {
        const made = (await tabs()).find((h) => !before.has(h));
        if (made) return made;
      }
      return null;
    },
    // Runs privileged code in the browser itself, for the handful of things only a toolbar click can do.
    async inBrowser(script) {
      await send("Marionette:SetContext", { value: "chrome" });
      try {
        return (await send("WebDriver:ExecuteScript", { script, args: [] })).value;
      } finally {
        await send("Marionette:SetContext", { value: "content" });
      }
    },
    // Like `inBrowser`, but `body` is an async function's body, the same as `exec`. This is for privileged work
    // that has to wait on something, such as trusting a local https fixture's certificate before sending a tab
    // to it.
    async inBrowserAsync(body, ...args) {
      await send("Marionette:SetContext", { value: "chrome" });
      try {
        return await exec(body, ...args);
      } finally {
        await send("Marionette:SetContext", { value: "content" });
      }
    },
    click: async (css) => send("WebDriver:ElementClick", { id: await element(css) }),
    type: async (css, text) => send("WebDriver:ElementSendKeys", { id: await element(css), text }),
    // Polls `body`, the same as `exec`, until it returns something truthy, or returns the last answer once the
    // time runs out. If the page changed mid-script because it was still loading, this just asks again.
    async waitFor(body, timeoutMs = 10000, ...args) {
      let last;
      for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(150)) {
        try {
          last = await exec(body, ...args);
        } catch (err) {
          if (!err.gone) throw err;
          last = null;
        }
        if (last) return last;
      }
      return last;
    },
  };
}

module.exports = { launchFirefox };
