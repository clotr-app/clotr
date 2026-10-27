// "Rate Clotr" picks the right store listing's reviews page for the browser it's running in: Chrome and Brave
// share the Chrome Web Store (Brave's user agent reads as Chrome), Edge gets its own Add-ons page, and Firefox
// gets AMO's reviews page.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/rate.js");
const { Rate } = globalThis.Clotr;

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const BRAVE_UA = CHROME_UA; // Brave sends the same Chrome user agent; navigator.brave is the only tell.
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";

test("Chrome and Brave both get the Chrome Web Store reviews link", () => {
  assert.equal(Rate.rateUrl(CHROME_UA), Rate.STORE_URLS.chrome);
  assert.equal(Rate.rateUrl(BRAVE_UA), Rate.STORE_URLS.chrome);
  assert.match(Rate.STORE_URLS.chrome, /^https:\/\/chromewebstore\.google\.com\/detail\/.+\/reviews$/);
});

test("Edge gets the Edge Add-ons link", () => {
  assert.equal(Rate.rateUrl(EDGE_UA), Rate.STORE_URLS.edge);
  assert.match(Rate.STORE_URLS.edge, /^https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\//);
});

test("Firefox gets AMO's reviews link", () => {
  assert.equal(Rate.rateUrl(FIREFOX_UA), Rate.STORE_URLS.firefox);
  assert.match(Rate.STORE_URLS.firefox, /^https:\/\/addons\.mozilla\.org\/firefox\/addon\/.+\/reviews\/$/);
});

test("an unrecognized user agent falls back to the Chrome Web Store", () => {
  assert.equal(Rate.rateUrl("something else entirely"), Rate.STORE_URLS.chrome);
});

// The welcome page's pin steps use the same test, so its wording and the store link always agree.
test("browserFor names the browser family the same way rateUrl picks a store", () => {
  assert.equal(Rate.browserFor(CHROME_UA), "chrome");
  assert.equal(Rate.browserFor(BRAVE_UA), "chrome");
  assert.equal(Rate.browserFor(EDGE_UA), "edge");
  assert.equal(Rate.browserFor(FIREFOX_UA), "firefox");
  assert.equal(Rate.browserFor("something else entirely"), "chrome");
});
