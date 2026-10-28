"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { closeFirefox, withTimeout } = require("./e2e/firefox.js");

test("Firefox smoke checks stop waiting when a check never settles", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "FF test"), /FF test timed out after 10 ms/);
});

test("Firefox close timeout kills the browser process", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = once(child, "exit");
  t.after(() => child.kill());

  const err = await closeFirefox(
    {
      close: () => new Promise(() => {}),
      process: () => child,
    },
    10,
  );

  assert.match(err.message, /Firefox close timed out after 10 ms/);
  await withTimeout(exited, 1500, "the test browser process");
  assert.notEqual(child.exitCode, null);
});
