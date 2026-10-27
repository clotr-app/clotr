// Clotr for Windows — Look back: the Scan screen's third pick asks for
// the export and reads it, through the same worker and readers Check my files uses (scan-worker.js's
// readLookback()), with the same words and logic as the extension's own lookback.js. The reading step lives
// on the Scan screen (tool tabs, the drop zone, the progress bar and feed), the same real estate as Check my
// files' trace map; the finished result renders into the Results screen's own "Chats that hold private details"
// section (render() below), the same way scan.js's finish() hands Check my files' list to results.js. Nothing
// here is written to storage: the result lives in memory until "Forget these results" or another pick is chosen.
// "Open the chat" and the tool/help links never reach `ShellExecuteW` straight from this page: every one of them
// goes through `open_lookback_link` (main.rs), which checks it again with `lookback_link_ok()` before opening it.
"use strict";

(() => {
  const { call } = globalThis.ClotrApp || {};
  const W = globalThis.ClotrWords || { t: (k) => k };
  const C = globalThis.Clotr || {};
  const SCAN_TIMES_ENABLED = globalThis.ClotrDesktopFeatures?.scanTimes === true;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }
  // ---------- Colour and the one teaser line (the same three groups the extension's own lookback.js
  // uses): red for a key or an ID number, orange ("soon" in the kit's own tag palette) for what scammers ask for,
  // lemon ("test") for everything else personal. Exported so a Node test can check them with no DOM. ----------
  const RED_KINDS = new Set([
    "private_key",
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "google_api_key",
    "slack_token",
    "sentry_token",
    "grafana_token",
    "vault_token",
    "replicate_token",
    "linear_key",
    "postman_key",
    "shopify_token",
    "atlassian_token",
    "netlify_token",
    "pulumi_token",
    "databricks_token",
    "gitlab_token",
    "perplexity_key",
    "digitalocean_token",
    "huggingface_token",
    "heroku_token",
    "onepassword_token",
    "cloudflare_origin_ca_key",
    "twilio_credentials",
    "crypto_secret",
    "service_token",
    "connection_string",
    "jwt",
    "otp_secret",
    "internal_ip",
    "internal_host",
    "us_ssn",
    "national_id",
    "passport",
    "drivers_license",
    "medicare_id",
    "insurance_id",
    "vin",
    "student_id",
    "my_id",
    "bank_account",
    "medical_record",
  ]);
  const AMBER_KINDS = new Set(["password", "credit_card", "card_code", "gift_card", "stripe_publishable_key"]);
  // The ID-number half of RED_KINDS, named separately so the teaser line can tell a login key apart from an ID
  // number without a second, diverging list.
  const TEASER_ID_KINDS = new Set([
    "us_ssn",
    "national_id",
    "passport",
    "drivers_license",
    "medicare_id",
    "insurance_id",
    "vin",
    "student_id",
    "my_id",
    "bank_account",
    "medical_record",
  ]);
  function tagClass(kindId) {
    if (RED_KINDS.has(kindId)) return "err";
    if (AMBER_KINDS.has(kindId)) return "soon";
    return "test";
  }
  function kindName(kindId) {
    const plain = W.t(`ws.plain.${kindId}`);
    if (plain !== `ws.plain.${kindId}`) return plain;
    const found = (C.PATTERNS || []).find((p) => p.id === kindId);
    return found ? found.name.toLocaleLowerCase(lang === "es" ? "es" : "en") : kindId.replaceAll("_", " ");
  }
  // The plain names start with "a" or "una" so they sit inside sentences; tags and rows drop it.
  function labelName(kindId) {
    const name = kindName(kindId).replace(/^(a|an|the|un|una|el|la|los|las) /i, "");
    return name.charAt(0).toLocaleUpperCase(lang === "es" ? "es" : "en") + name.slice(1);
  }
  function tagChip(kindId, countText) {
    return el("span", { className: `tag ${tagClass(kindId)}`, textContent: countText || labelName(kindId) });
  }

  // The one teaser line for a card's most serious kind found: red first, then a password, then an ID number, then
  // a photo's place; a kind none of those cover (an address, an email, a phone…) gets no teaser, just its tags.
  function teaserFor(kinds) {
    const ids = Object.keys(kinds);
    if (ids.some((k) => RED_KINDS.has(k) && !TEASER_ID_KINDS.has(k))) return W.t("ws.whyKey");
    if (ids.includes("password")) return W.t("ws.lbWhyPassword");
    if (ids.some((k) => TEASER_ID_KINDS.has(k))) return W.t("ws.lbWhyId");
    if (ids.includes("photo_location")) return W.t("ws.whyPhoto");
    return "";
  }

  // lookback-core.js's WHERE is always one of these five fixed English strings: an internal contract with that
  // file, matched here by exact value, never translated or guessed from a locale.
  const WHERE_WORD = {
    "your message": "ws.lbWhereMessage",
    "a message you later edited": "ws.lbWhereEdited",
    "a file you attached": "ws.lbWhereFile",
    "a voice note": "ws.lbWhereVoice",
    "your custom instructions": "ws.lbWhereInstructions",
  };
  function whereLabel(where) {
    const key = WHERE_WORD[where];
    return key ? W.t(key) : "";
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "0 KB";
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  function formatSeconds(s) {
    if (!Number.isFinite(s) || s <= 0) return "";
    if (s < 60) return `${Math.ceil(s)}s`;
    return `${Math.ceil(s / 60)}m`;
  }

  // Every address this screen can ever ask Rust to open: `open_lookback_link` checks it again with
  // `lookback_link_ok()` before it ever reaches ShellExecuteW (main.rs).
  function openLink(url) {
    if (url) call("open_lookback_link", { url }).catch(() => {});
  }

  // ---------- Step 1: which tool, and its steps ----------

  const TOOLS = {
    chatgpt: {
      label: "ChatGPT",
      stepsKey: "ws.lbChatgptSteps",
      openUrl: "https://chatgpt.com/",
      openName: "ChatGPT",
      helpUrl: "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
    },
    claude: {
      label: "Claude",
      stepsKey: "ws.lbClaudeSteps",
      openUrl: "https://claude.ai/",
      openName: "Claude",
      helpUrl: "https://privacy.claude.com/en/articles/9450526-export-your-claude-data",
    },
    gemini: {
      label: "Gemini",
      stepsKey: "ws.lbGeminiSteps",
      openUrl: "https://takeout.google.com/",
      openName: "Google Takeout",
      helpUrl: "https://support.google.com/gemini/answer/16920332",
    },
  };

  let currentTool = "chatgpt";
  function selectTool(tool) {
    if (!TOOLS[tool]) return;
    currentTool = tool;
    for (const tab of $("lb-tool-tabs").querySelectorAll(".lb-tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.tool === tool));
    }
    const info = TOOLS[tool];
    const steps = $("lb-tool-steps");
    steps.textContent = "";
    for (const step of W.t(info.stepsKey).split(" / ")) steps.append(el("li", { textContent: step }));
    $("lb-open-tool").textContent = W.t("ws.lbOpenTool", info.openName);
    $("lb-open-help").textContent = W.t("ws.lbHelp", info.openName);
  }

  // ---------- Step 2: picking the export ----------

  function isTgzName(name) {
    return /\.tgz$|\.tar\.gz$/i.test(name || "");
  }
  function pickedKindFor(name) {
    return /\.json$/i.test(name || "") ? "json" : "zip";
  }

  function showUnsupported(kind) {
    const text =
      {
        tgz: "ws.lbTgz",
        unknown: "ws.lbUnknown",
        unknownJson: "ws.lbUnknownJson",
        html: "ws.lbHtml",
        geminiNoChats: "ws.lbGeminiNoChats",
        damaged: "ws.lbDamaged",
      }[kind] || "ws.lbDamaged";
    const p = $("lb-unsupported");
    p.textContent = W.t(text);
    p.hidden = false;
    $("lb-try-again").hidden = false;
  }
  function clearUnsupported() {
    $("lb-unsupported").hidden = true;
    $("lb-try-again").hidden = true;
  }

  // ---------- Reading: the worker, the progress UI, Stop ----------

  let worker = null;
  let readStartedAt = 0;
  let lastAnnouncedQuarter = -1;
  let currentView = null;
  let lang = "en";
  let lastResult = null;

  function announce(text) {
    if (text) $("lb-live-region").textContent = text;
  }

  function resetReadingUi(toolLabel) {
    $("lb-reading-heading").textContent = W.t("ws.lbReading", toolLabel);
    $("lb-progress-fill").style.width = "0%";
    $("lb-progress-bar").setAttribute("aria-valuenow", "0");
    $("lb-bytes-text").textContent = "";
    $("lb-time-left").textContent = "";
    $("lb-stat-chats-line").textContent = "";
    $("lb-stat-found-line").textContent = "";
    const list = $("lb-steps-list");
    list.textContent = "";
    [W.t("ws.lbStepOpen"), W.t("ws.lbStepChats"), W.t("ws.lbStepPhotos")].forEach((step, i) =>
      list.append(el("li", { textContent: step, className: i === 0 ? "is-active" : "" })),
    );
    $("lb-live-feed").textContent = "";
    lastAnnouncedQuarter = -1;
  }

  function markStepsThrough(index) {
    $("lb-steps-list")
      .querySelectorAll("li")
      .forEach((li, i) => {
        li.classList.toggle("is-done", i < index);
        li.classList.toggle("is-active", i === index);
      });
  }

  function beginRead(picked, entries) {
    clearUnsupported();
    $("lb-start").hidden = true;
    $("lb-done").hidden = true;
    $("lb-reading").hidden = false;
    resetReadingUi(TOOLS[currentTool].label);
    announce(W.t("ws.lbReading", TOOLS[currentTool].label));
    readStartedAt = performance.now();

    worker = new Worker("scan-worker.js");
    let totalBytes = 0;

    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "opened") {
        totalBytes = msg.totalBytes || 0;
        markStepsThrough(1);
      } else if (msg.type === "progress") {
        onProgress(msg, totalBytes);
      } else if (msg.type === "unsupported") {
        worker?.terminate();
        worker = null;
        $("lb-reading").hidden = true;
        $("lb-start").hidden = false;
        showUnsupported(msg.kind);
      } else if (msg.type === "done") {
        worker?.terminate();
        worker = null;
        finishRead(msg.result);
      } else if (msg.type === "error") {
        worker?.terminate();
        worker = null;
        $("lb-reading").hidden = true;
        $("lb-start").hidden = false;
        showUnsupported("damaged");
      }
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      $("lb-reading").hidden = true;
      $("lb-start").hidden = false;
      showUnsupported("damaged");
    };

    const settings = currentView?.settings || {};
    worker.postMessage({
      type: "lookback",
      picked,
      entries,
      vault: { salt: settings.salt, entries: settings.vault || [] },
    });
  }

  function onProgress(tick, totalBytes) {
    markStepsThrough(1);
    const pct = totalBytes > 0 ? Math.min(100, Math.round((tick.liveBytes / totalBytes) * 100)) : 0;
    $("lb-progress-fill").style.width = `${pct}%`;
    $("lb-progress-bar").setAttribute("aria-valuenow", String(pct));
    $("lb-bytes-text").textContent = W.t("ws.lbBytes", formatBytes(tick.liveBytes), formatBytes(totalBytes));
    const elapsed = (performance.now() - readStartedAt) / 1000;
    if (pct > 2 && elapsed > 1) {
      const left = formatSeconds(elapsed / (pct / 100) - elapsed);
      $("lb-time-left").textContent = left ? W.t("ws.lbLeft", left) : "";
    }
    $("lb-stat-chats-line").textContent = W.t("ws.lbStatChats", tick.read.chats);
    if (tick.chat) {
      const n = Number($("lb-stat-found-line").dataset.n || 0) + 1;
      $("lb-stat-found-line").dataset.n = String(n);
      $("lb-stat-found-line").textContent = W.t("ws.lbStatFound", n);
      addFeedRow(tick.chat);
    }
    if (pct >= 100) markStepsThrough(2);
    const quarter = Math.floor(pct / 25);
    if (quarter > lastAnnouncedQuarter && quarter > 0) {
      lastAnnouncedQuarter = quarter;
      announce($("lb-bytes-text").textContent);
    }
  }

  function addFeedRow(chat) {
    const feed = $("lb-live-feed");
    const row = el("div", { className: "lb-feed-row" }, [el("span", { textContent: chat.title })]);
    for (const kind of Object.keys(chat.kinds)) row.append(tagChip(kind));
    feed.append(row);
    while (feed.children.length > 30) feed.removeChild(feed.firstChild);
  }

  function stopReading() {
    worker?.terminate();
    worker = null;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = false;
  }

  function showStart() {
    $("lb-done").hidden = true;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = false;
    clearUnsupported();
  }

  function finishRead(result) {
    lastResult = result;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = true;
    $("lb-done").hidden = false;
    $("lb-done-heading").textContent =
      result.chats.length > 0
        ? W.t("ws.lbFound", result.chats.length, result.read.chats)
        : W.t("ws.lbFoundNone", result.read.chats);
    const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("lb-done-sub").textContent = W.t("ws.lbResNote", result.tool, now);
    announce($("lb-done-heading").textContent);
    render(result);
    // History's own row for this read: how many chats, and how many of each kind across them, from the same
    // totals the Results screen already shows. Only History redraws from it, so the person never waits on it.
    const seconds = Math.max(0, (performance.now() - readStartedAt) / 1000);
    const row = {
      t: Date.now(),
      scan: "lookback",
      items: result.read.chats,
      seconds,
      counts: lookbackCounts(result.totals),
    };
    call("record_scan", { row })
      .then((next) => {
        globalThis.ClotrHistory?.draw(next);
        globalThis.ClotrScanScreen?.draw(next, lang);
        draw(next, lang);
        const recorded = next.scans?.[next.scans.length - 1];
        if (SCAN_TIMES_ENABLED && (recorded?.added || recorded?.gone)) {
          const kinds = new Map((C.PATTERNS || []).map((pattern) => [pattern.id, pattern.name]));
          const added = globalThis.ClotrHistory.foundLabel(recorded.added, kinds, {
            t: W.t,
            lang: document.documentElement.lang,
          });
          const gone = globalThis.ClotrHistory.foundLabel(recorded.gone, kinds, {
            t: W.t,
            lang: document.documentElement.lang,
          });
          $("lb-done-sub").textContent = `${$("lb-done-sub").textContent} ${W.t("ws.scanChangeSummary", added, gone)}`;
        }
      })
      .catch(() => {});
  }

  function lookbackCounts(totals) {
    const out = {};
    for (const [id, t] of Object.entries(totals || {})) out[id] = t.count;
    return out;
  }

  // ---------- Results (rendered into the Results screen's own section) ----------

  function renderSharedRows(totals) {
    const rows = $("res-chats-shared-rows");
    rows.textContent = "";
    let anyDifferent = false;
    const ids = Object.keys(totals).sort((a, b) => labelName(a).localeCompare(labelName(b)));
    for (const id of ids) {
      const t = totals[id];
      const row = el("div", { className: "lb-shared-row" }, [
        el("span", { className: "lb-kind-name", textContent: labelName(id) }),
        el("span", {
          className: "lb-kind-count",
          textContent: t.chats === 1 ? W.t("ws.lbCountInOne", t.count) : W.t("ws.lbCountIn", t.count, t.chats),
        }),
      ]);
      if (t.count > 1) {
        anyDifferent = true;
        row.append(el("span", { className: "lb-kind-count", textContent: W.t("ws.lbDifferent", t.different) }));
      }
      rows.append(row);
    }
    $("res-chats-different-note").hidden = !anyDifferent;
  }

  function renderInstructions(instructions) {
    const section = $("res-chats-instructions");
    if (!instructions || !Object.keys(instructions.kinds).length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const box = $("res-chats-instructions-kinds");
    box.textContent = "";
    const countText =
      instructions.chats === 1
        ? (count) => W.t("ws.lbCountInOne", count)
        : (count) => W.t("ws.lbCountIn", count, instructions.chats);
    for (const [id, count] of Object.entries(instructions.kinds)) {
      box.append(tagChip(id, `${labelName(id)} – ${countText(count)}`));
    }
  }

  function findRow(find) {
    return el("li", { className: "lb-find-row" }, [
      tagChip(find.kind),
      el("span", { className: "lb-find-masked", textContent: find.masked }),
      el("span", { className: "lb-find-where", textContent: whereLabel(find.where) }),
    ]);
  }

  function renderWhatNow(result) {
    const advice = $("res-chats-what-now-advice");
    advice.textContent = "";
    const seen = new Set();
    for (const chat of result.chats) {
      for (const kind of Object.keys(chat.kinds)) {
        const text = globalThis.ClotrInsights?.adviceFor(kind);
        if (text && !seen.has(text)) {
          seen.add(text);
          advice.append(el("li", { textContent: text }));
        }
      }
    }
    advice.append(el("li", { textContent: W.t("ws.lbDeleteNote") }));

    const actions = $("res-chats-what-now-actions");
    actions.textContent = "";
    if (result.format === "gemini") {
      const href = C.chatLink("gemini", "");
      if (href && C.chatLinkOk(href)) {
        const open = el("button", {
          type: "button",
          className: "btn text",
          textContent: W.t("ws.lbOpenActivity"),
        });
        open.addEventListener("click", () => openLink(href));
        actions.append(open);
      }
    }
  }

  function chatCard(chat, result) {
    const details = el("details", { className: "lb-card-item" });
    const head = el("div", { className: "lb-card-head" }, [
      el("span", { className: "lb-card-title", textContent: chat.title }),
    ]);
    if (chat.date) head.append(el("span", { className: "lb-card-date", textContent: chat.date }));
    for (const kind of Object.keys(chat.kinds)) head.append(tagChip(kind));
    const summary = el("summary", {}, [head]);
    const teaser = teaserFor(chat.kinds);
    if (teaser) summary.append(el("p", { className: "lb-card-teaser", textContent: teaser }));
    const excerpt = (chat.finds || [])
      .map((find) => find.masked)
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
    if (excerpt) summary.append(el("p", { className: "lb-card-excerpt", textContent: excerpt }));
    details.append(summary);

    const findsList = el(
      "ul",
      { className: "lb-finds" },
      chat.finds.map((f) => findRow(f)),
    );
    const body = el("div", { className: "lb-card-body" }, [findsList]);

    if (globalThis.ClotrInsights) {
      const adviceSeen = new Set();
      const advice = el("ul", { className: "lb-advice" }, [el("li", { textContent: W.t("ws.whatToDo") })]);
      for (const kind of Object.keys(chat.kinds)) {
        const text = globalThis.ClotrInsights.adviceFor(kind);
        if (text && !adviceSeen.has(text)) {
          adviceSeen.add(text);
          advice.append(el("li", { textContent: text }));
        }
      }
      body.append(advice);
    }

    const actions = el("div", { className: "btn-row" });
    if (chat.link && C.chatLinkOk(chat.link)) {
      const open = el("button", {
        type: "button",
        className: "btn text",
        textContent:
          result.grouping === "day" || result.format === "gemini" ? W.t("ws.lbOpenActivity") : W.t("ws.openChat"),
      });
      open.addEventListener("click", () => openLink(chat.link));
      actions.append(open);
    }
    // The deletion-letter panel (openLetterPanel, res-letter) stays out of v1's UI: no button opens it here.
    body.append(actions);
    details.append(body);
    return details;
  }

  function renderChatCards(result) {
    const box = $("res-chats-cards");
    box.textContent = "";
    const shown = result.chats.slice(0, 40);
    for (const chat of shown) box.append(chatCard(chat, result));
    const more = $("res-chats-more");
    if (result.chats.length > shown.length) {
      more.textContent = W.t("ws.lbMore", result.chats.length - shown.length);
      more.hidden = false;
    } else {
      more.hidden = true;
    }
  }

  const KEY_KINDS = new Set([
    "private_key",
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "xai_key",
    "google_api_key",
    "slack_token",
    "sentry_token",
    "grafana_token",
    "vault_token",
    "replicate_token",
    "linear_key",
    "postman_key",
    "shopify_token",
    "atlassian_token",
    "netlify_token",
    "pulumi_token",
    "databricks_token",
    "gitlab_token",
    "perplexity_key",
    "digitalocean_token",
    "huggingface_token",
    "heroku_token",
    "onepassword_token",
    "cloudflare_origin_ca_key",
    "twilio_credentials",
    "crypto_secret",
    "service_token",
    "connection_string",
    "jwt",
    "password",
    "otp_secret",
    "backup_codes",
  ]);
  const ID_KINDS = new Set([
    "us_ssn",
    "national_id",
    "medicare_id",
    "passport",
    "drivers_license",
    "insurance_id",
    "medical_record",
    "vin",
    "student_id",
    "my_id",
    "bank_account",
    "id_picture",
    "license_plate",
  ]);
  const CONTACT_KINDS = new Set(["phone_number", "email", "street_address"]);

  function renderPlainSteps(result) {
    const host = $("res-chats-steps");
    if (!host) return null;
    host.replaceChildren();
    const sorted = [...result.chats].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const keyItems = sorted.flatMap((chat) =>
      Object.keys(chat.kinds)
        .filter((kind) => KEY_KINDS.has(kind))
        .map((kind) => ({ chat, kind })),
    );
    const idChats = sorted.filter((chat) => Object.keys(chat.kinds).some((kind) => ID_KINDS.has(kind)));
    const contactKinds = [
      ...new Set(sorted.flatMap((chat) => Object.keys(chat.kinds).filter((kind) => CONTACT_KINDS.has(kind)))),
    ];
    const steps = [];

    function addStep(text, chats, action, detail = "") {
      const card = el("article", { className: "lb-card lb-plain-step" }, [el("p", { textContent: text })]);
      if (detail) card.append(el("p", { className: "small muted", textContent: detail }));
      const actions = el("div", { className: "btn-row" });
      if (action) actions.append(action);
      card.append(actions);
      const excerptList = el("div", { className: "lb-cards" });
      const initial = chats.slice(0, 5);
      for (const chat of initial) excerptList.append(chatCard(chat, result));
      if (chats.length > 5) {
        const all = el("details", { className: "lb-show-all" }, [
          el("summary", { textContent: W.t("ws.lbShowAll", chats.length - 5) }),
        ]);
        for (const chat of chats.slice(5)) all.append(chatCard(chat, result));
        excerptList.append(all);
      }
      card.append(excerptList);
      host.append(card);
      steps.push(card);
      return card;
    }

    for (const { chat, kind } of keyItems) {
      const open =
        chat.link && C.chatLinkOk(chat.link)
          ? el("button", { type: "button", className: "btn text", textContent: W.t("ws.openChat") })
          : null;
      open?.addEventListener("click", () => openLink(chat.link));
      addStep(
        chat.date
          ? W.t("ws.lbStepKey", kindName(kind), result.tool, chat.date)
          : W.t("ws.lbStepKeyNoDate", kindName(kind), result.tool),
        [chat],
        open,
        W.t("ws.lbKeyStillWorks"),
      );
    }
    if (idChats.length) {
      const action =
        result.format === "gemini"
          ? (() => {
              const button = el("button", {
                type: "button",
                className: "btn text",
                textContent: W.t("ws.lbOpenActivity"),
              });
              const href = C.chatLink("gemini", "");
              button.addEventListener("click", () => openLink(href));
              return button;
            })()
          : (() => {
              const chat = idChats[0];
              if (!chat.link || !C.chatLinkOk(chat.link)) return null;
              const button = el("button", { type: "button", className: "btn text", textContent: W.t("ws.openChat") });
              button.addEventListener("click", () => openLink(chat.link));
              return button;
            })();
      addStep(
        result.grouping === "day"
          ? W.t("ws.lbStepGeminiIds", idChats.length, result.tool)
          : W.t("ws.lbStepIds", idChats.length, result.tool),
        idChats,
        action,
      );
      if (result.format !== "gemini") {
        for (const chat of idChats) {
          if (chat.link && C.chatLinkOk(chat.link)) {
            const button = el("button", { type: "button", className: "btn text sm", textContent: W.t("ws.openChat") });
            button.addEventListener("click", () => openLink(chat.link));
            host.lastChild.querySelector?.(".btn-row")?.append(button);
          }
        }
      }
    }
    if (contactKinds.length) {
      const names = new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(
        contactKinds.map(kindName),
      );
      const contacts = sorted.filter((chat) => Object.keys(chat.kinds).some((kind) => CONTACT_KINDS.has(kind)));
      const chat = contacts[0];
      const action =
        chat?.link && C.chatLinkOk(chat.link)
          ? el("button", { type: "button", className: "btn text", textContent: W.t("ws.openChat") })
          : null;
      action?.addEventListener("click", () => openLink(chat.link));
      addStep(W.t("ws.lbStepContact", names), contacts, action);
    }

    if (steps.length) {
      const card = steps[0];
      const top = el("li", { className: "res-first-step", textContent: card.firstElementChild?.textContent || "" });
      const action = card.querySelector(".btn-row")?.firstElementChild;
      if (action) top.append(action);
      return top;
    }
    return null;
  }

  function renderNotRead(notRead) {
    const list = $("res-chats-notread-list");
    list.textContent = "";
    if (notRead.tooBig > 0) list.append(el("li", { textContent: W.t("ws.lbTooBig", notRead.tooBig) }));
    if (notRead.pictures > 0) list.append(el("li", { textContent: W.t("ws.lbPhotosNotRead", notRead.pictures) }));
    if (notRead.unpackLimit > 0) list.append(el("li", { textContent: W.t("ws.lbUnpackLimit") }));
    list.append(el("li", { textContent: W.t("ws.noOcr") }));
    list.append(el("li", { textContent: W.t("ws.lbDeletedGone") }));
    list.append(el("li", { textContent: W.t("ws.nothingKnown") }));
  }

  function updateResultSummary(result, step) {
    const count = result.chats.length;
    const priority = result.chats.some((chat) => Object.keys(chat.kinds).some((kind) => KEY_KINDS.has(kind)))
      ? 1
      : result.chats.some((chat) => Object.keys(chat.kinds).some((kind) => ID_KINDS.has(kind)))
        ? 2
        : 5;
    const sentence = count
      ? result.grouping === "day"
        ? W.t("ws.resLeadGemini", result.tool, count)
        : W.t("ws.resLeadChats", result.tool, count)
      : "";
    globalThis.ClotrResults?.setAreaSummary?.("chats", count, sentence, step, priority);
  }

  function render(result) {
    $("res-chats").hidden = false;
    $("res-chat-details").hidden = Object.keys(result.totals || {}).length === 0;
    $("res-letter").hidden = true;
    $("res-chats-found").textContent =
      result.chats.length > 0
        ? W.t("ws.lbFound", result.chats.length, result.read.chats)
        : W.t("ws.lbFoundNone", result.read.chats);
    const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("res-chats-note").textContent = W.t("ws.lbResNote", result.tool, now);
    $("res-chats-gemini-days").hidden = result.grouping !== "day";
    renderSharedRows(result.totals);
    renderInstructions(result.instructions);
    renderWhatNow(result);
    renderChatCards(result);
    renderNotRead(result.notRead);
    const step = renderPlainSteps(result);
    updateResultSummary(result, step);
  }

  function forgetResults() {
    $("res-chats-shared-rows").textContent = "";
    $("res-chats-cards").textContent = "";
    $("res-chats-notread-list").textContent = "";
    $("res-chats-instructions-kinds").textContent = "";
    $("res-letter-chat-picks").textContent = "";
    $("res-letter-box").value = "";
    $("res-chats").hidden = true;
    globalThis.ClotrResults?.setAreaSummary?.("chats", 0, "", null);
    $("res-letter").hidden = true;
    lastResult = null;
    showStart();
  }

  // ---------- The deletion letter (shared letter.js) ----------

  const DELETE_INFO = {
    chatgpt: { formUrl: "https://privacy.openai.com", email: "dsar@openai.com" },
    claude: { formUrl: null, email: "privacy@anthropic.com" },
    gemini: { formUrl: "https://support.google.com/legal/troubleshooter/1114905", email: null },
  };

  let letterUserEdited = false;

  function buildChatPicks(result, pickChat) {
    const box = $("res-letter-chat-picks");
    box.textContent = "";
    for (const chat of result.chats) {
      const input = el("input", { type: "checkbox" });
      input.checked = pickChat ? chat === pickChat : true;
      input.dataset.chatId = String(chat.id);
      input.addEventListener("change", regenerateLetter);
      const label = el("label", { className: "lb-chat-pick" }, [input]);
      if (result.grouping === "day" || result.format === "gemini") {
        label.append(el("span", { textContent: chat.date }));
      } else {
        label.append(el("span", { textContent: chat.title }));
        if (chat.date) label.append(el("span", { className: "lb-card-date", textContent: chat.date }));
      }
      box.append(label);
    }
  }

  function currentPlace() {
    const checked = document.querySelector('input[name="lb-letter-place"]:checked');
    return checked ? checked.value : undefined;
  }

  function pickedChats(result) {
    const ids = new Set([...$("res-letter-chat-picks").querySelectorAll("input:checked")].map((i) => i.dataset.chatId));
    return result.chats.filter((c) => ids.has(String(c.id)));
  }

  function regenerateLetter() {
    if (!lastResult || letterUserEdited) return;
    const result = lastResult;
    const chats = pickedChats(result);
    const kindIds = new Set();
    for (const c of chats) for (const id of Object.keys(c.kinds)) kindIds.add(id);
    const dates = chats
      .map((c) => c.date)
      .filter(Boolean)
      .sort();
    const links =
      result.grouping === "day" || result.format === "gemini"
        ? chats.map((c) => c.date)
        : chats.map((c) => (c.link && C.chatLinkOk(c.link) ? c.link : c.title));
    const { text, blanks } = C.letterFor({
      company: result.company,
      tool: result.tool,
      kindNames: [...kindIds].map(kindName),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      links,
      place: currentPlace(),
      lang,
    });
    $("res-letter-box").value = text;
    $("res-letter-blanks").textContent = W.t("ws.lbBlanks", blanks);
  }

  function openLetterPanel(result, chat) {
    lastResult = result;
    letterUserEdited = false;
    $("res-letter-heading").textContent = W.t("ws.askDelete", result.company);
    buildChatPicks(result, chat);
    for (const r of document.querySelectorAll('input[name="lb-letter-place"]')) r.checked = false;

    const info = DELETE_INFO[result.format] || {};
    const requests = $("res-letter-requests");
    if (info.formUrl) {
      const link = $("res-letter-requests-link");
      link.textContent = W.t("ws.lbOpenRequests", result.company);
      link.onclick = () => openLink(info.formUrl);
      requests.hidden = false;
    } else {
      requests.hidden = true;
    }
    const emailEl = $("res-letter-email");
    if (info.email) {
      emailEl.textContent = W.t("ws.lbEmailIt", info.email);
      emailEl.hidden = false;
    } else {
      emailEl.hidden = true;
    }
    $("res-letter-next-title").textContent = W.t("ws.lbNextTitle", result.company);
    $("res-letter-copy-status").textContent = "";

    regenerateLetter();

    $("res-chats").hidden = true;
    $("res-letter").hidden = false;
  }

  // ---------- Switching the Scan screen's pick ----------

  function show() {
    $("lookback-flow").hidden = false;
    if (worker || lastResult) return; // mid-read or already finished: leave it as it is
    showStart();
  }
  function hide() {
    $("lookback-flow").hidden = true;
    stopReading();
  }

  // ---------- Wiring (once, at startup) ----------

  function wireFilePicking() {
    $("lb-try-again").addEventListener("click", clearUnsupported);
    $("lb-choose-file").addEventListener("click", async () => {
      // Testing only: a dk-test-app build with CLOTR_LOOKBACK_FIXTURE set hands back a fixture's bytes directly, the
      // same way scan_start substitutes CLOTR_SCAN_ROOT for a test; a real build's command always refuses, so this
      // never changes what a real click does there. The fixture is always Claude's own one-file export (its
      // whole conversations.json), so there's nothing else to name it from.
      try {
        const bytes = await call("lookback_dk_fixture");
        const name = "conversations.json";
        beginRead("json", [{ name, file: new File([new Uint8Array(bytes)], name) }]);
        return;
      } catch {
        /* a real build, or no fixture set: the ordinary native picker */
      }
      $("lb-file-input").click();
    });
    $("lb-choose-folder").addEventListener("click", () => $("lb-folder-input").click());

    $("lb-file-input").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (isTgzName(file.name)) {
        showUnsupported("tgz");
        return;
      }
      beginRead(pickedKindFor(file.name), [{ name: file.name, file }]);
    });

    $("lb-folder-input").addEventListener("change", (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      beginRead(
        "folder",
        files.map((file) => ({ name: file.webkitRelativePath || file.name, file })),
      );
    });

    const dropzone = $("lb-dropzone");
    dropzone.addEventListener("click", () => $("lb-file-input").click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $("lb-file-input").click();
      }
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-over");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));

    function readEntryFile(entry) {
      return new Promise((resolve, reject) => entry.file(resolve, reject));
    }
    function readDirEntries(reader) {
      return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    }
    async function collectFolder(dirEntry, prefix, out) {
      const reader = dirEntry.createReader();
      for (;;) {
        const batch = await readDirEntries(reader);
        if (!batch.length) break;
        for (const entry of batch) {
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory) await collectFolder(entry, name, out);
          else out.push({ name, file: await readEntryFile(entry) });
        }
      }
    }

    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-over");
      const items = [...(e.dataTransfer?.items || [])];
      const entry = items.map((i) => i.webkitGetAsEntry?.()).find(Boolean);
      if (entry?.isDirectory) {
        const out = [];
        await collectFolder(entry, "", out);
        beginRead("folder", out);
        return;
      }
      if (entry?.isFile) {
        const file = await readEntryFile(entry);
        if (isTgzName(file.name)) {
          showUnsupported("tgz");
          return;
        }
        beginRead(pickedKindFor(file.name), [{ name: file.name, file }]);
        return;
      }
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        if (isTgzName(file.name)) {
          showUnsupported("tgz");
          return;
        }
        beginRead(pickedKindFor(file.name), [{ name: file.name, file }]);
      }
    });
  }

  function wire() {
    for (const tab of $("lb-tool-tabs").querySelectorAll(".lb-tab")) {
      tab.textContent = TOOLS[tab.dataset.tool].label; // a company's own name, never one of Clotr's own words
      tab.addEventListener("click", () => selectTool(tab.dataset.tool));
    }
    selectTool("chatgpt");
    $("lb-open-tool").addEventListener("click", () => openLink(TOOLS[currentTool].openUrl));
    $("lb-open-help").addEventListener("click", () => openLink(TOOLS[currentTool].helpUrl));
    wireFilePicking();
    $("lb-stop").addEventListener("click", stopReading);
    $("lb-again").addEventListener("click", () => {
      lastResult = null;
      showStart();
    });
    $("res-chats-forget").addEventListener("click", forgetResults);

    for (const r of document.querySelectorAll('input[name="lb-letter-place"]')) {
      r.addEventListener("change", regenerateLetter);
    }
    $("res-letter-box").addEventListener("input", () => {
      letterUserEdited = true;
      const blanks = ($("res-letter-box").value.match(/\[[^\]]*\]/g) || []).length;
      $("res-letter-blanks").textContent = W.t("ws.lbBlanks", blanks);
      $("res-letter-copy-status").textContent = "";
    });
    $("res-letter-copy").addEventListener("click", async () => {
      const box = $("res-letter-box");
      try {
        await navigator.clipboard.writeText(box.value);
        $("res-letter-copy-status").textContent = W.t("ws.lbCopied");
      } catch {
        box.focus();
        box.select();
        $("res-letter-copy-status").textContent = W.t("ws.lbCopyFailed");
      }
    });
    $("res-letter-back").addEventListener("click", () => {
      $("res-letter").hidden = true;
      $("res-chats").hidden = false;
    });
  }

  function draw(view, locale) {
    currentView = view;
    lang = locale;
    const row = [...(view?.scans || [])].reverse().find((item) => item.scan === "lookback");
    const target = $("lb-last-scan");
    if (target) {
      target.hidden = !SCAN_TIMES_ENABLED;
      if (!SCAN_TIMES_ENABLED) {
        target.textContent = "";
        return;
      }
      const when = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
      const seconds = Number(row?.seconds);
      const elapsed =
        Number.isFinite(seconds) && seconds >= 0
          ? seconds < 60
            ? W.t("ws.scanRowSeconds", String(Math.floor(seconds)))
            : W.t("ws.scanRowMinutes", String(Math.floor(seconds / 60)))
          : W.t("ws.scanRowNoTime");
      if (!row) target.textContent = W.t("ws.neverRan");
      else {
        const base = W.t("ws.lastRan", when.format(new Date(row.t)), String(row.items), elapsed);
        target.textContent = Date.now() - row.t >= 30 * 86_400_000 ? `${base} ${W.t("ws.runAgainWhenReady")}` : base;
      }
    }
  }

  // openLetterPanel: kept reachable here for when the deletion letter returns to the UI; nothing calls it yet.
  globalThis.ClotrLookback = {
    draw,
    wire,
    show,
    hide,
    tagClass,
    teaserFor,
    whereLabel,
    openLetterPanel,
    lookbackCounts,
    renderFixtureResult(result) {
      render(result);
    },
  };
})();
