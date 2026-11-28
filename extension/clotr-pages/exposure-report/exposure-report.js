// "Your exposure report", the full-page dashboard.
// Reads the stored history (kind, site, time, outcome, fingerprint; never values). Fingerprints
// are only used to count "different" details and repeats; they're never shown. Nothing leaves
// the page except an export file the user asks for.
"use strict";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const { PATTERNS, msg } = globalThis.Clotr;
const TYPE = Object.fromEntries(PATTERNS.map((pattern) => [pattern.id, pattern]));
const PERSONAL = new Set(
  PATTERNS.filter((pattern) => pattern.group === "personal" || pattern.group === "custom").map((pattern) => pattern.id),
);
const SERIES = [
  { action: "redacted", label: msg("pp_covered", "Hidden"), color: "var(--series-1)" },
  { action: "allowed", label: msg("pp_sent", "Sent"), color: "var(--series-2)" },
  { action: "suppressed", label: msg("pp_justCounted", "Just counted"), color: "var(--series-3)" },
];
const DAY = 86400000;

// ---------- Page parts and words ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

// A kind's name, in the browser's language.
function nameOf(event) {
  return TYPE[event.type]?.name || event.name || event.type;
}

function tools(count) {
  return count === 1 ? msg("db_tool1", "1 AI tool") : msg("db_toolN", "$1 services", count);
}

const fmtDay = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
const fmtWhen = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });

const advice = globalThis.ClotrInsights.adviceFor;
// How many details a record stands for: one, or the count of the rest of a long list sent at once.
const { weight } = globalThis.ClotrSites;

function sum(list) {
  return list.reduce((total, event) => total + weight(event), 0);
}

function moreInOneGo(event) {
  return msg("pp_moreInOneGo", "$1 more in one go", weight(event).toLocaleString());
}

// Biggest count first, then by site name. `entries` are [site, count] pairs.
function byCountThenSite(a, b, countOf) {
  return countOf(b[1]) - countOf(a[1]) || a[0].localeCompare(b[0]);
}

// ---------- Totals ----------

function statBox(number, label) {
  return el("div", { className: "stat" }, [
    el("b", { textContent: String(number) }),
    el("span", { textContent: label }),
  ]);
}

function renderTotals(events) {
  function count(action) {
    return sum(events.filter((event) => event.action === action));
  }
  $("totals").replaceChildren(
    statBox(sum(events), msg("db_foundTotal", "found in total")),
    ...SERIES.map((series) => statBox(count(series.action), series.label)),
  );
  if (!events.length) {
    $("since").textContent = msg("db_nothingYet", "Nothing here yet. What Clotr notices shows up here as you go.");
    return;
  }
  const sites = new Set(events.map((event) => event.site)).size;
  $("since").textContent = msg("db_since", "Since $1 · $2", fmtDay.format(events[0].t), tools(sites));
}

// ---------- Personal details sent, by AI service ----------

function exposureRow(site, details) {
  const kinds = new Map();
  for (const event of details.values()) kinds.set(nameOf(event), (kinds.get(nameOf(event)) || 0) + 1);
  const count =
    details.size === 1
      ? msg("db_detail1", "1 personal detail")
      : msg("db_detailN", "$1 personal details", details.size);
  const kindsText = [...kinds].map(([kind, times]) => (times > 1 ? `${times} × ${kind}` : kind)).join(" · ");
  const node = el("div", { className: "tool" }, [
    el("div", { className: "name", textContent: msg("db_siteDetails", "$1: $2", site, count) }),
    el("div", { className: "kinds", textContent: kindsText }),
  ]);
  node.dataset.site = site;
  node.dataset.details = String(details.size);
  return node;
}

function renderExposure(events) {
  // Each different personal detail sent, by site: the same kind and fingerprint counts once.
  const bySite = new Map();
  for (const event of events) {
    if (event.action !== "allowed" || !event.fp || !PERSONAL.has(event.type)) continue;
    if (!bySite.has(event.site)) bySite.set(event.site, new Map());
    bySite.get(event.site).set(`${event.type}:${event.fp}`, event);
  }
  const rows = [...bySite.entries()].sort((a, b) => byCountThenSite(a, b, (details) => details.size));
  if (!rows.length) {
    const none = msg("db_noDetails", "No personal details have been sent to any service. 👍");
    $("exposure").replaceChildren(el("p", { className: "empty-note", textContent: none }));
    return;
  }
  $("exposure").replaceChildren(...rows.map(([site, details]) => exposureRow(site, details)));
}

