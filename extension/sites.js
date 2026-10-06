// Which sites Clotr runs on, and how it spots new AI tools.
// Shared by background.js, popup.js and the "What Clotr stores" page; this file isn't a content script itself.
//
// Out of the box Clotr only runs on AI chat sites, never on everything. It can spot an AI tool it doesn't
// already know about, but protecting one always takes your click and a browser permission prompt for that one
// site. Email and chat apps work the same way: never built in, switched on one at a time.
(() => {
  "use strict";

  const CONTENT_JS = [
    "patterns.js",
    "detector.js",
    "decide.js",
    "attachments.js",
    "pictures.js",
    "commands.js",
    "ui-styles.js",
    "editor.js",
    "warning-ui.js",
    "content.js",
  ];
  const USER_SCRIPT_ID = "clotr-user-sites";

  // Email and chat apps, where you're writing to a person instead of an AI. None of these run by default:
  // Settings lists them, and each one only starts once you switch it on and the browser grants that site.
  // Bandage and the reply check both stay off here too, since a cover name would reach a real person, and a
  // reply is someone else's words, not an AI's.
  const EVERYDAY_SITES = [
    { name: "Gmail", kind: "email", matches: ["https://mail.google.com/*"] },
    { name: "Outlook", kind: "email", matches: ["https://outlook.live.com/*", "https://outlook.office.com/*"] },
    { name: "Yahoo Mail", kind: "email", matches: ["https://mail.yahoo.com/*"] },
    { name: "Discord", kind: "chat", matches: ["https://discord.com/*"] },
    { name: "Slack", kind: "chat", matches: ["https://app.slack.com/*"] },
    { name: "WhatsApp", kind: "chat", matches: ["https://web.whatsapp.com/*"] },
    { name: "Messenger", kind: "chat", matches: ["https://www.messenger.com/*"] },
    { name: "Microsoft Teams", kind: "chat", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*"] },
  ];
  const hostOf = (pattern) => new URL(pattern.replace(/\*$/, "")).hostname;

  function everydaySiteFor(host) {
    return EVERYDAY_SITES.find((s) => s.matches.some((p) => hostOf(p) === host)) || null;
  }

  // The addresses for the apps with these names, in the list's order. Anything that isn't a real name on
  // the list, like a pattern such as "https://*/*", is just ignored.
  function everydayOrigins(names) {
    if (!Array.isArray(names)) return [];
    const wanted = new Set(names.filter((n) => typeof n === "string"));
    return [...new Set(EVERYDAY_SITES.filter((s) => wanted.has(s.name)).flatMap((s) => s.matches))];
  }

  // Which listed apps the browser has already granted at least one address for.
  function grantedEverydayApps(origins) {
    const granted = new Set(Array.isArray(origins) ? origins : []);
    return EVERYDAY_SITES.filter((s) => s.matches.some((p) => granted.has(p))).map((s) => s.name);
  }

  // Asks the browser for permission on the named apps, and returns whether it said yes. The ask has to
  // happen first, before anything else awaits, since Firefox refuses the prompt once you've awaited
  // something. Nothing is stored here: the browser remembers the grant, and the background notices and
  // turns Clotr on for those sites. The log only says what kind of error happened, never an address.
  async function requestEverydayApps(names) {
    const origins = everydayOrigins(names);
    if (!origins.length) return false;
    try {
      return Boolean(await chrome.permissions.request({ origins }));
    } catch (err) {
      const kind = err instanceof Error ? err.constructor.name : typeof err;
      console.warn("[Clotr] could not ask for email and chat apps:", kind);
      return false;
    }
  }

  // Hands an app's permission back. There's no prompt either way, so there's nothing to say no to: if this
  // fails, the app just stays on, and the next refresh notices.
  async function removeEverydayApps(names) {
    const origins = everydayOrigins(names);
    if (!origins.length) return false;
    try {
      return Boolean(await chrome.permissions.remove({ origins }));
    } catch (err) {
      const kind = err instanceof Error ? err.constructor.name : typeof err;
      console.warn("[Clotr] could not switch off email and chat apps:", kind);
      return false;
    }
  }

  // Decides what to store for the one-time offer to use Clotr on email and chat apps. A new install gets
  // "welcome", since the welcome page makes the offer there. Someone who already had Clotr gets "popup" once,
  // so the offer shows there instead. Either way it becomes "done" once answered, or once one of the apps is
  // already on.
  const OFFER_WORDS = new Set(["welcome", "popup", "done"]);
  function offerAfterInstall(reason, current, anyEverydayGranted) {
    if (reason === "install") return "welcome";
    const known = OFFER_WORDS.has(current) ? current : undefined;
    if (reason !== "update") return known;
    if (known === undefined || known === "popup") return anyEverydayGranted ? "done" : "popup";
    return known;
  }

  // Folds a long run of identical detections into one record, so pasting a huge list doesn't flood history.
  // Pasting 3,000 emails means 3,000 detections, which would push months of real history out of the 10,000-record
  // cap. Within one batch, the first `keep` records of each kind, outcome, site and way are kept as they are;
  // anything past that becomes a single record with no fingerprint and a count. Only the background calls this,
  // and it always works the count out fresh, so a page can't hand it a fake one. A single extra record is left
  // alone, since folding it wouldn't save anything.
  function collapseBatch(events, keep = 10) {
    const groups = new Map();
    const out = [];
    for (const e of events) {
      const plain = { ...e };
      delete plain.n; // an incoming count is never kept
      const key = [plain.site, plain.type, plain.action, plain.via || "", plain.severity].join("\n");
      const g = groups.get(key) || { seen: 0, rest: null };
      groups.set(key, g);
      g.seen++;
      if (g.seen <= keep) out.push(plain);
      else if (!g.rest) {
        g.rest = { at: out.length, first: plain, n: 1 };
        out.push(plain);
      } else g.rest.n++;
    }
    for (const { rest } of groups.values()) if (rest && rest.n > 1) out[rest.at] = { ...rest.first, fp: "", n: rest.n };
    return out;
  }

  // How many details one record actually stands for: its `n` if it's a folded record for the rest of a long
  // list, otherwise one. Every count of history goes through this, though counting distinct details or repeats
  // skips records with no fingerprint instead.
  const weight = (e) => (Number.isInteger(e?.n) && e.n > 1 ? e.n : 1);

  // Whether this is a site where you write to people rather than an AI: either one from the list, or one you
  // told Clotr isn't an AI chat yourself. Your own choice always wins over the list.
  function isEveryday(host, siteKinds = {}) {
    if (!host) return false;
    if (siteKinds[host] === "everyday") return true;
    if (siteKinds[host] === "ai") return false;
    return Boolean(everydaySiteFor(host));
  }

  // Built-in AI sites come straight from the manifest, so there is one list.
  function builtInMatches() {
    return chrome.runtime.getManifest().content_scripts.flatMap((cs) => cs.matches);
  }

  // Converts an extension match pattern like "https://huggingface.co/chat/*" to a RegExp.
  function matchPatternToRegExp(pattern) {
    const m = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!m) return null;
    const [, scheme, host, pathPart] = m;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const hostRe = host === "*" ? "[^/]+" : host.startsWith("*.") ? `([^/]+\\.)?${esc(host.slice(2))}` : esc(host);
    const schemeRe = scheme === "*" ? "https?" : scheme;
    return new RegExp(`^${schemeRe}://${hostRe}${esc(pathPart).replace(/\*/g, ".*")}$`);
  }

  function urlMatchesAny(url, patterns) {
    return patterns.some((p) => matchPatternToRegExp(p)?.test(url));
  }

  function originPattern(hostname) {
    return `https://${hostname}/*`;
  }

  // Hosts where the AI tool is only part of a bigger site, like huggingface.co/chat/*: the built-in entry only
  // covers that one section. Protecting a page there has to stay scoped to that section too, not the whole
  // host, which is what used to happen with Hugging Face.
  function sharedHosts() {
    return new Set(
      builtInMatches()
        .map((p) => /^https:\/\/([^/]+)(\/.*)$/.exec(p))
        .filter((m) => m && m[2] !== "/*")
        .map((m) => m[1]),
    );
  }

  // What clicking "Protect this site" actually covers for this page: the whole host for a normal AI site, or
  // just its section, up to three path parts deep, on a host shared with other things.
  function protectScope(url) {
    const u = new URL(url);
    if (!sharedHosts().has(u.hostname)) return originPattern(u.hostname);
    const parts = u.pathname.split("/").filter(Boolean).slice(0, 3);
    return parts.length ? `https://${u.hostname}/${parts.join("/")}/*` : `https://${u.hostname}/`;
  }

  // Browser permissions only work per host, so this is always the whole host. Where Clotr actually runs on
  // that host gets narrowed down separately, by the scopes stored in `siteScopes`.
  function permissionFor(scope) {
    return originPattern(new URL(scope.replace(/\*$/, "")).hostname);
  }

  function isWiderThanNeeded(pattern) {
    const m = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
    return Boolean(m && sharedHosts().has(m[1]));
  }

  // Where Clotr runs on the sites someone added themselves: for each granted host that isn't already built in,
  // either the sections they chose, or the whole host if the grant predates per-section scoping.
  async function userSitePatterns() {
    const builtIn = new Set(builtInMatches());
    const { origins = [] } = await chrome.permissions.getAll();
    const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
    return origins
      .filter((o) => !builtIn.has(o) && o !== "https://*/*")
      .flatMap((o) => (siteScopes[o]?.length ? siteScopes[o] : [o]))
      .sort();
  }

  // ---------- Automatic spotting (browser-side, no page access needed) ----------
  // chrome.declarativeContent lets the browser itself check a page against these rules and light up Clotr's
  // icon, without Clotr ever reading or running on the page. A page counts as spotted once its address has AI
  // wording and it has something that looks like a prompt box.

  // Written in RE2 syntax, since declarativeContent doesn't support lookarounds. "ai" only counts as a whole
  // label or TLD, so mail.google.com doesn't match, while gpt, llm, copilot and assistant can appear anywhere.
  const AI_URL_REGEX = "^https://(([^/]*[.-])?ai([.-][^/]*)?|[^/]*(gpt|llm|copilot|assistant)[^/]*)/";

  // declarativeContent only supports simple selectors, so these match on fragments instead of whole words:
  // "sk " catches both "Ask" and "ask", and "essage" catches both "Message" and "message".
  const PROMPT_SELECTORS = [
    'textarea[placeholder*="sk "]',
    'textarea[placeholder*="nything"]',
    'textarea[placeholder*="essage"]',
    'textarea[placeholder*="rompt"]',
    'textarea[aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="essage"]',
    '[contenteditable="true"][data-placeholder]',
    'div.ProseMirror[contenteditable="true"]',
  ];

  // ---------- On-demand check (popup, via activeTab) ----------
  // Only runs in the current tab, and only once someone opens the popup there. It has to be self-contained,
  // since it gets serialized and run inside the page itself.
  function inspectPageForAIChat() {
    const AI_WORDS =
      /\b(ai|a\.i\.|gpt|llm|chatbot|copilot|assistant|claude|gemini|mistral|llama|deepseek|perplexity|grok|qwen|kimi|language model)\b/i;
    const host = location.hostname;
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || "";
    const signals = [];

    if (/(^|[.-])ai([.-]|$)|gpt|llm|copilot|assistant/i.test(host)) signals.push("AI wording in the address");
    if (AI_WORDS.test(`${document.title} ${meta}`)) signals.push("AI wording in the page title");

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 150 && r.height > 16;
    };
    const describe = (el) =>
      [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("data-placeholder"),
        (el.textContent || "").slice(0, 120),
      ].join(" ");
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].filter(
      visible,
    );
    const promptBox = inputs.some((el) =>
      /ask|message|prompt|anything|question|describe|chat|type/i.test(describe(el)),
    );
    if (promptBox) signals.push("a chat-style prompt box");
    if (
      document.querySelector(
        'button[aria-label*="send" i], button[aria-label*="submit" i], button[data-testid*="send" i]',
      )
    ) {
      signals.push("a send button");
    }

    const aiWording = signals.some((s) => s.startsWith("AI wording"));
    // A prompt box alone could be any messaging app; require AI wording too.
    return { looksLikeAI: promptBox && aiWording, signals };
  }

  // What the popup tells you about a protected tab, based on what that tab's content script already reported
  // to the background. The level is one of on, idle, warn or paused.
  function healthText({ running = false, paused = false, editor = false, editFailed = false, uiRemoved = false } = {}) {
    if (!running)
      return {
        level: "warn",
        key: "hc_notRunning",
        text: "Clotr isn't running in this tab yet. Reload the page to start it.",
      };
    if (paused) return { level: "paused", key: "hc_paused", text: "Paused on this site" };
    if (uiRemoved)
      return {
        level: "warn",
        key: "hc_uiRemoved",
        text: "This page removed Clotr's warnings, so Clotr can't warn you here. Messages are never held on this page.",
      };
    if (editFailed)
      return {
        level: "warn",
        key: "hc_editFailed",
        text: "Clotr couldn't edit the chat box here last time. Delete flagged details by hand before sending.",
      };
    if (editor) return { level: "on", key: "hc_watching", text: "Protecting this site: watching the chat box ✓" };
    return { level: "idle", key: "hc_noBox", text: "Protecting this site: no chat box on this page yet" };
  }

  // ---------- Team policy ----------
  // Pure functions, so the rules are unit-tested; the background and popup apply them.
  const POLICY_RESPONSES = new Set(["block", "warn", "log"]);
  // Every team gets 500 watch words and 50 watch formats between its own watch list and its kinds, and up to
  // 20 kinds. A kind's format can also list up to 10 words that often appear near it.
  const MAX_POLICY_WORDS = 500;
  const MAX_POLICY_FORMATS = 50;
  const MAX_KINDS = 20;
  const MAX_NEAR = 10;

  // Ready-made policies an admin can turn on with a single word stored as `preset`. The ids are written out by
  // hand here rather than pulled from Clotr.PATTERNS, since sites.js loads before patterns.js does. A test
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
          "google_api_key",
          "slack_token",
          "crypto_secret",
          "service_token",
          "connection_string",
          "jwt",
          "internal_ip",
          "internal_host",
          "otp_secret",
          "password",
          "stripe_publishable_key",
        ].map((id) => [id, "block"]),
      ),
      allowPause: false,
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
      const value =
        typeof policy[key] === "boolean"
          ? policy[key]
          : preset && typeof preset[key] === "boolean"
            ? preset[key]
            : undefined;
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
      for (const k of kinds) requiredResponses[k.id] = k.response;
    }
    return merged;
  }

  // Whether a policy requires blocking this kind. The background checks this separately, because a vault
  // entry marked "OK to share" overrides the normal response, and that override needs its own floor too.
  function floorOf(policy, type) {
    return policy && typeof policy.requiredResponses === "object" && policy.requiredResponses?.[type] === "block"
      ? "block"
      : null;
  }

  // Whether the organization's policy asks before sending at least one kind of detail. If it does, a file that
  // might hold one of those kinds waits for the person to answer instead of going through silently, and the
  // question explains that the organization asked for the check. This is worked out on the fly rather than
  // stored, so it adds no field to the policy and doesn't change its fingerprint; the chat page only ever
  // learns this one yes or no. Bad entries, like an unknown id or value, are ignored.
  function teamHoldOf(policy) {
    const required = policy && typeof policy === "object" ? policy.requiredResponses : null;
    if (!required || typeof required !== "object") return false;
    return Object.entries(required).some(([id, value]) => /^[a-z0-9_]{1,64}$/.test(id) && value === "block");
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
    const C = globalThis.Clotr;
    for (const [id, value] of Object.entries(required)) {
      if (!/^[a-z0-9_]{1,64}$/.test(id) || !POLICY_RESPONSES.has(value)) continue;
      const current = C?.responseFor ? C.responseFor(id, user.responses) : responses[id];
      responses[id] = C?.stricter ? C.stricter(current ?? value, value) : value;
    }
    return {
      responses,
      paused: policy.allowPause === false ? false : Boolean(user.paused),
      largeText: policy.largeText === true || Boolean(user.largeText),
      locked: policy.lockSettings === true,
      pauseAllowed: policy.allowPause !== false,
    };
  }

  // ---------- Tourniquet: the stronger setup for someone you help ----------
  // Two presets you choose on this computer, one for a child and one for a grown-up (the code calls the
  // second one "adult"). Like a team preset, each one lists every kind of detail with its own floor: block
  // asks before sending, warn means a chat can't be set down to Just count. The ids are written out by hand
  // here too, and a test checks them against Clotr.PATTERNS, so a new kind in the engine has to be a deliberate
  // choice for both presets, not an oversight. It's all stored as one small record, `tourniquet: { for, since }`,
  // with an `until` added for the 30 days after a scam. Turning it off just removes that record, and whatever
  // settings were underneath go back to being in force.
  const SIGN_IN_CODES = [
    "private_key",
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "google_api_key",
    "slack_token",
    "crypto_secret",
    "service_token",
    "connection_string",
    "jwt",
    "otp_secret",
    "password",
  ];
  const MONEY_AND_IDS = [
    "us_ssn",
    "credit_card",
    "card_code",
    "gift_card",
    "bank_account",
    "national_id",
    "medical_record",
    "medicare_id",
    "passport",
    "drivers_license",
    "insurance_id",
    "my_id",
    "date_of_birth",
  ];
  const WHO_AND_WHERE = [
    "my_name",
    "family_name",
    "street_address",
    "phone_number",
    "email",
    "employer",
    "public_ip",
    "watch_list",
  ];
  // Public by design (an office network's address, a page's publishable payment key): a note, never a question.
  const TECHNICAL = ["internal_ip", "internal_host", "stripe_publishable_key"];
  // A car's numbers: a note for both, never a question. A student ID asks for a child, a note for a grown-up.
  const CAR = ["vin", "license_plate"];
  // These only come from an attached picture. Where a photo was taken asks for a child, since it can show
  // where they live, but it's just a note for a grown-up, the same as their address. A picture named like an
  // ID or a document asks for both, since a photo of an ID is exactly what scammers ask for.
  const PICTURE_PLACE = ["photo_location"];
  const PICTURE_ID = ["id_picture"];
  // A gamer tag, counted quietly by default: a note for both, never a question.
  const GAMES = ["gamer_tag"];
  const withResponse = (ids, value) => ids.map((id) => [id, value]);
  const TOURNIQUET = {
    // Who they are and where they live, kept from strangers online: every personal detail asks first.
    child: {
      requiredResponses: Object.fromEntries([
        ...withResponse([...SIGN_IN_CODES, ...MONEY_AND_IDS, ...WHO_AND_WHERE, "student_id"], "block"),
        ...withResponse([...TECHNICAL, ...CAR], "warn"),
        ...withResponse([...PICTURE_PLACE, ...PICTURE_ID], "block"),
        ...withResponse(GAMES, "warn"),
      ]),
      apps: ["Discord", "WhatsApp", "Messenger"],
    },
    // Money, ID numbers and sign-in codes, kept from scammers: those ask first; everyday details get a bigger note.
    adult: {
      requiredResponses: Object.fromEntries([
        ...withResponse([...SIGN_IN_CODES, ...MONEY_AND_IDS], "block"),
        ...withResponse([...WHO_AND_WHERE, ...TECHNICAL, ...CAR, "student_id"], "warn"),
        ...withResponse(PICTURE_PLACE, "warn"),
        ...withResponse(PICTURE_ID, "block"),
        ...withResponse(GAMES, "warn"),
      ]),
      largeText: true,
      apps: ["Gmail", "Outlook", "Yahoo Mail", "WhatsApp", "Messenger"],
    },
  };

  // After a scam, Scam Shield uses the exact same object as the grown-up preset, so the two can never drift
  // apart, for 30 days before it steps back down on its own. Scammers often come back to people who already
  // paid, now offering to help them get the money back.
  TOURNIQUET.after_scam = TOURNIQUET.adult;
  const TOURNIQUET_DAYS = 30;
  const DAY = 86400000;
  const LONGEST = 61 * DAY; // room for "30 more days" on top of a running 30

  // Checks that the stored record is exactly the shape expected, or returns null. That's either { for: "child"
  // or "adult", since }, or { for: "after_scam", since, until }, where until comes after since and no more than
  // 61 days later. Anything else is rejected, so a corrupted value can't quietly change what Tourniquet does.
  const isTime = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  function tourniquetRecord(t) {
    if (!t || typeof t !== "object" || Array.isArray(t) || !isTime(t.since)) return null;
    const keys = Object.keys(t).sort().join();
    if (t.for === "child" || t.for === "adult") return keys === "for,since" ? { for: t.for, since: t.since } : null;
    if (t.for !== "after_scam" || keys !== "for,since,until" || !isTime(t.until)) return null;
    if (t.until <= t.since || t.until - t.since > LONGEST) return null;
    return { for: t.for, since: t.since, until: t.until };
  }

  // The record while Tourniquet is actually on, or null once it isn't. The 30 days are measured against the
  // stored dates on this computer's own clock, and nothing ever rewrites those dates, so it turns off
  // everywhere the moment they end, even before anything else has had a chance to run. If the clock somehow
  // reads before the start, it just stays on, since that only ever adds protection, never removes it.
  function cleanTourniquet(t, now = Date.now()) {
    const r = tourniquetRecord(t);
    if (r?.until !== undefined && !(now < r.until)) return null;
    return r;
  }

  // A new 30 days from `now`.
  const afterScam = (now = Date.now()) => ({ for: "after_scam", since: now, until: now + TOURNIQUET_DAYS * DAY });

  // Which day of the 30 this is, counted from the stored start on this computer's clock: day 1 on the day it
  // was turned on, never less than 1 or more than the last day. Returns null for a record with no end.
  function tourniquetDay(t, now = Date.now()) {
    const r = tourniquetRecord(t);
    if (!r?.until) return null;
    const of = Math.ceil((r.until - r.since) / DAY);
    return { day: Math.min(of, Math.max(1, Math.floor((now - r.since) / DAY) + 1)), of };
  }

  // The end of the 30 days, kept until the person answers the popup's note: `{ since, at }`, or null.
  function tourniquetEnded(e) {
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).sort().join() !== "at,since") return null;
    if (!isTime(e.since) || !isTime(e.at) || e.at <= e.since || e.at - e.since > LONGEST) return null;
    return { since: e.since, at: e.at };
  }

  // Whether the computer's clock is now well before the latest time Clotr has already seen while the 30 days
  // were running, meaning someone turned it back. An hour of slack keeps small clock corrections from counting.
  const CLOCK_SLACK = 3600000;
  const tourniquetClockBack = (seen, now = Date.now()) => isTime(seen) && now < seen - CLOCK_SLACK;

  // Works out what the background should do about the 30 days right now: what to write, what to remove, and
  // what to set the end alarm to, or null to clear it. It's a pure function, so the three cases below can be
  // tested without moving the real clock, and none of them ever rewrites the stored dates or quietly adds or
  // removes days.
  //
  // If it's on and not yet ended, the alarm goes on the stored end date, and `tourniquetSeen` tracks the
  // latest time the clock has shown, never lower, so turning the clock back doesn't fool it; the popup notices
  // and says the clock went back.
  // If the end has been reached on this computer's clock, whether through the alarm or found later, it turns
  // off and the end gets recorded once in `tourniquetEnded`. Moving the clock forward past the end has the
  // same effect as time actually passing, and the note says so either way.
  // If it already ended, nothing new has been chosen since, and the clock is now well before that end, the
  // stored dates say the 30 days genuinely aren't over yet, so it comes back on using them.
  function tourniquetStep(s, now) {
    const out = { set: {}, remove: [], alarm: null };
    const r = tourniquetRecord(s.tourniquet);
    const seen = isTime(s.tourniquetSeen) ? s.tourniquetSeen : null;
    if (r?.until !== undefined) {
      if (now >= r.until) {
        out.set.tourniquetEnded = { since: r.since, at: r.until };
        out.remove.push("tourniquet");
        if (s.tourniquetSeen !== undefined) out.remove.push("tourniquetSeen");
        return out;
      }
      out.alarm = r.until;
      if (seen === null || now > seen) out.set.tourniquetSeen = now;
      if (s.tourniquetEnded !== undefined) out.remove.push("tourniquetEnded");
      return out;
    }
    if (s.tourniquetSeen !== undefined) out.remove.push("tourniquetSeen");
    if (r) {
      // Another preset chosen since the end: the note is no longer news.
      if (s.tourniquetEnded !== undefined) out.remove.push("tourniquetEnded");
      return out;
    }
    const ended = tourniquetEnded(s.tourniquetEnded);
    if (s.tourniquet === undefined && ended && now < ended.at - CLOCK_SLACK) {
      out.set.tourniquet = { for: "after_scam", since: ended.since, until: ended.at };
      out.set.tourniquetSeen = ended.at; // the clock showed at least the end once: the popup says it went back
      out.remove = ["tourniquetEnded"];
      out.alarm = ended.at;
    }
    return out;
  }

  // Tourniquet as a policy-shaped object (a copy of its rules), or null when it's off.
  function tourniquetPolicy(t, now = Date.now()) {
    const clean = cleanTourniquet(t, now);
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
      requiredResponses[id] = POLICY_RESPONSES.has(theirs) && RANK[theirs] < RANK[value] ? theirs : value;
    }
    const combined = { ...base, requiredResponses, watchWords: Array.isArray(base.watchWords) ? base.watchWords : [] };
    if (tourniquet.largeText === true) combined.largeText = true;
    return combined;
  }

  // Which kinds a policy, or Tourniquet inside it, holds firmly: a warning for one of these never offers to
  // loosen it. A floor of "Just count" doesn't actually hold anything, since nothing can go lower than that
  // anyway.
  function firmKinds(policy) {
    const required = policy && typeof policy.requiredResponses === "object" ? policy.requiredResponses : null;
    if (!required) return [];
    return Object.entries(required)
      .filter(([id, v]) => /^[a-z0-9_]{1,64}$/.test(id) && (v === "block" || v === "warn"))
      .map(([id]) => id);
  }

  // Whether this is a watched format, like "EMP-#####" where # stands for a digit and @ for a letter. It uses
  // the same rule as vault.js's own format check, so an admin's formats and an employee's behave the same
  // way. Formats aren't secret, so they're kept and sent around exactly as typed.
  function isShape(p) {
    if (typeof p !== "string") return false;
    const s = p.trim();
    if (!s || s.length > 40) return false;
    const marks = (s.match(/[#@]/g) || []).length;
    return marks >= 4 && !/\d/.test(s);
  }

  // The admin's watch formats (isShape), up to 50, in the order given, duplicates dropped.
  function policyShapes(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const w of policy.watchWords) {
      const s = typeof w === "string" ? w.trim() : "";
      if (!isShape(s) || out.includes(s)) continue;
      out.push(s);
      if (out.length >= MAX_POLICY_FORMATS) break;
    }
    return out;
  }

  // Cleans up one watch word or phrase: trimmed, lowercased, capped at four words and 100 characters, or ""
  // if it doesn't qualify. A format never counts as a phrase here, since it's watched as a format instead of
  // being hashed as literal text.
  function cleanPhrase(w) {
    if (typeof w !== "string" || isShape(w)) return "";
    const phrase = w.trim().toLowerCase().replace(/\s+/g, " ");
    return phrase && phrase.length <= 100 && phrase.split(" ").length <= 4 ? phrase : "";
  }

  // The admin's watch words, cleaned (cleanPhrase), 500 at most.
  function policyWords(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const w of policy.watchWords) {
      const phrase = cleanPhrase(w);
      if (!phrase || out.includes(phrase)) continue;
      out.push(phrase);
      if (out.length >= MAX_POLICY_WORDS) break;
    }
    return out;
  }

  // A name or cover word as people will read it: no control or invisible characters, single spaces, at most `max`.
  const plainText = (v, max) =>
    typeof v === "string"
      ? v
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
          .trim()
      : "";
  // Bandage's word for a kind: no brackets or digits, so "[Matter 2]" always reads back as the second matter.
  const coverWord = (v) => {
    const w = plainText(typeof v === "string" ? v.replace(/[[\]\d]/g, " ") : "", 20);
    return /\p{L}/u.test(w) ? w : "";
  };
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
    for (let i = 1; taken.has(id); i++) id = `${base.slice(0, 38).replace(/_+$/, "")}_${String.fromCharCode(97 + i)}`;
    taken.add(id);
    return id;
  }

  // Cleans up a team's own kinds into a list of { id, name, cover, response, words, formats, near }. A kind
  // needs a name, up to 40 characters, since that's what shows up in warnings. Its words are cleaned the same
  // way watch words are, so a format typed in there is treated as a format instead; both share the policy's
  // overall limit of 500 words and 50 formats along with the regular watch list, counted first come first
  // served, and nothing already watched gets counted twice. A kind that runs out of room keeps its name and
  // response but ends up matching nothing. `near` holds up to 10 nearby words, each up to 40 characters. The
  // response defaults to warn unless it's explicitly block, warn or log, and the cover word, Bandage's name
  // for it, defaults to the kind's own name, or "ID" if neither has a real letter in it. This is a pure
  // function, and cleaning an already-clean list changes nothing, so the merged policy can go through it
  // again safely anywhere.
  function policyKinds(policy = {}) {
    if (!Array.isArray(policy.kinds)) return [];
    const words = new Set(policyWords(policy));
    const watchFormats = policyShapes(policy);
    const formats = new Set(watchFormats.map((f) => f.toLowerCase()));
    let wordsLeft = MAX_POLICY_WORDS - words.size;
    let formatsLeft = MAX_POLICY_FORMATS - watchFormats.length;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    const ids = new Set();
    const out = [];
    for (const k of policy.kinds) {
      if (out.length >= MAX_KINDS) break;
      if (!k || typeof k !== "object" || Array.isArray(k)) continue;
      const name = plainText(k.name, 40);
      if (!/[\p{L}\p{N}]/u.test(name)) continue;
      const kind = {
        id: kindId(name, ids),
        name,
        cover: coverWord(k.cover) || coverWord(name) || "ID",
        response: POLICY_RESPONSES.has(k.response) ? k.response : "warn",
        words: [],
        formats: [],
        near: [],
      };
      const addFormat = (f) => {
        const shape = f.trim();
        if (!isShape(shape) || formats.has(shape.toLowerCase()) || formatsLeft <= 0) return;
        formats.add(shape.toLowerCase());
        formatsLeft--;
        kind.formats.push(shape);
      };
      for (const w of list(k.words)) {
        if (isShape(w)) {
          addFormat(w);
          continue;
        }
        const phrase = cleanPhrase(w);
        if (!phrase || words.has(phrase) || wordsLeft <= 0) continue;
        words.add(phrase);
        wordsLeft--;
        kind.words.push(phrase);
      }
      for (const f of list(k.formats)) addFormat(f);
      for (const w of list(k.near)) {
        const word = plainText(w, Infinity).toLowerCase();
        if (word.length > 40 || !/[\p{L}\p{N}]/u.test(word) || kind.near.includes(word)) continue;
        kind.near.push(word);
        if (kind.near.length >= MAX_NEAR) break;
      }
      out.push(kind);
    }
    return out;
  }

  // Whether the merged policy actually sets anything. mergePolicy always returns an object with empty
  // requiredResponses and watchWords by default, so those alone don't count as "set". The popup's banner and
  // the attestation page's "no policy" line both depend on this.
  function hasPolicy(policy) {
    const p = policy && typeof policy === "object" ? policy : {};
    return Boolean(
      (p.requiredResponses && Object.keys(p.requiredResponses).length) ||
      (Array.isArray(p.watchWords) && p.watchWords.length) ||
      (Array.isArray(p.kinds) && p.kinds.length) ||
      typeof p.allowPause === "boolean" ||
      typeof p.lockSettings === "boolean" ||
      typeof p.largeText === "boolean" ||
      typeof p.orgName === "string" ||
      typeof p.preset === "string",
    );
  }

  // A short, stable code for one merged and validated policy, shown on the attestation page. A preset and
  // its fully expanded JSON print the exact same code, so an admin can compare a test machine's page against
  // the policy they meant to set. It's unsalted on purpose, since this code isn't a secret. `preset`, `orgName`
  // and the extension version are left out, so the code only changes when the policy's actual rules change.
  function policyFingerprint(policy) {
    const p = policy && typeof policy === "object" ? policy : {};
    const required = p.requiredResponses && typeof p.requiredResponses === "object" ? p.requiredResponses : {};
    const r = Object.entries(required)
      .filter(([id, v]) => /^[a-z0-9_]{1,64}$/.test(id) && POLICY_RESPONSES.has(v))
      .sort(([a], [b]) => a.localeCompare(b));
    const canon = {
      v: 1,
      r,
      w: policyWords(p).slice().sort(),
      s: policyShapes(p)
        .map((x) => x.toLowerCase())
        .sort(),
      p: p.allowPause !== false,
      l: p.lockSettings === true,
      t: p.largeText === true,
    };
    // The team's own kinds only join the canonical form when there are any, so every code printed before
    // kinds existed stays unchanged. Their order is kept as-is, since it's what decides the ids when two
    // names collide.
    const kinds = policyKinds(p);
    if (kinds.length)
      canon.k = kinds.map((k) => [
        k.id,
        k.name,
        k.cover,
        k.response,
        k.words.slice().sort(),
        k.formats.map((x) => x.toLowerCase()).sort(),
        k.near.slice().sort(),
      ]);
    return globalThis.Clotr.sha256(JSON.stringify(canon)).slice(0, 16).toUpperCase();
  }

  globalThis.ClotrSites = {
    healthText,
    PRESETS,
    mergePolicy,
    applyPolicy,
    floorOf,
    teamHoldOf,
    TOURNIQUET,
    TOURNIQUET_DAYS,
    tourniquetRecord,
    cleanTourniquet,
    afterScam,
    tourniquetDay,
    tourniquetEnded,
    tourniquetClockBack,
    tourniquetStep,
    tourniquetPolicy,
    combinePolicies,
    firmKinds,
    isShape,
    policyShapes,
    policyWords,
    policyKinds,
    policyFingerprint,
    hasPolicy,
    CONTENT_JS,
    USER_SCRIPT_ID,
    EVERYDAY_SITES,
    everydaySiteFor,
    everydayOrigins,
    grantedEverydayApps,
    requestEverydayApps,
    removeEverydayApps,
    offerAfterInstall,
    isEveryday,
    collapseBatch,
    weight,
    AI_URL_REGEX,
    PROMPT_SELECTORS,
    builtInMatches,
    matchPatternToRegExp,
    urlMatchesAny,
    originPattern,
    protectScope,
    permissionFor,
    isWiderThanNeeded,
    userSitePatterns,
    inspectPageForAIChat,
  };
})();
