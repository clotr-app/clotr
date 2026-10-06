// Builds made-up AI chat exports for Look Back's tests (tests/fixtures/exports/): a tiny ChatGPT, Claude and
// Google Takeout (Gemini Apps) export, each in the shape its public description and open-source readers document.
// Each export is written both as a folder, which is committed, and as the .zip the company actually sends, built
// by zipOf(name) and byte for byte the same every run; the zips themselves stay out of git, so run this file to
// get them back to try by hand. Every value in them is made up: 555 phone numbers, example.com and example.org
// addresses, the card and key numbers used throughout Clotr's tests (4111 1111 1111 1111, 5555 5555 5555 4444,
// AKIA4HPQ7XZ2R6TWLJ3N), the same SSN (219-09-9999) Clotr's other tests use, and photo locations at public
// landmarks from tools/make-picture-fixtures.js. No real export was read to build any of this; each shape comes
// from the source named beside it.
//
// expected.json records what a reader is supposed to find: only in what the person wrote or sent, meaning their
// messages, their custom instructions, the text of files they attached, and the pictures they uploaded. It should
// never find anything in the AI's answers or the account files (user.json, users.json), which hold findable
// details on purpose so a reader that reads them by mistake fails the test. tests/lookback-fixtures.test.js holds
// these fixtures to that standard.
//
// Run `node tests/fixtures/exports/make-exports.js` again whenever a shape changes; otherwise these files don't
// need rebuilding.
"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { crc32, deflateRawSync } = require("zlib");
const { BASE, PLACES, jpegWithGps } = require("../../../tools/make-picture-fixtures.js");

const DIR = __dirname;

// ---------- ChatGPT (Settings > Data controls > Export) ----------
// conversations.json is an array of conversations. Each one holds a `mapping` of nodes (id, parent, children,
// message) that forms a tree: an edited message leaves its first version on another branch, and `current_node`
// marks the leaf that's actually shown.
//
// Sources: convoviz's models and spec (github.com/mohamed-chs/convoviz, docs/dev/chatgpt-spec.md, February 2026)
// and chatgpt-exporter's types (github.com/pionxzh/chatgpt-exporter, src/api.ts). Together they document
// author.role, content.content_type ("text", "multimodal_text" with image and audio_transcription parts,
// "user_editable_context" for custom instructions), metadata.attachments, and metadata.is_user_system_message with
// its user_context_message_data (the older style of custom instructions). They also cover conversation_id sitting
// beside id (older exports only have id), uploaded files sitting at the zip's root named after their file id, and
// the newer split into conversations-000.json, conversations-001.json, and so on instead of one file.

// Uploaded files sit at the zip's root as <file id>-<name>. The passport scan has no location inside it, but its
// name says what it is; the beach photo carries the place it was taken, here the Statue of Liberty.
const BEACH = jpegWithGps({ ...PLACES.liberty });

