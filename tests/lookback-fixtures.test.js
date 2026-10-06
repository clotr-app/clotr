// Tests for the made-up export fixtures in tests/fixtures/exports/ (built by make-exports.js), which stand in for
// real ChatGPT, Claude and Gemini exports before any export reader exists. They check that each export's zip
// (built by zipOf(), never committed) holds exactly its folder's files, that every value in the fixtures is made
// up, and that expected.json matches what today's detector actually finds when it walks only what the person wrote
// or sent. The values expected.json calls "not theirs" should instead show up in the AI's answers, a tool's output
// or the account files. The walk functions below are a plain, code-only version of that logic, not the product's
// real reader: they read whole files at once and take shortcuts a reader of multi-hundred-MB exports can't afford.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");

require("../extension/patterns.js");
require("../extension/detector.js");
require("../extension/decide.js");
require("../extension/attachments.js");
require("../extension/pictures.js");
const C = globalThis.Clotr;

const DIR = path.join(__dirname, "fixtures", "exports");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const { EXPORTS, zipOf } = require("./fixtures/exports/make-exports.js");

// Reads every file in a folder into { "a/b.json": Buffer }.
function folder(name) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(path.join(DIR, name), p).replace(/\\/g, "/")] = fs.readFileSync(p);
    }
  };
  walk(path.join(DIR, name));
  return out;
}

// Reads a zip's files from its central directory, using the sizes recorded there rather than in each local header.
// Returns { name: Buffer }, plus which entries wrote their sizes after the data instead of before it (bit 3 of the
// flags).
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  const after = [];
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    if (flags & 8) after.push(name);
  }
  return { files, after };
}

test("each export is a folder and a zip holding exactly the same files", () => {
  for (const name of Object.keys(EXPORTS)) {
    const files = folder(name);
    assert.deepEqual(Object.keys(files).sort(), Object.keys(EXPORTS[name]).sort(), name);
    for (const [rel, content] of Object.entries(EXPORTS[name]))
      assert.ok(files[rel].equals(Buffer.isBuffer(content) ? content : Buffer.from(content)), `${name}/${rel}`);
    const zipped = unzip(zipOf(name));
    assert.deepEqual(Object.keys(zipped.files).sort(), Object.keys(files).sort(), `${name}.zip`);
    for (const rel of Object.keys(files)) assert.ok(zipped.files[rel].equals(files[rel]), `${name}.zip: ${rel}`);
  }
  // ChatGPT's zip writes the sizes after each file's data, as zips made while streaming do.
  const chatgpt = unzip(zipOf("chatgpt"));
  assert.equal(chatgpt.after.length, Object.keys(chatgpt.files).length);
});

// These are the made-up values for each kind. Finding anything else of that kind in a fixture would be a mistake.
const MADE_UP = {
  credit_card: /^(4111 1111 1111 1111|5555 5555 5555 4444)$/,
  us_ssn: /^219-09-9999$/,
  aws_access_key: /^AKIA4HPQ7XZ2R6TWLJ3N$/,
  email: /@example\.(com|org|net)$/,
  phone_number: /555/,
};
// Pulls the words out of a fixture file: a JSON file's string values, skipping its keys and IDs since a run of
// digits in an ID can look like a card number and a real reader never treats IDs as words. An HTML file's words
// are its text between the tags.
const ID_KEY = /(^|_)(id|uuid)$|^(parent|children|current_node|asset_pointer)$/;
function words(rel, content) {
  const text = content.toString("utf8");
  if (rel.endsWith(".html")) return [text.replace(/<[^>]*>/g, " ")];
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (!ID_KEY.test(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  if (rel.endsWith(".jsonl")) {
    for (const line of text.split("\n")) if (line.trim()) walk(JSON.parse(line), "");
  } else {
    walk(JSON.parse(text), "");
  }
  return out;
}
test("every value in the fixtures is made up", () => {
  for (const name of Object.keys(EXPORTS)) {
    for (const [rel, content] of Object.entries(folder(name))) {
      if (!/\.(json|jsonl|html)$/.test(rel)) continue;
      for (const w of words(rel, content))
        for (const r of C.detect(w))
          for (const m of r.matches) if (MADE_UP[r.id]) assert.match(m, MADE_UP[r.id], `${name}/${rel}: ${r.id}`);
    }
    // Also checks every phone number in the account files, written the way each service formats it: a leading +1
    // and digits.
    for (const [rel, content] of Object.entries(folder(name)))
      for (const phone of content.toString("latin1").match(/\+1\d{10}/g) || [])
        assert.match(phone, /^\+1\d{3}555\d{4}$/, `${name}/${rel}`);
  }
});

// ---------- The shapes, walked plainly ----------
// Adds the kinds and counts found in some text into `into`. Each distinct piece of text only counts once per chat,
// since Claude's `text` field and its text block can carry the same words twice.
function count(into, texts) {
  for (const t of new Set(texts.filter((s) => typeof s === "string" && s.trim())))
    for (const r of C.detect(t)) into[r.id] = (into[r.id] || 0) + r.matches.length;
  return into;
}
function named(into, names) {
  for (const n of names) for (const r of C.namedDocument({ name: n })) into[r.id] = (into[r.id] || 0) + 1;
  return into;
}
const tidy = (kinds) => Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b)));

