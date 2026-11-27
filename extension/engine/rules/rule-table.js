// The rule table: one entry per kind Clotr finds, with the finder it uses. It loads after the other rules files
// and puts the rules' public names on globalThis.Clotr.
(() => {
  "use strict";

  const {
    isPlaceholder,
    looksRandom,
    looksRandomHex,
    looksRandomLetters,
    msg,
    numberRuns,
    findPhones,
    findCards,
    findSSNs,
    findEmails,
    addressCore,
    findAddresses,
    findBirthDates,
    findBankNumbers,
    findLicenses,
    findMedicare,
    findPassports,
    findInsuranceIds,
    findVins,
    findStudentIds,
    findPlates,
    findGamerTags,
    findIbans,
    findNationalIds,
    findMedicalRecords,
    findMyIps,
    sha256Bytes,
    SEED_LABEL,
    findCryptoSecrets,
    findPrivateKeys,
    findOtpSecrets,
    cleanableParamsOf,
    findShareLinks,
    cleanShareLink,
    findConnectionStrings,
    JWT_RE,
    findInternalIPs,
    findInternalHosts,
    findAwsAccessKeys,
    isVaultFormat,
    vaultKinds,
    setVault,
    isClosedLetter,
    closedLength,
    closedHead,
    utf8At,
    setScanDeadline,
    setVaultSource,
    vaultCutShort,
    findVault,
    RECOVERY_WORD,
    findBackupCodes,
    findCardCodes,
    findGiftCards,
    ASK_REASONS,
    askLabels,
    findSecrets,
    findServiceTokens,
    findTwilioCredentials,
  } = globalThis.ClotrInternal;

  // ---------- One rule per kind ----------
  const PATTERNS = [
    // ── Credentials ──
    // `secret: true` drops placeholder matches. `validate` adds a check specific to that pattern.
    {
      id: "private_key",
      group: "credentials",
      name: "Private Key",
      severity: "high",
      find: findPrivateKeys,
    },
    {
      id: "aws_access_key",
      group: "credentials",
      secret: true,
      name: "AWS Access Key",
      severity: "high",
      find: findAwsAccessKeys,
    },
    {
      id: "github_token",
      group: "credentials",
      secret: true,
      name: "GitHub Token",
      severity: "high",
      regex:
        /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}(?![A-Za-z0-9_])|\bghs_[0-9]{1,20}_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_.-])/g,
      validate: (token) => {
        if (!token.startsWith("ghs_")) return true;
        const appIdEnd = token.indexOf("_", 4);
        return appIdEnd < 0 || looksRandomHex(token.slice(appIdEnd + 1).replace(/\./g, ""));
      },
    },
    {
      id: "stripe_secret_key",
      group: "credentials",
      secret: true,
      name: "Stripe Secret Key",
      severity: "high",
      // A webhook's signing secret (whsec_…) lets anyone forge Stripe's events to that site.
      // One that goes on in base64 ("+", "/" or "=") is a Standard Webhooks secret, which the service-token rule reads.
      // It steps aside only when that rule's whole shape fits from the same "whsec_": a run that goes on past it, into
      // a path, a second secret or more than 88 characters, is still Stripe's.
      regex:
        /\b(?:[sr]k_live_[A-Za-z0-9]{24,}|whsec_(?!(?=[A-Za-z0-9]{32,88}[+/=])[A-Za-z0-9+/]{32,88}={0,2}(?![A-Za-z0-9+/=-])(?!_[A-Za-z0-9_+/=-]))[A-Za-z0-9]{32,})\b/g,
    },
    {
      id: "anthropic_key",
      group: "credentials",
      secret: true,
      name: "Anthropic API Key",
      severity: "high",
      regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
      validate: (token) => looksRandom(token.replace(/^sk-ant-(?:[a-z]+\d+-)?/, "")),
    },
    {
      id: "openai_key",
      group: "credentials",
      secret: true,
      name: "OpenAI API Key",
      severity: "high",
      regex: /\bsk-(?!ant-|or-v1-)(?:proj-)?[A-Za-z0-9_-]{20,}/g,
      validate: (token) => looksRandom(token.replace(/^sk-(?:proj-)?/, "")),
    },
    {
      id: "xai_key",
      group: "credentials",
      secret: true,
      name: "xAI API Key",
      severity: "high",
      // Same `xai-` prefix shadow-ai-dlp matches (MIT, Erik Sanchez, see THIRD-PARTY-NOTICES), with the same
      // randomness check Clotr already runs on Anthropic and OpenAI keys on top of the prefix match.
      regex: /\bxai-[A-Za-z0-9_-]{16,}/g,
      validate: (token) => looksRandom(token.replace(/^xai-/, ""), 16),
    },
    {
      id: "google_api_key",
      group: "credentials",
      secret: true,
      name: "Google API Key",
      severity: "high",
      regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, // it may end in "-" (no \b after it)
    },
    {
      id: "slack_token",
      group: "credentials",
      secret: true,
      name: "Slack Token",
      severity: "high",
      regex:
        /(?:\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bxoxe\.xox[abp]-[A-Za-z0-9-]{20,200}(?![A-Za-z0-9-])|\bxoxe\.xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]{20,100}(?![A-Za-z0-9-])|\bxoxe-\d-[A-Za-z0-9-]{20,200}(?![A-Za-z0-9-])|\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]{20,100}(?![A-Za-z0-9-])|\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{1,40}\/B[A-Za-z0-9_]{1,40}\/[A-Za-z0-9_]{16,100}(?![A-Za-z0-9_]))/g,
      validate: (token) => {
        const tail = token.slice(token.lastIndexOf("-") + 1);
        // A refresh token (xoxe-, xoxe.) or an app token (xapp-) ends in its random part.
        if (/^(?:xoxe[.-]|xapp-)/.test(token)) return looksRandomHex(tail);
        if (token.startsWith("https://hooks.slack.com/")) {
          return looksRandomHex(token.slice(token.lastIndexOf("/") + 1));
        }
        // A bot, user or app token carries its workspace's and user's numbers, a random part, or both. Words alone
        // ("not-a-real-token" after the prefix) or counting digits ("1234-5678-abcd") are a docs placeholder.
        if (looksRandomHex(tail) || (tail.length >= 20 && looksRandomLetters(tail))) return true;
        // Random letters swap case often; a camelCase name ("notARealToken") only at each word.
        if (/^[A-Za-z]{8,}$/.test(tail) && (tail.match(/[a-z][A-Z]/g) || []).length >= 3) return true;
        const digits = token.slice(5).replace(/\D/g, "");
        return digits.length > 0 && !isPlaceholder(digits);
      },
    },
    {
      id: "gitlab_token",
      group: "credentials",
      secret: true,
      name: "GitLab Token",
      severity: "high",
      regex:
        /(?:\bglpat-[A-Za-z0-9_-]{20,300}(?:\.[a-z0-9]{9})?|\bgldt-[A-Za-z0-9_-]{20,300}|\bglcbt-(?:[0-9a-fA-F]{2}_)?[A-Za-z0-9_-]{20,300}|\bglrt-(?:t\d_[A-Za-z0-9_-]{27,300}\.[a-z0-9]{9}|[A-Za-z0-9_-]{20,300})|\bglft-[A-Za-z0-9_-]{20,300}|\bglsoat-[A-Za-z0-9_-]{20,300}|\bglagent-[A-Za-z0-9_-]{50,1024}|\bgloas-[A-Za-z0-9_-]{64}|\bglptt-[0-9a-f]{40}|\bglffct-[A-Za-z0-9_-]{20}|\bglimt-[A-Za-z0-9_-]{25}|\bGR1348941[A-Za-z0-9_-]{20})(?![A-Za-z0-9_-])/g,
      validate: (token) => {
        const body = token.replace(/^(?:gl(?:pat|dt|cbt|rt|ft|soat|agent|oas|ptt|ffct|imt)-?|GR1348941)/, "");
        const randomBody = body
          .replace(/\.[a-z0-9]{9}$/, "")
          .replace(/^t\d_/, "")
          .replace(/^[0-9a-fA-F]{2}_/, "");
        const normalizedBody = randomBody.replace(/[-_]/g, "");
        return looksRandomHex(normalizedBody) || looksRandomLetters(normalizedBody);
      },
    },
    {
      id: "perplexity_key",
      group: "credentials",
      secret: true,
      name: "Perplexity API Key",
      severity: "high",
      regex: /\bpplx-[A-Za-z0-9]{16,128}(?![A-Za-z0-9])/g,
      validate: (token) => looksRandomHex(token.slice(5)),
    },
    {
      id: "digitalocean_token",
      group: "credentials",
      secret: true,
      name: "DigitalOcean Token",
      severity: "high",
      regex: /\bd(?:op|oo|or)_v1_[0-9a-fA-F]{64}\b/g,
      validate: (token) => looksRandomHex(token.slice(7)),
    },
    {
      id: "huggingface_token",
      group: "credentials",
      secret: true,
      name: "Hugging Face Token",
      severity: "high",
      regex: /\b(?:hf_|api_org_)[A-Za-z]{34}\b/g,
      validate: (token) => looksRandomLetters(token.slice(token.startsWith("hf_") ? 3 : 8)),
    },
    {
      id: "heroku_token",
      group: "credentials",
      secret: true,
      name: "Heroku Token",
      severity: "high",
      regex: /\bHRKU-[A-Za-z0-9_-]{60}\b/g,
      validate: (token) => looksRandomHex(token.slice(5)),
    },
    {
      id: "onepassword_token",
      group: "credentials",
      secret: true,
      name: "1Password Token",
      severity: "high",
      regex:
        /(?:\bops_eyJ[A-Za-z0-9+/=_-]{250,4096}(?![A-Za-z0-9+/=_-])|\bA3-[A-Z0-9]{6}-(?:[A-Z0-9]{11}|[A-Z0-9]{6}-[A-Z0-9]{5})-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b)/g,
      validate: (token) => looksRandomHex(token.startsWith("ops_") ? token.slice(4) : token.replace(/-/g, "").slice(2)),
    },
    {
      id: "cloudflare_origin_ca_key",
      group: "credentials",
      secret: true,
      name: "Cloudflare Origin CA Key",
      severity: "high",
      regex: /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/g,
      validate: (token) => looksRandomHex(token.slice(5).replace(/-/g, "")),
    },
    {
      id: "twilio_credentials",
      group: "credentials",
      secret: true,
      name: "Twilio Credentials",
      severity: "high",
      find: findTwilioCredentials,
    },
    // Developer tools' tokens, each in the shape its provider documents. A key or token label in front still
    // names the provider, since the labelled-key check leaves out any value one of these regexes recognizes.
    {
      id: "sentry_token",
      group: "credentials",
      secret: true,
      name: "Sentry Auth Token",
      severity: "high",
      // User, app and integration tokens are 64 hex. An organization token is base64 JSON about the org, then
      // "_" and a 43-character base64 secret.
      regex: /\bsntry(?:[uai]_[0-9a-f]{64}\b|s_eyJ[A-Za-z0-9+/]{20,1000}={0,2}_[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=_-]))/g,
      validate: (token) =>
        token.startsWith("sntrys_") ? looksRandom(token.slice(-43)) : looksRandomHex(token.slice(7)),
    },
    {
      id: "grafana_token",
      group: "credentials",
      secret: true,
      name: "Grafana Token",
      severity: "high",
      // A service account token ends in "_" and an 8-hex checksum. A Grafana Cloud token is one base64 run, and so is
      // an older API key, whose "eyJrIjoi" is base64 of the start of its JSON.
      regex:
        /\b(?:gl(?:sa_[A-Za-z0-9]{32}_[0-9a-f]{8}\b|c_[A-Za-z0-9+/]{32,400}={0,3}(?![A-Za-z0-9+/=]))|eyJrIjoi[A-Za-z0-9]{70,400}={0,3}(?![A-Za-z0-9+/=]))/g,
      validate: (token) => {
        if (token.startsWith("glsa_")) return looksRandom(token.slice(5, 37));
        return looksRandom(token.slice(token.startsWith("glc_") ? 4 : 8).replace(/=+$/, ""));
      },
    },
    {
      id: "vault_token",
      group: "credentials",
      secret: true,
      name: "HashiCorp Vault Token",
      severity: "high",
      // Service, batch and recovery tokens. Vault only promises 24 characters or more after the prefix.
      regex: /\bhv[sbr]\.[A-Za-z0-9_-]{24,1000}(?![A-Za-z0-9_-])/g,
      validate: (token) => looksRandom(token.slice(4), 24),
    },
    {
      id: "replicate_token",
      group: "credentials",
      secret: true,
      name: "Replicate API Token",
      severity: "high",
      regex: /\br8_[A-Za-z0-9]{37}\b/g,
      validate: (token) => looksRandomHex(token.slice(3)),
    },
    {
      id: "linear_key",
      group: "credentials",
      secret: true,
      name: "Linear API Key",
      severity: "high",
      // An API key, or an OAuth access token an app holds for someone.
      regex: /\blin_(?:api_[A-Za-z0-9]{40}|oauth_[a-f0-9]{64})\b/g,
      validate: (token) => looksRandomHex(token.replace(/^lin_(?:api|oauth)_/, "")),
    },
    {
      id: "postman_key",
      group: "credentials",
      secret: true,
      name: "Postman API Key",
      severity: "high",
      regex: /\bPMAK-[0-9a-fA-F]{24}-[0-9a-fA-F]{34}\b/g,
      validate: (token) => looksRandomHex(token.slice(5).replace("-", "")),
    },
    {
      id: "shopify_token",
      group: "credentials",
      secret: true,
      name: "Shopify Access Token",
      severity: "high",
      // Admin API, custom app and delegate access tokens, and an app's shared secret.
      regex: /\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b/g,
      validate: (token) => looksRandomHex(token.slice(6)),
    },
    {
      id: "atlassian_token",
      group: "credentials",
      secret: true,
      name: "Atlassian API Token",
      severity: "high",
      // An account's API token or an organization's admin key. Atlassian treats the body as opaque and may change
      // its length, so the length here is a range around today's tokens, which end in "=" and an 8-character
      // checksum.
      regex: /\bAT[AC]TT3[A-Za-z0-9_=-]{150,250}=[A-Za-z0-9]{8}(?![A-Za-z0-9_=-])/g,
      validate: (token) => looksRandom(token.slice(6, -9)),
    },
    {
      id: "netlify_token",
      group: "credentials",
      secret: true,
      name: "Netlify Access Token",
      severity: "high",
      // Personal, CLI, OAuth, app and build tokens.
      regex: /\bnf[pcoub]_[A-Za-z0-9_]{36}(?![A-Za-z0-9_])/g,
      validate: (token) => looksRandomHex(token.slice(4)),
    },
    {
      id: "pulumi_token",
      group: "credentials",
      secret: true,
      name: "Pulumi Access Token",
      severity: "high",
      regex: /\bpul-[a-z0-9]{40}\b/g,
      validate: (token) => looksRandomHex(token.slice(4)),
    },
    {
      id: "databricks_token",
      group: "credentials",
      secret: true,
      name: "Databricks Access Token",
      severity: "high",
      // Some end in "-" and a digit.
      regex: /\bdapi[0-9a-fA-F]{32}(?:-\d)?\b/g,
      validate: (token) => looksRandomHex(token.slice(4, 36)),
    },
    // Covers the keys from several other services under one Settings row: Hugging Face, npm, PyPI,
    // GitLab, SendGrid, Twilio, Mailgun, DigitalOcean, Telegram and Discord bots, Azure storage
    // and service-bus keys, Tailscale, Fly.io, NuGet and crates.io, and Slack or Discord
    // webhook URLs, since anyone with one of those URLs can post as the bot that owns it.
    // The service-token row (below) also holds the provider tokens in PREFIXED_TOKENS: Google OAuth,
    // Microsoft Entra and Azure DevOps, Azure storage signatures, Okta, and developer platforms
    // like Docker Hub, Supabase, Notion, Terraform Cloud, Doppler and Square.
    {
      id: "crypto_secret",
      group: "credentials",
      name: "Crypto Wallet Seed or Key",
      severity: "high",
      find: findCryptoSecrets,
      labelAnywhere: SEED_LABEL,
    },
    {
      id: "service_token",
      group: "credentials",
      secret: true,
      name: "Service Access Token",
      severity: "high",
      find: findServiceTokens,
    },

    {
      id: "connection_string",
      group: "credentials",
      name: "Database/Service Connection String",
      severity: "high",
      find: findConnectionStrings,
    },
    { id: "jwt", group: "credentials", secret: true, name: "Login Token (JWT)", severity: "high", regex: JWT_RE },
    { id: "internal_ip", group: "credentials", name: "Internal IP Address", severity: "medium", find: findInternalIPs },
    {
      id: "internal_host",
      group: "credentials",
      name: "Internal Hostname",
      severity: "medium",
      find: findInternalHosts,
    },
    {
      id: "otp_secret",
      group: "credentials",
      name: "Two-Step Sign-in Key",
      severity: "high",
      find: findOtpSecrets,
    },
    {
      id: "backup_codes",
      group: "credentials",
      name: "Backup Codes",
      severity: "high",
      find: findBackupCodes,
      labelAnywhere: RECOVERY_WORD,
    },
    { id: "password", group: "credentials", name: "Password or Secret", severity: "high", find: findSecrets },

    // ── Personal data ──
    // Phone, SSN and email use find() instead of a single regex, so they also catch
    // spelled-out and mixed forms ("five five five…", "5fivefiv5…", "bob at gmail dot com").
    { id: "us_ssn", group: "personal", name: "US Social Security Number", severity: "high", find: findSSNs },
    { id: "credit_card", group: "personal", name: "Credit Card Number", severity: "high", find: findCards },
    // These are the codes a scammer asks you to read out, so `bandage: false` keeps their own warning,
    // which already says what they are, instead of letting Bandage cover them with a generic label.
    {
      id: "card_code",
      group: "personal",
      name: "Card Security Code",
      severity: "high",
      bandage: false,
      find: findCardCodes,
    },
    {
      id: "gift_card",
      group: "personal",
      name: "Gift Card Code",
      severity: "high",
      bandage: false,
      find: findGiftCards,
    },
    {
      id: "stripe_publishable_key",
      group: "credentials",
      secret: true,
      name: "Stripe Publishable Key",
      severity: "medium",
      regex: /\bpk_live_[A-Za-z0-9]{24,}\b/g,
    },
    { id: "street_address", group: "personal", name: "Street Address", severity: "medium", find: findAddresses },
    {
      id: "bank_account",
      group: "personal",
      name: "Bank Account or Routing Number",
      severity: "high",
      find: (text) => [...findBankNumbers(text), ...findIbans(text)],
    },
    { id: "national_id", group: "personal", name: "National ID Number", severity: "high", find: findNationalIds },
    {
      id: "medical_record",
      group: "personal",
      name: "Medical Record Number",
      severity: "high",
      find: findMedicalRecords,
    },
    { id: "public_ip", group: "personal", name: "Your IP Address", severity: "medium", find: findMyIps },
    { id: "medicare_id", group: "personal", name: "Medicare Number", severity: "high", find: findMedicare },
    { id: "passport", group: "personal", name: "Passport Number", severity: "high", find: findPassports },
    {
      id: "drivers_license",
      group: "personal",
      name: "Driver's License Number",
      severity: "medium",
      find: findLicenses,
    },
    // These two are only found in an attached picture, never in text, so `find` gives nothing back and
    // detect() never reports them on its own. One is the place a photo was taken, when the camera saved
    // that inside the file. The other is a picture, or a text-free scan, whose file name says it's an ID
    // or a document, like "passport-scan.jpg".
    {
      id: "photo_location",
      group: "personal",
      name: "Photo Location",
      severity: "medium",
      picture: true,
      find: () => [],
    },
    {
      id: "id_picture",
      group: "personal",
      name: "ID or Document Picture",
      severity: "medium",
      picture: true,
      find: () => [],
    },
    { id: "insurance_id", group: "personal", name: "Insurance Member ID", severity: "medium", find: findInsuranceIds },
    { id: "vin", group: "personal", name: "Vehicle Identification Number", severity: "medium", find: findVins },
    { id: "student_id", group: "personal", name: "Student ID Number", severity: "medium", find: findStudentIds },
    // Starts as Just count, so it's counted but never shown unless the person switches it to Warn.
    { id: "license_plate", group: "personal", name: "License Plate", severity: "low", start: "log", find: findPlates },
    // Starts as Just count too.
    { id: "gamer_tag", group: "personal", name: "Gamer Tag", severity: "low", start: "log", find: findGamerTags },
    { id: "date_of_birth", group: "personal", name: "Date of Birth", severity: "medium", find: findBirthDates },
    { id: "phone_number", group: "personal", name: "Phone Number", severity: "medium", find: findPhones },
    { id: "my_name", group: "personal", name: "Your Name", severity: "high", find: findVault("my_name") },
    {
      id: "family_name",
      group: "personal",
      name: "Family Member's Name",
      severity: "high",
      find: findVault("family_name"),
    },
    { id: "employer", group: "personal", name: "Your Employer", severity: "medium", find: findVault("employer") },
    { id: "my_id", group: "personal", name: "Your Account/ID Number", severity: "high", find: findVault("my_id") },
    { id: "watch_list", group: "custom", name: "Watch List Item", severity: "medium", find: findVault("watch_list") },
    { id: "email", group: "personal", name: "Email Address", severity: "low", find: findEmails },

    // ── Links ──
    // Its own Settings group, so the switch for personal details doesn't hold it, and `bandage: false` keeps
    // Bandage from covering it while typing: a link isn't finished until the whole thing is there to clean.
    {
      id: "share_link",
      group: "links",
      name: "Share Code in a Link",
      severity: "low",
      bandage: false,
      find: findShareLinks,
      replace: cleanShareLink,
    },
  ];

  // ---------- Names and what the table shares ----------
  // Names in the browser's language (English is the name written above).
  for (const pattern of PATTERNS) pattern.name = msg(`type_${pattern.id}`, pattern.name);

  globalThis.Clotr = {
    ...(globalThis.Clotr || {}),
    PATTERNS,
    ASK_REASONS,
    askLabels,
    numberRuns,
    isPlaceholder,
    setVault,
    vaultKinds,
    isVaultFormat,
    isClosedLetter,
    closedLength,
    closedHead,
    vaultCutShort,
    setScanDeadline,
    setVaultSource,
    utf8At,
    addressCore,
    msg,
    cleanableParamsOf,
    cleanShareLink,
    findShareLinks,
    sha256Bytes,
  };

  globalThis.ClotrInternal = { ...globalThis.ClotrInternal, PATTERNS };
})();
