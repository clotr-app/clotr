(() => {
  "use strict";

  // ---------- Tourniquet: the stronger setup for someone you help ----------

  // Two presets you choose on this computer, one for a child and one for a grown-up (the code calls the
  // second one "adult"). Like a team preset, each one lists every kind of detail with its own floor. Block
  // asks before sending, and warn means a chat can't be set down to Just count. The ids are written out by
  // hand here too, and a test checks them against Clotr.PATTERNS, so a new kind in the engine has to be a
  // deliberate choice for both presets, not an oversight.
  // It's all stored as one small record, `tourniquet: { for, since }`, with an `until` added for the 30 days
  // after a scam. Turning it off just removes that record, and whatever settings were underneath go back to
  // being in force.
  const SIGN_IN_CODES = [
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
    "otp_secret",
    "backup_codes",
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
  // Public by design (an office network's address, a page's publishable payment key). A note, never a
  // question.
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
  // A link's own tracking code, cleaned on its way out: a note for both, never a question.
  const LINKS = ["share_link"];

  const TOURNIQUET = {
    // Who they are and where they live, kept from strangers online: every personal detail asks first.
    child: {
      requiredResponses: Object.fromEntries([
        ...withResponse([...SIGN_IN_CODES, ...MONEY_AND_IDS, ...WHO_AND_WHERE, "student_id"], "block"),
        ...withResponse([...TECHNICAL, ...CAR, ...LINKS], "warn"),
        ...withResponse([...PICTURE_PLACE, ...PICTURE_ID], "block"),
        ...withResponse(GAMES, "warn"),
      ]),
      apps: ["Discord", "WhatsApp", "Messenger"],
    },
    // Money, ID numbers and sign-in codes, kept from scammers: those ask first. Everyday details get a bigger
    // note.
    adult: {
      requiredResponses: Object.fromEntries([
        ...withResponse([...SIGN_IN_CODES, ...MONEY_AND_IDS], "block"),
        ...withResponse([...WHO_AND_WHERE, ...TECHNICAL, ...CAR, ...LINKS, "student_id"], "warn"),
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
  // An hour of slack keeps small clock corrections from counting as a clock turned back.
  const CLOCK_SLACK = 3600000;

  function withResponse(ids, value) {
    return ids.map((id) => [id, value]);
  }

  // ---------- Tourniquet: the stored record ----------

  function isTime(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  // Checks that the stored record is exactly the shape expected, or returns null. That's either
  // { for: "child" or "adult", since }, or { for: "after_scam", since, until }, where until comes after since
  // and no more than 61 days later. Anything else is rejected, so a corrupted value can't quietly change what
  // Tourniquet does.
  function tourniquetRecord(stored) {
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || !isTime(stored.since)) return null;
    const keys = Object.keys(stored).sort().join();
    if (stored.for === "child" || stored.for === "adult") {
      if (keys !== "for,since") return null;
      return { for: stored.for, since: stored.since };
    }
    if (stored.for !== "after_scam" || keys !== "for,since,until" || !isTime(stored.until)) return null;
    if (stored.until <= stored.since || stored.until - stored.since > LONGEST) return null;
    return { for: stored.for, since: stored.since, until: stored.until };
  }

  // The record while Tourniquet is actually on, or null once it isn't. The 30 days are measured against the
  // stored dates on this computer's own clock, and nothing ever rewrites those dates, so it turns off
  // everywhere the moment they end, even before anything else has had a chance to run. If the clock somehow
  // reads before the start, it just stays on, since that only ever adds protection, never removes it.
  function cleanTourniquet(stored, now = Date.now()) {
    const record = tourniquetRecord(stored);
    if (record?.until !== undefined && !(now < record.until)) return null;
    return record;
  }

  // A new 30 days from `now`.
  function afterScam(now = Date.now()) {
    return { for: "after_scam", since: now, until: now + TOURNIQUET_DAYS * DAY };
  }

  // Which day of the 30 this is, counted from the stored start on this computer's clock: day 1 on the day it
  // was turned on, never less than 1 or more than the last day. Returns null for a record with no end.
  function tourniquetDay(stored, now = Date.now()) {
    const record = tourniquetRecord(stored);
    if (!record?.until) return null;
    const days = Math.ceil((record.until - record.since) / DAY);
    const daysIn = Math.floor((now - record.since) / DAY) + 1;
    return { day: Math.min(days, Math.max(1, daysIn)), of: days };
  }

  // The end of the 30 days, kept until the person answers the popup's note: `{ since, at }`, or null.
  function tourniquetEnded(ended) {
    if (!ended || typeof ended !== "object" || Array.isArray(ended)) return null;
    if (Object.keys(ended).sort().join() !== "at,since") return null;
    if (!isTime(ended.since) || !isTime(ended.at)) return null;
    if (ended.at <= ended.since || ended.at - ended.since > LONGEST) return null;
    return { since: ended.since, at: ended.at };
  }

  // Whether the computer's clock is now well before the latest time Clotr has already seen while the 30 days
  // were running, meaning someone turned it back.
  function tourniquetClockBack(seen, now = Date.now()) {
    return isTime(seen) && now < seen - CLOCK_SLACK;
  }

  // ---------- Tourniquet: the 30 days, step by step ----------

  // Works out what the background should do about the 30 days right now: what to write, what to remove, and
  // what to set the end alarm to, or null to clear it. It's a pure function, so the three cases below can be
  // tested without moving the real clock, and none of them ever rewrites the stored dates or quietly adds or
  // removes days.
  //
  // If it's on and not yet ended, the alarm goes on the stored end date, and `tourniquetSeen` tracks the
  // latest time the clock has shown, never lower, so turning the clock back doesn't fool it. The popup
  // notices and says the clock went back.
  // If the end has been reached on this computer's clock, whether through the alarm or found later, it turns
  // off and the end gets recorded once in `tourniquetEnded`. Moving the clock forward past the end has the
  // same effect as time actually passing, and the note says so either way.
  // If it already ended, nothing new has been chosen since, and the clock is now well before that end, the
  // stored dates say the 30 days genuinely aren't over yet, so it comes back on using them.
  function tourniquetStep(state, now) {
    const out = { set: {}, remove: [], alarm: null };
    const record = tourniquetRecord(state.tourniquet);
    if (record?.until !== undefined) {
      if (now >= record.until) return endTheDays(state, record, out);
      return keepTheDays(state, record, now, out);
    }
    if (state.tourniquetSeen !== undefined) out.remove.push("tourniquetSeen");
    if (record) {
      // Another preset chosen since the end: the note is no longer news.
      if (state.tourniquetEnded !== undefined) out.remove.push("tourniquetEnded");
      return out;
    }
    const ended = tourniquetEnded(state.tourniquetEnded);
    if (state.tourniquet === undefined && ended && now < ended.at - CLOCK_SLACK) return restartTheDays(ended, out);
    return out;
  }

  // The end has been reached: off, with the end noted once.
  function endTheDays(state, record, out) {
    out.set.tourniquetEnded = { since: record.since, at: record.until };
    out.remove.push("tourniquet");
    if (state.tourniquetSeen !== undefined) out.remove.push("tourniquetSeen");
    return out;
  }

  // Still running: the alarm on the stored end, and the latest time the clock has shown.
  function keepTheDays(state, record, now, out) {
    const seen = isTime(state.tourniquetSeen) ? state.tourniquetSeen : null;
    out.alarm = record.until;
    if (seen === null || now > seen) out.set.tourniquetSeen = now;
    if (state.tourniquetEnded !== undefined) out.remove.push("tourniquetEnded");
    return out;
  }

  // The clock went back before a recorded end: back on, from the stored dates.
  function restartTheDays(ended, out) {
    out.set.tourniquet = { for: "after_scam", since: ended.since, until: ended.at };
    out.set.tourniquetSeen = ended.at; // the clock showed at least the end once: the popup says it went back
    out.remove = ["tourniquetEnded"];
    out.alarm = ended.at;
    return out;
  }

  Object.assign(globalThis.ClotrSites, {
    TOURNIQUET,
    TOURNIQUET_DAYS,
    tourniquetRecord,
    cleanTourniquet,
    afterScam,
    tourniquetDay,
    tourniquetEnded,
    tourniquetClockBack,
    tourniquetStep,
  });
})();
