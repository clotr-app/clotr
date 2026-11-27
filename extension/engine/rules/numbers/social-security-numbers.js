// findSSNs(): US Social Security numbers, labelled, in lists and in table columns.
(() => {
  "use strict";

  const {
    isLetter,
    lastItem,
    spanText,
    digitsOf,
    hasNumberWord,
    numberGroupSizes,
    VALID_SSN_SHAPE,
    inFileName,
    ssnLabelBefore,
    phoneContextBefore,
    bareSSNContext,
    counting,
    numberRuns,
    europeanNationalPhone,
    SSN_LABEL_NEAR,
    wrappedNumbers,
  } = globalThis.ClotrInternal;

  // ── SSNs in lists and columns ──────────────────────

  // "555-555-5636, 219-09-9999": a comma or semicolon breaks a list. A spelled-out phone keeps its
  // ", " inside one run, so the number reader handles those, not this.
  function listBreakAfter(text, groups, i) {
    if (i >= groups.length - 1) return false;
    return /[,;]/.test(text.slice(lastItem(groups[i]).end, groups[i + 1][0].start));
  }

  // Cuts a run at its list breaks into [[group, …], …].
  function listChunks(text, groups) {
    const chunks = [[]];
    for (let i = 0; i < groups.length; i++) {
      lastItem(chunks).push(groups[i]);
      if (listBreakAfter(text, groups, i)) chunks.push([]);
    }
    return chunks;
  }

  function isSsnChunk(chunk) {
    const digits = digitsOf(chunk);
    if (digits.length !== 9) return false;
    if (!hasNumberWord(chunk) && numberGroupSizes(chunk) !== "3,2,4") return false;
    return VALID_SSN_SHAPE.test(digits);
  }

  function listedSSNs(text, groups) {
    const chunks = listChunks(text, groups);
    if (chunks.length < 2) return [];
    return chunks.filter(isSsnChunk).map((chunk) => spanText(text, chunk));
  }

  // A CSV with an SSN column ("phone,ssn" then "5555555636,219099999"): the header says what the values are.
  const SSN_COLUMN = /^["']?(?:ssn|social[\s_]*security(?:[\s_]*(?:number|no))?|social)["']?$/i;

  function ssnColumn(text) {
    if (!/ssn|social/i.test(text)) return [];
    const found = [];
    let column = -1;
    for (const line of text.split("\n")) {
      const cells = line.split(",").map((cell) => cell.trim());
      const header = cells.findIndex((cell) => SSN_COLUMN.test(cell));
      if (header >= 0) {
        column = header;
        continue;
      }
      if (column < 0 || cells.length <= column) {
        if (cells.length <= 1) column = -1; // a line that isn't a CSV row ends the table
        continue;
      }
      const value = cells[column].replace(/^["']|["']$/g, "");
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(value) && VALID_SSN_SHAPE.test(value.replace(/-/g, ""))) found.push(value);
    }
    return found;
  }

  // ── Finding SSNs ───────────────────────────────────

  // "SKU 460-12-3447": a stock, part or model number can have an SSN's 3-2-4 shape.
  const STOCK_WORDS = "sku|part|item|model|serial|product|catalog(?:ue)?|stock";
  const SHORT_CODE_NAMES = String.raw`upc|ean|lot|batch|p\/n|mpn|asin`;
  const NUMBER_WORD = String.raw`(?:\s*(?:number|no\.?|num|#|code|id))?`;
  const PRODUCT_CODE_BEFORE = new RegExp(
    String.raw`(?<![\p{L}])(?:${STOCK_WORDS}|${SHORT_CODE_NAMES})(?![\p{L}])${NUMBER_WORD}\s*(?:[:=#]|is)?\s*$`,
    "iu",
  );

  function productCodeBefore(text, run) {
    const start = run.units[0].start;
    return PRODUCT_CODE_BEFORE.test(text.slice(Math.max(0, start - 30), start));
  }

  // Digits need the 3-2-4 shape unless a label or the message says what they are.
  // Spelled-out numbers can be written any way.
  function ssnShapeOrSaid(text, run) {
    if (hasNumberWord(run.groups)) return true;
    if (numberGroupSizes(run.groups) === "3,2,4") return true;
    return ssnLabelBefore(text, run) || bareSSNContext(text, run);
  }

  function findSSNs(text) {
    const found = ssnColumn(text);
    for (const wrapped of wrappedNumbers(text, SSN_LABEL_NEAR)) {
      if (wrapped.sizes === "3,2,4" && VALID_SSN_SHAPE.test(wrapped.digits)) found.push(wrapped.span);
    }

    for (const run of numberRuns(text)) {
      const digits = digitsOf(run.groups);
      if (digits.length !== 9) {
        // A loop, not push(...list): a long list is too many arguments for one call.
        for (const ssn of listedSSNs(text, run.groups)) found.push(ssn);
        continue;
      }
      if (phoneContextBefore(text, run)) continue; // "call me at …"
      if (europeanNationalPhone(text, run)) continue;
      if (counting(text, run)) continue;
      if (inFileName(text, run)) continue;
      if (productCodeBefore(text, run) && !ssnLabelBefore(text, run)) continue;
      if (!ssnShapeOrSaid(text, run)) continue;
      if (!VALID_SSN_SHAPE.test(digits)) continue;
      if (isLetter(text[lastItem(run.units).end]) && !ssnLabelBefore(text, run)) continue;
      found.push(spanText(text, run.groups));
    }
    return found;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, listBreakAfter, findSSNs };
})();
