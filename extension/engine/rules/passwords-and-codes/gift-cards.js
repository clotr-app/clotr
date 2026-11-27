// findGiftCards(): gift card codes near a gift card word, joined back up when they're typed in pieces.
(() => {
  "use strict";

  const { validLuhn, isKeyPlaceholder, lastItem, isIsbn13 } = globalThis.ClotrInternal;

  // ---------- Gift card codes ----------
  // The US FTC says gift cards are what scammers most often ask older people to pay with, telling them to
  // "buy gift cards and read me the numbers on the back". This looks for a gift card word, like a plain
  // gift card, a specific store's card, or "tarjeta regalo", followed by its numbers in the same sentence
  // or the next one, as in "the gift card code is 7KQ2-9PMX-4RT8".
  // Stores whose cards are named on their own, like "a Steam card".
  const STORE_NAMES =
    String.raw`apple|itunes|google\s*play|steam|amazon|target|walmart|ebay|razer\s*gold|xbox|play\s*station|psn|` +
    String.raw`nintendo(?:\s*e-?shop)?|vanilla|best\s*buy|sephora`;
  const BACK_OF = String.raw`(?:numbers?|digits?|codes?)\s+(?:off|on|from)\s+(?:the\s+)?back\s+of`;
  const WHICH_CARD = "(?:the|my|your|this|that|these|those|a|each)";
  const GIFT_WORDS =
    String.raw`(?:` +
    String.raw`(?:e-?\s?)?gift[\s-]*cards?` +
    String.raw`|(?:${STORE_NAMES})\s+(?:gift\s*)?cards?` +
    String.raw`|(?:claim|redemption)\s+codes?` +
    String.raw`|${BACK_OF}\s+${WHICH_CARD}\s+(?:gift\s*)?cards?` +
    String.raw`|tarjetas?\s+(?:de\s+)?regalo|c[oó]digos?\s+de\s+canje` +
    String.raw`|tarjetas?\s+(?:de\s+)?(?:google\s*play|apple|itunes|amazon|steam|xbox|play\s*station|psn|nintendo)` +
    String.raw`)`;
  const GIFT_LABEL = new RegExp(String.raw`(?<![\p{L}\d])${GIFT_WORDS}(?![\p{L}])`, "giu");
  // Finds where the n-th sentence ends in a stretch of text, meaning its stop before a space or the end,
  // or a line break, falling back to the end of the stretch if there aren't that many. Giving every search
  // a definite end like this means no text ever gets read twice.
  const SENTENCE_END = /[.!?…]+(?=\s|$)|\n/g;
  function sentenceStop(text, from, to, n) {
    let seen = 0;
    for (const m of text.slice(from, to).matchAll(SENTENCE_END)) {
      seen++;
      if (seen === n) return from + m.index;
    }
    return to;
  }
  // A code can be typed as letters and digits joined by dashes, like "7KQ2-9PMX-4RT8", or as one piece.
  const CODE_PIECE = /(?<![\p{L}\p{N}])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\p{L}\p{N}])/gu;
  // Rules out a piece that's really part of something else, like an amount of money, a percentage, a date,
  // a link, or a phone's country code.
  const NOT_BEFORE_PIECE = /[$€£¥#@/\\.+_%&=~]/;
  const NOT_AFTER_PIECE = /^(?:[@/\\%_&=~€]|[.,]\p{N})/u;
  // Common words, in English or Spanish, that a code can never actually be.
  const NOT_CODE_WORDS = new Set(
    "pin nip and the are is was code codes card cards gift and pero con son es era pin y el la los".split(" "),
  );
  // Rules out a number someone names as something else right before it, like an order or tracking number.
  const OTHER_NUMBER_NAMES =
    "order|tracking|track|confirmation|reference|ref|invoice|receipt|transaction|account|routing|sku|model|serial|" +
    "upc|isbn|item|part|phone|call|text|tel|fax|" +
    "pedido|seguimiento|referencia|factura|recibo|cuenta|tel[eé]fono|m[oó]vil|llama";
  const NUMBER_WORD = String.raw`(?:\s+(?:number|no\.?|#|id|code|n[uú]mero|c[oó]digo))?`;
  const NAMED_OTHER = new RegExp(
    String.raw`(?<![\p{L}])(?:${OTHER_NUMBER_NAMES})${NUMBER_WORD}\s*(?:is|was|es|era)?\s*[:#]?\s*$`,
    "iu",
  );
  // The gift card's PIN, told after its code in the same sentence, as in "and the pin is 4471".
  const GIFT_PIN = /(?<![\p{L}])(?:pin|nip)(?![\p{L}])[^\n\d.!?]{0,20}?(?<![\p{L}\p{N}])(\d{4,8})(?![\p{L}\p{N}])/iu;

  // ── Joining pieces into a code ──
  // Describes one piece's shape so pieces can be joined into a code: it needs a digit, or to be all
  // capitals, like the group "PMXR".
  const pieceOf = (text, m) => {
    const value = m[0];
    const end = m.index + value.length;
    const apart = NOT_BEFORE_PIECE.test(text[m.index - 1] || "") || NOT_AFTER_PIECE.test(text.slice(end, end + 2));
    const digit = /\d/.test(value);
    const caps = !digit && /^[A-Z]{3,8}$/.test(value) && !NOT_CODE_WORDS.has(value.toLowerCase());
    return { start: m.index, end, value, dash: value.includes("-"), usable: !apart && (digit || caps) };
  };
  // Decides whether a run of pieces reads as one gift card code: 10 to 25 letters and digits (an Xbox code
  // runs to 25), with at least two digits and the letters all one case, so "iPhone15ProMax" doesn't qualify.
  // All-digit codes only count from 12 digits up, since fewer would be a phone number and one starting "00"
  // a phone called from abroad; one that passes the Luhn check still reads as a card number instead.
  function giftCode(value) {
    const plain = value.replace(/[\s-]/g, "");
    const digits = plain.replace(/\D/g, "").length;
    if (plain.length < 10 || plain.length > 25) return false;
    if (digits < 2 || isKeyPlaceholder(plain)) return false;
    if (/[a-z]/.test(plain) && /[A-Z]/.test(plain)) return false;
    if (digits < plain.length) return true;
    if (digits < 12 || plain.startsWith("00")) return false;
    // A number that passes the Luhn check is a card number, unless it's a book's ISBN.
    return !validLuhn(plain) || isIsbn13(plain);
  }

  // Reads the codes out of one stretch of text after a gift card's word. Pieces separated by a single space
  // join into one code when they're the same size, like a printed card's groups "7KQ2 PMXR 4RT8 W9ZL",
  // though the last can be shorter if it has a digit; a piece with dashes already in it counts as a
  // complete code on its own. Each code that passes the checks goes into `out`, with any PIN found after it.
  // Whether a piece joins the run: both are plain groups one space apart, and it's the first group's size, or
  // shorter with a digit in it as the last group.
  function joinsRun(text, run, piece) {
    const first = run[0];
    if (!first || !piece.usable || piece.dash || first.dash) return false;
    if (text.slice(lastItem(run).end, piece.start) !== " ") return false;
    if (piece.value.length === first.value.length) return true;
    return piece.value.length < first.value.length && /\d/.test(piece.value);
  }

  function giftCodesIn(text, from, to, out) {
    const pieces = [];
    for (const m of text.slice(from, to).matchAll(CODE_PIECE)) {
      pieces.push(pieceOf(text, { 0: m[0], index: from + m.index }));
    }
    let run = [];
    const closeRun = () => {
      if (!run.length) return;
      const start = run[0].start;
      const value = text.slice(start, lastItem(run).end);
      run = [];
      if (!giftCode(value) || NAMED_OTHER.test(text.slice(Math.max(0, start - 40), start))) return;
      out.push(value);
      const end = start + value.length;
      const pin = GIFT_PIN.exec(text.slice(end, sentenceStop(text, end, Math.min(text.length, end + 80), 1)));
      if (pin && !isKeyPlaceholder(pin[1])) out.push(pin[1]);
    };
    for (const piece of pieces) {
      if (joinsRun(text, run, piece)) {
        run.push(piece);
        // A shorter group ends the code it's the last part of.
        if (piece.value.length < run[0].value.length) closeRun();
        continue;
      }
      closeRun();
      if (piece.usable) run = [piece];
    }
    closeRun();
  }

  // ── Every gift card in a text ──
  // Each gift card word reads up to the end of the next sentence, 300 characters at most, or up to the next
  // such word, which then reads on from there, so every stretch of text is read once. The result is
  // cached for the last text read, the same way findCardCodes caches its answer.
  let giftCardsFor = { text: null, codes: [] };
  function findGiftCards(text) {
    if (giftCardsFor.text !== text) {
      const labels = [...text.matchAll(GIFT_LABEL)];
      const codes = [];
      labels.forEach((labelMatch, k) => {
        const from = labelMatch.index + labelMatch[0].length;
        const nextLabel = labels[k + 1]?.index ?? Infinity;
        const to = sentenceStop(text, from, Math.min(text.length, from + 300, nextLabel), 2);
        if (to > from) giftCodesIn(text, from, to, codes);
      });
      giftCardsFor = { text, codes: [...new Set(codes)] };
    }
    return [...giftCardsFor.codes];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, GIFT_WORDS, findGiftCards };
})();
