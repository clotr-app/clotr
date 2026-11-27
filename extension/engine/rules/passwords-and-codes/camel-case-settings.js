// camelCase settings, like apiKeyRef or dbPassword: when the name means a secret and the value could be one.
(() => {
  "use strict";

  const {
    PASSPHRASE,
    secretValue,
    LOOKUP_TOKEN_LABEL,
    CREDENTIAL_KEY_LABEL,
    namedValue,
    LOOKUP_KEY_LABEL,
    typedPasswordLabel,
    twinName,
    ABOUT_THE_SECRET,
    SECRET_WORD_WHOLE,
    LABELLED_SECRET,
    LABELLED_API_KEY,
    keyLike,
    hexKey,
  } = globalThis.ClotrInternal;

  // ── camelCase settings ──
  // Whether the password or key checks after namedSettings could take a camelCase setting's value, so a value they'd
  // turn down ("3600", "production") is dropped before its record is built.
  function camelValueCouldBeRead(text, name, kind, value, at) {
    // A page or cursor token (nextToken) is a lookup, as its twin's label is.
    if (LOOKUP_TOKEN_LABEL.test(`${twinName(name)}:`)) return false;
    if (kind === "key" && !twinIsSecretLabel(name)) {
      if (!twinIsKeyLabel(name)) return false;
      const secret = secretValue(value, true, 16);
      return Boolean(secret) && (keyLike(secret) || hexKey(secret));
    }
    if (kind === "key") return Boolean(secretValue(value, true, 16));
    const typed = typedPasswordLabel(name, value, kind);
    return Boolean(secretValue(value, true, 4, typed)) || PASSPHRASE.test(text.slice(at, at + 90));
  }
  // Whether LABELLED_SECRET reads a camelCase name's snake_case twin as its label, as it reads jwt_secret.
  const SECRET_LABEL_AT_START = new RegExp(String.raw`^(?:${LABELLED_SECRET.source})`, "i");
  const twinIsSecretLabel = (name) => SECRET_LABEL_AT_START.test(`${twinName(name)}: x`);
  // Whether LABELLED_API_KEY reads the twin as its label: stripe_key_ref has a word after its key, so it isn't read.
  const KEY_LABEL_AT_START = new RegExp(String.raw`^(?:${LABELLED_API_KEY.source})`, "i");
  const twinIsKeyLabel = (name) => KEY_LABEL_AT_START.test(`${twinName(name)}: x`);
  // A camelCase key name read as its snake_case twin's label is: a lookup key's name (storageKey) holds a name unless
  // the value is a cloud key, and a key not named for a credential holds a name when the value is made of words.
  function camelKeyNamesSomething(name, value) {
    const twin = twinName(name);
    if (LOOKUP_KEY_LABEL.test(twin) && !(/^[A-Za-z0-9+/]{40,88}={0,2}$/.test(value) && keyLike(value))) return true;
    return !CREDENTIAL_KEY_LABEL.test(twin) && namedValue(value);
  }
  // Whether a camelCase setting's value names something rather than holding a secret. A config written in camelCase
  // names things in its values too: a Secret (pg-creds), a key inside one (admin-password), an env or vault reference
  // (env:TOKEN, vault:secret/data/db, ref+vault://secret/db#pass), an id (userId), a service (SecretsManager),
  // another setting (adminPassword) or a resource and its year (OrdersDb2024). Weak passwords of the same shapes
  // (MyPassword1, SuperSecret) go quiet here too. Under a key setting, digits in joined words and marks are still
  // read. Under a password setting, camelPasswordLacksShape reads only a digit with a password's mark, or a random
  // key.
  function camelValueNamesSomething(value) {
    const trimmed = value.trim();
    if (/^[a-z][a-z0-9+]*:(?:\/\/)?[A-Za-z][A-Za-z_]*(?:[/.#-][A-Za-z_]+)*$/.test(trimmed)) return true;
    if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(trimmed)) {
      const parts = trimmed.split(/[-_.]/);
      if (!/\d/.test(trimmed) && parts.length <= 3) return true;
      return parts.some(isSecretWord) || ABOUT_THE_SECRET.has(parts[parts.length - 1]);
    }
    const humps = /^[A-Za-z][a-z]*(?:[A-Z][a-z]+)+(\d{0,4})$/.exec(trimmed) && trimmed.split(/(?=[A-Z])/);
    if (!humps) return false;
    if (!/\d$/.test(trimmed)) return true;
    const words = humps.map((hump) => hump.replace(/\d+$/, ""));
    return words.slice(1).some((word) => isSecretWord(word) || word.length === 2);
  }
  // ── A camelCase password's shape ──
  // A password's own marks. A name, path, link, env reference or template joins its parts with the others
  // (- _ . / : + @ = $ { }), so those don't count.
  const PASSWORD_MARK = /[!#%^&*?~]/;
  // Whether a camelCase password, secret or token setting (dbPassword, passwordRef, clientSecret, accessToken) holds
  // something without a real password's shape. Only a value with a digit and a password's mark, or a random key, is
  // read there. Anything else is most often a name (pg-creds-v2, vault:secret/data/db1, orders-db-2024). A version
  // range or a hash's digest is a name too, and the marks that join a name's parts (camelMarkText) don't count.
  // `quoted` is whether the value sits in quotes or right after an XML tag's ">", where YAML can't read an alias.
  function camelPasswordLacksShape(kind, value, quoted = false) {
    if (kind !== "password") return false;
    if (VERSION_RANGE.test(value) || HASH_DIGEST.test(value)) return true;
    return lacksPasswordShape(value, quoted);
  }
  const lacksPasswordShape = (value, quoted) =>
    !(/\d/.test(value) && PASSWORD_MARK.test(camelMarkText(value, quoted))) && !camelRandomKey(value);
  // A version range: ^2.3.1, ~1.4.0, >=3.2.0 <4.0.0, ^0.9.2 || ^1.0.0.
  const VERSION_RANGE = /^(?:(?:[~^]|[<>]=?|=)?v?\d+(?:\.(?:\d+|[xX*])){1,3}(?:-[\w.]+)?(?:\s*\|\|\s*|\s+|$))+$/;
  // A hash's digest, alone or after an image's name: sha256: and 64 hex, app@sha256:…
  const HASH_DIGEST = /^(?:[\w./:-]+@)?(?:sha\d{1,3}|md5):[0-9a-f]{32,128}$/i;
  // The part of a value whose marks count. These marks join a name's parts rather than a password's: in a link,
  // what follows "#", and a query after its host (camelLinkMarkText); an encoded "/" in a lowercase name
  // (secret%2Fdb-2); "~/" at the start of a path to a dotfile, a folder or a file with an extension (~/.pgpass2,
  // ~/secrets/client2.json); and "*" before a YAML alias's name (*db_password_1, camelAliasName). A "#" between
  // two words still counts: welcome#pass_1 and dogs-rule#password1 are weak passwords, and a Secret's name and key
  // (db-secret#password2) have the same shape, so both are found, as on 1.6.2.
  function camelMarkText(value, quoted) {
    if (/:\/\//.test(value)) return camelLinkMarkText(value);
    const marked = value
      .replace(/^[a-z0-9]+(?:(?:[-_.]|%2[Ff])[a-z0-9]+)+$/, (name) => name.replace(/%2F/gi, "/"))
      .replace(/^~\/(?=\.|[\w.-]+\/|[\w-]+\.\w)/, "/");
    if (camelAliasName(marked, quoted)) return marked.slice(1);
    return marked;
  }
  // Whether a value starting with "*" reads as a YAML alias's name. Bare, any name with two parts or more does
  // (*defaults_2). In quotes YAML reads no alias, and JSON and XML have none, so there a "*" value is the password
  // itself (*secret-123, *super_secret_1).
  function camelAliasName(value, quoted) {
    return !quoted && /^\*[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)+$/.test(value);
  }
  // A link's part whose marks count: what precedes "#", without the query after the host when no parameter there is
  // named for a secret and each parameter holds a name or a version (queryNamesSomething: vault://kv/db?version=3,
  // ?rev=4&env=prod). A value like hunter-42 under any parameter or Maple47!qz keeps the query, and its "?" counts.
  function camelLinkMarkText(value) {
    const link = value.replace(/#[^#]*$/, "");
    const host = link.indexOf("/", link.lastIndexOf("@") + 1 || link.indexOf("://") + 3);
    if (host < 0 || /[?&;][\w.-]*(?:pass|pwd|secret|token|key|auth)[\w.-]*=/i.test(link)) return link;
    const query = /\?(.*)$/.exec(link.slice(host));
    if (!query || !query[1].split(/[&;]/).every(queryNamesSomething)) return link;
    return link.slice(0, host + query.index);
  }
  // Whether a query's parameter holds a name or a version rather than a password: a number or a version (2, v2,
  // 1.4.0) or words with no digit (prod, us-east). Words and numbers mixed (prod-2, hunter-42) read as a password
  // under any parameter.
  const queryNamesSomething = (param) =>
    /^(?:v?\d+(?:\.\d+)*|[A-Za-z]+(?:[-_.][A-Za-z]+)*)?$/.test(param.slice(param.indexOf("=") + 1));
  const pascalPasswordShape = (value) =>
    (/\d/.test(value) && PASSWORD_MARK.test(value)) ||
    (camelRandomKey(value) && /[a-z]/.test(value) && /[A-Z]/.test(value));
  // A random key's shape: an unbroken run of 16 or more letters, digits and base64 marks that keyLike takes, where
  // letters and digits swap places at least three times. A name with a version or a year (my-release-postgresql-0,
  // keycloak-admin-1, myapp2024production) swaps once or twice.
  const camelRandomKey = (value) =>
    (value.match(/[A-Za-z0-9+/=]{16,}/g) || []).some(
      (run) => keyLike(run) && (run.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length >= 3,
    );
  // Whether a word is a secret's word, alone or plural: password, Token, Secrets.
  const isSecretWord = (word) =>
    SECRET_WORD_WHOLE.test(word) || (/s$/i.test(word) && SECRET_WORD_WHOLE.test(word.slice(0, -1)));

  globalThis.ClotrInternal = {
    ...globalThis.ClotrInternal,
    camelValueCouldBeRead,
    SECRET_LABEL_AT_START,
    twinIsSecretLabel,
    camelKeyNamesSomething,
    camelValueNamesSomething,
    camelPasswordLacksShape,
    pascalPasswordShape,
  };
})();
