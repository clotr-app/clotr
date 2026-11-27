// The text inside an attachment, from a PDF's page streams or Office XML, each read in one bounded pass.
// attachments.js reads files through these, by way of globalThis.Clotr.
(() => {
  "use strict";

  // ---------- PDF attachments: finding the streams ----------
  // A PDF someone attaches is attacker-controlled, so this stays linear and bounded: each "stream" keyword only
  // looks back 4 KB for its dictionary, and it never looks at more than 5,000 keywords in all.
  function findPdfStreams(raw, max = 400) {
    const out = [];
    let at = 0;
    const isSpace = (char) => char === " " || char === "\r" || char === "\n" || char === "\t";
    for (let seen = 0; out.length < max && seen < 5000; seen++) {
      const keyword = raw.indexOf("stream", at);
      if (keyword < 0) break;
      at = keyword + 6;
      if (raw.startsWith("end", keyword - 3)) continue; // "endstream"
      let dataStart = keyword + 6;
      if (raw[dataStart] === "\r") dataStart++;
      if (raw[dataStart] !== "\n") continue;
      dataStart++;
      let dictEnd = keyword - 1;
      // Back over the spaces and line breaks between the dictionary's ">>" and the keyword.
      while (dictEnd > 0 && keyword - dictEnd < 64 && isSpace(raw[dictEnd])) dictEnd--;
      if (raw[dictEnd] !== ">" || raw[dictEnd - 1] !== ">") continue;
      let depth = 0;
      let dictStart = -1;
      for (let i = dictEnd, lo = Math.max(1, dictEnd - 4096); i >= lo;) {
        if (raw[i] === ">" && raw[i - 1] === ">") {
          depth++;
          i -= 2;
          continue;
        }
        if (raw[i] === "<" && raw[i - 1] === "<") {
          depth--;
          i -= 2;
          if (depth === 0) {
            dictStart = i + 1;
            break;
          }
          continue;
        }
        i--;
      }
      if (dictStart < 0) continue;
      out.push({ dict: raw.slice(dictStart + 2, dictEnd - 1), start: dataStart });
    }
    return out;
  }

  // ---------- PDF attachments: reading the text ----------
  // Reads the text-showing operators (Tj, TJ, ', ") out of already-unpacked PDF page streams, translating each
  // one through its font's ToUnicode map. Every loop here is bounded and blocks are found with indexOf, so a
  // hostile file can't make this crawl.
  const hexToString = (hex) => {
    let text = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return text || String.fromCharCode(parseInt(hex || "20", 16));
  };
  function blocks(text, open, close, max = 200) {
    const out = [];
    for (let at = 0; out.length < max;) {
      const from = text.indexOf(open, at);
      if (from < 0) break;
      const to = text.indexOf(close, from + open.length);
      if (to < 0) break;
      out.push(text.slice(from + open.length, to));
      at = to + close.length;
    }
    return out;
  }
  // A single range is already capped at 5,001 codes, but nothing capped how many ranges or bfchar entries a
  // hostile file could pack in: one 2 MB stream of tiny ranges could still mean hundreds of millions of map.set
  // calls. `budget` is shared across every stream of one PDF, so the total stays bounded no matter how it's split.
  const MAX_CMAP_TOTAL = 50000;
  function readCMap(text, map, budget) {
    for (const block of blocks(text, "beginbfchar", "endbfchar")) {
      for (const pair of block.matchAll(/<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,64})>/g)) {
        if (budget.left-- <= 0) return;
        map.set(pair[1].toLowerCase(), hexToString(pair[2]));
      }
    }
    for (const block of blocks(text, "beginbfrange", "endbfrange")) {
      // An array entry's closing "]" (at most 20,000 characters on) is found with indexOf, and the next "]" is
      // remembered, so a hostile file full of unclosed "[" can't make every entry rescan 20,000 characters.
      const entry = /<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,8})>\s{0,20}(?:<([0-9a-fA-F]{1,64})>|\[)/g;
      let close = -1; // the first "]" at or after the last "[" looked at; Infinity once there's none left
      for (let pair = entry.exec(block); pair; pair = entry.exec(block)) {
        if (budget.left <= 0) return;
        let array = null;
        if (pair[3] === undefined) {
          const open = entry.lastIndex;
          if (close < open) {
            close = block.indexOf("]", open);
            if (close < 0) close = Infinity;
          }
          if (close - open > 20000) {
            entry.lastIndex = pair.index + 1; // not an entry: look again from the next character
            continue;
          }
          array = block.slice(open, close);
          entry.lastIndex = close + 1;
        }
        const lo = parseInt(pair[1], 16);
        const hi = Math.min(parseInt(pair[2], 16), lo + 5000, lo + budget.left);
        const width = pair[1].length;
        const list = array ? [...array.matchAll(/<([0-9a-fA-F]{1,64})>/g)].map((item) => hexToString(item[1])) : null;
        for (let code = lo; code <= hi; code++) {
          budget.left--;
          map.set(
            code.toString(16).padStart(width, "0").toLowerCase(),
            list ? (list[code - lo] ?? "") : String.fromCharCode(parseInt(pair[3], 16) + (code - lo)),
          );
        }
      }
    }
  }
  const ESCAPES = { n: " ", r: " ", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
  const pdfString = (raw) =>
    raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, escape) =>
      /[0-7]/.test(escape[0]) ? String.fromCharCode(parseInt(escape, 8)) : ESCAPES[escape],
    );
  // `wide`: the maps have two-byte codes, so a code none of them knows is skipped four hex digits at a time. A code
  // a map does know moves on by its own width, so a simple font's one-byte map (<20> to <7E>) reads every byte.
  function showText(content, cmap, wide = true) {
    const hex = (raw) => {
      const digits = raw.replace(/\s+/g, "").toLowerCase();
      if (cmap.size) {
        let decoded = "";
        for (let i = 0; i < digits.length;) {
          const two = cmap.get(digits.slice(i, i + 4));
          const one = two === undefined ? cmap.get(digits.slice(i, i + 2)) : undefined;
          decoded += two ?? one ?? "";
          i += two !== undefined ? 4 : one !== undefined || !wide ? 2 : 4;
        }
        if (decoded) return decoded;
      }
      let decoded = "";
      for (let i = 0; i + 2 <= digits.length; i += 2) {
        decoded += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
      }
      return decoded;
    };
    // This is a hand-written scanner. When a string or hex block never closes, it skips the whole window it
    // looked at, so a hostile file can't make any character get visited more than a bounded number of times.
    let out = "";
    let inArray = false;
    let flatUntil = 0;
    const length = content.length;
    for (let i = 0; i < length;) {
      const char = content[i];
      if (char === "(") {
        // Balanced parentheses inside a string needn't be escaped, so the string ends at the ")" that closes its own
        // "(". A file whose inner "(" never closes still ends at the first ")", and so does every string
        // that starts inside the window that one looked at, so no character is looked at by more than one such scan.
        const nested = i >= flatUntil;
        let j = i + 1;
        let inner = "";
        let depth = 0;
        let first = -1; // the first unescaped ")" and the string up to it
        let firstText = "";
        while (j < length && j - i <= 4096 && !(content[j] === ")" && (depth === 0 || !nested))) {
          if (content[j] === "\\") {
            inner += content.slice(j, j + 2);
            j += 2;
            continue;
          }
          if (content[j] === "(") depth++;
          else if (content[j] === ")") {
            if (first < 0) [first, firstText] = [j, inner];
            depth--;
          }
          inner += content[j++];
        }
        if (content[j] === ")") {
          out += pdfString(inner);
          i = j + 1;
        } else if (first >= 0) {
          out += pdfString(firstText);
          flatUntil = j;
          i = first + 1;
        } else i = j; // unclosed: skip it
        continue;
      }
      if (char === "<" && content[i + 1] !== "<") {
        let j = i + 1;
        while (j < length && j - i <= 8192 && /[0-9a-fA-F\s]/.test(content[j])) j++;
        if (content[j] === ">") {
          out += hex(content.slice(i + 1, j));
          i = j + 1;
        } else i = Math.max(j, i + 1);
        continue;
      }
      if (char === "[") inArray = true;
      else if (char === "]") inArray = false;
      else if (char === "E" && content[i + 1] === "T") out += " ; ";
      else if (
        char === "T" &&
        "Jj*dDm".includes(content[i + 1] || "") &&
        !inArray &&
        content[i + 1] !== "J" &&
        content[i + 1] !== "j"
      ) {
        out += " ";
      } else if ((char === "'" || char === '"') && !inArray) out += " ";
      i++;
    }
    return out;
  }
  function pdfPageText(streams) {
    const cmap = new Map();
    const budget = { left: MAX_CMAP_TOTAL };
    for (const stream of streams) if (stream.includes("begincmap")) readCMap(stream, cmap, budget);
    let wide = false;
    for (const code of cmap.keys()) {
      if (code.length > 2) {
        wide = true;
        break;
      }
    }
    return streams
      .filter((stream) => !stream.includes("begincmap") && /Tj|TJ/.test(stream))
      .map((stream) => showText(stream, cmap, wide))
      .join(" ; ");
  }

  // ---------- Office XML attachments ----------
  // Turns Office XML (docx, xlsx, pptx, OpenDocument) into plain text in one linear pass. A hostile file
  // like 600 KB of "<a <a <a…" can't make it crawl.
  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  // A paragraph's or cell's end, and the line breaks and tabs inside one (Word's w:br, w:cr and w:tab, PowerPoint's
  // a:br, OpenDocument's text:line-break and text:tab), with or without attributes, each start a new line;
  // OpenDocument's text:s is a run of spaces. Without them the words on either side run together.
  const BREAK_TAG =
    /^(?:\/(?:w:p|a:p|text:p|text:h|si|row|c)|(?:w:br|w:cr|w:tab|a:br|text:tab|text:line-break)(?:\s[\s\S]*)?\/?)$/;
  const SPACE_TAG = /^text:s(?:\s[\s\S]*)?\/?$/;
  function xmlToText(xml) {
    // Plain text gets copied in one slice per run and joined once at the end. Appending one character at a time
    // grows faster than the input on hostile "&aaaa…" text.
    const parts = [];
    let run = 0; // start of the plain text not yet copied
    const length = xml.length;
    for (let i = 0; i < length;) {
      const char = xml[i];
      if (char === "<") {
        const close = xml.indexOf(">", i + 1);
        // No more tags, so the rest of the file isn't document text.
        if (close < 0) {
          if (i > run) parts.push(xml.slice(run, i));
          return parts.join("");
        }
        if (i > run) parts.push(xml.slice(run, i));
        if (close - i < 64) {
          const tag = xml.slice(i + 1, close).trim();
          if (BREAK_TAG.test(tag)) parts.push("\n");
          else if (SPACE_TAG.test(tag)) parts.push(" ");
        }
        i = run = close + 1;
        continue;
      }
      if (char === "&") {
        const near = xml.slice(i + 1, i + 12).indexOf(";"); // an entity is short, so I don't need to look further
        const semi = near < 0 ? -1 : i + 1 + near;
        const name = semi > i && semi - i <= 10 ? xml.slice(i + 1, semi) : "";
        if (name) {
          let decoded;
          if (name[0] === "#") {
            // A number, "&#65;" or "&#x41;". A code of 0, or past Unicode's last code point, reads as nothing.
            const isHex = name[1] === "x" || name[1] === "X";
            const code = parseInt(name.slice(isHex ? 2 : 1), isHex ? 16 : 10);
            decoded = code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
          } else {
            decoded = XML_ENTITIES[name.toLowerCase()];
          }
          if (decoded !== undefined) {
            if (i > run) parts.push(xml.slice(run, i));
            parts.push(decoded);
            i = run = semi + 1;
            continue;
          }
        }
      }
      i++;
    }
    if (length > run) parts.push(xml.slice(run));
    return parts.join("");
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findPdfStreams, pdfPageText, xmlToText };
})();
