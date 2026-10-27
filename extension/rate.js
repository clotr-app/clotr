// The "Rate Clotr" link, in the popup's footer and in What's new. It only opens the store listing's reviews
// page for the browser it's running in, nothing else: no prompt, no pop-up, and no record of the click.
// Classic script, so it shares code through globalThis.Clotr like the content scripts do.
"use strict";

(function () {
  // Kept in step with CHROMEWEBSTORE.md, README.md and website-test/download.html.
  const STORE_URLS = {
    chrome: "https://chromewebstore.google.com/detail/gkgpgejhhmmhklaghdnbjbalkmpjnmab/reviews",
    edge: "https://microsoftedge.microsoft.com/addons/detail/hbangnmofjeaieaeamlncpcfmhbclbkj",
    firefox: "https://addons.mozilla.org/firefox/addon/clotr-clot-your-data-leaks/reviews/",
  };

  const msg =
    globalThis.Clotr?.msg ||
    ((_key, english, ...subs) => english.replace(/\$(\d)/g, (_match, n) => String(subs[n - 1] ?? "")));

  // Which browser family this is: "firefox", "edge" or "chrome". Brave's user agent reads as Chrome, so it
  // counts as Chrome, which is right for both its store and its menus. The welcome page's pin steps use it too.
  // Takes a user agent string so it can be tested without a browser.
  function browserFor(ua) {
    const s = typeof ua === "string" ? ua : (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/\bFirefox\//.test(s)) return "firefox";
    if (/\bEdg\//.test(s)) return "edge";
    return "chrome";
  }

  // Only Firefox and Edge need their own store link; Brave shares the Chrome Web Store.
  function rateUrl(ua) {
    return STORE_URLS[browserFor(ua)];
  }

  // Fills the placeholder element with this id. Safe to call more than once; only the first mount does
  // anything, so a page can't end up with two links in the same spot.
  function mount(placeholderId) {
    const host = document.getElementById(placeholderId);
    if (!host || host.dataset.rateMounted) return;
    host.dataset.rateMounted = "1";
    const link = document.createElement("a");
    link.className = "link rate-link";
    link.target = "_blank";
    link.rel = "noopener";
    link.href = rateUrl();
    link.textContent = msg("rate_rateClotr", "Rate Clotr");
    host.append(link);
  }

  globalThis.Clotr = { ...(globalThis.Clotr || {}), Rate: { mount, rateUrl, browserFor, STORE_URLS } };

  if (typeof document !== "undefined") for (const id of ["rate-root", "rate-root-whatsnew"]) mount(id);
})();
