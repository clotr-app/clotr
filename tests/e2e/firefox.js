// A smoke test for the Firefox build, part of every npm run check. It packages the extension, installs it as a
// temporary add-on, and checks that Clotr starts on an AI chat, warns about a key, and never blocks sending.
//
// Usage: npm run test:firefox                     (fails if no Firefox is found)
//        npm run test:firefox -- --if-installed   (used by npm run check: skips quietly if there's no Firefox)
//        npm run test:firefox -- --only FF8,FF11  --browser <path to firefox.exe>
//        (no Firefox installed? npx @puppeteer/browsers install firefox@stable --path <dir>)
//
// Firefox's automation can't see inside Clotr's closed shadow roots, so most checks here look at the warning's host
// element instead and save a screenshot of what a person would actually see. FF5 through FF8 attach files, since
// Firefox keeps a page's uploaded files away from content scripts in a way Chrome doesn't, so that path needs its
// own coverage. FF9 through FF20 drive Clotr's welcome page and popup with real clicks over Marionette, because
// Firefox only lets an add-on ask for a site in the same click that triggered the ask, and the popup broke that
// rule once. FF19 and FF20 open the real toolbar popup, since only there can Clotr's panel cover Firefox's
// question. FF16 also needs a real https page, since Tourniquet's storage only exists in an extension page's own
// world and has to be set from a moz-extension:// tab that the other checks can't open.
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");
const puppeteer = require("puppeteer-core");
const fx = require("../../tools/make-picture-fixtures.js");
const { launchFirefox } = require("./marionette.js");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "output");
const CHECK_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 10_000;
const FIREFOX_ENV = { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" };
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
// Picks a Firefox to use: --browser first, then CLOTR_FIREFOX, then any installed copy, then the newest portable
// one under %LOCALAPPDATA%\Clotr\browsers. Install a portable one once with
// npx @puppeteer/browsers install firefox@stable --path %LOCALAPPDATA%\Clotr\browsers, and a local run needs no path.
function findFirefox() {
  const given = arg("--browser") || process.env.CLOTR_FIREFOX;
  if (given) return given;
  const installed = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Mozilla Firefox", "firefox.exe"),
    "/usr/bin/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
  ].find((p) => fs.existsSync(p));
  if (installed) return installed;
  const portable = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"),
    "Clotr",
    "browsers",
    "firefox",
  );
  try {
    const newest = fs.readdirSync(portable).sort().reverse();
    for (const dir of newest) {
      const exe = ["core/firefox.exe", "firefox/firefox", "core/firefox"]
        .map((x) => path.join(portable, dir, x))
        .find((p) => fs.existsSync(p));
      if (exe) return exe;
    }
  } catch {
    /* none downloaded */
  }
  return null;
}
const FIREFOX = findFirefox();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = ["AKIA", "4HPQ7XZ2", "R6TWLJ3N"].join("");

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs} ms`);
      err.code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function killFirefoxTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function closeFirefox(browser, timeoutMs = CLOSE_TIMEOUT_MS) {
  if (!browser) return null;
  try {
    await withTimeout(
      Promise.resolve().then(() => browser.close()),
      timeoutMs,
      "Firefox close",
    );
    return null;
  } catch (err) {
    killFirefoxTree(browser.process());
    return err;
  }
}

// A .docx file is just a zip with a word/document.xml entry inside, so this builds one by hand, deflated the way
// Word itself stores it.
function docx(paragraphs) {
  const name = Buffer.from("word/document.xml");
  const xml = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  const data = Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${xml}</w:body></w:document>`);
  const body = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(zlib.crc32(data), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const dir = Buffer.alloc(46); // the zip's central directory, which lists what the archive holds
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(zlib.crc32(data), 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, dir, name, end]);
}

const INSTALL =
  "install it, pass --browser <firefox.exe>, or run npx @puppeteer/browsers install firefox@stable --path %LOCALAPPDATA%\\Clotr\\browsers";

// Runs every check, unless --only names specific ones to run instead (e.g. --only FF8,FF11).
const ONLY = arg("--only")
  ?.split(",")
  .map((id) => id.trim().toUpperCase());
const wanted = (id) => !ONLY || ONLY.includes(id.toUpperCase());
// Click the visible label, not the small checkbox inside it. Marionette cannot reliably scroll
// that checkbox into view in headless Firefox, while a person can click the whole app row.
const offerLabel = (app) => `#everyday-offer label.ev-app:has(input[value="${app}"])`;
async function clickOfferApp(ff, app) {
  const label = offerLabel(app);
  await ff.exec(`document.querySelector(${JSON.stringify(label)})?.scrollIntoView({ block: "center" });`);
  await ff.click(label);
}

