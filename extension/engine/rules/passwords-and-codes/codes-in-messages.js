// Sign-in, card security, remote-access and door codes told in a message, and a login shared as a pair.
// scam-requests.js reuses these labels.
(() => {
  "use strict";

  const { UNIT_RE, isLetter, readTypo, lastItem, readNumberRuns, secretValue } = globalThis.ClotrInternal;

  // ---------- Logins and codes told in a message ----------

  // ── Logins and codes told in a message ──
  // "login: jdoe@gmail.com / Fluffy!23": a login shared as a pair.
  // The login word, the name, then "/" or "|" and the password. A "/" in the password means a path instead.
  const LOGIN_WORD = String.raw`\b(?:login|log-?in|sign[- ]?in|credentials|creds)\b`;
  const LOGIN_PAIR = new RegExp(
    String.raw`${LOGIN_WORD}[^\n]{0,20}?\s["'“‘]?[^\s/|"']{3,64}\s*[/|]\s*` +
      String.raw`["'“‘]?([^\s"'”’,;/]{4,64})(?![^\s"'”’,;])`,
    "gi",
  );
  // Codes that open a home, a card or a phone, as in "the gate code is 1234" or "the safe combination is
  // 12-34-56". Unrelated codes like a zip code or an error code stay quiet.
  const CODE_FOR = [
    String.raw`gate|alarm|garage|door|lock\s*box|locker|lock|keypad|safe|building|entry|house`,
    String.raw`atm|debit(?:\s+card)?|credit\s+card|card|phone|iphone|bank`,
  ].join("|");
  const CODE_LABEL = [
    String.raw`(?:${CODE_FOR})\s+(?:code|combination|combo|passcode|pin)`,
    String.raw`passcode|combination|pin(?=\s+(?:number|code|#))|my\s+pin`,
  ].join("|");
  // "to my storage unit", "for the shed"
  const TO_WHAT = String.raw`(?:\s+(?:to|for|on|of)\s+(?:my|the|our|his|her)\s+[\p{L}-]+)?`;
  // 3 to 10 digits, maybe with a "#", or a combination in groups: "12-34-56", "12 34 56".
  const DOOR_CODE = String.raw`(\d{3,10}#?|\d{1,3}(?:-\d{1,3}){2,3}|\d{1,2}(?: \d{1,2}){2,3})(?![\d-]| \d)`;
  const CODE_TOLD = new RegExp(
    String.raw`\b(?:${CODE_LABEL})(?:\s+(?:number|code))?${TO_WHAT}\s*(?:(?:is|was|:|=)\s*)?["'“‘]?${DOOR_CODE}`,
    "giu",
  );

  // ---------- Sign-in codes ----------

  // ── Sign-in codes, in English ──
  // Sign-in codes sent by text or email, as in "the verification code they texted me is 482913", which is
  // what a scam caller is after. Error codes, zip codes and a plain "sent the code" stay quiet.
  // The code itself is 4 to 8 digits, or two groups of 3 like WhatsApp's "482-913". It's never a year,
  // never part of a longer number, and never a size, so "my code is 3000 lines long" doesn't match.
  const SIGN_IN_DIGITS = String.raw`(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)`;
  const SIZE_WORDS = [
    "lines?|characters?|chars|bytes?|words?|pages?|rows?|times|errors?",
    "l[ií]neas|caracteres|palabras|p[aá]ginas|filas|veces|errores",
  ].join("|");
  const SIGN_IN_VALUE = String.raw`["'“‘]?(?<![\p{L}\d])${SIGN_IN_DIGITS}(?!\s+(?:${SIZE_WORDS})(?![\p{L}]))`;
  const IS = String.raw`\s*(?:(?:is|was)\s*)?(?:[:=,]\s*)?`;
  const IS_SAID = String.raw`\s*(?:(?:is|was)(?![\p{L}])\s*(?:[:=]\s*)?|[:=]\s*)`;
  // The words that mark a code as a sign-in code, and the apps whose codes scammers ask for most, as in
  // "G-482913 is your Google verification code".
  const SIGN_IN_WORD = String.raw`(?:${[
    String.raw`verification|one[- ]time|login|log-?in|sign[- ]?in|two[- ]factor`,
    String.raw`2fa|mfa|otp|authentication|auth|access|sms`,
  ].join("|")})`;
  const SIGN_IN_APP = String.raw`(?:${[
    String.raw`whats\s?app|telegram|signal|google|gmail|facebook|instagram|tiktok`,
    String.raw`snapchat|uber|lyft|paypal|venmo|zelle|cash\s?app|coinbase|microsoft`,
    String.raw`outlook|yahoo|netflix`,
  ].join("|")})`;
  const DIGITS_LONG = String.raw`(?:(?:\d|four|six|eight)[- ]digit\s+)?`;
  const SIGN_IN_NAME = String.raw`${DIGITS_LONG}(?:${SIGN_IN_APP}\s+)?(?:${SIGN_IN_WORD}\s+)?`;
  const SIGN_IN_NAMED = String.raw`${DIGITS_LONG}(?:${SIGN_IN_APP}\s+(?:${SIGN_IN_WORD}\s+)?|${SIGN_IN_WORD}\s+)`;
  // Rules out a code that isn't a sign-in code, named right before the word "code", as in "the tracking
  // code they sent me" or "asked for the zip code".
  const NOT_SIGN_IN = String.raw`(?<!(?<![\p{L}])(?:${[
    String.raw`error|zip|postal|area|status|exit|promo|promotional|discount|coupon`,
    String.raw`voucher|referral|invite|invitation|tracking|order|booking|reference`,
    String.raw`product|item|gift|source|dress|country|bar|qr|tax|billing|diagnosis`,
    String.raw`diagnostic|medical|course|class|style|colou?r|sku|post|cheat|redeem`,
    String.raw`redemption|rewards?`,
  ].join("|")})[\s-]+)`;
  // Who sent the code and how, as in "the code they texted me" or "the code that came to my phone".
  const SENDER = String.raw`(?:they|he|she|someone|it|you|the\s+bank|i|we)`;
  const SENT_VERB = String.raw`(?:texted|sent|messaged|emailed|gave|got|received|was\s+sent|were\s+sent)`;
  const ARRIVED = String.raw`(?:just\s+)?(?:came|arrived|was\s+sent|were\s+sent)`;
  const TO_ME = String.raw`(?:\s+(?:to\s+)?(?:me|us|him|her|you))?`;
  // "by text", "on my phone", "over WhatsApp"
  const BY_THE = String.raw`(?:by|via|in|on|over|through|to)\s+(?:(?:a|an|the|my|your|his|her|our)\s+)?`;
  const BY_WHAT = String.raw`(?:text(?:\s+message)?|sms|e-?mail|message|phone|cell(?:\s?phone)?|mobile|whats\s?app)`;
  const WHO_SENT = String.raw`(?:${SENDER}\s+(?:just\s+)?${SENT_VERB}|${ARRIVED})`;
  const BY_TEXT = String.raw`(?:\s+${BY_THE}${BY_WHAT})?`;
  const SENT_TO_ME = String.raw`(?:(?:that|which)\s+)?${WHO_SENT}${TO_ME}${BY_TEXT}`;
  // The value a rule with one group per way of saying it took.
  const matched = (match) => match.slice(1).find((group) => group !== undefined);
  // A code for a door or a gate isn't a sign-in code: "4821 is my code for the gate".
  const WHOSE = String.raw`(?:the|my|our|his|her|their|your)\s+`;
  const DOOR_OR_CARD = String.raw`(?:gate|door|alarm|garage|lock(?:box|er)?|safe|building|house|keypad|atm|card|phone)`;
  const NOT_FOR_A_DOOR = String.raw`(?!\s+(?:for|to|on|of)\s+${WHOSE}(?:front\s+|back\s+|garage\s+)?${DOOR_OR_CARD})`;
  // After a code is told without a name for it, the sentence either ends or says where the code came from,
  // as in "I got the code 482913 by text". Something like "I got the code 1500 from the tutorial" doesn't
  // match, since it doesn't end that way.
  const SENTENCE_END = String.raw`$|[\n.,;:!?)"'”’]`;
  const ENDING_WORDS = "by|via|in|on|over|and|but|so|what|which|is|was";
  const FROM_WHO = String.raw`from\s+(?:the\s+|my\s+)?(?:bank|${SIGN_IN_APP})`;
  const CODE_ENDS = String.raw`(?=\s*(?:${SENTENCE_END}|(?:${ENDING_WORDS}|${FROM_WHO})(?![\p{L}])))`;
  // After a code's name that comes second, the name ends there: "12345 is my code name" is something else.
  const AFTER_NAME_WORDS = [
    "they|he|she|someone|it|that|which|i|we|you",
    "from|for|to|by|via|in|on|and|but|so|sent|texted|just",
  ].join("|");
  const NAME_ENDS = String.raw`(?=\s*(?:${SENTENCE_END}|(?:${AFTER_NAME_WORDS})(?![\p{L}])))`;
  // A number named as something else isn't a code before its name: "error 4821 - that's the code", "port 8080".
  const NUMBER_OF_WORDS = "error|status|exit|code|port|line|page|room|step|version|model|order|ticket|case";
  const NOT_A_NUMBER_OF = String.raw`(?<!(?<![\p{L}])(?:${NUMBER_OF_WORDS})\s+)`;
  // The label: a sign-in code's own names, plus any phrase for a code someone sent, like "the code they
  // texted me".
  const LOGIN_CODE_WORDS = [
    String.raw`verification|one[- ]time|login|log-?in|sign[- ]?in|two[- ]factor`,
    "authentication|auth|access|sms",
  ].join("|");
  const LOGIN_NAMES = String.raw`(?:${LOGIN_CODE_WORDS})\s+(?:code|pin|passcode)|(?:otp|2fa|mfa)(?:\s+(?:code|pin))?`;
  const CODE_THEY_SENT = String.raw`${NOT_SIGN_IN}(?<![\p{L}])(?:pass)?code\s+${SENT_TO_ME}`;
  // The rest of the sentence names a door or a gate: "the code 4821 they gave you for the gate".
  const DOOR_WORDS = String.raw`gate|door|alarm|garage|lock\s*box|locker|safe|building|house|keypad`;
  const NOT_AT_A_DOOR = String.raw`(?![^\n.!?]{0,40}?(?<![\p{L}])(?:${DOOR_WORDS})(?![\p{L}]))`;
  // A closing quote right after a code that opened with the same kind of quote, as in "'482913' is my code".
  // The opening quote gets the same checks as a code with no quotes, so "port '8080' is my code" stays quiet.
  // The lookbehind runs only once a closing quote is found.
  const QUOTED = (open, close) =>
    String.raw`${close}(?<=(?<!\d[-./\s])${NOT_A_NUMBER_OF}${open}(?:\d{4,8}|\d{3}[\s-]\d{3})${close})`;
  const CLOSING_QUOTE = String.raw`(?:${QUOTED("'", "'")}|${QUOTED('"', '"')}|${QUOTED("‘", "’")}|${QUOTED("“", "”")})`;
  // The name that follows a code told before it: "is my verification code", "- that's the code they sent me".
  const THATS = String.raw`\s*(?:[,:–—-]\s*)?(?:is|was|that['’]?s|that\s+is|that\s+was|it['’]?s)\s+`;
  const CODE_NAME_AFTER = [
    String.raw`my\s+${SIGN_IN_NAME}(?:pass)?code`,
    String.raw`(?:the|your)\s+${SIGN_IN_NAMED}(?:pass)?code`,
    String.raw`the\s+(?:pass)?code\s+${SENT_TO_ME}`,
  ].join("|");
  const NAMED_AFTER = String.raw`${THATS}(?:${CODE_NAME_AFTER})(?![\p{L}])${NOT_FOR_A_DOOR}${NAME_ENDS}`;
  // Not a number right after "in", "since", "by" and the like: "the code expires in 3600 seconds".
  const LEAD_IN_WORDS = "in|since|by|from|of|until|before|after|at|to|about|around|every";
  const NOT_AFTER_LEAD_IN = String.raw`(?<!(?<![\p{L}])(?:${LEAD_IN_WORDS})\s+)`;
  // The code right after its label.
  const CODE_AFTER_LABEL = String.raw`["'“‘]?(?=\d)${NOT_AFTER_LEAD_IN}(?<![\p{L}\d])${SIGN_IN_DIGITS}`;
  const GAVE = String.raw`(?:texted|sent|messaged|emailed|gave)`;
  const TEXTED_ME_THE = String.raw`${GAVE}\s+(?:me|us|him|her)\s+(?:(?:the|a|that|this|my)\s+)?`;
  const ASKED_FOR_THE = String.raw`ask(?:ed|ing|s)?\s+(?:me\s+)?for\s+(?:the|my|a|that)\s+`;
  const TEXT_KINDS = String.raw`(?:text(?:\s+message)?|sms|e-?mail|message|texts)`;
  const IN_THE_TEXT = String.raw`(?:in|from|on)\s+(?:the|that|this|my|your|their|a|an)\s+${TEXT_KINDS}`;
  // A lookbehind that walks back over spaces runs only after a lookahead finds the code or the digit it guards,
  // so a long run of blank lines costs linear time in a plain backtracking engine.
  const LOGIN_CODE = new RegExp(
    // "verification code: 482913", "OTP 482913"
    String.raw`(?<![\p{L}\d])(?:${LOGIN_NAMES})(?![\p{L}])[^\n\d]{0,30}?(?:\b(?:is|was)\b)?\s*(?:[:=]\s*)?` +
      String.raw`${CODE_AFTER_LABEL}` +
      // "they texted me the code 482913", "asked me for the code: 482913"
      String.raw`|(?<![\p{L}])(?:${TEXTED_ME_THE}|${ASKED_FOR_THE})(?:\p{L}+\s+)?${NOT_SIGN_IN}code` +
      String.raw`\s*(?:(?:is|was)\s*)?(?:[:=]\s*)?${CODE_AFTER_LABEL}` +
      // "the code they texted me is 482913", "the passcode I got by text: 482913"
      String.raw`|(?=(?:pass)?code)${CODE_THEY_SENT}${IS}${SIGN_IN_VALUE}` +
      // "enter the code 482913 we texted you", "the verification code 482913 they sent you by text"
      String.raw`|(?<![\p{L}])(?:the|this|that|a)\s+(?:${SIGN_IN_WORD}\s+)?(?:pass)?code\s+${SIGN_IN_VALUE}` +
      String.raw`${NOT_AT_A_DOOR}\s+${SENT_TO_ME}` +
      // "the code from the text is 482913", "the code in the email: 482913"
      String.raw`|(?=(?:pass)?code)${NOT_SIGN_IN}(?<![\p{L}])(?:pass)?code\s+${IN_THE_TEXT}` +
      String.raw`\s*(?:(?:is|was|says|said|reads)\s*)?(?:[:=,]\s*)?${SIGN_IN_VALUE}` +
      // "I got a text with the code 482913", "I received a code 482913", "my code is 482913", "Your WhatsApp code:
      // 482-913"
      String.raw`|(?<![\p{L}])(?:(?:text|sms|message|e-?mail)\s+with|got|received|get|getting)\s+` +
      String.raw`(?:a|an|the|this|that|my)\s+(?:new\s+)?${SIGN_IN_NAME}(?:pass)?code${IS}${SIGN_IN_VALUE}${CODE_ENDS}` +
      String.raw`|(?<![\p{L}])(?:my\s+(?:pass)?code|${SIGN_IN_APP}\s+(?:${SIGN_IN_WORD}\s+)?(?:pass)?code)` +
      String.raw`${IS_SAID}${SIGN_IN_VALUE}` +
      // The code before its name: "texted me 482913 as a verification code", "482913 is my code", "482913 - that's the
      // code they sent me", "G-482913 is your Google verification code"
      String.raw`|(?<![\p{L}])(?:texted|sent|messaged|emailed|gave|got|received)\s+(?:(?:me|us)\s+)?${SIGN_IN_VALUE}` +
      String.raw`\s+as\s+(?:a|an|the|my|our|your)\s+${SIGN_IN_NAME}(?:pass)?code` +
      String.raw`(?![\p{L}])${NOT_FOR_A_DOOR}${NAME_ENDS}` +
      String.raw`|(?=["'“‘]?\d)(?<!\d[-./\s])${NOT_A_NUMBER_OF}${SIGN_IN_VALUE}` +
      String.raw`(?:${CLOSING_QUOTE}(?=${NAMED_AFTER})|${NAMED_AFTER})`,
    "giu",
  );

  // ── A second code beside a sign-in code ──
  // A second code in the same sentence as a login code, typed the same way, as in "the old one was 561902 but the
  // new login code: 447215". It needs its own reason to be a code: a code word or a code-like word right before it
  // ("code", "the one was", "now it's", "or", "send"). A place in a list is no reason, since "482913, 551234 and
  // 640318 are the invoice numbers" lists plain numbers after a code. A plain label and a colon, like "customer:
  // 551234" or "price: 1250", is no reason either, so those stay quiet. It has to end like a code too, so "the price
  // is 1250" or "551234 is my zip" stays quiet. A number named as something else, like "order 551234", "room 4829"
  // or one after a currency sign, stays quiet.
  const OTHER_CODE_BODY = String.raw`(?<![\p{L}\d]|\d[-./\s])${SIGN_IN_DIGITS}`;
  const CODE_END_WORDS = "and|or|but|so|then|when|now|instead|too|also|by|via";
  const OTHER_CODE_END = String.raw`(?=["'”’]?\s*(?:$|[\n.,;:!?)]|(?:${CODE_END_WORDS})(?![\p{L}])))`;
  const CODE_LEAD_IN = [
    String.raw`code|(?:code|one|that|this)\s+(?:is|was)|now,?\s+it(?:['’]?s|\s+is)`,
    "or|and|then|maybe|now|send|sent|enter|type|try|use",
  ].join("|");
  const OTHER_CODE = new RegExp(
    String.raw`(?<=(?<![\p{L}])(?:${CODE_LEAD_IN})\s*[:=,]?\s*["'“‘]?)` + OTHER_CODE_BODY + OTHER_CODE_END,
    "giu",
  );
  // Words that name a number as something else, read in the three words before it.
  const NAMED_NUMBER = new RegExp(
    String.raw`(?<![\p{L}])(?:${[
      String.raw`order|tracking|ticket|case|room|invoice|account|acct|number|no|zip`,
      String.raw`postal|area|phone|call|ext|extension|port|error|status|exit|version`,
      String.raw`model|item|product|sku|ref|reference|booking|confirmation|reservation`,
      String.raw`flight|seat|gate|door|apt|apartment|unit|suite|page|line|step|id|serial`,
      String.raw`promo|coupon|gift`,
    ].join("|")})(?![\p{L}])[^\p{L}\d]*(?:\p{L}+['’]?\p{L}*[^\p{L}\d]+){0,2}["'“‘]?$|[$€£¥₹#+]\s*["'“‘]?$`,
    "iu",
  );
  // After "and", "or", "then" or "send", a number counts as a code only when nothing but more numbers joined by a
  // comma, "and" or "or" follows it, up to the end of the sentence or to the found code's name ("send 318274, my").
  // So "482913 and 551234 too, for the parking" and "send 2500 by Friday" stay quiet. After any word, numbers named
  // right after, as in "551234 and 640318 are the order numbers", stay quiet.
  const JOINED = /(?<![\p{L}])(?:and|or|then|send)\s*[:=,]?\s*["'“‘]?$/iu;
  // A space inside a number counts only before another digit or dash, so the spaces before a comma are read one
  // way and a long run of short numbers stays fast.
  const MORE_NUMBERS = String.raw`(?:\s*(?:[,;/&]|and|or)\s*["'“‘]?\d[\d-]*(?:\s+[\d-]+)*)*["'”’]?\s*`;
  const ONLY_NUMBERS_AFTER = new RegExp(String.raw`^${MORE_NUMBERS}[,;:]?\s*(?:my|the|your|our)?\s*$`, "iu");
  const NAMED_AFTER_LIST = new RegExp(
    String.raw`^${MORE_NUMBERS}(?:are|were|is|was)\s+(?![^.!?\n]*(?:code|pin|otp))`,
    "iu",
  );
  // The same shape: as many digits, grouped the same way.
  const codeShape = (code) => code.replace(/\d/g, "0").replace(/\s/g, " ");

  // Other codes in the sentence around a login code found at [start, end), at most 80 characters away.
  function otherCodes(text, start, end, code) {
    const from = Math.max(0, start - 80);
    const before = text.slice(from, start);
    const stop = before.search(/[\n.!?][^\n.!?]*$/);
    const left = stop < 0 ? from : from + stop + 1;
    const after = text.slice(end, end + 80).search(/[\n.!?]/);
    const right = after < 0 ? Math.min(text.length, end + 80) : end + after;
    const sentence = text.slice(left, right);
    const codes = [];
    for (const match of sentence.matchAll(OTHER_CODE)) {
      const other = match[1];
      const at = left + match.index;
      if (other === code || codeShape(other) !== codeShape(code)) continue;
      if (NAMED_NUMBER.test(text.slice(Math.max(left, at - 40), at))) continue;
      const rest = text.slice(at + other.length, right);
      if (NAMED_AFTER_LIST.test(rest)) continue;
      // Before the login code, the words after it run up to the code's own name, as in "send 318274, my".
      const words = at < start ? text.slice(at + other.length, start) : rest;
      if (JOINED.test(text.slice(Math.max(left, at - 12), at)) && !ONLY_NUMBERS_AFTER.test(words)) continue;
      codes.push(other);
    }
    return codes;
  }

  // ── Sign-in codes, in Spanish ──
  // Spanish, matching the same kinds of phrases: "el código de verificación es 482913", "me mandaron un
  // código por SMS: 552019", and the code coming before its name, as in "482913 es mi código".
  const ES_SENT = String.raw`(?:${[
    String.raw`(?:mand|envi|pas)(?:aron|[oó]|aste)|dieron|di[oó]|pidieron|pidi[oó]|lleg[oó]`,
    String.raw`(?:ha|han)\s+(?:mandado|enviado|pasado|dado|pedido|llegado)`,
    String.raw`acaban?\s+de\s+(?:mandar|enviar|pasar|llegar)|est[aá]n?\s+pidiendo|piden|pide`,
  ].join("|")})`;
  const ES_OF_WHAT = String.raw`verificaci[oó]n|acceso|un\s+solo\s+uso|inicio\s+de\s+sesi[oó]n`;
  const ES_SIGN_IN = String.raw`(?:de\s+(?:${ES_OF_WHAT})|sms|otp|din[aá]mica)`;
  // What can follow the code's name, like "de un solo uso" or "por SMS", while ruling out words that mark
  // it as a different kind of code, like "de seguimiento" or "de la puerta".
  const ES_NOT_SIGN_IN = String.raw`(?:${[
    String.raw`puerta|portal|alarma|garaje|edificio|casa|caja|cajero|tarjeta`,
    String.raw`seguimiento|descuento|promoci[oó]n|cup[oó]n|pedido|reserva|producto`,
    String.raw`referencia|error|regalo|canje|barras|[aá]rea|fuente|cliente|la|el|los|las|un|una`,
  ].join("|")})`;
  // "de la tienda", "por correo", but not "de la puerta".
  const ES_THE = String.raw`(?:(?:la|el|mi|tu|su)\s+)?`;
  const ES_OTHER = String.raw`(?:de|del|por|para|al|en)\s+${ES_THE}(?!${ES_NOT_SIGN_IN}(?![\p{L}]))\p{L}+`;
  const ES_MORE = String.raw`(?:sms|otp|de\s+un\s+solo\s+uso|de\s+(?:\d|cuatro|seis|ocho)\s+d[ií]gitos|${ES_OTHER})`;
  const ES_MORE_2 = String.raw`(?:\s+${ES_MORE}){0,2}`;
  // Not a number right after "en", "desde", "hasta" and the like.
  const ES_LEAD_IN_WORDS = String.raw`en|desde|hasta|de|del|a|al|antes|despu[eé]s|por|para|cada`;
  const ES_VALUE =
    String.raw`\s*(?:(?:es|era)(?![\p{L}])\s*)?(?::\s*)?["'“‘]?` +
    String.raw`(?<!(?<![\p{L}])(?:${ES_LEAD_IN_WORDS})\s+)${SIGN_IN_VALUE}`;
  const ES_THAT_SENT = String.raw`que\s+(?:me|nos)\s+${ES_SENT}(?:\s+(?:el|la|mi)\s+\p{L}+)?`;
  // The label, as for English: the code's names, and a code someone sent.
  const LOGIN_LABEL_ES =
    // "el código de verificación (que me llegó) es …", "clave de acceso de un solo uso …", "la contraseña de un solo
    // uso"
    String.raw`(?:(?:c[oó]digo|clave|pin)\s+${ES_SIGN_IN}` +
    String.raw`|contrase(?:ñ|n)a\s+(?:de\s+un\s+solo\s+uso|sms|otp|din[aá]mica))` +
    String.raw`(?![\p{L}])${ES_MORE_2}(?:\s+${ES_THAT_SENT})?${ES_MORE_2}` +
    // "el código (de WhatsApp) que me llegó (por SMS) es …"
    String.raw`|c[oó]digo${ES_MORE_2}\s+${ES_THAT_SENT}${ES_MORE_2}` +
    // "me mandó un código por SMS: …", "me están pidiendo el código …", "un SMS con el código …"
    String.raw`|(?:(?:me|nos)\s+${ES_SENT}|pidieron|piden|(?:sms|mensaje|correo|e-?mail|texto|whats\s?app)\s+con)` +
    String.raw`\s+(?:el|un|mi|ese|este|su)\s+c[oó]digo${ES_MORE_2}` +
    // "el código del SMS es …", "el código de WhatsApp: …"
    String.raw`|c[oó]digo\s+(?:del\s+(?:sms|mensaje(?:\s+de\s+texto)?|correo|e-?mail|texto)|de\s+${SIGN_IN_APP})`;
  const LOGIN_CODE_ES = new RegExp(
    // …and "mi código es …"
    String.raw`(?<![\p{L}\d])(?:${LOGIN_LABEL_ES}|mi\s+c[oó]digo(?=\s*(?:(?:es|era)(?![\p{L}])|:)))` +
      String.raw`(?![\p{L}])${ES_VALUE}` +
      // The code before its name: "482913 es mi código", "482913 es el código que me mandaron", "me mandaron 482913
      // como código de verificación"
      String.raw`|(?<!\d[-./\s])${SIGN_IN_VALUE}\s*(?:,\s*)?(?:es|era)\s+` +
      // "mi código", but not "mi código postal"
      String.raw`(?:mi\s+c[oó]digo(?:\s+${ES_SIGN_IN})?(?![\p{L}])(?!\s+(?:postal|de|del|para|fuente|en)(?![\p{L}]))` +
      String.raw`|el\s+c[oó]digo\s+(?:${ES_SIGN_IN}|que\s+(?:me|nos)\s+${ES_SENT})(?![\p{L}]))` +
      String.raw`|(?<![\p{L}])(?:me|nos)\s+${ES_SENT}\s+${SIGN_IN_VALUE}` +
      String.raw`\s+como\s+(?:c[oó]digo|clave)(?:\s+${ES_SIGN_IN})?(?![\p{L}])`,
    "giu",
  );

  // ---------- Card security and remote-access codes ----------

  // ── Card security codes ──
  // A card's security code, said the way people say it, or a remote-access code like "the AnyDesk code is
  // 123 456 789" from a fake support call. This covers both the code's own names, like "CVV", and how a
  // scam caller describes where it sits, like "the 3 numbers on the back". It's just the label; cardCodeAt()
  // below reads the actual code after it. "CSC" and "CV2" only count before "is" or a colon, since alone
  // they're also a course code and a code library, and "the numbers on the back" only counts for a card.
  const CARD_KIND = String.raw`(?:(?:credit|debit|bank)\s+)?`;
  const WHOSE_CARD = String.raw`(?:the|my|your|his|her|their|our|this|that|a)\s+`;
  const OF_THE_CARD = String.raw`\s+(?:side\s+)?of\s+${WHOSE_CARD}${CARD_KIND}(?:card|amex|visa|mastercard)`;
  const DE_LA_TARJETA = String.raw`\s+de\s+(?:la|mi|tu|su|esta|esa)\s+tarjeta(?:\s+de\s+(?:cr[eé]dito|d[eé]bito))?`;
  const ON_A_CARD = String.raw`(?:${OF_THE_CARD}|${DE_LA_TARJETA})?`;
  const SOMEONES_CARD = String.raw`(?:the|my|your|his|her|their|our)\s+${CARD_KIND}card`;
  const ON_BACK = String.raw`(?:(?:on|at|from|in)\s+(?:the\s+)?(?:back|reverse)(?:\s+side)?|behind\s+${SOMEONES_CARD})`;
  const ON_FRONT = String.raw`(?:on|at|from|in)\s+(?:the\s+)?front(?:\s+side)?`;
  const QUE_ESTAN = String.raw`(?:que\s+(?:est[aá]n?|vienen?|salen?|hay)\s+)?`;
  const DETRAS = String.raw`(?:${[
    String.raw`${QUE_ESTAN}(?:(?:de|en|por|a)\s+)?(?:la\s+parte\s+(?:de\s+)?)?(?:atr[aá]s|detr[aá]s)`,
    String.raw`(?:de|en)\s+la\s+parte\s+trasera`,
    String.raw`(?:del|en\s+el|al|por\s+el)\s+(?:reverso|dorso)`,
  ].join("|")})`;
  const DELANTE = String.raw`(?:${[
    String.raw`(?:de|en|por)\s+(?:la\s+parte\s+(?:de\s+)?)?(?:delante|adelante|delantera)`,
    String.raw`(?:del|en\s+el|al)\s+frente`,
  ].join("|")})`;
  const THE = String.raw`(?:the|my|your|his|her|their|our|those|these)\s+`;
  const NUMBERS = String.raw`(?:numbers?|digits?|nums?|numerals?|code)`;
  const LOS = String.raw`(?:los|las|mis|tus|sus|el|mi|tu|su)\s+`;
  const NUMEROS = String.raw`(?:n[uú]meros?|d[ií]gitos?|numeritos|c[oó]digo)`;
  // "CSC" and "CV2" only before "is" or a colon.
  const CSC_TOLD = String.raw`(?:csc|cv2)(?=\s*(?:code\s*|number\s*)?(?:is|was|:|=))`;
  const THREE_OR_FOUR = String.raw`(?:3|three|4|four)[\s-]+(?:digit\s+)?`;
  const TRES_O_CUATRO = String.raw`(?:3|tres|4|cuatro)\s+`;
  const CARD_LABEL =
    String.raw`(?:` +
    // its names, and where it is: "the CVV on the back of my card", "el código de seguridad de atrás"
    String.raw`(?:cvv2?|cvc2?|ccv|${CSC_TOLD}|card\s+verification\s+(?:value|code|number)` +
    String.raw`|security\s+code|c[oó]digo\s+de\s+seguridad)` +
    String.raw`(?:\s+(?:code|number|c[oó]digo|n[uú]mero))?(?:\s+(?:${ON_BACK}|${DETRAS}))?${ON_A_CARD}` +
    // "the (last) 3 numbers on the back (of my card)", "3 digit code on the back", and an Amex's 4 on the front
    String.raw`|(?:${THE}(?:last\s+)?(?:${THREE_OR_FOUR})?|${THREE_OR_FOUR})${NUMBERS}\s+${ON_BACK}${ON_A_CARD}` +
    String.raw`|(?:${THE})?(?:4|four)[\s-]+(?:digit\s+)?${NUMBERS}\s+${ON_FRONT}${ON_A_CARD}` +
    // "(on) the back of my card (it) says"
    String.raw`|(?:on\s+)?(?:the\s+)?(?:back|reverse)(?:\s+side)?\s+of\s+${SOMEONES_CARD}(?:,?\s+it)?` +
    // Spanish: "los 3 números de atrás (de la tarjeta)", "los 4 números del frente", "la parte de atrás de mi tarjeta"
    String.raw`|(?:${LOS}(?:${TRES_O_CUATRO})?(?:[uú]ltimos\s+)?|${TRES_O_CUATRO})${NUMEROS}\s+${DETRAS}${ON_A_CARD}` +
    String.raw`|(?:${LOS})?(?:4|cuatro)\s+${NUMEROS}\s+${DELANTE}${ON_A_CARD}` +
    String.raw`|(?:la\s+parte\s+(?:de\s+)?(?:atr[aá]s|detr[aá]s)|la\s+parte\s+trasera|el\s+reverso|el\s+dorso)` +
    String.raw`\s+de\s+(?:la|mi|tu|su)\s+tarjeta` +
    String.raw`)`;
  const CARD_IS_WORDS = "is|are|was|were|reads|says|shows|es|son|era|eran|dice|dicen|pone|ponen";
  const CARD_IS = String.raw`(?:(?:${CARD_IS_WORDS})(?![\p{L}])|[:=#])?`;
  const CARD_CODE = new RegExp(String.raw`(?<![\p{L}\d])${CARD_LABEL}["']?\s*${CARD_IS}\s*["']?`, "giu");
  // Reads the code right after that label, however it's typed: plain digits, spaced-out digits, or spelled
  // out like "four eight two". It has to be three or four digits that end there, so "12/27" reads as an
  // expiry date and "4111 1111 …" as a card number, not a security code. A phrase like "3 or 4 digits" is
  // describing a code rather than giving one, and digits running into letters belong to a longer code.
  const CODE_DIGITS = /^(?:\d{3,4}|\d(?: \d){2,3})(?![\d/\p{L}-]|[^\S\n]+\d)/u;
  const CODE_GAP = /^(?:[^\S\n]|[,-]){0,3}$/;
  const CODE_SIZE =
    /^[^\S\n]*(?:digits?|numbers?|characters?|long|d[ií]gitos?|n[uú]meros?|cifras?|caracteres)(?![\p{L}])/iu;
  function cardCodeAt(text, at) {
    const rest = text.slice(at, at + 60);
    let end = CODE_DIGITS.exec(rest)?.[0].length;
    if (!end) {
      // Only bothers with this slower path when the text starts like a number, so a label followed by
      // unrelated words costs nothing extra.
      UNIT_RE.lastIndex = 0;
      if (!UNIT_RE.test(rest) && !(isLetter(rest[0]) && readTypo(rest, 0))) return null;
      const units = readNumberRuns(rest, true)[0]?.units;
      if (!units || units[0].start !== 0 || !units.some((unit) => unit.isWord)) return null;
      for (let unitIndex = 1; unitIndex < units.length; unitIndex++) {
        if (!CODE_GAP.test(rest.slice(units[unitIndex - 1].end, units[unitIndex].start))) return null;
      }
      const digitTotal = units.reduce((count, unit) => count + unit.digits.length, 0);
      end = lastItem(units).end;
      if (digitTotal < 3 || digitTotal > 4) return null;
      // Cut off at 60 characters, it may go on.
      if (end === rest.length && at + end < text.length) return null;
    }
    if (CODE_SIZE.test(rest.slice(end))) return null;
    return rest.slice(0, end);
  }

  // ── Remote-access and door codes, in Spanish too ──
  // Spanish, matching the same kind of phrase: "el código de AnyDesk es 123 456 789".
  // A remote-access app's name, in English and in Spanish.
  const REMOTE_WORDS = [
    String.raw`any\s*desk|team\s*viewer|remote\s+(?:access|support|desktop)`,
    String.raw`quick\s*assist|ultra\s*viewer|rust\s*desk`,
  ].join("|");
  const REMOTE_WORDS_ES = String.raw`any\s*desk|team\s*viewer|acceso\s+remoto`;
  const ES_DOOR_WORDS = String.raw`puerta|portal|alarma|garaje|caja\s+fuerte|edificio|casa|cajero|tarjeta`;
  const CODE_TOLD_ES = new RegExp(
    String.raw`(?<![\p{L}])(?:c[oó]digo|clave|id|pin)\s+(?:de\s+la|del|de)\s+(?:${REMOTE_WORDS_ES}|${ES_DOOR_WORDS})` +
      String.raw`\s*(?:(?:es|era|:)\s*)?["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{3,10}#?)(?![\d-])`,
    "giu",
  );
  const REMOTE_CODE = new RegExp(
    String.raw`\b(?:${REMOTE_WORDS})(?:\s+(?:id|code|number|address|password|pin))?` +
      String.raw`\s*(?:(?:is|:|=)\s*)?["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{6,10})(?![\d-])`,
    "gi",
  );

  // ── Card security codes ──
  // Finds a card's security code, which counts as its own money-related kind alongside the card number
  // rather than as a password. This matches the label, reads the code after it with cardCodeAt(), and
  // runs it through the same value checks a password gets. The result is cached for the last text read,
  // since the password kind needs it too, to leave these codes out of its own matches.
  let cardCodesFor = { text: null, codes: [] };
  function findCardCodes(text) {
    if (cardCodesFor.text !== text) {
      const codes = [];
      for (const m of text.matchAll(CARD_CODE)) {
        const code = cardCodeAt(text, m.index + m[0].length);
        const value = code && secretValue(code, false, 3);
        if (value) codes.push(value);
      }
      cardCodesFor = { text, codes: [...new Set(codes)] };
    }
    return [...cardCodesFor.codes];
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    LOGIN_PAIR,
    CODE_TOLD,
    matched,
    LOGIN_NAMES,
    CODE_THEY_SENT,
    LOGIN_CODE,
    otherCodes,
    LOGIN_LABEL_ES,
    LOGIN_CODE_ES,
    CARD_LABEL,
    REMOTE_WORDS,
    REMOTE_WORDS_ES,
    CODE_TOLD_ES,
    REMOTE_CODE,
    findCardCodes,
  };
})();
