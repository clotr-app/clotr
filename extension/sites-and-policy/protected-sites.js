// Which sites Clotr runs on, and how it spots new AI tools.
// Shared by background.js, popup/popup.js and the "What Clotr stores" page.
// This file isn't a content script itself.
//
// Out of the box Clotr only runs on AI chat sites, never on everything. It can spot an AI tool it doesn't
// already know about, but protecting one always takes your click and a browser permission prompt for that one
// site. Email and chat apps work the same way: never built in, switched on one at a time.
(() => {
  "use strict";

  // ---------- Content scripts ----------

  // The engine's files come from its list (engine/files.js), and the chat page's own scripts from the extension's
  // list (extension-files.js). Both load before this file.
  const engineFiles = globalThis.ClotrEngineFiles;
  const CONTENT_JS = [
    ...engineFiles.rules,
    ...engineFiles.detect,
    ...engineFiles.decide,
    ...globalThis.ClotrExtensionFiles.chatPage,
  ];
  const SHIPPED_JS = shippedScripts();
  const USER_SCRIPT_ID = "clotr-user-sites";

  // The release zip leaves out a held-back feature's script and drops it from the manifest, and the browser
  // won't register a list that names a missing file. So the sites people add and the email and chat apps get
  // the scripts the manifest really ships, in this order.
  function shippedScripts() {
    const shipped = globalThis.chrome?.runtime?.getManifest?.()?.content_scripts?.[0]?.js;
    if (!Array.isArray(shipped)) return CONTENT_JS;
    return CONTENT_JS.filter((file) => shipped.some((script) => isPathOf(script, file)));
  }

  // Firefox hands the manifest's script paths back in a different form than they're written in, so a path counts
  // when it ends with the script's own path. That keeps the folder, as for the engine's files under engine/.
  function isPathOf(scriptPath, file) {
    const written = String(scriptPath);
    return written === file || written.endsWith(`/${file}`);
  }

  // Logs name the kind of error only, never an address.
  function errorKind(err) {
    return err instanceof Error ? err.constructor.name : typeof err;
  }

  // ---------- Email and chat apps ----------

  // Email and chat apps, where you're writing to a person instead of an AI. None of these run by default.
  // Settings lists them, and each one only starts once you switch it on and the browser grants that site.
  // Bandage and the reply check both stay off here too, since a cover name would reach a real person, and a
  // reply is someone else's words, not an AI's.
  const EVERYDAY_SITES = [
    { name: "Gmail", kind: "email", matches: ["https://mail.google.com/*"] },
    { name: "Outlook", kind: "email", matches: ["https://outlook.live.com/*", "https://outlook.office.com/*"] },
    { name: "Yahoo Mail", kind: "email", matches: ["https://mail.yahoo.com/*"] },
    { name: "Discord", kind: "chat", matches: ["https://discord.com/*"] },
    { name: "Slack", kind: "chat", matches: ["https://app.slack.com/*"] },
    { name: "WhatsApp", kind: "chat", matches: ["https://web.whatsapp.com/*"] },
    { name: "Messenger", kind: "chat", matches: ["https://www.messenger.com/*"] },
    { name: "Microsoft Teams", kind: "chat", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*"] },
  ];

  function hostOf(pattern) {
    return new URL(pattern.replace(/\*$/, "")).hostname;
  }

  function everydaySiteFor(host) {
    const site = EVERYDAY_SITES.find((listed) => listed.matches.some((pattern) => hostOf(pattern) === host));
    return site || null;
  }

  // The addresses for the apps with these names, in the list's order. Anything that isn't a real name on
  // the list, like the broad origin Everywhere I type uses, is just ignored.
  function everydayOrigins(names) {
    if (!Array.isArray(names)) return [];
    const wanted = new Set(names.filter((name) => typeof name === "string"));
    const sites = EVERYDAY_SITES.filter((site) => wanted.has(site.name));
    return [...new Set(sites.flatMap((site) => site.matches))];
  }

  // Which listed apps the browser has already granted at least one address for.
  function grantedEverydayApps(origins) {
    const granted = new Set(Array.isArray(origins) ? origins : []);
    const sites = EVERYDAY_SITES.filter((site) => site.matches.some((pattern) => granted.has(pattern)));
    return sites.map((site) => site.name);
  }

  // Asks the browser for permission on the named apps, and returns whether it said yes. The ask has to
  // happen first, before anything else awaits, since Firefox refuses the prompt once you've awaited
  // something. Nothing is stored here: the browser remembers the grant, and the background notices and
  // turns Clotr on for those sites.
  async function requestEverydayApps(names) {
    const origins = everydayOrigins(names);
    if (!origins.length) return false;
    try {
      const yes = Boolean(await chrome.permissions.request({ origins }));
      if (yes) await notePicks(origins);
      return yes;
    } catch (err) {
      console.warn("[Clotr] could not ask for email and chat apps:", errorKind(err));
      return false;
    }
  }

  // Hands an app's permission back. There's no prompt either way, so there's nothing to say no to. If this
  // fails, the app just stays on, and the next refresh notices.
  async function removeEverydayApps(names) {
    const origins = everydayOrigins(names);
    if (!origins.length) return false;
    const forgot = await forgetPicks(origins);
    try {
      return Boolean(await chrome.permissions.remove({ origins })) || forgot;
    } catch (err) {
      console.warn("[Clotr] could not switch off email and chat apps:", errorKind(err));
      return forgot && (await stillUnlisted(origins));
    }
  }

  // Whether this is a site where you write to people rather than an AI: either one from the list, or one you
  // told Clotr isn't an AI chat yourself. Your own choice always wins over the list.
  function isEveryday(host, siteKinds = {}) {
    if (!host) return false;
    if (siteKinds[host] === "everyday") return true;
    if (siteKinds[host] === "ai") return false;
    return Boolean(everydaySiteFor(host));
  }

  // What the popup calls a page its check found chat-shaped. An email or chat app is never "spotted" as an AI
  // tool, since it has its own switch (the warning there talks about people) and the spotted list is for AI
  // tools.
  function spotKind(host, result) {
    if (result?.looksLikeAI && !everydaySiteFor(host)) return "spotted";
    return "not-ai";
  }

  // ---------- Everywhere I type ----------

  // One opt-in switch covering chat-style boxes on every https site, instead of a list to keep up. Off by
  // default. Turning it on asks for the one broad origin the manifest already lists as optional, so nothing
  // broad is ever granted up front. The dynamic script that uses it excludes every site with its own
  // dedicated setup (built-in AI tools, email and chat apps, search and support sites, and any AI site added
  // by hand), so a host never ends up running two copies of Clotr.
  const EVERYWHERE_ORIGIN = "https://*/*";
  const EVERYWHERE_SCRIPT_ID = "clotr-everywhere";

  // Whether the switch is on. The browser's grant is the record, nothing stored as "on" ahead of it.
  function everywhereGranted(origins) {
    return Array.isArray(origins) && origins.includes(EVERYWHERE_ORIGIN);
  }

  // The same shape as requestEverydayApps, for the one broad origin. The ask has to come first in the click,
  // before anything else awaits, for the same Firefox reason.
  async function requestEverywhere() {
    try {
      return Boolean(await chrome.permissions.request({ origins: [EVERYWHERE_ORIGIN] }));
    } catch (err) {
      console.warn("[Clotr] could not ask for Everywhere I type:", errorKind(err));
      return false;
    }
  }

  // While "Everywhere I type" is on, the browser's broad grant already covers every https site. Asked for one
  // more, Firefox and Chrome both answer yes at once, with no question, and add nothing to the grants they
  // list, so a switch that read only those grants stayed off. A site switched on by itself then gets noted
  // under the broad origin's own entry in `siteScopes`, and it counts as switched on by itself for as long
  // as the broad grant lasts. Only a single https site ever counts, whatever the entry holds.
  function isOneSite(pattern) {
    return typeof pattern === "string" && /^https:\/\/[\w.:-]+\/\S*$/.test(pattern);
  }

  function picksUnderEverywhere(origins, siteScopes) {
    if (!everywhereGranted(origins)) return [];
    const picks = siteScopes?.[EVERYWHERE_ORIGIN];
    if (!Array.isArray(picks)) return [];
    return picks.filter(isOneSite);
  }

  // Whether "Everywhere I type" already runs Clotr on this host by itself. It covers every https site except
  // the built-in AI tools and the search engines, which keep a switch of their own (background.js's
  // dedicatedMatches), so an email or chat app or a support chat reads On there without a grant of its own.
  function everywhereCovers(host, origins) {
    return Boolean(host) && everywhereGranted(origins) && !isSearchSite(host);
  }

  // The sites on `list` that Everywhere I type covers by itself, by name.
  function coveredByEverywhere(list, origins) {
    const covered = list.filter((site) => site.matches.some((pattern) => everywhereCovers(hostOf(pattern), origins)));
    return covered.map((site) => site.name);
  }

  // The browser's grants plus those noted sites, for code that reads what's on straight from the grants.
  function withPicks(origins, siteScopes) {
    const list = Array.isArray(origins) ? origins : [];
    return [...new Set([...list, ...picksUnderEverywhere(list, siteScopes)])];
  }

  // Runs once the browser has said yes, never before the ask. A site the browser lists itself isn't noted.
  async function notePicks(patterns) {
    try {
      const { origins = [] } = await chrome.permissions.getAll();
      if (!everywhereGranted(origins)) return;
      const missing = patterns.filter((pattern) => isOneSite(pattern) && !origins.includes(permissionFor(pattern)));
      if (!missing.length) return;
      const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
      const picks = new Set(picksUnderEverywhere(origins, siteScopes));
      if (missing.every((pattern) => picks.has(pattern))) return;
      for (const pattern of missing) picks.add(pattern);
      await chrome.storage.local.set({ siteScopes: { ...siteScopes, [EVERYWHERE_ORIGIN]: [...picks].sort() } });
    } catch (err) {
      console.warn("[Clotr] could not note a site switched on:", errorKind(err));
    }
  }

  // Takes sites off that note when they're switched off, and says whether any were on it.
  async function forgetPicks(patterns) {
    try {
      const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
      const picks = siteScopes[EVERYWHERE_ORIGIN];
      if (!Array.isArray(picks) || !picks.some((pattern) => patterns.includes(pattern))) return false;
      const rest = picks.filter((pattern) => !patterns.includes(pattern));
      const next = { ...siteScopes, [EVERYWHERE_ORIGIN]: rest };
      if (!rest.length) delete next[EVERYWHERE_ORIGIN];
      await chrome.storage.local.set({ siteScopes: next });
      return true;
    } catch (err) {
      console.warn("[Clotr] could not forget a site switched off:", errorKind(err));
      return false;
    }
  }

  // Whether the browser lists none of these, for a switch-off whose own removal failed. A site that was only
  // noted is off once the note is gone.
  async function stillUnlisted(origins) {
    const { origins: listed = [] } = await chrome.permissions.getAll().catch(() => ({}));
    return !origins.some((origin) => listed.includes(origin));
  }

  // Once the broad grant is gone, so is what it covered. Those sites are off now, and a later Everywhere I
  // type starts from nothing. The background runs this whenever a grant is taken back.
  async function dropPicksWithoutEverywhere() {
    const { origins = [] } = await chrome.permissions.getAll();
    if (everywhereGranted(origins)) return;
    const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
    if (!(EVERYWHERE_ORIGIN in siteScopes)) return;
    const next = { ...siteScopes };
    delete next[EVERYWHERE_ORIGIN];
    await chrome.storage.local.set({ siteScopes: next });
  }

  // ---------- The offer after install ----------

  // Decides what to store for the one-time offer to use Clotr on email and chat apps. A new install gets
  // "welcome", since the welcome page makes the offer there. Someone who already had Clotr gets "popup" once,
  // so the offer shows there instead. Either way it becomes "done" once answered, or once one of the apps is
  // already on.
  const OFFER_WORDS = new Set(["welcome", "popup", "done"]);

  function offerAfterInstall(reason, current, anyEverydayGranted) {
    if (reason === "install") return "welcome";
    const known = OFFER_WORDS.has(current) ? current : undefined;
    if (reason !== "update") return known;
    if (known !== undefined && known !== "popup") return known;
    return anyEverydayGranted ? "done" : "popup";
  }

  // ---------- Folding long runs in history ----------

  // Folds a long run of identical detections into one record, so pasting a huge list doesn't flood history.
  // Pasting 3,000 emails means 3,000 detections, which would push months of real history out of the
  // 10,000-record cap. Within one batch, the first `keep` records of each kind, outcome, site and way are
  // kept as they are. Anything past that becomes a single record with no fingerprint and a count. Only the
  // background calls this, and it always works the count out fresh, so a page can't hand it a fake one. A
  // single extra record is left alone, since folding it wouldn't save anything.
  function collapseBatch(events, keep = 10) {
    const groups = new Map();
    const out = [];
    for (const event of events) {
      const plain = { ...event };
      delete plain.n; // an incoming count is never kept
      const key = [plain.site, plain.type, plain.action, plain.via || "", plain.severity].join("\n");
      const group = groups.get(key) || { seen: 0, rest: null };
      groups.set(key, group);
      group.seen++;
      if (group.seen <= keep) {
        out.push(plain);
        continue;
      }
      if (group.rest) {
        group.rest.n++;
        continue;
      }
      group.rest = { at: out.length, first: plain, n: 1 };
      out.push(plain);
    }
    for (const { rest } of groups.values()) {
      if (rest && rest.n > 1) out[rest.at] = { ...rest.first, fp: "", n: rest.n };
    }
    return out;
  }

  // How many details one record actually stands for: its `n` if it's a folded record for the rest of a long
  // list, otherwise one. Every count of history goes through this, though counting distinct details or
  // repeats skips records with no fingerprint instead.
  function weight(event) {
    if (Number.isInteger(event?.n) && event.n > 1) return event.n;
    return 1;
  }

  // ---------- Built-in AI sites and match patterns ----------

  // Built-in AI sites come straight from the manifest, so there is one list.
  function builtInMatches() {
    return chrome.runtime.getManifest().content_scripts.flatMap((script) => script.matches);
  }

  // Converts an extension match pattern like "https://huggingface.co/chat/*" to a RegExp.
  function matchPatternToRegExp(pattern) {
    const parts = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!parts) return null;
    const [, scheme, host, pathPart] = parts;
    const schemeSource = scheme === "*" ? "https?" : scheme;
    const pathSource = escapeForRegExp(pathPart).replace(/\*/g, ".*");
    return new RegExp(`^${schemeSource}://${hostRegExpSource(host)}${pathSource}$`);
  }

  // "*" is any host, "*.example.com" is the host or any of its subdomains, anything else is that host alone.
  function hostRegExpSource(host) {
    if (host === "*") return "[^/]+";
    if (host.startsWith("*.")) return `([^/]+\\.)?${escapeForRegExp(host.slice(2))}`;
    return escapeForRegExp(host);
  }

  // Leaves "*" alone, since the caller turns it into a wildcard.
  function escapeForRegExp(text) {
    return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  function urlMatchesAny(url, patterns) {
    return patterns.some((pattern) => matchPatternToRegExp(pattern)?.test(url));
  }

  // The built-in match pattern(s) that cover this page, so the popup can ask the browser for exactly those
  // when they're missing. A browser can withhold a built-in site's access even though it's in
  // host_permissions, not just optional_host_permissions. Firefox does this for every install, and Chrome's
  // per-site "On click" setting does the same thing by hand.
  function builtInMatchesFor(url) {
    return builtInMatches().filter((pattern) => urlMatchesAny(url, [pattern]));
  }

  function originPattern(hostname) {
    return `https://${hostname}/*`;
  }

  // Hosts where the AI tool is only part of a bigger site, like huggingface.co/chat/*. The built-in entry
  // only covers that one section. Protecting a page there has to stay scoped to that section too, not the
  // whole host, which is what used to happen with Hugging Face.
  function sharedHosts() {
    const hostAndPath = builtInMatches().map((pattern) => /^https:\/\/([^/]+)(\/.*)$/.exec(pattern));
    const sections = hostAndPath.filter((parts) => parts && parts[2] !== "/*");
    return new Set(sections.map((parts) => parts[1]));
  }

  // What clicking "Protect this site" actually covers for this page: the whole host for a normal AI site, or
  // just its section, up to three path parts deep, on a host shared with other things.
  function protectScope(url) {
    const page = new URL(url);
    if (!sharedHosts().has(page.hostname)) return originPattern(page.hostname);
    const pathParts = page.pathname.split("/").filter(Boolean).slice(0, 3);
    if (!pathParts.length) return `https://${page.hostname}/`;
    return `https://${page.hostname}/${pathParts.join("/")}/*`;
  }

  // Browser permissions only work per host, so this is always the whole host. Where Clotr actually runs on
  // that host gets narrowed down separately, by the scopes stored in `siteScopes`.
  function permissionFor(scope) {
    return originPattern(new URL(scope.replace(/\*$/, "")).hostname);
  }

  function isWiderThanNeeded(pattern) {
    const wholeHost = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
    return Boolean(wholeHost && sharedHosts().has(wholeHost[1]));
  }

  // Where Clotr runs on the sites someone added themselves: for each granted host that isn't already built
  // in, either the sections they chose, or the whole host if the grant predates per-section scoping. Sites
  // switched on one by one under "Everywhere I type" come from its own entry (picksUnderEverywhere says why).
  //
  // Chromium ignores the path in a host permission, so a built-in section like huggingface.co/chat/* also
  // comes back from getAll() as its whole host. That copy is the manifest's, not the person's, unless they
  // chose a section on that host themselves. A whole-host grant there from before sections were recorded
  // looks the same, so in Chromium it stops counting too. Firefox keeps the path and adds no such copy, so
  // there that grant is still the person's and still listed.
  async function userSitePatterns() {
    const builtIn = new Set(builtInMatches());
    const keepsPath = Boolean(chrome.runtime.getManifest().browser_specific_settings?.gecko);
    const builtInHosts = new Set(keepsPath ? [] : builtInMatches().map(permissionFor));
    const { origins = [] } = await chrome.permissions.getAll();
    const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
    const chosenSections = (origin) => siteScopes[origin]?.length;
    const granted = origins
      .filter((origin) => !builtIn.has(origin) && origin !== EVERYWHERE_ORIGIN)
      .filter((origin) => !builtInHosts.has(origin) || chosenSections(origin))
      .flatMap((origin) => (chosenSections(origin) ? siteScopes[origin] : [origin]));
    const picked = picksUnderEverywhere(origins, siteScopes).filter((pattern) => !builtIn.has(pattern));
    return [...new Set([...granted, ...picked])].sort();
  }

  // ---------- Search engines and support chats ----------

  // Search engines, where what you type becomes a search instead of a message to an AI or a person. None of
  // these run by default. Settings lists them, and each one only starts once you switch it on and the browser
  // grants that one host. Google's other country domains (google.co.uk, google.de, and the rest) aren't
  // listed. No single match pattern reaches them without also reaching sites a wildcard like that shouldn't,
  // so only google.com is covered.
  const SEARCH_SITES = [
    { name: "Google", kind: "search", matches: ["https://www.google.com/*"] },
    { name: "Bing", kind: "search", matches: ["https://www.bing.com/*"] },
    { name: "DuckDuckGo", kind: "search", matches: ["https://duckduckgo.com/*"] },
    { name: "Brave Search", kind: "search", matches: ["https://search.brave.com/*"] },
    { name: "Startpage", kind: "search", matches: ["https://www.startpage.com/*"] },
    { name: "Ecosia", kind: "search", matches: ["https://www.ecosia.org/*"] },
    { name: "Yahoo Search", kind: "search", matches: ["https://search.yahoo.com/*"] },
  ];

  // Support chat widgets a company embeds on its own site. Each one's actual conversation box loads in an
  // iframe at an address the widget's maker controls, the same address wherever a company puts the widget,
  // so switching one on only ever asks for that one host and then covers it everywhere that widget turns up.
  // None of these run by default either.
  // LiveChat only covers sites that embed it as its own iframe (one of the two ways LiveChat can be added).
  // Its other, script-only embed doesn't have one fixed address to ask for.
  // Zendesk, HubSpot and Olark are left out. Their own CSP guidance asks integrators to allow a whole family
  // of hosts (`*.zendesk.com`/`*.zopim.com`, `*.hubspot.com`, `*.olark.com`), not one fixed address, and
  // HubSpot's conversation host also differs by the account's hosting region, so none of the three fit the
  // one-host rule.
  const SUPPORT_SITES = [
    { name: "Intercom", kind: "support", matches: ["https://widget.intercom.io/*"] },
    { name: "Drift", kind: "support", matches: ["https://widget.drift.com/*"] },
    { name: "Freshchat", kind: "support", matches: ["https://wchat.freshchat.com/*"] },
    { name: "Crisp", kind: "support", matches: ["https://client.crisp.chat/*"] },
    { name: "LiveChat", kind: "support", matches: ["https://secure.livechatinc.com/*"] },
    { name: "Tawk.to", kind: "support", matches: ["https://embed.tawk.to/*"] },
    { name: "Tidio", kind: "support", matches: ["https://widget-v4.tidiochat.com/*"] },
  ];

  // Search engines and support-chat widgets together, so one lookup covers every site in either list without
  // touching how EVERYDAY_SITES (email and chat apps) is looked up, since those two keep their own wording.
  const MORE_SITES = [...SEARCH_SITES, ...SUPPORT_SITES];

  function moreSiteFor(host) {
    const site = MORE_SITES.find((listed) => listed.matches.some((pattern) => hostOf(pattern) === host));
    return site || null;
  }

  function isSearchSite(host) {
    return moreSiteFor(host)?.kind === "search";
  }

  function isSupportSite(host) {
    return moreSiteFor(host)?.kind === "support";
  }

  // The same idea as everydayOrigins, for the search and support lists.
  function moreSiteOrigins(names) {
    if (!Array.isArray(names)) return [];
    const wanted = new Set(names.filter((name) => typeof name === "string"));
    const sites = MORE_SITES.filter((site) => wanted.has(site.name));
    return [...new Set(sites.flatMap((site) => site.matches))];
  }

  function grantedMoreSites(origins) {
    const granted = new Set(Array.isArray(origins) ? origins : []);
    const sites = MORE_SITES.filter((site) => site.matches.some((pattern) => granted.has(pattern)));
    return sites.map((site) => site.name);
  }

  // The same shape as requestEverydayApps and removeEverydayApps, for the search and support lists.
  async function requestMoreSites(names) {
    const origins = moreSiteOrigins(names);
    if (!origins.length) return false;
    try {
      const yes = Boolean(await chrome.permissions.request({ origins }));
      if (yes) await notePicks(origins);
      return yes;
    } catch (err) {
      console.warn("[Clotr] could not ask for a search or support site:", errorKind(err));
      return false;
    }
  }

  async function removeMoreSites(names) {
    const origins = moreSiteOrigins(names);
    if (!origins.length) return false;
    const forgot = await forgetPicks(origins);
    try {
      return Boolean(await chrome.permissions.remove({ origins })) || forgot;
    } catch (err) {
      console.warn("[Clotr] could not switch off a search or support site:", errorKind(err));
      return forgot && (await stillUnlisted(origins));
    }
  }

  // ---------- What other files use ----------

  globalThis.ClotrSites = {
    CONTENT_JS: SHIPPED_JS,
    USER_SCRIPT_ID,
    EVERYWHERE_ORIGIN,
    EVERYWHERE_SCRIPT_ID,
    requestEverywhere,
    everywhereGranted,
    picksUnderEverywhere,
    everywhereCovers,
    coveredByEverywhere,
    withPicks,
    notePicks,
    forgetPicks,
    dropPicksWithoutEverywhere,
    EVERYDAY_SITES,
    everydaySiteFor,
    everydayOrigins,
    grantedEverydayApps,
    requestEverydayApps,
    removeEverydayApps,
    SEARCH_SITES,
    SUPPORT_SITES,
    MORE_SITES,
    moreSiteFor,
    isSearchSite,
    isSupportSite,
    grantedMoreSites,
    requestMoreSites,
    removeMoreSites,
    offerAfterInstall,
    isEveryday,
    spotKind,
    collapseBatch,
    weight,
    builtInMatches,
    builtInMatchesFor,
    matchPatternToRegExp,
    urlMatchesAny,
    originPattern,
    protectScope,
    permissionFor,
    isWiderThanNeeded,
    userSitePatterns,
  };
})();
