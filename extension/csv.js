// A small, quote-aware CSV reader. It's a classic script with no DOM and no chrome.* calls, so it runs in the
// extension's worker and in Node for the tests, the same as zip.js beside it. It reads a whole decoded text
// string at once rather than streaming, since every export this reads today (Copilot's activity history) is
// small enough for Look back's existing per-file size cap to cover.
(() => {
  "use strict";

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  // Splits CSV text into rows of fields, honoring a quoted field that holds a comma, a newline, or an escaped
  // quote (a doubled ""). \r\n, \r and \n line endings are all accepted, and a trailing quote left open by a
  // truncated file just ends the last field instead of throwing.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const src = stripBom(text);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        continue;
      }
      if (c === "\r") continue;
      if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        continue;
      }
      field += c;
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Reads a CSV as its header row and an array of objects keyed by it. A row with the wrong number of fields,
  // such as a blank trailing line, is skipped rather than guessed at.
  function csvRecords(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { header: [], records: [] };
    const header = rows[0];
    const records = [];
    for (const row of rows.slice(1)) {
      if (row.length === 1 && row[0] === "") continue;
      if (row.length !== header.length) continue;
      const rec = {};
      header.forEach((h, i) => (rec[h] = row[i]));
      records.push(rec);
    }
    return { header, records };
  }

  Object.assign(globalThis.Clotr, { parseCsv, csvRecords });
})();
