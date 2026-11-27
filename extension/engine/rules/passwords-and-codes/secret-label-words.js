// The words that label a password or a secret, and values that plainly aren't one. Most of the password and
// secret rules build on these.
(() => {
  "use strict";

  const { looksRandomLetters, nameRoleAlternatives } = globalThis.ClotrInternal;

  // ---------- The words that label a password or a secret ----------

  // A labelled secret like "password: hunter2" or an .env name like DB_PASSWORD=. The name prefix is limited to 4
  // parts (the DB_PROD_ in DB_PROD_PASSWORD), because an unbounded one would backtrack quadratically on hostile text
  // like "a-a-a-…".
  // An "=" setting never takes its value from the next line: in an .env template "PASSWORD=" is empty and the line
  // under it ("USERNAME=admin") is its own setting. "Password:" can, after a quoted reply's "> ", when the value is
  // alone on its line: a forwarded "Reset your password:" with "> Click the link…" under it is a sentence.
  // People write a key's name with a space too ("API key: …", "secret key: …", "clave de API: …"). Code adds a type
  // ("apiKey: string = …") or sets it by name (os.environ["DB_PASSWORD"] = …), and psql and sshpass read PGPASSWORD
  // and SSHPASS.
  // A label's role words (nameRoleWords) take only a value with no ":" or "/", so an ARN or a path after one is left
  // to the labels inside it: "secret:" in app.secret.arn=arn:aws:…:secret:….
  const ROLE_VALUE_AHEAD = String.raw`(?=["']?\]?\s*[:=][^\S\n]*["']?[^\s"',;:/]+(?:[\s"',;]|$))`;
  // After the secret's name, a dotted role word still names it: db.password.ref=…. SecretString, the Secrets
  // Manager field, counts only before a quoted value or after ? or & in a query, so a CloudFormation function on
  // the next line or a variable in an SDK call (SecretString=creds_json) isn't a value.
  const STRING_IN_QUERY = String.raw`(?<=[?&]secret)string(?==\S)`;
  const STRING_BEFORE_QUOTE = String.raw`string(?=["\x27]?[^\S\n]*[:=][^\S\n]*["\x27])`;
  const STRING_BEFORE_SET = String.raw`string(?=[^\S\n]*(?:=|:\s))`;
  const SECRET_WORDS = [
    String.raw`password|passwd|pwd|pass|pw|passcode|passphrase|pin`,
    String.raw`secret(?:${STRING_IN_QUERY}|${STRING_BEFORE_QUOTE}|${STRING_BEFORE_SET})?`,
    String.raw`client_secret|token(?:\sde\sacceso)?|access_token|auth_token`,
    String.raw`api[_ -]?key|secret[ -]key|contrase(?:ñ|n)a|clave(?:\s(?:de\s)?api)?`,
    String.raw`pgpass(?:word)?|sshpass`,
  ].join("|");
  // Up to four words joined to the label's front: DB_ADMIN_PASSWORD, my-app-api-key.
  const NAME_START = String.raw`\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}`;
  const DOTTED_ROLE = String.raw`(?:\.(?:${nameRoleAlternatives()})${ROLE_VALUE_AHEAD})?`;
  const LABEL_CLOSE = String.raw`["']?\]?\s*`;
  // How the value is set: a typed "?: string =", a quoted reply's "> " on the next line, ":" or "=".
  const TYPED_SET = String.raw`\??:\s*(?:string|str)\s*=[^\S\n]*`;
  const QUOTED_REPLY_SET = String.raw`:[^\S\n]*\r?\n(?:>[^\S\n]?){1,3}(?=["']?[^\s"',;]+["']?[^\S\n]*(?:\r?\n|$))`;
  const SECRET_SET = String.raw`(?:${TYPED_SET}|${QUOTED_REPLY_SET}|:\s*|=[^\S\n]*)`;
  const VALUE = String.raw`["']?([^\s"',;]+)`;
  const LABELLED_SECRET = new RegExp(
    String.raw`${NAME_START}(?:${SECRET_WORDS})(?:_[A-Za-z0-9]+)*${DOTTED_ROLE}${LABEL_CLOSE}${SECRET_SET}${VALUE}`,
    "gi",
  );
  // Key and token labels get a kind of their own; password labels stay in LABELLED_SECRET. An Authorization header
  // is AUTH_HEADER's. Role words after the key's name still name it: stripe_key_ref, apiKeyRef.
  const KEY_WORDS = [
    String.raw`api[ _-]?key|[A-Za-z0-9]{1,30}[ _-](?:key|token)`,
    String.raw`client[ _-]secret|token\s+de\s+acceso`,
  ].join("|");
  const KEY_ROLE = String.raw`(?:[_.-]?(?:${nameRoleAlternatives()})${ROLE_VALUE_AHEAD})?`;
  const KEY_SET = String.raw`(?:${TYPED_SET}|:\s*|=[^\S\n]*)`;
  const LABELLED_API_KEY = new RegExp(
    String.raw`${NAME_START}(?:${KEY_WORDS})${KEY_ROLE}${LABEL_CLOSE}${KEY_SET}${VALUE}`,
    "gi",
  );

  // ── Values that plainly aren't secrets ──
  // A flag, an empty value, a decimal number, an auth scheme or a Kubernetes secret type, a YAML or CloudFormation
  // tag, a well-known resource name, or code.
  const NOT_A_SECRET_WORDS =
    "true|false|yes|no|on|off|none|null|nil|undefined|nan|" +
    "bearer|basic|digest|opaque|jwt|oauth2?|secretstr|secretbytes";
  const NOT_A_SECRET_VALUE = new RegExp(String.raw`^(?:${NOT_A_SECRET_WORDS}|\d+\.\d+)$`, "i");
  // A number with a unit (30m, 3600s, 512mb) is a setting after a token or key label, but after a password or PIN
  // label it can be the password itself ("pin: 2024s").
  const UNIT_NUMBER = /^\d+(?:ms|s|m|h|d|kb|mb|gb|k|%)$/i;
  // A constant's name that stands in for a value still to be filled in: CHANGE_ME, TODO_FIXME, REPLACE_WITH_YOURS.
  const PLACEHOLDER_WORDS =
    "CHANGE|CHANGEME|TODO|FIXME|TBD|TBC|REPLACE|FILL|ENTER|INSERT|ASK|HERE|XXX+|" +
    "DUMMY|SAMPLE|PLACEHOLDER|REDACTED|HIDDEN|MASKED|UNSET|NOTSET";
  const PLACEHOLDER_CONSTANT = new RegExp(`(?:^|_)(?:${PLACEHOLDER_WORDS})(?:_|$)`);

  // ── Auth scheme words ──
  // A scheme word told after a secret's label, with the credential after it: "token: Bearer …", "Basic …", GitHub's
  // and Django REST's "Token …", Discord's "Bot …", and OAuth, Digest, JWT or Opaque.
  const AUTH_SCHEME = /^(?:bearer|basic|digest|oauth2?|jwt|opaque|bot|token)$/i;
  // A parameter after a scheme word isn't its credential: "Bearer, expires_in=3600", 'Digest realm="api"',
  // "Bearer; charset=UTF-8", "OAuth oauth_consumer_key=…". A token's own "=" is only base64 padding at its end, so a
  // name and an "=" with more after it is a parameter.
  const SCHEME_PARAMETER = /^[A-Za-z_][\w.-]*=(?!=*$)/;
  // A known parameter's name, with ":" or nothing after it.
  const SCHEME_PARAMETER_NAME = new RegExp(
    String.raw`^(?:${[
      String.raw`realm|scope|error|error_description|error_uri|charset|expires|expires_in|expires_at`,
      String.raw`ttl|max[_-]?age|version|kid|alg|typ|nonce|cnonce|nc|qop|opaque|algorithm|stale`,
      String.raw`domain|uri|response|username|userhash|oauth_[a-z_]+|token_type|state|audience|aud`,
      String.raw`iss|sub|exp|iat|nbf`,
    ].join("|")})(?:[:=]|$)`,
    "i",
  );
  // A protocol's name and version after a scheme word: "Bearer; HTTP/1.1".
  const PROTOCOL_VERSION = /^[A-Za-z]+\/\d+(?:\.\d+)*$/;

  // The credential after a scheme word is the whole run up to a space, whatever marks are in it (%2B, $, !, &next=…),
  // less the sentence's own punctuation at its end. A colon, comma or dash can sit between the scheme and the run
  // ("Bearer: …", "Bearer - …", "Bearer – …"), and the run can be the whole next line ("token: Bearer" with the token
  // under it), but not a setting of its own ("expires_in: 3600"). A quote closing a quoted scheme word ('"Bearer" …')
  // can sit before the run, but not one that ends a JSON value with more keys after it ('"Bearer", "expires_in": …').
  function schemeCredential(text, schemeEnd) {
    const closingQuote = /^["'”’][^\S\r\n]+[^\s"'{[,:;]/u.test(text.slice(schemeEnd, schemeEnd + 4)) ? 1 : 0;
    const credentialStart = schemeEnd + closingQuote;
    const match = /^[^\S\r\n]*(?:=>|->|[:,;=\-–—])?(?:[^\S\r\n]+|[^\S\r\n]*(\r?\n)[^\S\r\n]*)(\S+)/u.exec(
      text.slice(credentialStart, credentialStart + 600),
    );
    if (!match) return null;

    const [matchedText, lineBreak, candidate] = match;
    if (lineBreak) {
      const looksLikeSetting = /[:=][^=]|:$/.test(candidate);
      const aloneOnItsLine = /^[^\S\r\n]*(?:\r?\n|$)/.test(text.slice(credentialStart + matchedText.length));
      if (looksLikeSetting || !aloneOnItsLine) return null;
    }

    const openingMarks = /^["'“‘(<[`]*/.exec(candidate)[0].length;
    const value = candidate.slice(openingMarks).replace(/[.,;:!?'"”’)\]}>`]+$/u, "");
    if (!value) return null;

    const valueStart = credentialStart + matchedText.length - candidate.length + openingMarks;
    return { value, at: valueStart, end: credentialStart + matchedText.length };
  }

  // The scheme word at the start of a value told at `valueStart`, less a bracket before it ("(Bearer …)") and a
  // colon, comma or dash after it, and the credential after it; null without both.
  function schemeAt(text, valueStart, value) {
    const openingBracket = /^[([]?/.exec(value)[0].length;
    const schemeWord = value.slice(openingBracket).replace(/[:,\-–—]+$/u, "");
    if (!AUTH_SCHEME.test(schemeWord)) return null;

    const credential = schemeCredential(text, valueStart + openingBracket + schemeWord.length);
    if (!credential) return null;
    return { word: schemeWord, value: credential.value, at: credential.at, end: credential.end };
  }

  // ── Basic credentials ──
  // Base64 read without atob, which Node 14 doesn't have. The "=" padding at the end is optional.
  const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function decodeBase64(encoded) {
    const padded = /=$/.test(encoded);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    if (padded && encoded.length % 4 !== 0) return null;
    if (!padded && encoded.length % 4 === 1) return null;

    let bits = 0;
    let bitCount = 0;
    let decoded = "";
    for (const character of encoded.replace(/=+$/, "")) {
      bits = ((bits << 6) | BASE64_DIGITS.indexOf(character)) & 0xffffff;
      bitCount += 6;
      if (bitCount < 8) continue;

      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
    }
    return decoded;
  }

  // HTTP Basic's credential is base64 of "name:password", so one that decodes to that is a sign-in.
  function basicSignIn(decoded) {
    if (!decoded) return false;
    return /^[\x21-\x7e][\x20-\x7e]*:[\x20-\x7e]*[\x21-\x7e]$/.test(decoded);
  }

  // Whether the run after "Bearer" or "Basic" is a credential: digits among its letters, random letters, or for
  // Basic a "name:password" in base64. "Basic Authentication" or "Bearer tokens" isn't one.
  function schemeCredentialLike(scheme, credential) {
    // A Bearer token (RFC 6750's b64token) and Basic's base64 never hold a ":", so a run with one is a parameter or
    // a claim told after the scheme: "Bearer, client_id:app42", "Bearer, jti:a1b2c3".
    if (/:/.test(credential)) return false;
    if (SCHEME_PARAMETER.test(credential)) return false;
    if (SCHEME_PARAMETER_NAME.test(credential)) return false;
    if (PROTOCOL_VERSION.test(credential)) return false;

    if (/^basic$/i.test(scheme)) {
      const decoded = decodeBase64(credential);
      // The standard's own example, Aladdin's "open sesame", is in every guide to Basic, and "username:password"
      // is a placeholder.
      if (decoded && /^(?:aladdin:open sesame|username:password)$/i.test(decoded)) return false;
      if (basicSignIn(decoded)) return true;
    }

    // A setting's name in snake case with a number on the end ("expires_in3600") is the next key, not a credential.
    if (/^[a-z]+(?:_[a-z]+)+\d*$/.test(credential)) return false;
    if (/\d/.test(credential) && /[A-Za-z]/.test(credential)) return true;
    // Letters alone are a credential when they're random or switch case the way a token does ("XkfQaLmPzRtVbNw"),
    // which the same label reads as a password without the scheme word too.
    if (credential.length >= 16 && looksRandomLetters(credential)) return true;
    const caseSwitches = (credential.match(/[a-z][A-Z]/g) || []).length;
    return credential.length >= 10 && /^[A-Za-z]+$/.test(credential) && caseSwitches >= 3;
  }

  // ── Code around a label ──
  // The text before `index` on its line, up to 200 characters, starting with "\n" when it reaches the line's start.
  function lineBefore(text, index) {
    const from = Math.max(0, index - 200);
    const chunk = text.slice(from, index);
    const lineStart = chunk.lastIndexOf("\n");
    if (lineStart >= 0) return chunk.slice(lineStart);
    if (from > 0) return chunk;
    return "\n" + chunk;
  }

  // What follows a value only in code: an operator like ||, && or ??, a default after a type ("password:
  // Optional[str] = None"), a comma ending the line as in an object's lines, or a bracket on the next line closing
  // the object or call. A comma inside a line, a ")" or "and" is ordinary writing too. A comma ends an object's line
  // only when the next line is code too: another "name:" or "name =", a call, a comment, or the closing bracket.
  // "superSecret,\nthanks" ends a line of a letter.
  const OPERATOR = String.raw`\|\||&&|\?\?|=(?!=)`;
  // A closing bracket, a "name:" or a call, a comment, "..." or an empty line.
  const CODE_LINE_START = String.raw`[)}\]]|["']?[\w$.-]+["']?[^\S\r\n]*[:=(]|\/\/|\/\*|#|\.\.\.|$`;
  const NEXT_LINE_IS_CODE = String.raw`\r?\n(?:[^\S\r\n]*(?:${CODE_LINE_START})|[^\S\r\n]+[\w$.]+,)`;
  const COMMA_ENDS_LINE = String.raw`,[^\S\r\n]*(?:${NEXT_LINE_IS_CODE}|$)`;
  const BRACKET_NEXT_LINE = String.raw`\r?\n[^\S\r\n]*[)}\]]`;
  const CODE_AFTER = new RegExp(String.raw`^[^\S\r\n]*(?:${OPERATOR}|${COMMA_ENDS_LINE}|${BRACKET_NEXT_LINE})`);
  // After a spaced " = " assignment, a semicolon or a Python "or", "and", "if" or "+" is code; an INI file's
  // "password = superSecret" alone is not, and nor is its comment after a spaced " ; ".
  const ASSIGNED_CODE_AFTER =
    /^(?:;|[^\S\r\n]+;[^\S\r\n]*(?:\r?\n|$|[\w$.]+[^\S\r\n]*[=(])|[^\S\r\n]*(?:\+|or\b|and\b|if\b))/;
  // What comes before a label in code: a declaration at the start of its line (let, const, private String) or an
  // object (this., self.). "the final password:" or "Our public password:" is a sentence.
  const DECLARATION_WORDS =
    "export|let|const|var|val|final|static|private|public|protected|readonly|String|string|str|auto|def";
  const DECLARED_BEFORE = new RegExp(String.raw`(?:^|[\n;{(,])[^\S\n]*(?:(?:${DECLARATION_WORDS})\s+)+$`);
  // Declaration words that also start a sentence ("final password: …", "public password: …"). Before a label set
  // with ":" they make the value a type, and a type isn't written in lower camel case like "superSecret".
  const PROSE_DECLARATION =
    /^(?:final|public|private|protected|static)(?:\s+(?:final|public|private|protected|static))*$/;
  const MEMBER_BEFORE = /[.$]$/;
  // An INI or TOML section's header on a line of its own before the label: "[database]", "[wifi]".
  const INI_SECTION = /(?:^|\n)[^\S\r\n]*\[[A-Za-z][\w .-]*\][^\S\r\n]*\r?\n/;

  // ── Types and constant names ──
  // Generic types and the types they hold, as in a Python or TypeScript annotation: Optional[str], List[str],
  // Annotated[str, Form()], Optional[SecretStr].
  const TYPE_GENERIC = new RegExp(
    String.raw`^(?:${[
      String.raw`optional|list|dict|union|annotated|tuple|set|frozenset|sequence|mapping`,
      String.raw`mutablemapping|iterable|iterator|generator|literal|type|callable|awaitable|coroutine`,
      String.raw`classvar|final|required|notrequired|readonly|array|record|partial|promise|maybe|nullable`,
      String.raw`option|result|vec|box|rc|arc|some|ok|err|ref|cell|refcell|map|hashmap|future|lazy`,
    ].join("|")})$`,
  );
  const TYPE_WORD = new RegExp(
    String.raw`^(?:${[
      String.raw`str|int|float|bool|bytes|none|any|object|string|number|boolean|unknown|never|void`,
      String.raw`null|undefined|text|char|byte|long|integer|uuid|date|datetime|secretstr|secretbytes`,
      String.raw`emailstr|httpurl|anyurl|path|json|self|true|false`,
    ].join("|")})$`,
  );
  // A secret's own word inside a name: Optional[Password], Some(Token), SECRET_KEY, ADMIN_PASS.
  const SECRET_PART_WORDS =
    "pass|passwd|pwd|password|pw|pin|key|keys|token|tokens|secret|secrets|" +
    "cred|creds|credential|credentials|auth|hash|api|salt";
  const SECRET_PART = new RegExp(`^(?:${SECRET_PART_WORDS})$`, "i");
  // A word and a number spelled out, the way "hunter2" is typed in capitals: HUNTER_TWO. A step, level or phase with
  // a number is an enum's value (PHASE_TWO, LEVEL_ONE), a test's or an account's constant is a fixture (MOCK_TWO,
  // ADMIN_TWO, WPA_TWO), and an instruction is a placeholder (PICK_ONE, ANY_TWO). "_ONE" alone is too often "pick
  // one" or "use one" to count.
  const CAPS_WORD_NUMBER = /^([A-Z]{3,})_(?:TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE)$/;
  const ENUM_STEP = new RegExp(
    String.raw`^(?:${[
      String.raw`LEVEL|PHASE|STEP|STAGE|TIER|OPTION|VERSION|ROUND|PLAN|CASE|GROUP|CLASS|RULE|FACTOR`,
      String.raw`METHOD|SCHEME|POLICY|TEAM|ZONE|REGION|NODE|SLOT|PART|PAGE|ITEM|CHOICE|LAYER|GRADE`,
      String.raw`ROLE|BATCH|SHARD|REPLICA|PRIORITY|NUMBER|INDEX|ORDER|RANK|SIZE|SET|SIDE|AREA|PLAYER`,
      String.raw`SCREEN|FORM|FIELD|SECTION|ENTRY|STATE|STATUS|TEST|ANY|SOME|ALL|EACH|EVERY|NOT|NONE`,
      String.raw`ONLY|JUST|PICK|CHOOSE|SELECT|USE|GENERATE|CREATE|MAKE|ADD|GET|NEED|NEEDS|ENTER|INPUT`,
      String.raw`ASK|SEE|FIND|GIVE|TAKE|FIRST|LAST|NEXT|PREV|PREVIOUS|TOP|BOTTOM|PLUS|MINUS|TIMES`,
      String.raw`AUTO|MANUAL|STRATEGY|FLOW|TOTAL|DEMO|MOCK|FAKE|STUB|FIXTURE|TESTING|ADMIN|GUEST|ROOT`,
      String.raw`BACKUP|ACCOUNT|PRIMARY|SECONDARY|BUILD|SPRINT|DAY|WAVE|OAUTH|SHA|WPA`,
    ].join("|")})$`,
  );

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    LABELLED_SECRET,
    LABELLED_API_KEY,
    NOT_A_SECRET_VALUE,
    UNIT_NUMBER,
    PLACEHOLDER_CONSTANT,
    AUTH_SCHEME,
    schemeAt,
    schemeCredentialLike,
    lineBefore,
    CODE_AFTER,
    ASSIGNED_CODE_AFTER,
    DECLARED_BEFORE,
    PROSE_DECLARATION,
    MEMBER_BEFORE,
    INI_SECTION,
    TYPE_GENERIC,
    TYPE_WORD,
    SECRET_PART,
    CAPS_WORD_NUMBER,
    ENUM_STEP,
  };
})();
