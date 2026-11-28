// The "Report a problem" button, on every Clotr page. It only opens a GitHub issue form (or, once
// REPORT_EMAIL is set, a mailto:) for the person to read and send themselves; Clotr never sends anything
// on its own. Classic script, so it shares code through globalThis.Clotr like the content scripts do.
// Load it after translations.js (for Clotr.msg) and after the page's markup.
"use strict";

(function () {
  // ---------- The address ----------

  // The address in words (shown in the menu and printed on the Share guide) and the forms built from it.
  const REPORT_ADDRESS = "github.com/clotr-app/clotr/issues";
  const REPORT_URL = `https://${REPORT_ADDRESS}/new`;
  // A private path, off for now.
  const REPORT_EMAIL = "";

  // English with its $1, $2 filled in, for a page without translations.js.
  function englishMsg(_key, english, ...subs) {
    return english.replace(/\$(\d)/g, (_match, digit) => String(subs[digit - 1] ?? ""));
  }

  const msg = globalThis.Clotr?.msg || englishMsg;

  // ---------- This browser ----------

  // Checked in this order: Edge's and Opera's user agents say "Chrome" too. Brave is checked before all of
  // them, through navigator.brave, and gives Chrome's version.
  const BROWSERS = [
    ["Edge", /\bEdg\//, /\bEdg\/(\S+)/],
    ["Opera", /\bOPR\//, /\bOPR\/(\S+)/],
    ["Firefox", /\bFirefox\//, /\bFirefox\/(\S+)/],
    ["Chrome", /\bChrome\//, /\bChrome\/(\S+)/],
  ];
  // Android's user agent says "Linux" too, so it goes first.
  const SYSTEMS = [
    [/Windows/, "Windows"],
    [/Mac OS X/, "macOS"],
    [/Android/, "Android"],
    [/Linux/, "Linux"],
  ];

  function version() {
    try {
      const manifest = chrome.runtime.getManifest();
      return manifest.version || "";
    } catch {
      return "";
    }
  }

  // The browser's name and version from the user agent, and a coarse OS name.
  function browserParts() {
    const userAgent = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const brave = typeof navigator !== "undefined" && Boolean(navigator.brave);
    const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] || "";
    if (brave) return { name: "Brave", ver: firstGroup(/\bChrome\/(\S+)/, userAgent), os };
    const known = BROWSERS.find(([, test]) => test.test(userAgent));
    if (!known) return { name: "", ver: "", os };
    const [name, , versionPattern] = known;
    return { name, ver: firstGroup(versionPattern, userAgent), os };
  }

  function firstGroup(pattern, text) {
    return pattern.exec(text)?.[1] || "";
  }

  // A short "browser name + version" and the OS: never anything more specific than the bug form's own
  // placeholder ("Brave 1.95 on Windows 11").
  function browserInfo() {
    const { name, ver, os } = browserParts();
    const nameVer = [name, ver].filter(Boolean).join(" ");
    return os ? [nameVer, os].filter(Boolean).join(" on ") : nameVer;
  }

  // ---------- "Copy my summary" ----------
  // What Clotr counted in the last 30 days, for the person to read, edit and paste into a public report
  // themselves. Each line is Clotr's own words plus a built-in kind's name, id and count, so a crafted
  // event or a detail typed where a name should be can't smuggle anything else into the text. Team kinds
  // (ids starting "team_") are named by the organization, so they share one anonymous line instead.

  const SUMMARY_DAYS = 30;
  const DAY = 86400000;
  const SUMMARY_BROWSERS = new Set(["Brave", "Chrome", "Edge", "Firefox", "Opera"]);
  const COUNTED_ACTIONS = ["redacted", "allowed", "suppressed"];
  // Group keys no kind id can be, for team kinds and anything else that isn't built in.
  const TEAM = "\0team";
  const OTHER = "\0other";

  // The records in `list` from `since` on, skipping anything that isn't a record with a time.
  function recentOf(list, since) {
    if (!Array.isArray(list)) return [];
    return list.filter(
      (record) => record && typeof record === "object" && Number.isFinite(record.t) && record.t >= since,
    );
  }

  function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function groupKeyOf(type, builtIn) {
    if (builtIn.has(type)) return type;
    return type.startsWith("team_") ? TEAM : OTHER;
  }

  // Each kind's counts: found, hidden (and by Bandage), sent and just counted.
  function countEvents(events, builtIn) {
    // A record that stands for the rest of a long list counts as its n.
    const weight = globalThis.ClotrSites?.weight || (() => 1);
    const groups = new Map();
    for (const event of events) {
      if (!COUNTED_ACTIONS.includes(event.action)) continue;
      const type = typeof event.type === "string" ? event.type : "";
      const key = groupKeyOf(type, builtIn);
      const group = groups.get(key) || { found: 0, hidden: 0, bandage: 0, sent: 0, counted: 0 };
      const counted = weight(event);
      group.found += counted;
      if (event.action === "redacted") {
        group.hidden += counted;
        if (event.via === "bandage") group.bandage += counted;
      } else if (event.action === "allowed") group.sent += counted;
      else group.counted += counted;
      groups.set(key, group);
    }
    return groups;
  }

  // "3 found, 2 hidden (1 by Bandage), 1 sent": only the parts that aren't zero, after the first.
  function countsLine(group) {
    const parts = [msg("rpt_sumFound", "$1 found", group.found)];
    if (group.hidden) {
      const hidden = msg("rpt_sumHidden", "$1 hidden", group.hidden);
      const byBandage = msg("rpt_sumByBandage", "($1 by Bandage)", group.bandage);
      parts.push(group.bandage ? `${hidden} ${byBandage}` : hidden);
    }
    if (group.sent) parts.push(msg("rpt_sumSent", "$1 sent", group.sent));
    if (group.counted) parts.push(msg("rpt_sumJustCounted", "$1 just counted", group.counted));
    return parts.join(", ");
  }

  // The first line: Clotr's version and a known browser's name, when they look right.
  function headerLine(about) {
    const ver = /^\d+(\.\d+){0,3}$/.test(about.version) ? about.version : "";
    const who = ver ? `Clotr ${ver}` : "Clotr";
    if (SUMMARY_BROWSERS.has(about.browser)) {
      return msg(
        "rpt_sumHeader",
        "$1 on $2, last 30 days. Counts only: no details, sites or times.",
        who,
        about.browser,
      );
    }
    return msg("rpt_sumHeaderNoBrowser", "$1, last 30 days. Counts only: no details, sites or times.", who);
  }

  // The replies, responses and Bandage lines, each only when it isn't zero.
  function settingsLines(stored, since) {
    const lines = [];
    const mentions = recentOf(stored.mentions, since).length;
    if (mentions) lines.push(msg("rpt_sumMentions", "AI replies that brought up your details: $1", mentions));
    const responses = Object.values(plainObject(stored.responses));
    const ask = responses.filter((response) => response === "block").length;
    const justCount = responses.filter((response) => response === "log").length;
    if (ask) lines.push(msg("rpt_sumAskBefore", "Kinds set to Ask before sending: $1", ask));
    if (justCount) lines.push(msg("rpt_sumJustCount", "Kinds set to Just count: $1", justCount));
    const bandageOn = Object.values(plainObject(stored.bandage)).filter((on) => on === true).length;
    if (bandageOn) lines.push(msg("rpt_sumBandage", "AI sites with Bandage on: $1", bandageOn));
    return lines;
  }

  function summaryText(stored, now, about = {}) {
    const storedObject = stored && typeof stored === "object" ? stored : {};
    const since = now - SUMMARY_DAYS * DAY;
    const builtIn = new Map((globalThis.Clotr?.PATTERNS || []).map((pattern) => [pattern.id, pattern]));
    const groups = countEvents(recentOf(storedObject.events, since), builtIn);

    const lines = [headerLine(about)];
    // Most found first, then by id.
    const kinds = [...groups.keys()]
      .filter((key) => key !== TEAM && key !== OTHER)
      .sort((a, b) => groups.get(b).found - groups.get(a).found || (a < b ? -1 : 1));
    for (const id of kinds) {
      lines.push(`${msg(`type_${id}`, builtIn.get(id).name)} (${id}): ${countsLine(groups.get(id))}`);
    }
    if (groups.has(TEAM)) {
      lines.push(`${msg("rpt_sumTeamKinds", "Kinds your organization added")}: ${countsLine(groups.get(TEAM))}`);
    }
    if (groups.has(OTHER)) lines.push(`${msg("rpt_sumOtherKinds", "Other kinds")}: ${countsLine(groups.get(OTHER))}`);
    if (!groups.size) lines.push(msg("rpt_sumNothing", "Nothing found in the last 30 days."));

    lines.push(...settingsLines(storedObject, since));
    return lines.join("\n");
  }

  // ---------- The forms ----------

  // Fills in only safe facts through the forms' own field ids, nothing anyone typed or stored. `host` is
  // the current AI site's name, included only when the person ticked "Include this site" in the popup.
  // `title` is a fixed string a page passes in, like the full report's "history full" note, not anything
  // pulled from the person's own history.
  function formUrl(template, host, title) {
    const params = new URLSearchParams({ template });
    if (title) params.set("title", title);
    const clotrVersion = version();
    if (clotrVersion) params.set("version", clotrVersion);
    const browser = browserInfo();
    if (browser) params.set("browser", browser);
    if (host) params.set("site", host);
    return `${REPORT_URL}?${params.toString()}`;
  }

  function mailUrl(host) {
    const lines = [`Clotr version: ${version()}`, `Browser: ${browserInfo()}`];
    if (host) lines.push(`Site: ${host}`);
    lines.push("", "What happened:");
    const subject = encodeURIComponent("Clotr");
    const body = encodeURIComponent(lines.join("\n"));
    return `mailto:${REPORT_EMAIL}?subject=${subject}&body=${body}`;
  }

  function open(url) {
    window.open(url, "_blank", "noopener");
  }

  // ---------- The menu ----------

  // Each form: its template, and the button's words.
  const FORMS = [
    ["bug.yml", "rpt_somethingsWrong", "Something's wrong"],
    ["missed.yml", "rpt_itMissedSomething", "It missed something"],
    ["false-alarm.yml", "rpt_aFalseAlarm", "A false alarm"],
  ];

  function el(tag, props = {}) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name in node) node[name] = value;
      else node.setAttribute(name, value);
    }
    return node;
  }

  // Set once a page (the popup, popup only) knows the current AI site's host.
  let hostGetter = null;
  let siteToggle = null; // { label, checkbox, text }

  function currentHost() {
    return siteToggle && siteToggle.checkbox.checked ? hostGetter?.() || null : null;
  }

  function choiceButton(text, onOpen) {
    const button = el("button", { type: "button", className: "link report-choice", textContent: text });
    button.addEventListener("click", onOpen);
    return button;
  }

  function summaryBox() {
    const box = el("textarea", { id: "report-sum-text", className: "report-sum-text", rows: 9, spellcheck: false });
    // Like every box on Clotr's pages, the browser keeps nothing typed here (the vault page shows this box
    // too).
    box.setAttribute("autocomplete", "off");
    box.setAttribute("aria-labelledby", "report-sum-title");
    box.setAttribute("aria-describedby", "report-sum-note");
    return box;
  }

  // Tall enough to show every line at once, so nothing goes public unseen below the fold.
  function fitBox(box) {
    box.style.height = "0px"; // measured from nothing, so it shrinks as lines are deleted too
    box.style.height = `${box.scrollHeight + 2}px`;
  }

  // The summary card: closed until asked for, then the history is read once and the summary put in a box
  // the person can edit. "Copy it" copies the box as they left it. Nothing is stored or sent: they paste it
  // into the form.
  function summaryCard() {
    const card = el("details", { className: "report-summary" });
    const title = el("summary", {
      id: "report-sum-title",
      textContent: msg("rpt_sumAdd", "Add what Clotr counted (optional)"),
    });
    const box = summaryBox();
    const note = el("p", {
      id: "report-sum-note",
      className: "report-sum-note",
      textContent: msg(
        "rpt_sumNote",
        "This goes public with your report. Delete any line you'd rather keep to yourself, then paste it into the form.",
      ),
    });
    const copy = el("button", {
      type: "button",
      className: "btn primary report-sum-copy",
      textContent: msg("rpt_sumCopy", "Copy it"),
    });
    const status = el("span", { className: "report-sum-msg" });
    status.setAttribute("role", "status");
    const actions = el("div", { className: "report-sum-actions" });
    actions.append(copy, status);
    card.append(title, box, note, actions);

    // Filled the first time it opens, so the person's edits stay if they close and reopen it.
    let filled = false;
    card.addEventListener("toggle", async () => {
      if (!card.open || filled) return;
      filled = true;
      try {
        const stored = await chrome.storage.local.get(["events", "mentions", "responses", "bandage"]);
        box.value = summaryText(stored, Date.now(), { version: version(), browser: browserParts().name });
        fitBox(box);
      } catch {
        filled = false;
        status.textContent = msg("rpt_sumReadFailed", "Couldn't read Clotr's counts just now. Try again in a moment.");
      }
    });
    box.addEventListener("input", () => {
      status.textContent = "";
      fitBox(box);
    });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(box.value);
        status.textContent = msg("rpt_sumCopied", "Copied. Now pick a form below.");
      } catch {
        box.focus();
        box.select();
        status.textContent = msg(
          "rpt_sumCopyFailed",
          "Couldn't copy. The text is selected: copy it yourself, then pick a form below.",
        );
      }
    });
    return card;
  }

  // "Include this site", hidden until the popup knows the site.
  function siteToggleParts() {
    const label = el("label", { className: "toggle report-site" });
    label.hidden = true;
    const checkbox = el("input", { type: "checkbox" });
    const text = el("span", {});
    label.append(checkbox, text);
    return { label, checkbox, text };
  }

  // Fills the placeholder element with this id. Safe to call more than once; only the first mount
  // does anything, so a page can't end up with two buttons.
  function mount(placeholderId) {
    const host = document.getElementById(placeholderId);
    if (!host || host.dataset.reportMounted) return;
    host.dataset.reportMounted = "1";

    const details = reportDetails();
    const menu = el("div", { className: "report-menu" });
    // Said before any choice: the forms are public, so the real detail never goes in one.
    menu.append(menuWarning());
    // A disclosure with plain buttons: no menu role, which would promise arrow-key handling.

    // The summary comes before the forms: opening a form closes the popup, so copying has to come first.
    menu.append(
      summaryCard(),
      el("p", { className: "report-then", textContent: msg("rpt_thenPickOne", "Then pick one:") }),
    );

    siteToggle = siteToggleParts();
    menu.append(siteToggle.label);

    menu.append(...formChoiceButtons(details));
    if (REPORT_EMAIL) menu.append(emailChoiceButton(details));
    menu.append(addressLine());
    details.append(menu);
    host.append(details);
  }

  // The closed "Report a problem" disclosure.
  function reportDetails() {
    const details = el("details", { className: "report" });
    details.append(el("summary", { textContent: msg("rpt_reportAProblem", "Report a problem") }));
    // The popup's tabs bar stays fixed at the bottom, so on a tall panel a menu that just opened could land
    // partly behind it. Scroll it into view when it opens (popup/popup.css's scroll-padding-bottom keeps it clear
    // of the bar; a no-op elsewhere).
    details.addEventListener("toggle", () => {
      if (details.open) details.scrollIntoView({ block: "end" });
    });
    return details;
  }

  function menuWarning() {
    return el("p", {
      className: "report-warn",
      textContent: msg(
        "rpt_publicWarning",
        "Reports are public, on GitHub. Never paste a real password, key or personal detail: describe it instead.",
      ),
    });
  }

  // A button per form: each opens its form with the safe facts filled in, then closes the menu.
  function formChoiceButtons(details) {
    return FORMS.map(([template, key, english]) =>
      choiceButton(msg(key, english), () => {
        open(formUrl(template, currentHost()));
        details.open = false;
      }),
    );
  }

  function emailChoiceButton(details) {
    return choiceButton(msg("rpt_sendPrivatelyByEmail", "Send privately by email"), () => {
      open(mailUrl(currentHost()));
      details.open = false;
    });
  }

  // The address in words too, for someone who'd rather type it or read it out to a helper.
  function addressLine() {
    const address = el("p", { className: "report-address" });
    address.append(
      `${msg("rpt_orTypeAddress", "Or type this address:")} `,
      el("span", { textContent: REPORT_ADDRESS }),
    );
    return address;
  }

  // Popup only: reveals "Include this site (<host>)" once the current AI site is known
  // (`null` hides it again, e.g. away from an AI tool).
  function setHost(host) {
    hostGetter = host ? () => host : null;
    if (!siteToggle) return;
    if (host) {
      siteToggle.text.textContent = msg("rpt_includeThisSite", "Include this site ($1)", host);
      siteToggle.label.hidden = false;
    } else {
      siteToggle.label.hidden = true;
      siteToggle.checkbox.checked = false;
    }
  }

  globalThis.Clotr = {
    ...(globalThis.Clotr || {}),
    Report: { mount, setHost, formUrl, mailUrl, summaryText, REPORT_ADDRESS },
  };

  // Self-mounts wherever the page has left a placeholder (every page but the printable guide/policy
  // text itself); the popup also calls Report.setHost() once it knows the current AI site. (No page in the
  // unit tests, which load this file for summaryText.)
  if (typeof document !== "undefined") mount("report-root");
})();
