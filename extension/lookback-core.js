// Look back's export reader. It's a classic script with no DOM and no chrome.* calls, so it runs in the
// extension's worker and in Node for the tests. It's built on zip.js's openZip/entryStream/entryBytes/jsonItems
// to find an export's shape and walk it into one results shape. Nothing here is stored, and the salt used for
// fingerprints is made fresh for each read and thrown away afterward.
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
  } = globalThis.Clotr;

  const CHAT_CAP = 32 * 1024 * 1024; // one chat over this is "too big to read"
  const PEEK_CAP = 1 << 16; // enough to see a conversation's early keys even when it's huge
  const MAX_PICTURES = 5000;
  const PICTURE_SAFETY_CAP = 20 * 1024 * 1024; // a "picture" this big is read as none (notRead.pictures)
  const MANIFEST_CAP = 1024 * 1024; // Claude's manifest (the small file of download links) is a few KB

  // Scans an entry as a top-level JSON array or object (jsonItems), or as one JSON record per line for a
  // `.jsonl` file (jsonlItems). From what I've read, Claude's export can zip the conversations file either way,
  // so every reader below just calls this and doesn't need to care which shape it got.
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
  };

  const tidy = (kinds) => Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)));

  // Reports progress to the page as it happens, without changing what the read eventually returns. `liveBytes`
  // is a running count of JSON characters read so far, close enough for a progress bar that fills smoothly and
  // lands on "done" when the read finishes.
  function tick(ctx, chat) {
    if (!ctx.onProgress) return;
    ctx.onProgress({
      read: { ...ctx.read },
      notRead: { ...ctx.notRead },
      liveBytes: ctx.liveBytes,
      chat: chat && Object.keys(chat.kinds).length ? chat : null,
    });
  }

  // ---------- File entries: the one shape every format's reader walks, whether from a zip or a picked folder ----------
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

  // Wraps several files chosen together, since Claude's export can split the chats over conversations-000.zip,
  // -001.zip, and so on. `parts` is `[{ name, file }]`, where each file is either a .zip to unzip or a lone
  // .json/.jsonl to read as is. I prefix every entry's name with its own part's file name, which keeps the
  // parts sorted in the right order and still lets detectFormat() find a conversations file wherever it sits
  // inside each part.
  async function multiPartFileEntries(parts) {
    const isZip = (name) => /\.zip$/i.test(name);
    const lists = await Promise.all(
      parts.map(({ name, file }) =>
        isZip(name) ? fileEntriesFromZip(fromFile(file)) : folderFileEntries({ [name]: file }),
      ),
    );
    return lists.flatMap((list, i) =>
      isZip(parts[i].name) ? list.map((f) => ({ ...f, name: `${parts[i].name}/${f.name}` })) : list,
    );
  }

  async function pictureFileFor(entry) {
    if (entry.size > PICTURE_SAFETY_CAP) return null;
    const bytes = await entry.head(entry.size);
    return new File([bytes], entry.name.replace(/^.*\//, ""));
  }

  // ---------- Finding the format by its shape (never by the archive's name) ----------

  function isGeminiRecord(r) {
    return (
      !!r &&
      typeof r.title === "string" &&
      typeof r.time === "string" &&
      [r.header, ...(Array.isArray(r.products) ? r.products : [])].some((h) => /gemini|bard/i.test(h || ""))
    );
  }

  // Reads just the first item of a top-level JSON array, far enough to see its shape. A `mapping` key means
  // ChatGPT, a `chat_messages` key means Claude, and both show up in the raw prefix even for a huge first item,
  // so I don't need to parse JSON to spot them. Gemini and Bard need an actual value check on `title`, `time`,
  // and `header` or `products`, so I parse the item when it's small enough and fall back to a prefix search
  // when it isn't.
  async function peekShape(entry) {
    for await (const item of itemsFor(entry, { cap: PEEK_CAP })) {
      const raw = item.text ?? item.prefix ?? "";
      if (/"mapping"\s*:/.test(raw)) return "chatgpt";
      if (/"chat_messages"\s*:/.test(raw)) return "claude";
      if (
        /"title"\s*:/.test(raw) &&
        /"time"\s*:/.test(raw) &&
        (/"header"\s*:/.test(raw) || /"products"\s*:/.test(raw))
      ) {
        if (item.text !== null) {
          try {
            if (isGeminiRecord(JSON.parse(item.text))) return "gemini";
          } catch {
            /* not valid JSON on its own: not a match */
          }
        } else if (/gemini|bard/i.test(raw)) return "gemini";
      }
      return null; // the first item doesn't match any known shape
    }
    return null; // no items at all: not a top-level array (or conversations array)
  }

  async function looksLikeGeminiHtml(entry) {
    const bytes = await entry.head(16384);
    const text = new TextDecoder().decode(bytes);
    return /class="outer-cell/.test(text) && /header-cell[^>]*>[\s\S]{0,200}(?:Gemini|Bard)/i.test(text);
  }

  async function detectFormat(fileEntries) {
    const convEntries = fileEntries
      .filter((f) => /(?:^|\/)conversations(-\d+)?\.(?:json|jsonl)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (convEntries.length) {
      const shape = await peekShape(convEntries[0]);
      if (shape === "chatgpt") return { format: "chatgpt", dataEntries: convEntries };
      // I read every file named "conversations(-NNN)", not just the first, since Claude's export can split
      // across several parts, each unzipped into its own entry here.
      if (shape === "claude") return { format: "claude", dataEntries: convEntries };
    }
    // Claude's newer export doesn't call its conversations file "conversations.json" at all, so beyond that I
    // check every other .json/.jsonl file by its shape rather than its name, and read every entry that matches.
    const jsonEntries = fileEntries
      .filter((f) => /\.(?:json|jsonl)$/i.test(f.name) && !convEntries.includes(f))
      .sort((a, b) => a.name.localeCompare(b.name));
    const shapeOf = new Map();
    for (const entry of jsonEntries) shapeOf.set(entry, await peekShape(entry));
    const gemini = jsonEntries.find((e) => shapeOf.get(e) === "gemini");
    if (gemini) return { format: "gemini", dataEntries: [gemini] };
    const chatgpt = jsonEntries.filter((e) => shapeOf.get(e) === "chatgpt");
    if (chatgpt.length) return { format: "chatgpt", dataEntries: convEntries.length ? convEntries : chatgpt };
    const claude = jsonEntries.filter((e) => shapeOf.get(e) === "claude");
    if (claude.length) return { format: "claude", dataEntries: claude };
    const htmlEntries = fileEntries.filter((f) => /\.html?$/i.test(f.name));
    for (const entry of htmlEntries)
      if (await looksLikeGeminiHtml(entry)) return { format: "gemini-html", dataEntries: [] };
    return { format: null, dataEntries: [] };
  }

  // ---------- Claude's manifest: a small list of download links, not the export itself ----------
  // Claude now emails a tiny JSON file first, naming the real export's download links, which may expire or be
  // one-time use. I recognize it by its shape, the same as every other format here: a plain object with a
  // "version" and a "created_at", and a "data_files" array whose entries each name a "filename". A real export's
  // conversations file is a top-level array instead, so it never matches this check.
  async function detectManifest(fileEntries) {
    const candidates = fileEntries.filter((f) => /\.json$/i.test(f.name) && f.size > 0 && f.size <= MANIFEST_CAP);
    for (const entry of candidates) {
      let obj;
      try {
        obj = JSON.parse(new TextDecoder().decode(await entry.head(entry.size)));
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
      if (typeof obj.version !== "string" || typeof obj.created_at !== "string") continue;
      if (!Array.isArray(obj.data_files) || !obj.data_files.length) continue;
      const files = obj.data_files.map((f) => ({
        category: typeof f?.category === "string" ? f.category : "",
        filename: typeof f?.filename === "string" ? f.filename : null,
        url: typeof f?.export_url === "string" ? f.export_url : null,
      }));
      if (!files.every((f) => f.filename)) continue;
      return { createdAt: obj.created_at, files };
    }
    return null;
  }

  // Works out when the manifest's links expire, 24 hours after created_at, or null if created_at doesn't parse.
  // This stays locale-free; the page formats the result for display.
  function manifestExpiry(createdAt) {
    const t = Date.parse(createdAt);
    return Number.isFinite(t) ? new Date(t + 24 * 60 * 60 * 1000).toISOString() : null;
  }

  // A manifest's download link only opens when it's really Claude's own: https, and on claude.ai or a
  // subdomain of it. That blocks a lookalike host like claude.ai.evil.com, and I never show the raw URL as
  // text either, so an unsafe link just shows the file's name with no link at all.
  function exportLinkOk(url) {
    if (typeof url !== "string") return false;
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    return u.protocol === "https:" && (u.hostname === "claude.ai" || u.hostname.endsWith(".claude.ai"));
  }

  // ---------- Titles, shown with every detail in them masked (never the raw value) ----------

  function maskedTitle(title) {
    if (typeof title !== "string") return "";
    let shown = title;
    for (const r of detect(title)) for (const v of r.matches) shown = shown.split(v).join(mask(v));
    return shown;
  }

  // ---------- Opening the chat: a fixed address, from an id of a fixed shape, or no link at all ----------

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const GEMINI_URL = "https://myactivity.google.com/product/gemini";

  function chatLink(format, id) {
    if (format === "gemini") return GEMINI_URL;
    if (format === "chatgpt" && UUID_RE.test(id)) return `https://chatgpt.com/c/${id}`;
    if (format === "claude" && UUID_RE.test(id)) return `https://claude.ai/chat/${id}`;
    return null;
  }

  function chatLinkOk(url) {
    if (typeof url !== "string") return false;
    if (url === GEMINI_URL) return true;
    if (new RegExp(`^https://chatgpt\\.com/c/${UUID_RE.source.slice(1, -1)}$`, "i").test(url)) return true;
    if (new RegExp(`^https://claude\\.ai/chat/${UUID_RE.source.slice(1, -1)}$`, "i").test(url)) return true;
    return false;
  }

  // ---------- Scanning text and file names for what the person shared ----------

  function tallyTotals(ctx, chatId, kindId, value) {
    let t = ctx.totals[kindId];
    if (!t) t = ctx.totals[kindId] = { count: 0, chatIds: new Set(), fps: new Set() };
    t.count++;
    if (chatId != null) t.chatIds.add(chatId);
    t.fps.add(fingerprint(ctx.salt, kindId, value));
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
      for (const r of detect(text)) {
        kinds[r.id] = (kinds[r.id] || 0) + r.matches.length;
        for (const v of r.matches) {
          finds.push({ kind: r.id, masked: mask(v), at: finds.length, where });
          tallyTotals(ctx, chatId, r.id, v);
        }
      }
    }
    return { kinds, finds };
  }

  // ChatGPT shows custom instructions as their own card rather than tying them to one chat, so this only counts
  // what's in them and never adds it to the chat totals.
  function scanTextsOnly(entries) {
    const kinds = {};
    const seen = new Set();
    for (const { text } of entries) {
      if (typeof text !== "string" || !text.trim() || seen.has(text)) continue;
      seen.add(text);
      for (const r of detect(text)) kinds[r.id] = (kinds[r.id] || 0) + r.matches.length;
    }
    return tidy(kinds);
  }

  function addNamed(names, ctx, chatId, kinds, finds, where) {
    for (const name of names) {
      if (typeof name !== "string") continue;
      for (const r of namedDocument({ name })) {
        kinds[r.id] = (kinds[r.id] || 0) + r.matches.length;
        for (const v of r.matches) {
          finds.push({ kind: r.id, masked: mask(v), at: finds.length, where });
          tallyTotals(ctx, chatId, r.id, v);
        }
      }
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

  async function walkChatgptConversation(conv, allEntries, ctx) {
    const chatId = conv.conversation_id || conv.id;
    const live = livePathIds(conv);
    const textEntries = [];
    const attachmentNames = [];
    const attachmentIds = [];
    let hadAbout = false;
    let aboutKey = null;
    for (const [nodeId, node] of Object.entries(conv.mapping || {})) {
      const m = node?.message;
      if (!m) continue;
      ctx.read.messages++;
      const meta = m.metadata || {};
      if (meta.is_user_system_message) {
        const d = meta.user_context_message_data || {};
        hadAbout = true;
        aboutKey = JSON.stringify([d.about_user_message, d.about_model_message]);
        continue;
      }
      if (m.author?.role !== "user") continue;
      if (m.content?.content_type === "user_editable_context") {
        hadAbout = true;
        aboutKey = JSON.stringify([m.content.user_profile, m.content.user_instructions]);
        continue;
      }
      const where = live.has(nodeId) ? WHERE.message : WHERE.edited;
      for (const part of m.content?.parts || []) {
        if (typeof part === "string") textEntries.push({ text: part, where });
        else if (part?.content_type === "audio_transcription" && part.direction !== "out")
          textEntries.push({ text: part.text, where: WHERE.voice });
      }
      for (const a of meta.attachments || []) {
        attachmentNames.push(a.name);
        attachmentIds.push(a.id);
      }
    }
    const { kinds, finds } = scanTexts(textEntries, ctx, chatId);
    addNamed(attachmentNames, ctx, chatId, kinds, finds, WHERE.file);
    for (const id of attachmentIds) {
      const picEntry = allEntries.find((f) => f.name.startsWith(`${id}-`));
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
      for (const r of found) {
        if (r.id !== "photo_location") continue;
        for (const v of r.matches) {
          kinds[r.id] = (kinds[r.id] || 0) + 1;
          finds.push({ kind: r.id, masked: mask(v), at: finds.length, where: WHERE.file });
          tallyTotals(ctx, chatId, r.id, v);
        }
      }
    }
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
    for (const m of conv.chat_messages || []) {
      ctx.read.messages++;
      if (m.sender !== "human") continue;
      const blocks = (m.content || []).filter((b) => b.type === "text" || b.type === "voice_note");
      const blockTexts = blocks.map((b) => b.text);
      if (blockTexts.some((t) => t && t.trim()))
        blocks.forEach((b, i) =>
          textEntries.push({ text: blockTexts[i], where: b.type === "voice_note" ? WHERE.voice : WHERE.message }),
        );
      else textEntries.push({ text: m.text, where: WHERE.message });
      for (const a of m.attachments || []) {
        if (a.extracted_content) textEntries.push({ text: a.extracted_content, where: WHERE.file });
        attachmentNames.push(a.file_name);
      }
      for (const f of m.files || []) attachmentNames.push(f.file_name);
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

  // ---------- Gemini (Google Takeout): one record per prompt, grouped by day (no chat id) ----------
  // Takeout's My Activity records come in date order, so I group them by day as I go: once a new day's record
  // arrives, the day that just finished turns into its chat and gets let go. That way only one day's prompts
  // are ever held in memory at once.

  // Makes a light first pass over the file, without parsing any record, just to see whether the English
  // "Prompted " prefix shows up anywhere. That lets the real pass below skip non-prompt records as it goes
  // instead of filtering them out afterward. This stops as soon as it finds a match; on a non-English export
  // it ends up reading the whole file a second time, trading time for memory.
  async function detectGeminiLocale(entry) {
    for await (const item of jsonItems(entry.chunks(), { cap: PEEK_CAP })) {
      const raw = item.text ?? item.prefix ?? "";
      if (/"title"\s*:\s*"Prompted /.test(raw)) return true;
    }
    return false;
  }

  // In English, a prompt's title starts "Prompted ", which I drop, and I skip every other record. A locale
  // that doesn't use that word gives no way to tell a prompt from the rest, so there I read every record.
  async function readGeminiChats(entry, ctx) {
    const englishSeen = await detectGeminiLocale(entry);
    const chats = [];
    let records = 0;
    let prompts = 0;
    let currentDay = null;
    let dayTitle = "";
    let dayTexts = [];
    const flushDay = () => {
      if (currentDay == null || !dayTexts.length) return;
      const { kinds, finds } = scanTexts(
        dayTexts.map((t) => ({ text: t, where: WHERE.message })),
        ctx,
        currentDay,
      );
      const chat = {
        id: currentDay,
        link: chatLink("gemini", currentDay),
        title: maskedTitle(dayTitle),
        date: currentDay,
        kinds: tidy(kinds),
        finds,
      };
      ctx.read.chats++;
      tick(ctx, chat);
      chats.push(chat);
      dayTexts = [];
    };
    try {
      for await (const item of jsonItems(entry.chunks(), { cap: CHAT_CAP })) {
        if (item.text === null) {
          ctx.notRead.tooBig++;
          continue;
        }
        let r;
        try {
          r = JSON.parse(item.text);
        } catch {
          ctx.notRead.unreadable++;
          continue;
        }
        ctx.liveBytes += item.text.length;
        if (!isGeminiRecord(r)) continue;
        records++;
        ctx.read.messages++;
        const isPrompt = /^Prompted /.test(r.title);
        if (englishSeen && !isPrompt) continue;
        const text = isPrompt ? r.title.replace(/^Prompted /, "") : r.title;
        const day = (r.time || "").slice(0, 10);
        if (!day) continue;
        prompts++;
        if (day !== currentDay) {
          flushDay();
          currentDay = day;
          dayTitle = text;
        }
        dayTexts.push(text);
      }
      flushDay();
      ctx.read.bytes += entry.size;
    } catch (err) {
      if (err?.code === "unpack-limit") ctx.notRead.unpackLimit++;
      else ctx.notRead.unreadable++;
    }
    return { chats, records, prompts };
  }

  // ---------- Putting it together: the one results shape ----------

  function randomSalt() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    const { format, dataEntries } = await detectFormat(fileEntries);
    let chats = [];
    let instructions = null;
    let grouping = "chat";
    let extra = {};
    if (format === "chatgpt") {
      const r = await readChatgptFiles(dataEntries, fileEntries, ctx);
      chats = r.chats;
      instructions = r.instructions;
    } else if (format === "claude") {
      chats = await readClaudeFiles(dataEntries, ctx);
    } else if (format === "gemini") {
      const r = await readGeminiChats(dataEntries[0], ctx);
      chats = r.chats;
      grouping = "day";
      extra = { records: r.records, prompts: r.prompts };
    }
    const totals = {};
    for (const [id, t] of Object.entries(ctx.totals))
      totals[id] = { count: t.count, chats: t.chatIds.size, different: t.fps.size };
    const withFinds = chats
      .filter((c) => Object.keys(c.kinds).length)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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
