// Extension check's core logic: does an extension installed in this browser reach your AI chats? This is pure,
// with no DOM, no chrome.* calls, and nothing network-facing, so extcheck.js and other hosts can all give the
// same answer from the same record.
//
// A record is the shape a host builds from what it can see: `{ id, name, browser, profile, enabled,
// installType, hosts, scripts, warnings, self }`. `hosts` is the host access granted right now. `scripts` is
// content-script match patterns, only filled in on Windows, since an extension can't normally see another
// extension's content scripts; `warnings`, the browser's own permission-warning sentences, covers that gap on
// other platforms. `self` says whether a record is Clotr's own extension, set by the caller since only it
// knows its own id.
(() => {
  "use strict";

  // Only an http(s) site, or the real wildcard scheme, can ever reach a chat. A non-web scheme, like an
  // extension's own moz-extension: URL, never does, even if it ends up in `hosts`.
  const SITE_SCHEME = /^(https?|\*):\/\//;
  function isSitePattern(pattern) {
    return typeof pattern === "string" && (pattern === "<all_urls>" || SITE_SCHEME.test(pattern));
  }
  function hostOf(pattern) {
    if (!isSitePattern(pattern)) return null;
    const m = /^(?:https?|\*):\/\/([^/]+)/.exec(pattern);
    return m ? m[1] : null;
  }

  // Whether a pattern covers every https site, either as the literal "<all_urls>" or a scheme-wide wildcard
  // host like "*://*/*".
  function coversAllSites(pattern) {
    return pattern === "<all_urls>" || hostOf(pattern) === "*";
  }

  // Whether an extension's own host, plain or a "*.example.com" wildcard, covers one AI site's plain host.
  function hostCoversAiHost(extHost, aiHost) {
    if (!extHost || !aiHost) return false;
    if (extHost === aiHost) return true;
    if (!extHost.startsWith("*.")) return false;
    const base = extHost.slice(2);
    return aiHost === base || aiHost.endsWith(`.${base}`);
  }

  // Maps each plain hostname ai-sites.json covers to its tool name. The entries never overlap in practice, so
  // it doesn't matter which one wins if they ever did.
  function aiHosts(aiSites) {
    const hosts = new Map();
    for (const site of Array.isArray(aiSites) ? aiSites : []) {
      for (const pattern of Array.isArray(site?.matches) ? site.matches : []) {
        const host = hostOf(pattern);
        if (host && !hosts.has(host)) hosts.set(host, site.name);
      }
    }
    return hosts;
  }

  function patternsOf(record) {
    return [
      ...(Array.isArray(record?.hosts) ? record.hosts : []),
      ...(Array.isArray(record?.scripts) ? record.scripts : []),
    ].filter(isSitePattern);
  }

  // Which of ai-sites.json's tools a record's host access or warnings name. A tool counts as reached if a
  // pattern matches its host, or if a warning mentions that host as plain text; host names aren't translated,
  // so this still works whatever language the browser writes the warning in.
  function aiSitesReached(record, aiSites) {
    const hosts = aiHosts(aiSites);
    const patterns = patternsOf(record);
    const warnings = Array.isArray(record?.warnings) ? record.warnings : [];
    const names = new Set();
    for (const [host, name] of hosts) {
      const reached = patterns.some((p) => hostCoversAiHost(hostOf(p), host)) || warnings.some((w) => w.includes(host));
      if (reached) names.add(name);
    }
    return [...names];
  }

  // Returns one of "all", "ai", "some", "none", or "off". `words.allSites` is the all-sites warning sentence in
  // this browser's own language, taken from a made-up <all_urls> manifest so the comparison works everywhere.
  function reachOf(record, aiSites, words = {}) {
    if (!record || record.enabled === false) return "off";
    const patterns = patternsOf(record);
    const warnings = Array.isArray(record.warnings) ? record.warnings : [];
    const allSites = typeof words?.allSites === "string" ? words.allSites : null;

    if (patterns.some(coversAllSites) || (allSites !== null && warnings.includes(allSites))) return "all";
    if (aiSitesReached(record, aiSites).length) return "ai";
    if (patterns.length || warnings.length) return "some";
    return "none";
  }

  // Says whether an extension is worth a look, for only two reasons: it's on the reported list by id, or it
  // was installed by another program ("sideload"). Clotr is never worth a look, no matter what else is true.
  function worthALookOf(record, reportedExtensions) {
    if (!record || record.self) return null;
    const entries = Array.isArray(reportedExtensions?.entries) ? reportedExtensions.entries : [];
    const report = entries.find((e) => e?.id === record.id);
    if (report) return { reason: "reported", report };
    if (record.installType === "sideload") return { reason: "sideload" };
    return null;
  }

  // A plain note rather than a flag, for an extension loaded by hand (development) or added by an organization
  // (admin).
  function installNoteOf(record) {
    if (record?.installType === "development") return "development";
    if (record?.installType === "admin") return "admin";
    return null;
  }

  // Builds the result shape: one entry per extension, with its reach, which AI tools it reaches, whether it's
  // worth a look, and its install note, plus the counts the results page heads with.
  function checkExtensions(records, { aiSites, reportedExtensions, words } = {}) {
    const entries = (Array.isArray(records) ? records : []).map((record) => {
      const reach = reachOf(record, aiSites, words);
      return {
        id: record?.id,
        name: record?.name,
        browser: record?.browser,
        enabled: record?.enabled !== false,
        installType: record?.installType,
        self: Boolean(record?.self),
        reach,
        aiSites: reach === "ai" || reach === "all" ? aiSitesReached(record, aiSites) : [],
        worthALook: worthALookOf(record, reportedExtensions),
        note: installNoteOf(record),
      };
    });
    return {
      total: entries.length,
      entries,
      canReadAi: entries.filter((e) => e.reach === "all" || e.reach === "ai").length,
      worthALook: entries.filter((e) => e.worthALook),
      some: entries.filter((e) => e.reach === "some").length,
      off: entries.filter((e) => e.reach === "off").length,
      none: entries.filter((e) => e.reach === "none").length,
    };
  }

  globalThis.Clotr = {
    ...globalThis.Clotr,
    reachOf,
    aiSitesReached,
    worthALookOf,
    installNoteOf,
    checkExtensions,
  };
})();