// ---------- What Bandage kept ----------

function keptRow(site, count) {
  const kept = count === 1 ? msg("db_kept1", "1 detail kept") : msg("db_keptN", "$1 details kept", count);
  const node = el("div", { className: "tool" }, [
    el("div", { className: "name", textContent: msg("db_bandageSiteKept", "$1: $2", site, kept) }),
  ]);
  node.dataset.site = site;
  node.dataset.kept = String(count);
  return node;
}

// What Bandage kept from each AI: "redacted" events with `via: "bandage"`,
// apart from what you hid by hand. Only shown once Bandage has covered something.
function renderBandageKept(events) {
  const bySite = new Map();
  for (const event of events) {
    if (event.action !== "redacted" || event.via !== "bandage") continue;
    bySite.set(event.site, (bySite.get(event.site) || 0) + weight(event));
  }
  $("bandage-section").hidden = bySite.size === 0;
  if (!bySite.size) return;
  const rows = [...bySite.entries()].sort((a, b) => byCountThenSite(a, b, (count) => count));
  $("bandage-kept").replaceChildren(...rows.map(([site, count]) => keptRow(site, count)));
}

// ---------- The mind map ----------

// Mind map of everything you could be leaking: history, reply mentions, your vault and the
// AI tools Clotr spotted but doesn't protect. The model and layout live in page-parts/insights.js / page-parts/mind-map.js.
const mapData = { events: [], mentions: [], vault: [], spotted: {} };
let mapView = readView();
let mapChosen = null;
function readView() {
  try {
    return localStorage.getItem("clotr.mapView") === "kind" ? "kind" : "service";
  } catch {
    return "service";
  }
}

// Spotted sites that are still unprotected (protecting one takes it off the blind spots).
async function blindSpots() {
  const covered = [...globalThis.ClotrSites.builtInMatches(), ...(await globalThis.ClotrSites.userSitePatterns())];
  return globalThis.ClotrInsights.unprotectedHosts(mapData.spotted, covered);
}

// The node with this id in the tree, or null.
function findNode(tree, id) {
  let found = null;
  function visit(node) {
    if (node.id === id) found = node;
    node.children.forEach(visit);
  }
  visit(tree);
  return found;
}

async function renderMap() {
  // Draw at the real width so text stays readable on a narrow window.
  mapWidth = $("map").parentElement.clientWidth; // the section: the map itself is narrower as an outline
  const width = Math.round(Math.min(960, Math.max(340, mapWidth || 760)));
  $("map").dataset.room = `0 0 ${width} ${Math.round(width * (width < 560 ? 1 : 0.72))}`;
  const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
  const { layoutRadial, layoutList, renderMindMap, renderMindMapTable } = globalThis.ClotrMindMap;
  const model = exposureModel({ ...mapData, blind: await blindSpots() });
  // Wide: a radial mind map. Narrow (a phone, a side panel): the same tree as an outline, which
  // stays readable at any width.
  const narrow = width < 560;
  const built = buildMindMapTree(model, { view: mapView, max: width < 640 ? 5 : 8, leaves: width >= 640 });
  const tree = narrow ? layoutList(built) : layoutRadial(built);
  $("map").classList.toggle("as-list", narrow);
  function show(node) {
    mapChosen = node.id;
    $("map-details").textContent = node.detail || node.label;
  }
  renderMindMap($("map"), tree, { onSelect: show });
  const chosen = findNode(tree, mapChosen);
  const empty = !model.has.bySite.length && !model.near.bySite.length;
  if (chosen) show(chosen);
  else {
    $("map-details").textContent = empty
      ? msg("db_mapEmpty", "Nothing here yet. The map fills in as Clotr notices things in your chats and email.")
      : "";
  }
  renderMindMapTable($("map-table").tBodies[0], tree);
  for (const button of $("map-view").querySelectorAll("button")) {
    button.setAttribute("aria-checked", String(button.dataset.view === mapView));
  }
}

