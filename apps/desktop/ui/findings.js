// Clotr for Windows — how a scan's finds are grouped, ordered and put into words, shared by Results, the Scan
// screen's Found so far and Save a summary so all three read the same. Pure: no DOM, no Tauri call, only a file's
// own `{ index, name, folder, kind, found, fps, dupOf }` (scan.js's shapes, never a value).
"use strict";

(() => {
  const C = globalThis.Clotr || {};

  // What's at stake, most harmful first: a key or password in a file you'd share, then an ID, then a photo that
  // gives away a place, then money, then contact details. Only the first four ever need a look; contact details
  // alone are shown so you know where they are, never counted or announced. A code project's files go under their
  // own heading, since test files and examples are full of made-up keys: shown and counted apart, never in the
  // headline.
  const GROUPS = ["keys", "ids", "photos", "money", "projects", "contact"];
  const NEEDS_A_LOOK = new Set(["keys", "ids", "photos", "money"]);

  // Each kind as a plain noun, in the order a phrase names them. The noun decides the group, so a new pattern
  // lands in the right place by its id (or, for a new credential, by the engine's own group).
  const NOUNS = [
    ["key", "keys"],
    ["password", "keys"],
    ["code", "keys"],
    ["seed", "keys"],
    ["network", "keys"],
    ["id", "ids"],
    ["idPicture", "ids"],
    ["place", "photos"],
    ["card", "money"],
    ["cardCode", "money"],
    ["bank", "money"],
    ["birth", "contact"],
    ["address", "contact"],
    ["phone", "contact"],
    ["email", "contact"],
    ["name", "contact"],
    ["other", "contact"],
  ];
  const NOUN_RANK = new Map(NOUNS.map(([noun], i) => [noun, i]));
  const NOUN_GROUP = new Map(NOUNS);
  const KIND_NOUN = {
    password: "password",
    otp_secret: "code",
    backup_codes: "code",
    crypto_secret: "seed",
    internal_ip: "network",
    internal_host: "network",
    us_ssn: "id",
    national_id: "id",
    medicare_id: "id",
    medical_record: "id",
    passport: "id",
    drivers_license: "id",
    insurance_id: "id",
    vin: "id",
    student_id: "id",
    my_id: "id",
    id_picture: "idPicture",
    photo_location: "place",
    credit_card: "card",
    gift_card: "card",
    card_code: "cardCode",
    bank_account: "bank",
    date_of_birth: "birth",
    street_address: "address",
    phone_number: "phone",
    email: "email",
    my_name: "name",
    family_name: "name",
  };
  let byId = null;
  function pattern(id) {
    if (!byId) byId = new Map((C.PATTERNS || []).map((p) => [p.id, p]));
    return byId.get(id);
  }
  function nounOf(id) {
    if (KIND_NOUN[id]) return KIND_NOUN[id];
    return pattern(id)?.group === "credentials" ? "key" : "other";
  }

  // The engine's own rating for a kind (patterns.js: high, medium, low), as a rank: 0 is the most serious.
  const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
  function severityRank(id) {
    return SEVERITY_RANK[pattern(id)?.severity] ?? 1;
  }
  function worstSeverity(file) {
    let worst = 2;
    for (const id of Object.keys(file.found || {})) worst = Math.min(worst, severityRank(id));
    return worst;
  }

  // A photo's place only puts a picture in Photo locations; the same kind in a text file is a contact detail.
  function groupOfKind(id, file) {
    const group = NOUN_GROUP.get(nounOf(id));
    if (group === "photos" && file.kind !== "picture") return "contact";
    return group;
  }
  function groupOf(file) {
    let best = GROUPS.length - 1;
    for (const id of Object.keys(file.found || {})) best = Math.min(best, GROUPS.indexOf(groupOfKind(id, file)));
    // A code project's file and a secret file share one heading, the developer switch's own.
    return (file.project || file.secret) && NEEDS_A_LOOK.has(GROUPS[best]) ? "projects" : GROUPS[best];
  }
  function hasFinds(file) {
    return Boolean(file.found && Object.keys(file.found).length);
  }
  function needsALook(file) {
    return hasFinds(file) && NEEDS_A_LOOK.has(groupOf(file));
  }

  // `{ noun: count }` for a file's finds (or several files' summed), most harmful noun first.
  function nounCounts(found, onlyGroup = null, file = { kind: "text" }) {
    const out = new Map();
    for (const [id, n] of Object.entries(found || {})) {
      if (onlyGroup && groupOfKind(id, file) !== onlyGroup) continue;
      const noun = nounOf(id);
      out.set(noun, (out.get(noun) || 0) + n);
    }
    return [...out.entries()].sort((a, b) => NOUN_RANK.get(a[0]) - NOUN_RANK.get(b[0]));
  }

  // "Was this right?": the two things an answer keeps about a file besides yes or no, worked out fresh
  // each time from what's already on screen -- never stored on the file itself. The kind is its worst noun (the
  // same one a card leads with); the tier is one of store.rs's own four, "yours" unless the file is a code
  // project's or a secret file's.
  function accuracyKindOf(file) {
    const [noun] = nounCounts(file.found, null, file)[0] || [];
    return noun || "other";
  }
  function accuracyTierOf(file) {
    if (file.secret) return "secret";
    if (file.project) return "project";
    return "yours";
  }

  // "a key and 2 passwords": the first `cap` nouns, then how many more kinds there are.
  function kindsPhrase(found, { t, lang = "en", cap = 3, onlyGroup = null, file, fmt = String } = {}) {
    const counts = nounCounts(found, onlyGroup, file);
    const parts = counts
      .slice(0, cap)
      .map(([noun, n]) => (n === 1 ? t(`ws.kn.${noun}1`) : t(`ws.kn.${noun}N`, fmt(n))));
    if (counts.length > cap) parts.push(t("ws.knMore", fmt(counts.length - cap)));
    return listFormat(lang, parts);
  }
  function listFormat(lang, parts) {
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(parts);
  }

  // Byte-identical copies (the walker's `dupOf`: the first copy's own index) fold under that first copy, so one
  // file copied into 40 project folders is one entry "also in 40 places", not 41. A copy whose first copy isn't
  // in this list stands on its own. With `hideCopies` off every copy keeps its own entry, marked as a copy.
  function foldCopies(files, hideCopies = true) {
    const byIndex = new Map(files.map((f) => [f.index, f]));
    const rootOf = (file) => {
      let cur = file;
      for (let hops = 0; hops < 64 && cur.dupOf != null && cur.dupOf !== cur.index; hops++) {
        const next = byIndex.get(cur.dupOf);
        if (!next) break;
        cur = next;
      }
      return cur;
    };
    const entries = new Map();
    const order = [];
    const entryFor = (file) => {
      let entry = entries.get(file.index);
      if (!entry) {
        entry = { file, copies: [], copyOf: null };
        entries.set(file.index, entry);
        order.push(entry);
      }
      return entry;
    };
    for (const file of files) {
      const root = rootOf(file);
      if (root === file) {
        entryFor(file);
        continue;
      }
      entryFor(root).copies.push(file);
      if (!hideCopies) entryFor(file).copyOf = root;
    }
    if (hideCopies) return order;
    // Each copy's own entry sits right after its first copy's, so the two read together.
    const out = [];
    for (const entry of order) {
      if (entry.copyOf) continue;
      out.push(entry);
      for (const copy of entry.copies) out.push(entries.get(copy.index));
    }
    return out;
  }

  // Desktop and Downloads (a Quick scan's own roots) first, then Documents and Pictures, then the rest by name.
  const FOLDER_RANK = { desktop: 0, downloads: 0, documents: 1, pictures: 1 };
  // One collator for every comparison: building one per call made a 5,000-file sort take seconds.
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function compareFolders(a, b) {
    const byRank = (FOLDER_RANK[a] ?? 2) - (FOLDER_RANK[b] ?? 2);
    if (byRank) return byRank;
    return collator.compare(a, b);
  }
  // Inside a folder: what the engine rates most serious first, then by name, so a private key never sits below a
  // file with only an internal hostname in it.
  function compareEntries(a, b) {
    const bySeverity = a.severity - b.severity;
    if (bySeverity) return bySeverity;
    const byName = collator.compare(a.file.name, b.file.name);
    if (byName) return byName;
    return a.file.index - b.file.index;
  }

  // Files that hold the same detail (the run's own salted fingerprints, never a value), counted once per group:
  // copies are left out, since a copy holds the same detail by definition.
  function repeatedIndexes(entries) {
    const byFp = new Map();
    for (const { file, copyOf } of entries) {
      if (copyOf) continue;
      for (const [id, fps] of Object.entries(file.fps || {})) {
        for (const fp of fps) {
          const key = `${id}\0${fp}`;
          if (!byFp.has(key)) byFp.set(key, new Set());
          byFp.get(key).add(file.index);
        }
      }
    }
    const out = new Set();
    for (const indexes of byFp.values()) if (indexes.size > 1) for (const i of indexes) out.add(i);
    return out;
  }

  // The whole view: groups in order of harm, each with its folders and their entries, plus the counts the summary
  // line speaks from. `query` matches file names only (they're already on the page); `onlyNeeds` drops contact
  // details. The counts in `totals` are always the unfiltered scan's, so the summary never changes under a search.
  function buildView(files, { hideCopies = true, onlyNeeds = false, query = "" } = {}) {
    const withFinds = (files || []).filter(hasFinds);
    const q = query.trim().toLocaleLowerCase();
    const all = foldCopies(withFinds, hideCopies);
    const repeated = repeatedIndexes(all);
    const totals = { needs: 0, projects: 0, appSignins: 0, contact: 0, copies: 0, byGroup: {} };
    const byGroup = new Map(GROUPS.map((g) => [g, []]));
    for (const entry of all) {
      const group = groupOf(entry.file);
      entry.severity = worstSeverity(entry.file);
      if (!entry.copyOf) {
        totals.byGroup[group] = (totals.byGroup[group] || 0) + 1;
        if (NEEDS_A_LOOK.has(group)) totals.needs++;
        else if (group === "projects") {
          totals.projects++;
          if (entry.file.appSignin) totals.appSignins++;
        } else totals.contact++;
        totals.copies += entry.copies.length;
      }
      if (onlyNeeds && !NEEDS_A_LOOK.has(group)) continue;
      if (q && !entry.file.name.toLocaleLowerCase().includes(q)) continue;
      byGroup.get(group).push(entry);
    }
    const groups = [];
    for (const id of GROUPS) {
      const entries = byGroup.get(id);
      if (!entries.length) continue;
      const folderMap = new Map();
      for (const entry of entries) {
        const label = entry.file.folder || "";
        if (!folderMap.has(label)) folderMap.set(label, []);
        folderMap.get(label).push(entry);
      }
      const folders = [...folderMap.keys()].sort(compareFolders).map((label) => ({
        label,
        entries: folderMap.get(label).sort(compareEntries),
      }));
      groups.push({
        id,
        needs: NEEDS_A_LOOK.has(id),
        files: entries.filter((e) => !e.copyOf).length,
        copies: entries.reduce((n, e) => n + (e.copyOf ? 0 : e.copies.length), 0),
        repeated: entries.filter((e) => repeated.has(e.file.index)).length,
        folders,
      });
    }
    return { groups, totals };
  }

  // The summary at the top of Results (and of the saved page): what needs a look, then what it holds by group,
  // then contact details and copies on a quieter line. Plain counts, no chips.
  const GROUP_CLAUSE = { keys: "ws.resKeys", ids: "ws.resIds", photos: "ws.resPhotos", money: "ws.resMoney" };
  function summaryLines(totals, { t, lang = "en", fmt = String } = {}) {
    const n = totals.needs;
    const head = n === 0 ? t("ws.resNeedNone") : n === 1 ? t("ws.resNeedOne") : t("ws.resNeedN", fmt(n));
    const clauses = GROUPS.filter((g) => GROUP_CLAUSE[g] && totals.byGroup[g]).map((g) => {
      const count = totals.byGroup[g];
      return count === 1 ? t(`${GROUP_CLAUSE[g]}One`) : t(`${GROUP_CLAUSE[g]}N`, fmt(count));
    });
    const detail = clauses.length ? `${listFormat(lang, clauses)}.` : "";
    const quiet = [];
    if (totals.contact) {
      // With nothing else found, contact details are the whole story, so the line says "only".
      const key = n === 0 ? "ws.resContactOnly" : "ws.resContact";
      quiet.push(totals.contact === 1 ? t(`${key}One`) : t(`${key}N`, fmt(totals.contact)));
    }
    if (totals.projects) {
      quiet.push(totals.projects === 1 ? t("ws.resProjectsOne") : t("ws.resProjectsN", fmt(totals.projects)));
    }
    // An app's own sign-in (gh's hosts.yml, a cloud tool's credentials) is meant to sit there: it gets the gentler
    // advice, leave it and sign out of the app once it's no longer used, rather than a count asking for a fix.
    if (totals.appSignins) {
      quiet.push(totals.appSignins === 1 ? t("ws.resAppSigninOne") : t("ws.resAppSigninN", fmt(totals.appSignins)));
    }
    if (totals.copies) quiet.push(totals.copies === 1 ? t("ws.resCopiesOne") : t("ws.resCopiesN", fmt(totals.copies)));
    return { head, detail, quiet: quiet.join(" ") };
  }

  // Where a file is, the way a person looks for it: its top place (a known folder's key, the first folder in the
  // home folder, or a drive with its first folder), then the folders below that, already shortened by the walker.
  function placeLine(file) {
    const top = String(file?.folder || "");
    const head = top.charAt(0).toUpperCase() + top.slice(1);
    return [head, ...(file?.place || [])].filter(Boolean).join(" › ");
  }

  globalThis.ClotrFindings = {
    GROUPS,
    groupOf,
    needsALook,
    nounOf,
    severityRank,
    worstSeverity,
    nounCounts,
    accuracyKindOf,
    accuracyTierOf,
    kindsPhrase,
    foldCopies,
    buildView,
    summaryLines,
    listFormat,
    placeLine,
  };
})();
