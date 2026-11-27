// Turns a found detail into a decision (warn, log or stay quiet) and the words a warning uses, the same in every
// host, since it never touches the page, storage or browser. A host passes its state as `s`: the salt, vault
// entries, each kind's response, this site's mode, and an optional cache it clears when the salt or vault changes.
(() => {
  "use strict";

  const { msg, responseFor, fingerprintFor, ASK_REASONS } = globalThis.Clotr;

  // ---------- Showing a value ----------

  // A full secret is never shown back on screen. A short value becomes all dots, and a password-like kind is eight
  // dots at any length, so its length doesn't show either.
  // A gift card works like cash, a private key starts with a fixed header, a connection string often holds a password.
  const PASSWORD_KINDS = new Set([
    "password",
    "backup_codes",
    "crypto_secret",
    "otp_secret",
    "card_code",
    "gift_card",
    "private_key",
    "connection_string",
  ]);

  // Any other value keeps at most a quarter of itself, and two characters at each end. A `kind` that isn't a string
  // gets that rule too. A `value` that isn't a string throws, since a long array would come back with items whole.
  function mask(value, kind) {
    if (typeof value !== "string") throw new TypeError("mask takes one string");
    if (value.length <= 8) return "•".repeat(value.length);
    if (typeof kind === "string" && PASSWORD_KINDS.has(kind)) return "•".repeat(8);
    const shown = Math.min(4, Math.floor(value.length / 4));
    const head = Math.ceil(shown / 2);
    return `${value.slice(0, head)}…${value.slice(value.length - (shown - head))}`;
  }

  // Each kind gets one line. With more than a few values, it shows a count plus a couple of masked examples
  // instead of listing every one.
  function describeValues(result) {
    const shown = result.matches
      .slice(0, 3)
      .map((value) => mask(value, result.id))
      .join(", ");
    return result.matches.length > 3 ? `×${result.matches.length}: ${shown}, …` : shown;
  }

  // ---------- What each found value does ----------

  // A site's own mode overrides a kind's usual response: a site set to block everything wins even over a kind
  // that's normally just logged, and the same the other way around for a quieter site.
  function responseOf(patternId, s) {
    const kindResponse = responseFor(patternId, s.responses);
    return s.siteMode || kindResponse;
  }

  // What the vault says about one value: "protect", "allow" or null. The vault holds only fingerprints (setVault
  // in vault/saved-words.js). Each value is hashed once and cached, capped at 2,000 so a tab open all day doesn't
  // grow forever.
  // A host can give one check a budget (`s.budget = { until, missed }`, from performance.now()). Once it's
  // spent, a value needing a strong fingerprint comes back undefined and goes on `missed` for later.
  function vaultMode(patternId, match, s) {
    const entries = s.vault || [];
    if (!s.salt || !entries.some((saved) => saved.kind === "value")) return null;
    const cache = s.cache;
    const key = `${patternId}\0${match}`;
    if (cache?.has(key)) return cache.get(key);
    if (
      s.budget &&
      performance.now() > s.budget.until &&
      entries.some((saved) => saved.kind === "value" && saved.type === patternId && saved.scheme === 2)
    ) {
      s.budget.missed.push([patternId, match]);
      return undefined;
    }
    if (cache && cache.size >= 2000) cache.clear();
    // A stored entry may have been fingerprinted under either scheme, so each is compared the way it was
    // made; nothing is rehashed with the other scheme unless some stored entry actually needs it.
    const savedEntry = (id) => {
      const candidates = entries.filter((saved) => saved.kind === "value" && saved.type === patternId);
      // The stronger scheme is slow on purpose, so each scheme is worked out once per match, not once per entry:
      // twenty saved cards would otherwise cost twenty slow hashes for the same text.
      const byScheme = new Map();
      const fingerprintOf = (scheme) => {
        const which = scheme === 2 ? 2 : 1;
        if (!byScheme.has(which)) byScheme.set(which, fingerprintFor(which === 2 ? 2 : undefined, s.salt, id, match));
        return byScheme.get(which);
      };
      return candidates.find((saved) => saved.fp === fingerprintOf(saved.scheme));
    };
    // An address saved by an older version of Clotr kept its accents in the fingerprint, so it still matches a
    // value typed with accents even though newer entries strip them first.
    const found =
      savedEntry(patternId) ||
      (patternId === "street_address" && /[^\x00-\x7f]/.test(match) && savedEntry("street_address_accented"));
    const mode = found?.mode || null;
    cache?.set(key, mode);
    return mode;
  }

  // If your own ID is in the vault, any other ID that merely has the same format is split out. Those get called
  // "Account/ID Number" and ranked lower than your actual one.
  function splitOwnIds(results, s) {
    if (!s.salt || !(s.vault || []).some((saved) => saved.kind === "value" && saved.type === "my_id")) return results;
    return results.flatMap((result) => {
      if (result.id !== "my_id") return [result];
      // An ID not worked out yet (a host's time budget ran out) stays with yours, keeping the higher rank.
      const own = result.matches.filter((value) => vaultMode("my_id", value, s) !== null);
      const other = result.matches.filter((value) => vaultMode("my_id", value, s) === null);
      return [
        ...(own.length ? [{ ...result, matches: own }] : []),
        ...(other.length
          ? [{ ...result, matches: other, name: msg("otherAccountId", "Account/ID Number"), severity: "medium" }]
          : []),
      ];
    });
  }

  // Works out the real response for one value, starting from its kind's usual response and then checking the
  // vault. A value you marked OK to share is only logged, even when its kind would warn or block. One you marked
  // worth protecting goes from a quiet log up to a warning, and a "protect" entry never lowers a response.
  function respFor(result, value, s) {
    const base = responseOf(result.id, s);
    // Only an "OK to share" entry can change a warning, and only a "protect" one a quiet kind. With no saved value
    // of this kind that could, the lookup is skipped: it costs a strong fingerprint per value, and a pasted list of
    // hundreds of phone numbers would hold the tab for seconds.
    const canChangeIt = base === "log" ? "protect" : "allow";
    const couldChange = (saved) => saved.kind === "value" && saved.type === result.id && saved.mode === canChangeIt;
    if (!s.salt || !(s.vault || []).some(couldChange)) return base;
    const mode = vaultMode(result.id, value, s);
    // Not known yet: never quieter than the full answer could be.
    if (mode === undefined) return base === "log" ? "warn" : base;
    if (mode === "allow") return "log";
    if (mode === "protect" && base === "log") return "warn";
    return base;
  }

  // ---------- The words ----------

  // Builds the warning as { lead, items, tail }, each item "Kind (masked value)", so every host shows the same words
  // and only draws them differently. `everyday` means an email or chat app; `source` is "typed" or "copied" (caught
  // on the clipboard before a paste).
  function noticeWords(results, { everyday = false, source = "typed" } = {}) {
    const items = results.flatMap((result) =>
      result.matches.map((value) => `${result.name} (${mask(value, result.id)})`),
    );
    if (source === "copied") {
      return {
        lead: msg("noticeCopiedContains", "What you copied contains "),
        items,
        tail: everyday
          ? msg("noticeCopiedSharedHere", ". If you paste it here, the people who read it get it.")
          : msg("noticeCopiedShared", ". If you paste it here, this AI app gets it."),
      };
    }
    return {
      lead: msg("noticeContains", "Your message contains "),
      items,
      tail: everyday
        ? msg("noticeSharedHere", ". If you send it, the people who read it here get it.")
        : msg("noticeShared", ". If you send it, this AI gets it."),
    };
  }

  // ---------- Who really asks for this ----------
  // A card's security code, a gift card's numbers and the five codes scammers ask people to read out (the password
  // kind's reasons). WHO_ASKS is the order a warning's one line is picked in. Each has a name, a question, an answer
  // under the lead and a "what to do" behind "Why am I seeing this?".
  const WHO_ASKS = ["card_code", "gift_card", ...ASK_REASONS];
  // Each answer says calmly who really asks for the detail, never "you're being scammed", backed by these sources
  // ("plain fact" means the detail's own nature is the source). None of it is stored, counted or sent.
  const SOURCES = {
    // The Georgia Attorney General's page on credit card scams says credit card companies will never ask for your
    // 3-digit code, since they already have it. The FTC's guide on what to do if you were scammed says to tell
    // your bank.
    card_code: [
      "https://consumer.georgia.gov/credit-card-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
    // The FTC's page on gift card scams says no real business or government agency will ever tell you to buy a
    // gift card to pay them, and its scam guide says to call the issuer on the number on the back of the card.
    gift_card: [
      "https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
    // The FTC says anyone who asks for your account verification code is a scammer, and that sharing one with
    // someone you didn't contact first is a scam every time.
    login_code: [
      "https://consumer.ftc.gov/consumer-alerts/2024/03/whats-verification-code-why-would-someone-ask-me-it",
      "https://consumer.ftc.gov/consumer-alerts/2021/10/google-voice-scam-how-verification-code-scam-works-how-avoid-it",
    ],
    // The FTC's page on tech support scams says real tech companies won't contact you about a problem with your
    // computer, and its scam guide says to update your software, run a scan, and change your passwords.
    remote_code: [
      "https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams",
      "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed",
    ],
    recovery_codes: ["plain fact"],
    security_answer: ["plain fact"],
    home_code: ["plain fact"],
  };

  // Gives a reason the same kind of display name a detection kind would have, like "Sign-in Code".
  function reasonName(reason) {
    switch (reason) {
      case "login_code":
        return msg("ss_askLoginCodeName", "Sign-in Code");
      case "remote_code":
        return msg("ss_askRemoteCodeName", "Remote-Access Code");
      case "recovery_codes":
        return msg("ss_askRecoveryCodesName", "Backup Codes");
      case "security_answer":
        return msg("ss_askSecurityAnswerName", "Security Answer");
      case "home_code":
        return msg("ss_askHomeCodeName", "PIN or Door Code");
      default:
        return null;
    }
  }

  // Builds one kind's or reason's words: an id, a display name, a question, its answer, what to do about it, and
  // the sources backing the answer.
  function whoAsksFor(id) {
    const say = (q, a, todo) => ({
      id,
      name: reasonName(id) || globalThis.Clotr.PATTERNS.find((p) => p.id === id)?.name || id,
      q,
      a,
      todo,
      sources: SOURCES[id],
    });
    switch (id) {
      case "card_code":
        return say(
          msg("ss_askCardCodeQ", "Who asks for the 3 numbers on the back of your card?"),
          msg(
            "ss_askCardCodeA",
            "Not your card company: it already has them. Type them only into a checkout page you opened yourself.",
          ),
          msg(
            "ss_askCardCodeDo",
            "Don't send them. If they already went to someone, call the number on your card and ask for a new card.",
          ),
        );
      case "gift_card":
        return say(
          msg("ss_askGiftCardQ", "Who asks for the numbers on a gift card?"),
          msg(
            "ss_askGiftCardA",
            "Scammers do. No real business or government agency will ever tell you to pay them with a gift card.",
          ),
          msg(
            "ss_askGiftCardDo",
            "Don't send them. If you already did, call the gift card company on the number on the back of the card and ask for your money back.",
          ),
        );
      case "login_code":
        return say(
          msg("ss_askLoginCodeQ", "Who asks for a code that was sent to you?"),
          msg(
            "ss_askLoginCodeA",
            "Only scammers: with it, they get into your account. No real bank, company or buyer asks for it.",
          ),
          msg(
            "ss_askLoginCodeDo",
            "Don't send it. If someone called or messaged you for it, hang up and call the number on your card.",
          ),
        );
      case "remote_code":
        return say(
          msg("ss_askRemoteCodeQ", "Who asks for a code to get into your computer?"),
          msg(
            "ss_askRemoteCodeA",
            "Fake tech support. Real tech companies don't call or message you about a problem with your computer.",
          ),
          msg(
            "ss_askRemoteCodeDo",
            "Don't send it. If you already let someone in, update your security software, run a scan and change your passwords.",
          ),
        );
      case "recovery_codes":
        return say(
          msg("ss_askRecoveryCodesQ", "Who asks for your backup codes?"),
          msg(
            "ss_askRecoveryCodesA",
            "Only someone trying to get into your account without you. They're its spare keys.",
          ),
          msg("ss_askRecoveryCodesDo", "Keep them on paper or in your password manager, never in a chat."),
        );
      case "security_answer":
        return say(
          msg("ss_askSecurityAnswerQ", "Who asks for your security answers?"),
          msg(
            "ss_askSecurityAnswerA",
            "They open your account like a password. Someone asking in a chat may be trying to reset yours.",
          ),
          msg(
            "ss_askSecurityAnswerDo",
            "Don't send them. If you already did, change the answer in that account's settings.",
          ),
        );
      case "home_code":
        return say(
          msg("ss_askHomeCodeQ", "Who needs your PIN or a door code?"),
          msg(
            "ss_askHomeCodeA",
            "Only you, and people you'd give your keys to. Someone who contacted you first and asks for it is likely a scammer.",
          ),
          msg("ss_askHomeCodeDo", "Don't send it in a chat. If a card's PIN went out, call the number on your card."),
        );
      default:
        return null;
    }
  }

  // Lists the kinds and reasons that show up in a warning's results, in WHO_ASKS' order. The first one's line
  // shows right under the warning's lead, and "Why am I seeing this?" shows its what-to-do plus the rest as
  // questions. A code only counts while its match is still in the results, so one the person already allowed
  // through leaves no line behind.
  function whoAsks(results) {
    const named = new Map();
    for (const result of results) {
      if (result.id === "card_code" || result.id === "gift_card") named.set(result.id, result.name);
      else if (result.id === "password" && result.reasonOf) {
        for (const value of result.matches) if (result.reasonOf.has(value)) named.set(result.reasonOf.get(value), null);
      }
    }
    return WHO_ASKS.filter((id) => named.has(id)).map((id) => {
      const words = whoAsksFor(id);
      return named.get(id) ? { ...words, name: named.get(id) } : words;
    });
  }

  // Renames results the way a warning shows them. A password result whose matches all have a known reason splits
  // into one entry per reason ("Sign-in Code"); otherwise it stays "Password or Secret". Only the screen changes:
  // History's results stay untouched.
  function asShown(results) {
    return results.flatMap((result) => {
      const reasons = result.reasonOf ? result.matches.map((value) => result.reasonOf.get(value)) : [];
      if (!reasons.length || !reasons.every(Boolean)) return [result];
      return ASK_REASONS.filter((reason) => reasons.includes(reason)).map((reason) => ({
        ...result,
        name: reasonName(reason),
        matches: result.matches.filter((_, i) => reasons[i] === reason),
      }));
    });
  }

  // ---------- What's allowed into storage (each host's one writer keeps only what passes this) ----------

  const VAULT_KINDS = new Set(["value", "word", "shape"]);
  const VAULT_MODES = new Set(["protect", "allow"]);
  const vaultKey = (entry) =>
    entry.kind === "shape"
      ? `shape:${entry.type}:${String(entry.shape).toLowerCase()}`
      : `${entry.kind}:${entry.type}:${entry.fp}`;

  function dedupeVault(entries) {
    const seen = new Set();
    return entries.filter((entry) => {
      const key = vaultKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Checks that an entry is well-formed before it's allowed into storage. A raw value can never pass this check.
  function cleanVaultEntry(entry) {
    if (!entry || !VAULT_KINDS.has(entry.kind)) return null;
    if (typeof entry.type !== "string" || !/^[a-z_]{2,40}$/.test(entry.type)) return null;
    const out = { kind: entry.kind, type: entry.type, added: Number.isFinite(entry.added) ? entry.added : Date.now() };
    if (entry.kind === "shape") {
      const shape = entry.shape;
      if (typeof shape !== "string" || !/[#@].*[#@]/.test(shape) || /\d/.test(shape) || shape.length > 40) return null;
      out.shape = entry.shape;
    } else {
      if (!/^[0-9a-f]{16}$/.test(entry.fp)) return null;
      out.fp = entry.fp;
      // Absent means the original, single-round fingerprint; 2 is the stronger, iterated one. Nothing else
      // written here, so a tampered or future value just falls back to the original scheme.
      if (entry.scheme === 2) out.scheme = 2;
      if (entry.kind === "word") out.words = Math.min(4, Math.max(1, Number(entry.words) || 1));
      // A name saved with an apostrophe has a second fingerprint, of its form without one (wordEntry in
      // respond/fingerprints.js).
      if (entry.kind === "word" && /^[0-9a-f]{16}$/.test(entry.joined)) out.joined = entry.joined;
      // A word written only in a script without spaces keeps its count of letters and its head (wordEntry in
      // respond/fingerprints.js): both, or neither.
      if (
        entry.kind === "word" &&
        Number.isInteger(entry.closed) &&
        entry.closed >= 2 &&
        entry.closed <= 64 &&
        Number.isInteger(entry.head) &&
        entry.head >= 0 &&
        entry.head < 4096
      ) {
        out.closed = entry.closed;
        out.head = entry.head;
      }
      if (entry.kind === "value") out.mode = VAULT_MODES.has(entry.mode) ? entry.mode : "protect";
    }
    if (entry.learned) out.learned = true;
    return out;
  }

  // A "mentioned" event means an AI's reply brought up one of your vault details, not something you typed. The
  // background keeps those in a separate `mentions` list so they're never counted as found in your own messages.
  const ACTIONS = new Set(["redacted", "allowed", "suppressed", "mentioned"]);
  const SEVERITIES = new Set(["high", "medium", "low"]);

  // Keeps only an event's known fields, each checked for a sane value, so nothing a page adds on its own ever
  // gets stored.
  function cleanEvent(event) {
    if (!event || typeof event !== "object") return null;
    if (!ACTIONS.has(event.action) || !SEVERITIES.has(event.severity)) return null;
    const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
    const out = {
      t: Number.isFinite(event.t) ? event.t : Date.now(),
      site: clip(event.site, 253),
      type: clip(event.type, 64),
      name: clip(event.name, 64),
      severity: event.severity,
      action: event.action,
      fp: /^[0-9a-f]{16}$/.test(event.fp) ? event.fp : "",
    };
    // Marks whether a "redacted" event happened because Bandage swapped the detail for a label while you typed,
    // as opposed to you hiding it by hand with "Hide it" in the dialog or notice, so the report can tell the two
    // apart.
    if (event.via === "bandage") out.via = "bandage";
    // Absent means the original, single-round fingerprint; see cleanVaultEntry for why that's never rewritten.
    if (event.scheme === 2) out.scheme = 2;
    return out;
  }

  globalThis.Clotr = {
    ...globalThis.Clotr,
    mask,
    describeValues,
    responseOf,
    vaultMode,
    splitOwnIds,
    respFor,
    noticeWords,
    WHO_ASKS,
    whoAsksFor,
    whoAsks,
    asShown,
    VAULT_MODES,
    vaultKey,
    dedupeVault,
    cleanVaultEntry,
    cleanEvent,
  };
})();
