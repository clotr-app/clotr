// Extension check's page. It asks the browser once for the optional `management` permission, uses
// extcheck-core.js's reachOf() to see which installed extensions can read this computer's pages, shows the
// results, and gives the permission back. It never turns an extension off or uninstalls one, and the only page
// it opens besides this one is the browser's own extensions page. Nothing it reads gets stored: the list lives
// on this page until it's closed.
"use strict";

(() => {
  const { msg, checkExtensions, reportedExtensions } = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  };
  // Splits one key's value into its separate sentences. The word table and the Spanish strings use line
  // breaks; this page's English fallbacks use " / " instead.
  const parts = (key, english, ...subs) => msg(key, english, ...subs).split(/ \/ |\n/);

  const isFirefox = Boolean(chrome.runtime.getManifest().browser_specific_settings?.gecko);

  // The browser's own permission-warning sentence, the same fixed words Chrome's and Firefox's own permission
  // lists use. I never run this through Clotr's translation, since the browser shows its prompt in its own UI
  // language rather than Clotr's, and a translated guess would likely be wrong.
  const PERMISSION_SENTENCE = isFirefox
    ? "Monitor extension usage and manage themes"
    : "Manage your apps, extensions, and themes";

  // A friendly name for this browser, never shown next to an extension's own name since there's only ever one
  // browser on this page.
  function browserName() {
    if (isFirefox) return "Firefox";
    if (typeof navigator !== "undefined" && navigator.brave) return "Brave";
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/\bEdg\//.test(ua)) return "Edge";
    return "Chrome";
  }

  function joinNames(names) {
    try {
      return new Intl.ListFormat(chrome.i18n.getUILanguage(), { type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  // ---------- Reading the browser's own list ----------

  // Builds a made-up <all_urls> manifest and reads it back through the browser's own permission-warnings call,
  // so the all-sites sentence reachOf() compares against is the real one, in this browser's own language.
  async function allSitesWarning() {
    try {
      const manifestJson = JSON.stringify({
        manifest_version: 3,
        name: "x",
        version: "1",
        host_permissions: ["<all_urls>"],
      });
      const warnings = await chrome.management.getPermissionWarningsByManifest(manifestJson);
      return warnings?.[0] || null;
    } catch {
      return null;
    }
  }

  async function warningsFor(id) {
    try {
      return await chrome.management.getPermissionWarningsById(id);
    } catch {
      return [];
    }
  }

  async function aiSitesList() {
    try {
      return await (await fetch(chrome.runtime.getURL("ai-sites.json"))).json();
    } catch {
      return [];
    }
  }

  // Reads every installed extension, leaving out themes and apps, and normalizes each one to the shape
  // extcheck-core.js and Clotr for Windows share. `scripts` stays empty here, since a browser extension can't
  // see another extension's content scripts; `warnings` carries that information instead.
  async function readRecords() {
    const [all, allSites, aiSites] = await Promise.all([chrome.management.getAll(), allSitesWarning(), aiSitesList()]);
    const selfId = chrome.runtime.id;
    const browser = browserName();
    const records = await Promise.all(
      all
        .filter((e) => e.type === "extension")
        .map(async (e) => ({
          id: e.id,
          name: e.name,
          browser,
          profile: null,
          enabled: e.enabled !== false,
          installType: e.installType,
          hosts: Array.isArray(e.hostPermissions) ? e.hostPermissions : [],
          scripts: [],
          warnings: await warningsFor(e.id),
          self: e.id === selfId,
        })),
    );
    return { records, aiSites, words: { allSites } };
  }

  // ---------- The ask, the read, the hand-back ----------

  // Asks for the permission first thing, in the click's own turn, since Firefox refuses a prompt that comes
  // after any await and the page could lose focus as it opens. The permission goes back as soon as the list
  // is read, whether that worked or not.
  async function startCheck() {
    $("start-check").disabled = true;
    $("reading-note").hidden = true;
    let granted;
    try {
      granted = await chrome.permissions.request({ permissions: ["management"] });
    } catch {
      granted = false;
    }
    if (!granted) {
      $("start-check").disabled = false;
      showSaidNo();
      return;
    }
    $("reading-note").hidden = false;
    try {
      const { records, aiSites, words } = await readRecords();
      showResults(checkExtensions(records, { aiSites, reportedExtensions, words }));
    } catch (err) {
      console.warn("[Clotr] extension check couldn't read the list:", err instanceof Error ? err.message : err);
      $("start-check").disabled = false;
      showSaidNo();
    } finally {
      $("reading-note").hidden = true;
      await chrome.permissions.remove({ permissions: ["management"] }).catch(() => {});
    }
  }

  // ---------- Showing the results ----------

  // Chrome, Edge, and Brave can jump straight to an extension's own card through chrome://extensions?id=.
  // Firefox can't open about:addons from an extension, so it gets written-out steps instead.
  function openExtensionsPage(id) {
    chrome.tabs.create({ url: `chrome://extensions/?id=${id}` }).catch(() => {});
  }

  function stepsList(key, english) {
    return el(
      "ol",
      {},
      parts(key, english).map((s) => el("li", { textContent: s })),
    );
  }

  function removeAction(id, short) {
    if (isFirefox) {
      return el("details", { className: "ec-remove-steps" }, [
        el("summary", {
          textContent: short
            ? msg("ec_removeShort", "Where to remove it")
            : msg("ec_remove", "Show me where to remove it"),
        }),
        stepsList(
          "ec_stepsFirefox",
          "Open Firefox's menu, then Add-ons and themes, then Extensions. / Click an extension, then its Permissions tab. / Look for \"Access your data for all websites\" or an AI site like chatgpt.com. / Remove any you don't use or don't recognize.",
        ),
      ]);
    }
    return el("button", {
      className: short ? "as-link ec-remove" : "btn ec-remove",
      type: "button",
      textContent: short ? msg("ec_removeShort", "Where to remove it") : msg("ec_remove", "Show me where to remove it"),
      onclick: () => openExtensionsPage(id),
    });
  }

  function reachLine(entry) {
    if (entry.reach === "all") return msg("ec_all", "Can read every site, AI chats included");
    if (entry.reach === "ai") return msg("ec_sites", "Can read $1", joinNames(entry.aiSites));
    return msg("ec_some", "Can read some sites; your browser's page lists them");
  }

  function noteLine(entry) {
    if (entry.note === "development") return msg("ec_dev", "Loaded by hand, in developer mode.");
    if (entry.note === "admin") return msg("ec_admin", "Added by your organization.");
    return null;
  }

  function worthCard(entry) {
    const kids = [
      el("h4", { className: "ec-name", textContent: entry.name }),
      el("p", { className: "ec-reach", textContent: reachLine(entry) }),
    ];
    if (entry.worthALook.reason === "reported") {
      const { report } = entry.worthALook;
      kids.push(
        el("p", {
          className: "ec-reason",
          textContent: msg("ec_reported", "Reported by $1 on $2 for collecting AI chats.", report.source, report.date),
        }),
        el("p", {}, [
          el("a", {
            href: report.url,
            target: "_blank",
            rel: "noopener noreferrer",
            textContent: msg("ec_readReport", "Read the report"),
          }),
        ]),
      );
    } else {
      kids.push(
        el("p", {
          className: "ec-reason",
          textContent: msg("ec_sideload", "Installed by another program, not from a store."),
        }),
      );
    }
    const note = noteLine(entry);
    if (note) kids.push(el("p", { className: "muted", textContent: note }));
    kids.push(removeAction(entry.id, false));
    const card = el("article", { className: "ec-card-item worth" }, kids);
    card.dataset.id = entry.id;
    return card;
  }

  function readRow(entry) {
    const kids = [
      el("b", { className: "ec-name", textContent: entry.name }),
      el("span", { className: "ec-reach", textContent: reachLine(entry) }),
    ];
    const note = noteLine(entry);
    if (note) kids.push(el("span", { className: "muted", textContent: note }));
    kids.push(removeAction(entry.id, true));
    const row = el("div", { className: "ec-row" }, kids);
    row.dataset.id = entry.id;
    return row;
  }

  function foldedList(entries) {
    return el(
      "ul",
      { className: "ec-fold-list" },
      entries.map((e) => el("li", { textContent: e.name })),
    );
  }

  function showResults(result) {
    $("start").hidden = true;
    $("said-no").hidden = true;
    $("results").hidden = false;
    const heading = $("results-heading");

    // Clotr reads its own entry too, so it can label itself in the list, but it's never counted as one of
    // "your" extensions, so I leave it out of the headline and every list below.
    const others = result.entries.filter((e) => !e.self);
    const canReadOthers = others.filter((e) => e.reach === "all" || e.reach === "ai");
    heading.textContent = msg(
      "ec_count",
      "$1 of your $2 extensions can read your AI chats",
      canReadOthers.length,
      others.length,
    );

    const worth = result.worthALook;
    $("worth-a-look-section").hidden = worth.length === 0;
    $("none-worth-a-look").hidden = worth.length !== 0;
    $("worth-a-look-heading").textContent = msg("ec_worth", "Worth a look ($1)", worth.length);
    $("worth-a-look-cards").replaceChildren(...worth.map(worthCard));

    // Each extension shows up once: a worth-a-look card already carries its can-read line, so it's left out here.
    const worthIds = new Set(worth.map((e) => e.id));
    const canRead = canReadOthers.filter((e) => !worthIds.has(e.id));
    $("can-read-heading").textContent = msg("ec_canReadAi", "Can read your AI chats ($1)", canRead.length);
    $("normal-note").hidden = canRead.length === 0;
    $("can-read-rows").replaceChildren(...canRead.map(readRow));

    const cant = others.filter((e) => e.reach === "some" || e.reach === "none");
    $("cant-details").hidden = cant.length === 0;
    $("cant-summary").textContent = msg("ec_cant", "Can't read your AI chats ($1)", cant.length);
    $("cant-list").replaceChildren(foldedList(cant));

    const off = others.filter((e) => e.reach === "off");
    $("off-details").hidden = off.length === 0;
    $("off-summary").textContent = msg("ec_off", "$1 is off, so it can't read anything now", off.length);
    $("off-list").replaceChildren(foldedList(off));

    $("about-clotr").textContent = msg(
      "ec_isClotr",
      "Clotr itself reads AI chat pages to check what you type; it keeps nothing and sends nothing.",
    );

    const limits = parts(
      "ec_limits",
      "Clotr's list holds only extensions reported up to $1. / It sees what your browser lets each extension read now. An extension can ask for more later. / Not on the list doesn't clear an extension: it means no one has reported it yet.",
      reportedExtensions.checked,
    ).map((line) => el("p", { textContent: line }));
    if (isFirefox)
      limits.push(
        el("p", {
          textContent: msg(
            "ec_firefoxScripts",
            "Firefox doesn't show older add-ons' page scripts here; its Add-ons page does.",
          ),
        }),
      );
    $("limits").replaceChildren(...limits);

    heading.focus();
  }

  // ---------- If the person says no ----------

  function showSaidNo() {
    $("start").hidden = true;
    $("results").hidden = true;
    $("said-no").hidden = false;
    const key = isFirefox ? "ec_stepsFirefox" : "ec_stepsChromium";
    const english = isFirefox
      ? "Open Firefox's menu, then Add-ons and themes, then Extensions. / Click an extension, then its Permissions tab. / Look for \"Access your data for all websites\" or an AI site like chatgpt.com. / Remove any you don't use or don't recognize."
      : "Type $1 in the address bar and press Enter. / Click Details on each extension. / Under Site access, look for \"On all sites\" or an AI site like chatgpt.com. / Remove any you don't use or don't recognize.";
    const steps = isFirefox ? parts(key, english) : parts(key, english, "chrome://extensions");
    $("by-hand-steps").replaceChildren(...steps.map((s) => el("li", { textContent: s })));
    $("said-no-heading").focus();
  }

  // ---------- Set-up ----------

  $("facts").replaceChildren(
    ...parts(
      "ec_facts",
      "Reads the list only: names, and which sites each one can read. / Nothing leaves this computer: Clotr has no servers and never goes online. / Can read, not does: Clotr says what each one is allowed to read, not what it does with it.",
    ).map((s) => el("li", { textContent: s })),
  );
  $("list-date").textContent = msg(
    "ec_listDate",
    "Clotr's list of reported extensions was last checked on $1. It comes with Clotr's updates; Clotr never fetches it.",
    reportedExtensions.checked,
  );
  $("permission-sentence").textContent = `“${PERMISSION_SENTENCE}”`;

  $("start-check").addEventListener("click", startCheck);
  $("ask-again").addEventListener("click", startCheck);
})();
