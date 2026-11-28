// Plain-words advice and the mind map's model, shared by the popup and the full report (dashboard).
// Extension pages only; not a content script.
"use strict";

(() => {
  // ---------- Kinds of detail ----------

  // Keys, tokens and passwords: their advice is to turn it off and make a new one.
  const KEYS = new Set([
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
    "service_token",
    "jwt",
    "connection_string",
    "private_key",
    "password",
  ]);
  // ID numbers and ID pictures: their advice is about identity theft.
  const IDS = new Set([
    "us_ssn",
    "national_id",
    "passport",
    "drivers_license",
    "medicare_id",
    "insurance_id",
    "medical_record",
    "id_picture", // a picture named like an ID or a document (on-websites/attached-pictures.js): an ID all the same
  ]);

  // ---------- Words ----------

  // English is written here and is the fallback; translations.js provides msg() on every page that loads
  // this. `args` is (key, english, ...fillers), so "$1" is args[2].
  function msg(...args) {
    if (globalThis.Clotr?.msg) return globalThis.Clotr.msg(...args);
    return args[1].replace(/\$(\d)/g, (_, digit) => String(args[Number(digit) + 1] ?? ""));
  }

  // A kind's name in the browser's language, else the name or id the record carries.
  function typeName(record) {
    const pattern = globalThis.Clotr?.PATTERNS?.find((each) => each.id === record.type);
    return pattern?.name || record.name || record.type;
  }

  // ---------- Advice ----------

  // What to do now about something that was sent to an AI service.
  function adviceFor(type) {
    if (type === "crypto_secret") {
      return msg(
        "ad_crypto",
        "Move your funds to a new wallet. A seed phrase or key can't be changed, only left behind.",
      );
    }
    if (type === "otp_secret") {
      return msg(
        "ad_otp",
        "Turn two-step sign-in off and on again for that account. That makes a new key, and the old one stops working.",
      );
    }
    if (type === "backup_codes") {
      return msg(
        "ad_backup_codes",
        "Make a fresh set of backup codes for that account now. The old list stops working once you do.",
      );
    }
    if (KEYS.has(type)) {
      return msg(
        "ad_key",
        "Turn it off and make a new one (or change the password) now. Once it's been sent, treat it as public.",
      );
    }
    if (type === "card_code") {
      return msg("ad_card_code", "Call the number on your card and ask for a new one if someone else could have it.");
    }
    if (type === "gift_card") {
      return msg(
        "ad_gift_card",
        "Call the gift card company on the number on the back of the card. Say a scammer got the number and PIN, and ask for your money back.",
      );
    }
    if (type === "credit_card") {
      return msg("ad_card", "Watch your statements, and ask your bank for a new card if you're unsure.");
    }
    if (type === "bank_account") {
      return msg("ad_bank", "Tell your bank if you didn't mean to share it, and watch for unexpected activity.");
    }
    if (IDS.has(type)) {
      return msg(
        "ad_id",
        "Keep an eye out for identity theft. In the US, a free credit freeze stops anyone opening new accounts in your name.",
      );
    }
    return msg("ad_other", "Delete that chat in the AI service if you can, and turn off training on your chats.");
  }

  // ---------- Mind map of everything you could be leaking ----------
  // Pure data in, data out (unit-tested): history, reply mentions, your vault and spotted AI sites
  // become one tree. page-parts/mind-map.js lays it out and draws it; the table view reads the same tree.

  const RANK = { high: 3, medium: 2, low: 1 };
  const RISK_WORD = {
    high: msg("rk_high", "High"),
    medium: msg("rk_medium", "Medium"),
    low: msg("rk_low", "Low"),
    none: msg("rk_none", "Nothing sent"),
  };

  // Places no browser extension can see, always listed under blind spots.
  const CANT_SEE = [
    ["desktop_apps", () => msg("mp_desktopApps", "AI apps on your computer")],
    ["phone_apps", () => msg("mp_phoneApps", "AI apps on your phone")],
    ["browser_panels", () => msg("mp_browserPanels", "AI side panels built into browsers")],
  ];

  function riskier(a, b) {
    return (RANK[b] || 0) > (RANK[a] || 0) ? b : a;
  }

  // "Email ×3, Card": each kind, with its count when there's more than one.
  function kindsText(kinds) {
    return [...kinds].map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind)).join(", ");
  }

  // Biggest count first, then by label.
  function byCountThenLabel(a, b) {
    return b.count - a.count || a.label.localeCompare(b.label);
  }

  // ---------- Counting ----------

  // The map's row for `key`, made on first use.
  function rowFor(map, key, label) {
    if (!map.has(key)) map.set(key, { key, label, count: 0, severity: "none", parts: new Map() });
    return map.get(key);
  }

  // Counts per AI service and per kind of detail, each with the riskiest severity seen.
  function tally(list) {
    const bySite = new Map();
    const byType = new Map();
    // A record that stands for the rest of a long list counts as its n.
    const weight = globalThis.ClotrSites?.weight || (() => 1);
    for (const record of list) {
      const name = typeName(record);
      const counted = weight(record);
      const site = rowFor(bySite, record.site, record.site);
      site.count += counted;
      site.severity = riskier(site.severity, record.severity);
      site.parts.set(name, (site.parts.get(name) || 0) + counted);
      const kind = rowFor(byType, record.type, name);
      kind.count += counted;
      kind.severity = riskier(kind.severity, record.severity);
      kind.parts.set(record.site, (kind.parts.get(record.site) || 0) + counted);
    }
    return { bySite: [...bySite.values()].sort(byCountThenLabel), byType: [...byType.values()].sort(byCountThenLabel) };
  }

  // events: history (found in your own messages); mentions: replies that brought up your details;
  // vault: your saved details (fingerprints/formats); blind: spotted AI site names Clotr
  // doesn't protect. Never sees a value: only kinds, sites, outcomes and fingerprints.
  function exposureModel({ events = [], mentions = [], vault = [], blind = [] } = {}) {
    const sentList = events.filter((event) => event.action === "allowed" || event.action === "suppressed");
    const reachedList = [...sentList, ...mentions];
    const reached = new Set(reachedList.map((record) => record.fp).filter(Boolean));
    const reachedTypes = new Set(reachedList.map((record) => record.type));
    const open = new Map();
    for (const saved of vault) {
      if (!saved || saved.mode === "allow" || !saved.type) continue;
      const wentOut = saved.fp ? reached.has(saved.fp) : reachedTypes.has(saved.type);
      if (wentOut) continue;
      if (!open.has(saved.type)) {
        open.set(saved.type, { key: saved.type, label: typeName({ type: saved.type }), count: 0 });
      }
      open.get(saved.type).count++;
    }
    return {
      has: tally(reachedList),
      mentioned: tally(mentions),
      near: tally(events.filter((event) => event.action === "redacted")),
      open: [...open.values()].sort(byCountThenLabel),
      blind: [...new Set(blind)].sort(),
    };
  }

  // Spotted AI sites (names only) that Clotr protects nowhere: `covered` = the match patterns Clotr runs
  // on. A site protected for one section only (huggingface.co/chat) counts as protected: it isn't a blind
  // spot.
  function unprotectedHosts(spotted, covered) {
    const coveredHosts = covered.map((pattern) => (pattern.match(/^https?:\/\/([^/]+)\//) || [])[1]);
    const hosts = new Set(coveredHosts.filter(Boolean));
    return Object.keys(spotted || {})
      .filter((host) => !hosts.has(host))
      .sort();
  }

  // ---------- The tree's words ----------

  const BRANCH_LABEL = {
    has: () => msg("mp_has", "Already has"),
    near: () => msg("mp_near", "Near misses"),
    open: () => msg("mp_open", "Not shared yet"),
    blind: () => msg("mp_blind", "Blind spots"),
  };

  const BRANCH_DETAIL = {
    has: () =>
      msg(
        "mp_hasDetail",
        "What services already have from you: sent after a warning, just counted, or brought up in their replies.",
      ),
    near: () => msg("mp_nearDetail", "What Clotr hid or held before it went out."),
    open: () => msg("mp_openDetailBranch", "Details in your vault that haven't gone anywhere yet."),
    blind: () =>
      msg(
        "mp_blindDetailBranch",
        "Where Clotr can't protect you: AI tools it spotted but doesn't cover, and places no extension can see.",
      ),
  };

  // One group's line: what a service has or a kind reached, or what Clotr stopped, and the replies too.
  function detailFor(branch, byService, group, said) {
    const list = kindsText(group.parts);
    let text;
    if (branch === "near") {
      text = byService
        ? msg("mp_nearService", "Clotr stopped on $1: $2", group.label, list)
        : msg("mp_nearKind", "$1, stopped by Clotr on: $2", group.label, list);
    } else {
      const risk = RISK_WORD[group.severity] || RISK_WORD.none;
      text = byService
        ? msg("mp_hasService", "$1 has: $2 (riskiest: $3)", group.label, list, risk)
        : msg("mp_hasKind", "$1 reached: $2", group.label, list);
    }
    if (said) {
      const mentioned = msg(
        "mp_mentionedToo",
        "Its replies brought up your details without you typing them ($1×).",
        said.count,
      );
      text += ` ${mentioned}`;
    }
    return text;
  }

  // ---------- The tree ----------

  // Up to `max` children; the rest become one "+N more" node.
  function capped(children, max, idBase) {
    if (children.length <= max) return children;
    const rest = children.slice(max - 1);
    return [
      ...children.slice(0, max - 1),
      {
        id: `${idBase}/more`,
        type: "more",
        branch: children[0].branch,
        label: msg("mp_more", "+$1 more", rest.length),
        count: rest.reduce((sum, child) => sum + (child.count || 0), 0),
        children: [],
      },
    ];
  }

  // A group's outer ring: one leaf per service or kind it counted.
  function leafNodes(group, branch, id, max) {
    const leaves = [...group.parts].map(([label, count]) => ({
      id: `${id}/${label}`,
      type: "leaf",
      branch,
      label,
      count,
      children: [],
    }));
    return capped(leaves, max, id);
  }

  // A branch's services or kinds, each with its line and, unless leaves are off, its leaves.
  function groupNodes(branch, counted, { byService, mentionedBy, leaves, max }) {
    const groups = byService ? counted.bySite : counted.byType;
    return groups.map((group) => {
      const said = branch === "has" ? mentionedBy.get(group.key) : null;
      const id = `${branch}/${group.key}`;
      return {
        id,
        type: byService ? "service" : "kind",
        branch,
        key: group.key,
        label: group.label,
        count: group.count,
        severity: group.severity,
        mentioned: said ? said.count : 0,
        detail: detailFor(branch, byService, group, said),
        children: !leaves ? [] : leafNodes(group, branch, id, max),
      };
    });
  }

  function openNodes(model) {
    return model.open.map((kind) => ({
      id: `open/${kind.key}`,
      type: "kind",
      branch: "open",
      key: kind.key,
      label: kind.label,
      count: kind.count,
      severity: "none",
      detail: msg("mp_openDetail", "$1: not shared anywhere yet ($2 of yours)", kind.label, kind.count),
      children: [],
    }));
  }

  function blindNodes(model) {
    return model.blind.map((host) => ({
      id: `blind/${host}`,
      type: "service",
      branch: "blind",
      key: host,
      label: host,
      count: 0,
      severity: "none",
      detail: msg(
        "mp_blindDetail",
        "$1 looks like an AI chat, but Clotr doesn't protect it. Open Clotr's toolbar button there to protect it.",
        host,
      ),
      children: [],
    }));
  }

  // The places no extension can see, as one node with a leaf each.
  function cantSeeNode() {
    return {
      id: "blind/cant-see",
      type: "cant-see",
      branch: "blind",
      key: "cant-see",
      label: msg("mp_cantSee", "Clotr can't see"),
      count: 0,
      severity: "none",
      detail: msg(
        "mp_cantSeeDetail",
        "Clotr only works on AI websites in this browser, so be just as careful with these: $1.",
        CANT_SEE.map(([, label]) => label()).join(", "),
      ),
      children: CANT_SEE.map(([key, label]) => ({
        id: `blind/cant-see/${key}`,
        type: "leaf",
        branch: "blind",
        label: label(),
        count: 0,
        children: [],
      })),
    };
  }

  // view: "service" (you → branch → AI service → kinds) or "kind" (you → branch → kind → AI services).
  // compact: the popup's version: no leaves, only the branches with something in them.
  // leaves: false drops the outer ring only (a narrow window); their details stay in the table.
  function buildMindMapTree(model, { view = "service", max = 8, compact = false, leaves = !compact } = {}) {
    const byService = view !== "kind";
    const mentioned = byService ? model.mentioned.bySite : model.mentioned.byType;
    const mentionedBy = new Map(mentioned.map((group) => [group.key, group]));
    const options = { byService, mentionedBy, leaves, max };
    const has = groupNodes("has", model.has, options);
    const near = groupNodes("near", model.near, options);
    const open = openNodes(model);
    const blind = blindNodes(model);
    const allBlind = compact ? blind : [...blind, cantSeeNode()];
    const branches = [
      ["has", has],
      ["near", near],
      ["open", open],
      ["blind", allBlind],
    ]
      .filter(([, children]) => !compact || children.length)
      .map(([key, children]) => ({
        id: key,
        type: "branch",
        branch: key,
        key,
        label: BRANCH_LABEL[key](),
        detail: BRANCH_DETAIL[key](),
        count: children.filter((child) => child.type !== "cant-see").length,
        children: capped(children, max, key),
      }));
    return { id: "you", type: "you", label: msg("mp_you", "You"), count: 0, children: branches };
  }

  globalThis.ClotrInsights = {
    adviceFor,
    exposureModel,
    buildMindMapTree,
    unprotectedHosts,
    kindsText,
    RISK_WORD,
    CANT_SEE,
  };
})();
