// findBankNumbers(): bank accounts, routing numbers, CLABE, CBU, sort codes and AWS account IDs after their labels.
(() => {
  "use strict";

  const { groupsEnd, spanText, digitsOf, numberRuns, label, runsByStart, numberAfter, ibanValid, ROUTING_ES } =
    globalThis.ClotrInternal;

  // ---------- US and Spanish accounts ----------

  // ── Bank accounts and routing numbers ─────────────

  const BANK_ACCOUNT_WORDS = String.raw`(?:(?:bank|checking|savings)\s+)?(?:account|acct)`;
  const BANK_LABELS = [label(BANK_ACCOUNT_WORDS)];
  // "aba8-" is a UUID's group ("…-4be6-aba8-42258489…"), not a label: a group is "aba", one hex digit and a dash.
  // "ABA021000021" and "RTN021000021" are a wire form's label glued to its number, and "rtn" is never hex.
  const ROUTING_LABELS = [label(String.raw`routing|aba(?![0-9a-f]-)|rtn`)];

  // ABA routing checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10).
  function abaValid(digits) {
    if (digits.length !== 9) return false;
    const d = [...digits].map(Number);
    return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
  }

  function bankAccountSize(digits) {
    return digits.length >= 6 && digits.length <= 17;
  }
  function accountSize(digits) {
    return digits.length >= 6 && digits.length <= 22;
  }

  // ── Spanish bank accounts ─────────────────────────
  // Reads things like "número de cuenta 1234567890" or "mi cuenta bancaria es la 1234567890", plus
  // Peru's 20-digit CCI. Accounts run up to 22 digits across the region, covering Spain's old 20-digit
  // account, Mexico's 18 and Argentina's 22. An amount right after isn't an account, so "en mi cuenta de
  // ahorros 150000 pesos" stays quiet.

  const SPANISH_ACCOUNT_KINDS = String.raw`(?:bancaria|corriente|de\s+ahorros?|de\s+cheques|n[oó]mina)`;
  const NUMBER_WORD = String.raw`(?:n[uú]mero|n\.?\s?[º°o]\.?|n[uú]m\.|nro\.?)`;
  const WHOSE = String.raw`(?:(?:la|mi|tu|su)\s+)?`;
  const NUMERO_DE_CUENTA = String.raw`${NUMBER_WORD}\s+de\s+${WHOSE}cuenta(?:\s+${SPANISH_ACCOUNT_KINDS})?`;
  const SPANISH_ACCOUNT_WORDS = String.raw`(?:${NUMERO_DE_CUENTA}|cuenta\s+${SPANISH_ACCOUNT_KINDS})`;
  const SPANISH_ACCOUNT_CONNECTOR = String.raw`(?![\p{L}])\s*(?:[:=#]|(?:es|era)(?![\p{L}]))?\s*(?:(?:el|la)\s+)?`;
  const SPANISH_ACCOUNT_NAME = String.raw`(?<![\p{L}])${SPANISH_ACCOUNT_WORDS}${SPANISH_ACCOUNT_CONNECTOR}`;
  const SPANISH_ACCOUNT_LABEL = new RegExp(SPANISH_ACCOUNT_NAME, "giu");
  const CCI_WORDS = String.raw`cci(?:\s+interbancari[oa])?`;
  const CCI_NAME = String.raw`(?<![\p{L}])${CCI_WORDS}${SPANISH_ACCOUNT_CONNECTOR}`;
  const CCI_LABEL = new RegExp(CCI_NAME, "giu");
  // A number right after an account's name is read as the account only, never also as a phone
  // (labelledAsOther), as in "account number 12345678901" or "cuenta de ahorros 12345678901".
  const ACCOUNT_NAME = String.raw`\b${BANK_ACCOUNT_WORDS}(?:\s*(?:number|no\.?|num|#|id))?\s*(?:[:=#]|is|was)?`;
  const ACCOUNT_NAME_BEFORE = new RegExp(String.raw`(?:${ACCOUNT_NAME}|${SPANISH_ACCOUNT_NAME}|${CCI_NAME})\s*$`, "iu");
  const AMOUNT_AFTER =
    /^\s*(?:pesos|euros?|d[oó]lares|dollars?|usd|eur|mxn|ars|cop|clp|pen|soles|€|\$|%|mil(?![\p{L}])|millones)/iu;

  function cciSize(digits) {
    return digits.length === 20;
  }

  function accountAfter(labelRe, text, okDigits) {
    let byStart = null;
    const found = [];
    for (const match of text.matchAll(labelRe)) {
      if (!byStart) byStart = runsByStart(text);
      const run = byStart.get(match.index + match[0].length);
      if (!run || !okDigits(digitsOf(run.groups))) continue;
      const end = groupsEnd(run);
      if (AMOUNT_AFTER.test(text.slice(end, end + 12))) continue;
      found.push(spanText(text, run.groups));
    }
    return found;
  }

  // ---------- Accounts with a check or a name ----------

  // ── Accounts with check digits: CLABE, CBU, CVU ───
  // Mexico's CLABE is 18 digits, the last a check digit. Argentina's CBU and CVU are 22 digits with two.
  // The check digits make these reliable enough to read a little after their name on the same line, as
  // in "Mi CLABE interbancaria para el depósito es …". A wrong check digit means it isn't one.

  const CHECKED_ACCOUNT_NAME = /(?<![\p{L}])(clabe|cbu|cvu)(?![\p{L}])/giu;
  // The same idea applies to phones (labelledAsOther): a Banamex CLABE starts with 002, which otherwise
  // reads like an international number.
  const CHECKED_ACCOUNT_NAME_BEFORE = /(?<![\p{L}])(?:clabe|cbu|cvu)(?![\p{L}])[^\n]*$/iu;
  const CLABE_WEIGHTS = [3, 7, 1];

  function clabeValid(digits) {
    if (digits.length !== 18) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += (Number(digits[i]) * CLABE_WEIGHTS[i % 3]) % 10;
    return (10 - (sum % 10)) % 10 === Number(digits[17]);
  }

  // The check digit at `to` brings the weighted sum of digits from..to-1 up to a multiple of ten.
  function checkDigitBalances(digits, from, to, weights) {
    let sum = 0;
    for (let i = from; i < to; i++) sum += Number(digits[i]) * weights[(i - from) % 4];
    return (10 - (sum % 10)) % 10 === Number(digits[to]);
  }

  // The bank and branch (7 digits) use the weights 7, 1, 3, 9 …, the account (13 digits) 3, 9, 7, 1 ….
  function cbuValid(digits) {
    if (digits.length !== 22) return false;
    return checkDigitBalances(digits, 0, 7, [7, 1, 3, 9]) && checkDigitBalances(digits, 8, 21, [3, 9, 7, 1]);
  }

  function checkedAccountAt(text, run) {
    const digits = digitsOf(run.groups);
    if (!clabeValid(digits) && !cbuValid(digits)) return false;
    const start = run.units[0].start;
    return CHECKED_ACCOUNT_NAME_BEFORE.test(text.slice(Math.max(0, start - 80), start));
  }

  // The first run from `first` on, on the same line and within 80 characters of `from`, that passes.
  function checkedRunAfter(text, runs, first, from, valid) {
    for (let j = first; j < runs.length && runs[j].units[0].start < from + 80; j++) {
      if (text.slice(from, runs[j].units[0].start).includes("\n")) return null;
      if (valid(digitsOf(runs[j].groups))) return spanText(text, runs[j].groups);
    }
    return null;
  }

  function checkedAccounts(text) {
    const found = [];
    let runs = null;
    // The first run that starts after the last name read. Names come in order, so each run is passed once.
    let next = 0;
    for (const match of text.matchAll(CHECKED_ACCOUNT_NAME)) {
      if (!runs) runs = numberRuns(text);
      const from = match.index + match[0].length;
      const valid = match[1].toLowerCase() === "clabe" ? clabeValid : cbuValid;
      while (next < runs.length && runs[next].units[0].start < from) next++;
      const account = checkedRunAfter(text, runs, next, from, valid);
      if (account !== null) found.push(account);
    }
    return found;
  }

  // ── IBANs and accounts named after the number ─────

  // Reads an IBAN after its name in any case, like "iban: es26 0000 …". On its own, an IBAN must be in
  // capitals instead (see findIbans).
  const IBAN_CONNECTOR = String.raw`\s*(?:(?:[:=#]|(?:is|was|es|era)(?![\p{L}]))\s*)?(?:(?:el|la)\s+)?`;
  const IBAN_VALUE = String.raw`([a-z]{2}\d{2}(?:[ -]?[a-z0-9]){11,30})`;
  const IBAN_LABELLED = new RegExp(
    String.raw`(?<![\p{L}])iban(?![\p{L}])${IBAN_CONNECTOR}${IBAN_VALUE}(?![\p{L}\d])`,
    "giu",
  );

  // The number before its name: "1234567890 is my account number", "1234567890 es mi número de cuenta".
  const NUMBER_FIRST = String.raw`(?<![\p{L}\d])(?<!\d[-./])(\d{2,22}(?:[ -]\d{2,8}){0,5})`;
  const IS_MY = String.raw`\s*(?:,\s*)?(?:is|was|es|era)\s+(?:my|our|the|mi|el|nuestro)\s+`;
  const ITS_NAME = String.raw`(?:${BANK_ACCOUNT_WORDS}\s+(?:number|no\.?|#)|${SPANISH_ACCOUNT_WORDS}|clabe|cbu|cvu)`;
  const ACCOUNT_NAMED_AFTER = new RegExp(String.raw`${NUMBER_FIRST}${IS_MY}${ITS_NAME}(?![\p{L}])`, "giu");

  function labelledIbans(text) {
    return [...text.matchAll(IBAN_LABELLED)].map((match) => match[1]).filter((iban) => ibanValid(iban.toUpperCase()));
  }

  function accountsNamedAfter(text) {
    return [...text.matchAll(ACCOUNT_NAMED_AFTER)]
      .map((match) => match[1])
      .filter((account) => accountSize(account.replace(/\D/g, "")));
  }

  // ---------- Other banks' numbers and AWS IDs ----------

  // ── Sort codes, BSBs and transit numbers ──────────
  // A UK sort code, an Australian BSB, or a Canadian transit and institution number, each read with the
  // account number right after it as one match, so Hide it takes the whole thing. None of these three has a
  // check digit, so on their own they'd be too easy to confuse with another number; the account right after
  // is what tells them apart from an everyday mention of a sort code or a BSB with nothing else next to it.
  // The gap after each name reads every run of spaces one way only, like the address gaps in street-addresses.js.

  const BANK_CONNECT = String.raw`(?:\s*(?:number|no\.?|num|#))?\s*(?:(?:[:=#]|is|was)\s*)?`;
  const ACCOUNT_WORD = String.raw`account(?:\s+(?:number|no\.?|num|#))?`;
  // Up to 30 characters with no digit or line break, then the account's name.
  const THEN_ACCOUNT = String.raw`[^\n\d]{0,30}\b${ACCOUNT_WORD}\b${BANK_CONNECT}`;
  const THEN_INSTITUTION = String.raw`[^\n\d]{0,30}\binstitution(?:\s+number)?\b${BANK_CONNECT}\d{3}\b`;
  const UK_SORT_CODE_RE = new RegExp(
    String.raw`\bsort\s*code\b${BANK_CONNECT}\d{2}[- ]?\d{2}[- ]?\d{2}\b${THEN_ACCOUNT}\d{6,10}\b`,
    "gi",
  );
  const AU_BSB_RE = new RegExp(
    String.raw`\bBSB\b${BANK_CONNECT}\d{3}[- ]?\d{3}\b${THEN_ACCOUNT}\d{3,10}(?:[ ]\d{3,6}){0,2}\b`,
    "gi",
  );
  const CA_TRANSIT_RE = new RegExp(
    String.raw`\btransit(?:\s+number)?\b${BANK_CONNECT}\d{5}\b${THEN_INSTITUTION}${THEN_ACCOUNT}\d{5,12}\b`,
    "gi",
  );

  // ── AWS account IDs ───────────────────────────────
  // An AWS account ID is 12 digits too, and "account 482019375564" beside an ARN, the word AWS or a region like
  // us-east-1 is that, not a bank account. A bank, checking, savings or routing word nearby still wins.

  const REGION_AREA = "(?:us|eu|ap|sa|ca|me|af|il|mx)";
  const REGION_SIDE = "(?:north|south|east|west|central|northeast|southeast|northwest|southwest)";
  const AWS_REGION = String.raw`\b${REGION_AREA}-${REGION_SIDE}-\d\b`;
  const AWS_MARKER = new RegExp(String.raw`\barn:aws|(?<![\p{L}])AWS(?![\p{L}])|${AWS_REGION}`, "iu");
  const BANK_WORD = /\b(?:bank|banking|checking|savings|routing|iban|swift|deposit|wire|ach)\b/i;
  const TWELVE_DIGITS = /(?<!\d)\d{12}(?!\d)/g;

  function aroundAccountId(text, at) {
    return text.slice(Math.max(0, at - 80), at + 92);
  }

  function awsAccountIds(text) {
    const ids = new Set();
    for (const match of text.matchAll(TWELVE_DIGITS)) {
      const near = aroundAccountId(text, match.index);
      if (AWS_MARKER.test(near) && !BANK_WORD.test(near)) ids.add(match[0]);
    }
    // One mention in a bank's words keeps the number reported wherever else it appears.
    for (const match of text.matchAll(TWELVE_DIGITS)) {
      const near = aroundAccountId(text, match.index);
      if (BANK_WORD.test(near) || !AWS_MARKER.test(near)) ids.delete(match[0]);
    }
    return ids;
  }

  function findBankNumbers(text) {
    const combined = [
      ...(text.match(UK_SORT_CODE_RE) || []),
      ...(text.match(AU_BSB_RE) || []),
      ...(text.match(CA_TRANSIT_RE) || []),
    ];
    const plain = [
      ...numberAfter(BANK_LABELS, text, bankAccountSize),
      ...numberAfter([...ROUTING_LABELS, ROUTING_ES], text, abaValid),
      ...accountAfter(SPANISH_ACCOUNT_LABEL, text, accountSize),
      ...accountAfter(CCI_LABEL, text, cciSize),
      ...checkedAccounts(text),
      ...labelledIbans(text),
      ...accountsNamedAfter(text),
    ];
    // A sort code, BSB or transit number's own account digits would also match the plain "account …" label on
    // their own; dropping anything already inside a combined match keeps Hide it from leaving the code behind.
    const cloud = plain.some((value) => /^\d{12}$/.test(value)) ? awsAccountIds(text) : new Set();
    const insideCombined = (value) => combined.some((match) => match.includes(value));
    return [...combined, ...plain.filter((value) => !insideCombined(value) && !cloud.has(value))];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, ACCOUNT_NAME_BEFORE, checkedAccountAt, findBankNumbers };
})();
