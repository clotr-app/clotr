// Every setting read by its name, in YAML, JSON, XML, .env and code, including values one level under a name.
(() => {
  "use strict";

  const {
    isPlaceholder,
    QUOTE_CLOSE,
    wholeValue,
    LOOKUP_TOKEN_LABEL,
    LOOKUP_KEY_LABEL,
    nameRole,
    roleNameValueReads,
    SECRET_WORD_AT_END,
    camelSecretName,
    STORAGE_KEY_NAME,
    PAIR,
    CAMEL_PAIR,
    CAMEL_XML_PAIR,
    VALUE_ROWS,
    NAME_SPLIT,
    readName,
    LABELLED_SECRET,
    LABELLED_API_KEY,
    storageKeyName,
    settingRecord,
    labelledNotSecret,
    keyLike,
    hexKey,
    looksLikePath,
    SETTING_CALL,
    ATTR_PAIR,
    HCL_DEFAULT,
    YAML_BLOCK,
    camelValueCouldBeRead,
    SECRET_LABEL_AT_START,
    twinIsSecretLabel,
    camelValueNamesSomething,
    camelPasswordLacksShape,
    pascalPasswordShape,
  } = globalThis.ClotrInternal;

  // ---------- Settings under a name ----------

  // ── Values one level under a YAML name ──
  // A YAML name with nothing after its ":" can hold its value one level under it: a CloudFormation parameter's
  // Default:, a Helm value:, a text: or a list item. These are the keys read under such a name. Any other key under
  // it (Type:, description:, secretKeyRef:) describes the secret or says where it's kept, and isn't read.
  const UNDER_NAME_KEYS = [
    { key: "value", reads: /^value$/i },
    { key: "default", reads: /^default$/i },
    { key: "text", reads: /^text$/i },
    { key: "list item", reads: /^-$/ },
  ];
  const UNDER_NAME = /(?:^|\n)([^\S\r\n]*)([\w.-]{1,60})[^\S\r\n]*:[^\S\r\n]*(?:#[^\r\n]*)?(?=\r?\n)/g;
  const UNDER_NAME_LINE = /^([^\S\r\n]*)(?:(-)[^\S\r\n]+|([\w.-]{1,60})[^\S\r\n]*:[^\S\r\n]+)([^\r\n]*)$/;
  // A name is read only when its own line would be: "password:" and "db_password:", but not a bare "key:".
  const UNDER_NAME_LABELS = [LABELLED_SECRET, LABELLED_API_KEY].map((re) => new RegExp(`^(?:${re.source})$`, "i"));
  // Lines read under one name, so a long block costs each name only a few lines.
  const UNDER_NAME_LINES = 40;
  // The value that starts a line's rest, read as a label's value is: its first run, then as far as wholeValue takes it.
  function valueAt(text, restAt) {
    const at = restAt + (QUOTE_CLOSE[text[restAt]] ? 1 : 0);
    const first = /^[^\s"',;]+/.exec(text.slice(at, at + 256));
    return first ? { value: wholeValue(text, at, first[0]), at } : null;
  }
  // A camelCase or PascalCase name (DbPassword, PasswordHint) read as its snake_case twin, so the about checks see
  // its words.
  const snakeTwin = (name) =>
    /[a-z0-9][A-Z]/.test(name) ? name.split(NAME_SPLIT).filter(Boolean).join("_").toLowerCase() : name;
  // The keyed lines one level under a name line `m`: only lines at the first line's depth under it, up to the first
  // line back at the name's depth or less. Each gives the line's start and its parsed key and rest.
  function linesUnderName(text, m) {
    const lines = [];
    let lineStart = text.indexOf("\n", m.index + m[0].length) + 1;
    let depth = null;
    for (let n = 0; lineStart > 0 && n < UNDER_NAME_LINES; n++) {
      const lineEnd = text.indexOf("\n", lineStart);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, "");
      const indent = /^[^\S\r\n]*/.exec(line)[0].length;
      if (line.trim()) {
        if (indent <= m[1].length || (depth !== null && indent < depth)) break;
        if (depth === null) depth = indent;
        const child = indent === depth && UNDER_NAME_LINE.exec(line);
        if (child) {
          lines.push({ key: child[2] || child[3], rest: child[4], restAt: lineStart + line.length - child[4].length });
        }
      }
      lineStart = lineEnd < 0 ? 0 : lineEnd + 1;
    }
    return lines;
  }
  // What a name says about the value under it, as its role words say on its own line: "points" for a name that says
  // where a secret is kept (password_ref, secret_arn, existing_secret), else "holds".
  function underNameRole(name) {
    const named = SECRET_WORD_AT_END.exec(name);
    if (/^existing_/i.test(name) || (named && nameRole(named[1]) === "points")) return "points";
    return "holds";
  }
  // Whether a snake_case name is a lookup's, as its own line's labels read it: a page token, or a cache, sort or bucket
  // key that the password label doesn't read either, and that isn't holding a cloud key or a primary key's hex.
  function underNameLookup(name, value) {
    const nameLabel = `${name}:`;
    if (LOOKUP_TOKEN_LABEL.test(nameLabel)) return true;
    if (!LOOKUP_KEY_LABEL.test(nameLabel) || SECRET_LABEL_AT_START.test(`${nameLabel} x`)) return false;
    const cloudKey = /^[A-Za-z0-9+/]{40,88}={0,2}$/.test(value) && keyLike(value);
    const primary = /\bprimary[ _.-]key\b/i.test(nameLabel) && ((hexKey(value) && !isPlaceholder(value)) || cloudKey);
    return !primary && !(/(?:storage|s3)[ _.-]key\b/i.test(nameLabel) && cloudKey);
  }
  // The settings one level under a name with nothing after its ":", each as the record of the name and the value under
  // it. Only the keys in UNDER_NAME_KEYS are read, and not one whose value is a key of its own (`- name: x`). A
  // camelCase or PascalCase name's record keeps it as camelName, so readSettingsByName can give it the camelCase
  // reader's checks too.
  function settingsUnderName(text) {
    const records = [];
    for (const m of text.matchAll(UNDER_NAME)) {
      const name = snakeTwin(m[2]);
      if (!readName(name, PAIR).kind || !UNDER_NAME_LABELS.some((re) => re.test(`${name}: Qz7wPq`))) continue;
      const from = m.index + (m[0].startsWith("\n") ? 1 : 0);
      for (const line of linesUnderName(text, m)) {
        const read = UNDER_NAME_KEYS.some((row) => row.reads.test(line.key));
        if (!read || /^[\w.-]{1,60}:(?:\s|$)/.test(line.rest)) continue;
        const found = valueAt(text, line.restAt);
        if (!found) continue;
        const record = settingRecord(text, { name, ...found, from, shape: "yaml-under", labelPart: `${name}: ` });
        records.push(name === m[2] ? record : { ...record, camelName: m[2] });
      }
    }
    return records;
  }

  // ---------- Reading every setting ----------

  // ── Every setting read by its name ──
  const settingKind = ({ name }) => readName(name, PAIR).kind;
  // These structural finders see a camelCase label in common config markup. The name table alone decides what it says.
  const CAMEL_YAML_SETTING = /(?:^|\n)[^\S\r\n]*([a-z][A-Za-z0-9]{1,59})[^\S\r\n]*:[^\S\r\n]*([^\r\n]{4,256})/g;
  const CAMEL_JSON_SETTING = /"([a-z][A-Za-z0-9]{1,59})"[^\S\r\n]*:[^\S\r\n]*"([^"\r\n]{4,256})"/g;
  const CAMEL_XML_SETTING = /<([a-z][A-Za-z0-9]{1,59})>([^<\r\n]{4,256})<\/\1>/g;
  // The password and key checks both read the same text's settings, so the last text's list is kept.
  let lastSettingsText = null;
  let lastSettings = null;
  function namedSettings(text) {
    if (text !== lastSettingsText) {
      lastSettings = readSettingsByName(text);
      lastSettingsText = text;
    }
    return lastSettings;
  }
  function readSettingsByName(text) {
    const out = [];
    // `at` is where the value starts: `tail` characters before the match's end.
    const push = (m, shape, name, value, tail) => {
      const at = m.index + m[0].length - tail;
      const record = settingRecord(text, { name, value, at, shape, from: m.index, labelPart: text.slice(m.index, at) });
      const kind = settingKind(record);
      if (kind) out.push({ kind, value, record });
    };
    for (const m of text.matchAll(SETTING_CALL)) push(m, "call", m[2], m[4], m[4].length + 1);
    for (const m of text.matchAll(ATTR_PAIR)) push(m, "attribute", m[2], m[4], m[4].length + 1);
    for (const m of text.matchAll(HCL_DEFAULT)) push(m, "hcl-default", m[1], m[2], m[2].length + 1);
    // A PEM key under "private_key: |" is the private key kind's, whole.
    for (const m of text.matchAll(YAML_BLOCK)) {
      if (m[3].length > m[1].length && !m[4].startsWith("-----")) push(m, "yaml-block", m[2], m[4].trim(), m[4].length);
    }
    // A config repeats its names, so each name's reading is kept unless a row that reads the value could answer.
    const readings = new Map();
    const camelReading = (name, role, value) => {
      const key = `${role}\n${name}`;
      if (readings.has(key)) return readings.get(key);
      const reading = readName(name, role, value);
      const readAs = name.split(NAME_SPLIT).filter(Boolean).join("_");
      if (!VALUE_ROWS.some((r) => r.role === role && r.shape.test(readAs))) readings.set(key, reading);
      return reading;
    };
    // The camelCase reader's checks on a value under a camelCase name, the same on the name's own line and one level
    // under it. Gives the name's reading, or null when the value isn't read.
    const camelValueReading = (name, value, at, role = CAMEL_PAIR, asKind) => {
      if (!camelSecretName(name)) return null;
      if (role === CAMEL_XML_PAIR && /[/:.]/.test(value)) return null;
      const named = camelReading(name, role, value);
      if (!named.kind || named.about) return null;
      const reading = asKind ? { ...named, kind: asKind } : named;
      // A token's storage key holding a stored name (accessTokenKey: app:authToken), as its twin's label reads it.
      const readAs = name.split(NAME_SPLIT).filter(Boolean).join("_");
      if (storageKeyName({ storageKey: STORAGE_KEY_NAME.test(readAs) }, value.trim())) return null;
      // A key name's path, like privateKey: ./certs/server.pem, names the file the key is in.
      if (reading.kind === "key" && looksLikePath({ value }) && !twinIsSecretLabel(name)) return null;
      // A quoted sentence is a message or a hint, as the snake_case label reader reads one ("use the one from the
      // vault").
      const first = /^[^\s"',;]+/.exec(value);
      if (role === CAMEL_PAIR && first && /^[^\S\r\n]+\S/.test(value.slice(first[0].length))) {
        if (wholeValue(text, at, first[0]) === first[0]) return null;
      }
      // A value right after a quote or an XML tag's ">" is a plain string, where YAML reads no alias.
      const quoted = /["'>]/.test(text[at - 1] || "");
      if (camelValueNamesSomething(value) || camelPasswordLacksShape(reading.kind, value, quoted)) return null;
      if (!camelValueCouldBeRead(text, name, reading.kind, value, at)) return null;
      return reading;
    };
    const pushCamel = (shape, name, value, at, from, role = CAMEL_PAIR) => {
      const reading = camelValueReading(name, value, at, role);
      if (!reading) return;
      const record = settingRecord(text, { name, value, at, shape, from, labelPart: text.slice(from, at) });
      if (labelledNotSecret(record)) return;
      out.push({ kind: reading.kind, value, record, camel: true });
    };
    // A value under a camelCase or PascalCase name is read only when the camelCase reader would read it on the name's
    // own line, with the name's reading or, where its snake_case twin is a password's name (apiSecret), as a
    // password. Live reads a PascalCase name's own line (DbPassword:) only through its labels, so under one the value
    // also needs a password's shape: a digit and a password's mark, or a random key in mixed case. A KMS key id or a
    // commit hash under SecretKmsKey or SourceToken is neither.
    const underCamelReads = (name, value, at, kind) => {
      const camel = name[0].toLowerCase() + name.slice(1);
      const kinds = kind === "password" ? [undefined, kind] : [undefined];
      if (!kinds.some((k) => camelValueReading(camel, value, at, CAMEL_PAIR, k))) return false;
      return camel === name || pascalPasswordShape(value);
    };
    // A value one level under its name is judged by the checks its snake_case twin's own line uses: a lookup name
    // (next_token, s3_key) stays a lookup, and the value is read only when it's shaped like a password or a key under
    // the name's role (roleNameValueReads). A path, a link or joined words under the name say where the secret is kept
    // as often as they hold it, and under a name that points at a secret (password_ref, existing_secret) so does a
    // capitalised name with a number. Under a camelCase or PascalCase name (SecretKmsKey, PasswordRef, clientSecret)
    // the camelCase reader's checks for that name's own line have to read the value too.
    for (const record of settingsUnderName(text)) {
      const { name, value, camelName } = record;
      if (!roleNameValueReads(value, underNameRole(name)) || underNameLookup(name, value)) continue;
      const kind = settingKind(record);
      if (camelName && !underCamelReads(camelName, value, record.at, kind)) continue;
      if (kind && !labelledNotSecret(record)) out.push({ kind, value, record });
    }
    for (const m of text.matchAll(CAMEL_YAML_SETTING)) {
      const name = m[1];
      if (!camelSecretName(name)) continue;
      const raw = m[2];
      if (raw.trimStart().startsWith("=") || /[,;]$/.test(raw.trimEnd())) continue;
      const rawAt = m.index + m[0].length - raw.length;
      const trimmed = raw.trimStart();
      const leading = raw.length - trimmed.length;
      const quote = QUOTE_CLOSE[trimmed[0]];
      const at = rawAt + leading + (quote ? 1 : 0);
      // Unquoted, the value is its first word, read on as the snake_case label reader reads it, so a sentence or a
      // type after the name ("set this in the dashboard first", "string | null") isn't taken whole.
      const rawValue = quote ? trimmed.slice(1).split(quote, 1)[0] : (/^[^\s"',;]+/.exec(trimmed) || [""])[0];
      if (!rawValue || /^!/.test(rawValue) || /^\$\{/.test(rawValue)) continue;
      const value = wholeValue(text, at, rawValue);
      const from = m.index + m[0].indexOf(name);
      pushCamel("camel-yaml", name, value, at, from);
    }
    for (const m of text.matchAll(CAMEL_JSON_SETTING)) {
      const value = m[2];
      const at = m.index + m[0].lastIndexOf(value);
      pushCamel("camel-json", m[1], value, at, m.index);
    }
    for (const m of text.matchAll(CAMEL_XML_SETTING)) {
      const value = m[2];
      const at = m.index + m[0].indexOf(value);
      pushCamel("camel-xml", m[1], value, at, m.index, CAMEL_XML_PAIR);
    }
    return out;
  }

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, namedSettings };
})();
