(() => {
  "use strict";
  const { TOURNIQUET, cleanTourniquet } = globalThis.ClotrSites;

  // ---------- Team policy ----------

  // Pure functions, so the rules are unit-tested. The background and popup apply them.
  const POLICY_RESPONSES = new Set(["block", "warn", "log"]);
  // A kind id a policy can name: lowercase letters, digits and underscores, 64 at most.
  const KIND_ID = /^[a-z0-9_]{1,64}$/;
  // Every team gets 500 watch words and 50 watch formats between its own watch list and its kinds, and up to
  // 20 kinds. A kind's format can also list up to 10 words that often appear near it.
  const MAX_POLICY_WORDS = 500;
  const MAX_POLICY_FORMATS = 50;
  const MAX_KINDS = 20;
  const MAX_NEAR = 10;

  // Ready-made policies an admin can turn on with a single word stored as `preset`. The ids are written out
  // by hand here rather than pulled from Clotr.PATTERNS, since sites-and-policy/protected-sites.js loads before rule-table.js does. A test
  // checks these against the real pattern groups, so adding a new credentials or personal kind to the engine
  // can't silently leave these presets out of date.
  const PRESETS = {
    // For a dev shop: every credentials kind asks before it goes out, including the two that are sometimes
    // meant to be shared on purpose. A shop that finds those two noisy can set them back to warn afterwards.
    keys_never: {
      requiredResponses: Object.fromEntries(
        [
          "private_key",
          "aws_access_key",
          "github_token",
          "stripe_secret_key",
          "anthropic_key",
          "openai_key",
          "xai_key",
          "google_api_key",
          "slack_token",
          "sentry_token",
          "grafana_token",
          "vault_token",
          "replicate_token",
          "linear_key",
          "postman_key",
          "shopify_token",
          "atlassian_token",
          "netlify_token",
          "pulumi_token",
          "databricks_token",
          "gitlab_token",
          "perplexity_key",
          "digitalocean_token",
          "huggingface_token",
          "heroku_token",
          "onepassword_token",
          "cloudflare_origin_ca_key",
          "twilio_credentials",
          "crypto_secret",
          "service_token",
          "connection_string",
          "jwt",
          "internal_ip",
          "internal_host",
          "otp_secret",
          "backup_codes",
          "password",
          "stripe_publishable_key",
        ].map((id) => [id, "block"]),
      ),
      allowPause: false,
      holdFiles: true,
    },
    // For law firms, accountants and agencies: client names always ask first, and every personal-detail kind
    // is at least a warn. That's a floor, so nobody on the team can quietly turn their own SSN down to Just
    // count.
    client_names: {
      requiredResponses: {
        watch_list: "block",
        ...Object.fromEntries(
          [
            "us_ssn",
            "credit_card",
            "card_code",
            "gift_card",
            "street_address",
            "bank_account",
            "national_id",
            "medical_record",
            "public_ip",
            "medicare_id",
            "passport",
            "drivers_license",
            "photo_location",
            "id_picture",
            "insurance_id",
            "vin",
            "student_id",
            "license_plate",
            "gamer_tag",
            "date_of_birth",
            "phone_number",
            "my_name",
            "family_name",
            "employer",
            "my_id",
            "email",
          ].map((id) => [id, "warn"]),
        ),
      },
      allowPause: false,
      holdFiles: true,
    },
    // For a clinic: anything that identifies a patient or staff member always asks. Settings aren't locked
    // here on purpose, so staff can still add their own names to the vault.
    clinic: {
      requiredResponses: {
        medical_record: "block",
        medicare_id: "block",
        insurance_id: "block",
        us_ssn: "block",
        date_of_birth: "block",
        my_name: "block",
        family_name: "block",
        // A patient's photo can reveal where it was taken, and a picture named like an ID or a scanned
        // document, such as an insurance card, is worth a second look. Both get at least a warning.
        photo_location: "warn",
        id_picture: "warn",
      },
      largeText: true,
      allowPause: false,
      holdFiles: true,
    },
    // For a tax office: Social Security and tax ID numbers, bank and routing numbers, dates of birth, and the
    // office's own list of client names all always ask first.
    tax_office: {
      requiredResponses: {
        watch_list: "block",
        us_ssn: "block",
        national_id: "block",
        bank_account: "block",
        date_of_birth: "block",
      },
      allowPause: false,
      holdFiles: true,
    },
  };

  // Combines the admin's raw managed policy with a chosen preset, field by field, with anything explicit in
  // the raw policy winning. This checks for `__proto__` by hand, because assigning that key on a plain object
  // changes its prototype instead of just adding a property.
  function mergePolicy(raw) {
    const policy = raw && typeof raw === "object" ? raw : {};
    const presetId = typeof policy.preset === "string" ? policy.preset : "";
    const preset = Object.hasOwn(PRESETS, presetId) ? PRESETS[presetId] : null;
    const requiredResponses = { ...(preset?.requiredResponses || {}) };
    const explicit = policy.requiredResponses;
    if (explicit && typeof explicit === "object") {
      for (const [id, value] of Object.entries(explicit)) {
        if (id === "__proto__") continue;
        requiredResponses[id] = value;
      }
    }
    const merged = {
      requiredResponses,
      watchWords: [
        ...(Array.isArray(preset?.watchWords) ? preset.watchWords : []),
        ...(Array.isArray(policy.watchWords) ? policy.watchWords : []),
      ],
    };
    for (const key of ["allowPause", "lockSettings", "largeText"]) {
      const value = booleanSetting(policy, preset, key);
      if (value !== undefined) merged[key] = value;
    }
    if (typeof policy.orgName === "string") merged.orgName = policy.orgName.slice(0, 80);
    if (preset) merged.preset = presetId;
    // A team's own kinds, cleaned up to just their own fields plus the id Clotr generates, each response
    // acting as a floor the same way requiredResponses does. With no kinds, this adds no field at all, so an
    // older policy keeps exactly the shape it already had.
    const kinds = policyKinds({ watchWords: merged.watchWords, kinds: policy.kinds });
    if (kinds.length) {
      merged.kinds = kinds;
      for (const kind of kinds) requiredResponses[kind.id] = kind.response;
    }
    // holdFiles: an admin's own value wins, then the preset's, and otherwise it's on by itself whenever this
    // policy actually sets anything, so nobody has to remember to turn it on. hasPolicy() runs against what's
    // been merged so far, before holdFiles joins it, so a bare `{ holdFiles: true }` with nothing else set
    // still counts as a policy. With no explicit value and no policy at all, this adds no field, the same way
    // the other booleans above don't.
    const explicitHoldFiles = booleanSetting(policy, preset, "holdFiles");
    const holdFiles = explicitHoldFiles !== undefined ? explicitHoldFiles : hasPolicy(merged);
    if (explicitHoldFiles !== undefined || holdFiles) merged.holdFiles = holdFiles;
    return merged;
  }

  // An admin's own true or false wins, then the preset's, and otherwise there's none.
  function booleanSetting(policy, preset, key) {
    if (typeof policy[key] === "boolean") return policy[key];
    if (preset && typeof preset[key] === "boolean") return preset[key];
    return undefined;
  }

  // Whether a policy requires blocking this kind. The background checks this separately, because a vault
  // entry marked "OK to share" overrides the normal response, and that override needs its own floor too.
  function floorOf(policy, type) {
    if (!policy || typeof policy.requiredResponses !== "object") return null;
    return policy.requiredResponses?.[type] === "block" ? "block" : null;
  }

  // Whether the organization's policy asks before sending at least one kind of detail. If it does, a file
  // that might hold one of those kinds waits for the person to answer instead of going through silently, and
  // the question explains that the organization asked for the check. This is worked out on the fly rather
  // than stored, so it adds no field to the policy and doesn't change its fingerprint. The chat page only
  // ever learns this one yes or no. Bad entries, like an unknown id or value, are ignored.
  function teamHoldOf(policy) {
    const required = policy && typeof policy === "object" ? policy.requiredResponses : null;
    if (!required || typeof required !== "object") return false;
    return Object.entries(required).some(([id, value]) => KIND_ID.test(id) && value === "block");
  }

  // Works out the settings actually in force. A policy's required response is a floor: whichever is stricter,
  // the policy's or the person's own choice, wins, so a required warn can never pull someone's own block down
  // to warn. Bad entries, like an unknown id or value, are ignored.
  function applyPolicy(user = {}, policy = {}) {
    const responses = { ...(user.responses || {}) };
    const required =
      policy && typeof policy.requiredResponses === "object" && policy.requiredResponses
        ? policy.requiredResponses
        : {};
    const engineApi = globalThis.Clotr;
    for (const [id, value] of Object.entries(required)) {
      if (!KIND_ID.test(id) || !POLICY_RESPONSES.has(value)) continue;
      const current = engineApi?.responseFor ? engineApi.responseFor(id, user.responses) : responses[id];
      responses[id] = engineApi?.stricter ? engineApi.stricter(current ?? value, value) : value;
    }
    return {
      responses,
      paused: policy.allowPause === false ? false : Boolean(user.paused),
      largeText: policy.largeText === true || Boolean(user.largeText),
      locked: policy.lockSettings === true,
      pauseAllowed: policy.allowPause !== false,
    };
  }

  // ---------- Tourniquet as a policy ----------

  // Tourniquet as a policy-shaped object (a copy of its rules), or null when it's off.
  function tourniquetPolicy(stored, now = Date.now()) {
    const clean = cleanTourniquet(stored, now);
    if (!clean) return null;
    const preset = TOURNIQUET[clean.for];
    const policy = { requiredResponses: { ...preset.requiredResponses } };
    if (preset.largeText === true) policy.largeText = true;
    return policy;
  }

  // Combines the organization's policy with Tourniquet on top, taking whichever response is stricter for each
  // kind, and asking for larger warnings if either one does. Locking settings, pausing, the organization's
  // name and its watch words all come from the organization alone.
  const RANK = { block: 0, warn: 1, log: 2 };

  function combinePolicies(managed, tourniquet) {
    const base = managed && typeof managed === "object" ? managed : {};
    if (!tourniquet) return base;
    const team = base.requiredResponses && typeof base.requiredResponses === "object" ? base.requiredResponses : {};
    const requiredResponses = { ...team };
    for (const [id, value] of Object.entries(tourniquet.requiredResponses || {})) {
      if (!POLICY_RESPONSES.has(value)) continue;
      const theirs = Object.hasOwn(team, id) ? team[id] : undefined;
      const theirsIsStricter = POLICY_RESPONSES.has(theirs) && RANK[theirs] < RANK[value];
      requiredResponses[id] = theirsIsStricter ? theirs : value;
    }
    const watchWords = Array.isArray(base.watchWords) ? base.watchWords : [];
    const combined = { ...base, requiredResponses, watchWords };
    if (tourniquet.largeText === true) combined.largeText = true;
    return combined;
  }

  // ---------- Team policy: firm kinds, watch words and the team's own kinds ----------

  // Which kinds a policy, or Tourniquet inside it, holds firmly: a warning for one of these never offers to
  // loosen it. A floor of "Just count" doesn't actually hold anything, since nothing can go lower than that
  // anyway.
  function firmKinds(policy) {
    const required = policy && typeof policy.requiredResponses === "object" ? policy.requiredResponses : null;
    if (!required) return [];
    return Object.entries(required)
      .filter(([id, response]) => KIND_ID.test(id) && (response === "block" || response === "warn"))
      .map(([id]) => id);
  }

  // Whether this is a watched format, like "EMP-#####" where # stands for a digit and @ for a letter. It uses
  // the same rule as clotr-pages/vault/vault.js's own format check, so an admin's formats and an employee's behave the same
  // way. Formats aren't secret, so they're kept and sent around exactly as typed.
  function isShape(value) {
    if (typeof value !== "string") return false;
    const shape = value.trim();
    if (!shape || shape.length > 40) return false;
    const marks = (shape.match(/[#@]/g) || []).length;
    return marks >= 4 && !/\d/.test(shape);
  }

  // The admin's watch formats (isShape), up to 50, in the order given, duplicates dropped.
  function policyShapes(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const word of policy.watchWords) {
      const shape = typeof word === "string" ? word.trim() : "";
      if (!isShape(shape) || out.includes(shape)) continue;
      out.push(shape);
      if (out.length >= MAX_POLICY_FORMATS) break;
    }
    return out;
  }

  // Cleans up one watch word or phrase: trimmed, lowercased, capped at four words and 100 characters, or ""
  // if it doesn't qualify. A format never counts as a phrase here, since it's watched as a format instead of
  // being hashed as literal text.
  function cleanPhrase(word) {
    if (typeof word !== "string" || isShape(word)) return "";
    const phrase = word.trim().toLowerCase().replace(/\s+/g, " ");
    if (!phrase || phrase.length > 100 || phrase.split(" ").length > 4) return "";
    return phrase;
  }

  // The admin's watch words, cleaned (cleanPhrase), 500 at most.
  function policyWords(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const word of policy.watchWords) {
      const phrase = cleanPhrase(word);
      if (!phrase || out.includes(phrase)) continue;
      out.push(phrase);
      if (out.length >= MAX_POLICY_WORDS) break;
    }
    return out;
  }

  // A name or cover word as people will read it: no control or invisible characters, single spaces, at most
  // `max`.
  function plainText(value, max) {
    if (typeof value !== "string") return "";
    const visible = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
    return visible.replace(/\s+/g, " ").trim().slice(0, max).trim();
  }

  // Bandage's word for a kind. No brackets or digits, so "[Matter 2]" always reads back as the second matter.
  function coverWord(value) {
    const withoutMarks = typeof value === "string" ? value.replace(/[[\]\d]/g, " ") : "";
    const word = plainText(withoutMarks, 20);
    return /\p{L}/u.test(word) ? word : "";
  }

  // "team_" and the name's letters (accents dropped), a letter after it when two names make the same id.
  function kindId(name, taken) {
    const letters = name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const base = `team_${letters || "kind"}`.slice(0, 40).replace(/_+$/, "");
    let id = base;
    for (let tries = 1; taken.has(id); tries++) {
      id = `${base.slice(0, 38).replace(/_+$/, "")}_${String.fromCharCode(97 + tries)}`;
    }
    taken.add(id);
    return id;
  }

  // Cleans up a team's own kinds into a list of { id, name, cover, response, words, formats, near }.
  //
  // A kind needs a name, up to 40 characters, since that's what shows up in warnings. Its words are cleaned
  // the same way watch words are, so a format typed in there is treated as a format instead. Both share the
  // policy's overall limit of 500 words and 50 formats along with the regular watch list, counted first come
  // first served, and nothing already watched gets counted twice. A kind that runs out of room keeps its name
  // and response but ends up matching nothing. `near` holds up to 10 nearby words, each up to 40 characters.
  // The response defaults to warn unless it's explicitly block, warn or log, and the cover word, Bandage's
  // name for it, defaults to the kind's own name, or "ID" if neither has a real letter in it.
  //
  // This is a pure function, and cleaning an already-clean list changes nothing, so the merged policy can go
  // through it again safely anywhere.
  function policyKinds(policy = {}) {
    if (!Array.isArray(policy.kinds)) return [];
    const words = new Set(policyWords(policy));
    const watchFormats = policyShapes(policy);
    // What's left of the policy's shared room, as the kinds fill it in order.
    const kindRoom = {
      words,
      formats: new Set(watchFormats.map((format) => format.toLowerCase())),
      wordsLeft: MAX_POLICY_WORDS - words.size,
      formatsLeft: MAX_POLICY_FORMATS - watchFormats.length,
    };
    const ids = new Set();
    const out = [];
    for (const raw of policy.kinds) {
      if (out.length >= MAX_KINDS) break;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const name = plainText(raw.name, 40);
      if (!/[\p{L}\p{N}]/u.test(name)) continue;
      const kind = {
        id: kindId(name, ids),
        name,
        cover: coverWord(raw.cover) || coverWord(name) || "ID",
        response: POLICY_RESPONSES.has(raw.response) ? raw.response : "warn",
        words: [],
        formats: [],
        near: [],
      };
      for (const word of stringsIn(raw.words)) addKindWord(kind, word, kindRoom);
      for (const format of stringsIn(raw.formats)) addKindFormat(kind, format, kindRoom);
      addNearWords(kind, stringsIn(raw.near));
      out.push(kind);
    }
    return out;
  }

  function stringsIn(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string");
  }

  // A word typed as a format joins the kind's formats instead.
  function addKindWord(kind, word, kindRoom) {
    if (isShape(word)) {
      addKindFormat(kind, word, kindRoom);
      return;
    }
    const phrase = cleanPhrase(word);
    if (!phrase || kindRoom.words.has(phrase) || kindRoom.wordsLeft <= 0) return;
    kindRoom.words.add(phrase);
    kindRoom.wordsLeft--;
    kind.words.push(phrase);
  }

  function addKindFormat(kind, format, kindRoom) {
    const shape = format.trim();
    if (!isShape(shape) || kindRoom.formats.has(shape.toLowerCase()) || kindRoom.formatsLeft <= 0) return;
    kindRoom.formats.add(shape.toLowerCase());
    kindRoom.formatsLeft--;
    kind.formats.push(shape);
  }

  function addNearWords(kind, nearWords) {
    for (const raw of nearWords) {
      const word = plainText(raw, Infinity).toLowerCase();
      if (word.length > 40 || !/[\p{L}\p{N}]/u.test(word) || kind.near.includes(word)) continue;
      kind.near.push(word);
      if (kind.near.length >= MAX_NEAR) break;
    }
  }

  // Whether the merged policy actually sets anything. mergePolicy always returns an object with empty
  // requiredResponses and watchWords by default, so those alone don't count as "set". The popup's banner and
  // the attestation page's "no policy" line both depend on this.
  const POLICY_SETTINGS = ["allowPause", "lockSettings", "largeText", "holdFiles"];

  function hasPolicy(policy) {
    const given = policy && typeof policy === "object" ? policy : {};
    if (given.requiredResponses && Object.keys(given.requiredResponses).length) return true;
    if (Array.isArray(given.watchWords) && given.watchWords.length) return true;
    if (Array.isArray(given.kinds) && given.kinds.length) return true;
    if (POLICY_SETTINGS.some((key) => typeof given[key] === "boolean")) return true;
    return typeof given.orgName === "string" || typeof given.preset === "string";
  }

  // A short, stable code for one merged and validated policy, shown on the attestation page. A preset and
  // its fully expanded JSON print the exact same code, so an admin can compare a test machine's page against
  // the policy they meant to set. It's unsalted on purpose, since this code isn't a secret. `preset`,
  // `orgName` and the extension version are left out, so the code only changes when the policy's actual rules
  // change.
  function policyFingerprint(policy) {
    const given = policy && typeof policy === "object" ? policy : {};
    const required =
      given.requiredResponses && typeof given.requiredResponses === "object" ? given.requiredResponses : {};
    const responses = Object.entries(required)
      .filter(([id, response]) => KIND_ID.test(id) && POLICY_RESPONSES.has(response))
      .sort(([a], [b]) => a.localeCompare(b));
    const canon = {
      v: 1,
      r: responses,
      w: policyWords(given).slice().sort(),
      s: lowerCaseSorted(policyShapes(given)),
      p: given.allowPause !== false,
      l: given.lockSettings === true,
      t: given.largeText === true,
    };
    // holdFiles only joins the canonical form when mergePolicy actually set it, the same as kinds below, so a
    // policy printed before holdFiles existed keeps exactly the same code.
    if (typeof given.holdFiles === "boolean") canon.h = given.holdFiles;
    // The team's own kinds only join the canonical form when there are any, so every code printed before
    // kinds existed stays unchanged. Their order is kept as-is, since it's what decides the ids when two
    // names collide.
    const kinds = policyKinds(given);
    if (kinds.length) {
      canon.k = kinds.map((kind) => [
        kind.id,
        kind.name,
        kind.cover,
        kind.response,
        kind.words.slice().sort(),
        lowerCaseSorted(kind.formats),
        kind.near.slice().sort(),
      ]);
    }
    return globalThis.Clotr.sha256(JSON.stringify(canon)).slice(0, 16).toUpperCase();
  }

  function lowerCaseSorted(list) {
    return list.map((item) => item.toLowerCase()).sort();
  }

  Object.assign(globalThis.ClotrSites, {
    PRESETS,
    mergePolicy,
    applyPolicy,
    floorOf,
    teamHoldOf,
    tourniquetPolicy,
    combinePolicies,
    firmKinds,
    isShape,
    policyShapes,
    policyWords,
    policyKinds,
    policyFingerprint,
    hasPolicy,
  });
})();
