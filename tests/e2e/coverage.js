// Coverage for the browser suite, opt-in: npm run test:e2e -- --coverage (written to output/coverage.json), or
// CLOTR_E2E_COVERAGE=<file>. tools/coverage.js --e2e runs it and merges the result with the unit tests' own.
// lib.js only loads this file when one of those is set, so an ordinary run is exactly as before.
//
// V8's precise coverage has to be on before a script runs, or the code that ran first (a content script's top level,
// say) never shows up. Puppeteer attaches to every new page, frame and worker paused, sets it up, then lets it run, so
// the Profiler commands go out on puppeteer's own session the moment it's created, ahead of its "run" command.
// Puppeteer lets go of service workers straight away, so coverage there starts on the session lib.js opens on
// Clotr's worker, or on a new one for a worker that starts later; their start-up code runs in the unit tests anyway. A target's numbers vanish with it, so every session is read before a
// page closes or navigates, before a browser closes, and every couple of seconds for anything that goes on its own.
// Each read resets V8's counts, so the reads are folded together, a line that ran in any of them counting as run.
"use strict";

const fs = require("fs");
const { Connection, CDPSessionEvent, CdpPage, CdpBrowser, Page } = require("puppeteer-core");
const { lineCoverage, merge, browserFile, readSource, summary, ROOT } = require("../../tools/coverage.js");

// The target types whose code starts under puppeteer's pause: tabs' pages, out-of-process frames and dedicated workers.
const PAUSED_TYPES = new Set(["page", "iframe", "worker", "shared_worker"]);
const START = ["Profiler.startPreciseCoverage", { callCount: true, detailed: true }];

const byFile = {};
const sessions = new Set();
const typeOf = new Map(); // session id -> target type, read off the attach message before puppeteer handles it
const dirs = new Map(); // extension ID -> the folder that browser loaded it from

function start(session) {
  sessions.add(session);
  session.send("Profiler.enable").catch(() => {});
  session.send(...START).catch(() => sessions.delete(session));
}

// One read's scripts, folded into byFile. A script that ran nothing since the last read is skipped before any work.
function fold(result) {
  for (const entry of result) {
    if (!entry.url.startsWith("chrome-extension://")) continue;
    if (!entry.functions.some((f) => f.ranges.some((r) => r.count > 0))) continue;
    const file = browserFile(entry.url, dirs);
    if (file) byFile[file] = merge(byFile[file], lineCoverage(readSource(file), entry.functions));
  }
}

let reading = null;
function snapshot() {
  // One read at a time: a second one asked for meanwhile waits for it and then reads again.
  reading = (reading || Promise.resolve()).then(() =>
    Promise.all(
      [...sessions].map(async (s) => {
        if (s.detached) {
          sessions.delete(s);
          return;
        }
        try {
          // A target that's busy closing can leave a read unanswered, and a page's close waits on this.
          const read = s.send("Profiler.takePreciseCoverage");
          const timeout = new Promise((_, reject) => setTimeout(reject, 5000, new Error("no answer")).unref());
          fold((await Promise.race([read, timeout])).result);
        } catch {
          if (s.detached) sessions.delete(s);
        }
      }),
    ),
  );
  return reading;
}

// Hooks into puppeteer. Its transport handler is bound when a connection is made, so these go in before any launch.
const onMessage = Connection.prototype.onMessage;
Connection.prototype.onMessage = function (message) {
  if (message.includes('"Target.attachedToTarget"')) {
    const o = JSON.parse(message);
    if (o.method === "Target.attachedToTarget") typeOf.set(o.params.sessionId, o.params.targetInfo.type);
  }
  return onMessage.call(this, message);
};
const emit = Connection.prototype.emit;
Connection.prototype.emit = function (type, event) {
  if (type === CDPSessionEvent.SessionAttached) {
    if (PAUSED_TYPES.has(typeOf.get(event.id()))) start(event);
    typeOf.delete(event.id());
  }
  return emit.call(this, type, event);
};
const close = CdpPage.prototype.close;
CdpPage.prototype.close = async function (...args) {
  await snapshot();
  return close.apply(this, args);
};
CdpPage.prototype.goto = async function (...args) {
  await snapshot();
  return Page.prototype.goto.apply(this, args);
};
const closeBrowser = CdpBrowser.prototype.close;
CdpBrowser.prototype.close = async function (...args) {
  await snapshot();
  return closeBrowser.apply(this, args);
};
setInterval(snapshot, 2000).unref();

// Every launched browser: which folder its copy of Clotr came from, the session lib.js already holds on that copy's
// service worker (a second session on it, made alongside, closed the worker under Brave), then a session of its own
// on each service worker that starts later.
function watch(browser, swTarget, swSession, ext) {
  dirs.set(new URL(swTarget.url()).host, Array.isArray(ext) ? ext[0] : ext);
  start(swSession);
  browser.on("targetcreated", async (target) => {
    if (target.type() !== "service_worker") return;
    try {
      start(await target.createCDPSession());
    } catch {
      // A worker that stopped before the session came up has nothing to read.
    }
  });
}

// Writes the folded lines for tools/coverage.js and prints the browser suite's own share.
async function save(file) {
  await snapshot();
  fs.writeFileSync(file, JSON.stringify({ lines: byFile }));
  const s = summary(ROOT, byFile);
  console.log(
    `\nLines of extension/ the browser suite ran: ${((100 * s.covered) / s.total).toFixed(1)}% ` +
      `(${s.covered} of ${s.total}), written to ${file}`,
  );
}

module.exports = { watch, save, snapshot };
