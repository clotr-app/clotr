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
// own coverage. FF9 through FF16 drive Clotr's welcome page and popup with real clicks over Marionette, because
// Firefox only lets an add-on ask for a site in the same click that triggered the ask, and the popup broke that
// rule once. FF16 also needs a real https page, since Tourniquet's storage only exists in an extension page's own
// world and has to be set from a moz-extension:// tab that the other checks can't open.
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer-core");
const fx = require("../../tools/make-picture-fixtures.js");
const { launchFirefox } = require("./marionette.js");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "output");
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
const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";

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
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "unzip";
  execFileSync(tar, process.platform === "win32" ? ["-xf", zip, "-C", ext] : ["-q", zip, "-d", ext]);
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-files-"));

  const browser = await puppeteer.launch({ browser: "firefox", executablePath: firefox, headless: true });
  const results = [];
  const check = async (id, name, fn) => {
    if (!wanted(id)) return;
    try {
      await fn();
      results.push(`  ${id} ${name} … PASS`);
    } catch (err) {
      results.push(`  ${id} ${name} … FAIL\n       → ${err.message}`);
    }
  };
  try {
    console.log(`Clotr Firefox smoke test\n  browser: ${await browser.version()}\n  build:   ${path.basename(zip)}\n`);
    await browser.installExtension(ext);
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
        if (missing.length || !host)
          throw new Error(`found ${JSON.stringify(found)}, missing ${JSON.stringify(missing)}, warning shown: ${host}`);
      } finally {
        await tab.close();
      }
    };
    const page = await openChat();

    await check("FF1", "Clotr starts on an AI chat and warns about a key (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type("my key is AKIA4HPQ7XZ2R6TWLJ3N ");
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
    await check("FF1b", "Hide it replaces the key in the chat box (Firefox)", async () => {
      // Reaches the warning by keyboard instead of a click, so the test doesn't depend on fonts or layout: Tab
      // until focus lands inside it, which is Leave it in, Tab once more to reach Hide it, then Enter.
      let inside = false;
      for (let i = 0; i < 8 && !inside; i++) {
        await page.keyboard.press("Tab");
        inside = await page.evaluate(() => document.activeElement?.tagName === "CLOTR-NOTICE");
      }
      if (!inside) throw new Error("couldn't reach the warning with Tab");
      await page.keyboard.press("Tab");
      // Clotr ignores Enter for 0.6 s after focus lands in the warning, so this waits well past that: a busy
      // computer can run the focus handler late, and npm run check runs this alongside other work.
      await sleep(1200);
      await page.keyboard.press("Enter");
      await sleep(500);
      const text = await page.$eval("#prompt-textarea", (t) => t.value);
      if (!text.includes("[REDACTED AWS ACCESS KEY]") || text.includes("AKIA4HPQ"))
        throw new Error(`box: ${JSON.stringify(text)}`);
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
    // A VIN with no label or vehicle word nearby is an easy case to miss, so this checks it on its own, pasting it
    // the way a real paste would land. Firefox automation can't read the closed warning, so it clicks Hide it
    // instead: the box then names the VIN's kind, which is how the test confirms what the warning was about.
    await check("FFVIN1", "A VIN pasted on its own warns; Hide it covers it as a VIN (Firefox)", async () => {
      const tab = await openChat();
      try {
        await tab.focus("#prompt-textarea");
        await tab.evaluate(() => document.execCommand("insertText", false, "1HGCM82633A004352"));
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
        await tab.keyboard.press("Tab");
        await sleep(1200); // waits past the 0.6 s guard on Enter, with extra room for a slow computer
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
    await check("FF4", "Bandage: cover a phone number and show the peek bubble (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type("call me at 555-555-0123 ");
      let host = false;
      for (let t = 0; t < 5000 && !host; t += 250) {
        await sleep(250);
        host = await page.evaluate(() => Boolean(document.querySelector("clotr-notice")));
      }
      if (!host) throw new Error("no notice for the Bandage offer");
      // The offer's buttons are drawn a moment after the notice appears, later still on a busy computer, so this
      // waits until the notice's size stops changing before tabbing through its buttons.
      let size = "";
      for (let t = 0, same = 0; t < 6000 && same < 3; t += 250) {
        await sleep(250);
        const now = await page.evaluate(() => {
          const r = document.querySelector("clotr-notice")?.getBoundingClientRect();
          return r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "";
        });
        same = now && now === size ? same + 1 : 0;
        size = now;
      }
      // Tabs into the notice, which lands on Leave it in, then continues in DOM order through Hide it, More
      // choices, Why am I seeing this, No thanks, and Yes, use cover names. This has to work blind, the same as
      // FF1b, since there's no shadow-root access here.
      let inside = false;
      for (let i = 0; i < 8 && !inside; i++) {
        await page.keyboard.press("Tab");
        inside = await page.evaluate(() => document.activeElement?.tagName === "CLOTR-NOTICE");
      }
      if (!inside) throw new Error("couldn't reach the notice with Tab");
      for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
      await sleep(1200); // waits past the 0.6 s guard on Enter, with extra room for a slow computer
      await page.keyboard.press("Enter");
      // Waits for the cover name to land once the choice is saved, rather than a fixed delay: 0.5 s wasn't always
      // enough on a slow CI runner. It still fails if the cover name never shows up.
      let text = "";
      for (let t = 0; t < 5000 && !text.includes("[Phone 1]"); t += 250) {
        await sleep(250);
        text = await page.$eval("#prompt-textarea", (el) => el.value);
      }
      if (!text.includes("[Phone 1]")) throw new Error(`box after "Yes, use cover names": ${JSON.stringify(text)}`);
      await page.keyboard.press("Enter"); // send it
      await sleep(500);
      await page.evaluate(() => window.__reply("Sure, I'll call [Phone 1] soon."));
      // Waits for the hotspot, which appears once the reply has sat quietly for about 3 s.
      let spots = false;
      for (let t = 0; t < 8000 && !spots; t += 250) {
        await sleep(250);
        spots = await page.evaluate(() => Boolean(document.querySelector("clotr-spots")));
      }
      if (!spots) throw new Error("no hotspot over the label");
      const point = await page.evaluate(() => {
        const t = document.querySelector(".reply").firstChild;
        const r = document.createRange();
        const i = t.nodeValue.indexOf("[Phone 1]");
        r.setStart(t, i);
        r.setEnd(t, i + "[Phone 1]".length);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      // Starts outside the label and moves in, since Firefox won't treat a hotspot that appears under an
      // already-still mouse as a hover.
      await page.mouse.move(point.x - 60, point.y - 30);
      await page.mouse.move(point.x, point.y, { steps: 4 });
      let peek = false;
      for (let t = 0; t < 3000 && !peek; t += 250) {
        await sleep(250);
        peek = await page.evaluate(() => Boolean(document.querySelector("clotr-peek")));
      }
      await page.screenshot({ path: path.join(OUT, "firefox-peek.png") });
      if (!peek) throw new Error("no peek bubble appeared");
    });
    await check("FF5", "A photo with the place it was taken saved inside: the Photo Location warning (Firefox)", () =>
      attachExpecting("IMG_FF5.jpg", fx.jpegWithGps(fx.PLACES.liberty), ["photo_location"], "firefox-photo-place.png"),
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
    await browser.close();
    fs.rmSync(files, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    await ownPageChecks(check, firefox, ext);
  } catch (err) {
    results.push(`  FF9-FF16 Clotr's own pages … FAIL\n       → couldn't run: ${err.message}`);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.includes("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed (${((Date.now() - t0) / 1000).toFixed(0)} s).`);
  process.exitCode = failed ? 1 : 0;
}

// FF9 through FF16 cover Clotr's own pages: the welcome page it opens on install, and the popup. They run in a
// separate Firefox driven over Marionette with real clicks and typing. `ext` is the unpacked Firefox build.
const OWN_PAGES = ["FF9", "FF10", "FF11", "FF12", "FF13", "FF14", "FF15", "FF16"];
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
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const usePort = await freePort();
  await new Promise((resolve) => server.listen(usePort, "127.0.0.1", resolve));
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
// WebDriver capability for that, only geckodriver's layer on top does, so this does it the way Firefox's own
// test suites do: from chrome-privileged script.
async function trustFixtureCert(ff, url) {
  const trusted = await ff.inBrowserAsync(`
  return await new Promise((resolve) => {
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
        overrides.rememberValidityOverride(${JSON.stringify(new URL(url).hostname)}, ${new URL(url).port}, {}, secInfo.serverCert, bits, true);
        resolve(true);
      } catch (e) {
        resolve(String((e && e.message) || e));
      }
    };
    req.onload = () => resolve(true);
    req.send(null);
  });`);
  if (trusted !== true) throw new Error(`couldn't trust the fixture's certificate: ${trusted}`);
}

async function ownPageChecks(check, firefox, ext) {
  if (!OWN_PAGES.some(wanted)) return;
  const manifestFile = path.join(ext, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const addon = manifest.browser_specific_settings.gecko.id;
  // FF16 needs Clotr to treat a local https fixture the way it treats a built-in AI site. A host permission
  // pattern never names a port, so it matches the fixture whichever free port it happens to get. Only this run's
  // throwaway build gets the extra permission, never the real manifest.
  if (wanted("FF16")) {
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
    };

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
        await ff.click('#everyday-offer input[value="Gmail"]');
        await ff.click("#ev-go");
        const said = await ff.waitFor(
          'return (await chrome.permissions.contains({ origins: ["https://mail.google.com/*"] })) ? document.querySelector("#ev-status").textContent : null;',
        );
        if (!said)
          throw new Error(
            `Gmail isn't on (the card says ${JSON.stringify(await ff.exec('return document.querySelector("#ev-status").textContent;'))})`,
          );
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
          if (!(await ff.exec(`return document.querySelector(${JSON.stringify(box)}).checked;`))) await ff.click(box);
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
        await ff.click('#everyday-offer input[value="Slack"]');
        await ff.click('#everyday-offer input[value="WhatsApp"]');
        await ff.click("#ev-go");
        const status = await ff.waitFor(
          'const t = document.querySelector("#ev-status").textContent; return /Nothing was switched on/.test(t) ? t : null;',
        );
        if (!status)
          throw new Error(
            `status after No: ${await ff.exec('return document.querySelector("#ev-status").textContent;')}`,
          );
        const ticked = await ff.exec(
          'return [...document.querySelectorAll("#everyday-offer input[type=checkbox]")].filter((b) => b.checked && !b.parentElement.classList.contains("on")).map((b) => b.value);',
        );
        if (ticked.join() !== "Slack,WhatsApp") throw new Error(`ticks after No: ${JSON.stringify(ticked)}`);
        await ff.click('#everyday-offer input[value="Slack"]');
        await ff.click('#everyday-offer input[value="WhatsApp"]');
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
        await ff.click('#everyday-offer input[value="Slack"]');
        await ff.click('#everyday-offer input[value="WhatsApp"]');
        await ff.click("#ev-go");
        const status = await ff.waitFor(
          'const t = document.querySelector("#ev-status").textContent; return /Nothing was switched on/.test(t) ? t : null;',
        );
        if (!status)
          throw new Error(
            `status right after the No: ${await ff.exec('return document.querySelector("#ev-status").textContent;')}`,
          );
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
        if (at !== SITE)
          throw new Error(
            `the tab in front is on ${JSON.stringify(at)}, not the chat (tabs: ${await ff.inBrowser('const g = Services.wm.getMostRecentWindow("navigator:browser").gBrowser; return JSON.stringify(g.tabs.map((t) => (t.selected ? "*" : "") + t.linkedBrowser.currentURI.spec));')})`,
          );
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
        if (!offered)
          throw new Error(
            `no way to protect the site: ${JSON.stringify(await ff.exec('return document.querySelector("#site").innerText;'))}`,
          );
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
        if (!done)
          throw new Error(`not set up: ${JSON.stringify(await ff.exec(`${setUp} return { granted, runs, kind };`))}`);
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
          if (!spotted || !/not protected yet/i.test(spotted))
            throw new Error(
              `not spotted as an AI chat: ${JSON.stringify(await ff.exec('return document.querySelector("#site")?.innerText || null;'))}`,
            );
          const btn = await ff.exec(
            'const b = document.querySelector("#site button.primary"); return b ? { text: b.textContent, linkish: b.classList.contains("linkish") } : null;',
          );
          if (!btn || btn.linkish)
            throw new Error(`"Protect this site" isn't the primary button: ${JSON.stringify(btn)}`);
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
          if (!done)
            throw new Error(`not set up: ${JSON.stringify(await ff.exec(`${setUp} return { granted, runs, kind };`))}`);
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
          if (!host)
            throw new Error(
              `no corner note for a phone number under Tourniquet (box: ${JSON.stringify(await ff.exec('return document.querySelector("#prompt-textarea")?.value ?? null;'))})`,
            );
        } finally {
          await onWelcome();
          await ff.exec('await chrome.storage.local.remove("tourniquet");').catch(() => {});
          await fixture.close();
        }
      },
    );
  } finally {
    await ff.close();
  }
}

// Other test tools find Firefox the same way.
module.exports = { findFirefox };

if (require.main === module)
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
