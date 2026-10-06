// The "Report a problem" button, on every Clotr page. It only opens a GitHub issue form (or, once
// REPORT_EMAIL is set, a mailto:) for the person to read and send themselves; Clotr never sends anything
// on its own. Classic script, so it shares code through globalThis.Clotr like the content scripts do.
// Load it after patterns.js (for Clotr.msg) and after the page's markup.
"use strict";

(function () {
  // The address in words (shown in the menu and printed on the Share guide) and the forms built from it.
  const REPORT_ADDRESS = "github.com/clotr-app/clotr/issues";
  const REPORT_URL = `https://${REPORT_ADDRESS}/new`;
  // A private path, off for now.
  const REPORT_EMAIL = "";

  const msg =
    globalThis.Clotr?.msg ||
    ((key, english, ...subs) => english.replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? "")));

  function version() {
    try {
      const m = chrome.runtime.getManifest();
      return m.version || "";
    } catch {
      return "";
    }
  }

  // The browser's name and version from the user agent, and a coarse OS name.
  function browserParts() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const brave = typeof navigator !== "undefined" && Boolean(navigator.brave);
    const pick = (re) => re.exec(ua)?.[1] || "";
    let name = "";
    let ver = "";
    if (brave) {
      name = "Brave";
      ver = pick(/\bChrome\/(\S+)/);
    } else if (/\bEdg\//.test(ua)) {
      name = "Edge";
      ver = pick(/\bEdg\/(\S+)/);
    } else if (/\bOPR\//.test(ua)) {
      name = "Opera";
      ver = pick(/\bOPR\/(\S+)/);
    } else if (/\bFirefox\//.test(ua)) {
      name = "Firefox";
      ver = pick(/\bFirefox\/(\S+)/);
    } else if (/\bChrome\//.test(ua)) {
      name = "Chrome";
      ver = pick(/\bChrome\/(\S+)/);
    }
    const os = /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
    return { name, ver, os };
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
  const SUMMARY_BROWSERS = new Set(["Brave", "Chrome", "Edge", "Firefox", "Opera"]);

  function summaryText(stored, now, about = {}) {
    const s = stored && typeof stored === "object" ? stored : {};
    const since = now - SUMMARY_DAYS * 86400000;
    const recent = (v) =>
      Array.isArray(v) ? v.filter((e) => e && typeof e === "object" && Number.isFinite(e.t) && e.t >= since) : [];
    const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const builtIn = new Map((globalThis.Clotr?.PATTERNS || []).map((p) => [p.id, p]));
    // A record that stands for the rest of a long list counts as its n.
    const weight = globalThis.ClotrSites?.weight || (() => 1);
    const TEAM = "\0team";
    const OTHER = "\0other";

    const groups = new Map();
    for (const e of recent(s.events)) {
      if (!["redacted", "allowed", "suppressed"].includes(e.action)) continue;
      const type = typeof e.type === "string" ? e.type : "";
      const key = builtIn.has(type) ? type : type.startsWith("team_") ? TEAM : OTHER;
      const g = groups.get(key) || { found: 0, hidden: 0, bandage: 0, sent: 0, counted: 0 };
      const w = weight(e);
      g.found += w;
      if (e.action === "redacted") {
        g.hidden += w;
        if (e.via === "bandage") g.bandage += w;
      } else if (e.action === "allowed") g.sent += w;
      else g.counted += w;
      groups.set(key, g);
    }
    const counts = (g) => {
      const parts = [msg("rpt_sumFound", "$1 found", g.found)];
      if (g.hidden) {
        const hidden = msg("rpt_sumHidden", "$1 hidden", g.hidden);
        parts.push(g.bandage ? `${hidden} ${msg("rpt_sumByBandage", "($1 by Bandage)", g.bandage)}` : hidden);
      }
      if (g.sent) parts.push(msg("rpt_sumSent", "$1 sent", g.sent));
      if (g.counted) parts.push(msg("rpt_sumJustCounted", "$1 just counted", g.counted));
      return parts.join(", ");
    };

    const ver = /^\d+(\.\d+){0,3}$/.test(about.version) ? about.version : "";
    const who = ver ? `Clotr ${ver}` : "Clotr";
    const lines = [
      SUMMARY_BROWSERS.has(about.browser)
        ? msg("rpt_sumHeader", "$1 on $2, last 30 days. Counts only: no details, sites or times.", who, about.browser)
        : msg("rpt_sumHeaderNoBrowser", "$1, last 30 days. Counts only: no details, sites or times.", who),
    ];
    const kinds = [...groups.keys()]
      .filter((k) => k !== TEAM && k !== OTHER)
      .sort((a, b) => groups.get(b).found - groups.get(a).found || (a < b ? -1 : 1));
    for (const id of kinds) lines.push(`${msg(`type_${id}`, builtIn.get(id).name)} (${id}): ${counts(groups.get(id))}`);
    if (groups.has(TEAM))
      lines.push(`${msg("rpt_sumTeamKinds", "Kinds your organization added")}: ${counts(groups.get(TEAM))}`);
    if (groups.has(OTHER)) lines.push(`${msg("rpt_sumOtherKinds", "Other kinds")}: ${counts(groups.get(OTHER))}`);
    if (!groups.size) lines.push(msg("rpt_sumNothing", "Nothing found in the last 30 days."));

    const mentions = recent(s.mentions).length;
    if (mentions) lines.push(msg("rpt_sumMentions", "AI replies that brought up your details: $1", mentions));
    const responses = Object.values(plain(s.responses));
    const ask = responses.filter((r) => r === "block").length;
    const justCount = responses.filter((r) => r === "log").length;
    if (ask) lines.push(msg("rpt_sumAskBefore", "Kinds set to Ask before sending: $1", ask));
    if (justCount) lines.push(msg("rpt_sumJustCount", "Kinds set to Just count: $1", justCount));
    const bandageOn = Object.values(plain(s.bandage)).filter((on) => on === true).length;
    if (bandageOn) lines.push(msg("rpt_sumBandage", "AI sites with Bandage on: $1", bandageOn));
    return lines.join("\n");
  }

  // Fills in only safe facts through the forms' own field ids, nothing anyone typed or stored. `host` is
  // the current AI site's name, included only when the person ticked "Include this site" in the popup.
  // `title` is a fixed string a page passes in, like the full report's "history full" note, not anything
  // pulled from the person's own history.
  function formUrl(template, host, title) {
    const params = new URLSearchParams({ template });
    if (title) params.set("title", title);
    const v = version();
    if (v) params.set("version", v);
    const b = browserInfo();
    if (b) params.set("browser", b);
    if (host) params.set("site", host);
    return `${REPORT_URL}?${params.toString()}`;
  }

  function mailUrl(host) {
    const lines = [`Clotr version: ${version()}`, `Browser: ${browserInfo()}`];
    if (host) lines.push(`Site: ${host}`);
    lines.push("", "What happened:");
    return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent("Clotr")}&body=${encodeURIComponent(lines.join("\n"))}`;
  }

  function el(tag, props = {}) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k in node) node[k] = v;
      else node.setAttribute(k, v);
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
    const b = el("button", { type: "button", className: "link report-choice", textContent: text });
    b.addEventListener("click", onOpen);
    return b;
  }

  // The summary card: closed until asked for, then the history is read once and the summary put in a box the person
  // can edit. "Copy it" copies the box as they left it. Nothing is stored or sent: they paste it into the form.
  function summaryCard() {
    const card = el("details", { className: "report-summary" });
    const title = el("summary", {
      id: "report-sum-title",
      textContent: msg("rpt_sumAdd", "Add what Clotr counted (optional)"),
    });
    const box = el("textarea", { id: "report-sum-text", className: "report-sum-text", rows: 9, spellcheck: false });
    // Like every box on Clotr's pages, the browser keeps nothing typed here (the vault page shows this box too).
    box.setAttribute("autocomplete", "off");
    box.setAttribute("aria-labelledby", "report-sum-title");
    box.setAttribute("aria-describedby", "report-sum-note");
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

    // Tall enough to show every line at once, so nothing goes public unseen below the fold.
    const fit = () => {
      box.style.height = "0px"; // measured from nothing, so it shrinks as lines are deleted too
      box.style.height = `${box.scrollHeight + 2}px`;
    };
    // Filled the first time it opens, so the person's edits stay if they close and reopen it.
    let filled = false;
    card.addEventListener("toggle", async () => {
      if (!card.open || filled) return;
      filled = true;
      try {
        const stored = await chrome.storage.local.get(["events", "mentions", "responses", "bandage"]);
        box.value = summaryText(stored, Date.now(), { version: version(), browser: browserParts().name });
        fit();
      } catch {
        filled = false;
        status.textContent = msg("rpt_sumReadFailed", "Couldn't read Clotr's counts just now. Try again in a moment.");
      }
    });
    box.addEventListener("input", () => {
      status.textContent = "";
      fit();
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

  function open(url) {
    window.open(url, "_blank", "noopener");
  }

  // Fills the placeholder element with this id. Safe to call more than once; only the first mount
  // does anything, so a page can't end up with two buttons.
  function mount(placeholderId) {
    const host = document.getElementById(placeholderId);
    if (!host || host.dataset.reportMounted) return;
    host.dataset.reportMounted = "1";

    const details = el("details", { className: "report" });
    details.append(el("summary", { textContent: msg("rpt_reportAProblem", "Report a problem") }));
    // The popup's tabs bar stays fixed at the bottom, so on a tall panel a menu that just opened could land
    // partly behind it. Scroll it into view when it opens (popup.css's scroll-padding-bottom keeps it clear
    // of the bar; a no-op elsewhere).
    details.addEventListener("toggle", () => {
      if (details.open) details.scrollIntoView({ block: "end" });
    });

    const menu = el("div", { className: "report-menu" });
    // Said before any choice: the forms are public, so the real detail never goes in one.
    menu.append(
      el("p", {
        className: "report-warn",
        textContent: msg(
          "rpt_publicWarning",
          "Reports are public, on GitHub. Never paste a real password, key or personal detail: describe it instead.",
        ),
      }),
    );
    // A disclosure with plain buttons: no menu role, which would promise arrow-key handling.

    // The summary comes before the forms: opening a form closes the popup, so copying has to come first.
    menu.append(
      summaryCard(),
      el("p", { className: "report-then", textContent: msg("rpt_thenPickOne", "Then pick one:") }),
    );

    const label = el("label", { className: "toggle report-site" });
    label.hidden = true;
    const checkbox = el("input", { type: "checkbox" });
    const text = el("span", {});
    label.append(checkbox, text);
    siteToggle = { label, checkbox, text };
    menu.append(label);

    const close = () => {
      details.open = false;
    };
    menu.append(
      choiceButton(msg("rpt_somethingsWrong", "Something's wrong"), () => {
        open(formUrl("bug.yml", currentHost()));
        close();
      }),
      choiceButton(msg("rpt_itMissedSomething", "It missed something"), () => {
        open(formUrl("missed.yml", currentHost()));
        close();
      }),
      choiceButton(msg("rpt_aFalseAlarm", "A false alarm"), () => {
        open(formUrl("false-alarm.yml", currentHost()));
        close();
      }),
    );
    if (REPORT_EMAIL) {
      menu.append(
        choiceButton(msg("rpt_sendPrivatelyByEmail", "Send privately by email"), () => {
          open(mailUrl(currentHost()));
          close();
        }),
      );
    }
    // The address in words too, for someone who'd rather type it or read it out to a helper.
    const address = el("p", { className: "report-address" });
    address.append(
      `${msg("rpt_orTypeAddress", "Or type this address:")} `,
      el("span", { textContent: REPORT_ADDRESS }),
    );
    menu.append(address);
    details.append(menu);
    host.append(details);
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