$("map-view").addEventListener("click", (event) => {
  const view = event.target.closest("button")?.dataset.view;
  if (!view || view === mapView) return;
  mapView = view;
  mapChosen = null;
  try {
    localStorage.setItem("clotr.mapView", view); // this page's view only (a convenience, not a setting)
  } catch {
    /* private window: the toggle still works for this visit */
  }
  renderMap();
});

// Only a new width redraws: a height change (a phone's address bar, a full-page capture) leaves the map
// still.
let mapResize = null;
let mapWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(mapResize);
  mapResize = setTimeout(() => {
    if ($("map").parentElement.clientWidth !== mapWidth) renderMap();
  }, 150);
});

// ---------- Twelve weeks ----------

const WEEKS = 12;
const CHART_WIDTH = 720;
const CHART_HEIGHT = 200;
const CHART_PAD = { l: 28, r: 8, t: 8, b: 24 };

// Each of the last twelve weeks, ending today, with its counts by outcome.
function weekCounts(events) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = now.getTime() - 83 * DAY; // 12 weeks, ending today
  const weeks = Array.from({ length: WEEKS }, (_, index) => ({
    from: start + index * 7 * DAY,
    redacted: 0,
    allowed: 0,
    suppressed: 0,
  }));
  for (const event of events) {
    const index = Math.floor((event.t - start) / (7 * DAY));
    if (index >= 0 && index < WEEKS && event.action in weeks[index]) weeks[index][event.action] += weight(event);
  }
  return weeks;
}

function svgText(attrs, text) {
  return Object.assign(svg("text", attrs), { textContent: text });
}

// One week's stacked bar, named for screen readers and as a tooltip.
function weekBar(week, index, max) {
  const pad = CHART_PAD;
  const band = (CHART_WIDTH - pad.l - pad.r) / WEEKS;
  const plot = CHART_HEIGHT - pad.t - pad.b;
  const x = pad.l + index * band + band * 0.18;
  const width = band * 0.64;
  let y = CHART_HEIGHT - pad.b;
  const group = svg("g", {
    tabindex: 0,
    role: "img",
    "aria-label": msg(
      "db_weekLabel",
      "Week of $1: $2 hidden, $3 sent, $4 just counted",
      fmtDay.format(week.from),
      week.redacted,
      week.allowed,
      week.suppressed,
    ),
  });
  group.dataset.week = String(index);
  for (const series of SERIES) {
    const height = (week[series.action] / max) * plot;
    if (height > 0) {
      y -= height;
      group.append(svg("rect", { x, y, width, height, fill: series.color, rx: 2 }));
    }
  }
  group.append(Object.assign(svg("title"), { textContent: group.getAttribute("aria-label") }));
  return { group, middle: x + width / 2 };
}

function weekRow(week) {
  return el("tr", {}, [
    el("td", { textContent: fmtDay.format(week.from) }),
    el("td", { textContent: String(week.redacted) }),
    el("td", { textContent: String(week.allowed) }),
    el("td", { textContent: String(week.suppressed) }),
  ]);
}

function renderWeeks(events) {
  const weeks = weekCounts(events);
  const pad = CHART_PAD;
  const max = Math.max(1, ...weeks.map((week) => week.redacted + week.allowed + week.suppressed));
  const bottom = CHART_HEIGHT - pad.b;
  const nodes = [
    svg("line", { class: "grid", x1: pad.l, x2: CHART_WIDTH - pad.r, y1: bottom, y2: bottom }),
    svgText({ class: "tick", x: 2, y: pad.t + 10 }, String(max)),
  ];
  for (const [index, week] of weeks.entries()) {
    const { group, middle } = weekBar(week, index, max);
    nodes.push(group);
    // A date under every other bar.
    if (index % 2 === 0) {
      const tick = { class: "tick", x: middle, y: CHART_HEIGHT - 6, "text-anchor": "middle" };
      nodes.push(svgText(tick, fmtDay.format(week.from)));
    }
  }
  $("weeks").replaceChildren(...nodes);
  const swatches = SERIES.map((series) => el("span", {}, [Object.assign(el("i"), { style: "" }), series.label]));
  $("legend").replaceChildren(...swatches);
  $("legend")
    .querySelectorAll("i")
    .forEach((swatch, index) => {
      swatch.style.background = SERIES[index].color;
    });
  $("weeks-table").tBodies[0].replaceChildren(...weeks.map(weekRow));
}