async function main() {
  const t0 = Date.now();
  const firefox = FIREFOX && fs.existsSync(FIREFOX) ? FIREFOX : null;
  if (!firefox) {
    const why = FIREFOX ? `the Firefox named isn't there (${FIREFOX})` : "no Firefox found on this computer";
    // With --if-installed, npm run check still finishes on a computer with no Firefox, but it says so instead of
    // staying quiet about it.
    if (process.argv.includes("--if-installed")) {
      console.log(
        `Clotr Firefox smoke test … SKIPPED: ${why}, so nothing was checked in Firefox.\n  To check it: ${INSTALL}`,
      );
      return;
    }
    throw new Error(`${why}: ${INSTALL}`);
  }
  execFileSync(process.execPath, [path.join(ROOT, "tools", "package.js"), "--firefox"], { stdio: "ignore" });
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
  const zip = path.join(ROOT, "dist", `clotr-${version}-firefox.zip`);
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-"));
  const files = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-files-"));
  let browser;
  try {
    const tar =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "unzip";
    execFileSync(tar, process.platform === "win32" ? ["-xf", zip, "-C", ext] : ["-q", zip, "-d", ext]);
    fs.mkdirSync(OUT, { recursive: true });
    browser = await puppeteer.launch({
      browser: "firefox",
      executablePath: firefox,
      headless: true,
      timeout: 30_000,
      env: FIREFOX_ENV,
    });
  } catch (err) {
    // Nothing below gets a chance to close Firefox or remove these if setup fails partway through.
    try {
      await closeFirefox(browser);
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
      fs.rmSync(files, { recursive: true, force: true });
    }
    throw err;
  }
  const results = [];
  let checksAborted = false;
  const check = async (id, name, fn) => {
    if (!wanted(id) || checksAborted) return;
    try {
      await withTimeout(Promise.resolve().then(fn), CHECK_TIMEOUT_MS, id);
      results.push(`  ${id} ${name} … PASS`);
    } catch (err) {
      results.push(`  ${id} ${name} … FAIL\n       → ${err.message}`);
      if (err.code === "ETIMEDOUT") checksAborted = true;
    }
  };
  try {
    const browserVersion = await withTimeout(browser.version(), 15_000, "Firefox version");
    console.log(`Clotr Firefox smoke test\n  browser: ${browserVersion}\n  build:   ${path.basename(zip)}\n`);
    await withTimeout(browser.installExtension(ext), 30_000, "Firefox extension install");
    // Clotr logs what it found in each attached file, naming kinds of data only, never a value or a file name.
    // This collects that log, since Firefox automation can't read the closed warning directly.
    const findings = [];
    // Opens a practice chat at chatgpt.com, with every other network request blocked.
    const openChat = async () => {
      const tab = await browser.newPage();
      await tab.setRequestInterception(true);
      tab.on("request", (req) => {
        if (req.url().startsWith("https://chatgpt.com/")) {
          return req.respond({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: fs.readFileSync(path.join(__dirname, "pages", "textarea-chat.html")),
          });
        }
        return req.abort();
      });
      tab.on("console", (m) => {
        if (!m.text().startsWith("[Clotr] attached file")) return;
        const [, , ending, , kinds] = m.args();
        findings.push(Promise.all([ending?.jsonValue(), kinds?.jsonValue()]).catch(() => []));
      });
      await tab.goto("https://chatgpt.com/", { waitUntil: "load" });
      await sleep(1500);
      return tab;
    };
    // Attaches a file in its own chat tab, then waits until the log reports every kind in `kinds` and the warning
    // appears on the page. Throws with what it actually found if that never happens.
    const attachExpecting = async (name, bytes, kinds, shot) => {
      const tab = await openChat();
      try {
        const file = path.join(files, name);
        fs.writeFileSync(file, bytes);
        const ending = path.extname(name).toLowerCase();
        const from = findings.length;
        await (await tab.$("#attach")).uploadFile(file);
        let found = [];
        let host = false;
        for (let t = 0; t < 6000 && !(host && kinds.every((k) => found.includes(k))); t += 250) {
          await sleep(250);
          found = (await Promise.all(findings.slice(from)))
            .filter(([e]) => e === ending)
            .flatMap(([, ids]) => ids || []);
          host = await tab.evaluate(() => Boolean(document.querySelector("clotr-notice")));
        }
        if (shot) await tab.screenshot({ path: path.join(OUT, shot) });
        const missing = kinds.filter((k) => !found.includes(k));
        if (missing.length || !host) {
          throw new Error(`found ${JSON.stringify(found)}, missing ${JSON.stringify(missing)}, warning shown: ${host}`);
        }
      } finally {
        await tab.close();
      }
    };
    const page = await openChat();

    await check("FF1", "Clotr starts on an AI chat and warns about a key (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type(`my key is ${KEY} `);
      // Polls instead of waiting a fixed time, since a cold Firefox start can take longer than Clotr's usual
      // 0.4 s scan.
      let host = false;
      for (let t = 0; t < 5000 && !host; t += 250) {
        await sleep(250);
        host = await page.evaluate(() => Boolean(document.querySelector("clotr-notice")));
      }
      await page.screenshot({ path: path.join(OUT, "firefox-notice.png") });
      if (!host) throw new Error("no warning appeared");
    });
    await check("FF1b", "Clot this leak replaces the key in the chat box (Firefox)", async () => {
      // By keyboard, so it doesn't depend on fonts or layout: Tab until focus enters Clotr's
      // warning, which lands on "Clot this leak", then Enter.
      let inside = false;
      for (let i = 0; i < 8 && !inside; i++) {
        await page.keyboard.press("Tab");
        inside = await page.evaluate(() => document.activeElement?.tagName === "CLOTR-NOTICE");
      }
      if (!inside) throw new Error("couldn't reach the warning with Tab");
      // Enter is ignored for 0.6 s after focus lands in a warning: wait well past it (a busy computer
      // runs the warning's focus handler late, and npm run check runs this while other work goes on).
      await sleep(1200);
      await page.keyboard.press("Enter");
      await sleep(500);
      const text = await page.$eval("#prompt-textarea", (t) => t.value);
      if (!text.includes("[REDACTED AWS ACCESS KEY]") || text.includes("AKIA4HPQ")) {
        throw new Error(`box: ${JSON.stringify(text)}`);
      }
    });
    await check("FF2", "Warn never blocks: Enter sends (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type("call me at 555-555-0123 ");
      await sleep(2000);
      await page.keyboard.press("Enter");
      await sleep(500);
      const sent = await page.evaluate(() => window.__sent.length);
      if (sent !== 1) throw new Error(`sent ${sent} messages`);
    });
    // A VIN pasted on its own, with no label and no vehicle word, showed nothing in Firefox's practice chat until
    // this was added. Typed with real key events: text a page's own script inserts (execCommand) no longer counts as
    // the person's (the 1.2.1 scan's page-events finding), so a scripted insert can't stand in for a paste here.
    // Firefox automation can't read the closed warning, so Clot this leak tells what the warning was about: the box
    // then names the VIN's kind.
    await check("FFVIN1", "A VIN pasted on its own warns; Clot this leak covers it as a VIN (Firefox)", async () => {
      const tab = await openChat();
      try {
        await tab.focus("#prompt-textarea");
        await tab.keyboard.type("1HGCM82633A004352");
        let host = false;
        for (let t = 0; t < 5000 && !host; t += 250) {
          await sleep(250);
          host = await tab.evaluate(() => Boolean(document.querySelector("clotr-notice")));
        }
        await tab.screenshot({ path: path.join(OUT, "firefox-vin-alone.png") });
        if (!host) throw new Error("no warning appeared");
        let inside = false;
        for (let i = 0; i < 8 && !inside; i++) {
          await tab.keyboard.press("Tab");
          inside = await tab.evaluate(() => document.activeElement?.tagName === "CLOTR-NOTICE");
        }
        if (!inside) throw new Error("couldn't reach the warning with Tab");
        await sleep(1200); // past the 0.6 s Enter guard, with room for a busy computer
        await tab.keyboard.press("Enter");
        let text = "";
        for (let t = 0; t < 3000 && !text.includes("[REDACTED"); t += 250) {
          await sleep(250);
          text = await tab.$eval("#prompt-textarea", (el) => el.value);
        }
        if (text !== "[REDACTED VEHICLE IDENTIFICATION NUMBER]") throw new Error(`box: ${JSON.stringify(text)}`);
      } finally {
        await tab.close();
      }
    });
    // A lone photo (nothing else attached alongside it) is rebuildable, so Clotr takes its place out before the
    // site ever sees the file, instead of warning after the fact the way scanFiles does for text files (FF6-8):
    // that's "removed the place from attached pictures", not "attached file … contains", so this doesn't reuse
    // attachExpecting's log-matching (chromium's PIC14 covers the same behaviour with shadow-DOM access).
    await check(
      "FF5",
      "A photo with the place it was taken saved inside: the place comes out before the site gets it (Firefox)",
      async () => {
        const tab = await openChat();
        try {
          const file = path.join(files, "IMG_FF5.jpg");
          fs.writeFileSync(file, fx.jpegWithGps(fx.PLACES.liberty));
          let removed = false;
          const onConsole = (m) => {
            if (m.text().startsWith("[Clotr] removed the place from attached pictures")) removed = true;
          };
          tab.on("console", onConsole);
          await (await tab.$("#attach")).uploadFile(file);
          let host = false;
          for (let t = 0; t < 6000 && !(host && removed); t += 250) {
            await sleep(250);
            host = await tab.evaluate(() => Boolean(document.querySelector("clotr-notice")));
          }
          await tab.screenshot({ path: path.join(OUT, "firefox-photo-place.png") });
          if (!removed || !host) throw new Error(`place removed: ${removed}, warning shown: ${host}`);
        } finally {
          await tab.close();
        }
      },
    );
    await check("FF6", "A PDF with text: the key and the phone number in it are found (Firefox)", () =>
      attachExpecting(
        "statement FF6.pdf",
        fx.pdf({ scanned: false, compressed: true, text: `Deploy key ${KEY}, call 555-555-0123` }),
        ["aws_access_key", "phone_number"],
      ),
    );
    await check("FF7", "A Word document (.docx): the key and the phone number in it are found (Firefox)", () =>
      attachExpecting("resume FF7.docx", docx(["Jane Example", `deploy key ${KEY}`, "Call me: 555-555-0123"]), [
        "aws_access_key",
        "phone_number",
      ]),
    );
    await check("FF8", "A text file (.txt): the key and the phone number in it are found (Firefox)", () =>
      attachExpecting("notes FF8.txt", Buffer.from(`Notes\ndeploy key ${KEY}\ncall 555-555-0123\n`), [
        "aws_access_key",
        "phone_number",
      ]),
    );
    await check("FF3", "An ordinary site stays untouched (Firefox)", async () => {
      const other = await browser.newPage();
      await other.goto("about:blank");
      const host = await other.evaluate(() => Boolean(document.querySelector("clotr-notice")));
      await other.close();
      if (host) throw new Error("Clotr UI on a non-AI page");
    });
  } finally {
    try {
      const closeError = await closeFirefox(browser);
      if (closeError) {
        checksAborted = true;
        results.push(`  Firefox cleanup … FAIL\n       → ${closeError.message}`);
      }
    } finally {
      fs.rmSync(files, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  try {
    if (!checksAborted) await ownPageChecks(check, firefox, ext);
  } catch (err) {
    results.push(`  FF9-FF18 Clotr's own pages … FAIL\n       → couldn't run: ${err.message}`);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.includes("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed (${((Date.now() - t0) / 1000).toFixed(0)} s).`);
  process.exitCode = failed ? 1 : 0;
}

// FF9 through FF20 cover Clotr's own pages: the welcome page it opens on install, and the popup. They run in a
// separate Firefox driven over Marionette with real clicks and typing. `ext` is the unpacked Firefox build.
const OWN_PAGES = [
  "FF4",
  "FF9",
  "FF10",
  "FF11",
  "FF12",
  "FF13",
  "FF14",
  "FF15",
  "FF16",
  "FFMAIL1",
  "FF17",
  "FF18",
  "FF19",
  "FF20",
];
const SITE = "https://chat.newtool.example/"; // an AI chat Clotr doesn't recognize; this suite never touches the network

// FF15 needs a page that actually loads over https, since the popup only calls a site spotted once it's checked a
// live page's title and chat box, and a blocked address like SITE above never gets that far. A throwaway local
// server stands in for that page. Its self-signed certificate is fine, since launchFirefox's session already
// accepts insecure certs, the standard WebDriver way to test a local https fixture.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
// `host` is the name the browser will use for the fixture. FF15 passes "localhost" so its site doesn't collide
// with the 127.0.0.1 that FF16 builds into its own run.
async function startHttpsFixture(html, host = "127.0.0.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-cert-"));
  let server;
  let usePort;
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=${host === "localhost" ? "DNS" : "IP"}:${host}`,
    ]);
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    usePort = await freePort();
    await new Promise((resolve) => server.listen(usePort, "127.0.0.1", resolve));
  } catch (err) {
    // close() below never gets called if setup itself fails, so this has to remove its own cert folder here.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    url: `https://${host}:${usePort}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
const AI_CHAT_HTML = `<!doctype html><html><head><title>AI practice chat</title></head><body>
    <textarea placeholder="Ask anything" style="width:300px;height:80px;"></textarea>
    <button aria-label="Send">Send</button>
  </body></html>`;
// Trusts a fixture's self-signed certificate, but only for this Marionette session. Raw Marionette has no
// WebDriver capability for that, so this does it from a chrome-privileged script. Firefox 159 does not allow async
// WebDriver scripts in chrome context, so the script starts an async request and Marionette polls its result.
async function trustFixtureCert(ff, url) {
  const key = `__clotrCertTrust${Date.now()}`;
  await ff.inBrowser(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win[${JSON.stringify(key)}] = null;
    const req = new XMLHttpRequest();
    req.open("GET", ${JSON.stringify(url)}, true);
    req.onerror = () => {
      try {
        const secInfo = req.channel.securityInfo.QueryInterface(Ci.nsITransportSecurityInfo);
        const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
        const bits =
          Ci.nsICertOverrideService.ERROR_UNTRUSTED |
          Ci.nsICertOverrideService.ERROR_MISMATCH |
          Ci.nsICertOverrideService.ERROR_TIME;
        overrides.rememberValidityOverride(
          ${JSON.stringify(new URL(url).hostname)},
          ${new URL(url).port},
          {},
          secInfo.serverCert,
          bits,
          true,
        );
        win[${JSON.stringify(key)}] = true;
      } catch (e) {
        win[${JSON.stringify(key)}] = String((e && e.message) || e);
      }
    };
    req.onload = () => { win[${JSON.stringify(key)}] = true; };
    req.send(null);
    return true;`);
  let trusted = null;
  for (const until = Date.now() + 10000; Date.now() < until; await sleep(150)) {
    trusted = await ff.inBrowser(
      `return Services.wm.getMostRecentWindow("navigator:browser")[${JSON.stringify(key)}];`,
    );
    if (trusted !== null) break;
  }
  await ff.inBrowser(`delete Services.wm.getMostRecentWindow("navigator:browser")[${JSON.stringify(key)}];`);
  if (trusted !== true) throw new Error(`couldn't trust the fixture's certificate: ${trusted || "request timed out"}`);
}

async function clickShadowButtonByLabel(ff, hostSelector, label) {
  const host = Object.values(
    (
      await ff.send("WebDriver:FindElement", {
        using: "css selector",
        value: hostSelector,
      })
    ).value,
  )[0];
  const shadowRoot = Object.values((await ff.send("WebDriver:GetShadowRoot", { id: host })).value)[0];
  const buttons = await ff.send("WebDriver:FindElementsFromShadowRoot", {
    shadowRoot,
    using: "css selector",
    value: "button",
  });
  let button;
  for (const item of buttons) {
    const id = Object.values(item)[0];
    const text = (await ff.send("WebDriver:GetElementText", { id })).value;
    if (text.trim().replace(/\s+/g, " ") === label) button = id;
  }
  if (!button) throw new Error(`no button labeled ${JSON.stringify(label)} inside ${hostSelector}`);
  await ff.send("WebDriver:ElementClick", { id: button });
}

// Answers Firefox's own question about a site for the Clotr page whose address ends in `page`, the way a person
// clicks Allow, and says whether Firefox asked at all within `ms`. Only FF17 and FF18 see a question, since they
// switch Firefox's prompts back on. Earlier checks can leave another popup tab open, so every tab at that
// address is looked at.
async function answerPrompt(ff, page, ms) {
  const script = `
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const n = win.gBrowser.tabs
      .filter((t) => t.linkedBrowser.currentURI.spec.endsWith(${JSON.stringify(page)}))
      .map((t) => win.PopupNotifications.getNotification("addon-webext-permissions", t.linkedBrowser))
      .find(Boolean);
    if (!n) return false;
    n.mainAction.callback();
    n.remove();
    return true;`;
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) {
    if (await ff.inBrowser(script)) return true;
  }
  return false;
}

// The sites FF17 and FF18 switch on and off, and the broad origin "Everywhere I type" asks for.
const SWITCHED = [
  "https://mail.google.com/*",
  "https://outlook.live.com/*",
  "https://outlook.office.com/*",
  "https://www.google.com/*",
  "https://duckduckgo.com/*",
  "https://widget.intercom.io/*",
  "https://discord.com/*",
  "https://*/*",
];

async function ownPageChecks(check, firefox, ext) {
  if (!OWN_PAGES.some(wanted)) return;
  const manifestFile = path.join(ext, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const addon = manifest.browser_specific_settings.gecko.id;
  // FF16 needs Clotr to treat a local https fixture the way it treats a built-in AI site. A host permission
  // pattern never names a port, so it matches the fixture whichever free port it happens to get. Only this run's
  // throwaway build gets the extra permission, never the real manifest.
  if (wanted("FF4") || wanted("FF16") || wanted("FFMAIL1")) {
    manifest.content_scripts[0].matches.push("https://127.0.0.1/*");
    manifest.host_permissions.push("https://127.0.0.1/*");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  const ff = await launchFirefox({
    firefox,
    extension: ext,
    // The fixtures listen on 127.0.0.1 only, so "localhost" mustn't try ::1 first.
    prefs: { "network.proxy.no_proxies_on": "127.0.0.1, localhost", "network.dns.disableIPv6": true },
  });
  try {
    const welcome = await ff.tabWhere((u) => /^moz-extension:\/\/[^/]+\/vault\.html\?welcome=1$/.test(u));
    const onWelcome = async () => {
      if (!welcome) throw new Error("Clotr didn't open its welcome page when it was installed");
      await ff.switchTo(welcome);
      const ready = await ff.waitFor(
        'return document.querySelector("#where-offer") && !document.querySelector("#where-offer").hidden ? true : null;',
      );
      if (!ready) throw new Error("the welcome page's site choices didn't load");
      // The app rows live under "Pick sites one by one instead" on the welcome page.
      if (!(await ff.exec('return document.querySelector("#where-pick-sites").open;'))) {
        await ff.click("#where-pick-sites summary");
      }
    };

    await check("FF4", "Bandage: cover a phone number and show the peek bubble (Firefox)", async () => {
      const fixture = await startHttpsFixture(
        fs.readFileSync(path.join(__dirname, "pages", "textarea-chat.html"), "utf8"),
      );
      try {
        await trustFixtureCert(ff, fixture.url);
        await onWelcome();
        await ff.exec('await chrome.storage.local.set({ siteKinds: { "127.0.0.1": "ai" } });');
        const tab = await ff.newTab(() =>
          ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(fixture.url)} });`),
        );
        if (!tab) throw new Error("the fixture chat's tab didn't open");
        await ff.switchTo(tab);
        const loaded = await ff.waitFor('return document.querySelector("#prompt-textarea") ? true : null;', 10000);
        if (!loaded) throw new Error("the fixture chat didn't load");
        await ff.click("#prompt-textarea");
        await ff.type("#prompt-textarea", "call me at 555-555-0123 ");
        const host = await ff.waitFor('return Boolean(document.querySelector("clotr-notice")) || null;', 8000);
        if (!host) throw new Error("no notice for the Bandage offer");

        await ff.exec('document.querySelector("#composer button").focus();');
        await ff.send("WebDriver:PerformActions", {
          actions: [
            {
              type: "key",
              id: "keyboard",
              actions: [
                { type: "keyDown", value: "\uE004" },
                { type: "keyUp", value: "\uE004" },
              ],
            },
          ],
        });
        const inside = await ff.waitFor('return document.activeElement?.tagName === "CLOTR-NOTICE" || null;', 3000);
        if (!inside) throw new Error("couldn't reach the notice with Tab");
        await clickShadowButtonByLabel(ff, "clotr-notice", "Yes, use cover names");

        const covered = await ff.waitFor(
          'const text = document.querySelector("#prompt-textarea")?.value || ""; return text.includes("[Phone 1]") ? text : null;',
          5000,
        );
        if (!covered) throw new Error('box after "Yes, use cover names" did not show [Phone 1]');
        await ff.type("#prompt-textarea", "\uE007");
        const sent = await ff.waitFor("return window.__sent?.length === 1 || null;", 3000);
        if (!sent) throw new Error("the covered message was not sent");
        await ff.exec('window.__reply("Sure, I\'ll call [Phone 1] soon.");');
        const spots = await ff.waitFor('return Boolean(document.querySelector("clotr-spots")) || null;', 8000);
        if (!spots) throw new Error("no hotspot over the label");
        const point = await ff.exec(`
          const text = document.querySelector(".reply")?.firstChild;
          if (!text) return null;
          const range = document.createRange();
          const start = text.nodeValue.indexOf("[Phone 1]");
          if (start < 0) return null;
          range.setStart(text, start);
          range.setEnd(text, start + "[Phone 1]".length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`);
        if (!point) throw new Error("no point for the cover name");
        await ff.send("WebDriver:PerformActions", {
          actions: [
            {
              type: "pointer",
              id: "mouse",
              parameters: { pointerType: "mouse" },
              actions: [
                { type: "pointerMove", duration: 0, x: point.x - 60, y: point.y - 30 },
                { type: "pointerMove", duration: 250, x: point.x, y: point.y },
              ],
            },
          ],
        });
        const peek = await ff.waitFor('return Boolean(document.querySelector("clotr-peek")) || null;', 3000);
        if (!peek) throw new Error("no peek bubble appeared");
      } finally {
        await fixture.close();
      }
    });

    await check(
      "FF9",
      "The welcome page opens when Clotr is installed, and its practice box warns (Firefox)",
      async () => {
        await onWelcome();
        // The page names itself once its script has run.
        const title = await ff.waitFor('return document.title === "Welcome to Clotr" ? document.title : null;');
        if (!title) throw new Error(`the page's title: ${JSON.stringify(await ff.exec("return document.title;"))}`);
        await ff.type("#try", `my key is ${KEY}`);
        const said = await ff.waitFor(
          'const t = document.querySelector("#try-result").innerText; return /AWS Access Key/.test(t) ? t : null;',
        );
        if (!said) throw new Error("the practice box found nothing");
        if (said.includes(KEY)) throw new Error("the practice box showed the whole key");
      },
    );

    await check(
      "FF10",
      "Welcome page: Switch on Gmail asks Firefox in the click's own turn, and Gmail is on (Firefox)",
      async () => {
        await onWelcome();
        // The card fills in once it knows which apps are already on.
        const shown = await ff.waitFor(
          'return !document.querySelector("#everyday-offer").hidden && Boolean(document.querySelector(\'#everyday-offer input[value="Gmail"]\'));',
        );
        if (!shown) throw new Error("the email and chat apps card didn't show");
        await clickOfferApp(ff, "Gmail");
        await ff.click("#ev-go");
        const said = await ff.waitFor(
          'return (await chrome.permissions.contains({ origins: ["https://mail.google.com/*"] })) ? document.querySelector("#ev-status").textContent : null;',
        );
        if (!said) {
          throw new Error(
            `Gmail isn't on (the card says ${JSON.stringify(await ff.exec('return document.querySelector("#ev-status").textContent;'))})`,
          );
        }
      },
    );

    await check(
      "FF13",
      "Welcome page: Gmail+Discord already on, then a No on Slack+WhatsApp still lets them be unticked (Firefox)",
      async () => {
        await onWelcome();
        const shown = await ff.waitFor(
          'return !document.querySelector("#everyday-offer").hidden && Boolean(document.querySelector(\'#everyday-offer input[value="Slack"]\'));',
        );
        if (!shown) throw new Error("the email and chat apps card didn't show");
        // Switches on Gmail and Discord first, in the same session. Firefox auto-grants permissions here, so this
        // stands in for ticking the boxes and clicking Allow. Gmail is already on from FF10, and clicking an
        // already-on app would untick it, so this only ticks the ones that still need it.
        for (const app of ["Gmail", "Discord"]) {
          const box = `#everyday-offer input[value="${app}"]`;
          if (!(await ff.exec(`return document.querySelector(${JSON.stringify(box)}).checked;`))) {
            await clickOfferApp(ff, app);
          }
        }
        await ff.click("#ev-go");
        const on = await ff.waitFor(
          'return (await chrome.permissions.contains({ origins: ["https://mail.google.com/*", "https://discord.com/*"] })) ? "yes" : null;',
        );
        if (!on) throw new Error("Gmail and Discord didn't switch on first");
        // Ticks Slack and WhatsApp, then says no. The permission request is stubbed to resolve false here,
        // standing in for the browser's own prompt the way the welcome page's ask is captured elsewhere. FF14
        // restores the real request function, since later checks need to ask Firefox from this same page.
        await ff.exec(
          "chrome.permissions.realRequest ??= chrome.permissions.request; chrome.permissions.request = () => Promise.resolve(false);",
        );
        await clickOfferApp(ff, "Slack");
        await clickOfferApp(ff, "WhatsApp");
        await ff.click("#ev-go");
        const status = await ff.waitFor(
          'const t = document.querySelector("#ev-status").textContent; return /Nothing was switched on/.test(t) ? t : null;',
        );
        if (!status) {
          throw new Error(
            `status after No: ${await ff.exec('return document.querySelector("#ev-status").textContent;')}`,
          );
        }
        const ticked = await ff.exec(
          'return [...document.querySelectorAll("#everyday-offer input[type=checkbox]")].filter((b) => b.checked && !b.parentElement.classList.contains("on")).map((b) => b.value);',
        );
        if (ticked.join() !== "Slack,WhatsApp") throw new Error(`ticks after No: ${JSON.stringify(ticked)}`);
        await clickOfferApp(ff, "Slack");
        await clickOfferApp(ff, "WhatsApp");
        const unticked = await ff.exec(
          'return [...document.querySelectorAll("#everyday-offer input[type=checkbox]")].filter((b) => b.checked && !b.parentElement.classList.contains("on")).map((b) => b.value);',
        );
        if (unticked.length) throw new Error(`still ticked after a click to untick: ${JSON.stringify(unticked)}`);
      },
    );

    await check(
      "FF14",
      "Welcome page: the 'nothing switched on' message is still there a second after the No, not just right after it (Firefox)",
      async () => {
        await onWelcome();
        // Slack and WhatsApp are unticked and off again after the check above.
        await clickOfferApp(ff, "Slack");
        await clickOfferApp(ff, "WhatsApp");
        await ff.click("#ev-go");
        const status = await ff.waitFor(
          'const t = document.querySelector("#ev-status").textContent; return /Nothing was switched on/.test(t) ? t : null;',
        );
        if (!status) {
          throw new Error(
            `status right after the No: ${await ff.exec('return document.querySelector("#ev-status").textContent;')}`,
          );
        }
        // Waits long enough for a stray permission event near the answer to have redrawn the card.
        await sleep(1000);
        const later = await ff.exec('return document.querySelector("#ev-status").textContent;');
        try {
          if (!/Nothing was switched on/.test(later)) throw new Error(`status a second later: ${later}`);
        } finally {
          await ff.exec(
            "if (chrome.permissions.realRequest) chrome.permissions.request = chrome.permissions.realRequest;",
          );
        }
      },
    );

    await check(
      "FF11",
      "Popup: protecting the site you're on asks Firefox in the click's own turn; Clotr is set up there (Firefox)",
      async () => {
        await onWelcome();
        // Stands in for someone on an unknown AI chat clicking Clotr's toolbar button, which grants activeTab so
        // the popup can see which site the tab is on. Firefox has to grant that itself, so this does it from the
        // browser side.
        const tab = await ff.newTab(() => ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(SITE)} });`));
        if (!tab) throw new Error("the chat's tab didn't open");
        // Waits until the tab is actually on the site, since navigating away again would take back the access
        // the toolbar click granted.
        const front =
          'return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec;';
        let at = "";
        for (let t = 0; t < 12000 && at !== SITE; t += 150) {
          at = await ff.inBrowser(front);
          if (at !== SITE) await sleep(150);
        }
        if (at !== SITE) {
          throw new Error(
            `the tab in front is on ${JSON.stringify(at)}, not the chat (tabs: ${await ff.inBrowser('const g = Services.wm.getMostRecentWindow("navigator:browser").gBrowser; return JSON.stringify(g.tabs.map((t) => (t.selected ? "*" : "") + t.linkedBrowser.currentURI.spec));')})`,
          );
        }
        await ff.inBrowser(`
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        ExtensionParent.GlobalManager.getExtension(${JSON.stringify(addon)}).tabManager.addActiveTabPermission(win.gBrowser.selectedTab);`);
        // Opens the popup in a background tab, so the chat's tab stays the one the popup is about.
        await ff.switchTo(welcome);
        const popup = await ff.newTab(() =>
          ff.exec('await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false });'),
        );
        if (!popup) throw new Error("the popup didn't open");
        await ff.switchTo(popup);
        const offered = await ff.waitFor('return document.querySelector("#site button.linkish")?.textContent || null;');
        if (!offered) {
          throw new Error(
            `no way to protect the site: ${JSON.stringify(await ff.exec('return document.querySelector("#site").innerText;'))}`,
          );
        }
        await ff.click("#site button.linkish"); // "It's an AI chat: protect it"
        // Confirms it's fully set up: Firefox granted the site, Clotr's script for added sites runs on it, and
        // it's remembered as an AI chat.
        const setUp = `
        const origin = ${JSON.stringify(`${SITE}*`)};
        const granted = await chrome.permissions.contains({ origins: [origin] });
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        const runs = scripts.some((s) => (s.matches || []).includes(origin));
        const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
        const kind = siteKinds[${JSON.stringify(new URL(SITE).hostname)}];`;
        const done = await ff.waitFor(`${setUp} return granted && runs && kind === "ai";`, 15000);
        if (!done) {
          throw new Error(`not set up: ${JSON.stringify(await ff.exec(`${setUp} return { granted, runs, kind };`))}`);
        }
      },
    );

    await check(
      "FF12",
      "Firefox holds Clotr to the rule here: an ask after a wait is refused, an ask at once isn't",
      async () => {
        // Adds two buttons to the welcome page, each asking Firefox for a site when clicked: one asks right away,
        // the other waits on storage first, which is the mistake the popup used to make. Both use the same real
        // click; only the wait differs.
        await onWelcome();
        await ff.exec(`
        for (const [id, wait] of [["ff12-at-once", false], ["ff12-after-a-wait", true]]) {
          const b = document.createElement("button");
          b.id = id;
          b.textContent = id;
          b.addEventListener("click", async () => {
            try {
              if (wait) await chrome.storage.local.get("everydayOffer");
              b.dataset.answer = String(await chrome.permissions.request({ origins: ["https://" + id + ".newtool.example/*"] }));
            } catch (e) {
              b.dataset.answer = String(e.message || e);
            }
          });
          document.body.prepend(b);
        }`);
        await ff.click("#ff12-at-once");
        await ff.click("#ff12-after-a-wait");
        const answers = await ff.waitFor(
          'const a = ["ff12-at-once", "ff12-after-a-wait"].map((id) => document.getElementById(id).dataset.answer); return a.every(Boolean) ? a : null;',
        );
        if (!answers) throw new Error("the buttons got no answer");
        if (answers[0] !== "true") throw new Error(`an ask at once wasn't granted: ${answers[0]}`);
        if (!/user input/i.test(answers[1])) throw new Error(`an ask after a wait wasn't refused: ${answers[1]}`);
      },
    );

    await check(
      "FF15",
      'Popup: an AI chat Clotr spotted but doesn\'t protect yet — "Protect this site" asks Firefox the same way (Firefox)',
      async () => {
        // FF11 covers the other button on this card, the one offered for a site that looked like anything else.
        // This one is the primary button shown instead for an AI chat Clotr has already spotted but doesn't
        // protect yet, which needs a page that actually loads over https to earn that spotted state, the way a
        // real site like duck.ai would.
        const fixture = await startHttpsFixture(AI_CHAT_HTML, "localhost");
        try {
          await onWelcome();
          await trustFixtureCert(ff, fixture.url);
          const tab = await ff.newTab(() =>
            ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(fixture.url)} });`),
          );
          if (!tab) throw new Error("the fixture chat's tab didn't open");
          const front =
            'return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec;';
          let at = "";
          for (let t = 0; t < 12000 && at !== fixture.url; t += 150) {
            at = await ff.inBrowser(front);
            if (at !== fixture.url) await sleep(150);
          }
          if (at !== fixture.url) throw new Error(`the tab in front is on ${JSON.stringify(at)}, not the fixture chat`);
          await ff.inBrowser(`
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          ExtensionParent.GlobalManager.getExtension(${JSON.stringify(addon)}).tabManager.addActiveTabPermission(win.gBrowser.selectedTab);`);
          await ff.switchTo(welcome);
          const popup = await ff.newTab(() =>
            ff.exec('await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false });'),
          );
          if (!popup) throw new Error("the popup didn't open");
          await ff.switchTo(popup);
          const spotted = await ff.waitFor(
            'return document.querySelector("#site .state")?.textContent || null;',
            10000,
          );
          if (!spotted || !/not protected yet/i.test(spotted)) {
            throw new Error(
              `not spotted as an AI chat: ${JSON.stringify(await ff.exec('return document.querySelector("#site")?.innerText || null;'))}`,
            );
          }
          const btn = await ff.exec(
            'const b = document.querySelector("#site button.primary"); return b ? { text: b.textContent, linkish: b.classList.contains("linkish") } : null;',
          );
          if (!btn || btn.linkish) {
            throw new Error(`"Protect this site" isn't the primary button: ${JSON.stringify(btn)}`);
          }
          await ff.click("#site button.primary"); // "Protect this site"
          // A host permission pattern never names a port, so the fixture's random port doesn't appear here
          // either, matching what Clotr actually asks for.
          const origin = `https://${new URL(fixture.url).hostname}/*`;
          const setUp = `
          const granted = await chrome.permissions.contains({ origins: [${JSON.stringify(origin)}] });
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          const runs = scripts.some((s) => (s.matches || []).includes(${JSON.stringify(origin)}));
          const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
          const kind = siteKinds[${JSON.stringify(new URL(fixture.url).hostname)}];`;
          const done = await ff.waitFor(`${setUp} return granted && runs && kind === "ai";`, 15000);
          if (!done) {
            throw new Error(`not set up: ${JSON.stringify(await ff.exec(`${setUp} return { granted, runs, kind };`))}`);
          }
        } finally {
          await fixture.close();
        }
      },
    );

    await check(
      "FFMAIL1",
      "Outlook reply: three quoted addresses stay quiet, and a typed phone is covered in place (Firefox)",
      async () => {
        const fixture = await startHttpsFixture(
          fs.readFileSync(path.join(__dirname, "pages", "email-outlook-reply.html"), "utf8"),
        );
        try {
          await trustFixtureCert(ff, fixture.url);
          await onWelcome();
          await ff.exec('await chrome.storage.local.set({ siteKinds: { "127.0.0.1": "everyday" } });');

          const openReply = async () => {
            const tab = await ff.newTab(() =>
              ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(fixture.url)} });`),
            );
            if (!tab) throw new Error("the Outlook reply fixture didn't open");
            await ff.switchTo(tab);
            const loaded = await ff.waitFor('return document.querySelector("#reply") ? true : null;', 10000);
            if (!loaded) throw new Error("the Outlook reply fixture didn't load");
          };
          const placeAtReplyEnd = () =>
            ff.exec(`
              const editor = document.querySelector("#body");
              const reply = document.querySelector("#reply");
              const range = document.createRange();
              range.selectNodeContents(reply);
              range.collapse(false);
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              editor.focus();`);

          await openReply();
          await placeAtReplyEnd();
          await ff.type("#body", "Thanks.");
          await sleep(1200);
          if (await ff.exec('return Boolean(document.querySelector("clotr-notice"));')) {
            throw new Error("the reply warned about the three addresses in its quoted header");
          }

          await onWelcome();
          await openReply();
          await ff.exec(`
            const snapshot = (node) => ({
              node,
              type: node.nodeType,
              name: node.nodeName,
              value: node.nodeValue,
              attributes: node.nodeType === Node.ELEMENT_NODE ? [...node.attributes].map((a) => [a.name, a.value]) : [],
              children: [...node.childNodes].map(snapshot),
            });
            window.__emailPreserved = ["#signature", "#email-history"].map((selector) =>
              snapshot(document.querySelector(selector)),
            );`);
          await placeAtReplyEnd();
          await ff.type("#body", "My number is 555-555-0123.");
          const warned = await ff.waitFor('return Boolean(document.querySelector("clotr-notice")) || null;', 8000);
          if (!warned) throw new Error("the phone typed above the quote did not warn");

          let inside = false;
          for (let i = 0; i < 12 && !inside; i++) {
            await ff.send("WebDriver:PerformActions", {
              actions: [
                {
                  type: "key",
                  id: "keyboard",
                  actions: [
                    { type: "keyDown", value: "\uE004" },
                    { type: "keyUp", value: "\uE004" },
                  ],
                },
              ],
            });
            inside = await ff.exec('return document.activeElement?.tagName === "CLOTR-NOTICE";');
          }
          if (!inside) throw new Error("couldn't reach the warning with Tab");
          await sleep(1200);
          await ff.send("WebDriver:PerformActions", {
            actions: [
              {
                type: "key",
                id: "keyboard",
                actions: [
                  { type: "keyDown", value: "\uE007" },
                  { type: "keyUp", value: "\uE007" },
                ],
              },
            ],
          });
          const covered = await ff.waitFor(
            'return document.querySelector("#reply")?.innerText.includes("[REDACTED PHONE NUMBER]") || null;',
            5000,
          );
          if (!covered) throw new Error("Clot this leak did not replace the typed phone in the reply");
          const unchanged = await ff.exec(`
            const same = (before, node) => Boolean(node) && before.node === node && before.type === node.nodeType &&
              before.name === node.nodeName && before.value === node.nodeValue &&
              JSON.stringify(before.attributes) === JSON.stringify(node.nodeType === Node.ELEMENT_NODE ? [...node.attributes].map((a) => [a.name, a.value]) : []) &&
              before.children.length === node.childNodes.length && before.children.every((child, i) => same(child, node.childNodes[i]));
            return ["#signature", "#email-history"].every((selector, i) =>
              same(window.__emailPreserved[i], document.querySelector(selector)));
          `);
          if (!unchanged) throw new Error("Clot this leak changed the quote or signature formatting");
          const quote = await ff.exec('return document.querySelector("#quote-body")?.innerText || "";');
          if (!quote.includes("555-555-0123")) throw new Error("Clot this leak changed the quoted number");
        } finally {
          await fixture.close();
        }
      },
    );

    await check(
      "FF16",
      "Tourniquet (adult): a phone number still gets a corner note, with the money line (Firefox)",
      async () => {
        // With Tourniquet on for an adult, a phone number showed no corner note at all in manual testing, even
        // though a Medicare number and a password worked the same way. This check runs against a real site
        // through the actual content.js/background.js pipeline, not the welcome page's practice box, which skips
        // Tourniquet entirely; the extra host permission for that site was added above.
        const fixture = await startHttpsFixture(
          fs.readFileSync(path.join(__dirname, "pages", "textarea-chat.html"), "utf8"),
        );
        try {
          await trustFixtureCert(ff, fixture.url);
          // Turns Tourniquet on before the chat tab even opens, so the content script reads it fresh at the
          // start, the same as it would for someone who switched it on before opening the chat at all.
          await onWelcome();
          await ff.exec('await chrome.storage.local.set({ tourniquet: { for: "adult", since: Date.now() } });');
          const tab = await ff.newTab(() =>
            ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(fixture.url)} });`),
          );
          if (!tab) throw new Error("the fixture chat's tab didn't open");
          await ff.switchTo(tab);
          const loaded = await ff.waitFor('return document.querySelector("#prompt-textarea") ? true : null;', 10000);
          if (!loaded) throw new Error("the fixture chat didn't load");
          await ff.click("#prompt-textarea");
          await ff.type("#prompt-textarea", "call me at 555-555-0123 ");
          const host = await ff.waitFor('return Boolean(document.querySelector("clotr-notice")) || null;', 8000);
          if (!host) {
            throw new Error(
              `no corner note for a phone number under Tourniquet (box: ${JSON.stringify(await ff.exec('return document.querySelector("#prompt-textarea")?.value ?? null;'))})`,
            );
          }
        } finally {
          await onWelcome();
          await ff.exec('await chrome.storage.local.remove("tourniquet");').catch(() => {});
          await fixture.close();
        }
      },
    );

    // FF17 and FF18 switch Firefox's own prompts back on, the way a real profile has them. With them off, Firefox
    // records every site it's asked for, so it never takes the path that broke here: a site something already
    // granted covers gets a yes with no question and nothing recorded, and the switch stayed off.
    const withPrompts = async (fn) => {
      const set = (on) =>
        ff.inBrowser(`Services.prefs.setBoolPref("extensions.webextOptionalPermissionPrompts", ${on}); return true;`);
      await set(true);
      try {
        return await fn();
      } finally {
        await set(false);
        await onWelcome().catch(() => {});
        await ff
          .exec(
            `await chrome.permissions.remove({ origins: ${JSON.stringify(SWITCHED)} }); await chrome.storage.local.remove("siteScopes");`,
          )
          .catch(() => {});
      }
    };
    // Grants these the way an earlier session would have, with no question, from the browser's side.
    const grantedEarlier = async (origins) => {
      await ff.inBrowser(`
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
        const ext = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(addon)});
        ExtensionPermissions.add(
          ext.id,
          { permissions: [], origins: ${JSON.stringify(origins)}, data_collection: [] },
          ext,
        ).catch((e) => Services.console.logStringMessage(String(e)));
        return true;`);
      const granted = await ff.waitFor(
        `return await chrome.permissions.contains({ origins: ${JSON.stringify(origins)} }) || null;`,
        5000,
      );
      if (!granted) throw new Error(`Firefox didn't grant the earlier permission for ${JSON.stringify(origins)}`);
    };
    const appSwitch = (list, name) => `#${list} button[aria-label="Clotr on ${name}"]`;
    const reads = (sel) => ff.exec(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
    async function openPopupSettings() {
      // The tab is in the page before popup.js runs, so a click that early does nothing: click until it shows.
      const shown = await ff.waitFor('return document.querySelector("#tab-settings") ? true : null;');
      if (!shown) throw new Error("the popup didn't load");
      const onTab = await ff.waitFor(
        'document.getElementById("tab-settings").click(); return document.body.dataset.tab === "settings" || null;',
      );
      if (!onTab) throw new Error("the Settings tab didn't open");
      const ready = await ff.waitFor('return document.querySelectorAll("#everyday-sites li").length >= 8 || null;');
      if (!ready) throw new Error("Settings' email and chat apps didn't load");
      if (!(await ff.exec('return document.querySelector("#pick-sites").open;'))) await ff.click("#pick-sites summary");
    }
    // Clicks a switch, answers Firefox's question if it asks (`asks` says whether it should), and waits for the
    // switch to read `want`.
    async function flip(sel, label, want, asks) {
      await ff.exec(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" });`);
      await ff.click(sel);
      if (asks !== undefined) {
        const asked = await answerPrompt(ff, "/popup.html", asks ? 5000 : 1500);
        if (asked !== asks) {
          throw new Error(asks ? `Firefox didn't ask about ${label}` : `Firefox asked about ${label}, already covered`);
        }
      }
      const done = await ff.waitFor(
        `return document.querySelector(${JSON.stringify(sel)})?.textContent === ${JSON.stringify(want)} || null;`,
        5000,
      );
      if (!done) {
        const said = await ff.exec(
          'return [...document.querySelectorAll(".ev-status")].map((p) => p.textContent).join(" ");',
        );
        throw new Error(
          `${label} reads ${JSON.stringify(await reads(sel))}, not ${want} (status: ${JSON.stringify(said)})`,
        );
      }
    }

    // Clicks a switch Everywhere I type keeps on: Firefox doesn't ask, the switch still reads On, and the line
    // under its list says why instead of the click doing nothing.
    async function keptOn(sel, label, statusId) {
      await ff.exec(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" });`);
      await ff.exec(`document.getElementById(${JSON.stringify(statusId)}).textContent = "";`);
      await ff.click(sel);
      if (await answerPrompt(ff, "/popup.html", 1500)) throw new Error(`Firefox asked about ${label}, already covered`);
      const said = await ff.waitFor(
        `const t = document.getElementById(${JSON.stringify(statusId)}).textContent; return /keeps Clotr on here/.test(t) ? t : null;`,
        5000,
      );
      if (!said) throw new Error(`clicking ${label} said nothing (reads ${JSON.stringify(await reads(sel))})`);
      if ((await reads(sel)) !== "On") throw new Error(`${label} reads ${JSON.stringify(await reads(sel))}, not On`);
    }
    // What the row under a switch says about it, like "Email, through Everywhere I type".
    const why = (sel) => ff.exec(`return document.querySelector(${JSON.stringify(sel)}).closest("li").textContent;`);

    await check(
      "FF17",
      "Popup Settings: Turn on works for Gmail and Outlook fresh, with an earlier grant, and under Everywhere I type (Firefox)",
      () =>
        withPrompts(async () => {
          await onWelcome();
          await ff.exec(`await chrome.permissions.remove({ origins: ${JSON.stringify(SWITCHED)} });`);
          const popup = await ff.newTab(() =>
            ff.exec('await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });'),
          );
          if (!popup) throw new Error("the popup didn't open");
          await ff.switchTo(popup);
          await openPopupSettings();
          const gmail = appSwitch("everyday-sites", "Gmail");
          const outlook = appSwitch("everyday-sites", "Outlook");
          // Fresh: Firefox asks about each app, and a yes switches it on.
          await flip(gmail, "Gmail (fresh)", "On", true);
          await flip(outlook, "Outlook (fresh)", "On", true);

          // Granted in an earlier session: the popup opened again reads both as On straight away.
          await ff.send("WebDriver:Refresh");
          await openPopupSettings();
          for (const [sel, app] of [
            [gmail, "Gmail"],
            [outlook, "Outlook"],
          ]) {
            const now = await reads(sel);
            if (now !== "On") throw new Error(`${app} reads ${JSON.stringify(now)} with its grant already there`);
          }

          // Everywhere I type on. Gmail's own grant goes back, and Gmail stays On, through Everywhere I type,
          // which is what a profile that had both looked like. Switching it on there has nothing to ask for, so
          // the click says so. A support chat reads On the same way, and a search engine, which Everywhere I type
          // never covers, turns on with no question.
          await flip("#everywhere-switch", "Everywhere I type", "On", true);
          if (/through Everywhere I type/.test(await why(outlook))) {
            throw new Error("Outlook's own grant reads as covered");
          }
          await keptOn(gmail, "Gmail with its own grant", "everyday-status");
          if (!/through Everywhere I type/.test(await why(gmail))) {
            throw new Error(`Gmail's row says ${JSON.stringify(await why(gmail))}`);
          }
          await keptOn(gmail, "Gmail under Everywhere I type", "everyday-status");
          const intercom = appSwitch("support-sites", "Intercom");
          if ((await reads(intercom)) !== "On") throw new Error("Intercom isn't On under Everywhere I type");
          await keptOn(intercom, "Intercom under Everywhere I type", "support-status");
          await flip(appSwitch("search-sites", "Google"), "Google under Everywhere I type", "On", false);
          const setUp = `
            const [mine] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            const [wide] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-everywhere"] });
            const own = ["https://outlook.live.com/*", "https://www.google.com/*"];`;
          const runs = await ff.waitFor(
            `${setUp} return (own.every((o) => mine?.matches.includes(o) && wide?.excludeMatches.includes(o)) &&
              !mine.matches.includes("https://mail.google.com/*") && !wide.excludeMatches.includes("https://mail.google.com/*")) || null;`,
            8000,
          );
          if (!runs) {
            throw new Error(
              `set up wrong: ${JSON.stringify(await ff.exec(`${setUp} return { mine: mine?.matches, wide: wide?.excludeMatches };`))}`,
            );
          }
          await ff.send("WebDriver:Refresh");
          await openPopupSettings();
          for (const [sel, app] of [
            [gmail, "Gmail"],
            [outlook, "Outlook"],
            [appSwitch("search-sites", "Google"), "Google"],
          ]) {
            const now = await reads(sel);
            if (now !== "On") throw new Error(`${app} reads ${JSON.stringify(now)} after the popup opened again`);
          }

          // Google off again, then Everywhere I type off: Gmail and Intercom were on only through it, and Outlook
          // keeps its own grant.
          await flip(appSwitch("search-sites", "Google"), "Google", "Turn on");
          await flip("#everywhere-switch", "Everywhere I type", "Turn on");
          for (const [sel, app, want] of [
            [gmail, "Gmail", "Turn on"],
            [intercom, "Intercom", "Turn on"],
            [outlook, "Outlook", "On"],
          ]) {
            const now = await reads(sel);
            if (now !== want) throw new Error(`${app} reads ${JSON.stringify(now)} with Everywhere I type off`);
          }
        }),
    );

    await check(
      "FF18",
      "Welcome page under Everywhere I type: covered apps show On, and DuckDuckGo switches on and sticks (Firefox)",
      () =>
        withPrompts(async () => {
          await onWelcome();
          await ff.exec(`await chrome.permissions.remove({ origins: ${JSON.stringify(SWITCHED)} });`);
          // The shape of a real profile: Everywhere I type on, Discord granted by itself, Outlook not.
          await grantedEarlier(["https://*/*", "https://discord.com/*"]);
          await ff.send("WebDriver:Refresh");
          await onWelcome();
          const app = (name) => `#everyday-offer label.ev-app:has(input[value="${name}"])`;
          const shown = await ff.waitFor(
            `return !document.querySelector("#everyday-offer").hidden && document.querySelector(${JSON.stringify(app("Outlook"))})?.classList.contains("on") || null;`,
          );
          if (!shown) throw new Error("Outlook isn't On on the card under Everywhere I type");
          const boxes = await ff.exec(`
            const box = (n) => document.querySelector(${JSON.stringify(app("X"))}.replace("X", n) + " input");
            return { outlook: box("Outlook").disabled && box("Outlook").checked, discord: box("Discord").checked };`);
          if (!boxes.outlook || !boxes.discord) throw new Error(`the card's ticks are wrong: ${JSON.stringify(boxes)}`);

          const ddg = '#more-sites-offer label.ev-app:has(input[value="DuckDuckGo"])';
          await ff.exec(`document.querySelector(${JSON.stringify(ddg)}).scrollIntoView({ block: "center" });`);
          await ff.click(ddg);
          await ff.click("#ms-go");
          if (await answerPrompt(ff, "/vault.html?welcome=1", 1500)) throw new Error("Firefox asked about DuckDuckGo");
          const on = await ff.waitFor(`
            const on = await globalThis.ClotrSites.userSitePatterns();
            return on.includes("https://duckduckgo.com/*") || null;`);
          if (!on) {
            throw new Error(
              `not on: ${JSON.stringify(await ff.exec("return await globalThis.ClotrSites.userSitePatterns();"))}`,
            );
          }
          // The card opened again shows DuckDuckGo as On.
          await ff.send("WebDriver:Refresh");
          await onWelcome();
          const tagged = await ff.waitFor(
            `return document.querySelector(${JSON.stringify(ddg)})?.classList.contains("on") || null;`,
          );
          if (!tagged) throw new Error("DuckDuckGo isn't On on the card opened again");
        }),
    );

    // FF19 and FF20 use the real toolbar popup, the panel a click on Clotr's button opens, because a popup opened
    // as a tab can never cover Firefox's question. In a fresh profile Clotr sits in the extensions (puzzle) menu,
    // so this clicks that button and then Clotr's entry, both from the browser side. The popup's own page has no
    // window handle, so the checks read it through chrome.extension.getViews from the welcome page and click into
    // it with a real pointer at the button's spot.
    const openPanel = `
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const clotr = [...win.document.querySelectorAll('browser[webextension-view-type="popup"]')].find(
        (b) => b.closest("panel")?.state === "open",
      );`;
    // Also drops any question of Firefox's left unanswered, so a check that failed doesn't leave the next one a
    // question it never asked.
    const closeToolbarPopup = () =>
      ff.inBrowser(`${openPanel}
        clotr?.closest("panel").hidePopup();
        for (const b of win.gBrowser.browsers) win.PopupNotifications.getNotification("addon-webext-permissions", b)?.remove();
        return true;`);
    // `body` runs in the popup's page as `d`, its document, and is polled until it returns something.
    const inPopup = async (body, ms) => {
      await ff.switchTo(welcome);
      return ff.waitFor(
        `const [pop] = chrome.extension.getViews({ type: "popup" }); const d = pop?.document; if (!d) return null; ${body}`,
        ms,
      );
    };
    async function openToolbarPopup() {
      await closeToolbarPopup();
      await ff.clickInBrowser("#unified-extensions-button");
      await ff.clickInBrowser(`.unified-extensions-item-action-button[data-extensionid="${addon}"]`);
      // The page can be ready while its panel is still sliding open, so this waits for both.
      let open = false;
      for (const until = Date.now() + 10000; !open && Date.now() < until; await sleep(150)) {
        open = await ff.inBrowser(`${openPanel} return Boolean(clotr);`);
      }
      if (!open || !(await inPopup('return d.getElementById("tab-settings") ? true : null;'))) {
        throw new Error("Clotr's toolbar popup didn't open");
      }
    }
    async function clickInPopup(sel, label) {
      const at = await inPopup(`
        const b = d.querySelector(${JSON.stringify(sel)});
        if (!b) return null;
        b.scrollIntoView({ block: "center" });
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
      if (!at) throw new Error(`no ${label} in the toolbar popup`);
      const box = await ff.inBrowser(
        `${openPanel} const r = clotr?.getBoundingClientRect(); return r ? { x: r.left, y: r.top } : null;`,
      );
      if (!box) throw new Error("Clotr's toolbar popup closed before the click");
      await ff.clickInBrowserAt(box.x + at.x, box.y + at.y);
    }
    // Waits for Firefox's question about `label` and checks a person can reach its Allow button, which means
    // Clotr's panel has closed or at least isn't over the button, then clicks Allow, or Don't allow if `yes` is
    // false.
    async function answerFromToolbar(label, yes = true) {
      const look = `${openPanel}
        const asked = win.PopupNotifications.panel;
        const allow = asked.state === "open" && asked.querySelector("#addon-webext-permissions-notification")?.button;
        if (!allow) return { asked: false };
        const r = allow.getBoundingClientRect();
        const a = { left: r.left + win.mozInnerScreenX, top: r.top + win.mozInnerScreenY };
        Object.assign(a, { right: a.left + r.width, bottom: a.top + r.height });
        const c = clotr?.closest("panel").getOuterScreenRect();
        const over = Boolean(c) && a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
        return { asked: true, over, allow: [a.left, a.top, r.width, r.height].map(Math.round), clotr: c && [c.left, c.top, c.width, c.height].map(Math.round) };`;
      let seen = { asked: false };
      for (const until = Date.now() + 5000; Date.now() < until; await sleep(150)) {
        seen = await ff.inBrowser(look);
        if (seen.asked && !seen.over) break;
      }
      if (!seen.asked) throw new Error(`Firefox didn't ask about ${label}`);
      if (seen.over) {
        throw new Error(
          `Clotr's popup covers the Allow button of Firefox's question about ${label} (Allow at ${seen.allow}, popup at ${seen.clotr})`,
        );
      }
      await ff.inBrowser(
        `Services.wm.getMostRecentWindow("navigator:browser").PopupNotifications.panel.querySelector("#addon-webext-permissions-notification").${yes ? "button" : "secondaryButton"}.click(); return true;`,
      );
    }
    // What a switch in the popup's Settings reads.
    const switchReads = (list, app) =>
      inPopup(`
        d.getElementById("tab-settings").click();
        if (d.body.dataset.tab !== "settings" || d.querySelectorAll("#everyday-sites li").length < 8) return null;
        d.querySelector("#pick-sites").open = true;
        return d.querySelector(${JSON.stringify(appSwitch(list, app))})?.textContent || null;`);
    const granted = (origins) =>
      ff.waitFor(`return (await chrome.permissions.contains({ origins: ${JSON.stringify(origins)} })) || null;`, 5000);

    await check(
      "FF19",
      "Toolbar popup: the email apps offer and Turn on for Gmail and a search engine leave Firefox's Allow button reachable, Allow switches each on, and Don't allow leaves Outlook off (Firefox)",
      () =>
        withPrompts(async () => {
          await onWelcome();
          await ff.exec(`await chrome.permissions.remove({ origins: ${JSON.stringify(SWITCHED)} });`);
          // An old note calling Gmail an AI chat, which switching it on clears, popup or no popup.
          const gmailNote = (kind) => `
            const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
            ${kind ? `siteKinds["mail.google.com"] = "${kind}"; await chrome.storage.local.set({ siteKinds });` : ""}
            return siteKinds["mail.google.com"] ?? "none";`;
          await ff.exec(gmailNote("ai"));
          try {
            // The popup's own offer of the email and chat apps, shown while none is on yet, asks the same way.
            await ff.exec('await chrome.storage.local.set({ everydayOffer: "popup" });');
            await openToolbarPopup();
            const offered = await inPopup(`
              const box = d.querySelector('#everyday-offer input[value="Discord"]');
              if (d.getElementById("everyday-offer").hidden || !box) return null;
              if (!box.checked) box.click();
              return !d.getElementById("ev-go").hidden || null;`);
            if (!offered) throw new Error("the popup's offer of the email and chat apps didn't show");
            await clickInPopup("#ev-go", "the offer's Switch on");
            await answerFromToolbar("Discord");
            if (!(await granted(["https://discord.com/*"]))) throw new Error("Discord wasn't granted from the offer");

            for (const [list, app, origins, yes] of [
              ["everyday-sites", "Gmail", ["https://mail.google.com/*"], true],
              ["search-sites", "Google", ["https://www.google.com/*"], true],
              ["everyday-sites", "Outlook", ["https://outlook.live.com/*", "https://outlook.office.com/*"], false],
            ]) {
              await openToolbarPopup();
              const ready = await switchReads(list, app);
              if (ready !== "Turn on") throw new Error(`${app} reads ${JSON.stringify(ready)} in the toolbar popup`);
              await clickInPopup(appSwitch(list, app), `${app}'s Turn on`);
              await answerFromToolbar(app, yes);
              if (yes) {
                if (!(await granted(origins))) throw new Error(`${app} wasn't granted after Allow`);
                // Clotr is set up there with no popup left to do it.
                const runs = await ff.waitFor(
                  `const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
                  return ${JSON.stringify(origins)}.every((o) => s?.matches.includes(o)) || null;`,
                  5000,
                );
                if (!runs) throw new Error(`Clotr isn't set up on ${app} after Allow`);
                const note = await ff.exec(gmailNote());
                if (note !== "none") throw new Error(`Gmail's old note still says ${JSON.stringify(note)}`);
              } else if (
                await ff.exec(`return chrome.permissions.contains({ origins: ${JSON.stringify(origins)} });`)
              ) {
                throw new Error(`${app} was granted after Don't allow`);
              }
              // The popup opened again reads the answer.
              await openToolbarPopup();
              const now = await switchReads(list, app);
              const want = yes ? "On" : "Turn on";
              if (now !== want) throw new Error(`${app} reads ${JSON.stringify(now)} when the popup opens again`);
            }
          } finally {
            await closeToolbarPopup();
          }
        }),
    );

    await check(
      "FF20",
      "Toolbar popup: Allow Clotr on this site, and Turn Clotr on here, leave Firefox's Allow button reachable, and Allow sets each site up (Firefox)",
      () =>
        withPrompts(async () => {
          await onWelcome();
          const chat = "https://chatgpt.com/";
          const builtIn = await ff.exec(`return globalThis.ClotrSites.builtInMatchesFor(${JSON.stringify(chat)});`);
          const other = "https://notes.newtool.example/";
          const otherOrigin = `${other}*`;
          const setUp = `
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            const { siteKinds = {} } = await chrome.storage.local.get("siteKinds");
            const kind = siteKinds[${JSON.stringify(new URL(other).hostname)}];
            const runs = Boolean(s?.matches.includes(${JSON.stringify(otherOrigin)}));`;
          // The way Firefox installs Clotr: a built-in site's access withheld until someone allows it. The other
          // site is one Clotr doesn't know, switched on as an everyday site, which the popup notes before it asks.
          await ff.exec(`await chrome.permissions.remove({ origins: ${JSON.stringify(builtIn)} });`);
          try {
            // Allow is the highlighted button; Turn Clotr on here is a plain one, since on an ordinary site
            // Clotr is resting and switching it on is the quieter choice.
            for (const [url, button, sel, origins, done] of [
              [chat, "Allow Clotr on this site", "#site .btn.primary", builtIn, ""],
              [
                other,
                "Turn Clotr on here",
                "#site .btn:not(.primary)",
                [otherOrigin],
                `${setUp} return (runs && kind === "everyday") || null;`,
              ],
            ]) {
              const tab = await ff.newTab(() => ff.exec(`await chrome.tabs.create({ url: ${JSON.stringify(url)} });`));
              if (!tab) throw new Error(`${url}'s tab didn't open`);
              try {
                const front =
                  'return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec;';
                let at = "";
                for (let t = 0; t < 12000 && at !== url; t += 150) {
                  at = await ff.inBrowser(front);
                  if (at !== url) await sleep(150);
                }
                if (at !== url) throw new Error(`the tab in front is on ${JSON.stringify(at)}, not ${url}`);
                await openToolbarPopup();
                const offered = await inPopup(`return d.querySelector(${JSON.stringify(sel)})?.textContent || null;`);
                if (offered !== button) throw new Error(`the popup offers ${JSON.stringify(offered)}, not ${button}`);
                await clickInPopup(sel, button);
                await answerFromToolbar(new URL(url).hostname);
                if (!(await granted(origins))) throw new Error(`${url} wasn't granted after Allow`);
                if (done && !(await ff.waitFor(done, 5000))) {
                  throw new Error(
                    `${url} isn't set up: ${JSON.stringify(await ff.exec(`${setUp} return { runs, kind };`))}`,
                  );
                }
              } finally {
                await closeToolbarPopup();
                await ff.switchTo(tab);
                await ff.send("WebDriver:CloseWindow");
                await ff.switchTo(welcome);
              }
            }
          } finally {
            if (!(await ff.exec(`return chrome.permissions.contains({ origins: ${JSON.stringify(builtIn)} });`))) {
              await grantedEarlier(builtIn);
            }
            await ff.exec(`await chrome.permissions.remove({ origins: ${JSON.stringify([otherOrigin])} });`);
          }
        }),
    );
  } finally {
    await ff.close();
  }
}

// Other test tools find Firefox the same way.
module.exports = { closeFirefox, findFirefox, withTimeout };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => {
      const code = process.exitCode || 0;
      process.stdout.write("", () => process.exit(code));
    });
}