// Walks a ChatGPT export: every message from the person, across every branch of the conversation tree, with
// custom instructions counted separately and only once.
async function walkChatgpt(files) {
  const chats = [];
  const about = new Set();
  const names = Object.keys(files).filter((f) => /^conversations(-\d+)?\.json$/.test(f));
  for (const f of names.sort()) {
    for (const conv of JSON.parse(files[f].toString("utf8"))) {
      const kinds = {};
      const texts = [];
      const attachments = [];
      for (const { message: m } of Object.values(conv.mapping)) {
        if (!m) continue;
        const meta = m.metadata || {};
        if (meta.is_user_system_message) {
          const d = meta.user_context_message_data || {};
          about.add(JSON.stringify([d.about_user_message, d.about_model_message]));
        }
        if (m.author.role !== "user") continue;
        if (m.content.content_type === "user_editable_context") {
          about.add(JSON.stringify([m.content.user_profile, m.content.user_instructions]));
          continue;
        }
        for (const part of m.content.parts || []) {
          if (typeof part === "string") texts.push(part);
          else if (part?.content_type === "audio_transcription" && part.direction !== "out") texts.push(part.text);
        }
        attachments.push(...(meta.attachments || []));
      }
      count(kinds, texts);
      named(
        kinds,
        attachments.map((a) => a.name),
      );
      // Checks the pictures the person uploaded, stored at the zip's root as <file id>-<name>. Only what's inside
      // the picture counts here, since the file name was already counted from the attachment list.
      for (const a of attachments) {
        const file = Object.keys(files).find((f) => f.startsWith(`${a.id}-`));
        if (!file) continue;
        const found = await C.readPicture(new File([files[file]], "IMG_0001.jpg", { type: "image/jpeg" }));
        for (const r of found) if (r.id === "photo_location") kinds.photo_location = (kinds.photo_location || 0) + 1;
      }
      const id = conv.conversation_id || conv.id;
      const date = new Date(conv.create_time * 1000).toISOString().slice(0, 10);
      chats.push({ id, title: conv.title, date, link: `https://chatgpt.com/c/${id}`, kinds: tidy(kinds) });
    }
  }
  const instructions = {};
  for (const pair of about) count(instructions, JSON.parse(pair));
  return { chats, instructions: tidy(instructions), aboutSeen: about.size };
}

// Walks a Claude export: every message from the person (sender "human"), using its text blocks and voice notes, or
// its `text` field when it has no blocks, plus the text of any attached files.
function walkClaude(files) {
  return JSON.parse(files["conversations.json"].toString("utf8")).map((conv) => {
    const kinds = {};
    for (const m of conv.chat_messages) {
      if (m.sender !== "human") continue;
      const blocks = (m.content || []).filter((b) => b.type === "text" || b.type === "voice_note").map((b) => b.text);
      count(kinds, blocks.some((b) => b && b.trim()) ? blocks : [m.text]);
      count(
        kinds,
        (m.attachments || []).map((a) => a.extracted_content),
      );
      named(
        kinds,
        [...(m.attachments || []), ...(m.files || [])].map((a) => a.file_name),
      );
    }
    return {
      id: conv.uuid,
      title: conv.name,
      date: conv.created_at.slice(0, 10),
      link: `https://claude.ai/chat/${conv.uuid}`,
      kinds: tidy(kinds),
    };
  });
}

