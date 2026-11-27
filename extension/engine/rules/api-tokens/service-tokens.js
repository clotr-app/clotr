// findServiceTokens(): a service's token after its own name or a generic token label, kept apart from lookup keys.
(() => {
  "use strict";

  const {
    trimTrail,
    isPlaceholder,
    findAwsAccessKeys,
    secretValue,
    readClosed,
    findPrefixedTokens,
    twilioLookup,
    LOOKUP_TOKEN_LABEL,
    CREDENTIAL_KEY_LABEL,
    namedValue,
    LOOKUP_KEY_LABEL,
    nameRoleAlternatives,
    nameRole,
    roleNameValueReads,
    takenByItsOwnRule,
    LABELLED_SECRET,
    LABELLED_API_KEY,
    AUTH_SCHEME,
    schemeAt,
    schemeCredentialLike,
    isProviderCredentialLabel,
    keyLike,
    hexKey,
    CONFUSABLE_LABEL_CHAR,
    forConfusableLabelMatches,
    camelKeyNamesSomething,
    namedSettings,
  } = globalThis.ClotrInternal;

  // ── Service tokens ──
  // `group` = the Settings section: "credentials" (keys, passwords), "personal" (info about a person),
  // or "custom" (the user's own watch list).
  const GUID = String.raw`[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`;
  // A "perm:" token: one long part and any dotted ones, or a short part and at least two dotted ones.
  const PERM_CHARACTER = "[A-Za-z0-9+/=_-]";
  const PERM_LONG_FIRST = String.raw`${PERM_CHARACTER}{16,}(?:\.${PERM_CHARACTER}{8,})*`;
  const PERM_SHORT_FIRST = String.raw`${PERM_CHARACTER}{4,}(?:\.${PERM_CHARACTER}{8,}){2,}`;
  // An Office 365 connector's incoming webhook for a Teams channel.
  const TEAMS_HOST = String.raw`https://(?:[A-Za-z0-9-]{1,63}\.webhook|outlook)\.office\.com/webhook(?:b2)?/`;
  const TEAMS_PATH = String.raw`${GUID}@${GUID}/IncomingWebhook/[0-9a-f]{32}/${GUID}(?:/V2[A-Za-z0-9_-]{20,100})?`;
  // 32 letters and digits with a digit, a capital and a small letter somewhere in them.
  const WITHIN_32 = "[A-Za-z0-9]{0,31}";
  const MIXED_32 = String.raw`(?=${WITHIN_32}\d)(?=${WITHIN_32}[A-Z])(?=${WITHIN_32}[a-z])[A-Za-z0-9]{32}`;
  // Distinct provider prefixes share one service-token kind and one Settings row.
  const SERVICE_TOKEN_RE = new RegExp(
    [
      String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
      String.raw`\bovsxat_(?:[A-Za-z0-9]{43}|${GUID})(?![A-Za-z0-9_-])`,
      String.raw`\brubygems_[0-9a-f]{48}(?![A-Za-z0-9_-])`,
      String.raw`\bperm:(?:${PERM_LONG_FIRST}|${PERM_SHORT_FIRST})(?!${PERM_CHARACTER})`,
      String.raw`\bgsk_[A-Za-z0-9]{52}(?![A-Za-z0-9_-])`,
      String.raw`\bsk-or-v1-[0-9a-f]{64}(?![A-Za-z0-9_-])`,
      String.raw`\bsb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])`,
      String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`,
      String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`,
      String.raw`\bSK[0-9a-fA-F]{32}\b`,
      String.raw`\bkey-[0-9a-f]{32}\b`,
      String.raw`(?:(?<=/bot)|(?<![A-Za-z0-9_]))\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])`,
      String.raw`\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b`,
      String.raw`\b(?:AccountKey|SharedAccessKey)=["']?[A-Za-z0-9+/]{40,88}={0,2}["']?`,
      String.raw`https://hooks\.slack\.com/(?:workflows|triggers)/[A-Za-z0-9/_-]{20,120}`,
      String.raw`https://hooks\.slack\.com/services/(?!T[A-Za-z0-9_]{1,40}/B[A-Za-z0-9_]{1,40}/)[A-Za-z0-9/_-]{20,120}`,
      String.raw`https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d{5,25}/[A-Za-z0-9_-]{20,100}`,
      `${TEAMS_HOST}${TEAMS_PATH}`,
      String.raw`\btskey-(?:auth|api|client|scim|webhook)-[A-Za-z0-9]{8,}-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])`,
      String.raw`\bFlyV1\s+fm\d_[A-Za-z0-9+/=_-]{40,}(?:,fm\d_[A-Za-z0-9+/=_-]{20,})*`,
      String.raw`\bfo1_[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])`,
      String.raw`\boy2(?=[a-z0-9]{0,42}\d)[a-z0-9]{43}(?![A-Za-z0-9_-])`,
      String.raw`\bcio${MIXED_32}(?![A-Za-z0-9_-])`,
    ].join("|"),
    "g",
  );
  // Role words (nameRoleWords) right after a key's name in a label, before its ":" or "=".
  const ROLE_WORDS_IN_LABEL = new RegExp(
    String.raw`(?<=key|token|secret|acceso)[_.-]?(?:${nameRoleAlternatives()})(?=["']?\]?\s*\??[:=])`,
    "i",
  );
  const LABELLED_SECRET_ONCE = new RegExp(LABELLED_SECRET.source, "i");
  function findServiceTokens(
    text,
    inTwilio = twilioLookup(text),
    hasConfusableLabel = CONFUSABLE_LABEL_CHAR.test(text),
  ) {
    const found = [...text.matchAll(SERVICE_TOKEN_RE)].map((m) => m[0]);
    const awsKeys = new Set(findAwsAccessKeys(text));
    const labelledApiKey = (labelMatch) => {
      const at = labelMatch.index + labelMatch[0].length - labelMatch[1].length;
      readClosed(text, labelMatch, at, readApiKey, () => found.length);
    };
    const readApiKey = (m) => {
      const at = m.index + m[0].length - m[1].length;
      // A provider label only takes this path when its value matches that provider's own token shape.
      if (isProviderCredentialLabel(m[0], inTwilio, m[1], at)) return;
      if (inTwilio(at, at + m[1].length)) return;
      const written = m[0].slice(0, m[0].length - m[1].length);
      // With role words after the key's name (stripe_key_ref, apiKeyRef), the label is read only where
      // LABELLED_SECRET doesn't read it already (api_key_ref stays a password), for a value that reads under them, and
      // it's judged as the name without them.
      const role = ROLE_WORDS_IN_LABEL.exec(written);
      if (role && (LABELLED_SECRET_ONCE.test(`${written}x`) || !roleNameValueReads(m[1], nameRole(role[0])))) return;
      const lookupLabel = role ? written.slice(0, role.index) + written.slice(role.index + role[0].length) : written;
      const labelBefore = text.slice(Math.max(0, m.index - 40), m.index) + lookupLabel;
      if (LOOKUP_TOKEN_LABEL.test(labelBefore)) return;
      // "stripe key: Bearer …" or "stripe key: 'Bearer …'": a scheme word starts the value, and the credential is the
      // whole run after it.
      let told = m[1];
      if (AUTH_SCHEME.test(m[1].replace(/[:,\-–—]+$/u, ""))) {
        const scheme = schemeAt(text, at, m[1]);
        if (!scheme || !schemeCredentialLike(scheme.word, scheme.value)) return;
        told = scheme.value;
      }
      // A JSON string's \n or \t ends the value; what follows one is read again on its own (detect/second-readings.js).
      const raw = told.split(/\\[nrt]/)[0];
      const trimmed = trimTrail(raw, /[.)\]}>]/);
      if (LOOKUP_KEY_LABEL.test(lookupLabel)) {
        const value = trimmed;
        const contextBefore = text
          .slice(Math.max(0, m.index - 40), m.index)
          .trimEnd()
          .toLowerCase();
        const duplicateDatabaseKey = contextBefore.endsWith("duplicate");
        // An Azure storage account key or an AWS secret pasted as someone's bucket key is still a credential.
        const cloudKey = /^[A-Za-z0-9+/]{40,88}={0,2}$/.test(value) && keyLike(value);
        const primaryCredential =
          /\bprimary[ _.-]key\b/i.test(lookupLabel) &&
          !duplicateDatabaseKey &&
          ((hexKey(value) && !isPlaceholder(value)) || cloudKey);
        const storageCredential = /(?:storage|s3)[ _.-]key\b/i.test(lookupLabel) && cloudKey;
        if (!primaryCredential && !storageCredential) return;
      }
      // A key named for a credential (api, access, secret, license…) is read whatever its value; any other key or
      // token holding a name or a file path is a lookup key.
      if (!CREDENTIAL_KEY_LABEL.test(lookupLabel) && namedValue(trimmed)) return;
      // A hex key's "sk-" also starts an OpenAI key, whose own rule turns it down for having no capitals.
      const hex = trimmed;
      // A public key is meant to be shared, so its label alone can't vouch for a hex value or a very long one,
      // like an age public key joined to the secret key on the line under it.
      const publicKey = /pub(?:lic|lishable)?[ _.-]?key/i.test(m[0].slice(0, -m[1].length));
      // A public key or its fingerprint written in hex is shared on purpose, whatever its length.
      if (publicKey && /^(?:(?:sha256|sha1|md5):)?[0-9a-f]+$/i.test(hex)) return;
      if (!publicKey && hexKey(hex) && !isPlaceholder(hex)) {
        if (!takenByItsOwnRule(hex)) found.push(hex);
        return;
      }
      // A key in inline code is judged with the code's closing backticks still on, as it was before inline code was
      // read, so they count toward its length. The key is found without them.
      const closing = m.closing || "";
      const value = secretValue(raw, true, closing ? 4 : 16);
      const judged = closing ? secretValue(raw + closing, true, 16) : value;
      if (value && judged && (!publicKey || judged.length <= 128) && keyLike(judged) && !awsKeys.has(value)) {
        found.push(value);
      }
    };
    for (const m of text.matchAll(LABELLED_API_KEY)) labelledApiKey(m);
    forConfusableLabelMatches(text, LABELLED_API_KEY, labelledApiKey, hasConfusableLabel);
    for (const setting of namedSettings(text)) {
      const value = setting.kind === "key" && secretValue(setting.value, true, 16);
      if (value && setting.camel && camelKeyNamesSomething(setting.record.name, value)) continue;
      if (value && (keyLike(value) || hexKey(value)) && !awsKeys.has(value)) found.push(value);
    }
    // An .npmrc line: whatever follows its _authToken= is the registry's token, whatever its length.
    for (const m of text.matchAll(NPMRC_TOKEN)) {
      const value = secretValue(m[1], false, 8);
      if (value) found.push(value);
    }
    for (const token of findPrefixedTokens(text)) found.push(token);
    return [...new Set(found)];
  }
  const NPMRC_TOKEN = /(?<![\w-]):?_authToken\s*=\s*["']?([^\s"']+)/g;

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, findServiceTokens };
})();
