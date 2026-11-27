// Generalize: a found detail swapped for a coarser one that still helps the talk along, like a birth date's
// month and year. detect.js hands generalize() and generalForms() to pages and apps.
(() => {
  "use strict";

  const { isSavedWord, replaceBySpan, cleaned } = globalThis.ClotrInternal;

  // ---------- Generalize instead of remove ----------
  // Returns a coarser version of a detail that still helps the conversation along: a birth date keeps its
  // month and year, like "March 1948", and an address keeps just its town, like "Springfield". Returns null
  // when there's nothing safe to keep.
  const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
    ene: 1,
    abr: 4,
    ago: 8,
    dic: 12, // Spanish where it differs
  };
  const monthOf = (word) => MONTHS[word.slice(0, 3).toLowerCase()] ?? null;

  function birthMonthYear(match) {
    const iso = /\b(1[89]\d\d|20\d\d)([-/.])(\d{1,2})\2(\d{1,2})\b/.exec(match); // 1987-04-12, 1987/04/12
    if (iso) return { year: Number(iso[1]), month: Number(iso[3]) };
    const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](1[89]\d\d|20\d\d)\b/.exec(match);
    if (numeric) {
      const [first, second] = [Number(numeric[1]), Number(numeric[2])];
      // Day and month can only be told apart when one of them is over 12; otherwise keep just the year.
      let month = null;
      if (first > 12 && second <= 12) month = second;
      else if (second > 12 && first <= 12) month = first;
      return { year: Number(numeric[3]), month };
    }
    const year = /\b(1[89]\d\d|20\d\d)\b/.exec(match);
    if (!year) return null;
    // The first word that's a month's name.
    const words = /\b([a-záéíóú]{3,})\b/gi;
    let month = null;
    for (let m; !month && (m = words.exec(match));) month = monthOf(m[1]);
    return { year: Number(year[1]), month };
  }

  // A suite, unit or apartment part, even one lettered rather than numbered ("Suite B", "Unit Penthouse"). Words
  // that also start town names ("Flat Rock", "Ste. Genevieve") count only before a short designator ("Flat 3B").
  const UNIT_WORDS = "apt|apartment|suite|unit|piso|puerta|depto|dpto|departamento";
  const TOWN_LIKE_UNIT_WORDS = "flat|floor|fl|ste|room|rm";
  const UNIT_PART = new RegExp(String.raw`^(?:#|(?:${UNIT_WORDS})\b|(?:${TOWN_LIKE_UNIT_WORDS})\.?\s+\S{1,3}$)`, "i");
  const CANADIAN_POSTAL_CODE = /\s+(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)?\s*[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i;

  function townOf(match) {
    const parts = match.split(",").map((part) => part.trim());
    if (parts.length < 2) return null;
    // A flat or apartment number in front of the street adds its own comma-separated part, so the town isn't
    // always parts[1]: try each part after the street and keep the first one that's left holding just a name
    // once its own trailing postcode, state or ZIP (if any) is stripped, and isn't a suite or unit.
    for (const part of parts.slice(1)) {
      if (UNIT_PART.test(part)) continue;
      const town = part
        .replace(CANADIAN_POSTAL_CODE, "")
        .replace(/\s+\(?Qu[ée]bec\)?$/i, "") // Quebec written as the province name
        .replace(/\s+(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}$/, "") // Australian state and postcode
        .replace(/\s+[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/, "") // UK postcode
        .replace(/\s*\b\d{5}(-\d{4})?$/, "") // US ZIP
        .replace(/\s+[A-Z]{2}$/, "") // US state
        .replace(/^\d{4,5}\s+/, "") // a postal code before the town (Spain, much of Europe)
        .trim();
      if (/^[\p{L}][\p{L} .'-]{0,39}$/u.test(town)) return town;
    }
    return null;
  }

  function generalForm(patternId, match, locale = "en-US") {
    if (patternId === "date_of_birth") {
      const birth = birthMonthYear(match);
      if (!birth) return null;
      if (!birth.month || birth.month > 12) return String(birth.year);
      const date = new Date(Date.UTC(birth.year, birth.month - 1, 15));
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
    }
    if (patternId === "street_address") return townOf(match);
    return null;
  }

  // The items that have a general form, for the choice that offers it.
  function generalForms(results, locale) {
    return results.flatMap((result) =>
      result.matches
        .map((match) => ({ id: result.id, general: generalForm(result.id, match, locale) }))
        .filter((item) => item.general),
    );
  }

  // Like redact(), but a detail with a general form is swapped for it; the rest is hidden as redact() hides it.
  function generalize(text, results, locale) {
    const label = (result) => `[REDACTED ${result.name.toUpperCase()}]`;
    const replacements = results
      .flatMap((result) =>
        // A cleaned link stays cleaned; anything else gets its general form, or its label when it has none.
        result.matches.map((match) => ({
          ...(result.replace
            ? cleaned(result, match, label(result))
            : { match, replacement: generalForm(result.id, match, locale) ?? label(result) }),
          whole: isSavedWord(result, match),
        })),
      )
      .sort((a, b) => b.match.length - a.match.length);
    return replaceBySpan(text, replacements);
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, generalForms, generalize };
})();
