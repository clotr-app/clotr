// What a setting's name says about its value: a secret's word, a lookup key, a reference, or nothing secret.
// The settings readers and the secret reader read names through readName().
(() => {
  "use strict";

  const { looksRandom, looksRandomHex, ruleTable } = globalThis.ClotrInternal;

  // ---------- Reading a setting's name ----------

  // ── Keys that look something up ──
  // A key named for what it looks up rather than what it unlocks, like a cache, sort, partition or idempotency key or
  // a table's primary key, holds a hash or an ID, and "Cache saved with key: …" is a line of a CI log. A primary key
  // in an Azure portal can still be a real credential, so keep that label when its value has an Azure key shape. A
  // translation, message, Redis, bucket, React, storage, env, feature-flag, hash, map or registry key names a thing
  // too, and the key in a websocket handshake's own header (sec-websocket-key) is a one-time nonce. Only said ones
  // count: a setting named S3_KEY or STORAGE_KEY can hold the real key, and so can WEBSOCKET_KEY.
  const LOOKUP_KEY_WORDS =
    String.raw`cache|caching|sort|partition|primary|foreign|composite|object|idempotency|dedup(?:e|lication)?|` +
    String.raw`lookup|row|routing|shard|range|index|search|unique|etag|checksum|with|from|by`;
  const LOOKUP_KEY_WORD = `(?:${LOOKUP_KEY_WORDS})`;
  const SAID_ONLY_KEY_WORDS =
    String.raw`translation|i18n|l10n|locale|message|msg|redis|s3|react|storage|env|flag|hash|map|dict|registry|` +
    String.raw`sec[ _.-]?websocket`;
  const SAID_LOOKUP_KEY_WORD = `(?:${LOOKUP_KEY_WORDS}|${SAID_ONLY_KEY_WORDS})`;
  // A quote or "]" and anything but letters and digits after the label, up to the end.
  const LABEL_END = String.raw`["'\]]?[^A-Za-z0-9]*$`;
  // A page, cursor or CSRF token, or a model's padding and end-of-text tokens, is not a credential someone can reuse.
  const NOT_REUSABLE_TOKENS = "next|page|continuation|pagination|cursor|csrf|xsrf|pad|eos|bos|unk|sep|cls|mask";
  const LOOKUP_TOKEN_LABEL = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9])(?:${NOT_REUSABLE_TOKENS})[ _.-]token${LABEL_END}`,
    "i",
  );
  // The word before "key" or "token" that makes it a credential whatever its value looks like.
  const CREDENTIAL_WORDS =
    "api|access|secret|private|license|licence|product|service|auth|client|master|signing|encryption|account|" +
    "admin|deploy|app|bearer|refresh|session|personal|bot|webhook";
  const CREDENTIAL_KEY_LABEL = new RegExp(String.raw`(?:${CREDENTIAL_WORDS})[ _.-]?(?:key|token)${LABEL_END}`, "i");
  // A value made of words and short numbers names something (user:12345:session:v2, home.hero.title_2024,
  // ERR_TOKEN_EXPIRED_401, HKEY_LOCAL_MACHINE\SOFTWARE\…), and a file path ends in an extension. A key has random
  // parts.
  const NAMED_PART = /^(?:[a-z]+|[A-Z][a-z]+|[A-Za-z]+\d{1,4}|\d{1,8}|\d{1,4}[A-Za-z]{1,2})$/;
  function namedValue(value) {
    if (/^HKEY_[A-Z_]+\\/.test(value)) return true;
    if (/^[A-Z]+(?:_[A-Z]+\d{0,4}|_\d{1,4}){2,}$/.test(value)) return true;
    if (/^[\w.-]*(?:\/[\w.-]+)+\.[a-z][a-z0-9]{0,4}$/i.test(value) && !/\/\//.test(value)) return true;
    const parts = value.split(/[:._/#\\-]/);
    if (parts.length < 2 || !parts.every((part) => NAMED_PART.test(part))) return false;
    return parts.some((part) => /[a-z]{3}/i.test(part));
  }
  const valueRepeatsName = (value, name) => {
    if (!namedValue(value)) return false;
    const words = name.toLowerCase().split("_");
    const parts = value
      .toLowerCase()
      .split(/[:._/#\\-]/)
      .filter(Boolean);
    return words.some((_, start) => words.every((word, index) => parts[start + index] === word));
  };
  const LOOKUP_KEY_LABEL = new RegExp(
    String.raw`(?:^|[^A-Za-z0-9])${SAID_LOOKUP_KEY_WORD}[ _.-]key["'\]]?[^A-Za-z0-9]*(?:(?:string|str)[^A-Za-z0-9]*)?$`,
    "i",
  );
  // Whether a setting's name labels a password someone typed, so its value gets the typed placeholder rules. A name
  // ending in ref, reference or arn, or a value starting "arn:", says where the password is kept instead.
  const typedPasswordLabel = (name, value = "", kind) => {
    if ((kind ?? readName(name).kind) !== "password") return false;
    if (/(?:ref|reference|arn)$/.test(name.toLowerCase())) return false;
    return !value.trim().toLowerCase().startsWith("arn:");
  };
  // A camelCase name's snake_case twin, as the label patterns read it: apiKeyRef is api_Key_Ref.
  function twinName(name) {
    return name.split(NAME_SPLIT).filter(Boolean).join("_");
  }
  const LOOKUP_KEY_NAME = new RegExp(String.raw`(?:^|[_.-])${LOOKUP_KEY_WORD}[_.-]key$`, "i");

  // ── What a setting's name says ──
  // What a setting's name says, read in one place. readName cuts the name into words and reads it against these tables.
  // The words that name a secret, by kind. A "+" in one is where "_", " ", "-" or nothing can join its parts.
  const SECRET_WORDS = {
    password:
      "password passwd pwd pass pw passcode passphrase pin contraseña contrasena clave pgpassword pgpass sshpass",
    key: "secret token api+key key",
  };
  const PASSWORD_WORDS = new Set(SECRET_WORDS.password.split(" "));
  // A setting named after a secret is often about the secret rather than holding it: token_limit, pin_memory,
  // PASSWORD_RESET_TIMEOUT, api_key_header, password_hash_algorithm. These words after the secret's name mark that.
  // A place or a person (_prod, _db, _admin, _root, _user) still names the secret itself, so those aren't here.
  const ABOUT_THE_SECRET = new Set(
    (
      "count limit budget ttl timeout expiry expires expiration lifetime age duration interval window " +
      "type types id ids rate fail failed length len min max size header headers required field " +
      "fields algorithm algo memory policy url uri endpoint path file dir name names hash hashed " +
      "hasher hashers version threshold digits layout prefix suffix param params regex pattern label " +
      "placeholder hint reset mode format enabled enable disabled flag style text message msg error " +
      "title description help input class kind schema strategy scheme method provider store manager " +
      "location source rotation validator validation validators strength complexity retries attempts"
    ).split(" "),
  );
  // The words that can follow a secret's word in a name and still name that secret, and what each says the value is.
  // "holds": the secret itself (passwordValue, SecretValue). "points": the secret, or where it's kept (apiKeyRef,
  // password_reference, secretArn). Other words after the secret's (secretName, UserSecretsId) aren't here. A new word
  // is a row here. It's a function so the label and markup patterns built further up the file can read it.
  function nameRoleWords() {
    return { value: "holds", ref: "points", reference: "points", arn: "points" };
  }
  const NAME_ROLE_WORDS = new Map(Object.entries(nameRoleWords()));
  // The role words as a pattern's alternatives: "value|ref|reference|arn".
  function nameRoleAlternatives() {
    return Object.keys(nameRoleWords()).join("|");
  }
  // What the words after a secret's word say ("_ref", "Value", ".arn"), by NAME_ROLE_WORDS, or null when there are
  // none or one of them isn't a role word. A name with a "points" word anywhere in its tail points.
  function nameRole(tail) {
    const words = tail
      .split(/[._\- ]+|(?<=[a-z0-9])(?=[A-Z])/)
      .filter(Boolean)
      .map((word) => word.toLowerCase());
    if (!words.length || !words.every((word) => NAME_ROLE_WORDS.has(word))) return null;
    return words.some((word) => NAME_ROLE_WORDS.get(word) === "points") ? "points" : "holds";
  }
  // Under a role word, a value is read only when it's shaped like a password or a key. Words joined by dashes
  // (stripe-live-key, copper-meadow-falcon) are as often the name of the secret as the secret, and a path, an ARN, a
  // link, a member chain or a template ("vault/prod/db", "arn:aws:…", "process.env.KEY", "${KEY}") says where it is.
  // So the value is random like a key, or has three of small letters, capitals, digits and other marks. Under a
  // "points" word, capitalised words and a number (OrdersDb2024, KeyVaultSecret01) name a thing.
  function roleNameValueReads(value, role) {
    const trimmed = value.trim();
    if (trimmed.length < 8 || /[\s/:.$<>{}]/.test(trimmed)) return false;
    if (role === "points" && /^[a-z]*(?:[A-Z][a-z]+)+\d{1,4}$/.test(trimmed)) return false;
    if (looksRandom(trimmed) || looksRandomHex(trimmed)) return true;
    const marks = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9_-]/];
    return marks.filter((re) => re.test(trimmed)).length >= 3;
  }
  // Whether a setting's name ends in a secret's word and then role words, and its value reads under that name.
  function roleNameReads(name, value) {
    const named = SECRET_WORD_AT_END.exec(name);
    const role = named && nameRole(named[1]);
    return Boolean(role) && roleNameValueReads(value, role);
  }
  // A count before the secret's word makes the name a number of them: max_tokens_key, num_api_key.
  const COUNT_WORDS = new Set(["max", "min", "num", "total", "count"]);
  const spelled = (words, join) =>
    words
      .split(" ")
      .map((word) => word.replace(/\+/g, join))
      .join("|");
  // The secret's word at the end of a name, with any "_word" parts after it: "password" and "_hint" in password_hint.
  const SECRET_WORD_AT_END = new RegExp(
    String.raw`(?:${spelled(`${SECRET_WORDS.password} ${SECRET_WORDS.key}`, "[_ -]?")})((?:_[a-z0-9]+)*)$`,
    "i",
  );
  // A camelCase name with a secret's word somewhere in it, the only names readName can read as a secret's.
  const SECRET_WORD_ANYWHERE = new RegExp(spelled(`${SECRET_WORDS.password} ${SECRET_WORDS.key}`, "[_ -]?"), "i");
  const camelSecretName = (name) => /[a-z][A-Z]/.test(name) && SECRET_WORD_ANYWHERE.test(name);
  // The same for a camelCase name cut at its humps: the secret's word starts a hump, so "bypass_Cache" holds no "pass".
  const CAMEL_SECRET_WORD_AT_END = new RegExp(
    String.raw`(?<![a-z0-9])(?:${spelled(`${SECRET_WORDS.password} ${SECRET_WORDS.key}`, "[_ -]?")})((?:_[a-z0-9]+)*)$`,
    "i",
  );
  // A secret's word as a whole word: "password" in mariadb-root-password, "Secret" in SecretsManager.
  const SECRET_WORD_WHOLE = new RegExp(`^(?:${spelled(`${SECRET_WORDS.password} ${SECRET_WORDS.key}`, "")})$`, "i");
  // The words a storage key's name has before "_key", like TOKEN_KEY or auth_key: a name a token is kept under.
  const STORAGE_KEY_WORDS = new Set(["token", "tokens", "auth", "session", "jwt"]);
  const STORAGE_KEY_NAME = new RegExp(String.raw`(?:^|_)(?:${[...STORAGE_KEY_WORDS].join("|")})_key$`, "i");
  // Where a place reads a name differently from readName, a row here gives the name's shape, the place's role and its
  // answer, a secret's kind or null. The first row of the role whose shape fits the name answers.
  // A setting pair (a setter call, an attribute pair, an HCL default, a YAML block) reads its words anywhere in the
  // name, and knows other words.
  const PAIR = "setting-pair";
  const CAMEL_PAIR = "camel-setting-pair";
  const CAMEL_XML_PAIR = "camel-xml-setting-pair";
  const NAME_OVERRIDES = [
    {
      shape: new RegExp(spelled("csrf xsrf authenticity nonce pub+key public+key publishable+key", "[_.-]?"), "i"),
      role: [PAIR, CAMEL_PAIR],
      answer: null,
    },
    // A camelCase siteKey is a public site key. A setter call's "site_key" keeps its own reading.
    { shape: /(?<![a-z0-9])site_key(?![a-z0-9])/i, role: CAMEL_PAIR, answer: null },
    { shape: /^access_token_expires_in$/i, role: CAMEL_PAIR, answer: null },
    {
      shape: new RegExp(spelled("client+secret access+token admin+password password+secret", "[_.-]?"), "i"),
      role: CAMEL_PAIR,
      valueMatches: valueRepeatsName,
      answer: null,
    },
    { shape: /^db_password$/i, role: CAMEL_PAIR, valueMatches: /^change-me-later$/i, answer: null },
    {
      shape: new RegExp(spelled("existing+secret pull+secret image+pull+secret tls+secret", "[_.-]?"), "i"),
      role: CAMEL_PAIR,
      answer: null,
    },
    {
      shape: new RegExp(spelled("client+secret access+token secret+value", "[_.-]?"), "i"),
      role: CAMEL_PAIR,
      answer: "password",
    },
    // apiKeyRef, secretArn and a key name with role words after it (stripeKeyRef) are read only for a value that
    // reads under them (roleNameReads), as the snake_case twin's label is.
    {
      shape: new RegExp(
        `${spelled("api+key+ref secret+arn", "[_.-]?")}|(?:^|_)key(?:_(?:${nameRoleAlternatives()}))+$`,
        "i",
      ),
      role: CAMEL_PAIR,
      valueMatches: (value, name) => !roleNameReads(name, value),
      answer: null,
    },
    {
      shape: new RegExp(spelled("token+key token+storage+key", "[_.-]?"), "i"),
      role: CAMEL_PAIR,
      answer: null,
    },
    { shape: new RegExp(spelled("password+storage+key", "[_.-]?"), "i"), role: CAMEL_PAIR, answer: null },
    { shape: new RegExp(spelled("host+key", "[_.-]?"), "i"), role: CAMEL_PAIR, answer: null },
    { shape: /^db_password$/i, role: CAMEL_XML_PAIR, answer: "password" },
    {
      shape: new RegExp(`${spelled("password passwd passphrase pwd secret", "")}|(?:^|[_.-])pass(?:$|[_.-])`, "i"),
      role: PAIR,
      answer: "password",
    },
    { shape: LOOKUP_KEY_NAME, role: [PAIR, CAMEL_PAIR], answer: null },
    {
      shape: new RegExp(`${spelled("api+key token auth+key private+key salt", "_?")}|(?:^|[_.-])key$`, "i"),
      role: PAIR,
      answer: "key",
    },
    { shape: /(?:)/, role: PAIR, answer: null },
  ];
  // The rows whose answer turns on the value as well as the name.
  const VALUE_ROWS = NAME_OVERRIDES.filter((row) => row.valueMatches);
  // Where a name splits into words: camelCase humps, dots, dashes, underscores and spaces.
  const NAME_SPLIT = /[._\- ]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
  // What a setting's name says: `word` is the secret's word run together ("apikey", "password") and `kind` its kind.
  // The rest is worked out when asked, so each caller runs only the checks it reads.
  // A `role` with rows in NAME_OVERRIDES gets the first fitting row's kind instead.
  // Whether a NAME_OVERRIDES row answers for this name: its role, its shape and, on a value row, the value.
  function overrideFits(row, role, readAs, value) {
    const roles = Array.isArray(row.role) ? row.role : [row.role];
    if (!roles.includes(role) || !row.shape.test(readAs)) return false;
    if (!row.valueMatches) return true;
    if (value == null) return false;
    return row.valueMatches instanceof RegExp ? row.valueMatches.test(value) : row.valueMatches(value, readAs);
  }
  function readName(name, role, value) {
    const camelPair = role === CAMEL_PAIR || role === CAMEL_XML_PAIR;
    const readAs = camelPair ? twinName(name || "") : name || "";
    const row = role && NAME_OVERRIDES.find((override) => overrideFits(override, role, readAs, value));
    if (row && !(camelPair && row.answer)) return { kind: row.answer, says: row.answer ? "secret" : "none", row };
    // A camelCase row that names a kind still has the about check: accessTokenTtl is about its token.
    if (row) {
      const said = CAMEL_SECRET_WORD_AT_END.exec(readAs);
      const about =
        Boolean(said) &&
        aboutTheSecret(
          readAs.slice(0, said.index),
          said[1],
          said[0]
            .slice(0, said[0].length - said[1].length)
            .replace(/[_ -]/g, "")
            .toLowerCase(),
        );
      return { kind: row.answer, says: about ? "about" : "secret", row, about };
    }
    if (role === CAMEL_XML_PAIR) return { kind: null, says: "none" };
    const named = readAs ? (camelPair ? CAMEL_SECRET_WORD_AT_END : SECRET_WORD_AT_END).exec(readAs) : null;
    const said = named ? named[0].slice(0, named[0].length - named[1].length) : "";
    const word = said.replace(/[_ -]/g, "").toLowerCase();
    return {
      word,
      kind: !named ? null : PASSWORD_WORDS.has(word) ? "password" : "key",
      get words() {
        return (readAs || "").split(NAME_SPLIT).filter(Boolean);
      },
      get about() {
        return Boolean(named) && aboutTheSecret(readAs.slice(0, named.index), named[1], word);
      },
      get storageKey() {
        return STORAGE_KEY_NAME.test(readAs);
      },
      get says() {
        return this.storageKey ? "storage-key" : this.about ? "about" : named ? "secret" : "none";
      },
    };
  }
  // Whether the words before the secret's word (cut at "_" and "-") or after it (cut at "_") say it's about the secret.
  function aboutTheSecret(before, after, word) {
    const suffix = after.toLowerCase().split("_").filter(Boolean);
    // Vault's AppRole secret_id is itself a credential.
    const secretId = word === "secret" && suffix[0] === "id";
    if (!secretId && suffix.some((part) => ABOUT_THE_SECRET.has(part))) return true;
    return before
      .toLowerCase()
      .split(/[_-]/)
      .some((part) => COUNT_WORDS.has(part));
  }

  // ---------- Read or quiet by name and value ----------

  // ── Read or quiet, by the value and the name ──
  // A setting's name in the role VALUE_TABLE reads it in: about the secret (password_hint), a password's or PIN's
  // name, another secret's name (api_key, token), or no secret's name.
  const valueRole = (reading) =>
    reading.about ? "about" : reading.kind === "password" ? "password" : reading.kind ? "key" : "none";
  const READ = "read";
  const QUIET = "quiet";
  const VALUE_ROLES = ["about", "password", "key", "none"];
  // Read or quiet for each kind readValue gives (a row) under each role (a column, in VALUE_ROLES' order). A kind
  // with no row is read. A role whose every cell is quiet doesn't read the value at all.
  // prettier-ignore
  const VALUE_TABLE = {
    //                    about     password  key       none
    "stored-name":       [QUIET,    QUIET,    QUIET,    QUIET],
    "not-a-secret":      [QUIET,    QUIET,    QUIET,    QUIET],
    "yaml-tag":          [QUIET,    QUIET,    QUIET,    QUIET],
    "domain":            [QUIET,    QUIET,    QUIET,    QUIET],
    "unit-number":       [QUIET,    READ,     QUIET,    QUIET],
    "placeholder":       [QUIET,    QUIET,    QUIET,    QUIET],
    "string":            [QUIET,    READ,     READ,     READ],
    "constant":          [QUIET,    QUIET,    QUIET,    QUIET],
    "password-like":     [QUIET,    READ,     READ,     READ],
    "type":              [QUIET,    QUIET,    QUIET,    QUIET],
    "call":              [QUIET,    QUIET,    QUIET,    QUIET],
    "member-chain":      [QUIET,    QUIET,    QUIET,    QUIET],
    "passphrase":        [QUIET,    READ,     READ,     READ],
    "joined-words":      [QUIET,    READ,     READ,     READ],
    "variable":          [QUIET,    QUIET,    QUIET,    QUIET],
    "code-name":         [QUIET,    QUIET,    QUIET,    QUIET],
    "own-name":          [QUIET,    READ,     QUIET,    QUIET],
    "password-variable": [QUIET,    QUIET,    READ,     READ],
    "other":             [QUIET,    READ,     READ,     READ],
  };
  const valueAnswer = (role, kind) => (VALUE_TABLE[kind] || VALUE_TABLE.other)[VALUE_ROLES.indexOf(role)];
  const QUIET_ROLES = new Set(
    VALUE_ROLES.filter((_role, i) => Object.values(VALUE_TABLE).every((row) => row[i] === QUIET)),
  );
  // Whether a provider's own rule reports the value, its checks included.
  const takenByItsOwnRule = (value) =>
    ruleTable().some((pattern) => {
      if (!pattern.secret || !pattern.regex) return false;
      const m = new RegExp(pattern.regex.source, pattern.regex.flags.replace(/[gy]/g, "")).exec(value);
      return Boolean(m) && (!pattern.validate || pattern.validate(m[0]));
    });

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    LOOKUP_TOKEN_LABEL,
    CREDENTIAL_KEY_LABEL,
    namedValue,
    LOOKUP_KEY_LABEL,
    typedPasswordLabel,
    twinName,
    PASSWORD_WORDS,
    ABOUT_THE_SECRET,
    NAME_ROLE_WORDS,
    nameRoleAlternatives,
    nameRole,
    roleNameValueReads,
    SECRET_WORD_AT_END,
    camelSecretName,
    SECRET_WORD_WHOLE,
    STORAGE_KEY_WORDS,
    STORAGE_KEY_NAME,
    PAIR,
    CAMEL_PAIR,
    CAMEL_XML_PAIR,
    VALUE_ROWS,
    NAME_SPLIT,
    readName,
    valueRole,
    QUIET,
    valueAnswer,
    QUIET_ROLES,
    takenByItsOwnRule,
  };
})();
