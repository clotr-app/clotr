// Clotr for Windows — Look back: the Scan screen's third pick asks for the export and reads it, through the
// same worker and readers Check my files uses (scan-worker.js's readLookback()), with the same words and
// logic as the extension's own lookback.js. The reading step lives on the Scan screen (tool tabs, the drop
// zone, the progress bar and feed), the same real estate as Check my files' trace map; the finished result
// renders into the Results screen's own "Chats that hold private details" section (render() below), the same
// way scan-screen.js's finish() hands Check my files' list to results-screen.js. Nothing here is written to storage: the
// result lives in memory until "Forget these results" or another pick is chosen. "Open the chat" and the
// tool/help links never reach `ShellExecuteW` straight from this page: every one of them goes through
// `open_lookback_link` (allowed_links.rs), which checks it again with `lookback_link_ok()` before opening it.
"use strict";

(() => {
  const { call } = globalThis.ClotrApp || {};
  const W = globalThis.ClotrWords || { t: (key) => key };
  const C = globalThis.Clotr || {};
  const SCAN_TIMES_ENABLED = globalThis.ClotrDesktopFeatures?.scanTimes === true;
  const $ = (id) => document.getElementById(id);

  function makeNode(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // ---------- Colour and the one teaser line ----------

  // The same three groups the extension's own lookback.js uses: red for a key or an ID number, orange ("soon"
  // in the kit's own tag palette) for what scammers ask for, lemon ("test") for everything else personal.
  // Exported so a Node test can check them with no DOM.
  const RED_KINDS = new Set([
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
    "otp_secret",
    "backup_codes",
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
  // The ID-number half of RED_KINDS, named separately so the teaser line can tell a login key apart from an
  // ID number without a second, diverging list.
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

  // Red is the hand list plus every key in the engine's credentials group (finding-groups.js's isKeyKind), except a
  // password, which stays orange.
  function isRed(kindId) {
    if (RED_KINDS.has(kindId)) return true;
    if (AMBER_KINDS.has(kindId)) return false;
    return Boolean(globalThis.ClotrFindings?.isKeyKind(kindId));
  }

  function tagClass(kindId) {
    if (isRed(kindId)) return "err";
    if (AMBER_KINDS.has(kindId)) return "soon";
    return "test";
  }

  // The one teaser line for a card's most serious kind found: red first, then a password, then an ID number,
  // then a photo's place; a kind none of those cover (an address, an email, a phone…) gets no teaser, just
  // its tags.
  function teaserFor(kinds) {
    const ids = Object.keys(kinds);
    if (ids.some((kind) => isRed(kind) && !TEASER_ID_KINDS.has(kind))) return W.t("ws.whyKey");
    if (ids.includes("password")) return W.t("ws.lbWhyPassword");
    if (ids.some((kind) => TEASER_ID_KINDS.has(kind))) return W.t("ws.lbWhyId");
    if (ids.includes("photo_location")) return W.t("ws.whyPhoto");
    return "";
  }

  // ---------- Words ----------

  function locale() {
    return lang === "es" ? "es" : "en";
  }

  function kindName(kindId) {
    const plain = W.t(`ws.plain.${kindId}`);
    if (plain !== `ws.plain.${kindId}`) return plain;
    const found = (C.PATTERNS || []).find((pattern) => pattern.id === kindId);
    return found ? found.name.toLocaleLowerCase(locale()) : kindId.replaceAll("_", " ");
  }

  // The plain names start with "a" or "una" so they sit inside sentences; tags and rows drop it.
  function labelName(kindId) {
    const name = kindName(kindId).replace(/^(a|an|the|un|una|el|la|los|las) /i, "");
    return name.charAt(0).toLocaleUpperCase(locale()) + name.slice(1);
  }

  function tagChip(kindId, countText) {
    return makeNode("span", { className: `tag ${tagClass(kindId)}`, textContent: countText || labelName(kindId) });
  }

  // lookback-core.js's WHERE is always one of these five fixed English strings: an internal contract with
  // that file, matched here by exact value, never translated or guessed from a locale.
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

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    return `${Math.ceil(seconds / 60)}m`;
  }

  function foundHeading(result) {
    if (result.chats.length > 0) return W.t("ws.lbFound", result.chats.length, result.read.chats);
    return W.t("ws.lbFoundNone", result.read.chats);
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // ---------- Links ----------

  // Every address this screen can ever ask Rust to open: `open_lookback_link` checks it again with
  // `lookback_link_ok()` before it ever reaches ShellExecuteW (allowed_links.rs).
  function openLink(url) {
    if (url) call("open_lookback_link", { url }).catch(() => {});
  }

  function linkButton(words, url, className = "btn text") {
    const button = makeNode("button", { type: "button", className, textContent: words });
    button.addEventListener("click", () => openLink(url));
    return button;
  }

  // An "Open the chat" button for a chat whose link passes the check, or null.
  function openChatButton(chat) {
    if (!chat?.link || !C.chatLinkOk(chat.link)) return null;
    return linkButton(W.t("ws.openChat"), chat.link);
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
    for (const step of W.t(info.stepsKey).split(" / ")) steps.append(makeNode("li", { textContent: step }));
    $("lb-open-tool").textContent = W.t("ws.lbOpenTool", info.openName);
    $("lb-open-help").textContent = W.t("ws.lbHelp", info.openName);
  }

  // ---------- Step 2: picking the export ----------

  const UNSUPPORTED_WORD = {
    tgz: "ws.lbTgz",
    unknown: "ws.lbUnknown",
    unknownJson: "ws.lbUnknownJson",
    html: "ws.lbHtml",
    geminiNoChats: "ws.lbGeminiNoChats",
    damaged: "ws.lbDamaged",
  };

  function isTgzName(name) {
    return /\.tgz$|\.tar\.gz$/i.test(name || "");
  }

  function pickedKindFor(name) {
    return /\.json$/i.test(name || "") ? "json" : "zip";
  }

  function showUnsupported(kind) {
    const note = $("lb-unsupported");
    note.textContent = W.t(UNSUPPORTED_WORD[kind] || "ws.lbDamaged");
    note.hidden = false;
    $("lb-try-again").hidden = false;
  }

  function clearUnsupported() {
    $("lb-unsupported").hidden = true;
    $("lb-try-again").hidden = true;
  }

  // ---------- Reading: the worker, the progress UI, Stop ----------

  const FEED_ROWS = 30;

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
    const steps = [W.t("ws.lbStepOpen"), W.t("ws.lbStepChats"), W.t("ws.lbStepPhotos")];
    steps.forEach((step, i) =>
      list.append(makeNode("li", { textContent: step, className: i === 0 ? "is-active" : "" })),
    );
    $("lb-live-feed").textContent = "";
    lastAnnouncedQuarter = -1;
  }

  function markStepsThrough(index) {
    $("lb-steps-list")
      .querySelectorAll("li")
      .forEach((item, i) => {
        item.classList.toggle("is-done", i < index);
        item.classList.toggle("is-active", i === index);
      });
  }

  function stopReading() {
    worker?.terminate();
    worker = null;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = false;
  }

  // The reader gave up or broke: back to the start, saying why.
  function readFailed(kind) {
    stopReading();
    showUnsupported(kind);
  }

  function beginRead(picked, entries) {
    clearUnsupported();
    $("lb-start").hidden = true;
    $("lb-done").hidden = true;
    $("lb-reading").hidden = false;
    resetReadingUi(TOOLS[currentTool].label);
    announce(W.t("ws.lbReading", TOOLS[currentTool].label));
    readStartedAt = performance.now();

    worker = new Worker("check-my-files/scan-worker.js");
    let totalBytes = 0;

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "opened") {
        totalBytes = message.totalBytes || 0;
        markStepsThrough(1);
        return;
      }
      if (message.type === "progress") {
        onProgress(message, totalBytes);
        return;
      }
      if (message.type === "unsupported") {
        readFailed(message.kind);
        return;
      }
      if (message.type === "done") {
        worker?.terminate();
        worker = null;
        finishRead(message.result);
        return;
      }
      if (message.type === "error") readFailed("damaged");
    };
    worker.onerror = () => readFailed("damaged");

    const settings = currentView?.settings || {};
    worker.postMessage({
      type: "lookback",
      picked,
      entries,
      vault: { salt: settings.salt, entries: settings.vault || [] },
    });
  }

  function showTimeLeft(percent) {
    const elapsed = (performance.now() - readStartedAt) / 1000;
    const longEnough = percent > 2 && elapsed > 1;
    if (!longEnough) return;
    const left = formatSeconds(elapsed / (percent / 100) - elapsed);
    $("lb-time-left").textContent = left ? W.t("ws.lbLeft", left) : "";
  }

  function onProgress(tick, totalBytes) {
    markStepsThrough(1);
    const percent = totalBytes > 0 ? Math.min(100, Math.round((tick.liveBytes / totalBytes) * 100)) : 0;
    $("lb-progress-fill").style.width = `${percent}%`;
    $("lb-progress-bar").setAttribute("aria-valuenow", String(percent));
    $("lb-bytes-text").textContent = W.t("ws.lbBytes", formatBytes(tick.liveBytes), formatBytes(totalBytes));
    showTimeLeft(percent);
    $("lb-stat-chats-line").textContent = W.t("ws.lbStatChats", tick.read.chats);
    if (tick.chat) {
      const foundLine = $("lb-stat-found-line");
      const found = Number(foundLine.dataset.n || 0) + 1;
      foundLine.dataset.n = String(found);
      foundLine.textContent = W.t("ws.lbStatFound", found);
      addFeedRow(tick.chat);
    }
    if (percent >= 100) markStepsThrough(2);
    const quarter = Math.floor(percent / 25);
    if (quarter > lastAnnouncedQuarter && quarter > 0) {
      lastAnnouncedQuarter = quarter;
      announce($("lb-bytes-text").textContent);
    }
  }

  function addFeedRow(chat) {
    const feed = $("lb-live-feed");
    const row = makeNode("div", { className: "lb-feed-row" }, [makeNode("span", { textContent: chat.title })]);
    for (const kind of Object.keys(chat.kinds)) row.append(tagChip(kind));
    feed.append(row);
    while (feed.children.length > FEED_ROWS) feed.removeChild(feed.firstChild);
  }

  function showStart() {
    $("lb-done").hidden = true;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = false;
    clearUnsupported();
  }

  // ---------- A finished read, and History's row ----------

  function lookbackCounts(totals) {
    const out = {};
    for (const [id, total] of Object.entries(totals || {})) out[id] = total.count;
    return out;
  }

  // What changed since the last Look back, after the done line, when scan times are on.
  function showLookbackChange(recorded) {
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

  // History's own row for this read: how many chats, and how many of each kind across them, from the same
  // totals the Results screen already shows. Only History redraws from it, so the person never waits on it.
  function recordLookbackRow(result) {
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
        if (SCAN_TIMES_ENABLED && (recorded?.added || recorded?.gone)) showLookbackChange(recorded);
      })
      .catch(() => {});
  }

  function finishRead(result) {
    lastResult = result;
    $("lb-reading").hidden = true;
    $("lb-start").hidden = true;
    $("lb-done").hidden = false;
    $("lb-done-heading").textContent = foundHeading(result);
    $("lb-done-sub").textContent = W.t("ws.lbResNote", result.tool, timeNow());
    announce($("lb-done-heading").textContent);
    render(result);
    recordLookbackRow(result);
  }

  // ---------- Results (rendered into the Results screen's own section) ----------

  function countInWords(count, chats) {
    return chats === 1 ? W.t("ws.lbCountInOne", count) : W.t("ws.lbCountIn", count, chats);
  }

  function renderSharedRows(totals) {
    const rows = $("res-chats-shared-rows");
    rows.textContent = "";
    let anyDifferent = false;
    const ids = Object.keys(totals).sort((a, b) => labelName(a).localeCompare(labelName(b)));
    for (const id of ids) {
      const total = totals[id];
      const row = makeNode("div", { className: "lb-shared-row" }, [
        makeNode("span", { className: "lb-kind-name", textContent: labelName(id) }),
        makeNode("span", { className: "lb-kind-count", textContent: countInWords(total.count, total.chats) }),
      ]);
      if (total.count > 1) {
        anyDifferent = true;
        row.append(
          makeNode("span", { className: "lb-kind-count", textContent: W.t("ws.lbDifferent", total.different) }),
        );
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
    for (const [id, count] of Object.entries(instructions.kinds)) {
      box.append(tagChip(id, `${labelName(id)} – ${countInWords(count, instructions.chats)}`));
    }
  }

  function findRow(find) {
    return makeNode("li", { className: "lb-find-row" }, [
      tagChip(find.kind),
      makeNode("span", { className: "lb-find-masked", textContent: find.masked }),
      makeNode("span", { className: "lb-find-where", textContent: whereLabel(find.where) }),
    ]);
  }

  // Each piece of advice once, for the kinds in these chats, in the order they come.
  function adviceItems(chats) {
    const items = [];
    const seen = new Set();
    for (const chat of chats) {
      for (const kind of Object.keys(chat.kinds)) {
        const text = globalThis.ClotrInsights?.adviceFor(kind);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(makeNode("li", { textContent: text }));
      }
    }
    return items;
  }

  function renderWhatNow(result) {
    const advice = $("res-chats-what-now-advice");
    advice.textContent = "";
    advice.append(...adviceItems(result.chats));
    advice.append(makeNode("li", { textContent: W.t("ws.lbDeleteNote") }));

    const actions = $("res-chats-what-now-actions");
    actions.textContent = "";
    if (result.format !== "gemini") return;
    const href = C.chatLink("gemini", "");
    if (href && C.chatLinkOk(href)) actions.append(linkButton(W.t("ws.lbOpenActivity"), href));
  }

  // ---------- One chat's card ----------

  function chatSummary(chat) {
    const head = makeNode("div", { className: "lb-card-head" }, [
      makeNode("span", { className: "lb-card-title", textContent: chat.title }),
    ]);
    if (chat.date) head.append(makeNode("span", { className: "lb-card-date", textContent: chat.date }));
    for (const kind of Object.keys(chat.kinds)) head.append(tagChip(kind));
    const summary = makeNode("summary", {}, [head]);
    const teaser = teaserFor(chat.kinds);
    if (teaser) summary.append(makeNode("p", { className: "lb-card-teaser", textContent: teaser }));
    const excerpt = (chat.finds || [])
      .map((find) => find.masked)
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
    if (excerpt) summary.append(makeNode("p", { className: "lb-card-excerpt", textContent: excerpt }));
    return summary;
  }

  function chatAdvice(chat) {
    const advice = makeNode("ul", { className: "lb-advice" }, [makeNode("li", { textContent: W.t("ws.whatToDo") })]);
    advice.append(...adviceItems([chat]));
    return advice;
  }

  function chatCard(chat, result) {
    const details = makeNode("details", { className: "lb-card-item" });
    details.append(chatSummary(chat));

    const findsList = makeNode(
      "ul",
      { className: "lb-finds" },
      chat.finds.map((find) => findRow(find)),
    );
    const body = makeNode("div", { className: "lb-card-body" }, [findsList]);
    if (globalThis.ClotrInsights) body.append(chatAdvice(chat));

    const actions = makeNode("div", { className: "btn-row" });
    if (chat.link && C.chatLinkOk(chat.link)) {
      const byDay = result.grouping === "day" || result.format === "gemini";
      actions.append(linkButton(byDay ? W.t("ws.lbOpenActivity") : W.t("ws.openChat"), chat.link));
    }
    // The deletion-letter panel (openLetterPanel, res-letter) stays out of v1's UI: no button opens it here.
    body.append(actions);
    details.append(body);
    return details;
  }

  const CARDS_SHOWN = 40;

  function renderChatCards(result) {
    const box = $("res-chats-cards");
    box.textContent = "";
    const shown = result.chats.slice(0, CARDS_SHOWN);
    for (const chat of shown) box.append(chatCard(chat, result));
    const more = $("res-chats-more");
    if (result.chats.length > shown.length) {
      more.textContent = W.t("ws.lbMore", result.chats.length - shown.length);
      more.hidden = false;
    } else {
      more.hidden = true;
    }
  }

  // ---------- The plain steps ----------

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
  // A key for the steps and the summary: the hand list plus every key in the engine's credentials group.
  function isKeyKind(kind) {
    return KEY_KINDS.has(kind) || Boolean(globalThis.ClotrFindings?.isKeyKind(kind));
  }
  const CONTACT_KINDS = new Set(["phone_number", "email", "street_address"]);

  function hasKindIn(chat, kindSet) {
    return Object.keys(chat.kinds).some((kind) => kindSet.has(kind));
  }

  // One step's card: what to do, an optional detail and button, then its chats, the first five shown and the
  // rest folded under "Show all".
  function addPlainStep(host, steps, result, { text, chats, action, detail = "" }) {
    const card = makeNode("article", { className: "lb-card lb-plain-step" }, [makeNode("p", { textContent: text })]);
    if (detail) card.append(makeNode("p", { className: "small muted", textContent: detail }));
    const actions = makeNode("div", { className: "btn-row" });
    if (action) actions.append(action);
    card.append(actions);
    const excerptList = makeNode("div", { className: "lb-cards" });
    for (const chat of chats.slice(0, 5)) excerptList.append(chatCard(chat, result));
    if (chats.length > 5) {
      const all = makeNode("details", { className: "lb-show-all" }, [
        makeNode("summary", { textContent: W.t("ws.lbShowAll", chats.length - 5) }),
      ]);
      for (const chat of chats.slice(5)) all.append(chatCard(chat, result));
      excerptList.append(all);
    }
    card.append(excerptList);
    host.append(card);
    steps.push(card);
    return card;
  }

  // A step for each key found, newest chat first: a key still works until it's changed.
  function addKeySteps(host, steps, result, sorted) {
    const keyItems = sorted.flatMap((chat) =>
      Object.keys(chat.kinds)
        .filter(isKeyKind)
        .map((kind) => ({ chat, kind })),
    );
    for (const { chat, kind } of keyItems) {
      const text = chat.date
        ? W.t("ws.lbStepKey", kindName(kind), result.tool, chat.date)
        : W.t("ws.lbStepKeyNoDate", kindName(kind), result.tool);
      const action = openChatButton(chat);
      addPlainStep(host, steps, result, { text, chats: [chat], action, detail: W.t("ws.lbKeyStillWorks") });
    }
  }

  // Gemini's activity page for an export grouped by day, or the first ID chat's own link.
  function idStepAction(result, idChats) {
    if (result.format === "gemini") return linkButton(W.t("ws.lbOpenActivity"), C.chatLink("gemini", ""));
    return openChatButton(idChats[0]);
  }

  // One step for every chat with an ID number, with an "Open the chat" button per chat that has a link.
  function addIdStep(host, steps, result, sorted) {
    const idChats = sorted.filter((chat) => hasKindIn(chat, ID_KINDS));
    if (!idChats.length) return;
    const action = idStepAction(result, idChats);
    const text =
      result.grouping === "day"
        ? W.t("ws.lbStepGeminiIds", idChats.length, result.tool)
        : W.t("ws.lbStepIds", idChats.length, result.tool);
    addPlainStep(host, steps, result, { text, chats: idChats, action });
    if (result.format === "gemini") return;
    for (const chat of idChats) {
      if (!chat.link || !C.chatLinkOk(chat.link)) continue;
      const button = linkButton(W.t("ws.openChat"), chat.link, "btn text sm");
      host.lastChild.querySelector?.(".btn-row")?.append(button);
    }
  }

  // One step for the contact details found, naming each kind once.
  function addContactStep(host, steps, result, sorted) {
    const contactKinds = [
      ...new Set(sorted.flatMap((chat) => Object.keys(chat.kinds).filter((kind) => CONTACT_KINDS.has(kind)))),
    ];
    if (!contactKinds.length) return;
    const names = new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(
      contactKinds.map(kindName),
    );
    const contacts = sorted.filter((chat) => hasKindIn(chat, CONTACT_KINDS));
    const action = openChatButton(contacts[0]);
    addPlainStep(host, steps, result, { text: W.t("ws.lbStepContact", names), chats: contacts, action });
  }

  // The first step's words and button, as the line Results' own "What to do first" shows.
  function firstStepItem(steps) {
    if (!steps.length) return null;
    const card = steps[0];
    const top = makeNode("li", { className: "res-first-step", textContent: card.firstElementChild?.textContent || "" });
    const action = card.querySelector(".btn-row")?.firstElementChild;
    if (action) top.append(action);
    return top;
  }

  function renderPlainSteps(result) {
    const host = $("res-chats-steps");
    if (!host) return null;
    host.replaceChildren();
    const sorted = [...result.chats].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const steps = [];
    addKeySteps(host, steps, result, sorted);
    addIdStep(host, steps, result, sorted);
    addContactStep(host, steps, result, sorted);
    return firstStepItem(steps);
  }

  // ---------- What wasn't read, the summary, and the whole section ----------

  function renderNotRead(notRead) {
    const list = $("res-chats-notread-list");
    list.textContent = "";
    if (notRead.tooBig > 0) list.append(makeNode("li", { textContent: W.t("ws.lbTooBig", notRead.tooBig) }));
    if (notRead.pictures > 0) {
      list.append(makeNode("li", { textContent: W.t("ws.lbPhotosNotRead", notRead.pictures) }));
    }
    if (notRead.unpackLimit > 0) list.append(makeNode("li", { textContent: W.t("ws.lbUnpackLimit") }));
    list.append(makeNode("li", { textContent: W.t("ws.noOcr") }));
    list.append(makeNode("li", { textContent: W.t("ws.lbDeletedGone") }));
    list.append(makeNode("li", { textContent: W.t("ws.nothingKnown") }));
  }

  // Where this area sits among Results' own: a key first, then an ID number, else with the rest.
  function summaryPriority(chats) {
    if (chats.some((chat) => Object.keys(chat.kinds).some(isKeyKind))) return 1;
    if (chats.some((chat) => hasKindIn(chat, ID_KINDS))) return 2;
    return 5;
  }

  function leadSentence(result, count) {
    if (!count) return "";
    if (result.grouping === "day") return W.t("ws.resLeadGemini", result.tool, count);
    return W.t("ws.resLeadChats", result.tool, count);
  }

  function updateResultSummary(result, step) {
    const count = result.chats.length;
    const priority = summaryPriority(result.chats);
    const sentence = leadSentence(result, count);
    globalThis.ClotrResults?.setAreaSummary?.("chats", count, sentence, step, priority);
  }

  function render(result) {
    $("res-chats").hidden = false;
    $("res-chat-details").hidden = Object.keys(result.totals || {}).length === 0;
    $("res-letter").hidden = true;
    $("res-chats-found").textContent = foundHeading(result);
    $("res-chats-note").textContent = W.t("ws.lbResNote", result.tool, timeNow());
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

  function isByDay(result) {
    return result.grouping === "day" || result.format === "gemini";
  }

  function buildChatPicks(result, pickChat) {
    const box = $("res-letter-chat-picks");
    box.textContent = "";
    for (const chat of result.chats) {
      const input = makeNode("input", { type: "checkbox" });
      input.checked = pickChat ? chat === pickChat : true;
      input.dataset.chatId = String(chat.id);
      input.addEventListener("change", regenerateLetter);
      const label = makeNode("label", { className: "lb-chat-pick" }, [input]);
      if (isByDay(result)) {
        label.append(makeNode("span", { textContent: chat.date }));
      } else {
        label.append(makeNode("span", { textContent: chat.title }));
        if (chat.date) label.append(makeNode("span", { className: "lb-card-date", textContent: chat.date }));
      }
      box.append(label);
    }
  }

  function currentPlace() {
    const checked = document.querySelector('input[name="lb-letter-place"]:checked');
    return checked ? checked.value : undefined;
  }

  function pickedChats(result) {
    const checked = [...$("res-letter-chat-picks").querySelectorAll("input:checked")];
    const ids = new Set(checked.map((input) => input.dataset.chatId));
    return result.chats.filter((chat) => ids.has(String(chat.id)));
  }

  function regenerateLetter() {
    if (!lastResult || letterUserEdited) return;
    const result = lastResult;
    const chats = pickedChats(result);
    const kindIds = new Set();
    for (const chat of chats) for (const id of Object.keys(chat.kinds)) kindIds.add(id);
    const dates = chats
      .map((chat) => chat.date)
      .filter(Boolean)
      .sort();
    const links = isByDay(result)
      ? chats.map((chat) => chat.date)
      : chats.map((chat) => (chat.link && C.chatLinkOk(chat.link) ? chat.link : chat.title));
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

  function showWhereToSend(result) {
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
  }

  function openLetterPanel(result, chat) {
    lastResult = result;
    letterUserEdited = false;
    $("res-letter-heading").textContent = W.t("ws.askDelete", result.company);
    buildChatPicks(result, chat);
    for (const radio of document.querySelectorAll('input[name="lb-letter-place"]')) radio.checked = false;
    showWhereToSend(result);
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

  // ---------- Wiring: picking and dropping a file ----------

  // A picked or dropped file: a .tgz says it can't be read, anything else is read as JSON or a zip.
  function beginReadOf(file) {
    if (isTgzName(file.name)) {
      showUnsupported("tgz");
      return;
    }
    beginRead(pickedKindFor(file.name), [{ name: file.name, file }]);
  }

  async function chooseFile() {
    // Testing only: a dk-test-app build with CLOTR_LOOKBACK_FIXTURE set hands back a fixture's bytes
    // directly, the same way scan_start substitutes CLOTR_SCAN_ROOT for a test; a real build's command always
    // refuses, so this never changes what a real click does there. The fixture is always Claude's own
    // one-file export (its whole conversations.json), so there's nothing else to name it from.
    try {
      const bytes = await call("lookback_dk_fixture");
      const name = "conversations.json";
      beginRead("json", [{ name, file: new File([new Uint8Array(bytes)], name) }]);
      return;
    } catch {
      /* a real build, or no fixture set: the ordinary native picker */
    }
    $("lb-file-input").click();
  }

  function onFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    beginReadOf(file);
  }

  function onFolderChosen(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    beginRead(
      "folder",
      files.map((file) => ({ name: file.webkitRelativePath || file.name, file })),
    );
  }

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

  async function onDrop(event, dropzone) {
    event.preventDefault();
    dropzone.classList.remove("is-over");
    const items = [...(event.dataTransfer?.items || [])];
    const entry = items.map((item) => item.webkitGetAsEntry?.()).find(Boolean);
    if (entry?.isDirectory) {
      const out = [];
      await collectFolder(entry, "", out);
      beginRead("folder", out);
      return;
    }
    if (entry?.isFile) {
      beginReadOf(await readEntryFile(entry));
      return;
    }
    const file = event.dataTransfer?.files?.[0];
    if (file) beginReadOf(file);
  }

  function wireDropzone() {
    const dropzone = $("lb-dropzone");
    dropzone.addEventListener("click", () => $("lb-file-input").click());
    dropzone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      $("lb-file-input").click();
    });
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-over");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
    dropzone.addEventListener("drop", (event) => onDrop(event, dropzone));
  }

  function wireFilePicking() {
    $("lb-try-again").addEventListener("click", clearUnsupported);
    $("lb-choose-file").addEventListener("click", chooseFile);
    $("lb-choose-folder").addEventListener("click", () => $("lb-folder-input").click());
    $("lb-file-input").addEventListener("change", onFileChosen);
    $("lb-folder-input").addEventListener("change", onFolderChosen);
    wireDropzone();
  }

  // ---------- Wiring: the letter, and the rest ----------

  async function copyLetter() {
    const box = $("res-letter-box");
    try {
      await navigator.clipboard.writeText(box.value);
      $("res-letter-copy-status").textContent = W.t("ws.lbCopied");
    } catch {
      box.focus();
      box.select();
      $("res-letter-copy-status").textContent = W.t("ws.lbCopyFailed");
    }
  }

  function wireLetter() {
    for (const radio of document.querySelectorAll('input[name="lb-letter-place"]')) {
      radio.addEventListener("change", regenerateLetter);
    }
    $("res-letter-box").addEventListener("input", () => {
      letterUserEdited = true;
      const blanks = ($("res-letter-box").value.match(/\[[^\]]*\]/g) || []).length;
      $("res-letter-blanks").textContent = W.t("ws.lbBlanks", blanks);
      $("res-letter-copy-status").textContent = "";
    });
    $("res-letter-copy").addEventListener("click", copyLetter);
    $("res-letter-back").addEventListener("click", () => {
      $("res-letter").hidden = true;
      $("res-chats").hidden = false;
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
    wireLetter();
  }

  // ---------- Drawing: the last Look back ----------

  const DAY_MS = 86_400_000;

  function elapsedWords(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return W.t("ws.scanRowNoTime");
    if (seconds < 60) return W.t("ws.scanRowSeconds", String(Math.floor(seconds)));
    return W.t("ws.scanRowMinutes", String(Math.floor(seconds / 60)));
  }

  function draw(view, nextLocale) {
    currentView = view;
    lang = nextLocale;
    const row = [...(view?.scans || [])].reverse().find((item) => item.scan === "lookback");
    const target = $("lb-last-scan");
    if (!target) return;
    target.hidden = !SCAN_TIMES_ENABLED;
    if (!SCAN_TIMES_ENABLED) {
      target.textContent = "";
      return;
    }
    const when = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
    const elapsed = elapsedWords(Number(row?.seconds));
    if (!row) {
      target.textContent = W.t("ws.neverRan");
      return;
    }
    const base = W.t("ws.lastRan", when.format(new Date(row.t)), String(row.items), elapsed);
    target.textContent = Date.now() - row.t >= 30 * DAY_MS ? `${base} ${W.t("ws.runAgainWhenReady")}` : base;
  }

  // openLetterPanel: kept reachable here for when the deletion letter returns to the UI; nothing calls it
  // yet.
  globalThis.ClotrLookback = {
    draw,
    wire,
    show,
    hide,
    tagClass,
    isKeyKind,
    teaserFor,
    whereLabel,
    openLetterPanel,
    lookbackCounts,
    renderFixtureResult(result) {
      render(result);
    },
  };
})();
