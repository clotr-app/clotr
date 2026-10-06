// This file turns a found detail into a decision (warn, log, or stay quiet) and into the words a warning uses. It
// never touches the page, storage, or the browser, so every host gets the same answer for the same detail. A host
// passes in its own state as `s`: the salt, the vault entries, each kind's response setting, this site's mode if
// it has one, and an optional cache the host clears whenever the salt or vault changes.
// Loaded after patterns.js and detector.js, since it uses their msg, responseFor, fingerprint, and ASK_REASONS.
(() => {
  "use strict";

  const { msg, responseFor, fingerprint, ASK_REASONS } = globalThis.Clotr;

  // ---------- Showing a value ----------

  // I never show a full secret back on screen. A short value becomes all dots. A longer one keeps its first four
  // characters and its last two, with dots in between.
  function mask(value) {
    if (value.length <= 8) return "•".repeat(value.length);
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
  }

  // Each kind gets one line. With more than a few values, I show a count plus a couple of masked examples
  // instead of listing every one.
  function describeValues(r) {
    const shown = r.matches.slice(0, 3).map(mask).join(", ");
    return r.matches.length > 3 ? `×${r.matches.length}: ${shown}, …` : shown;
  }

  // ---------- What each found value does ----------

  // A site's own mode overrides a kind's usual response: a site set to block everything wins even over a kind
  // that's normally just logged, and the same the other way around for a quieter site.
  function responseOf(patternId, s) {
    const r = responseFor(patternId, s.responses);
    return s.siteMode || r;
  }

  // Looks up what the vault says about one value: "protect", "allow", or null if it isn't in there. The vault only
  // ever holds fingerprints, never the real value (see setVault in patterns.js). I hash each value once and cache
  // the result, capped at 2,000 entries so a tab left open all day doesn't grow it forever.
  function vaultMode(patternId, match, s) {
    const entries = s.vault || [];
    if (!s.salt || !entries.some((e) => e.kind === "value")) return null;
    const cache = s.cache;
    const key = `${patternId}\0${match}`;
    if (cache?.has(key)) return cache.get(key);
    if (cache && cache.size >= 2000) cache.clear();
    const entry = (id) => {
      const fp = fingerprint(s.salt, id, match);
      return entries.find((e) => e.kind === "value" && e.type === patternId && e.fp === fp);
    };
    // An address saved by an older version of Clotr kept its accents in the fingerprint, so it still matches a
    // value typed with accents even though newer entries strip them first.
    const found =
      entry(patternId) ||
      (patternId === "street_address" && /[^\x00-\x7f]/.test(match) && entry("street_address_accented"));
    const mode = found?.mode || null;
    cache?.set(key, mode);
    return mode;
  }

  // If your own ID is in the vault, I split out any other ID that merely has the same format. Those get called
  // "Account/ID Number" and ranked lower than your actual one.
  function splitOwnIds(results, s) {
    if (!s.salt || !(s.vault || []).some((e) => e.kind === "value" && e.type === "my_id")) return results;
    return results.flatMap((r) => {
      if (r.id !== "my_id") return [r];
      const own = r.matches.filter((m) => vaultMode("my_id", m, s));
      const other = r.matches.filter((m) => !vaultMode("my_id", m, s));
      return [
        ...(own.length ? [{ ...r, matches: own }] : []),
        ...(other.length
          ? [{ ...r, matches: other, name: msg("otherAccountId", "Account/ID Number"), severity: "medium" }]
          : []),
      ];
    });
  }

  // Works out the real response for one value, starting from its kind's usual response and then checking the
  // vault. If you marked it OK to share, I only log it. If you marked it worth protecting, I raise a silent log
  // up to a warning, but the vault never lowers a response below what the kind would normally get.
  function respFor(r, m, s) {
    const mode = vaultMode(r.id, m, s);
    if (mode === "allow") return "log";
    const base = responseOf(r.id, s);
    return mode === "protect" && base === "log" ? "warn" : base;
  }

  // ---------- The words ----------

  // Builds the warning's sentence as { lead, items, tail }. Each item reads "Kind (masked value)", so every host
  // shows the same words in the same language and only differs in how it draws them (the browser wraps each item
  // in its own <code> tag). `everyday` means this is an email or chat app where another person reads the
  // message. `source` is "typed" for what you wrote, or "copied" for something a host caught on the clipboard
  // before you pasted it.
  function noticeWords(results, { everyday = false, source = "typed" } = {}) {
    const items = results.flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`));
    if (source === "copied")
      return {
        lead: msg("noticeCopiedContains", "What you copied contains "),
        items,
        tail: everyday
          ? msg("noticeCopiedSharedHere", ". If you paste it here, the people who read it get it.")
          : msg("noticeCopiedShared", ". If you paste it here, this AI app gets it."),
      };
    return {
      lead: msg("noticeContains", "Your message contains "),
      items,
      tail: everyday
        ? msg("noticeSharedHere", ". If you send it, the people who read it here get it.")
        : msg("noticeShared", ". If you send it, this AI gets it."),
    };
  }

  // ---------- Who really asks for this ----------
  // This covers a card's security code, a gift card's numbers, and the five codes a scammer asks people to read
  // out (the password kind's reasons, from findSecrets in patterns.js). WHO_ASKS gives the order I pick a
  // warning's one line from. Each one has a name, a question, an answer that shows under the warning's lead, and
  // a "what to do" that shows behind "Why am I seeing this?". The answer says calmly who really asks for the
  // detail, without ever telling the person they're being scammed, and each one is backed by the sources listed
  // next to it ("plain fact" means the detail's own nature is the source, nothing more is needed). None of this
  // is stored, counted, or sent anywhere. It's just words shown on screen.
  const WHO_ASKS = ["card_code", "gift_card", ...ASK_REASONS];
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
    for (const r of results) {
      if (r.id === "card_code" || r.id === "gift_card") named.set(r.id, r.name);
      else if (r.id === "password" && r.reasonOf)
        for (const m of r.matches) if (r.reasonOf.has(m)) named.set(r.reasonOf.get(m), null);
    }
    return WHO_ASKS.filter((id) => named.has(id)).map((id) => {
      const words = whoAsksFor(id);
      return named.get(id) ? { ...words, name: named.get(id) } : words;
    });
  }

  // Renames results the way a warning should show them. If every match in a password result has a known reason,
  // I split it into one entry per reason, each named for that reason ("Sign-in Code"). If some matches are a
  // plain password with no reason, I leave the whole result as "Password or Secret" instead. This only changes
  // what's shown on screen; the results that History records stay untouched.
  function asShown(results) {
    return results.flatMap((r) => {
      const reasons = r.reasonOf ? r.matches.map((m) => r.reasonOf.get(m)) : [];
      if (!reasons.length || !reasons.every(Boolean)) return [r];
      return ASK_REASONS.filter((x) => reasons.includes(x)).map((x) => ({
        ...r,
        name: reasonName(x),
        matches: r.matches.filter((_, i) => reasons[i] === x),
      }));
    });
  }

  // ---------- What's allowed into storage (each host's one writer keeps only what passes this) ----------

  const VAULT_KINDS = new Set(["value", "word", "shape"]);
  const VAULT_MODES = new Set(["protect", "allow"]);
  const vaultKey = (e) =>
    e.kind === "shape" ? `shape:${e.type}:${String(e.shape).toLowerCase()}` : `${e.kind}:${e.type}:${e.fp}`;

  function dedupeVault(entries) {
    const seen = new Set();
    return entries.filter((e) => !seen.has(vaultKey(e)) && seen.add(vaultKey(e)));
  }

  // Checks that an entry is well-formed before it's allowed into storage. A raw value can never pass this check.
  function cleanVaultEntry(e) {
    if (!e || !VAULT_KINDS.has(e.kind) || typeof e.type !== "string" || !/^[a-z_]{2,40}$/.test(e.type)) return null;
    const out = { kind: e.kind, type: e.type, added: Number.isFinite(e.added) ? e.added : Date.now() };
    if (e.kind === "shape") {
      if (typeof e.shape !== "string" || !/[#@].*[#@]/.test(e.shape) || /\d/.test(e.shape) || e.shape.length > 40)
        return null;
      out.shape = e.shape;
    } else {
      if (!/^[0-9a-f]{16}$/.test(e.fp)) return null;
      out.fp = e.fp;
      if (e.kind === "word") out.words = Math.min(4, Math.max(1, Number(e.words) || 1));
      if (e.kind === "value") out.mode = VAULT_MODES.has(e.mode) ? e.mode : "protect";
    }
    if (e.learned) out.learned = true;
    return out;
  }

  // A "mentioned" event means an AI's reply brought up one of your vault details, not something you typed. The
  // background keeps those in a separate `mentions` list so they're never counted as found in your own messages.
  const ACTIONS = new Set(["redacted", "allowed", "suppressed", "mentioned"]);
  const SEVERITIES = new Set(["high", "medium", "low"]);

  // Keeps only an event's known fields, each checked for a sane value, so nothing a page adds on its own ever
  // gets stored.
  function cleanEvent(e) {
    if (!e || typeof e !== "object") return null;
    if (!ACTIONS.has(e.action) || !SEVERITIES.has(e.severity)) return null;
    const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    const out = {
      t: Number.isFinite(e.t) ? e.t : Date.now(),
      site: str(e.site, 253),
      type: str(e.type, 64),
      name: str(e.name, 64),
      severity: e.severity,
      action: e.action,
      fp: /^[0-9a-f]{16}$/.test(e.fp) ? e.fp : "",
    };
    // Marks whether a "redacted" event happened because Bandage swapped the detail for a label while you typed,
    // as opposed to you hiding it by hand with "Hide it" in the dialog or notice, so the report can tell the two
    // apart.
    if (e.via === "bandage") out.via = "bandage";
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