// Walks a Gemini Takeout My Activity export. The right file is found by its shape, not its path, and this gives
// one record per prompt, grouped by day, where the prompt is the title with its "Prompted " prefix stripped.
function walkGemini(files) {
  const records = Object.entries(files)
    .filter(([f]) => f.endsWith(".json"))
    .map(([, b]) => JSON.parse(b.toString("utf8")))
    .find((v) => Array.isArray(v) && v.every((r) => r && typeof r.title === "string" && typeof r.time === "string"));
  assert.ok(records, "no My Activity file found by its shape");
  const days = new Map();
  for (const r of records) {
    if (![r.header, ...(r.products || [])].some((h) => /gemini/i.test(h || ""))) continue;
    if (!/^Prompted /.test(r.title)) continue;
    const prompt = r.title.replace(/^Prompted /, "");
    const day = r.time.slice(0, 10);
    if (!days.has(day)) days.set(day, { title: prompt, prompts: [] });
    days.get(day).prompts.push(prompt);
  }
  return {
    records: records.length,
    chats: [...days].map(([day, d]) => ({
      id: day,
      title: d.title,
      date: day,
      link: "https://myactivity.google.com/product/gemini",
      kinds: tidy(count({}, d.prompts)),
      prompts: d.prompts.length,
    })),
  };
}

const withFinds = (chats) => chats.filter((c) => Object.keys(c.kinds).length);
const shape = (found) =>
  found.map(({ id, title, date, link, kinds }) => ({ id, title, date, link, kinds: tidy(kinds) }));

test("ChatGPT: the person's own messages hold exactly what expected.json lists", async () => {
  const want = expected.chatgpt;
  const got = await walkChatgpt(folder("chatgpt"));
  assert.equal(got.chats.length, want.chats);
  assert.deepEqual(withFinds(got.chats), shape(want.found));
  assert.deepEqual(got.instructions, want.customInstructions.kinds);
  assert.equal(got.aboutSeen, 1, "the same custom instructions in both shapes count once");
  // The split kind: the same chats over numbered files, without the pictures.
  const split = await walkChatgpt(folder("chatgpt-split"));
  const noPictures = shape(want.found).map((c) => {
    const kinds = { ...c.kinds };
    delete kinds.photo_location;
    return { ...c, kinds };
  });
  assert.deepEqual(withFinds(split.chats), noPictures);
});

test("Claude: the person's own messages and attached files hold exactly what expected.json lists", () => {
  const got = walkClaude(folder("claude"));
  assert.equal(got.length, expected.claude.chats);
  assert.deepEqual(withFinds(got), shape(expected.claude.found));
});

test("Gemini: the prompts hold exactly what expected.json lists, wherever the file is and whatever it's called", () => {
  for (const name of ["gemini", "gemini-localized"]) {
    const got = walkGemini(folder(name));
    assert.equal(got.records, expected.gemini.records, name);
    assert.equal(
      got.chats.reduce((n, c) => n + c.prompts, 0),
      expected.gemini.prompts,
      name,
    );
    assert.deepEqual(shape(withFinds(got.chats)), shape(expected.gemini.found), name);
  }
  // A title is shown with every detail in it masked.
  for (const f of expected.gemini.found) {
    let shown = f.title;
    for (const r of C.detect(f.title)) for (const m of r.matches) shown = shown.split(m).join(C.mask(m));
    assert.equal(shown, f.shownTitle);
  }
});

test("the values that aren't the person's are really in the AI's answers, a tool's output or the account files", () => {
  for (const name of ["chatgpt", "claude", "gemini"]) {
    const all = Object.values(folder(name))
      .map((b) => b.toString("utf8"))
      .join("\n");
    for (const v of expected[name].notTheirs) assert.ok(all.includes(v), `${name}: ${v}`);
    for (const f of expected[name].ignored) assert.ok(folder(name)[f], `${name}: ${f}`);
  }
});

test("the HTML kind and a file that isn't an export are there to be recognized, not read", () => {
  const html = folder("gemini-html")["Takeout/My Activity/Gemini Apps/MyActivity.html"].toString("utf8");
  assert.equal((html.match(/class="outer-cell /g) || []).length, expected.gemini.records);
  assert.match(html, /class="header-cell [^"]*"><p class="mdl-typography--title">Gemini Apps/);
  const unknown = JSON.parse(folder("unknown")["data.json"].toString("utf8"));
  assert.ok(!Array.isArray(unknown) && !("conversations" in unknown));
});
