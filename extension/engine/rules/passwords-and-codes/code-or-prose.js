// Is a value code or a sentence? Constants, code around a label, storage keys and the value readers that
// the password rules share.
(() => {
  "use strict";

  const {
    STRESSED_SECRET,
    QUOTE_CLOSE,
    STORAGE_KEY_WORDS,
    readName,
    valueRole,
    QUIET,
    valueAnswer,
    QUIET_ROLES,
    NOT_A_SECRET_VALUE,
    UNIT_NUMBER,
    PLACEHOLDER_CONSTANT,
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
  } = globalThis.ClotrInternal;

  // ---------- Names that look like code ----------

  // ── Constants in capitals ──
  // Words in a constant's name that code uses and a typed password doesn't: DEFAULT_VALUE, MAX_LENGTH, EMPTY_STRING.
  const CODE_CONSTANT_PART = new RegExp(
    String.raw`^(?:${[
      String.raw`DEFAULT|DEFAULTS|CONFIG|CONF|SETTING|SETTINGS|ENV|ENVIRON|VAR|VARS|VALUE|VALUES`,
      String.raw`NAME|PATH|FILE|DIR|URL|URI|HOST|PORT|USER|USERNAME|MAX|MIN`,
      String.raw`LEN|LENGTH|SIZE|EMPTY|STRING|STR|NONE|NULL|NIL|INT|BOOL|TRUE|FALSE`,
      String.raw`FIELD|FIELDS|TYPE|KIND|HEADER|PREFIX|SUFFIX|CHARS|REGEX|PATTERN|TIMEOUT|TTL|LIMIT|COUNT`,
      String.raw`MODE|FLAG|ID|KEY|DB|SQL|HTTP|HTTPS|API|APP|SERVER|CLIENT|SERVICE`,
      String.raw`CACHE|STORE|VAULT|PROD|DEV|TEST|STAGING|LOCAL|GLOBAL|CONST|INITIAL|INIT|ORIGINAL|CURRENT|OLD|NEW`,
    ].join("|")})$`,
  );

  // Whether a constant in capitals is a password a person typed rather than an enum's value, a setting or a
  // placeholder (SET_ME, NOT_REQUIRED, USE_SSO, MYSQL_ROOT, SOME_CONSTANT), which are far more common after a label.
  // Only a stressed "secret" (SUPER_SECRET) or a word and a number word (HUNTER_TWO) is; a quoted "MY_SECRET_PASS" is
  // a string typed out too.
  function capsPassword(value, quoted) {
    if (STRESSED_SECRET.test(value)) return true;
    if (quoted && /^MY_(?:(?:SUPER|TOP)_)?SECRET_PASS$/.test(value)) return true;
    const numbered = CAPS_WORD_NUMBER.exec(value);
    if (!numbered) return false;
    const word = numbered[1];
    if (CODE_CONSTANT_PART.test(word) || SECRET_PART.test(word)) return false;
    return !ENUM_STEP.test(word) && !PLACEHOLDER_CONSTANT.test(word);
  }

  // ── Names that look like code ──
  // Objects and holders that code reads a value from, at any place in a member chain: App.Settings.Value,
  // vault.kv.read, os.environ.get.
  const CODE_HOLDER = new RegExp(
    String.raw`^(?:${[
      String.raw`settings|setting|config|configs|conf|cfg|env|environ|vault|secrets|params|request|req|client|server`,
      String.raw`instance|current|defaults|default|prefs|preferences|keys|globals|vars|variables|properties|props`,
      String.raw`attrs|attributes|fields|field|model|module|exports|process|global|locals|services|service|provider`,
      String.raw`manager|cache|storage|value|values|get|read|load|fetch|app|self|this|state`,
      String.raw`ctx|context|data|form|store|options|opts|sys|os|args|kwargs|payload|result|response|resp|res|db|api`,
      String.raw`system|environment|java|javax|microsoft|android|util|lang|security|crypto|net|io|application`,
      String.raw`credentials|creds|keychain|keyring|account|accounts|login`,
    ].join("|")})$`,
    "i",
  );
  // A part of a member chain two letters or shorter is code when it has no vowel or is a usual short name in code
  // (kv, db, Pw, id, os); "I.love.my.dog" or "me.and.you" is a passphrase of short words.
  function shortCodePart(part) {
    if (part.length > 2) return false;
    if (!/[aeiouy]/i.test(part)) return true;
    return /^(?:id|os|io|ui|ip|op|el|ev|ex|re|ok|ai|au)$/i.test(part);
  }
  // A function's or index's name around a single word, and what follows its bracket: "Kitty[Paw]", "Fluffy(cat)9".
  const BRACKETED = /^([A-Za-z_$][\w$]*)([([])([^()[\]{}]*)([)\]])([\s\S]*)$/;
  // A constant's or an environment variable's name: DEFAULT_HASHERS, SESSION_SECRET.
  const CONSTANT_NAME = /^[A-Z]+(?:_[A-Z]+)+$/;
  // A variable's name in code: a secret's name with a word code uses for it, like hashedPassword or access_token.
  // Words a person also puts in a weak password (admin, default, temp, new, user, db) aren't here.
  const CODE_SECRET_NAME = new RegExp(
    String.raw`^(?:(?:${[
      String.raw`hash|hashed|encrypted|enc|salted|old|current|stored|plain`,
      String.raw`plaintext|raw|access|refresh|auth|session|csrf|jwt|input|confirm|reset|bearer|id|api`,
    ].join("|")})(?:password|passwd|pwd|pass|token|secret|key|pin)|` +
      String.raw`(?:password|passwd|pwd|pass|token|secret|key|pin)(?:${[
        String.raw`hash|hashed|encrypted|salt|input|field|value|confirm|confirmation`,
        String.raw`id|str|string|bytes|data`,
      ].join("|")}))$`,
  );
  // Names that are a variable in code and a weak password typed by a person alike, read as a password after a
  // password label.
  const WEAK_PASSWORD_NAME = /^(?:old|current|reset|auth|session)(?:password|passwd|pwd|pass)$/;
  // A password's word with a word code puts after it, anywhere in a longer name: resetPasswordToken,
  // sessionPasswordHash, user_password_field.
  const PASSWORD_THEN_CODE = new RegExp(
    String.raw`(?:password|passwd|pwd)(?:${[
      String.raw`hash|hashed|encrypted|salt|input|field|value|confirm|confirmation|id|str|string|bytes|data`,
      String.raw`token|key|reset|digest`,
    ].join("|")})$`,
  );
  // A function that makes or reads a secret, called around a word: Hash(pw), Decrypt(cfg), Secret(name).
  const SECRET_FUNCTION = new RegExp(
    String.raw`^(?:${[
      String.raw`hash|crypt|encrypt|decrypt|encode|decode|digest|cipher|hmac|sign|bcrypt|scrypt|argon2|sha\d*`,
      String.raw`md5|base64|b64encode|b64decode|getenv|env|secret|token|password|passwd|key|apikey`,
      String.raw`credential|credentials`,
    ].join("|")})$`,
  );

  // Whether the text just before `index` is inside code: an object's "{" or a call's or index's "(" or "[" right
  // after a name, still open. A "(" after a space or at the start is a sentence's aside: "(password: …)".
  function insideCode(text, index) {
    let depth = 0;
    for (let at = index - 1; at >= 0 && at >= index - 300; at--) {
      const character = text[at];
      if (character === ")" || character === "]" || character === "}") {
        depth++;
        continue;
      }
      if (character !== "(" && character !== "[" && character !== "{") continue;
      if (depth > 0) {
        depth--;
        continue;
      }
      return character === "{" || /[\w$.)\]]/.test(text[at - 1] || "");
    }
    return false;
  }
  // Whether a word around a word ("Kitty[Paw]", "Fluffy(cat)9") is a password rather than code. Code calls and
  // indexes look the same as these (Field(alias), Settings[key], Some(pw), Optional[str], Inject(Config)), so this
  // takes only what code doesn't write: letters or digits right after the closing bracket, or, in an INI file
  // where a value is never code, a capitalised word that isn't a generic type, a secret's function or the label's
  // word around a plain word ("[wifi]\npassword = Fluffy(cat)"). A sentence can describe code ("Set the password:
  // Input(prompt)"), so it isn't enough.
  function bracketedPassword(value, word, inCode, ini) {
    if (inCode) return false;
    const bracketed = BRACKETED.exec(value.trim().replace(/[.,;:!?]+$/, ""));
    if (!bracketed) return false;
    const [, name, , inside, , rest] = bracketed;
    // A chain on the result is code: Secret(name).value, get(pw)[0].
    if (/^(?:\.[A-Za-z_$]|[([])/.test(rest)) return false;
    if (/^[A-Za-z0-9]/.test(rest)) return true;
    if (rest || !ini) return false;
    if (!/^[A-Z][a-z]+$/.test(name) || !/^[A-Za-z]+$/.test(inside)) return false;
    const lowerName = name.toLowerCase();
    if (TYPE_GENERIC.test(lowerName) || SECRET_FUNCTION.test(lowerName) || lowerName === word) return false;
    return !TYPE_WORD.test(inside.toLowerCase()) && !/pass|pwd|token|secret|key|pin|cred|auth/i.test(inside);
  }
  // A YAML tag stands for a value kept somewhere else: a vault, a template's own functions, a file or a variable.
  const TEMPLATE_FUNCTION_TAGS = "Ref|Sub|GetAtt|ImportValue|Join|Select|Split|If|Base64|FindInMap|Equals|Condition";
  const YAML_TAG = new RegExp(`^!(?:vault|${TEMPLATE_FUNCTION_TAGS}|env|include|secret|encrypted)$`);
  const DOMAIN_ENDING = String.raw`\.(?:com|org|net|io|app|dev|co|ai|gov|edu|me|us|uk|de|cloud|sh)`;
  const DOMAIN_VALUE = new RegExp(String.raw`^[a-z0-9-]+(?:\.[a-z0-9-]+)*${DOMAIN_ENDING}(?:/[\w./-]*)?$`);
  // Objects that code reads a value from, like tokenizer.eos_token or state.auth.token.
  const CODE_OBJECT = new RegExp(
    String.raw`^(?:${[
      String.raw`self|this|tokenizer|response|resp|res|state|props|ctx|context|data|user|form|session|store|auth`,
      String.raw`options|opts|cfg|conf|app|sys|os|window|document|tokens|credentials|creds`,
      String.raw`payload|result|args|kwargs|jwt|crypto|bcrypt|hashlib|secrets`,
    ].join("|")})$`,
  );
  // A name in code is words, maybe with a number at the end (eos_token, getPassword, argv, v2). A random token cut at
  // its dots has digits in the middle of its pieces, so it never reads as one.
  const IDENT = String.raw`[A-Za-z_$][A-Za-z_$]*\d{0,3}(?![\w$])`;

  // ---------- Code around a label ----------

  // ── Code around a label ──
  // Code that names, reads or computes a secret instead of holding one. People's passwords can look like code too
  // ("Correct.Horse.Battery", "superSecret", "Fluffy(cat)9"), so a shape that both write needs code around it, and
  // ordinary writing (a comma, a bracket, "and", an INI file's " = ") isn't that. `near` is what's next to the
  // value: the text before the label on its line (`before`), the text after the value (`after`), whether the label
  // was set with a spaced " = " (`assigned`) or with any "=" (`equals`), and whether the label sits inside an object
  // or a call (`enclosed`).

  // Whether a label and its value stand alone the way a note writes them: "wifi password: myPassword". Set with "=",
  // a quoted key ("password": …), a colon with no space after it, an indented line (an object's or YAML's member),
  // code punctuation or a comment right after the value, or a closing bracket after blank or comment lines is code
  // or a settings file.
  const CODE_RIGHT_AFTER = /^[^\S\r\n]*(?:[)}\];]|\/\/|\/\*|#|,[^\S\r\n]*(?:\r?\n|$))/;
  const CLOSES_LATER = /^[^\S\r\n]*(?:\r?\n[^\S\r\n]*(?:(?:\/\/|#|\/\*)[^\r\n]*)?)*\r?\n[^\S\r\n]*[)}\]]/;
  function bareLabel(near, after) {
    if (near.equals || near.quotedKey || near.tight) return false;
    if (/^\n[^\S\n]+/.test(near.before || "")) return false;
    return !CODE_RIGHT_AFTER.test(after) && !CLOSES_LATER.test(after);
  }
  // The code shapes around any variable's name, which a note doesn't write either: a quoted key with an unquoted
  // value ("password": superSecret), or a ";", "}" or "//" comment right after it, or a closing bracket after blank
  // or comment lines. A ")" or "," is a sentence's too: "(password: superSecret)", and so is an INI file's comment
  // after a spaced " ; ".
  const VARIABLE_RIGHT_AFTER = /^(?:;|[^\S\r\n]*(?:\}|\/\/|\/\*|;[^\S\r\n]*(?:\r?\n|$)))/;
  // More of an object or a call after the value, which a note doesn't write either: a comma and another member
  // ("email })", "...rest", a "remember: true" or "email: email" set to a literal or its own name) or a comment, a
  // TypeScript cast ("as string", "satisfies Login"), a "+" or a "? :" around it, or indented member lines down to
  // the bracket that closes them. A comma and a word ("thanks!", "and the guest one", "host: x") is a sentence's.
  const MEMBERS_AFTER = new RegExp(
    [
      // A comma and another member or a comment.
      String.raw`^(?:[^\S\r\n]*,[^\S\r\n]*(?:\.\.\.|\/\/|\/\*|#|`,
      String.raw`[A-Za-z_$][\w$]*[^\S\r\n]*[,)}]|([A-Za-z_$][\w$]*):[^\S\r\n]*`,
      String.raw`(?:true|false|null|undefined|\d+|\1)(?![\w$]))`,
      // A cast, a "+" or a "? :".
      String.raw`|[^\S\r\n]+(?:as[^\S\r\n]+(?:const|string|number|boolean|any|unknown|[A-Z][\w$]*)(?![\w$])`,
      String.raw`|satisfies[^\S\r\n]+[A-Za-z_$]|\+[^\S\r\n]+[\w$(]|\?[^\S\r\n]+[^\r\n]*?[^\S\r\n]:[^\S\r\n])`,
      // Indented member lines down to the closing bracket.
      String.raw`|[^\S\r\n]*(?:\r?\n[^\S\r\n]+(?:,?[^\S\r\n]*["']?[\w$-]+["']?|\/\/|#|\/\*)[^\r\n]*)+`,
      String.raw`\r?\n[^\S\r\n]*[)}\]])`,
    ].join(""),
  );
  function variableInCode(near, after) {
    if (near.quotedKey) return true;
    return VARIABLE_RIGHT_AFTER.test(after) || CLOSES_LATER.test(after) || MEMBERS_AFTER.test(after);
  }
  // Whether a variable-like name stands on a bare line the way a note writes it: nothing after it up to the line's end
  // is a code character (a bracket, "=", "+", "?", ";", a quote, "<", ">", "|", "&", "!" or a member's "."), apart
  // from a ")" that closes a "(" opened before the label on its line ("(password: superSecret)") and a closing "!" or
  // "?" of a sentence, and the next line that isn't blank isn't indented and doesn't start with a closing bracket.
  // "password: superSecret, thanks" and "user: bob, password: mySecret, host: x" are bare; "password: newPassword,
  // email })", "password: newPassword === confirm" and "password: newPassword\n  ...rest\n}" aren't. An INI file's
  // comment after a spaced " ; " or " # " is the file's, not code.
  // A later member set to a camelCase name ("email: emailInput", "confirm: confirmPassword") is code too; "host: x" or
  // "wifi: HomeNet" is a note's.
  const BARE_LINE_CODE =
    /[(){}[\]=+;'"`<>|&]|![\w$!(=]|\?(?![^\S\r\n]*$)|\.[A-Za-z_$]|:[^\S\r\n]*[a-z][a-z\d]*[A-Z][\w$]*(?![\w$])/;
  function bareLine(near, rest) {
    const newline = rest.search(/\r?\n/);
    let line = newline < 0 ? rest : rest.slice(0, newline);
    if (near.assigned || near.ini) line = line.replace(/[^\S\r\n]+[;#][^\S\r\n][\s\S]*$/, "");
    const before = near.before || "";
    let opened = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
    while (opened > 0 && line.includes(")")) {
      line = line.replace(")", "");
      opened--;
    }
    if (BARE_LINE_CODE.test(line)) return false;
    if (newline < 0) return true;
    const next = /^(?:[^\S\r\n]*\r?\n)*([^\S\r\n]*)(\S?)/.exec(rest.slice(newline).replace(/^\r?\n/, ""));
    if (!next || !next[2]) return true;
    const [, indent, first] = next;
    return indent.length === 0 && !/[)}\]]/.test(first);
  }

  // ── Reading code-like values ──
  // What the code readers read around a value, worked out once when the first of them is asked: the value less
  // brackets at its end (`trimmed`), what follows it, whether it sits in code, and the setting name's word and kind.
  function codeFacts(context) {
    if (context.code) return context.code;
    const { record, around: near } = context;
    const value = record.value;
    const settingName = record.name.toLowerCase();
    const trimmed = value.trim().replace(/[)\]}>]+$/, "");
    // Brackets at the end that close nothing in the value, then what follows the value.
    const open = (trimmed.match(/[([{]/g) || []).length - (trimmed.match(/[)\]}]/g) || []).length;
    const closers = value.trim().slice(trimmed.length + Math.max(0, open));
    const after = closers + (near.after || "");
    // A declaration before a label set with ":" makes the value a type ("private password: String"), and a type is
    // capitalised or a built-in word, so "private password: superSecret" is a sentence's label.
    const declaration = DECLARED_BEFORE.exec(near.before || "");
    const declared =
      Boolean(declaration) &&
      (Boolean(near.equals) ||
        !/^[a-z]/.test(trimmed) ||
        TYPE_WORD.test(trimmed) ||
        !PROSE_DECLARATION.test(declaration[0].replace(/^[\n;{(,]/, "").trim()));
    const inCode =
      Boolean(near.enclosed) ||
      CODE_AFTER.test(after) ||
      declared ||
      MEMBER_BEFORE.test(near.before || "") ||
      // An indented member ending in ";", as in a TypeScript class or interface: "  password: superSecret;".
      (/^\n[^\S\n]+$/.test(near.before || "") && /^;[^\S\r\n]*(?:\r?\n|$)/.test(after)) ||
      Boolean(near.assigned && ASSIGNED_CODE_AFTER.test(after));
    const { word } = readName(settingName);
    context.code = { near, value, settingName, trimmed, closers, after, declared, inCode, word };
    return context.code;
  }
  // A type after a declaration: "private password: String", "readonly token: Token".
  function declaredType(context) {
    const { near, trimmed, declared } = codeFacts(context);
    if (!declared || near.equals) return null;
    return /^[A-Z][A-Za-z]*$/.test(trimmed) ? "type" : null;
  }
  // A type named for the label's own secret inside code: "token: Token;" in an interface, "password: Password,".
  function ownType(context) {
    const { trimmed, inCode, word } = codeFacts(context);
    if (!inCode || !word) return null;
    return /^[A-Z][A-Za-z]*$/.test(trimmed) && trimmed.toLowerCase().includes(word) ? "type" : null;
  }
  // A call or an index: generate_token(32, crypt($1, response.json()["…, tokens['…, sys.argv[1, hash(pw.
  // Any other word around a word is a password: "Kitty[Paw]", "Fluffy(cat)9".
  function codeCall(context) {
    const { near, value, trimmed, inCode, word } = codeFacts(context);
    const call = new RegExp(String.raw`^(${IDENT}(?:\.${IDENT})*)(?:\(\))*([([])(.?)`).exec(trimmed);
    if (!call) return null;
    const [, name, , next] = call;
    if (/[._]/.test(name) || /[a-z][A-Z]/.test(name)) return "call";
    if (next === "" || /^[$'")\]]$/.test(next)) return "call";
    // A plain word around a word: hash(pw), creds[key], Optional[str], Field(alias), Kitty[Paw], Fluffy(cat)9.
    if (/^[A-Za-z_]$/.test(next) && !bracketedPassword(value, word, inCode, near.ini)) return "call";
    return "password-like";
  }
  // A member chain: tokenizer.eos_token, state.auth.token, user.password, vault.kv.read, Settings.Db.Pw,
  // App.Settings.Value. Dotted words with nothing code-like in them ("Correct.Horse.Battery", "I.love.my.dog") are
  // a passphrase.
  function memberChain(context) {
    const { trimmed } = codeFacts(context);
    if (!new RegExp(String.raw`^${IDENT}(?:\.${IDENT})+$`).test(trimmed)) return null;
    const parts = trimmed.split(".");
    const last = parts[parts.length - 1].toLowerCase();
    const codePart = (part) =>
      /_/.test(part) || /[a-z][A-Z]/.test(part) || shortCodePart(part) || CODE_HOLDER.test(part);
    const code = parts.some(codePart) || CODE_OBJECT.test(parts[0]) || /pass|token|secret|key|pin/.test(last);
    return code ? "member-chain" : "passphrase";
  }
  // A name in code with no digit in it: api_key, hashedPassword, DEFAULT_HASHERS. A word plus digits stays a password.
  const plainName = (value) => new RegExp(String.raw`^${IDENT}$`).test(value) && !/\d/.test(value);
  // A constant is code, a setting or a placeholder (DB_PASSWORD, SECRET_KEY, NOT_SET, USE_SSO) unless it's a
  // password typed in capitals ("SUPER_SECRET", "HUNTER_TWO") outside code.
  // A setting for how secret something is holds a classification: PASSWORD_LEVEL=TOP_SECRET.
  function constantName(context) {
    const { settingName, trimmed, inCode, word } = codeFacts(context);
    if (!plainName(trimmed) || !CONSTANT_NAME.test(trimmed)) return null;
    const ownWord = Boolean(word) && trimmed.replace(/_/g, "").toLowerCase().includes(word);
    if (inCode || ownWord || !capsPassword(trimmed, false)) return "constant";
    if (/[_ -](?:level|classification|scope|audience|visibility)$/.test(settingName)) return "constant";
    return "password-like";
  }
  // A variable's name, joined with "_" or camel humps. Its kind says what VALUE_TABLE needs to tell a variable from a
  // weak password a person typed, since after a password's name the two can look the same.
  function variableName(context) {
    const { near, trimmed, closers, after, inCode, word } = codeFacts(context);
    if (!plainName(trimmed)) return null;
    const flat = trimmed.replace(/_/g, "").toLowerCase();
    const ownWord = Boolean(word) && flat.includes(word);
    const snakeCase = /_/.test(trimmed);
    if (!snakeCase && !/^[a-z]+[A-Z]/.test(trimmed)) return "password-like";
    if (!ownWord && !/password|token|secret/.test(flat)) return "joined-words";
    // Whatever the label, such a name is the variable unless it stands on a bare line ("token: newPassword, email })"
    // is code; "password: dbPassword" is a weak password).
    if (inCode) return "variable";
    const lineRest = closers + (near.rest != null ? near.rest : near.after || "");
    if (!bareLine(near, lineRest) || variableInCode(near, after)) return "variable";
    if (CODE_SECRET_NAME.test(flat) && !WEAK_PASSWORD_NAME.test(flat)) return "code-name";
    if (PASSWORD_THEN_CODE.test(flat)) return "code-name";
    // A name holding a password's word (newPassword, dbPassword) reads as a weak password only on a bare
    // "password: dbPassword" line. Any sign of code or settings around it makes it the variable, and so does snake
    // case (my_password), which is how a variable is written rather than a password.
    const setAsVariable = /pass|pwd/.test(flat) && ((ownWord && snakeCase) || !bareLabel(near, after));
    // A weak password reads like a variable: oldPassword, currentPassword, authPassword. So does a name holding the
    // label's own word: githubToken, webhookSecret, adminPassword.
    const ownOrWeak = ownWord || CODE_SECRET_NAME.test(flat);
    if (setAsVariable) return ownOrWeak ? "variable" : "password-variable";
    return ownOrWeak ? "own-name" : "password-like";
  }

  // ---------- Judging a setting's value ----------

  // ── Storage keys and setting records ──
  // A storage key's name under a token's _KEY constant, like TOKEN_KEY = 'app:authToken' or token_key = "auth_token",
  // is the name a token is kept under, not the token. It's words joined by ":", ".", "_" or capitals, one of them a
  // token, auth or session word and every one from the short list storage keys are made of. Random letters or a
  // passphrase like riverAuthCopperHarbor hold other words, so they're still read as secrets. API_KEY, SECRET_KEY or
  // PASSWORD_KEY name a secret itself, so they aren't read this way.
  const STORAGE_NAME_WORD = /^(?:token|tokens|auth|session|jwt|app|myapp|my|store|user|access|refresh|id|oidc)$/;
  function storageKeyName(reading, value) {
    if (!reading.storageKey) return false;
    const parts = value.split(/[:._]/);
    if (!parts.every((p) => /^[a-z]+(?:[A-Z][a-z]+)*$|^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(p))) return false;
    const words = parts.flatMap((p) => p.split(/(?=[A-Z])/)).map((w) => w.toLowerCase());
    if (words.length < 2 || !words.every((w) => STORAGE_NAME_WORD.test(w))) return false;
    return words.some((w) => STORAGE_KEY_WORDS.has(w));
  }
  // The name in a label's text, cut at its ":" or "=": "password" in `"password": "…"` and in `config["password"] = …`.
  const labelName = (labelText) =>
    labelText
      .replace(/\??\s*(?::\s*(?:string|str)\s*)?[:=][\s\S]*$/, "")
      .replace(/["'\]\s]+$/, "")
      .replace(/^.*\[["']?/, "");
  // The record of one setting that every label judge reads: its name, its value, where the value starts (`at`), the
  // shape it was written in, whether it's quoted and what's around it. `from` is where the setting starts in `text`.
  function settingRecord(text, { name, value, at, end = at + value.length, shape, from, labelPart }) {
    return {
      name,
      value,
      at,
      shape,
      quoted: Boolean(QUOTE_CLOSE[text[at - 1]]),
      around: {
        before: lineBefore(text, from),
        after: text.slice(end, end + 40),
        rest: text.slice(end, end + 400),
        ini: INI_SECTION.test(text.slice(Math.max(0, from - 2000), from)),
        assigned: /\s=/.test(labelPart),
        equals: /=/.test(labelPart),
        quotedKey: /["']\]?\s*(?:\??:|=)/.test(labelPart),
        tight: /:["']?$/.test(labelPart),
        enclosed: insideCode(text, from),
      },
    };
  }
  // What the label judges read around a value. A scheme's credential is judged on the line before its label, what
  // follows it and whether it sits in code, not on how the label in front of the scheme word was written.
  function judgedAround(record) {
    if (record.shape !== "label-scheme") return { ...record.around, quoted: record.quoted };
    const { before, after, enclosed } = record.around;
    return { before, after, enclosed };
  }
  // What the value readers read around a value, worked out once: the setting, what its name says (`reading`), what's
  // around it, and the value less a sentence's end marks (`trimmed`).
  function valueContext(record, reading) {
    return {
      record,
      reading,
      around: judgedAround(record),
      trimmed: record.value.trim().replace(/[.,;:!?)\]}>]+$/, ""),
    };
  }

  // ── Value readers ──
  // Each returns the value's kind when it fits, or null.
  // A storage key's name (app:authToken) is a kind only under a name a token is kept under, like TOKEN_KEY.
  const storedName = ({ reading, trimmed }) => (storageKeyName(reading, trimmed) ? "stored-name" : null);
  const notASecretWord = ({ trimmed }) => (NOT_A_SECRET_VALUE.test(trimmed) ? "not-a-secret" : null);
  const yamlTag = ({ trimmed }) => (YAML_TAG.test(trimmed) ? "yaml-tag" : null);
  const domainName = ({ trimmed }) => (DOMAIN_VALUE.test(trimmed) ? "domain" : null);
  // A key file named by its path is where the key is kept, not the key: apiKey: ./certs/server.pem. A key that
  // starts with "/" (base64 can) has no ".pem" at its end, so it is still read.
  const KEY_FILE_PATH = /[/\\][^\s/\\]*\.(?:pem|crt|cer|pfx|p12|key|json)$/i;
  const keyFilePath = ({ reading, trimmed }) =>
    reading.kind === "key" && KEY_FILE_PATH.test(trimmed) ? "domain" : null;
  const unitNumber = ({ trimmed }) => (UNIT_NUMBER.test(trimmed) ? "unit-number" : null);
  const placeholderConstant = ({ trimmed }) =>
    CONSTANT_NAME.test(trimmed) && PLACEHOLDER_CONSTANT.test(trimmed) ? "placeholder" : null;
  // A quoted value is a string, not code that names the secret: password = "superSecret". A quoted constant's name
  // is still a placeholder, an enum's value or the name of a setting (session_secret_env = "SESSION_SECRET",
  // "password": "NOT_SET", token: "MY_API_KEY"), unless it's a password typed in capitals: password: "SUPER_SECRET".
  function quotedValue({ record, around, trimmed }) {
    if (!around.quoted) return null;
    if (!CONSTANT_NAME.test(trimmed)) return "string";
    const { word } = readName(record.name.toLowerCase());
    const ownWord = Boolean(word) && trimmed.replace(/_/g, "").toLowerCase().includes(word);
    return ownWord || !capsPassword(trimmed, true) ? "constant" : "password-like";
  }
  const VALUE_READERS = [
    storedName,
    notASecretWord,
    yamlTag,
    domainName,
    keyFilePath,
    unitNumber,
    placeholderConstant,
    quotedValue,
    declaredType,
    ownType,
    codeCall,
    memberChain,
    constantName,
    variableName,
  ];
  // The value's kind from the first reader that fits, or "other". A value can fit two readers, like "NOT_SET" (a
  // placeholder and a constant), so the order is part of the answer.
  function readValue(record, reading = readName(record.name)) {
    const context = valueContext(record, reading);
    for (const reader of VALUE_READERS) {
      const kind = reader(context);
      if (kind) return kind;
    }
    return "other";
  }
  // Whether a value told after a secret's label isn't the secret, from the name's role and the value's kind in
  // VALUE_TABLE. A name about the secret (password_hint) is quiet whatever its value, so its value isn't read.
  function labelledNotSecret(record) {
    const reading = readName(record.name);
    const role = valueRole(reading);
    if (QUIET_ROLES.has(role)) return true;
    return valueAnswer(role, readValue(record, reading)) === QUIET;
  }

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    plainName,
    storageKeyName,
    labelName,
    settingRecord,
    readValue,
    labelledNotSecret,
  };
})();
