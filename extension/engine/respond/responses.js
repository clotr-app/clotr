// What Clotr does about each kind it finds: Block, Warn or Log, and the person's own choice for each.
// detect.js hands these on to pages and apps, and decide.js reads them.
(() => {
  "use strict";

  const { PATTERNS } = globalThis.Clotr;

  // ---------- What to do about a detection ----------
  // A response is Block (a dialog that holds the message until the person answers), Warn (a corner notice that
  // holds nothing) or Log (counted quietly). An "off" saved by an older version reads as "log". The `responses`
  // storage key maps a pattern ID to the person's own pick.
  const RESPONSES = ["block", "warn", "log"];
  // Nothing blocks by default; the person has to choose Block themselves. Severity still lives on the pattern
  // for the dashboard and badge, but it doesn't change the default response. A new kind can start out quiet,
  // counted but not shown, though nothing starts out blocking.
  const DEFAULT_RESPONSE = { high: "warn", medium: "warn", low: "warn" };

  function defaultResponse(patternId) {
    const pattern = PATTERNS.find((each) => each.id === patternId);
    return pattern?.start === "log" ? "log" : DEFAULT_RESPONSE[pattern?.severity] || "warn";
  }

  function responseFor(patternId, overrides) {
    const response = overrides?.[patternId] === "off" ? "log" : overrides?.[patternId];
    return RESPONSES.includes(response) ? response : defaultResponse(patternId);
  }

  // A team's policy sets a floor, not a ceiling: between two responses, the stricter one wins, so a required
  // "warn" can never downgrade someone's own "block". An unrecognized response counts as "warn", the safe
  // middle ground, rather than being rejected.
  function stricter(a, b) {
    const rank = (response) => (response === "block" ? 0 : response === "log" ? 2 : 1);
    const known = (response) => (RESPONSES.includes(response) ? response : "warn");
    return rank(a) <= rank(b) ? known(a) : known(b);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, RESPONSES, defaultResponse, responseFor, stricter };
})();