// A node's id is a UUID derived from a fixed name, so the files never change between runs, but the ids still look
// like the random ones a real export would have. Plain runs of zeros could otherwise be mistaken for a detected
// number.
const uuid = (label) => {
  const h = createHash("sha256").update(`clotr fixture ${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const T = (iso) => Date.parse(iso) / 1000; // ChatGPT writes seconds since 1970, with a fraction

function node(id, parent, children, message) {
  return { id, message, parent, children };
}
function message(id, role, content, at, extra = {}) {
  return {
    id,
    author: { role, name: extra.name ?? null, metadata: {} },
    create_time: at,
    update_time: at,
    content,
    status: "finished_successfully",
    end_turn: role === "assistant" ? true : null,
    weight: 1,
    metadata: extra.metadata ?? {},
    recipient: "all",
  };
}
const text = (s) => ({ content_type: "text", parts: [s] });

const CHATGPT_A = {
  title: "Fixing my server config",
  create_time: T("2025-01-14T09:30:00Z") + 0.25,
  update_time: T("2025-01-14T09:41:00Z") + 0.5,
  mapping: Object.fromEntries(
    [
      node(uuid("a01"), null, [uuid("a02")], null),
      node(
        uuid("a02"),
        uuid("a01"),
        [uuid("a03")],
        message(uuid("a02"), "system", text(""), null, {
          metadata: { is_visually_hidden_from_conversation: true },
        }),
      ),
      node(
        uuid("a03"),
        uuid("a02"),
        [uuid("a04")],
        message(
          uuid("a03"),
          "user",
          text("Can you fix this config? aws_access_key_id = AKIA4HPQ7XZ2R6TWLJ3N"),
          T("2025-01-14T09:30:00Z"),
        ),
      ),
      node(
        uuid("a04"),
        uuid("a03"),
        [uuid("a05"), uuid("a06")],
        message(
          uuid("a04"),
          "assistant",
          text("Sure. Never paste keys into a chat. A sample card for testing is 4111 1111 1111 1111."),
          T("2025-01-14T09:30:20Z"),
          { metadata: { model_slug: "gpt-4o" } },
        ),
      ),
      // This is the first version of the next message. It was edited afterward, but the original stays in the
      // export on its own branch.
      node(
        uuid("a05"),
        uuid("a04"),
        [],
        message(
          uuid("a05"),
          "user",
          text("bank login: jamie.rivera@example.com password: Sunflower!2024"),
          T("2025-01-14T09:38:00Z"),
        ),
      ),
      node(
        uuid("a06"),
        uuid("a04"),
        [uuid("a07")],
        message(uuid("a06"), "user", text("Thanks, that worked."), T("2025-01-14T09:40:00Z")),
      ),
      node(
        uuid("a07"),
        uuid("a06"),
        [],
        message(
          uuid("a07"),
          "assistant",
          text("Glad it helped. The password hunter2 is weak, pick a longer one."),
          T("2025-01-14T09:41:00Z"),
        ),
      ),
    ].map((n) => [n.id, n]),
  ),
  moderation_results: [],
  current_node: uuid("a07"),
  plugin_ids: null,
  conversation_id: "6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10",
  conversation_template_id: null,
  gizmo_id: null,
  is_archived: false,
  safe_urls: [],
  default_model_slug: "gpt-4o",
  id: "6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10",
};

// This is the older style of custom instructions, a hidden system message carrying what the person wrote in
// "About you".
const OLD_INSTRUCTIONS = {
  is_visually_hidden_from_conversation: true,
  is_user_system_message: true,
  user_context_message_data: {
    about_user_message: "I live at 1600 Elm Street, Springfield, IL 62704 with my two kids.",
    about_model_message: "Answer briefly.",
  },
};

const CHATGPT_B = {
  title: "Tax question",
  create_time: T("2025-02-03T18:05:00Z") + 0.75,
  update_time: T("2025-02-03T18:06:30Z") + 0.1,
  mapping: Object.fromEntries(
    [
      node(uuid("b01"), null, [uuid("b02")], null),
      node(
        uuid("b02"),
        uuid("b01"),
        [uuid("b03")],
        message(uuid("b02"), "system", text(""), null, { metadata: OLD_INSTRUCTIONS }),
      ),
      node(
        uuid("b03"),
        uuid("b02"),
        [uuid("b04")],
        message(
          uuid("b03"),
          "user",
          {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "image_asset_pointer",
                asset_pointer: "sediment://file_00000000a1b2c3d4e5f60718293a4b5c",
                size_bytes: BASE.jpeg.length,
                width: 16,
                height: 16,
                fovea: null,
                metadata: null,
              },
              "Is this right? My Social Security number is 219-09-9999 and I made 41,200 last year.",
            ],
          },
          T("2025-02-03T18:05:00Z"),
          {
            metadata: {
              attachments: [
                {
                  id: "file-Fx7Kq2Lm9Np4Rs6Tv8Wz",
                  name: "passport-scan.jpg",
                  size: BASE.jpeg.length,
                  mime_type: "image/jpeg",
                },
              ],
            },
          },
        ),
      ),
      node(
        uuid("b04"),
        uuid("b03"),
        [],
        message(
          uuid("b04"),
          "assistant",
          text("Your SSN 219-09-9999 should stay private. The numbers look right."),
          T("2025-02-03T18:06:30Z"),
        ),
      ),
    ].map((n) => [n.id, n]),
  ),
  moderation_results: [],
  current_node: uuid("b04"),
  plugin_ids: null,
  conversation_template_id: null,
  gizmo_id: null,
  is_archived: false,
  safe_urls: [],
  id: "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f",
};

const CHATGPT_C = {
  title: "Weekend plans",
  create_time: T("2025-03-22T11:00:00Z") + 0.5,
  update_time: T("2025-03-22T11:04:10Z") + 0.5,
  mapping: Object.fromEntries(
    [
      node(uuid("c01"), null, [uuid("c02")], null),
      // This is the newer style of custom instructions: a hidden message from the person, carrying the same
      // words as in "Tax question".
      node(
        uuid("c02"),
        uuid("c01"),
        [uuid("c03")],
        message(
          uuid("c02"),
          "user",
          {
            content_type: "user_editable_context",
            user_profile: "I live at 1600 Elm Street, Springfield, IL 62704 with my two kids.",
            user_instructions: "Answer briefly.",
          },
          null,
          { metadata: { is_visually_hidden_from_conversation: true } },
        ),
      ),
      // Said out loud in voice mode, this transcript of what the person said still counts as theirs.
      node(
        uuid("c03"),
        uuid("c02"),
        [uuid("c04")],
        message(
          uuid("c03"),
          "user",
          {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "audio_transcription",
                text: "Call me back at (555) 555-0142 tomorrow.",
                direction: "in",
                decoding_id: null,
              },
            ],
          },
          T("2025-03-22T11:00:00Z"),
        ),
      ),
      node(
        uuid("c04"),
        uuid("c03"),
        [uuid("c05")],
        message(
          uuid("c04"),
          "assistant",
          {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "audio_transcription",
                text: "Okay, I'll call (555) 555-0177 at noon.",
                direction: "out",
                decoding_id: null,
              },
            ],
          },
          T("2025-03-22T11:00:30Z"),
        ),
      ),
      node(
        uuid("c05"),
        uuid("c04"),
        [uuid("c06")],
        message(
          uuid("c05"),
          "user",
          {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "image_asset_pointer",
                asset_pointer: "sediment://file_00000000f0e1d2c3b4a5968778695a4b",
                size_bytes: BEACH.length,
                width: 16,
                height: 16,
                fovea: null,
                metadata: null,
              },
              "Where was this taken?",
            ],
          },
          T("2025-03-22T11:03:00Z"),
          {
            metadata: {
              attachments: [
                { id: "file-Hq3Jd5Kc7Lb9Mf2Ng4Ph", name: "beach.jpg", size: BEACH.length, mime_type: "image/jpeg" },
              ],
            },
          },
        ),
      ),
      // This is a tool's output, from the code runner, not the person's own words.
      node(
        uuid("c06"),
        uuid("c05"),
        [uuid("c07")],
        message(
          uuid("c06"),
          "tool",
          { content_type: "execution_output", text: "You can reach the office at sam.lee@example.org." },
          T("2025-03-22T11:03:40Z"),
          { name: "python" },
        ),
      ),
      node(
        uuid("c07"),
        uuid("c06"),
        [],
        message(
          uuid("c07"),
          "assistant",
          text("It looks like a beach. I can't tell where from the picture alone."),
          T("2025-03-22T11:04:10Z"),
        ),
      ),
    ].map((n) => [n.id, n]),
  ),
  moderation_results: [],
  current_node: uuid("c07"),
  plugin_ids: null,
  conversation_id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  conversation_template_id: null,
  gizmo_id: null,
  is_archived: false,
  is_starred: false,
  safe_urls: [],
  default_model_slug: "gpt-4o",
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
};

// This is the account file: the person's own email and phone, given to OpenAI at signup, not written in any chat.
const CHATGPT_USER = {
  id: "user-Ab12Cd34Ef56Gh78Ij90Kl12",
  email: "jamie.rivera@example.com",
  chatgpt_plus_user: false,
  phone_number: "+15555550142",
};

const CHATGPT_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>ChatGPT Data Export</title></head>
<body>
<!-- The export's offline viewer (made up here): it carries the same chats as conversations.json for a browser to
     show, so a reader takes conversations.json and leaves this page alone. -->
<div id="root"></div>
</body>
</html>
`;

// ---------- Claude (Settings > Privacy > Export data) ----------
// conversations.json is an array of conversations, each with uuid, name, created_at, updated_at, account and
// chat_messages. Each message has uuid, text, content (blocks of type text, thinking, tool_use, tool_result or
// voice_note), sender ("human" or "assistant"), created_at, updated_at, attachments (file_name, file_size,
// file_type and extracted_content, the text of an attached file or a long paste) and files (file_name). Older
// exports only have text, with no content blocks. users.json holds the account.
//
// Sources: Anthropic's privacy center ("Export your Claude data", updated 8 July 2026), claude-chat-viewer's
// schemas (github.com/osteele/claude-chat-viewer, docs/schemas.md and src/schemas/chat.ts), and claude-chats'
// parser (github.com/risaacr/claude-chats, claude_chats/parsers/claude_export.py).

const ACCOUNT = { uuid: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918" };
const block = (s, at) => ({ start_timestamp: at, stop_timestamp: at, type: "text", text: s, citations: [] });
function claudeMessage(uuid, sender, words, at, extra = {}) {
  return {
    uuid,
    text: words,
    content: extra.content ?? [block(words, at)],
    sender,
    created_at: at,
    updated_at: at,
    attachments: extra.attachments ?? [],
    files: extra.files ?? [],
  };
}

const CLAUDE = [
  {
    uuid: "3f2e1d0c-9b8a-4766-a554-433221100fed",
    name: "Budget spreadsheet help",
    created_at: "2025-04-02T09:15:00.123456Z",
    updated_at: "2025-04-02T09:21:40.654321Z",
    account: ACCOUNT,
    chat_messages: [
      claudeMessage(
        "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
        "human",
        "Here's my card for the subscription: 5555 5555 5555 4444",
        "2025-04-02T09:15:00.123456Z",
      ),
      claudeMessage(
        "6b5c4d3e-2f10-4b8a-9d6e-7f5a4b3c2d1e",
        "assistant",
        "Please don't share card numbers. A sample card for testing is 4111 1111 1111 1111.",
        "2025-04-02T09:15:20.000000Z",
        {
          content: [
            {
              start_timestamp: "2025-04-02T09:15:05.000000Z",
              stop_timestamp: "2025-04-02T09:15:10.000000Z",
              type: "thinking",
              thinking: "The password hunter2 is weak; I should say so if it comes up.",
              summaries: [],
              cut_off: false,
            },
            block(
              "Please don't share card numbers. A sample card for testing is 4111 1111 1111 1111.",
              "2025-04-02T09:15:20.000000Z",
            ),
          ],
        },
      ),
      // A file the person attached. Its text is in the export as extracted_content, and it counts as theirs.
      claudeMessage(
        "7c6d5e4f-3a21-4c9b-8e7f-8a6b5c4d3e2f",
        "human",
        "Can you check this list?",
        "2025-04-02T09:20:00.000000Z",
        {
          attachments: [
            {
              file_name: "logins.txt",
              file_size: 61,
              file_type: "text/plain",
              extracted_content: "bank login: jamie.rivera@example.com password: Sunflower!2024\n",
            },
          ],
          files: [{ file_name: "logins.txt" }],
        },
      ),
      claudeMessage(
        "8d7e6f5a-4b32-4dac-9f8a-9b7c6d5e4f3a",
        "assistant",
        "You can reach the office at sam.lee@example.org. Change that password soon.",
        "2025-04-02T09:21:40.654321Z",
      ),
    ],
  },
  {
    uuid: "9e8f7a6b-5c43-4ebd-8a9b-0c8d7e6f5a4b",
    name: "Doctor visit notes",
    created_at: "2025-06-11T16:40:00.000000Z",
    updated_at: "2025-06-11T16:44:00.000000Z",
    account: ACCOUNT,
    chat_messages: [
      // An older-style message: text only, with no content blocks.
      {
        uuid: "0f9a8b7c-6d54-4fce-9b0a-1d9e8f7a6b5c",
        text: "My patient ID: MRN 00423187 from the clinic",
        sender: "human",
        created_at: "2025-06-11T16:40:00.000000Z",
        updated_at: "2025-06-11T16:40:00.000000Z",
        attachments: [],
        files: [],
      },
      // Said out loud, a voice note still counts as the person's own words.
      claudeMessage("1a0b9c8d-7e65-4adf-8c1b-2e0f9a8b7c6d", "human", "", "2025-06-11T16:42:00.000000Z", {
        content: [
          {
            start_timestamp: "2025-06-11T16:42:00.000000Z",
            stop_timestamp: "2025-06-11T16:42:09.000000Z",
            type: "voice_note",
            title: "Voice note",
            text: "My date of birth is March 3, 1961",
          },
        ],
      }),
      claudeMessage(
        "2b1c0d9e-8f76-4be0-9d2c-3f1a0b9c8d7e",
        "assistant",
        "Thanks. Medicare covers hospital stays. Call 555-555-0188 for help.",
        "2025-06-11T16:44:00.000000Z",
      ),
    ],
  },
];

const CLAUDE_USERS = [
  {
    uuid: ACCOUNT.uuid,
    full_name: "Jamie Rivera",
    email_address: "jamie.rivera@example.com",
    verified_phone_number: "+15555550142",
  },
];

// ---------- Claude's October 2026 export: a manifest first, then the conversations split into parts ----------
// Claude now emails a small JSON file listing where to download the real export, instead of the export itself: a
// "version", a "created_at", and a "data_files" array naming each part (category, filename, and a download URL
// good for 24 hours and maybe one use). This fixture is based only on the shape of a real export request, never
// its content; nobody who built it read an actual manifest or an actual conversations-NNN.zip. The URLs point at
// claude.ai with no query string, so this fixture never trips the "every value here is made up" scanner.
const MANIFEST_EXAMPLE = {
  version: "1.0",
  created_at: "2026-10-04T13:11:24.000000Z",
  data_files: [
    {
      category: "conversations",
      filename: "conversations-000.zip",
      export_url: "https://claude.ai/api/organizations/example/export/download/conversations-000",
    },
    {
      category: "conversations",
      filename: "conversations-001.zip",
      export_url: "https://claude.ai/api/organizations/example/export/download/conversations-001",
    },
  ],
};

// ---------- Gemini, through Google Takeout (My Activity > Gemini Apps) ----------
// Takeout writes an activity log, not a chat history: one record per prompt, as an array of { header, title
// ("Prompted …"), time (ISO 8601), products, activityControls, subtitles, safeHtmlItem (Gemini's answer as HTML) }.
// HTML is Takeout's default output, with JSON only when someone picks "Multiple formats". Folder and file names
// follow the account's own language (google_takeout_parser's German mapping gives "Meine Aktivitäten/…/Meine
// Aktivitäten.json"), so a reader has to find the right file by its shape, not its path.
//
// Sources: Google's Gemini Apps Help ("Download your Gemini Apps data", answer 16920332); the record keys read by
// Gemini_Json2md4NotebookLM (github.com/minipoisson, convert_history.py: time, title, subtitles, safeHtmlItem.html,
// header); gemini-chat-exporter (github.com/davidmalko87, gemini_export/takeout.py: the "Prompted " prefix, and
// grouping records by day when there's no chat id); and google_takeout_parser
// (github.com/purarue/google_takeout_parser: My Activity JSON keys including locationInfos, and the HTML's
// outer-cell, header-cell and content-cell classes, plus localized folder names). The full record shape is
// under-documented, so these fixtures only use keys that at least one source names.

const GEMINI = [
  {
    header: "Gemini Apps",
    title: "Prompted My medicare number is 1EG4-TE5-MK73, what does it cover?",
    time: "2025-05-10T14:03:22.118Z",
    products: ["Gemini Apps"],
    activityControls: ["Gemini Apps Activity"],
    safeHtmlItem: [{ html: "<p>Thanks. Medicare covers hospital stays. Call 555-555-0188 for help.</p>" }],
  },
  {
    header: "Gemini Apps",
    title: "Prompted Write to me at jamie.rivera@example.com please, draft a short email to my landlord",
    time: "2025-05-10T14:20:05.502Z",
    products: ["Gemini Apps"],
    activityControls: ["Gemini Apps Activity"],
    safeHtmlItem: [{ html: "<p>Here's a draft. You can reach the office at sam.lee@example.org.</p>" }],
  },
  {
    header: "Gemini Apps",
    title: "Prompted is passport number X12345678 still valid?",
    time: "2025-08-30T07:45:51.000Z",
    products: ["Gemini Apps"],
    activityControls: ["Gemini Apps Activity"],
    safeHtmlItem: [{ html: "<p>I can't check passports. Ask the passport office.</p>" }],
  },
  // A record that isn't a prompt, just a feature being used, with nothing the person wrote.
  {
    header: "Gemini Apps",
    title: "Used Gemini Apps",
    time: "2025-08-30T07:50:00.000Z",
    products: ["Gemini Apps"],
    activityControls: ["Gemini Apps Activity"],
  },
];

// The same records written out in Takeout's default HTML: one outer-cell per record, the product in the
// header-cell, and the prompt and date in the first content-cell. Where Gemini's answer sits in this layout isn't
// documented, so here it's placed right after the date, which catches a reader that can't tell the two apart.
const htmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlDate = (iso) => {
  const d = new Date(iso);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const h = d.getUTCHours() % 12 || 12;
  const two = (n) => String(n).padStart(2, "0");
  const ampm = d.getUTCHours() < 12 ? "AM" : "PM";
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${ampm} UTC`;
};
function geminiHtml(records) {
  const cells = records.map((r) => {
    const prompt = r.title.replace(/^Prompted /, "");
    const said = r.title.startsWith("Prompted ") ? `Prompted&nbsp;${htmlEscape(prompt)}` : htmlEscape(r.title);
    const answer = (r.safeHtmlItem || []).map((i) => i.html).join("");
    return (
      '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
      '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Gemini Apps<br></p></div>' +
      `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${said}<br>${htmlDate(r.time)}<br>${answer}</div>` +
      '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>' +
      '<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br></div>' +
      "</div></div>"
    );
  });
  return (
    '<html><head><meta charset="UTF-8"><title>My Activity</title></head><body>' +
    `<div class="mdl-grid">\n${cells.join("\n")}\n</div></body></html>\n`
  );
}

// This stands in for Takeout's archive.html, an index of what the archive holds; a reader should leave it alone.
const ARCHIVE_HTML =
  '<html><head><meta charset="UTF-8"><title>Archive Overview</title></head><body><h1>Archive Overview</h1>' +
  "<p>My Activity: 1 file</p></body></html>\n";

// ---------- What each export holds, as files ----------
const json = (value, pretty) => `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
// Writes one JSON document per line, the way Claude's newer conversations-NNN.zip holds its records. Each line
// parses the same way an element of a top-level array would, so a reader can treat both shapes the same.
const jsonl = (values) => `${values.map((v) => JSON.stringify(v)).join("\n")}\n`;

const EXPORTS = {
  // Minified, like the real file, so a reader can't lean on line breaks.
  chatgpt: {
    "conversations.json": json([CHATGPT_A, CHATGPT_B, CHATGPT_C], false),
    "user.json": json(CHATGPT_USER, false),
    "message_feedback.json": json([], false),
    "shared_conversations.json": json([], false),
    "chat.html": CHATGPT_HTML,
    "file-Fx7Kq2Lm9Np4Rs6Tv8Wz-passport-scan.jpg": BASE.jpeg,
    "file-Hq3Jd5Kc7Lb9Mf2Ng4Ph-beach.jpg": BEACH,
  },
  // Since early 2026 (per convoviz, 23 February 2026), ChatGPT splits its chats over numbered files.
  "chatgpt-split": {
    "conversations-000.json": json([CHATGPT_A], false),
    "conversations-001.json": json([CHATGPT_B, CHATGPT_C], false),
    "user.json": json(CHATGPT_USER, false),
    "chat.html": CHATGPT_HTML,
  },
  claude: {
    "conversations.json": json(CLAUDE, true),
    "users.json": json(CLAUDE_USERS, true),
  },
  // This is the manifest: a lone JSON file with an arbitrary name here, though a real one carries an id and
  // numbers. A reader has to find it by its shape, not its name.
  "claude-manifest": {
    "manifest-example-20261004-131124.json": json(MANIFEST_EXAMPLE, true),
  },
  // Since October 2026, Claude splits conversations into parts, each a .jsonl file with one conversation per
  // line, under an arbitrary inner name; only its shape says it's Claude's. There are two parts here, so a
  // reader can be tested on combining them.
  "claude-conversations-000": {
    "data.jsonl": jsonl([CLAUDE[0]]),
  },
  "claude-conversations-001": {
    "data.jsonl": jsonl([CLAUDE[1]]),
  },
  gemini: {
    "Takeout/archive_browser.html": ARCHIVE_HTML,
    "Takeout/My Activity/Gemini Apps/MyActivity.json": json(GEMINI, true),
  },
  // Takeout's default HTML output. It should be recognized, but only read once an HTML reader exists; until then
  // Clotr should tell the person to choose JSON instead.
  "gemini-html": {
    "Takeout/archive_browser.html": ARCHIVE_HTML,
    "Takeout/My Activity/Gemini Apps/MyActivity.html": geminiHtml(GEMINI),
  },
  // An account set to another language, where the folders and file are named in that language. These names are
  // illustrative, not checked against a real Spanish archive, so the reader must find the file by its shape, not
  // its path.
  "gemini-localized": {
    "Takeout/Mi actividad/Apps de Gemini/MiActividad.json": json(
      GEMINI.map((r) => ({ ...r, header: "Apps de Gemini", products: ["Apps de Gemini"] })),
      true,
    ),
  },
  // Not an AI export at all. The reader should say it can't read this, rather than guessing.
  unknown: {
    "data.json": json({ items: [{ name: "Groceries", note: "Call me back at (555) 555-0142 tomorrow." }] }, true),
  },
};

// ---------- A small zip writer (stored names, deflate, a fixed date) ----------
// The `descriptor` option writes each file's sizes after its data instead of before it, the way zips made while
// streaming do (bit 3 of the flags). A reader has to take the sizes from the central directory instead.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1; // 1 January 2025
function zip(files, { descriptor = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const flags = 0x0800 | (descriptor ? 0x0008 : 0); // names in UTF-8
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : packed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const tail = [];
    if (descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(packed.length, 8);
      d.writeUInt32LE(data.length, 12);
      tail.push(d);
    }
    parts.push(local, nameBytes, packed, ...tail);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length + (descriptor ? 16 : 0);
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ChatGPT's zip writes sizes after the data (bit 3); every other zip writes them before it.
const ZIPS = { chatgpt: { descriptor: true } };

function main() {
  for (const [name, files] of Object.entries(EXPORTS)) {
    const folder = path.join(DIR, name);
    fs.rmSync(folder, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
      fs.writeFileSync(path.join(folder, rel), content);
    }
    fs.writeFileSync(path.join(DIR, `${name}.zip`), zipOf(name));
  }
}

// Builds an export as the .zip the company actually sends.
const zipOf = (name) => zip(EXPORTS[name], ZIPS[name] || {});

module.exports = { EXPORTS, ZIPS, zip, zipOf };

if (require.main === module) main();
