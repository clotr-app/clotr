// findAddresses(): street addresses in digits or words, US style, Spanish and Colombian streets, and
// postcodes, with the one form of an address that vault fingerprints use.
(() => {
  "use strict";

  const { trimTrail, lastItem, numberRuns, dotEndsSentence } = globalThis.ClotrInternal;

  // ---------- Street addresses, digits or spelled out ----------

  // "123 Main St, Springfield, IL 62704", "4500 N. Oak Ridge Road Apt 4B",
  // "one twenty three main street apt 4", "P.O. Box 1234".
  const NUM_WORDS =
    "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|" +
    "seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
  // At most 8 number words: unbounded, 40,000 spelled-out characters took 4 seconds. One line only, so a
  // "twenty" ending the line above isn't part of "Twelve Oak Street" below it.
  const HOUSE_NUM = String.raw`(?:\d{1,6}[A-Za-z]?|(?:${NUM_WORDS})(?:(?:[^\S\n]|-)+(?:${NUM_WORDS}|and)){0,7})`;
  const DIRECTION = String.raw`(?:north|south|east|west|n|s|e|w|ne|nw|se|sw)\.?`;
  // From "crescent/cres" on, the UK and Australian words (1.4.0).
  const SUFFIX_WORDS =
    "street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|" +
    "terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl|square|sq|loop|pike|" +
    "crescent|cres|close|mews|gardens|grove|croft|parade|esplanade|quay|wynd|circuit|promenade";
  const SUFFIX_PLAIN = `(?:${SUFFIX_WORDS})`;
  // Everyday words too. A street ends on one only if the next word isn't a plain suffix ("Sparrow Hill Dr"
  // is "Sparrow Hill"), and findAddresses still wants a tail, a front or an address phrase.
  const SUFFIX_AMBIGUOUS = String.raw`(?:park|green|hill|view|gate|walk|rise|row)`;
  const SUFFIX = String.raw`(?:${SUFFIX_PLAIN}|${SUFFIX_AMBIGUOUS}(?!\.?[^\S\n]+${SUFFIX_PLAIN}\.?\b))\.?`;
  const AMBIGUOUS_SUFFIX = new Set(["park", "green", "hill", "view", "gate", "walk", "rise", "row"]);
  // Each run of spaces between a label and its value reads one way only: "\s*(?:#\s*)?", not "\s*#?\s*".
  // Two runs can split the same spaces every possible way, which went quadratic on a label, a huge gap
  // and no value. The same goes for every label-to-value gap below.
  const ADDRESS_UNIT = String.raw`(?:,?\s+(?:apt|apartment|unit|suite|ste|#)\.?\s*(?:#\s*)?[A-Za-z0-9-]+)?`;
  // A flat before the number ("Flat 3, 12 Acacia Avenue"), an Australian "Unit 4/12" or "4/12", or a Canadian
  // "12-345 Main St", so Hide it covers it. addressCore ignores it, like ADDRESS_UNIT.
  const FLAT_FIRST = String.raw`(?:flat|apartment|apt)\.?\s*\d{1,4}[a-z]?,?[^\S\n]+`;
  const UNIT_SLASH = String.raw`(?:unit[^\S\n]+)?\d{1,4}\/[^\S\n]*`;
  const ADDRESS_FRONT = String.raw`(?:${FLAT_FIRST}|${UNIT_SLASH}|\d{1,4}-[^\S\n]*)`;
  // One to four words, the fewest that leave a suffix after them.
  const STREET_NAME = String.raw`(?:[A-Za-z0-9][\w'.-]*[^\S\n]+){0,3}?[A-Za-z0-9][\w'.-]*`;
  // One line only ([^\S\n]): a match that ran from a ZIP into the next line hid the address written there.
  const STREET_RE = new RegExp(
    String.raw`\b(?<front>${ADDRESS_FRONT})?(?<num>${HOUSE_NUM})[^\S\n]+(?:(?<pre>${DIRECTION})[^\S\n]+)?` +
      String.raw`(?<name>${STREET_NAME})[^\S\n]+(?<suf>${SUFFIX})` +
      String.raw`(?:[^\S\n]+(?<post>${DIRECTION}))?(?![\w])${ADDRESS_UNIT}`,
    "gi",
  );
  const PO_BOX_RE = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*(?:#\s*)?\d{1,6}\b/gi;
  // Words that make "<number> <word> <street word>" something else: "2 hard drive", "5 minutes drive".
  const NOT_A_STREET = new Set(
    (
      "hard test disk flash usb thumb long right wrong the a an this that my your our his her " +
      "any some no one other same half all each every way lane minute minutes min mins hour hours mile miles km " +
      "day days week weeks year years time times people more less of to in for and or star stars point points step " +
      "steps bed beds bedroom bedrooms room rooms car cars story stories person man men dollar dollars a.m p.m am pm " +
      // Linking words never name a street: "at 3 with Dr", half typed before the doctor's name.
      "with at by from on about after before until till near into onto without around against"
    ).split(" "),
  );

  // ── Town and postcode after a street ───────────────

  const STATES =
    "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|" +
    "MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
  // Case-sensitive, so "…St, then walk to me" doesn't swallow the rest of the sentence.
  // ", Springfield, IL 62704", ", IL 62704" or ", 62704".
  const TOWN = String.raw`[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}`;
  const ZIP = String.raw`\d{5}(?:-\d{4})?`;
  const CITY_STATE_ZIP = new RegExp(
    String.raw`^(?:,?\s*${TOWN},?\s+(?:${STATES})\b(?:\s+${ZIP})?|,?\s+(?:${STATES})\s+${ZIP}|,?\s+${ZIP}\b)`,
  );
  // Outward part, then inward part. Royal Mail never starts with Q, V or X.
  const UK_POSTCODE = String.raw`[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\s?\d[A-Z]{2}`;
  const UK_TAIL_RE = new RegExp(String.raw`^,?\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2},?\s+${UK_POSTCODE}\b`, "i");
  // A1A 1A1, never with D, F, I, O, Q or U.
  const CA_POSTAL = String.raw`[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ]\s?\d[ABCEGHJKLMNPRSTVWXYZ]\d`;
  const CA_PROVINCES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";
  // Only a space splits the town's words. "Saint-Jean-sur-Richelieu" is one word, and letting dashes split
  // too gave a long dashed run cubically many readings.
  const CA_TAIL_RE = new RegExp(
    String.raw`^,?\s*[A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+){0,2},?\s+(?:\(Qu[ée]bec\)|${CA_PROVINCES})\s+${CA_POSTAL}\b`,
    "iu",
  );
  const AU_STATES = "NSW|VIC|QLD|WA|SA|TAS|ACT|NT";
  const AU_TAIL_RE = new RegExp(
    String.raw`^,?\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2},?\s+(?:${AU_STATES})\s+\d{4}\b`,
    "i",
  );
  // An everyday suffix like "park" needs a phrase like this before it, a tail or a front.
  const ADDRESS_PHRASES_EN = [
    String.raw`I\s+live\s+at|living\s+at|send\s+it\s+to|ship\s+it\s+to|mail\s+it\s+to|deliver\s+it\s+to`,
    String.raw`my\s+address\s+is|moved\s+to|move\s+to`,
  ].join("|");
  const ADDRESS_PHRASE_EN = new RegExp(String.raw`\b(?:${ADDRESS_PHRASES_EN})\s*$`, "i");

  // The town and postcode, so Hide it covers them too. The longest reading wins, not the first: "WA" is
  // Washington and Western Australia, and the ZIP-less US reading would beat the one with the postcode.
  function addressTail(rest) {
    let best = null;
    for (const tail of [CITY_STATE_ZIP, UK_TAIL_RE, CA_TAIL_RE, AU_TAIL_RE]) {
      const match = tail.exec(rest);
      if (match && (!best || match[0].length > best.length)) best = match[0];
    }
    return best;
  }

  // ── One form per address, for vault fingerprints ───

  // "123 Oak St., Springfield" and "one twenty three oak street apt 4" both become "123 oak street".
  const SUFFIX_CANON = {
    st: "street",
    ave: "avenue",
    av: "avenue",
    rd: "road",
    blvd: "boulevard",
    dr: "drive",
    ln: "lane",
    ct: "court",
    pl: "place",
    ter: "terrace",
    cir: "circle",
    pkwy: "parkway",
    hwy: "highway",
    trl: "trail",
    sq: "square",
    cres: "crescent",
  };
  const DIR_CANON = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
  };

  function canonicalWord(word, map) {
    const plain = word.toLowerCase().replace(/\.$/, "");
    return map[plain] || plain;
  }

  // "one twenty three" becomes "123".
  function houseNumberDigits(houseNumber) {
    if (/^\d/.test(houseNumber)) return houseNumber.toLowerCase();
    return numberRuns(houseNumber)
      .flatMap((run) => run.units)
      .map((unit) => unit.digits)
      .join("");
  }

  function addressCore(text) {
    const box = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*(?:#\s*)?(\d{1,6})\b/i.exec(text);
    if (box) return `po box ${box[1]}`;
    const match = new RegExp(STREET_RE.source, "i").exec(text);
    if (!match) return colombianAddressCore(text) || spanishAddressCore(text);
    const parts = match.groups;
    return [
      houseNumberDigits(parts.num),
      parts.pre && canonicalWord(parts.pre, DIR_CANON),
      ...parts.name.toLowerCase().replace(/\./g, "").split(/\s+/),
      canonicalWord(parts.suf, SUFFIX_CANON),
      parts.post && canonicalWord(parts.post, DIR_CANON),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // ── Spanish streets and home coordinates ───────────

  // The street type, a capitalized name (with "de la", "del" …), then the number.
  const SPANISH_STREET_TYPES =
    "[Cc]alle|[Cc]/|[Aa]venida|[Aa]vda\\.?|[Aa]v\\.|[Pp]aseo|[Pp]laza|[Pp]za\\.|" +
    "[Cc]arrera|[Cc]ra\\.|[Cc]amino|[Rr]onda|[Tt]raves[ií]a|[Cc]alzada|[Bb]ulevar";
  const SPANISH_STREET_WORD = "[A-ZÁÉÍÓÚÑ][\\p{L}.'-]*";
  const SPANISH_STREET_JOINER = "(?:de(?:l|\\s+la|\\s+los|\\s+las)?\\s+)?";
  // A word of the name with its "de la" or "del": "Alcalá", "de la Paz".
  const SPANISH_NAME_PART = `${SPANISH_STREET_JOINER}${SPANISH_STREET_WORD}`;
  const SPANISH_STREET_NAME = String.raw`${SPANISH_NAME_PART}(?:\s+${SPANISH_NAME_PART}){0,4}`;
  const SPANISH_HOUSE_NUMBER = String.raw`(?:(?:n[º°o.]|n[uú]mero|num\.?)\s*)?\d{1,4}(?!\d)`;
  const SPANISH_STREET_RE = new RegExp(
    String.raw`(?<![\p{L}])(?:${SPANISH_STREET_TYPES})\s*${SPANISH_STREET_NAME},?\s+${SPANISH_HOUSE_NUMBER}`,
    "gu",
  );
  // "my home is at 40.712776, -74.005974" is as exact as an address. Only after a home phrase and with
  // 4+ decimals (about 10 meters), so a landmark's or a restaurant search's coordinates stay quiet.
  const COORD_NUM = String.raw`-?\d{1,3}\.\d{4,}°?`;
  const COORD = String.raw`${COORD_NUM}\s*[NSEW]?`;
  const HOME_PHRASES = [
    String.raw`my\s+(?:home|house|place|apartment|flat|address)|I\s+live`,
    String.raw`mi\s+(?:casa|piso|domicilio)|vivo`,
  ].join("|");
  const COORD_PAIR = String.raw`${COORD_NUM}\s*(?:[NSEW]\s*)?(?:,\s*)?${COORD}`;
  const HOME_COORDINATES = new RegExp(
    String.raw`(?<![\p{L}])(?:${HOME_PHRASES})(?![\p{L}])[^\n\d-]{0,25}(${COORD_PAIR})`,
    "giu",
  );
  // Any case, but only right after an address phrase like "vivo en" or "mi dirección es".
  const SPANISH_STREET_ANY_CASE = new RegExp(SPANISH_STREET_RE.source, "iuy");
  const SPANISH_NOT_A_STREET = new Set(
    (
      "al lado hace que con en muy por para desde hasta cerca frente junto donde esta este esa ese " +
      "una un y o sin sobre entre tras hacia según como"
    ).split(" "),
  );
  const ADDRESS_PHRASES_ES = [
    String.raw`viv(?:o|e|imos|en)\s+en(?:\s+la)?`, // "vivo en"
    String.raw`(?:mi\s+)?(?:direcci[oó]n|domicilio)(?:\s+es|\s*:)`, // "mi dirección es"
    String.raw`(?:m[aá]nd|env[ií])\p{L}*\s+a`, // "mándalo a", "envíalo a"
  ].join("|");
  const ADDRESS_PHRASE_ES = new RegExp(String.raw`(?<![\p{L}])(?:${ADDRESS_PHRASES_ES})\s+`, "giu");
  // "C/ Alcalá, 45" becomes "calle alcalá 45".
  const SPANISH_TYPE_CANON = [
    [/^c(?:alle|\/)$/, "calle"],
    [/^av(?:enida|da\.?|\.)$/, "avenida"],
    [/^p(?:laza|za\.)$/, "plaza"],
    [/^c(?:arrera|ra\.?)$/, "carrera"],
    [/^traves[ií]a$/, "travesía"],
  ];

  function spanishAddressCore(text) {
    const match = new RegExp(SPANISH_STREET_RE.source, "iu").exec(text); // any case: the vault says it's an address
    if (!match) return null;
    const words = match[0]
      .toLowerCase()
      .replace(/,/g, " ")
      .replace(/(?<![\p{L}])(?:n[º°o.]|n[uú]mero|num\.?)(?:\s+|(?=\d))/gu, "")
      .split(/\s+/)
      .filter(Boolean);
    // "c/alcalá" is the type and the name glued together.
    if (/^c\/./.test(words[0])) words.splice(0, 1, "c/", words[0].slice(2));
    const [type, ...rest] = words;
    const known = SPANISH_TYPE_CANON.find(([pattern]) => pattern.test(type));
    return [known ? known[1] : type, ...rest].join(" ");
  }

  // ── Not a street: years and doctors ────────────────

  // A house number from 1900 to 2099 is a year after a time word: "in 2024 the road…", "by 2030 Main Street
  // will…". Without one, "ship it to 2068 Oak Street" is an address.
  const YEAR_BEFORE =
    /(?<!\p{L})(?:in|since|by|from|until|till|before|after|during|of|circa|around|the|en|desde|hasta)\s+$/iu;
  // "at 3 with Dr. Okafor": a capitalized name after "Dr", with a lowercase word before it. Someone who
  // capitalizes "Okafor" capitalizes a street too ("418 Maple Dr. Springfield"). "Apt", a direction or
  // a ZIP after it still make it a street.
  const NAME_PARTICLES = String.raw`(?:(?:de|del|la|las|los|van|von|da|di|du|le)[^\S\n]+){0,2}`;
  const NOT_UNIT_OR_DIRECTION = String.raw`(?!(?:Apt|Apartment|Unit|Suite|Ste|North|South|East|West)(?![\p{L}]))`;
  const NAME_AFTER_TITLE = new RegExp(
    String.raw`^Dr\.?[^\S\n]+${NAME_PARTICLES}${NOT_UNIT_OR_DIRECTION}\p{Lu}[\p{Ll}'’]`,
    "u",
  );
  // These count as lowercase even capitalized: "Follow-up At 3 With Dr. Okafor".
  const BEFORE_A_TITLE = /^(?:with|and|see|seeing|con|el|la|y|ver)$/i;

  function yearNotHouseNumber(text, match) {
    if (!/^(?:19|20)\d\d$/.test(match[0].split(/\s/)[0])) return false;
    return YEAR_BEFORE.test(text.slice(Math.max(0, match.index - 12), match.index));
  }

  function doctorNotDrive(text, match) {
    const { name, suf } = match.groups;
    if (!/^Dr\.?$/.test(suf)) return false;
    const wordBefore = lastItem(name.split(/\s+/));
    if (!/^\p{Ll}/u.test(wordBefore) && !BEFORE_A_TITLE.test(wordBefore)) return false;
    const at = match.index + match[0].lastIndexOf(suf);
    if (!NAME_AFTER_TITLE.test(text.slice(at, at + 60))) return false;
    const tail = CITY_STATE_ZIP.exec(text.slice(at + suf.length));
    return !(tail && /\d{5}/.test(tail[0]));
  }

  // "park" or "view" alone isn't a street: it needs a front, a tail or an address phrase before it.
  function everydaySuffixAlone(text, match) {
    if (!AMBIGUOUS_SUFFIX.has(match.groups.suf.toLowerCase().replace(/\.$/, ""))) return false;
    if (match.groups.front) return false;
    if (addressTail(text.slice(match.index + match[0].length))) return false;
    return !ADDRESS_PHRASE_EN.test(text.slice(Math.max(0, match.index - 40), match.index));
  }

  // ── Postcodes on their own, Quebec streets ─────────

  // "my postcode is SW1A 1AA", "postal code: K1A 0B1". A bare Australian 4-digit code is too everyday,
  // so it counts only next to a state.
  const POSTCODE_LABEL = /\b(?:my\s+)?post(?:al\s+code|code)(?:\s+(?:is|number))?\s*[:=]?\s*/gi;
  const UK_POSTCODE_AT_START = new RegExp(`^${UK_POSTCODE}\\b`, "i");
  const CA_POSTAL_AT_START = new RegExp(String.raw`^${CA_POSTAL}\b`, "i");
  // The comma owns the space after it, so a long gap before a non-state reads one way only.
  const AU_POSTCODE_BEFORE_STATE = new RegExp(String.raw`^\d{4}(?=\s*(?:,\s*)?(?:${AU_STATES})\b)`, "i");

  function ownPostcodes(text) {
    const found = [];
    for (const labelMatch of text.matchAll(POSTCODE_LABEL)) {
      const rest = text.slice(labelMatch.index + labelMatch[0].length);
      const postcode =
        UK_POSTCODE_AT_START.exec(rest) || CA_POSTAL_AT_START.exec(rest) || AU_POSTCODE_BEFORE_STATE.exec(rest);
      if (postcode) found.push(postcode[0]);
    }
    return found;
  }

  // Quebec writes the type lowercase after the number: "123 rue Sainte-Catherine", "12 chemin de la Rivière".
  // No addressCore form yet: the vault matches these by their own text.
  const QUEBEC_STREET_JOINER = String.raw`(?:(?:de|du|des|d'|la|le|les)\s*){0,2}`;
  const QUEBEC_STREET_WORD = "[A-ZÀ-Ý][\\p{L}.'-]*";
  const QUEBEC_TYPE = "(?:rue|avenue|boulevard|chemin)";
  const QUEBEC_NAME_PART = `${QUEBEC_STREET_JOINER}${QUEBEC_STREET_WORD}`;
  const QUEBEC_STREET_RE = new RegExp(
    String.raw`\b\d{1,6}[^\S\n]+${QUEBEC_TYPE}[^\S\n]+${QUEBEC_NAME_PART}(?:[^\S\n]+${QUEBEC_NAME_PART}){0,3}`,
    "giu",
  );

  // ── Finding addresses ──────────────────────────────

  // The street name's words, and whether one of them ends a sentence ("5 minutes. Drive safe!",
  // "2 tickets. elm street…"). No real street name has a full stop after a whole word.
  function streetWords(match) {
    const typed = match.groups.name.split(/[^\S\n]+/);
    const words = typed.map((word) => trimTrail(word, /\./));
    const sentenceEnd = typed.some((word, i) => word !== words[i] && dotEndsSentence(words[i]));
    return { words, sentenceEnd };
  }

  function usStreets(text, withTail) {
    STREET_RE.lastIndex = 0;
    let match;
    while ((match = STREET_RE.exec(text))) {
      const { words, sentenceEnd } = streetWords(match);
      if (sentenceEnd) {
        // Pick up again from the next number: "…5 minutes. 42 Oak Street".
        STREET_RE.lastIndex = match.index + (match.groups.front || "").length + match.groups.num.length;
        continue;
      }
      if (words.some((word) => NOT_A_STREET.has(word.toLowerCase()))) continue;
      if (yearNotHouseNumber(text, match)) continue;
      if (doctorNotDrive(text, match)) continue;
      if (everydaySuffixAlone(text, match)) continue;
      withTail(match.index, match.index + match[0].length);
    }
  }

  // "vivo en calle mayor 5", all lowercase, right after an address phrase.
  // Everyday words mean a sentence, not a street ("vivo en la calle de al lado hace 5 años").
  function spanishStreetsAfterPhrase(text) {
    const streets = [];
    for (const phrase of text.matchAll(ADDRESS_PHRASE_ES)) {
      SPANISH_STREET_ANY_CASE.lastIndex = phrase.index + phrase[0].length;
      const street = SPANISH_STREET_ANY_CASE.exec(text);
      if (!street) continue;
      const words = street[0].toLowerCase().split(/[\s,]+/);
      if (!words.some((word) => SPANISH_NOT_A_STREET.has(word))) streets.push(street[0]);
    }
    return streets;
  }

  function findAddresses(text) {
    const found = [];
    function withTail(start, end) {
      const tail = addressTail(text.slice(end));
      found.push(text.slice(start, end + (tail ? tail.length : 0)));
    }

    usStreets(text, withTail);
    for (const match of text.matchAll(PO_BOX_RE)) withTail(match.index, match.index + match[0].length);
    for (const match of text.matchAll(SPANISH_STREET_RE)) found.push(match[0]);
    for (const match of text.matchAll(QUEBEC_STREET_RE)) found.push(match[0]);
    for (const match of text.matchAll(HOME_COORDINATES)) found.push(match[1]);
    for (const postcode of ownPostcodes(text)) found.push(postcode);
    for (const street of spanishStreetsAfterPhrase(text)) found.push(street);
    return withColombianStreets(text, found);
  }

  // ── Colombia's numbered streets ───────────────────
  // Reads Colombia's numbered streets: a street type and number, then "#" or "No." and the house's "93-47",
  // as in "Carrera 15 # 93-47" or "Cra. 7 No. 45-10". This matches in any case, since the "# 93-47" part is
  // what makes it an address; "calle 72 es bonita" on its own isn't one.

  const COLOMBIAN_STREET_TYPES = [
    String.raw`carrera|cra\.?|kra\.?|kr\.?|calle|cll\.?|cl\.?|diagonal|diag\.?|dg\.?`,
    String.raw`transversal|transv\.?|tv\.?|avenida|av\.?`,
  ].join("|");
  // "Avenida Carrera 15" has two types.
  const COLOMBIAN_STREET_TYPE = String.raw`(?:av(?:enida|\.)?[^\S\n]{0,3})?(?:${COLOMBIAN_STREET_TYPES})`;
  // "15", "15A", "15 bis B", "15 sur".
  const COLOMBIAN_STREET_NUMBER =
    String.raw`\d{1,3}(?:[^\S\n]?[a-z])?` + String.raw`(?:[^\S\n]?bis(?:[^\S\n]?[a-z])?)?(?:[^\S\n]{1,3}(?:sur|este))?`;
  const COLOMBIAN_NO = String.raw`(?:#|n[º°o]\.?|nro\.?|n[uú]mero)`;
  // In "# 93-47", the cross street's number, then the house's.
  const CROSS_STREET_NUMBER = String.raw`\d{1,3}(?:[^\S\n]?[a-z])?(?:[^\S\n]?bis)?`;
  const SPACES = String.raw`[^\S\n]{0,3}`;
  const COLOMBIAN_STREET_RE = new RegExp(
    String.raw`(?<![\p{L}\d])(${COLOMBIAN_STREET_TYPE})${SPACES}(${COLOMBIAN_STREET_NUMBER})${SPACES}` +
      String.raw`${COLOMBIAN_NO}${SPACES}(${CROSS_STREET_NUMBER})${SPACES}-${SPACES}(\d{1,3})(?![\p{L}\d])`,
    "giu",
  );
  // The first one only, for colombianAddressCore.
  const FIRST_COLOMBIAN_STREET = new RegExp(COLOMBIAN_STREET_RE.source, "iu");
  // The same street however it's written (vault fingerprints): "Cra. 15 No. 93 - 47" = "carrera 15 # 93-47".
  const COLOMBIAN_TYPE_CANON = {
    cra: "carrera",
    kra: "carrera",
    kr: "carrera",
    cll: "calle",
    cl: "calle",
    diag: "diagonal",
    dg: "diagonal",
    transv: "transversal",
    tv: "transversal",
    av: "avenida",
  };

  function lowerNoSpaces(part) {
    return part.toLowerCase().replace(/\s+/g, "");
  }

  function colombianAddressCore(text) {
    const street = FIRST_COLOMBIAN_STREET.exec(text);
    if (!street) return null;
    const [, written, streetNumber, house, door] = street;
    const typeWords = written
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter(Boolean)
      .map((word) => COLOMBIAN_TYPE_CANON[word] || word);
    return `${typeWords.join(" ")} ${lowerNoSpaces(streetNumber)} # ${lowerNoSpaces(house)}-${lowerNoSpaces(door)}`;
  }

  // A Colombian street replaces a shorter match inside it ("Av. Calle 26" in "Av. Calle 26 # 69-76").
  function withColombianStreets(text, found) {
    const streets = [...text.matchAll(COLOMBIAN_STREET_RE)].map((match) => match[0]);
    if (!streets.length) return found;
    const notInsideAStreet = found.filter((address) => !streets.some((street) => street.includes(address)));
    return [...notInsideAStreet, ...streets];
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, NUM_WORDS, addressCore, findAddresses };
})();
