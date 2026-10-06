// Look back's page. It lets you pick an export, hands the picked files to lookback-worker.js as File objects
// (never a copy of their bytes), and shows the worker's progress and results, without ever reading a byte of
// the export itself or writing anything to storage: results live in memory until you hit "Forget these
// results" or close the page. The one exception is `chatLinkOk()`, loaded here from lookback-core.js, which
// is the only thing standing between a finding and "Open the chat" actually opening a tab.
"use strict";

(() => {
  const { scanWord, chatLinkOk, exportLinkOk, manifestExpiry, PATTERNS, adviceFor, letterFor } = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  };
  const lines = (key, ...subs) =>
    scanWord(key, ...subs)
      .split("\n")
      .filter(Boolean);

  // ---------- Which group a kind's tag chip falls in (3 colours) ----------
  // Red covers a key or an ID number, amber covers a password, a card, or a code, and blue covers everything
  // else personal. A kind this page has never heard of defaults to blue, since most of what Look back finds is
  // a personal detail rather than a secret.
  const RED_KINDS = new Set([
    "private_key",
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "google_api_key",
    "slack_token",
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
  // The ID-number half of RED_KINDS, named separately so the teaser line can tell a login key apart from an
  // ID number instead of keeping a second list that could drift out of sync.
  const ID_KINDS = new Set([
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
  function tagColor(kindId) {
    if (RED_KINDS.has(kindId)) return "red";
    if (AMBER_KINDS.has(kindId)) return "amber";
    return "blue";
  }
  function kindName(kindId) {
    return PATTERNS?.find((p) => p.id === kindId)?.name || kindId;
  }
  function tagChip(kindId, countText) {
    return el("span", { className: `lb-tag lb-tag-${tagColor(kindId)}`, textContent: countText || kindName(kindId) });
  }

  // lookback-core.js always sets find.where to one of these five fixed English strings, so I can match it by
  // exact value here rather than translating or guessing it from a locale.
  const WHERE_INDEX = {
    "your message": 0,
    "a message you later edited": 1,
    "a file you attached": 2,
    "a voice note": 3,
    "your custom instructions": 4,
  };
  function whereLabel(where) {
    const words = lines("lb_where");
    const i = WHERE_INDEX[where];
    return i === undefined ? "" : words[i] || "";
  }

  // Picks one teaser line for a card's most serious kind found, checking red first, then amber, then blue's
  // own lines. A kind none of those cover, like an address or an email, gets no teaser, just its tags.
  function teaserFor(kinds) {
    const ids = Object.keys(kinds);
    if (ids.some((k) => RED_KINDS.has(k) && !ID_KINDS.has(k))) return scanWord("lb_whyKey");
    if (ids.includes("password")) return scanWord("lb_whyPassword");
    if (ids.some((k) => ID_KINDS.has(k))) return scanWord("lb_whyId");
    if (ids.includes("photo_location")) return scanWord("lb_whyPhoto");
    return "";
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

  // ---------- Step 1: which tool, and its steps ----------

  const TOOLS = {
    chatgpt: {
      label: "ChatGPT",
      stepsKey: "lb_chatgptSteps",
      openUrl: "https://chatgpt.com/",
      openName: "ChatGPT",
      helpUrl: "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
    },
    claude: {
      label: "Claude",
      stepsKey: "lb_claudeSteps",
      openUrl: "https://claude.ai/",
      openName: "Claude",
      helpUrl: "https://privacy.claude.com/en/articles/9450526-export-your-claude-data",
    },
    gemini: {
      label: "Gemini",
      stepsKey: "lb_geminiSteps",
      openUrl: "https://takeout.google.com/",
      openName: "Google Takeout",
      helpUrl: "https://support.google.com/gemini/answer/16920332",
    },
  };

  let currentTool = "chatgpt";
  function selectTool(tool) {
    if (!TOOLS[tool]) return;
    currentTool = tool;
    for (const tab of $("tool-tabs").querySelectorAll(".lb-tab")) {
      const on = tab.dataset.tool === tool;
      tab.setAttribute("aria-selected", String(on));
    }
    const info = TOOLS[tool];
    const steps = $("tool-steps");
    steps.textContent = "";
    for (const step of lines(info.stepsKey)) steps.append(el("li", { textContent: step }));
    const openTool = $("open-tool");
    openTool.href = info.openUrl;
    openTool.textContent = scanWord("lb_openTool", info.openName);
    const openHelp = $("open-help");
    openHelp.href = info.helpUrl;
    openHelp.textContent = scanWord("lb_help", info.openName);
  }
  for (const tab of $("tool-tabs").querySelectorAll(".lb-tab")) {
    tab.addEventListener("click", () => selectTool(tab.dataset.tool));
  }
  selectTool("chatgpt");

  // ---------- Step 2: picking the export ----------

  function isTgzName(name) {
    return /\.tgz$|\.tar\.gz$/i.test(name || "");
  }
  function pickedKindFor(name) {
    return /\.jsonl?$/i.test(name || "") ? "json" : "zip";
  }
  // Several files chosen at once, such as Claude's split export, get read as one export through
  // lookback-worker.js's "parts" branch, rather than as a single zip or a folder.
  function pickedKindForMany(files) {
    return files.length > 1 ? "parts" : pickedKindFor(files[0]?.name);
  }

  function showUnsupported(kind) {
    const text =
      {
        tgz: scanWord("lb_tgz"),
        unknown: scanWord("lb_unknown"),
        html: scanWord("lb_html"),
        damaged: scanWord("lb_damaged"),
      }[kind] || scanWord("lb_damaged");
    const p = $("unsupported");
    p.textContent = text;
    p.hidden = false;
    $("try-again").hidden = false;
  }
  function clearUnsupported() {
    $("unsupported").hidden = true;
    $("try-again").hidden = true;
  }
  $("try-again").addEventListener("click", clearUnsupported);
  $("unknown-again").addEventListener("click", showStart);

  $("choose-file").addEventListener("click", () => $("file-input").click());
  $("choose-folder").addEventListener("click", () => $("folder-input").click());

  $("file-input").addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    if (files.some((file) => isTgzName(file.name))) {
      showUnsupported("tgz");
      return;
    }
    beginRead(
      pickedKindForMany(files),
      files.map((file) => ({ name: file.name, file })),
    );
  });

  $("folder-input").addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    beginRead(
      "folder",
      files.map((file) => ({ name: file.webkitRelativePath || file.name, file })),
    );
  });

  const dropzone = $("dropzone");
  dropzone.addEventListener("click", () => $("file-input").click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $("file-input").click();
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
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const dirEntry = entries.find((en) => en.isDirectory);
    if (dirEntry) {
      const out = [];
      await collectFolder(dirEntry, "", out);
      if (out.length) beginRead("folder", out);
      return;
    }
    const fileEntries = entries.filter((en) => en.isFile);
    if (fileEntries.length) {
      const files = await Promise.all(fileEntries.map((en) => readEntryFile(en)));
      if (files.some((file) => isTgzName(file.name))) {
        showUnsupported("tgz");
        return;
      }
      beginRead(
        pickedKindForMany(files),
        files.map((file) => ({ name: file.name, file })),
      );
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      if (files.some((file) => isTgzName(file.name))) {
        showUnsupported("tgz");
        return;
      }
      beginRead(
        pickedKindForMany(files),
        files.map((file) => ({ name: file.name, file })),
      );
    }
  });

  // ---------- Reading: the worker, the progress UI, Stop ----------

  let worker = null;
  let readStartedAt = 0;
  let lastAnnouncedQuarter = -1;
  const seenKinds = new Set();

  function announce(text) {
    if (!text) return;
    $("live-region").textContent = text;
  }

  function resetReadingUi(toolLabel) {
    $("reading-heading").textContent = scanWord("lb_reading", toolLabel);
    $("progress-fill").style.width = "0%";
    $("progress-bar").setAttribute("aria-valuenow", "0");
    $("bytes-text").textContent = "";
    $("time-left").textContent = "";
    $("stat-chats-line").textContent = "";
    $("stat-found-line").textContent = "";
    const stepWords = lines("lb_steps");
    const list = $("steps-list");
    list.textContent = "";
    stepWords.forEach((step, i) => list.append(el("li", { textContent: step, className: i === 0 ? "is-active" : "" })));
    $("live-feed").textContent = "";
    lastAnnouncedQuarter = -1;
    seenKinds.clear();
  }

  function markStepsThrough(index) {
    const list = $("steps-list").querySelectorAll("li");
    list.forEach((li, i) => {
      li.classList.toggle("is-done", i < index);
      li.classList.toggle("is-active", i === index);
    });
  }

  function beginRead(picked, entries) {
    clearUnsupported();
    $("start").hidden = true;
    $("results").hidden = true;
    $("unknown-result").hidden = true;
    $("manifest-result").hidden = true;
    $("reading").hidden = false;
    resetReadingUi(TOOLS[currentTool].label);
    announce(scanWord("lb_reading", TOOLS[currentTool].label));
    readStartedAt = Date.now();

    worker = new Worker("lookback-worker.js");
    let totalBytes = 0;

    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "manifest") {
        showManifest(msg.manifest);
      } else if (msg.type === "opened") {
        totalBytes = msg.totalBytes || 0;
        markStepsThrough(1);
      } else if (msg.type === "progress") {
        onProgress(msg, totalBytes);
      } else if (msg.type === "unsupported") {
        worker?.terminate();
        worker = null;
        $("reading").hidden = true;
        $("start").hidden = false;
        showUnsupported(msg.kind);
      } else if (msg.type === "done") {
        worker?.terminate();
        worker = null;
        showResults(msg.result);
      } else if (msg.type === "error") {
        worker?.terminate();
        worker = null;
        $("reading").hidden = true;
        $("start").hidden = false;
        showUnsupported("damaged");
      }
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      $("reading").hidden = true;
      $("start").hidden = false;
      showUnsupported("damaged");
    };

    chrome.storage.local.get(["salt", "vault"]).then(({ salt, vault }) => {
      worker?.postMessage({ type: "start", picked, entries, vault: { salt, entries: vault || [] } });
    });
  }

  function onProgress(tick, totalBytes) {
    markStepsThrough(1);
    const pct = totalBytes > 0 ? Math.min(100, Math.round((tick.liveBytes / totalBytes) * 100)) : 0;
    $("progress-fill").style.width = `${pct}%`;
    $("progress-bar").setAttribute("aria-valuenow", String(pct));
    $("bytes-text").textContent = scanWord("lb_bytes", formatBytes(tick.liveBytes), formatBytes(totalBytes));
    const elapsed = (Date.now() - readStartedAt) / 1000;
    if (pct > 2 && elapsed > 1) {
      const totalEst = elapsed / (pct / 100);
      const left = formatSeconds(totalEst - elapsed);
      $("time-left").textContent = left ? scanWord("lb_left", left) : "";
    }
    const statWords = lines("lb_stats");
    const chatsLine = `${tick.read.chats} ${statWords[0] || ""}`.trim();
    $("stat-chats-line").textContent = chatsLine;

    if (tick.chat) {
      const holdWords = [statWords[1], statWords[2]].filter(Boolean).join(" ");
      const foundSoFar = Number($("stat-found-line").dataset.n || 0) + 1;
      $("stat-found-line").dataset.n = String(foundSoFar);
      $("stat-found-line").textContent = `${foundSoFar} ${holdWords}`.trim();
      addFeedRow(tick.chat);
      for (const kind of Object.keys(tick.chat.kinds)) {
        if (!seenKinds.has(kind)) {
          seenKinds.add(kind);
          announce(kindName(kind));
        }
      }
    }
    if (pct >= 100) markStepsThrough(2);
    const quarter = Math.floor(pct / 25);
    if (quarter > lastAnnouncedQuarter && quarter > 0) {
      lastAnnouncedQuarter = quarter;
      announce($("bytes-text").textContent);
    }
  }

  function addFeedRow(chat) {
    const feed = $("live-feed");
    const row = el("div", { className: "lb-feed-row" });
    row.append(el("span", { textContent: chat.title }));
    for (const kind of Object.keys(chat.kinds)) row.append(tagChip(kind));
    feed.append(row);
    while (feed.children.length > 30) feed.removeChild(feed.firstChild);
  }

  $("stop").addEventListener("click", () => {
    worker?.terminate();
    worker = null;
    $("reading").hidden = true;
    $("start").hidden = false;
  });

  function showStart() {
    $("unknown-result").hidden = true;
    $("manifest-result").hidden = true;
    $("results").hidden = true;
    $("letter-panel").hidden = true;
    $("reading").hidden = true;
    $("start").hidden = false;
    clearUnsupported();
  }

  // ---------- The manifest screen (Claude's manifest export) ----------

  function showManifest(manifest) {
    worker?.terminate();
    worker = null;
    $("reading").hidden = true;
    $("start").hidden = true;
    $("results").hidden = true;
    $("manifest-result").hidden = false;

    const expiry = manifestExpiry(manifest.createdAt);
    $("manifest-expiry").textContent = expiry
      ? scanWord("lb_manifestExpiry", new Date(expiry).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))
      : "";

    const list = $("manifest-links");
    list.textContent = "";
    for (const file of manifest.files) {
      const li = el("li", { className: "lb-manifest-link" });
      if (exportLinkOk(file.url)) {
        li.append(
          el("a", { href: file.url, target: "_blank", rel: "noopener noreferrer", textContent: file.filename }),
        );
      } else {
        li.append(el("span", { textContent: file.filename }));
      }
      list.append(li);
    }

    $("manifest-heading").focus();
  }
  $("manifest-choose").addEventListener("click", showStart);

  // ---------- Results ----------

  function renderSharedRows(totals) {
    const rows = $("shared-rows");
    rows.textContent = "";
    let anyDifferent = false;
    const ids = Object.keys(totals).sort((a, b) => kindName(a).localeCompare(kindName(b)));
    for (const id of ids) {
      const t = totals[id];
      const row = el("div", { className: "lb-shared-row" });
      row.append(el("span", { className: "lb-kind-name", textContent: kindName(id) }));
      row.append(
        el("span", {
          className: "lb-kind-count",
          textContent: t.chats === 1 ? scanWord("lb_countInOne", t.count) : scanWord("lb_countIn", t.count, t.chats),
        }),
      );
      if (t.count > 1) {
        anyDifferent = true;
        row.append(el("span", { className: "lb-kind-count", textContent: scanWord("lb_different", t.different) }));
      }
      rows.append(row);
    }
    $("shared-different-note").hidden = !anyDifferent;
  }

  function renderInstructions(instructions) {
    const section = $("instructions-card");
    if (!instructions || !Object.keys(instructions.kinds).length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const kindsBox = $("instructions-kinds");
    kindsBox.textContent = "";
    const countText =
      instructions.chats === 1
        ? (count) => scanWord("lb_countInOne", count)
        : (count) => scanWord("lb_countIn", count, instructions.chats);
    for (const [id, count] of Object.entries(instructions.kinds))
      kindsBox.append(tagChip(id, `${kindName(id)} – ${countText(count)}`));
  }

  function findRow(find) {
    const row = el("li", { className: "lb-find-row" });
    row.append(tagChip(find.kind));
    row.append(el("span", { className: "lb-find-masked", textContent: find.masked }));
    row.append(el("span", { className: "lb-find-where", textContent: whereLabel(find.where) }));
    return row;
  }

  function chatCard(chat, result) {
    const grouping = result.grouping;
    const details = el("details", { className: "lb-card-item" });
    const summary = el("summary");
    const head = el("div", { className: "lb-card-head" });
    head.append(el("span", { className: "lb-card-title", textContent: chat.title }));
    if (chat.date) head.append(el("span", { className: "lb-card-date", textContent: chat.date }));
    for (const kind of Object.keys(chat.kinds)) head.append(tagChip(kind));
    summary.append(head);
    const teaser = teaserFor(chat.kinds);
    if (teaser) summary.append(el("p", { className: "lb-card-teaser", textContent: teaser }));
    details.append(summary);

    const body = el("div", { className: "lb-card-body" });
    const findsList = el("ul", { className: "lb-finds" });
    for (const find of chat.finds) findsList.append(findRow(find));
    body.append(findsList);

    const adviceSeen = new Set();
    const advice = el("ul", { className: "lb-advice" });
    advice.append(el("li", { textContent: scanWord("lb_whatToDo"), className: "lb-advice-head" }));
    for (const kind of Object.keys(chat.kinds)) {
      const text = adviceFor?.(kind);
      if (text && !adviceSeen.has(text)) {
        adviceSeen.add(text);
        advice.append(el("li", { textContent: text }));
      }
    }
    body.append(advice);

    const actions = el("div", { className: "lb-card-actions" });
    if (chat.link && chatLinkOk(chat.link)) {
      const a = el("a", { href: chat.link, target: "_blank", rel: "noopener noreferrer" });
      a.textContent = grouping === "day" ? scanWord("lb_openActivity") : scanWord("lb_openChat");
      actions.append(a);
    }
    const askButton = el("button", {
      type: "button",
      className: "as-link",
      textContent: scanWord("lb_askDelete", result.company),
    });
    askButton.addEventListener("click", () => openLetterPanel(result, chat));
    actions.append(askButton);
    body.append(actions);
    details.append(body);
    return details;
  }

  function renderChatCards(result) {
    const box = $("chat-cards");
    box.textContent = "";
    const shown = result.chats.slice(0, 40);
    for (const chat of shown) box.append(chatCard(chat, result));
    const more = $("more-chats");
    if (result.chats.length > shown.length) {
      more.textContent = scanWord("lb_more", result.chats.length - shown.length);
      more.hidden = false;
    } else {
      more.hidden = true;
    }
  }

  function renderNotRead(notRead) {
    const list = $("not-read-list");
    list.textContent = "";
    if (notRead.tooBig > 0) list.append(el("li", { textContent: scanWord("lb_tooBig", notRead.tooBig) }));
    if (notRead.pictures > 0) list.append(el("li", { textContent: scanWord("lb_photosNotRead", notRead.pictures) }));
    if (notRead.unpackLimit > 0) list.append(el("li", { textContent: scanWord("lb_unpackLimit") }));
    list.append(el("li", { textContent: scanWord("lb_noOcr") }));
    list.append(el("li", { textContent: scanWord("lb_deletedGone") }));
    list.append(el("li", { textContent: scanWord("lb_nothingKnown") }));
    list.append(el("li", { textContent: scanWord("lb_deleteNote") }));
  }

  function showResults(result) {
    $("reading").hidden = true;
    $("start").hidden = true;
    $("unknown-result").hidden = true;
    $("results").hidden = false;

    const heading = $("results-heading");
    heading.textContent =
      result.chats.length > 0
        ? scanWord("lb_found", result.chats.length, result.read.chats)
        : scanWord("lb_foundNone", result.read.chats);
    const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("res-note").textContent = scanWord("lb_resNote", result.tool, now);

    $("chats-heading").textContent =
      result.grouping === "day" ? `${scanWord("lb_chats")} — ${scanWord("lb_geminiDays")}` : scanWord("lb_chats");

    renderSharedRows(result.totals);
    renderInstructions(result.instructions);
    renderChatCards(result);
    renderNotRead(result.notRead);

    announce(heading.textContent);
    heading.focus();
  }

  // ---------- The deletion letter ----------

  const DELETE_INFO = {
    chatgpt: { formUrl: "https://privacy.openai.com", email: "dsar@openai.com" },
    claude: { formUrl: null, email: "privacy@anthropic.com" },
    gemini: { formUrl: "https://support.google.com/legal/troubleshooter/1114905", email: null },
  };

  let lastResult = null;
  let letterUserEdited = false;

  function currentLang() {
    return document.documentElement.lang === "es" ? "es" : "en";
  }

  function buildChatPicks(result, pickChat) {
    const box = $("letter-chat-picks");
    box.textContent = "";
    for (const chat of result.chats) {
      const label = el("label", { className: "lb-chat-pick" });
      const input = el("input", { type: "checkbox" });
      input.checked = pickChat ? chat === pickChat : true;
      input.dataset.chatId = String(chat.id);
      input.addEventListener("change", regenerateLetter);
      label.append(input);
      if (result.grouping === "day") {
        label.append(el("span", { textContent: chat.date }));
      } else {
        label.append(el("span", { textContent: chat.title }));
        if (chat.date) label.append(el("span", { className: "lb-card-date", textContent: chat.date }));
      }
      box.append(label);
    }
  }

  function currentPlace() {
    const checked = document.querySelector('input[name="letter-place"]:checked');
    return checked ? checked.value : undefined;
  }

  function pickedChats(result) {
    const ids = new Set([...$("letter-chat-picks").querySelectorAll("input:checked")].map((i) => i.dataset.chatId));
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
      result.grouping === "day"
        ? chats.map((c) => c.date)
        : chats.map((c) => (c.link && chatLinkOk(c.link) ? c.link : c.title));
    const { text, blanks } = letterFor({
      company: result.company,
      tool: result.tool,
      kindNames: [...kindIds].map(kindName),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      links,
      place: currentPlace(),
      lang: currentLang(),
    });
    $("letter-box").value = text;
    $("letter-blanks").textContent = scanWord("lb_blanks", blanks);
  }

  function openLetterPanel(result, chat) {
    lastResult = result;
    letterUserEdited = false;
    $("letter-heading").textContent = scanWord("lb_askDelete", result.company);
    buildChatPicks(result, chat);
    for (const r of document.querySelectorAll('input[name="letter-place"]')) r.checked = false;

    const info = DELETE_INFO[result.format] || {};
    const requests = $("letter-requests");
    if (info.formUrl) {
      const link = $("letter-requests-link");
      link.href = info.formUrl;
      link.textContent = scanWord("lb_openRequests", result.company);
      requests.hidden = false;
    } else {
      requests.hidden = true;
    }
    const emailEl = $("letter-email");
    if (info.email) {
      emailEl.textContent = scanWord("lb_emailIt", info.email);
      emailEl.hidden = false;
    } else {
      emailEl.hidden = true;
    }
    $("letter-next-title").textContent = scanWord("lb_nextTitle", result.company);
    $("letter-copy-status").textContent = "";

    regenerateLetter();

    $("results").hidden = true;
    $("letter-panel").hidden = false;
    $("letter-heading").focus();
  }

  for (const r of document.querySelectorAll('input[name="letter-place"]'))
    r.addEventListener("change", regenerateLetter);

  $("letter-box").addEventListener("input", () => {
    letterUserEdited = true;
    const blanks = ($("letter-box").value.match(/\[[^\]]*\]/g) || []).length;
    $("letter-blanks").textContent = scanWord("lb_blanks", blanks);
    $("letter-copy-status").textContent = "";
  });

  $("letter-copy").addEventListener("click", async () => {
    const box = $("letter-box");
    try {
      await navigator.clipboard.writeText(box.value);
      $("letter-copy-status").textContent = scanWord("lb_copied");
    } catch {
      box.focus();
      box.select();
      $("letter-copy-status").textContent = scanWord("lb_copyFailed");
    }
  });

  $("letter-back").addEventListener("click", () => {
    $("letter-panel").hidden = true;
    $("results").hidden = false;
    $("results-heading").focus();
  });

  $("forget").addEventListener("click", () => {
    $("shared-rows").textContent = "";
    $("chat-cards").textContent = "";
    $("not-read-list").textContent = "";
    $("instructions-kinds").textContent = "";
    $("letter-chat-picks").textContent = "";
    $("letter-box").value = "";
    $("letter-panel").hidden = true;
    $("manifest-links").textContent = "";
    lastResult = null;
    letterUserEdited = false;
    showStart();
  });

  // ---------- Step 1 & 2 static words, filled once ----------

  const promises = $("promises");
  for (const line of lines("lb_promises")) promises.append(el("li", { textContent: line }));
})();