// ---------- Risky moments, repeats and the card ----------

function riskyMoment(event) {
  return el("div", { className: "moment" }, [
    el("div", { className: "what", textContent: msg("db_sentTo", "$1 sent to $2", nameOf(event), event.site) }),
    ...(weight(event) > 1 ? [el("div", { className: "more", textContent: moreInOneGo(event) })] : []),
    el("div", { className: "when", textContent: fmtWhen.format(event.t) }),
    el("div", { className: "todo", textContent: msg("db_whatToDo", "What to do now: $1", advice(event.type)) }),
  ]);
}

// High-risk kinds that went out, newest first, up to 20. A test reads this kind list by its shape.
function renderRisky(events) {
  const risky = events.filter(
    (e) =>
      (e.action === "allowed" && e.severity === "high" && !PERSONAL.has(e.type)) ||
      (e.action === "allowed" &&
        [
          "credit_card",
          "card_code",
          "gift_card",
          "us_ssn",
          "bank_account",
          "national_id",
          "passport",
          "medical_record",
          "crypto_secret",
        ].includes(e.type)),
  );
  if (!risky.length) {
    const none = msg("db_noRisky", "No high-risk items have been sent. 👍");
    $("risky").replaceChildren(el("p", { className: "empty-note", textContent: none }));
    return;
  }
  const newest = risky.slice().reverse().slice(0, 20);
  $("risky").replaceChildren(...newest.map(riskyMoment));
}

function renderRepeats(events) {
  // The same kind and fingerprint sent more than once, with where it went.
  const groups = new Map();
  for (const event of events) {
    if (event.action !== "allowed" || !event.fp) continue;
    const key = `${event.type}:${event.fp}`;
    if (!groups.has(key)) groups.set(key, { name: nameOf(event), times: 0, sites: new Set() });
    const group = groups.get(key);
    group.times++;
    group.sites.add(event.site);
  }
  const rows = [...groups.values()].filter((group) => group.times > 1).sort((a, b) => b.times - a.times);
  if (!rows.length) {
    const none = msg("db_noRepeats", "Nothing was sent more than once.");
    $("repeats").replaceChildren(el("p", { className: "empty-note", textContent: none }));
    return;
  }
  const items = rows.map((group) =>
    el("li", {
      textContent: msg(
        "db_repeat",
        "The same $1 went out $2 times, to $3. If it's yours, add it to your vault and Clotr will always watch for it.",
        group.name,
        group.times,
        tools(group.sites.size),
      ),
    }),
  );
  $("repeats").replaceChildren(el("ul", {}, items));
}

function renderCard(events) {
  const sent = sum(events.filter((event) => event.action === "allowed"));
  const covered = sum(events.filter((event) => event.action === "redacted"));
  const toolCount = new Set(events.map((event) => event.site)).size;
  const total = sum(events);
  const caught = total === 1 ? msg("db_private1", "1 private detail") : msg("db_privateN", "$1 private details", total);
  const text = msg(
    "db_card",
    "Clotr caught $1 on its way to $2: $3 hidden, $4 sent anyway. Checked on my own computer; nothing ever left it.",
    caught,
    tools(toolCount),
    covered,
    sent,
  );
  $("card").replaceChildren(el("b", { textContent: msg("db_cardTitle", "🛡️ My privacy, so far") }), el("br"), text);
  $("copy-card").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $("copy-msg").textContent = msg("db_copied", "Copied.");
    } catch {
      $("copy-msg").textContent = msg("db_copyFailed", "Couldn't copy; select the text instead.");
    }
  };
}

// ---------- Your data ----------

// The "Download again" link, made on the first export.
function exportLink() {
  let link = $("export-link");
  if (!link) {
    link = el("a", { id: "export-link", textContent: msg("db_downloadAgain", "Download again") });
    $("data-msg").after(link);
  }
  return link;
}

