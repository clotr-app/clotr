// Look back's export reader. It's a classic script with no DOM and no chrome.* calls, so it runs in the
// extension's worker and in Node for the tests. It's built on clotr-pages/look-back/zip-reader.js's
// openZip/entryStream/entryBytes/jsonItems to find an export's shape and walk it into one results shape.
// Nothing here is stored, and the salt used for fingerprints is made fresh for each read and thrown away
// afterward.
(() => {
  "use strict";

  const {
    detect,
    mask,
    fingerprint,
    setVault,
    namedDocument,
    readPicture,
    jsonItems,
    jsonlItems,
    openZip,
    entryStream,
    entryBytes,
    fromFile,
    parseCsv,
    csvRecords,
  } = globalThis.Clotr;

  const CHAT_CAP = 32 * 1024 * 1024; // one chat over this is "too big to read"
  const PEEK_CAP = 1 << 16; // enough to see a conversation's early keys even when it's huge
  const MAX_PICTURES = 5000;
  const PICTURE_SAFETY_CAP = 20 * 1024 * 1024; // a "picture" this big is read as none (notRead.pictures)
  const MANIFEST_CAP = 1024 * 1024; // Claude's manifest (the small file of download links) is a few KB

  // Scans an entry as a top-level JSON array or object (jsonItems), or as one JSON record per line for a
  // `.jsonl` file (jsonlItems). Claude's export, from what's known of it, can zip the conversations file
  // either way, so every reader below just calls this and doesn't need to care which shape it got.
  function itemsFor(entry, opts) {
    return /\.jsonl$/i.test(entry.name) ? jsonlItems(entry.chunks(), opts) : jsonItems(entry.chunks(), opts);
  }

  const WHERE = {
    message: "your message",
    edited: "a message you later edited",
    file: "a file you attached",
    voice: "a voice note",
    instructions: "your custom instructions",
  };

  const FORMAT_INFO = {
    chatgpt: { tool: "ChatGPT", company: "OpenAI" },
    claude: { tool: "Claude", company: "Anthropic" },
    gemini: { tool: "Gemini", company: "Google" },
    "gemini-html": { tool: "Gemini", company: "Google" },
    copilot: { tool: "Copilot", company: "Microsoft" },
  };

  // A chat's kinds, sorted by id.
  function tidy(kinds) {
    return Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)));
  }

  // Reports progress to the page as it happens, without changing what the read eventually returns.
  // `liveBytes` is a running count of JSON characters read so far, close enough for a progress bar that fills
  // smoothly and lands on "done" when the read finishes.
  function tick(ctx, chat) {
    if (!ctx.onProgress) return;
    ctx.onProgress({
      read: { ...ctx.read },
      notRead: { ...ctx.notRead },
      liveBytes: ctx.liveBytes,
      chat: chat && Object.keys(chat.kinds).length ? chat : null,
    });
  }

  // ---------- File entries ----------
  // The one shape every format's reader walks, whether from a zip or a picked folder:
  // { name, size, chunks(): AsyncIterable<Uint8Array>, head(cap): Promise<Uint8Array> }

  async function* streamChunks(stream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released by a cancel() upstream */
      }
    }
  }

  function zipFileEntries(source, entries) {
    return entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      chunks: () => entryStream(source, entry),
      head: (cap) => entryBytes(source, entry, { cap }),
    }));
  }

  async function fileEntriesFromZip(source) {
    const { entries } = await openZip(source);
    return zipFileEntries(source, entries);
  }

  function toBlob(content) {
    if (typeof Blob !== "undefined" && content instanceof Blob) return content;
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return new Blob([buf]);
  }

  // Wraps a picked folder, given as `{ "relative/path.json": File|Blob|Buffer|string }`, one entry per file.
  function folderFileEntries(filesByName) {
    return Object.entries(filesByName).map(([name, content]) => {
      const src = fromFile(toBlob(content));
      return {
        name: name.replace(/\\/g, "/"),
        size: src.size,
        chunks: () => streamChunks(src.stream(0, src.size)),
        head: (cap) => src.slice(0, Math.min(cap ?? src.size, src.size)),
      };
    });
  }

  // Wraps several files chosen together, since Claude's export can split the chats over
  // conversations-000.zip, -001.zip, and so on. `parts` is `[{ name, file }]`, where each file is either a
  // .zip to unzip or a lone .json/.jsonl to read as is. Every entry's name starts with its own part's file
  // name, which keeps the parts sorted in the right order and still lets detectFormat() find a conversations
  // file wherever it sits inside each part.
  async function multiPartFileEntries(parts) {
    const isZip = (name) => /\.zip$/i.test(name);
    const lists = await Promise.all(
      parts.map(({ name, file }) =>
        isZip(name) ? fileEntriesFromZip(fromFile(file)) : folderFileEntries({ [name]: file }),
      ),
    );
    return lists.flatMap((list, index) =>
      isZip(parts[index].name) ? list.map((entry) => ({ ...entry, name: `${parts[index].name}/${entry.name}` })) : list,
    );
  }

  async function pictureFileFor(entry) {
    if (entry.size > PICTURE_SAFETY_CAP) return null;
    const bytes = await entry.head(entry.size);
    return new File([bytes], entry.name.replace(/^.*\//, ""));
  }

  // ---------- Finding the format by its shape (never by the archive's name) ----------

  function isGeminiRecord(record) {
    return (
      Boolean(record) &&
      typeof record.title === "string" &&
      typeof record.time === "string" &&
      [record.header, ...(Array.isArray(record.products) ? record.products : [])].some((header) =>
        /gemini|bard/i.test(header || ""),
      )
    );
  }

  // Reads just the first item of a top-level JSON array, far enough to see its shape. A `mapping` key means
  // ChatGPT, a `chat_messages` key means Claude, and both show up in the raw prefix even for a huge first
  // item, so no JSON needs parsing to spot them. Gemini and Bard need an actual value check on `title`,
  // `time`, and `header` or `products`, so the item is parsed when it's small enough and fall back to a
  // prefix search when it isn't.
  // The shape one item shows: "chatgpt", "claude", "gemini", or null.
  function shapeOfItem(item) {
    const raw = item.text ?? item.prefix ?? "";
    if (/"mapping"\s*:/.test(raw)) return "chatgpt";
    if (/"chat_messages"\s*:/.test(raw)) return "claude";
    const geminiKeys =
      /"title"\s*:/.test(raw) && /"time"\s*:/.test(raw) && (/"header"\s*:/.test(raw) || /"products"\s*:/.test(raw));
    if (!geminiKeys) return null;
    if (item.text === null) return /gemini|bard/i.test(raw) ? "gemini" : null;
    try {
      if (isGeminiRecord(JSON.parse(item.text))) return "gemini";
    } catch {
      /* not valid JSON on its own: not a match */
    }
    return null;
  }

  async function peekShape(entry) {
    // Only the first item is looked at; a document that doesn't match any known shape there is no match.
    for await (const item of itemsFor(entry, { cap: PEEK_CAP })) return shapeOfItem(item);
    return null; // no items at all: not a top-level array (or conversations array)
  }

  async function looksLikeGeminiHtml(entry) {
    const bytes = await entry.head(16384);
    const text = new TextDecoder().decode(bytes);
    return /class="outer-cell/.test(text) && /header-cell[^>]*>[\s\S]{0,200}(?:Gemini|Bard)/i.test(text);
  }

  // ---------- Copilot: Microsoft's privacy dashboard export ----------
  // A single CSV with no published schema.
  // Microsoft's own help page only says "a comma-separated values (CSV) file is downloaded to your device"
  // and calls what's inside "the record of those prompts and responses"; it names no column. So this looks
  // for a header that can tell a date from a prompt and nothing more specific, rather than one fixed set of
  // names, and a CSV whose header doesn't say which column is which reads as an unknown export, not a guess.
  const CSV_TIMESTAMP_RE = /^(timestamp|date\s*\/?\s*time|datetime)$/i;
  const CSV_DATE_RE = /^date$/i;
  const CSV_TIME_RE = /^time$/i;
  const CSV_PROMPT_RE = /^(prompt|content|message)$/i;

  function csvColumn(header, re) {
    return header.find((name) => re.test((name || "").trim()));
  }

  function copilotShape(header) {
    const timestamp = csvColumn(header, CSV_TIMESTAMP_RE);
    const date = timestamp ? null : csvColumn(header, CSV_DATE_RE);
    const time = date ? csvColumn(header, CSV_TIME_RE) : null;
    const prompt = csvColumn(header, CSV_PROMPT_RE);
    if (!prompt || !(timestamp || date)) return null;
    return { timestamp, date, time, prompt };
  }

  async function copilotHeaderOf(entry) {
    const bytes = await entry.head(Math.min(entry.size, PEEK_CAP));
    const text = new TextDecoder().decode(bytes);
    return parseCsv(text)[0] || null;
  }

  async function detectFormat(fileEntries) {
    const convEntries = fileEntries
      .filter((entry) => /(?:^|\/)conversations(-\d+)?\.(?:json|jsonl)$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (convEntries.length) {
      const shape = await peekShape(convEntries[0]);
      if (shape === "chatgpt") return { format: "chatgpt", dataEntries: convEntries };
      // Every file named "conversations(-NNN)" is read, not just the first, since Claude's export can split
      // across several parts, each unzipped into its own entry here.
      if (shape === "claude") return { format: "claude", dataEntries: convEntries };
    }
    // Claude's newer export doesn't call its conversations file "conversations.json" at all, so beyond that
    // every other .json/.jsonl file is checked by its shape rather than its name, and every entry that
    // matches is read.
    const jsonEntries = fileEntries
      .filter((entry) => /\.(?:json|jsonl)$/i.test(entry.name) && !convEntries.includes(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shapeOf = new Map();
    for (const entry of jsonEntries) shapeOf.set(entry, await peekShape(entry));
    const gemini = jsonEntries.find((entry) => shapeOf.get(entry) === "gemini");
    if (gemini) return { format: "gemini", dataEntries: [gemini] };
    const chatgpt = jsonEntries.filter((entry) => shapeOf.get(entry) === "chatgpt");
    if (chatgpt.length) return { format: "chatgpt", dataEntries: convEntries.length ? convEntries : chatgpt };
    const claude = jsonEntries.filter((entry) => shapeOf.get(entry) === "claude");
    if (claude.length) return { format: "claude", dataEntries: claude };
    // Microsoft exports each activity category (Copilot apps, Copilot in Microsoft 365 apps, Copilot Chat) as
    // its own CSV, so choosing several at once (the same "parts" idea as Claude's split export) reads every
    // one that matches Copilot's shape, each by its own header, as one combined export.
    const csvEntries = fileEntries.filter((entry) => /\.csv$/i.test(entry.name));
    const csvMatches = [];
    for (const entry of csvEntries) {
      const header = await copilotHeaderOf(entry);
      const shape = header && copilotShape(header);
      if (shape) csvMatches.push({ entry, shape });
    }
    if (csvMatches.length) {
      return {
        format: "copilot",
        dataEntries: csvMatches.map((match) => match.entry),
        csvShapes: csvMatches.map((match) => match.shape),
      };
    }
    const htmlEntries = fileEntries.filter((entry) => /\.html?$/i.test(entry.name));
    for (const entry of htmlEntries) {
      if (await looksLikeGeminiHtml(entry)) return { format: "gemini-html", dataEntries: [] };
    }
    const hasTakeoutFiles = fileEntries.some((entry) => /(?:^|\/)Takeout\//i.test(entry.name.replace(/\\/g, "/")));
    const hasGeminiActivity = fileEntries.some((entry) =>
      /(?:^|\/)Takeout\/My Activity\/Gemini Apps\/MyActivity\.(?:json|html)$/i.test(entry.name.replace(/\\/g, "/")),
    );
    if (hasTakeoutFiles && !hasGeminiActivity) return { format: "gemini-no-chats", dataEntries: [] };
    return { format: null, dataEntries: [] };
  }

  // ---------- Claude's manifest: a small list of download links, not the export itself ----------
  // Claude now emails a tiny JSON file first, naming the real export's download links, which may expire or be
  // one-time use. It's recognized by its shape, the same as every other format here: a plain object with a
  // "version" and a "created_at", and a "data_files" array whose entries each name a "filename". A real
  // export's conversations file is a top-level array instead, so it never matches this check.
  async function detectManifest(fileEntries) {
    const candidates = fileEntries.filter(
      (entry) => /\.json$/i.test(entry.name) && entry.size > 0 && entry.size <= MANIFEST_CAP,
    );
    for (const entry of candidates) {
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(await entry.head(entry.size)));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (typeof parsed.version !== "string" || typeof parsed.created_at !== "string") continue;
      if (!Array.isArray(parsed.data_files) || !parsed.data_files.length) continue;
      const files = parsed.data_files.map((file) => ({
        category: typeof file?.category === "string" ? file.category : "",
        filename: typeof file?.filename === "string" ? file.filename : null,
        url: typeof file?.export_url === "string" ? file.export_url : null,
      }));
      if (!files.every((file) => file.filename)) continue;
      return { createdAt: parsed.created_at, files };
    }
    return null;
  }

  // Works out when the manifest's links expire, 24 hours after created_at, or null if created_at doesn't
  // parse. This stays locale-free; the page formats the result for display.
  function manifestExpiry(createdAt) {
    const time = Date.parse(createdAt);
    return Number.isFinite(time) ? new Date(time + 24 * 60 * 60 * 1000).toISOString() : null;
  }

  // A manifest's download link only opens when it's really Claude's own: https, and on claude.ai or a
  // subdomain of it. That blocks a lookalike host like claude.ai.evil.com, and the raw URL is never shown as
  // text either, so an unsafe link just shows the file's name with no link at all.
  function exportLinkOk(url) {
    if (typeof url !== "string") return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return parsed.protocol === "https:" && (parsed.hostname === "claude.ai" || parsed.hostname.endsWith(".claude.ai"));
  }

  // ---------- Titles, shown with every detail in them masked (never the raw value) ----------

  function maskedTitle(title) {
    if (typeof title !== "string") return "";
    let shown = title;
    for (const result of detect(title)) {
      for (const value of result.matches) shown = shown.split(value).join(mask(value, result.id));
    }
    shown = shown.replace(/\s+/g, " ").trim();
    if (shown.length <= 90) return shown;
    return `${shown.slice(0, 89).trimEnd()}…`;
  }

  // ---------- Opening the chat: a fixed address, from an id of a fixed shape, or no link at all ----------

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const GEMINI_URL = "https://myactivity.google.com/product/gemini";
  // Microsoft's support pages confirm this path but no `?view=` value for Copilot specifically (unlike the
  // `?view=media` one they show for another category), so this lands on the dashboard itself rather than
  // guessing a deep link that might be wrong.
  const COPILOT_URL = "https://account.microsoft.com/privacy/activity-history";

  function chatLink(format, id) {
    if (format === "gemini") return GEMINI_URL;
    if (format === "copilot") return COPILOT_URL;
    if (format === "chatgpt" && UUID_RE.test(id)) return `https://chatgpt.com/c/${id}`;
    if (format === "claude" && UUID_RE.test(id)) return `https://claude.ai/chat/${id}`;
    return null;
  }

  function chatLinkOk(url) {
    if (typeof url !== "string") return false;
    if (url === GEMINI_URL || url === COPILOT_URL) return true;
    if (new RegExp(`^https://chatgpt\\.com/c/${UUID_RE.source.slice(1, -1)}$`, "i").test(url)) return true;
    if (new RegExp(`^https://claude\\.ai/chat/${UUID_RE.source.slice(1, -1)}$`, "i").test(url)) return true;
    return false;
  }

  // ---------- Scanning text and file names for what the person shared ----------

  function tallyTotals(ctx, chatId, kindId, value) {
    let total = ctx.totals[kindId];
    if (!total) total = ctx.totals[kindId] = { count: 0, chatIds: new Set(), fps: new Set() };
    total.count++;
    if (chatId != null) total.chatIds.add(chatId);
    total.fps.add(fingerprint(ctx.salt, kindId, value));
  }

  // Adds each value the engine found to the chat's kinds and finds (masked) and to the read's totals.
  function addFinds(results, ctx, chatId, kinds, finds, where) {
    for (const result of results) {
      kinds[result.id] = (kinds[result.id] || 0) + result.matches.length;
      for (const value of result.matches) {
        finds.push({ kind: result.id, masked: mask(value, result.id), at: finds.length, where });
        tallyTotals(ctx, chatId, result.id, value);
      }
    }
  }

  // Scans a chat's `entries` (each `{ text, where }`), once per distinct piece of text, since Claude repeats
  // the same words across a message and its text block. The caller handles ChatGPT's custom instructions on
  // its own instead of going through here.
  function scanTexts(entries, ctx, chatId) {
    const kinds = {};
    const finds = [];
    const seen = new Set();
    for (const { text, where } of entries) {
      if (typeof text !== "string") continue;
      if (!text.trim() || seen.has(text)) continue;
      seen.add(text);
      addFinds(detect(text), ctx, chatId, kinds, finds, where);
    }
    return { kinds, finds };
  }

  // ChatGPT shows custom instructions as their own card rather than tying them to one chat, so this only
  // counts what's in them and never adds it to the chat totals.
  function scanTextsOnly(entries) {
    const kinds = {};
    const seen = new Set();
    for (const { text } of entries) {
      if (typeof text !== "string" || !text.trim() || seen.has(text)) continue;
      seen.add(text);
      for (const result of detect(text)) kinds[result.id] = (kinds[result.id] || 0) + result.matches.length;
    }
    return tidy(kinds);
  }

  function addNamed(names, ctx, chatId, kinds, finds, where) {
    for (const name of names) {
      if (typeof name !== "string") continue;
      addFinds(namedDocument({ name }), ctx, chatId, kinds, finds, where);
    }
  }

  // ---------- ChatGPT: every branch, custom instructions once, pictures by attachment id ----------

  // Finds the ids on the path from the root to `current_node`. A message off this path was edited away, but
  // its first version stays in the export on its own branch, and this reader still reads it.
  function livePathIds(conv) {
    const ids = new Set();
    let id = conv.current_node;
    while (id != null && conv.mapping?.[id] && !ids.has(id)) {
      ids.add(id);
      id = conv.mapping[id].parent;
    }
    return ids;
  }

  // The pictures attached by id (a ChatGPT export keeps them as "<id>-<name>"), each read for the place
  // it was taken, up to MAX_PICTURES in all.
  async function readAttachedPictures(attachmentIds, allEntries, ctx, chatId, kinds, finds) {
    for (const id of attachmentIds) {
      const picEntry = allEntries.find((entry) => entry.name.startsWith(`${id}-`));
      if (!picEntry) continue;
      if (ctx.read.pictures >= MAX_PICTURES) {
        ctx.notRead.pictures++;
        continue;
      }
      const file = await pictureFileFor(picEntry);
      if (!file) {
        ctx.notRead.pictures++;
        continue;
      }
      ctx.read.pictures++;
      let found;
      try {
        found = await readPicture(file);
      } catch {
        found = [];
      }
      for (const result of found) {
        if (result.id !== "photo_location") continue;
        for (const value of result.matches) {
          kinds[result.id] = (kinds[result.id] || 0) + 1;
          finds.push({ kind: result.id, masked: mask(value, result.id), at: finds.length, where: WHERE.file });
          tallyTotals(ctx, chatId, result.id, value);
        }
      }
    }
  }

  async function walkChatgptConversation(conv, allEntries, ctx) {
    const chatId = conv.conversation_id || conv.id;
    const live = livePathIds(conv);
    const textEntries = [];
    const attachmentNames = [];
    const attachmentIds = [];
    let hadAbout = false;
    let aboutKey = null;
    for (const [nodeId, node] of Object.entries(conv.mapping || {})) {
      const message = node?.message;
      if (!message) continue;
      ctx.read.messages++;
      const meta = message.metadata || {};
      if (meta.is_user_system_message) {
        const context = meta.user_context_message_data || {};
        hadAbout = true;
        aboutKey = JSON.stringify([context.about_user_message, context.about_model_message]);
        continue;
      }
      if (message.author?.role !== "user") continue;
      if (message.content?.content_type === "user_editable_context") {
        hadAbout = true;
        aboutKey = JSON.stringify([message.content.user_profile, message.content.user_instructions]);
        continue;
      }
      const where = live.has(nodeId) ? WHERE.message : WHERE.edited;
      for (const part of message.content?.parts || []) {
        if (typeof part === "string") textEntries.push({ text: part, where });
        else if (part?.content_type === "audio_transcription" && part.direction !== "out") {
          textEntries.push({ text: part.text, where: WHERE.voice });
        }
      }
      for (const attachment of meta.attachments || []) {
        attachmentNames.push(attachment.name);
        attachmentIds.push(attachment.id);
      }
    }
    const { kinds, finds } = scanTexts(textEntries, ctx, chatId);
    addNamed(attachmentNames, ctx, chatId, kinds, finds, WHERE.file);
    if (attachmentIds.length) await readAttachedPictures(attachmentIds, allEntries, ctx, chatId, kinds, finds);
    const date =
      typeof conv.create_time === "number" ? new Date(conv.create_time * 1000).toISOString().slice(0, 10) : "";
    return {
      hadAbout,
      aboutKey,
      chat: {
        id: chatId,
        link: chatLink("chatgpt", chatId),
        title: maskedTitle(conv.title),
        date,
        kinds: tidy(kinds),
        finds,
      },
    };
  }

  async function readChatgptFiles(dataEntries, allEntries, ctx) {
    const chats = [];
    const abouts = new Set();
    let aboutChats = 0;
    for (const entry of dataEntries) {
      try {
        for await (const item of itemsFor(entry, { cap: CHAT_CAP })) {
          if (item.text === null) {
            ctx.notRead.tooBig++;
            continue;
          }
          let conv;
          try {
            conv = JSON.parse(item.text);
          } catch {
            ctx.notRead.unreadable++;
            continue;
          }
          ctx.read.chats++;
          const result = await walkChatgptConversation(conv, allEntries, ctx);
          if (result.hadAbout) {
            abouts.add(result.aboutKey);
            aboutChats++;
          }
          chats.push(result.chat);
          ctx.liveBytes += item.text.length;
          tick(ctx, result.chat);
        }
        ctx.read.bytes += entry.size;
      } catch (err) {
        if (err?.code === "unpack-limit") ctx.notRead.unpackLimit++;
        else ctx.notRead.unreadable++;
      }
    }
    const instrEntries = [...abouts].flatMap((key) => {
      const [aboutUser, aboutModel] = JSON.parse(key);
      return [
        { text: aboutUser, where: WHERE.instructions },
        { text: aboutModel, where: WHERE.instructions },
      ];
    });
    return {
      chats,
      instructions: abouts.size ? { kinds: scanTextsOnly(instrEntries), chats: aboutChats } : null,
    };
  }

  // ---------- Claude: every human message, its attached files' text and names ----------

  function walkClaudeConversation(conv, ctx) {
    const chatId = conv.uuid;
    const textEntries = [];
    const attachmentNames = [];
    for (const message of conv.chat_messages || []) {
      ctx.read.messages++;
      if (message.sender !== "human") continue;
      const blocks = (message.content || []).filter((block) => block.type === "text" || block.type === "voice_note");
      const blockTexts = blocks.map((block) => block.text);
      if (blockTexts.some((text) => text && text.trim())) {
        blocks.forEach((block, index) =>
          textEntries.push({
            text: blockTexts[index],
            where: block.type === "voice_note" ? WHERE.voice : WHERE.message,
          }),
        );
      } else textEntries.push({ text: message.text, where: WHERE.message });
      for (const attachment of message.attachments || []) {
        if (attachment.extracted_content) textEntries.push({ text: attachment.extracted_content, where: WHERE.file });
        attachmentNames.push(attachment.file_name);
      }
      for (const file of message.files || []) attachmentNames.push(file.file_name);
    }
    const { kinds, finds } = scanTexts(textEntries, ctx, chatId);
    addNamed(attachmentNames, ctx, chatId, kinds, finds, WHERE.file);
    return {
      id: chatId,
      link: chatLink("claude", chatId),
      title: maskedTitle(conv.name),
      date: typeof conv.created_at === "string" ? conv.created_at.slice(0, 10) : "",
      kinds: tidy(kinds),
      finds,
    };
  }

  // `dataEntries` holds every file that matched Claude's shape: one for a single conversations.json, or
  // several for a split export whose parts get read together as one.
  async function readClaudeFiles(dataEntries, ctx) {
    const chats = [];
    for (const entry of dataEntries) {
      try {
        for await (const item of itemsFor(entry, { cap: CHAT_CAP })) {
          if (item.text === null) {
            ctx.notRead.tooBig++;
            continue;
          }
          let conv;
          try {
            conv = JSON.parse(item.text);
          } catch {
            ctx.notRead.unreadable++;
            continue;
          }
          ctx.read.chats++;
          const chat = walkClaudeConversation(conv, ctx);
          chats.push(chat);
          ctx.liveBytes += item.text.length;
          tick(ctx, chat);
        }
        ctx.read.bytes += entry.size;
      } catch (err) {
        if (err?.code === "unpack-limit") ctx.notRead.unpackLimit++;
        else ctx.notRead.unreadable++;
      }
    }
    return chats;
  }

  // ---------- Gemini (Google Takeout): one result per prompt record, with no chat id ----------
  // Only Takeout records with the documented prompt marker hold text the person wrote. Replies, subtitles and
  // attachment metadata are intentionally ignored because the export doesn't label their authors reliably.
  async function readGeminiChats(entry, ctx) {
    const chats = [];
    let records = 0;
    let prompts = 0;
    try {
      for await (const item of jsonItems(entry.chunks(), { cap: CHAT_CAP })) {
        if (item.text === null) {
          ctx.notRead.tooBig++;
          continue;
        }
        let record;
        try {
          record = JSON.parse(item.text);
        } catch {
          ctx.notRead.unreadable++;
          continue;
        }
        ctx.liveBytes += item.text.length;
        if (!isGeminiRecord(record)) continue;
        records++;
        ctx.read.messages++;
        if (!/^Prompted\s+/i.test(record.title)) continue;
        const text = record.title.replace(/^Prompted\s+/i, "");
        const day = (record.time || "").slice(0, 10);
        if (!day) continue;
        prompts++;
        const id = `${day}:${prompts}`;
        const { kinds, finds } = scanTexts([{ text, where: WHERE.message }], ctx, id);
        const chat = {
          id,
          link: chatLink("gemini", day),
          title: maskedTitle(text),
          date: day,
          kinds: tidy(kinds),
          finds,
        };
        ctx.read.chats++;
        tick(ctx, chat);
        if (Object.keys(kinds).length) chats.push(chat);
      }
      ctx.read.bytes += entry.size;
    } catch (err) {
      if (err?.code === "unpack-limit") ctx.notRead.unpackLimit++;
      else ctx.notRead.unreadable++;
    }
    return { chats, records, prompts };
  }

  // ---------- Copilot: one CSV row per prompt, grouped by day (no chat id) ----------
  // Only the column found to hold the prompt is ever scanned; whatever column might hold Copilot's own reply
  // (unconfirmed: Microsoft's pages don't name one) is never read, the same "never the AI's answer" rule as
  // every other format here.

  function copilotDay(rec, shape) {
    const raw = shape.timestamp ? rec[shape.timestamp] : rec[shape.date];
    if (typeof raw !== "string" || !raw) return null;
    const iso = /^\d{4}-\d{2}-\d{2}/.exec(raw);
    if (iso) return iso[0];
    const time = Date.parse(raw);
    return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
  }

  async function readCopilotFiles(entries, shapes, ctx) {
    const days = new Map();
    const order = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const shape = shapes[index];
      if (entry.size > CHAT_CAP) {
        ctx.notRead.tooBig++;
        continue;
      }
      const text = new TextDecoder().decode(await entry.head(entry.size));
      const { records } = csvRecords(text);
      ctx.read.bytes += entry.size;
      for (const rec of records) {
        const raw = rec[shape.prompt];
        if (typeof raw !== "string" || !raw.trim()) continue;
        const day = copilotDay(rec, shape);
        if (!day) continue;
        ctx.read.messages++;
        if (!days.has(day)) {
          days.set(day, []);
          order.push(day);
        }
        days.get(day).push(raw);
      }
    }
    const chats = [];
    for (const day of order) {
      const texts = days.get(day);
      const { kinds, finds } = scanTexts(
        texts.map((text) => ({ text: text, where: WHERE.message })),
        ctx,
        day,
      );
      const chat = {
        id: day,
        link: chatLink("copilot", day),
        title: maskedTitle(texts[0]),
        date: day,
        kinds: tidy(kinds),
        finds,
      };
      ctx.read.chats++;
      tick(ctx, chat);
      chats.push(chat);
    }
    return chats;
  }

  // ---------- Putting it together: the one results shape ----------

  function randomSalt() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Newest date first; chats with the same date keep their order.
  function newestFirst(a, b) {
    if (a.date < b.date) return 1;
    if (a.date > b.date) return -1;
    return 0;
  }

  async function readExport(fileEntries, opts = {}) {
    if (opts.vault !== undefined) setVault(opts.vault);
    const ctx = {
      salt: opts.salt || randomSalt(),
      totals: {},
      read: { chats: 0, messages: 0, bytes: 0, pictures: 0 },
      notRead: { tooBig: 0, unreadable: 0, pictures: 0, unpackLimit: 0 },
      onProgress: opts.onProgress || null,
      liveBytes: 0,
    };
    const { format, dataEntries, csvShapes } = await detectFormat(fileEntries);
    let chats = [];
    let instructions = null;
    let grouping = "chat";
    let extra = {};
    if (format === "chatgpt") {
      const read = await readChatgptFiles(dataEntries, fileEntries, ctx);
      chats = read.chats;
      instructions = read.instructions;
    } else if (format === "claude") {
      chats = await readClaudeFiles(dataEntries, ctx);
    } else if (format === "gemini") {
      const read = await readGeminiChats(dataEntries[0], ctx);
      chats = read.chats;
      grouping = "record";
      extra = { records: read.records, prompts: read.prompts };
    } else if (format === "copilot") {
      chats = await readCopilotFiles(dataEntries, csvShapes, ctx);
      grouping = "day";
    }
    const totals = {};
    for (const [id, total] of Object.entries(ctx.totals)) {
      totals[id] = { count: total.count, chats: total.chatIds.size, different: total.fps.size };
    }
    const withFinds = chats.filter((chat) => Object.keys(chat.kinds).length).sort(newestFirst);
    const info = FORMAT_INFO[format] || {};
    return {
      format,
      tool: info.tool,
      company: info.company,
      read: ctx.read,
      notRead: ctx.notRead,
      totals,
      chats: withFinds,
      instructions,
      grouping,
      ...extra,
    };
  }

  Object.assign(globalThis.Clotr, {
    readExport,
    detectFormat,
    detectManifest,
    manifestExpiry,
    exportLinkOk,
    chatLink,
    chatLinkOk,
    fileEntriesFromZip,
    zipFileEntries,
    folderFileEntries,
    multiPartFileEntries,
  });
})();
