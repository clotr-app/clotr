// Clotr for Windows' own use of Tourniquet: the extension's own rules
// (extension/sites.js, in the engine bundle for Clotr for Windows alone) turned into the responses actually in
// force and which kinds they hold firmly, the same way the browser's background.js does before a page ever sees
// them. There's no team policy on Windows, so Tourniquet is the only thing here that can raise a floor.
"use strict";

(() => {
  const Sites = globalThis.ClotrSites || {};

  // Tourniquet as a policy, or null while it's off (sites.js's tourniquetPolicy already checks the 30 days).
  function policyFor(settings, now = Date.now()) {
    return Sites.tourniquetPolicy ? Sites.tourniquetPolicy(settings?.tourniquet, now) : null;
  }

  // The word in force right now ("child", "adult" or "after_scam"), or null.
  function wordFor(settings, now = Date.now()) {
    const clean = Sites.cleanTourniquet ? Sites.cleanTourniquet(settings?.tourniquet, now) : null;
    return clean?.for || null;
  }

  // The settings actually in force: Tourniquet's floor applied over the person's own choices, whichever is
  // stricter winning for each kind, same as the browser. Only responses and largeText can change.
  function effectiveSettings(settings, now = Date.now()) {
    const policy = policyFor(settings, now);
    if (!policy || !Sites.applyPolicy) return settings;
    const applied = Sites.applyPolicy({ responses: settings?.responses || {} }, policy);
    return { ...settings, responses: applied.responses, largeText: applied.largeText || settings?.largeText === true };
  }

  // Which kinds Tourniquet holds firmly right now: a warning for one of these never offers to loosen it.
  function firmIds(settings, now = Date.now()) {
    const policy = policyFor(settings, now);
    return new Set(policy && Sites.firmKinds ? Sites.firmKinds(policy) : []);
  }

  globalThis.ClotrTourniquet = { policyFor, wordFor, effectiveSettings, firmIds };
})();