$("export").addEventListener("click", async () => {
  const {
    events = [],
    vault = [],
    responses = {},
    siteModes = {},
  } = await chrome.storage.local.get(["events", "vault", "responses", "siteModes"]);
  const exportData = {
    exported: new Date().toISOString(),
    note: "Clotr history: kinds of data, sites, times and outcomes. No detected values. The fingerprint secret is not included.",
    events,
    vault,
    responses,
    siteModes,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }));
  const link = exportLink();
  if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href); // free the previous export
  link.href = url;
  link.download = `clotr-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  $("data-msg").textContent =
    events.length === 1
      ? msg("db_exported1", "Exported 1 record.")
      : msg("db_exportedN", "Exported $1 records.", events.length);
});

// The background removes older records when this changes.
chrome.storage.local.get("keepDays").then(({ keepDays = 365 }) => {
  $("keep-days").value = String(keepDays);
});
$("keep-days").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ keepDays: Number(event.target.value) });
  const chosen = event.target.selectedOptions[0].textContent;
  $("data-msg").textContent = msg("db_keeping", "Keeping $1 of history.", chosen);
});

// "Your history is full": the 10,000-record cap removed records sooner than the keep period would have.
// The background stores two times (`historyFull`: when, and the oldest record kept) and removes the note
// once there's room again. "Tell us" opens the bug form with a fixed title and nothing from the history:
// the report that decides whether history moves to bigger storage. The title stays English so it's easy
// to search bug reports for.
const fmtLong = new Intl.DateTimeFormat([], { dateStyle: "long" });
// Hyphens and spaces that never break, so "1-year" stays on one line on a phone.
const KEEP_SETTING = {
  90: msg("db_keepSetting90", "3\u2011month"),
  365: msg("db_keepSetting365", "1\u2011year"),
  730: msg("db_keepSetting730", "2\u2011year"),
};
$("history-full-tell").href =
  globalThis.Clotr.Report?.formUrl("bug.yml", null, "History full (10,000 records)") ||
  "https://github.com/clotr-app/clotr/issues/new";
function renderHistoryFull({ historyFull, keepDays }) {
  const before = historyFull?.before;
  const days = KEEP_SETTING[keepDays] ? keepDays : 365;
  const show = Number.isFinite(before) && before >= Date.now() - days * DAY;
  $("history-full").hidden = !show;
  if (!show) return;
  $("history-full-text").textContent = msg(
    "db_historyFullText",
    "Clotr keeps up to 10,000 records. To make room, it removed records from before $1, sooner than your $2 setting. Everything newer is still here.",
    fmtLong.format(before),
    KEEP_SETTING[days],
  );
}
function refreshHistoryFull() {
  return chrome.storage.local.get(["historyFull", "keepDays"]).then(renderHistoryFull);
}
refreshHistoryFull();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.historyFull || changes.keepDays)) refreshHistoryFull();
});

// Two clicks, so a stray click can't wipe history. The first arms the button for four seconds.
const DELETE_ARM_MS = 4000;
let armed = null;

function disarm(button) {
  button.classList.remove("armed");
  button.textContent = msg("dash_deleteMyHistory", "Delete my history");
}

$("delete-history").addEventListener("click", async () => {
  const button = $("delete-history");
  if (!armed) {
    button.classList.add("armed");
    button.textContent = msg("db_deleteAgain", "Click again to delete all history");
    armed = setTimeout(() => {
      armed = null;
      disarm(button);
    }, DELETE_ARM_MS);
    return;
  }
  clearTimeout(armed);
  armed = null;
  await chrome.runtime.sendMessage({ type: "clotr:clearHistory" });
  disarm(button);
  $("data-msg").textContent = msg("db_deleted", "History deleted. Your settings and vault are still here.");
});

// ---------- Start ----------

function renderAll(events) {
  mapData.events = events;
  renderTotals(events);
  renderExposure(events);
  renderBandageKept(events);
  renderMap();
  renderWeeks(events);
  renderRisky(events);
  renderRepeats(events);
  renderCard(events);
}

chrome.storage.local.get(["events", "mentions", "vault", "spotted"]).then((stored) => {
  mapData.mentions = stored.mentions || [];
  mapData.vault = stored.vault || [];
  mapData.spotted = stored.spotted || {};
  renderAll(stored.events || []);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.mentions) mapData.mentions = changes.mentions.newValue || [];
  if (changes.vault) mapData.vault = changes.vault.newValue || [];
  if (changes.spotted) mapData.spotted = changes.spotted.newValue || {};
  if (changes.events) renderAll(changes.events.newValue || []);
  else if (changes.mentions || changes.vault || changes.spotted) renderMap();
});
