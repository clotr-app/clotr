// The guided setup page (helper.html) with a PIN set: once the 10 minutes after the PIN run out, an open page locks
// again, and its buttons check the time themselves, so Tourniquet can't be turned off or the PIN changed without it.
// Run from the repo root: node --test tests/helper-page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeNode, loadPage, settle } = require("./fake-page.js");

// Not a real PIN record: the page only needs to know one is set.
const FAKE_LOCK = { salt: "00".repeat(16), iterations: 1, hash: "ab".repeat(32) };

async function unlockedPage(until = Date.now() + 60_000, globals = {}) {
  const tile = Object.assign(new FakeNode("input"), { value: "child", checked: true });
  const page = loadPage(["patterns.js", "sites.js", "helper-core.js", "helper.js"], {
    local: { lock: FAKE_LOCK, tourniquet: { for: "child", since: Date.now() - 86_400_000 } },
    session: { unlockedUntil: until },
    manifest: { clotr_features: { tourniquet: true } },
    selectors: {
      '#who input[name="who"]:checked': tile,
      '#who input[value="child"]': tile,
      '#who input[name="who"]': tile,
      ".tq-map-lines": new FakeNode("svg"),
      ".tq-them": new FakeNode("div"),
    },
    globals: { ClotrEverydayOffer: { mount: async () => null }, ...globals },
  });
  await settle();
  return page;
}

test("helper page: unlocked within the 10 minutes, its steps show", async () => {
  const page = await unlockedPage();
  assert.equal(page.$("steps").hidden, false);
  assert.equal(page.$("unlock").hidden, true);
  assert.equal(page.$("tq-off").hidden, false);
});

test("helper page: once the 10 minutes are up, Turn it off asks for the PIN instead", async () => {
  const page = await unlockedPage();
  page.session.data.unlockedUntil = Date.now() - 1; // ran out, with nothing on the page told
  await page.$("tq-off").fire("click");
  await page.$("tq-off").fire("click");
  await settle();
  assert.ok(page.local.data.tourniquet, "Tourniquet stays on");
  assert.equal(page.$("steps").hidden, true, "the steps are hidden again");
  assert.equal(page.$("unlock").hidden, false, "the PIN box shows");
});

test("helper page: once the 10 minutes are up, Turn on and Change the PIN do nothing either", async () => {
  const page = await unlockedPage();
  page.session.data.unlockedUntil = Date.now() - 1;
  const record = page.local.data.tourniquet;
  delete page.local.data.tourniquet;
  await page.$("tq-on").fire("click");
  assert.equal(page.local.data.tourniquet, undefined, "Turn on didn't write a record");
  page.local.data.tourniquet = record;
  page.$("pin").value = "4826";
  await page.$("lock-set").fire("click");
  assert.deepEqual(page.local.data.lock, FAKE_LOCK, "the PIN is unchanged");
});

test("helper page: the unlock window ending in session storage locks an open page", async () => {
  const page = await unlockedPage();
  await page.session.set({ unlockedUntil: Date.now() - 1 });
  await settle();
  assert.equal(page.$("steps").hidden, true);
  assert.equal(page.$("unlock").hidden, false);
});

// The page reads a clock that moves only when the test moves it, so loading the page on a busy machine can't use up
// the 80 ms before the first look. The timer that ends them is a real one.
test("helper page: an open page locks itself when the 10 minutes run out", async () => {
  let now = Date.now();
  const PageDate = class extends Date {
    static now() {
      return now;
    }
  };
  const page = await unlockedPage(now + 80, { Date: PageDate });
  assert.equal(page.$("steps").hidden, false);
  now += 250;
  await new Promise((r) => setTimeout(r, 250));
  await settle();
  assert.equal(page.$("steps").hidden, true);
  assert.equal(page.$("unlock").hidden, false);
});
