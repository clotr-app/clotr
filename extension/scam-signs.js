// Finds the warning signs of a scam in a message someone got, for the "Is this a scam?" page. This is pure: no
// page, no storage, no browser call, so another host could carry it as is. I load it after patterns.js and
// reuse the engine's own labels (Clotr.askLabels) for the codes a scammer asks for, so the two word lists can't
// drift apart.
//   Clotr.scamSigns(text, { mine }) → [{ id, group, spans: [{ start, end }], kinds? }], in SCAM_SIGNS' order.
// A sign is just a place in the text plus a name, never the matched words themselves. `mine` is the person's
// own details that the page already found in the text; only their kinds come back, for "Mentions your own
// details". Every word list below covers English and Spanish side by side, since a message can be either.
(() => {
  "use strict";

  const { askLabels } = globalThis.Clotr;

  // The signs, grouped under the US FTC's four signs of a scam, plus one more for asking for a code or detail.
  const SCAM_SIGNS = [
    "asks_code",
    "asks_card_code",
    "asks_gift_card",
    "asks_remote",
    "asks_details",
    "asks_command",
    "pay_crypto",
    "pay_hard_to_undo",
    "pay_move_money",
    "press_rush",
    "press_secret",
    "press_threat",
    "press_stay",
    "pret_gov",
    "pret_bank",
    "pret_support",
    "pret_family",
    "pret_romance",
    "pret_knows_you",
    "prob_account",
    "prob_prize",
  ].map((id) => Object.freeze({ id, group: id.split("_")[0] }));

  // ---------- Building blocks ----------

  // Builds a whole-word, case-insensitive alternation. I use this instead of \b because \b doesn't treat
  // accented letters as letters.
  const words = (src) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${src})(?![\p{L}\p{N}])`, "giu");
  const all = (re, text) => [...text.matchAll(re)];
  const has = (re, text) => {
    re.lastIndex = 0;
    return re.test(text);
  };
  const span = (start, end) => ({ start, end });
  const spanOf = (m) => span(m.index, m.index + m[0].length);

  // Finds where each sentence starts and ends, splitting on a stop before a space or the end, or on a line break.
  function sentences(text) {
    const out = [];
    let start = 0;
    for (const m of text.matchAll(/[.!?…]+["'”’)]*(?=\s|$)|\n/g)) {
      const end = m.index + m[0].length;
      // A trailing-off "..." before a lowercase word, like "four five six digit... sorry, the six-digit
      // code", isn't really the end of a sentence.
      if (/^(?:\.{2,}|…)$/.test(m[0]) && /^\s+\p{Ll}/u.test(text.slice(end, end + 3))) continue;
      if (end > start) out.push(span(start, end));
      start = end;
    }
    if (start < text.length) out.push(span(start, text.length));
    return out;
  }
  const sentenceAt = (list, at) => list.find((s) => at >= s.start && at < s.end) || span(at, at);

  // A request said as a warning, like "we'll never ask for the code" or "nunca te pediremos", isn't really a
  // request. I decide this by the last matching negation word before the place in its sentence; a condition
  // like "if it wasn't you" or a word that turns the sentence, like "but", doesn't count as one.
  const NEGATION = words(
    String.raw`never|don'?t|dont|do\s+not|won'?t|will\s+not|wont|shouldn'?t|should\s+not|not|no\s+one|nobody|cannot|can'?t|isn'?t|if\s+(?:someone|anyone|somebody|anybody|they|a\s+caller|a\s+stranger)|anyone\s+who|someone\s+who|whoever|nunca|jam[aá]s|nadie|no|si\s+alguien|quien\s+te|cualquiera\s+que`,
  );
  const NOT_NEGATION = words(
    String.raw`if\s+(?:you|u|it|this|that)\s+(?:did\s*n'?t|did\s+not|don'?t|do\s+not|wasn'?t|was\s+not|weren'?t|haven'?t)|don'?t\s+(?:wait|delay|worry|hesitate|panic|hang\s+up)|do\s+not\s+(?:wait|delay|worry|hang\s+up)|si\s+no|para\s+no|no\s+cuelgues?|no\s+tarde|no\s+espere`,
  );
  const TURN = words(String.raw`but|however|instead|pero|sino`);
  function negated(text, sents, at) {
    const s = sentenceAt(sents, at);
    const before = text.slice(s.start, at);
    const keep = all(NOT_NEGATION, before).map(spanOf);
    const neg = all(NEGATION, before)
      .map(spanOf)
      .filter((n) => !keep.some((k) => n.start < k.end && k.start < n.end))
      .at(-1);
    if (!neg) return false;
    const after = before.slice(neg.end);
    return !has(TURN, after) && !after.includes(";");
  }

  // The words that make a request, in English and Spanish. A verb followed by "you", as in "we'll send you a
  // code", gives something to you rather than asking you for something, so it doesn't count as a request.
  const ASK = String.raw`tell|give|send|read(?:\s+out)?|share|forward|text|confirm|provide|reply|respond|answer|need|needs|want|ask(?:s|ed|ing)?\s+(?:you\s+|u\s+)?for|what(?:'s|\s+is|\s+are|\s+was)|whats|d[ií]game|d[ií]me|d[ií]nos|d[ií]ganos|dame|deme|danos|d[eé]nos|m[aá]ndame|m[aá]ndanos|m[aá]ndenos|m[aá]ndeme|manda|mande|env[ií]ame|env[ií]anos|env[ií]enos|env[ií]eme|env[ií]a|env[ií]e|reenv[ií]ame|reenv[ií]a|p[aá]same|pasa|pase|l[eé]eme|l[eé]ame|lee|lea|confirma|confirme|conf[ií]rmame|conf[ií]rmanos|conf[ií]rmeme|conf[ií]rmenos|ind[ií]canos|ind[ií]quenos|indique|facilita|facilite|facil[ií]tanos|facil[ií]tenos|comparte|comparta|responde|responda|contesta|conteste|necesito|necesitamos|necesita|cu[aá]l\s+es|cu[aá]les\s+son|(?:me|nos)\s+(?:dice|diga|da|d[eé]|manda|mande|env[ií]a|env[ií]e|pasa|pase|lee|lea|confirma|confirme)|ped(?:ir|imos|ir[aá]|ir[aá]n|iremos|irle|irte)|pid(?:e|a|o|en|an|i[oó]|ieron)`;
  // For a detail, being told to type it in somewhere counts as asking for it too.
  const ASK_MORE = String.raw`verify|validate|update|submit|enter|re-?enter|upload|(?:sign|log)\s*in\s+with|type\s+in|fill\s+in|verifica|verifique|actualiza|actualice|introduce|introduzca|escribe|escriba|rellena|rellene`;
  const ASK_CODE = words(ASK);
  const ASK_DETAIL = words(`${ASK}|${ASK_MORE}`);
  const GIVES_TO_YOU = /^\s+(?:you|u)(?![\p{L}])/iu;

  // Whether a real request sits just before this place in its sentence: the last ask word within 140
  // characters, as long as it isn't said as a warning.
  function askedBefore(text, sents, at, ask) {
    const s = sentenceAt(sents, at);
    const from = Math.max(s.start, at - 140);
    const before = text.slice(from, at);
    const cue = all(ask, before)
      .filter((m) => !GIVES_TO_YOU.test(before.slice(m.index + m[0].length)))
      .at(-1);
    return Boolean(cue) && !negated(text, sents, from + cue.index);
  }

  // ---------- It asks for a code or a detail ----------

  // A sign-in code is never 3 or 4 digits long, since those lengths belong to a card's security code or a PIN.
  const DIGITS = String.raw`(?:[5-9]|five|six|seven|eight|nine|cinco|seis|siete|ocho|nueve)`;
  const TO_YOU = String.raw`(?:\s+(?:to\s+)?(?:you|u|your\s+(?:phone|number|mobile|cell|email|e-?mail)))`;
  // Matches a code sent to you: the engine's own labels, plus the ways a message says it, like "the code we
  // just texted you" or "a code is coming to your phone".
  const CODE_SENT = new RegExp(
    [
      askLabels.login_code.source,
      String.raw`(?:${DIGITS}[\s-]*digit|sms|text|confirmation|google\s+voice|whatsapp)\s+(?:code|pin|passcode)`,
      String.raw`(?:code|passcode)\s+(?:that\s+)?(?:we|i|they|he|she|someone|it|the\s+bank)(?:'re|'ve|'ll|\s+are|\s+have|\s+will|\s+just|\s+already)*\s+(?:send(?:ing)?|text(?:ing)?|txt(?:ed)?|email(?:ing)?|sent|texted|emailed|messaged)${TO_YOU}?`,
      String.raw`(?:code|passcode)\s+(?:that\s+)?(?:was\s+|were\s+|is\s+being\s+|has\s+been\s+|will\s+be\s+|'s\s+)?(?:just\s+)?(?:sent|texted|txted|emailed|messaged)${TO_YOU}`,
      String.raw`(?:code|passcode)\s+(?:that\s+)?(?:you|u)\s+(?:just\s+)?(?:got|received|get|receive)`,
      String.raw`code\s+(?:that(?:'s|\s+is)?\s+|which\s+(?:is\s+)?)?(?:just\s+)?(?:came|arrived|is\s+coming|'s\s+coming|coming|about\s+to\s+come|going\s+to\s+come|will\s+come|went)\s+(?:in\s+)?(?:to\s+)?your\s+(?:phone|number|mobile|cell|email)`,
      String.raw`(?:sent|send|sending|texted|texting|text|txted|emailed|emailing)\s+(?:you\s+|u\s+)?(?:a|an|the|this|that|my|your)\s+(?:[\w-]+\s+){0,2}?(?:code|passcode)`,
      String.raw`code\s+(?:from|in)\s+(?:the|your|that)\s+(?:text|sms|message|email)`,
      String.raw`c[oó]digo\s+(?:de\s+(?:${DIGITS}\s+(?:cifras|d[ií]gitos)|confirmaci[oó]n|google\s+voice|whatsapp)|por\s+sms|del\s+sms)`,
      String.raw`c[oó]digo(?:\s+de\s+(?:verificaci[oó]n|acceso|confirmaci[oó]n|${DIGITS}\s+(?:cifras|d[ií]gitos)))?\s+que\s+(?:te|le|os|les)\s+(?:(?:acabamos|acaban|acaba|acabo)\s+de\s+|hemos\s+|han\s+|ha\s+|hayamos\s+|va\s+a\s+|vamos\s+a\s+|van\s+a\s+|estamos\s+)?(?:enviar|enviado|enviamos|enviaron|envi[oó]|enviando|mandar|mandado|mandamos|mandaron|mand[oó]|mandando|llegar|llegado|lleg[oó]|llega|llegar[aá])`,
      String.raw`c[oó]digo\s+que\s+(?:recibiste|recibi[oó]|has\s+recibido|ha\s+recibido)`,
      String.raw`(?:enviar|enviando|enviado|env[ií]o|mandar|mandando|mandado|mando|mandamos|enviamos|llegar|lleg[oó]|llega|llegar[aá])\s+(?:te\s+|le\s+)?(?:un|el|ese|este|tu|su)\s+c[oó]digo`,
      askLabels.recovery_codes.source,
    ].join("|"),
    "giu",
  );
  const CODE_LABEL = words(CODE_SENT.source);
  // What can come right before and right after a code's name, so the matched span covers the whole phrase, as
  // in "the 6-digit code we just texted you".
  const CODE_BEFORE = new RegExp(
    String.raw`(?:(?:the|a|an|that|this|your|ur|my|el|un|ese|este|tu|su)\s+)?(?:(?:${DIGITS}[\s-]*digits?|verification|one[- ]time|sms|text|confirmation|login|sign[- ]?in|google\s+voice|whatsapp|security)\s+)*$`,
    "iu",
  );
  const CODE_AFTER = new RegExp(
    String.raw`^(?:\s+(?:that\s+)?(?:we|i|they|the\s+bank)(?:'re|'ve|'ll|\s+are|\s+have|\s+will|\s+just)*\s+(?:sent|texted|txted|emailed|messaged|send|text|txt)(?![\p{L}])${TO_YOU}?|\s+(?:that\s+)?(?:was\s+|is\s+)?(?:just\s+)?(?:sent|texted|txted|emailed)${TO_YOU}|\s+(?:that\s+)?(?:you|u)\s+(?:just\s+)?(?:got|received)|\s+que\s+(?:te|le)\s+(?:(?:acabamos|acaba)\s+de\s+|hemos\s+|ha\s+)?(?:enviar|enviado|mandar|mandado|llegar|llegado|lleg[oó]))`,
    "iu",
  );
  function codeLabels(text) {
    return all(CODE_LABEL, text).map((m) => {
      const s = spanOf(m);
      s.start -= CODE_BEFORE.exec(text.slice(Math.max(0, s.start - 40), s.start))?.[0].length || 0;
      s.end += CODE_AFTER.exec(text.slice(s.end, s.end + 60))?.[0].length || 0;
      return s;
    });
  }
  // Catches a request for a code named just before it, like "read it back to me" or "tell me what it says".
  const ASK_IT = words(
    String.raw`(?:read|give|send|forward|text)\s+(?:it|that|them|this)(?:\s+back)?\s+(?:to\s+)?(?:me|us)|(?:read|give|send|forward|text)\s+(?:me|us)\s+(?:it|that|them)|send\s+it\s+back|read\s+it\s+back|tell\s+(?:me|us)\s+what\s+it\s+says|what\s+does\s+it\s+say|reply\s+with\s+it|d[ií]me\s+qu[eé]\s+(?:te\s+)?(?:dice|pone)|me\s+lo\s+(?:pasas|mandas|env[ií]as|reenv[ií]as|dices|lees|das)|l[eé]amelo|l[eé]emelo|d[ií]gamelo|d[ií]melo|m[aá]ndamelo|m[aá]ndemelo|p[aá]samelo|p[aá]semelo|env[ií]amelo|env[ií]emelo|reenv[ií]amelo|reenv[ií]emelo|d[eé]melo|d[aá]melo`,
  );

  function asksCode(text, sents, labels) {
    const out = labels.filter((l) => askedBefore(text, sents, l.start, ASK_CODE));
    for (const m of all(ASK_IT, text)) {
      const label = labels.filter((l) => l.end <= m.index && m.index - l.end < 200).at(-1);
      if (label && !negated(text, sents, m.index) && !out.includes(label)) out.push(label);
    }
    return out;
  }

  const CARD_LABEL = words(askLabels.card_code.source);
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  // Matches where a card's security code is named, like "the 3 numbers on the back of your card". The label
  // can reach into what follows it, so this trims the match back to its last real word.
  const cardLabels = (text) =>
    all(CARD_LABEL, text).map((m) => {
      const trimmed = m[0].replace(/[\s"':=#]+$/u, "");
      return span(m.index, m.index + trimmed.length);
    });
  // Skips a card code when it's really a gift card's numbers, or when it's a code that was sent to you.
  const asksCardCode = (text, sents, cards, codes, gifts) =>
    cards.filter(
      (s) =>
        !codes.some((c) => overlaps(c, s)) &&
        !gifts.some((g) => overlaps(g, s)) &&
        askedBefore(text, sents, s.start, ASK_DETAIL),
    );

  const GIFT = askLabels.gift_card.source;
  const NOT_THEM = String.raw`(?<!(?<![\p{L}])(?:i|we|they|he|she|i've|we've|i'll|we'll|did|should|shall|let's)\s+)`;
  const GIFT_ASKS = [
    // Buying several, or for an amount, as in "buy two gift cards" or "buy some Steam cards".
    new RegExp(
      String.raw`${NOT_THEM}(?<![\p{L}])(?:buy|purchase|get|pick\s+up|grab|compra|compre|comprar|c[oó]mprame|c[oó]mpreme|c[oó]mpranos|cons[ií]gueme|consigue|consiga)(?:\s+(?:me|us))?(?<amount>(?:\s+(?:some|several|a\s+few|more|\d+|two|three|four|five|six|seven|eight|nine|ten|unas|algunas|varias|dos|tres|cuatro|cinco|\$\s?[\d,.]+|€\s?[\d,.]+|[\d.,]+\s?€))*)(?:\s+(?:worth\s+of|in|of|en|de))?\s+(?:${GIFT})`,
      "giu",
    ),
    // Paying with them, as in "pay with Google Play gift cards" or "only takes gift cards".
    new RegExp(
      String.raw`(?<![\p{L}])(?:(?:pay|paid|payable|settle|cover)(?:\s+(?:it|this|them|me|us|today|now|only|the\s+\w+))*\s+(?:with|in|using|by)|(?:only\s+)?(?:takes|accepts)|(?:pag(?:ue|a|ar|arla|arlo|arlas)|abon(?:e|a))(?:\s+[\p{L}]+){0,2}?\s+(?:con|en))(?:\s+(?:\$\s?[\d,.]+|[\d.,]+\s?€)\s+(?:in|en))?(?:\s+[\w-]+){0,2}?\s+(?:${GIFT})`,
      "giu",
    ),
  ];
  // Sending the gift card's numbers, when the message is already about gift cards, as in "send me the numbers
  // on the back" or "call us back with the numbers".
  const GIFT_NUMBERS = words(
    String.raw`(?:send|text|read|give|tell|email|call(?:\s+\S+){0,4}?\s+with|take\s+a\s+(?:photo|picture)\s+of)\s+(?:(?:me|us)\s+)?(?:(?:the|those|their|its|a|some)\s+)?(?:(?:card|gift\s+card)\s+)?(?:numbers?|codes?|pins?|(?:photos?|pictures?|pics?)\s+of\s+(?:the\s+)?(?:backs?|codes?|cards?)|photo\s+of\s+the\s+back)|(?:m[aá]ndame|m[aá]ndanos|m[aá]ndenos|mandarme|mandarnos|env[ií]ame|env[ií]anos|env[ií]enos|enviarme|d[ií]game|dime|l[eé]ame|l[eé]eme|dame|deme|p[aá]same)\s+(?:(?:los|las|el|una|unas)\s+)?(?:n[uú]meros|c[oó]digos|pin|fotos?\s+de\s+(?:los\s+c[oó]digos|la\s+parte\s+de\s+atr[aá]s|atr[aá]s)|foto)`,
  );
  const GIFT_ANY = new RegExp(GIFT, "iu");
  function asksGiftCard(text, sents, codes) {
    const out = [];
    for (const re of GIFT_ASKS)
      for (const m of all(re, text)) {
        const plural = /s$/i.test(m[0]) || /\S/.test(m.groups?.amount || "") || re !== GIFT_ASKS[0];
        if (plural && !negated(text, sents, m.index)) out.push(spanOf(m));
      }
    if (GIFT_ANY.test(text))
      for (const m of all(GIFT_NUMBERS, text)) {
        const s = spanOf(m);
        if (!codes.some((c) => overlaps(c, s)) && !negated(text, sents, m.index)) out.push(s);
      }
    return out;
  }

  const REMOTE = `${askLabels.remote_code.source}|logmein|screenconnect|supremo|asistencia\\s+r[aá]pida|control\\s+remoto`;
  const DEVICE = String.raw`(?:your|ur|su|tu)\s+(?:computer|pc|laptop|mac|device|screen|machine|ordenador|computadora|equipo|port[aá]til)`;
  const REMOTE_ASKS = words(
    [
      String.raw`(?:install|download|open|run|get|launch|set\s+up|descarg(?:a|ue|ar)|instal(?:a|e|ar)|abr(?:e|a|ir)|baj(?:a|e|ar)|ejecut(?:a|e))\s+(?:the\s+|an?\s+|la\s+app\s+|el\s+programa\s+)?(?:app\s+)?(?:de\s+)?(?:${REMOTE})`,
      String.raw`(?:need|give|grant|allow|let)\s+(?:\S+\s+){0,3}?(?:remote\s+)?access\s+(?:to|into|on)\s+${DEVICE}`,
      String.raw`(?:let|allow)\s+(?:me|us|him|our\s+\w+|the\s+\w+)\s+(?:to\s+)?(?:connect|log\s*in|remote|get)\s+(?:in(?:to)?\s+|to\s+|on(?:to)?\s+)?${DEVICE}`,
      String.raw`connect(?:s|ing)?\s+remotely|remotely\s+connect`,
      String.raw`(?:i|we)\s+can\s+(?:get\s+into|access|connect\s+to|log\s*in(?:to)?|see)\s+${DEVICE}`,
      String.raw`(?:read|tell|give)\s+(?:me|us)\s+(?:the\s+)?(?:\S+\s+){0,2}?(?:number|code|id)\s+(?:on|that\s+appears\s+on|showing\s+on|from)\s+(?:your|the)\s+screen`,
      String.raw`(?:d[eé]nos|danos|deme|dame|(?:nos|me)\s+da)\s+acceso\s+(?:remoto\s+)?a\s+${DEVICE}`,
      String.raw`(?:deje|deja|permita|permite)\s+que\s+(?:nuestro\s+t[eé]cnico|nosotros|yo|el\s+t[eé]cnico)\s+(?:se\s+)?conect(?:e|emos)\s+(?:a|con)\s+${DEVICE}`,
      String.raw`(?:d[ií]game|dime|l[eé]ame|l[eé]eme)\s+el\s+(?:n[uú]mero|c[oó]digo)\s+que\s+aparece`,
    ].join("|"),
  );

  // A detail is someone's own number, login, or security answer, like "your Social Security number" or "your
  // card details". A wifi or door password doesn't count, since those are meant to be shared.
  const DETAIL = words(
    [
      String.raw`social\s+security\s+(?:number|no\.?|#)|ssn|date\s+of\s+birth|birth\s*date|dob`,
      String.raw`(?:full\s+)?(?:card|account|routing|bank\s+account|checking\s+account|savings\s+account|medicare|member)\s+(?:number|numbers|no\.?|#)`,
      String.raw`(?:your|ur|card'?s?|debit|atm|bank)\s+pin`,
      String.raw`(?:your|ur|email|e-?mail|bank|banking|online\s+banking|account)\s+password`,
      String.raw`(?:your|ur)\s+(?:(?:online\s+)?(?:banking\s+)?(?:login|username|user\s*name|credentials|log-?in(?:\s+details)?)|bank\s+account|details|identity|id|passport|driver'?s\s+licen[cs]e)`,
      String.raw`(?:bank(?:ing)?|online\s+banking)\s+(?:login|username|credentials)`,
      String.raw`(?:personal|bank(?:ing)?|account|billing|payment|card|financial|login|identity)\s+(?:details|info(?:rmation)?|data)`,
      String.raw`security\s+questions?|answer\s+to\s+your\s+security\s+question`,
      askLabels.security_answer.source,
      String.raw`n[uú]mero\s+de\s+(?:la\s+)?seguridad\s+social|dni|nie|pasaporte|fecha\s+de\s+nacimiento`,
      String.raw`n[uú]mero\s+(?:completo\s+)?de\s+(?:su|tu)\s+(?:tarjeta|cuenta)|(?:su|tu)\s+n[uú]mero\s+de\s+(?:tarjeta|cuenta)|n[uú]mero\s+de\s+cuenta`,
      String.raw`(?:su|tu|la)\s+(?:cuenta\s+bancaria|iban)|datos\s+(?:personales|bancarios|de\s+(?:su|tu|la)\s+tarjeta)|(?:sus|tus)\s+datos`,
      String.raw`(?:su|tu)\s+(?:usuario|contrase[ñn]a|clave|pin|identidad|tarjeta)|(?:la|su|tu)\s+contrase[ñn]a\s+de\s+(?:su|tu)\s+[\p{L}]+|(?:el|su|tu)\s+usuario\s+de\s+(?:su|tu)\s+[\p{L}]+`,
    ].join("|"),
  );
  const NOT_A_DETAIL =
    /^\s+(?:del?|de\s+la|for\s+the|to\s+the)\s+(?:wi-?fi|router|red|network)|^\s+(?:for|to)\s+the\s+(?:door|gate)/iu;
  function asksDetails(text, sents, cards) {
    return all(DETAIL, text)
      .map(spanOf)
      .filter(
        (s) =>
          !cards.some((c) => overlaps(c, s)) &&
          !/(?:wi-?fi|guest|door|gate|router|network)\s+$/iu.test(text.slice(Math.max(0, s.start - 12), s.start)) &&
          !NOT_A_DETAIL.test(text.slice(s.end, s.end + 20)) &&
          askedBefore(text, sents, s.start, ASK_DETAIL),
      );
  }

  // The paste-a-command trick needs both a Run box or terminal and an instruction to paste into it.
  const RUN_BOX = words(
    String.raw`(?:press|hold|hit)\s+(?:down\s+)?(?:the\s+)?(?:win(?:dows)?(?:\s+(?:logo\s+)?key)?|⊞)\s*(?:\+|and|plus)\s*r|win\s*\+\s*r|open\s+(?:the\s+)?(?:run\s+(?:box|dialog|window)|terminal|powershell|command\s+prompt|cmd)|(?:pulsa|presiona|pulse|presione)\s+(?:la\s+)?tecla\s+(?:de\s+)?windows\s*(?:\+|y)\s*r|abr(?:e|a)\s+(?:la\s+)?(?:ventana\s+)?(?:ejecutar|terminal|powershell|s[ií]mbolo\s+del\s+sistema)`,
  );
  const PASTE = words(String.raw`paste|ctrl\s*\+\s*v|cmd\s*\+\s*v|peg(?:a|ue|ar|alo|uelo)`);
  function asksCommand(text) {
    const box = all(RUN_BOX, text).map(spanOf);
    const paste = all(PASTE, text).map(spanOf);
    return box.length && paste.length ? [...box, ...paste] : [];
  }

  // ---------- It wants you to pay in a certain way ----------

  const NOT_I = String.raw`(?<!(?<![\p{L}])(?:i|we|they|he|she|i've|we've|i'd|i\s+just|yo)\s+)`;
  const WITHIN = String.raw`(?:[^.!?\n]|\.(?=\d)){0,60}?`;
  const CRYPTO = String.raw`bitcoin|btc|crypto(?:currency|currencies)?|usdt|tether|ethereum|eth|litecoin|wallet\s+address|cripto(?:moneda)?s?|(?:la|mi|su|tu|esta)\s+cartera`;
  const PAY_CRYPTO = [
    words(
      String.raw`(?:bitcoin|btc|crypto(?:currency)?)\s+(?:atm|machine|kiosk)|cajero\s+(?:de\s+)?(?:bitcoin|btc|cripto[\p{L}]*)`,
    ),
    new RegExp(
      String.raw`${NOT_I}(?<![\p{L}])(?:send|pay|deposit|transfer|put|move|convert|wire|(?:env[ií]|mand|pag|ingr[eé]s|deposit|transfier|cambi|pas|invi?ert|compr)[\p{L}]*)(?![\p{L}])${WITHIN}(?<![\p{L}])(?:${CRYPTO})(?![\p{L}])`,
      "giu",
    ),
  ];
  const ANY_CRYPTO = words(CRYPTO);
  // Catches a bare "deposit" plus an amount right after a sentence about a bitcoin app, since the money goes
  // wherever that sentence just said.
  const PAY_MONEY = new RegExp(
    String.raw`${NOT_I}(?<![\p{L}])(?:send|pay|deposit|transfer|put|move|convert|wire|invest)\s+(?:(?:at\s+least|all|your|my|the)\s+)*(?:\$\s?[\d,.]+|[\d.,]+\s?(?:€|dollars|euros)|savings|money|funds)`,
    "giu",
  );
  function payCrypto(text, sents) {
    const out = PAY_CRYPTO.flatMap((re) => all(re, text))
      .filter((m) => !negated(text, sents, m.index))
      .map(spanOf);
    const near = all(ANY_CRYPTO, text).map((m) => sents.findIndex((s) => m.index >= s.start && m.index < s.end));
    for (const m of all(PAY_MONEY, text)) {
      const at = sents.findIndex((s) => m.index >= s.start && m.index < s.end);
      if (near.some((k) => k === at || k === at - 1) && !negated(text, sents, m.index)) out.push(spanOf(m));
    }
    return out;
  }

  const HARD_TO_UNDO = [
    words(
      String.raw`wire(?:d)?\s+(?:it|them|me|us|the|this|that|money|funds)|wire\s+\$?\s?\d[\d,.]*|(?:by|via|through|with)\s+(?:a\s+)?(?:wire|bank)\s+transfer|wire\s+transfer|western\s+union|money\s?gram|gold\s+(?:bars?|coins?|bullion)`,
    ),
    words(String.raw`(?:zelle|venmo|cash\s*app)\s+(?:me|us|it|them|the\s+\w+|\$)`),
    new RegExp(
      String.raw`(?<!(?:lets|let|allows)\s+you\s+(?:to\s+)?)(?<![\p{L}])(?:send|pay|transfer)(?![\p{L}])${WITHIN}(?<![\p{L}])(?:by|via|through|with|on|using)\s+(?:zelle|venmo|cash\s*app|paypal(?:\s+friends)?)(?![\p{L}])`,
      "giu",
    ),
    words(
      String.raw`cash(?:[^!?\n]){0,80}?(?<![\p{L}])(?:courier|picks?\s+(?:it|them)\s+up|collect|mail\s+it|envelope|box)|(?:courier|man|someone|agent)(?:[^!?\n]){0,60}?(?<![\p{L}])(?:collect|pick\s+up)\s+(?:the\s+)?(?:cash|money)`,
    ),
    words(
      String.raw`(?:por|con|mediante|v[ií]a)\s+(?:una\s+)?transferencia|(?:haz|haga|hacer|hagas|me\s+haces)\s+(?:una\s+)?transferencia|(?:haz|haga|hacer|hacerme|me\s+(?:haces|hagas|puedes\s+hacer|podr[ií]as\s+hacer))\s+(?:un\s+)?bizum|(?:por|con|v[ií]a|mediante)\s+bizum|lingotes?\s+de\s+oro`,
    ),
    words(
      String.raw`efectivo(?:[^!?\n]){0,80}?(?<![\p{L}])(?:mensajero|agente|recoger[\p{L}]*|pasar[aá]|ir[aá]\s+a\s+su\s+casa|caja|sobre)|(?:mensajero|hombre)(?:[^!?\n]){0,60}?recoger\s+(?:el\s+)?efectivo`,
    ),
  ];
  const payHardToUndo = (text, sents) =>
    HARD_TO_UNDO.flatMap((re) => all(re, text))
      .filter((m) => !negated(text, sents, m.index))
      .map(spanOf);

  // Matches "moving money to protect it": a safety phrase and a verb that moves money, both in one sentence.
  const PROTECT = words(
    String.raw`to\s+protect\s+(?:it|them|your\s+(?:money|savings|funds|account))|for\s+safekeeping|(?:safe|secure|protected|safety)\s+(?:account|wallet)|keep\s+(?:it|your\s+money)\s+safe|para\s+proteger(?:lo|la|los|las)?|cuenta\s+(?:segura|protegida|de\s+seguridad)|para\s+que\s+est[eé]\s+a\s+salvo`,
  );
  const MOVE = words(
    String.raw`move|transfer|withdraw|send|deposit|put|convert|take\s+out|mueva|mueve|muevas|mover|transfier[\p{L}]*|transferir|pase|pasa|pasar|s[aá]que[\p{L}]*|saca|sacar|ingr[eé]se[\p{L}]*|ingresa|ingresar|env[ií][\p{L}]*|cambi[\p{L}]*`,
  );
  function payMoveMoney(text, sents) {
    const out = [];
    for (const p of all(PROTECT, text)) {
      const s = sentenceAt(sents, p.index);
      const move = all(MOVE, text.slice(s.start, s.end)).find((m) => !negated(text, sents, s.start + m.index));
      if (move && !negated(text, sents, p.index))
        out.push(span(s.start + move.index, s.start + move.index + move[0].length), spanOf(p));
    }
    return out;
  }

  // ---------- It pressures you ----------

  const RUSH = words(
    [
      String.raw`right\s+(?:away|now)|straight\s+away|immediately|immediatly|imediately|urgent(?:ly)?|asap|as\s+soon\s+as\s+possible|act\s+(?:now|fast|quickly|immediately)|hurry|final\s+(?:notice|warning)|last\s+chance|before\s+it'?s\s+too\s+late|before\s+it\s+expires|don'?t\s+(?:wait|delay)`,
      String.raw`(?:call|reply|respond|pay|click|tap|text|send|order|claim|confirm|verify|do\s+it)\s+now`,
      String.raw`(?<!(?<![\p{L}])(?:enter\s+it|use\s+it|valid|expires?|expiring)\s+)within\s+(?:the\s+)?(?:\d+|one|two|an?|the\s+next\s+\d+)\s*(?:minutes?|mins?|hours?|hrs?)|within\s+the\s+hour|in\s+the\s+next\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)`,
      String.raw`(?<!(?<![\p{L}])(?:expires?|expiring|valid|good|arrives?|there|ready|back|delayed|late|starts?|done|finished|about|be\s+home|home)\s+)in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)`,
      String.raw`(?:ends?|expires?|expire)\s+(?:at\s+midnight|tonight|today)|closes?\s+at\s+midnight|(?:ends?|closes?)\s+in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)`,
      String.raw`(?:by|before|until)\s+(?:\d{1,2}(?::\d\d)?\s*(?:am|pm)\s+)?(?:tonight|midnight|the\s+end\s+of\s+(?:the\s+)?day|end\s+of\s+day)|before\s+\d{1,2}(?::\d\d)?\s*(?:am|pm)`,
      String.raw`(?:responde|responda|contesta|conteste|llama|llame|paga|pague|haz|haga|act[uú]a|act[uú]e|env[ií]a|env[ií]e|confirma|confirme|hazlo)\s+(?:ya|ahora)|ahora\s+mismo|de\s+inmediato|inmediatamente|urgente(?:mente)?|cuanto\s+antes|lo\s+antes\s+posible|hoy\s+mismo|[uú]ltimo\s+aviso|date\s+prisa|d[eé]se\s+prisa`,
      String.raw`en\s+las?\s+pr[oó]xim[ao]s?\s+(?:\d+\s+)?(?:horas?|minutos?|hora)|antes\s+de\s+(?:\d+|una|1)\s+(?:horas?|minutos?|hora)|(?<!(?<![\p{L}])(?:caduca|caducan|vence|llegar[aá])\s+)en\s+\d+\s+(?:horas?|minutos?)`,
      String.raw`(?:termina|acaba)\s+(?:en\s+\d+\s+(?:horas?|hora|minutos?)|a\s+medianoche|esta\s+noche|hoy)|(?:caduca|caducan)\s+(?:a\s+medianoche|esta\s+noche|hoy)|(?:se\s+)?cierra[n]?\s+en\s+\d+\s+(?:horas?|hora|minutos?)|hasta\s+esta\s+noche|antes\s+de\s+esta\s+noche`,
    ].join("|"),
  );
  const SECRET = words(
    [
      String.raw`(?:don'?t|dont|do\s+not|never)\s+(?:tell|mention|talk\s+to|speak\s+to|discuss\s+(?:it|this)\s+with|say\s+anything\s+to)(?:\s+(?:this\s+call|it|this))?\s+(?:to\s+)?(?:anyone|anybody|your\s+[\p{L}]+|the\s+[\p{L}]+|my\s+[\p{L}]+|his\s+[\p{L}]+|her\s+[\p{L}]+|mom|mum|dad|grandpa|grandma|a\s+lawyer)(?:\s+(?:at|in)\s+the\s+[\p{L}]+)?`,
      String.raw`(?:can'?t|cannot|can\s+not)\s+tell\s+(?:mom|mum|dad|my\s+[\p{L}]+|anyone|your\s+[\p{L}]+)`,
      String.raw`(?:asked|ask)\s+(?:that\s+)?you\s+not\s+(?:to\s+)?tell\s+(?:the|his|her|your)\s+[\p{L}]+|not\s+tell\s+(?:his|her)\s+[\p{L}]+`,
      String.raw`keep\s+(?:this|it|that|our\s+[\p{L}]+)\s+(?:a\s+)?(?:secret|quiet|confidential|private|between\s+us|to\s+yourself)|(?:stay|must\s+stay|remain)\s+between\s+us|between\s+you\s+and\s+me|tell\s+no\s+one|tell\s+nobody`,
      String.raw`(?:this|it)\s+is\s+(?:a\s+)?(?:confidential|sealed|secret)(?:\s+case)?|(?:this|the)\s+case\s+is\s+confidential|sealed\s+case`,
      String.raw`if\s+(?:the\s+bank|they|anyone|someone|the\s+teller|your\s+[\p{L}]+)\s+asks?,?\s+(?:just\s+)?(?:say|tell\s+them)`,
      String.raw`they\s+(?:may|might)\s+be\s+in\s+on\s+it|(?:they're|they\s+are)\s+in\s+on\s+it|don'?t\s+trust\s+anyone`,
      String.raw`no\s+(?:se\s+lo\s+|le\s+|les\s+)?(?:dig(?:as|a)|cuent(?:es|e)|coment(?:es|e)|habl(?:es|e)|mencion(?:es|e))(?:\s+nada)?(?:\s+(?:a|al|con|de)\s+(?:nadie|esta\s+llamada|[\p{L}]+))?(?:\s+(?:de\s+la\s+oficina|en\s+el\s+banco))?|no\s+(?:se\s+lo\s+|le\s+)?puedo\s+(?:contar|decir)(?:\s+a\s+[\p{L}]+)?`,
      String.raw`(?:gu[aá]rd(?:alo|elo|a|e)|mant[eé]n(?:lo|gelo)?)\s+(?:en\s+)?secreto|(?:que\s+)?(?:quede|tiene\s+que\s+quedar|debe\s+quedar)\s+entre\s+nosotros|es\s+confidencial|pueden\s+estar\s+metidos|est[aá]n\s+metidos|si\s+(?:en\s+el\s+banco\s+)?(?:te|le)\s+preguntan,?\s+di(?:les|ga)?\s+que`,
    ].join("|"),
  );
  const THREAT = words(
    [
      String.raw`(?:avoid|prevent)\s+(?:being\s+)?(?:arrest(?:ed)?|arested)|warr?[ae]nt\s+(?:for\s+your\s+arrest|has\s+been\s+issued|was\s+issued|in\s+your\s+name)|(?:arrest|bench)\s+warr?[ae]nt|(?:you|you'll|you\s+will)\s+(?:be\s+)?(?:arrested|arested|deported|sued|jailed)|or\s+(?:be\s+)?(?:arrested|jailed|deported)|police\s+will\s+come|call\s+the\s+police|or\s+the\s+police|to\s+jail`,
      String.raw`lawsuit|sue\s+you|legal\s+action|criminal\s+charges|press\s+charges|court\s+summons|(?:be|get)\s+fined|a\s+fine\s+of|penalt(?:y|ies)|suspension|disconnection`,
      String.raw`(?:will|would|is\s+going\s+to|are\s+going\s+to)\s+be\s+(?:permanently\s+)?(?:closed|suspended|locked|frozen|terminated|deleted|cancell?ed|deactivated|disabled|shut\s+off|disconnected|cut\s+off|lost|seized|stopped|blocked)|(?:will|'ll)\s+(?:freeze|close|suspend|lock|delete|cancel|block|shut\s+off|cut\s+off|disconnect|stop)\s+(?:your|the)|(?:lose|losing)\s+(?:access|your\s+(?:account|benefits|money|home))|or\s+(?:else\s+)?i(?:'ll|\s+will)?\s+(?:share|send|post|publish|leak)|or\s+face\s+[\p{L}]+`,
      String.raw`(?:para\s+)?(?:no\s+ser|evitar\s+ser)\s+detenid[oa]|orden\s+de\s+(?:detenci[oó]n|arresto|captura)|(?:ser[aá]|ir[aá])\s+detenid[oa]|ir[aá]\s+a\s+la\s+c[aá]rcel|multa|sanci[oó]n|recargo|denuncia|acciones\s+legales|demanda|deportad[oa]|deportaci[oó]n|suspensi[oó]n`,
      String.raw`ser[aá]\s+(?:bloquead[ao]|cerrad[ao]|suspendid[ao]|cancelad[ao]|eliminad[ao]|borrad[ao])|quedar[aá]\s+bloquead[ao]|se\s+(?:borrar[aá]n|eliminar[aá]n|cancelar[aá])|(?:le|te)\s+(?:cortaremos|cortar[aá]n|bloquearemos|cerraremos|suspenderemos)|perder[aá]s?\s+(?:el\s+acceso|su\s+cuenta|tu\s+cuenta)|o\s+(?:los|las)\s+comparto`,
    ].join("|"),
  );
  const STAY = words(
    String.raw`(?:don'?t|do\s+not|dont)\s+hang\s+up|stay\s+on\s+the\s+(?:line|phone)|keep\s+(?:me|us|this\s+call)\s+on\s+the\s+(?:line|phone)|don'?t\s+end\s+(?:this|the)\s+call|remain\s+on\s+the\s+line|no\s+cuelgues?|(?:qu[eé]date|qu[eé]dese|mant[eé]ngase|mantente)\s+(?:en\s+(?:la\s+)?l[ií]nea|al\s+tel[eé]fono)`,
  );

  // ---------- It pretends to be someone you trust ----------

  const GOV = words(
    [
      String.raw`irs|internal\s+revenue(?:\s+service)?|social\s+security(?:\s+(?:administration|office|fraud\s+unit))?(?!\s+(?:number|no\b|#))|ssa|medicare(?:\s+benefits\s+office)?(?!\s+(?:number|card|id))|fbi|federal\s+bureau\s+of\s+investigation|fed(?:e)?ral\s+(?:agent|government|wallet)|dea|u\.?s\.?\s+marshals?(?:\s+service)?|sheriff'?s?\s+(?:office|department)|police\s+(?:department|officer)|this\s+is\s+the\s+police`,
      String.raw`(?:u\.?s\.?\s+)?customs(?:\s+(?:notice|office|department|agency|and\s+border(?:\s+protection)?)|\s*:)|immigration\s+(?:services|office)|uscis|department\s+of\s+(?:labor|justice|revenue|motor\s+vehicles|the\s+treasury|treasury)|dmv|(?:state\s+)?tax\s+(?:office|department|agency)|court\s+clerk|jury\s+duty\s+office|census\s+(?:office|bureau)|toll\s+authority|government(?:\s+(?:grant|agency|wallet))?`,
      String.raw`agencia\s+tributaria|hacienda|(?<!n[uú]mero\s+de\s+(?:la\s+)?)seguridad\s+social|polic[ií]a\s+(?:nacional|local|municipal)|guardia\s+civil|juzgado|tribunal|aduanas\s*:|tr[aá]fico|dgt|oficina\s+del\s+censo|ministerio|gobierno|ayuntamiento|inmigraci[oó]n`,
    ].join("|"),
  );
  const BANK = words(
    [
      String.raw`(?<!social\s+security\s+)(?:anti-?)?fraud\s+(?:dept\.?|department|team|unit|desk|prevention(?:\s+(?:team|department|unit))?|investigat(?:or|ions?)|specialist|alert|protection(?:\s+team)?|check)|fraud\s+prevention|(?:bank'?s?|card)\s+(?:security|fraud)\s+(?:team|department)|security\s+(?:team|department)\s+(?:at|of|from)\s+(?:your|the|[\p{L}]+)\s+(?:[\p{L}]+\s+)?bank|(?:bank|credit\s+union)\s+security(?:\s+team)?|this\s+is\s+(?:your|the)\s+bank|calling\s+from\s+(?:your|the)\s+bank`,
      String.raw`(?:equipo|departamento|[aá]rea|unidad|servicio)\s+(?:de\s+|anti)?fraude|antifraude|fraude\s*:|(?:departamento|equipo|servicio|[aá]rea)\s+de\s+seguridad\s+de\s+(?:su|tu|el|la)\s+(?:banco|caja)|seguridad\s+de\s+(?:banco|caja)\s+[\p{L}]+|(?:le\s+)?llamamos\s+de\s+(?:su|tu)\s+banco|(?:somos|soy)\s+(?:del|de)\s+(?:su|tu)\s+banco`,
    ].join("|"),
  );
  // Stretches the match to include the bank's own name, as in "the fraud team at Anytown Bank".
  const BANK_BEFORE = /(?:the|your|our|a|el|la|del|al)\s+$/iu;
  const BANK_AFTER =
    /^(?:\s+(?:at|of|from)\s+(?:your|the)\s+bank|\s+(?:at|of|from|de|del)\s+(?:[Tt]he\s+)?\p{Lu}[\p{L}'&]*(?:\s+\p{Lu}[\p{L}'&]*){0,3}|\s+de\s+(?:su|tu)\s+banco)/u;
  function bankSpans(text) {
    return all(BANK, text).map((m) => {
      const s = spanOf(m);
      s.start -= BANK_BEFORE.exec(text.slice(Math.max(0, s.start - 6), s.start))?.[0].length || 0;
      s.end += BANK_AFTER.exec(text.slice(s.end, s.end + 50))?.[0].length || 0;
      return s;
    });
  }

  const SUPPORT = words(
    String.raw`(?:microsoft|windows|apple|mac|pc|computer'?s?|tech(?:nical)?|it|antivirus|windows\s+defender|internet\s+provider'?s?)\s+(?:certified\s+)?(?:support|security|help\s*desk|technician|tech\s+support|technical\s+support)(?:\s+(?:team|center|centre|department|here))?|tech(?:nical)?\s+(?:support|department)|help\s*desk|support\s+team|(?:microsoft|apple)\s+(?:certified\s+)?technician|this\s+is\s+(?:microsoft|apple|windows)|soporte\s+t[eé]cnico|servicio\s+t[eé]cnico|t[eé]cnico\s+certificado\s+de\s+microsoft|equipo\s+de\s+seguridad\s+de\s+(?:apple|microsoft)|seguridad\s+de\s+(?:microsoft|apple|windows)|soporte\s+de\s+(?:microsoft|windows|apple)`,
  );
  const COMPUTER_PROBLEM = words(
    String.raw`virus(?:es)?|malware|spyware|trojan|hack(?:ed|ers?)|infected|compromised|(?:license|firewall|protection|warranty)\s+(?:has\s+)?(?:expired|is\s+over)|error\s+messages?|serious\s+error|(?:computer|pc|laptop|mac|device)\s+(?:has\s+been\s+locked|is\s+at\s+risk|at\s+risk)|virus\s+alert|suspicious\s+activity|infectad[oa]|hackead[oa]|pirateado|piratas|caducad[oa]|ha\s+caducado|error\s+grave|en\s+peligro|esp[ií]a`,
  );

  const KIN_START = new RegExp(
    String.raw`^[\s"'“(]*(?:(?:hi|hey|hello|hola|oye)[\s,]+)?(?:grandma|grandpa|grandmother|grandfather|nana|nan|granny|gran|mom|mum|mama|mommy|dad|daddy|papa|auntie|aunt|uncle|abuela|abuelo|abu|yaya|mam[aá]|mami|pap[aá]|t[ií]a|t[ií]o)(?![\p{L}])`,
    "iu",
  );
  const YOUR_KIN = words(
    String.raw`(?:your|ur|su|tu)\s+(?:grandson|granddaughter|grandchild|nephew|niece|son|daughter|niet[oa]|sobrin[oa]|hij[oa])`,
  );
  const TROUBLE = words(
    String.raw`trouble|arrested|in\s+jail|jail|accident|hospital|bail|lawyer|attorney|public\s+defender|stuck|stranded|stolen|locked\s+out|owe|crashed|lost\s+my\s+(?:phone|wallet)|phone\s+(?:broke|is\s+cracked|is\s+broken|died|fell)|(?:mine|it)\s+fell|being\s+held|new\s+number|changed\s+my\s+number|friend'?s\s+phone|en\s+un\s+l[ií]o|detenid[oa]|c[aá]rcel|accidente|fianza|abogad[oa]|tirad[oa]|se\s+me\s+rompi[oó]|perd[ií]\s+el\s+m[oó]vil|me\s+qued[eé]\s+sin|n[uú]mero\s+nuevo|nuevo\s+n[uú]mero|cambiado\s+de\s+n[uú]mero|debo\s+dinero|robaron|apuros`,
  );
  const MONEY = /\$\s?\d|\d\s?€|€\s?\d|(?<![\p{L}])(?:money|bail|dinero|fianza)(?![\p{L}])/iu;

  const NOT_MET = words(
    String.raw`(?:haven'?t|have\s+not|never)\s+met|we'?ve\s+never\s+met|(?:meet|see)\s+(?:you\s+)?in\s+person|(?:until|when|before)\s+we\s+(?:finally\s+)?meet|finally\s+(?:meet|be\s+together|see\s+you)|can'?t\s+(?:wait\s+to\s+)?meet|can'?t\s+meet|video\s+call|camera\s+is\s+broken|oil\s+rig|offshore|deployed|overseas|stationed|peacekeeping|military|(?:on|from)\s+(?:a|the)\s+ship|visa\s+to\s+come|come\s+meet\s+you|nunca\s+nos\s+hemos\s+visto|no\s+nos\s+conocemos(?:\s+en\s+persona)?|conocernos\s+en\s+persona|conocerte(?:\s+en\s+persona)?|(?:cuando|hasta\s+que)\s+(?:por\s+fin\s+)?nos\s+veamos|por\s+fin\s+nos\s+veamos|podemos\s+(?:vernos|hacer\s+videollamada)|videollamada|plataforma\s+petrolera|desplegad[oa]|en\s+el\s+extranjero|misi[oó]n\s+de\s+paz|en\s+persona`,
  );

  // ---------- It says there's a problem or a prize ----------

  const PROBLEM = words(
    [
      String.raw`(?:your|ur)\s+(?:[\p{L}-]+\s+){0,3}?(?:account|card|access|membership|subscription|package|parcel|delivery|order|item|payment|online\s+banking|mailbox|id|reservation)(?:\s+(?:has\s+been|is|was|is\s+being|has|got))?\s+(?:temporarily\s+)?(?:suspended|locked|blocked|frozen|limited|restricted|disabled|deactivated|compromised|on\s+hold|held|stopped|overdue|past\s+due|declined|failed|renewed|used|hacked|flagged)`,
      String.raw`could\s+not\s+be\s+delivered|couldn'?t\s+be\s+delivered|delivery\s+attempts?\s+failed|failed\s+delivery|(?:tried|attempted)\s+to\s+deliver|missed\s+(?:your\s+)?delivery|unpaid\s+(?:toll|shipping|customs|fees?|balance)|payment\s+(?:was\s+)?(?:declined|failed|didn'?t\s+go\s+through|unsuccessful)|(?:couldn'?t|could\s+not|unable\s+to|were\s+unable\s+to)\s+process\s+your\s+(?:[\p{L}]+\s+)?payment|(?:suspicious|unusual)\s+(?:activity|sign-?in|login|charge|transaction)|(?:someone|somebody)\s+tried\s+to\s+(?:sign|log)\s*in|unauthori[sz]ed\s+(?:access|charge|transaction)|if\s+you\s+did(?:\s+not|n'?t)\s+(?:make|place|authori[sz]e|request|recogni[sz]e)\s+(?:this|it|the)(?!\s+change)|problem\s+with\s+your\s+(?:account|order|payment|card|delivery)|(?:has|have)\s+been\s+charged|renewed\s+for\s+\$|for\s+nonpayment|non-?payment|overdue|past\s+due`,
      String.raw`(?:su|tu)\s+(?:[\p{L}-]+\s+){0,3}?(?:cuenta|tarjeta|acceso|suscripci[oó]n|paquete|pedido|env[ií]o|entrega|pago|almacenamiento)(?:\s+[\p{L}]+){0,3}?\s+(?:ha\s+sido|est[aá]|fue|se\s+ha|ha)\s+(?:temporalmente\s+)?(?:bloquead[ao]|suspendid[ao]|limitad[ao]|retenid[ao]|congelad[ao]|fallado|rechazad[ao]|renovad[ao]|en\s+peligro)`,
      String.raw`no\s+(?:pudo|se\s+pudo|pudimos)\s+(?:ser\s+)?(?:entregar|entregado|completar)|acceso\s+no\s+autorizado|actividad\s+sospechosa|intent[oó]\s+entrar\s+en\s+(?:su|tu)\s+cuenta|peaje\s+pendiente|impago|deuda\s+pendiente|saldo\s+pendiente|pago\s+(?:de\s+(?:su|tu)\s+[\p{L}]+\s+)?ha\s+fallado|problema\s+con\s+(?:su|tu)\s+(?:cuenta|pedido|pago)`,
    ].join("|"),
  );
  const PRIZE = words(
    String.raw`(?:you(?:'ve|\s+have)?|your\s+(?:[\p{L}]+\s+)?(?:wallet|email|number|phone))\s+(?:just\s+)?(?:won|been\s+(?:selected|chosen|picked))|(?:lucky\s+)?winners?|congratulations|congrats|prizes?|sweepstakes|lottery|jackpot|giveaway|lucky\s+draw|(?:relief|government|cash)\s+grant|(?:reward|refund)\s+waiting|free\s+(?:iphone|phone|cruise|vacation|gift|tv)|chosen\s+to\s+receive|selected\s+(?:as|for)|(?:has|ha|han)\s+(?:sido\s+)?(?:ganado|seleccionad[oa]|elegid[oa])|ganador(?:a)?|enhorabuena|felicidades|premios?|sorteo|loter[ií]a|concurso|(?:un|una)\s+[\p{L}]+\s+gratis`,
  );
  // Something to do right now is either a link, or a word that sends you somewhere or asks you to act.
  const DO_NOW = words(
    String.raw`click|tap|call|reply|text\s+back|respond|log\s*in|sign\s*in|verify|confirm|visit|update|pay|book|reschedule|fix|re-?enter|contact|claim|send|enter|deposit|wire|scan|responda|responde|pague|paga|llame|llama|haga\s+clic|pulse|entra|entre|confirme|confirma|actualice|actualiza|verifique|verifica|introduzca|introduce|env[ií]e|env[ií]a|cobrar|reclamar|canjear[\p{L}]*|escanee`,
  );
  const LINK =
    /https?:\/\/|www\.|(?<![\p{L}\p{N}@-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|invalid|info|co|io|us|gov|es)(?![\p{L}\p{N}])/iu;

  // ---------- All together ----------

  const spansOf = (re, text) => all(re, text).map(spanOf);

  // Sorts the spans, drops repeats, and merges any that overlap.
  function tidy(list) {
    const sorted = list.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    for (const s of sorted) {
      const last = out.at(-1);
      if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
      else out.push(span(s.start, s.end));
    }
    return out;
  }

  // Keeps only the page's own-detail matches that actually land inside this text.
  function mineIn(text, mine) {
    if (!Array.isArray(mine)) return [];
    return mine.filter(
      (m) =>
        m &&
        typeof m.kind === "string" &&
        Number.isInteger(m.start) &&
        Number.isInteger(m.end) &&
        m.start >= 0 &&
        m.end <= text.length &&
        m.end > m.start,
    );
  }

  function scamSigns(input, { mine } = {}) {
    if (typeof input !== "string" || !input.trim()) return [];
    // Swaps curly apostrophes for straight ones without changing the text's length, so every matched place
    // still lines up.
    const text = input.replace(/[’‘]/g, "'").replace(/\u00a0/g, " ");
    const sents = sentences(text);
    const codes = codeLabels(text);
    const found = new Map();
    const add = (id, list) => {
      if (list.length) found.set(id, tidy([...(found.get(id) || []), ...list]));
    };

    const cards = cardLabels(text);
    const gifts = asksGiftCard(text, sents, codes);
    add("asks_code", asksCode(text, sents, codes));
    add("asks_card_code", asksCardCode(text, sents, cards, codes, gifts));
    add("asks_gift_card", gifts);
    add(
      "asks_remote",
      all(REMOTE_ASKS, text)
        .filter((m) => !negated(text, sents, m.index))
        .map(spanOf),
    );
    add("asks_details", asksDetails(text, sents, cards));
    add("asks_command", asksCommand(text));
    add("pay_crypto", payCrypto(text, sents));
    add("pay_hard_to_undo", payHardToUndo(text, sents));
    add("pay_move_money", payMoveMoney(text, sents));
    add("press_rush", spansOf(RUSH, text));
    add("press_secret", spansOf(SECRET, text));
    add("press_threat", spansOf(THREAT, text));
    add("press_stay", spansOf(STAY, text));

    const asksOrPays = [...found.keys()].some((id) => id.startsWith("asks_") || id.startsWith("pay_"));
    const pays = [...found.keys()].some((id) => id.startsWith("pay_")) || found.has("asks_gift_card");
    // A bank's or the government's name only counts as a sign next to a request or a way to pay, since real
    // notices name them too.
    if (asksOrPays) add("pret_gov", spansOf(GOV, text));
    if (asksOrPays) add("pret_bank", bankSpans(text));
    // Tech support only counts as a sign alongside a computer problem, since real tech companies don't reach
    // out about one unprompted.
    const problem = spansOf(COMPUTER_PROBLEM, text);
    if (problem.length) add("pret_support", spansOf(SUPPORT, text));
    // A family-in-trouble pretext needs both who they are and what trouble they're in.
    const kin = [...(KIN_START.test(text) ? [spanOf(KIN_START.exec(text))] : []), ...spansOf(YOUR_KIN, text)];
    const trouble = spansOf(TROUBLE, text);
    if (kin.length && trouble.length && (asksOrPays || MONEY.test(text))) add("pret_family", [...kin, ...trouble]);
    // A romance pretext only counts once there's already a payment sign, since meeting-online phrases alone
    // aren't suspicious.
    if (pays) add("pret_romance", spansOf(NOT_MET, text));
    const own = mineIn(text, mine);
    if (own.length) {
      add(
        "pret_knows_you",
        own.map((m) => span(m.start, m.end)),
      );
      found.set("pret_knows_you:kinds", [...new Set(own.map((m) => m.kind))]);
    }
    // A problem or a prize only counts as a sign alongside something to do about it right now. I skip the
    // problem sign when the message already named the bank, the government, or tech support, so that
    // pretext doesn't get counted twice.
    const doNow = asksOrPays || has(DO_NOW, text) || LINK.test(text);
    if (doNow && !found.has("pret_bank") && !found.has("pret_gov") && !found.has("pret_support"))
      add("prob_account", spansOf(PROBLEM, text));
    if (doNow) add("prob_prize", spansOf(PRIZE, text));

    return SCAM_SIGNS.filter((s) => found.has(s.id)).map((s) => ({
      id: s.id,
      group: s.group,
      spans: found.get(s.id),
      ...(s.id === "pret_knows_you" ? { kinds: found.get("pret_knows_you:kinds") } : {}),
    }));
  }

  // Tells the page whether the message has a link in it, for the "don't use it to check" line.
  const scamHasLink = (text) => typeof text === "string" && LINK.test(text);

  globalThis.Clotr = { ...(globalThis.Clotr || {}), SCAM_SIGNS, scamSigns, scamHasLink };
})();
