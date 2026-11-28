/* global $, ACTIVITY_LIMIT, OUTCOME, PATTERNS, PATTERN_NAMES, SERIES, aKind, el, msg, rangeDays, renderLookBackCard,
          renderScamHelpToday, site, siteFilter, state, sum, svg, viewEvents, viewMentions, weight */
/* exported renderActivity, renderOverview */
"use strict";

// ---------- Overview (dashboard) ----------

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function lastNDays(count) {
  const today = startOfDay(Date.now());
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (count - 1 - index));
    return day;
  });
}

function niceCeil(value) {
  if (value <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= value) return Math.ceil(step * pow);
  return value;
}

function countBy(list, keyFn) {
  const out = new Map();
  for (const item of list) out.set(keyFn(item), (out.get(keyFn(item)) || 0) + weight(item));
  return [...out.entries()].sort((first, second) => second[1] - first[1]);
}

// One caught item: covered with a dash, went through with a cross.
function caughtRow(record) {
  const name = PATTERN_NAMES[record.type] || record.name || record.type;
  const isCovered = record.action === "redacted";
  return el("li", { className: `caught-row ${isCovered ? "covered" : "through"}` }, [
    el("span", { className: "mark", "aria-hidden": "true", textContent: isCovered ? "–" : "✕" }),
    el("span", {
      textContent: isCovered
        ? msg("pp_itemCovered", "$1 was covered.", aKind(name), name)
        : msg("pp_itemSent", "$1 went through as it was.", aKind(name), name),
    }),
  ]);
}

// A record on this tab's own site, in the range, that was covered or went through.
function isCaughtHere(record, since) {
  if (record.site !== site.host) return false;
  if (!(record.t >= since)) return false;
  return record.action === "redacted" || record.action === "allowed";
}

// What Clotr caught on this tab's own site (not the Overview's site filter), in the current range:
// covered with a dash, went through with a cross. Only while Clotr protects this site.
function renderCaught() {
  const card = $("caught-card");
  if (site.kind !== "protected") {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const since = lastNDays(rangeDays)[0].getTime();
  const items = state.events.filter((record) => isCaughtHere(record, since));
  const covered = sum(items.filter((record) => record.action === "redacted"));
  const sent = sum(items.filter((record) => record.action === "allowed"));
  $("caught-list").replaceChildren(...items.slice(-4).reverse().map(caughtRow));
  $("caught-sum").textContent =
    covered + sent > 0
      ? msg(
          "pp_caughtSum",
          "$1 caught in the last $2 days. $3 covered, $4 went through.",
          covered + sent,
          rangeDays,
          covered,
          sent,
        )
      : msg("pp_caughtNone", "Nothing caught here in the last $1 days.", rangeDays);
}

function renderReplyMentions(since) {
  const replyMentions = viewMentions().filter((record) => record.t >= since);
  $("reply-mentions-card").hidden = replyMentions.length === 0;
  if (!replyMentions.length) return;
  $("reply-mentions-text").textContent = msg(
    replyMentions.length === 1 ? "popup_replyMentionsOne" : "popup_replyMentionsMany",
    replyMentions.length === 1
      ? "1 AI reply mentioned your details in the last $1 days."
      : "$2 AI replies mentioned your details in the last $1 days.",
    rangeDays,
    replyMentions.length,
  );
}

function renderEmptyOverview(empty) {
  const quiet = empty && viewEvents().length > 0; // history exists, just not in this range
  $("empty-title").textContent = quiet
    ? msg("pp_quietDays", "Quiet $1 days.", rangeDays)
    : msg("popup_nothingFoundYet", "Nothing found yet.");
  $("empty-hint").hidden = quiet;
  $("empty-quiet").hidden = !quiet;
  $("empty-overview").hidden = !empty;
  $("overview-body").hidden = empty;
}

// The big number: leaks stopped in the range, and the other outcomes under it.
function renderHero(events) {
  const outcomeTotal = (action) => sum(events.filter((record) => record.action === action));
  $("hero-value").textContent = outcomeTotal("redacted").toLocaleString();
  $("hero-label").textContent =
    outcomeTotal("redacted") === 1
      ? msg("pp_heroOne", "leak stopped in the last $1 days", rangeDays)
      : msg("pp_heroMany", "leaks stopped in the last $1 days", rangeDays);
  $("hero-sub").textContent = msg(
    "pp_heroSub",
    "$1 found · $2 sent · $3 just counted",
    sum(events),
    outcomeTotal("allowed"),
    outcomeTotal("suppressed"),
  );
}

function renderOverview() {
  const days = lastNDays(rangeDays);
  const since = days[0].getTime();
  const events = viewEvents().filter((record) => record.t >= since);

  renderCaught();
  for (const button of document.querySelectorAll(".range button")) {
    button.setAttribute("aria-checked", String(Number(button.dataset.days) === rangeDays));
  }

  renderExposure(); // all history, so it shows even when this range is quiet
  renderMiniMap();
  renderDigest();
  renderLookBackCard(); // all history too: it's about what's out there, not this range
  renderScamHelpToday(); // today only, regardless of range
  const empty = events.length === 0;
  renderReplyMentions(since);
  renderEmptyOverview(empty);
  if (empty) return;

  renderHero(events);
  renderAlerts(events);
  renderLegend(events);
  renderChart(days, events);
  renderHBars(
    $("by-site"),
    countBy(events, (record) => record.site),
  );
  renderHBars(
    $("by-type"),
    countBy(events, (record) => PATTERN_NAMES[record.type] || record.name || record.type),
  );
}

// The small mind map: only branches with something in them; the full one is in the report.
function renderMiniMap() {
  const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
  const { layoutRadial, renderMindMap } = globalThis.ClotrMindMap;
  const events = viewEvents();
  const mentions = siteFilter ? state.mentions.filter((record) => record.site === siteFilter) : state.mentions;
  const model = exposureModel({ events, mentions });
  $("mini-map-card").hidden = !model.has.bySite.length && !model.near.bySite.length;
  if ($("mini-map-card").hidden) return;
  const tree = layoutRadial(buildMindMapTree(model, { compact: true, max: 4 }));
  renderMindMap($("mini-map"), tree, { compact: true });
  // The key: each branch's name and count, drawn in its line's style.
  $("mini-map-key").replaceChildren(
    ...tree.children.map((branch) =>
      el("span", { className: `key-${branch.branch}` }, [
        el("i", { "aria-hidden": "true" }),
        `${branch.label} `,
        el("b", { textContent: String(branch.count) }),
      ]),
    ),
  );
}

// This week against last week, in words.
function trendWords(found, last) {
  if (found < last) return msg("pp_fewer", "fewer than last week ($1)", last);
  if (found > last) return msg("pp_more", "more than last week ($1)", last);
  return msg("pp_same", "the same as last week");
}

// Weekly digest: this week against last week, and the one thing to do now. Local, no notifications.
function renderDigest() {
  const DAY = 86400000;
  const now = Date.now();
  const all = viewEvents();
  const week = all.filter((record) => record.t >= now - 7 * DAY);
  const found = sum(week);
  const last = sum(all.filter((record) => record.t >= now - 14 * DAY && record.t < now - 7 * DAY));
  $("digest").hidden = found === 0 && last === 0;
  if ($("digest").hidden) return;
  const outcomeTotal = (action) => sum(week.filter((record) => record.action === action));
  const trend = trendWords(found, last);
  $("digest-line").textContent = msg(
    "pp_digest",
    "This week: $1 found, $2 hidden, $3 sent anyway. That's $4.",
    found,
    outcomeTotal("redacted"),
    outcomeTotal("allowed"),
    trend,
  );
  const risky = week.filter((record) => record.action === "allowed" && record.severity === "high").at(-1);
  $("digest-todo").textContent = risky
    ? msg(
        "pp_todo",
        "To do: the $1 sent to $2. $3",
        PATTERN_NAMES[risky.type] || risky.name || risky.type,
        risky.site,
        globalThis.ClotrInsights.adviceFor(risky.type),
      )
    : msg("pp_nothingRisky", "Nothing high-risk went out this week.");
  $("digest-todo").classList.toggle("urgent", Boolean(risky));
}

// Profile exposure: distinct personal details (by fingerprint) each AI tool actually
// received, i.e. sent with outcome "allowed". All stored history, not just the range.
const PROFILE_TYPES = new Set(
  PATTERNS.filter((pattern) => pattern.group === "personal" || pattern.group === "custom").map((pattern) => pattern.id),
);
function renderExposure() {
  const seen = new Map(); // site → Set(fp)
  for (const record of viewEvents()) {
    if (record.action !== "allowed" || !record.fp || !PROFILE_TYPES.has(record.type)) continue;
    if (!seen.has(record.site)) seen.set(record.site, new Set());
    seen.get(record.site).add(`${record.type}:${record.fp}`);
  }
  const rows = [...seen]
    .map(([host, fingerprints]) => [host, fingerprints.size])
    .sort((first, second) => second[1] - first[1]);
  renderHBars($("exposure"), rows);
  $("exposure-empty").hidden = rows.length > 0;
  $("exposure-card").hidden = viewEvents().length === 0; // nothing at all yet: the empty card covers it
}

function renderAlerts(events) {
  const alerts = [];

  const riskyAllowed = sum(events.filter((record) => record.action === "allowed" && record.severity === "high"));
  if (riskyAllowed) {
    alerts.push(
      riskyAllowed === 1
        ? msg("pp_riskyOne", "You sent 1 high-risk item anyway in this period.")
        : msg("pp_riskyMany", "You sent $1 high-risk items anyway in this period.", riskyAllowed),
    );
  }

  // The same secret seen more than once (by fingerprint); only high-severity ones are worth nagging about.
  const high = events.filter((record) => record.fp && record.severity === "high");
  const repeats = countBy(high, (record) => record.fp)
    .filter(([, count]) => count > 1)
    .slice(0, 2);
  for (const [fp, count] of repeats) {
    const hit = high.find((record) => record.fp === fp);
    alerts.push(
      msg(
        "pp_repeat",
        "Clotr found the same $1 $2 times. If it's a real password or key, it's worth changing.",
        PATTERN_NAMES[hit.type] || hit.name,
        count,
      ),
    );
  }

  $("alerts").replaceChildren(
    ...alerts.map((text) =>
      el("div", { className: "alert", role: "note" }, [
        el("span", { className: "icon", textContent: "⚠️", "aria-hidden": "true" }),
        el("span", { textContent: text }),
      ]),
    ),
  );
}

function renderLegend(events) {
  $("legend").replaceChildren(
    ...SERIES.map((series) =>
      el("span", {}, [
        el("i", { style: { background: series.color } }),
        series.label,
        el("b", { textContent: String(sum(events.filter((record) => record.action === series.action))) }),
      ]),
    ),
  );
}

// ---------- The chart ----------

function colPath(x, y, width, height, corner) {
  const radius = Math.min(corner, height, width / 2);
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

// Events per day and outcome.
function chartBuckets(days, events) {
  const buckets = days.map((day) => ({ date: day, redacted: 0, allowed: 0, suppressed: 0 }));
  const index = new Map(days.map((day, at) => [day.getTime(), at]));
  for (const record of events) {
    const at = index.get(startOfDay(record.t).getTime());
    if (at !== undefined && record.action in buckets[at]) buckets[at][record.action] += weight(record);
  }
  return buckets;
}

function bucketTotal(bucket) {
  return bucket.redacted + bucket.allowed + bucket.suppressed;
}

// Recessive grid: top + midpoint (when it's a whole number) + baseline.
function drawChartGrid({ chart, width, pad, base, yMax, y }) {
  const ticks = yMax >= 2 && yMax % 2 === 0 ? [yMax / 2, yMax] : [yMax];
  for (const tick of ticks) {
    const tickY = base - y(tick);
    chart.append(svg("line", { class: "gridline", x1: pad.left, x2: width - pad.right, y1: tickY, y2: tickY }));
    const label = svg("text", { class: "tick", x: pad.left - 5, y: tickY + 3, "text-anchor": "end" });
    label.textContent = String(tick);
    chart.append(label);
  }
  const zero = svg("text", { class: "tick", x: pad.left - 5, y: base + 3, "text-anchor": "end" });
  zero.textContent = "0";
  chart.append(zero);
}

// Stack bottom → top; 2px surface gap between segments; only the top one gets rounded corners.
function stackColumn(bucket, barX, { base, barW, y }) {
  const GAP = 2;
  const col = svg("g", { class: "col" });
  const segs = SERIES.map((series) => ({ series, value: bucket[series.action] })).filter((seg) => seg.value > 0);
  let cursor = base;
  segs.forEach((seg, at) => {
    const height = Math.max(3, y(seg.value));
    const top = cursor - height;
    const drawH = height - (at > 0 ? GAP : 0);
    const isTop = at === segs.length - 1;
    col.append(
      isTop
        ? svg("path", { class: seg.series.cls, d: colPath(barX, top, barW, drawH, 4) })
        : svg("rect", { class: seg.series.cls, x: barX, y: top, width: barW, height: drawH }),
    );
    cursor = top;
  });
  return col;
}

// Sparse x labels (last one always), anchored to the right edge for "today".
function drawDayLabel(bucket, at, bandX, layout) {
  const { chart, height, band, buckets, fmtDay, labelEvery } = layout;
  const isLast = at === buckets.length - 1;
  if (at % labelEvery !== 0 && !isLast) return;
  if (rangeDays > 7 && !isLast && buckets.length - 1 - at < labelEvery / 2) return;
  const tx = svg("text", { class: "tick", x: bandX + band / 2, y: height - 4, "text-anchor": "middle" });
  tx.textContent = isLast ? msg("pp_today", "Today") : fmtDay.format(bucket.date);
  chart.append(tx);
}

// The tooltip for one day, beside its column.
function showDayTooltip(bucket, col, bandX, layout) {
  const { chart, tooltip, width, band, barW, fmtFull } = layout;
  chart.classList.add("hovering");
  col.classList.add("active");
  tooltip.replaceChildren(
    el("div", { className: "tt-date", textContent: fmtFull.format(bucket.date) }),
    ...SERIES.map((series) =>
      el("div", { className: "tt-row" }, [
        el("i", { className: "key", style: { background: series.color } }),
        el("b", { textContent: String(bucket[series.action]) }),
        series.label,
      ]),
    ),
    el("div", { className: "tt-total", textContent: msg("pp_nFound", "$1 found", bucketTotal(bucket)) }),
  );
  tooltip.hidden = false;
  // Place beside the column, flipping sides past the midpoint so it never covers the hovered bar.
  const centerX = bandX + band / 2;
  const tooltipWidth = tooltip.offsetWidth;
  const left = centerX < width / 2 ? centerX + barW / 2 + 8 : centerX - barW / 2 - 8 - tooltipWidth;
  tooltip.style.left = `${Math.max(0, Math.min(width - tooltipWidth, left))}px`;
  tooltip.style.top = "0px";
}

// Hit target = the whole day band (bigger than the bar), keyboard focusable.
function dayHitTarget(bucket, col, bandX, layout) {
  const { chart, tooltip, pad, plotH, band, fmtFull } = layout;
  const summary = msg(
    "pp_daySummary",
    "$1: $2 hidden, $3 sent, $4 just counted",
    fmtFull.format(bucket.date),
    bucket.redacted,
    bucket.allowed,
    bucket.suppressed,
  );
  const hit = svg("rect", {
    class: "hit",
    x: bandX,
    y: pad.top,
    width: band,
    height: plotH,
    tabindex: 0,
    role: "img",
    "aria-label": summary,
  });
  function show() {
    showDayTooltip(bucket, col, bandX, layout);
  }
  function hide() {
    chart.classList.remove("hovering");
    col.classList.remove("active");
    tooltip.hidden = true;
  }
  hit.addEventListener("pointerenter", show);
  hit.addEventListener("focus", show);
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("blur", hide);
  return hit;
}

function drawDayColumn(bucket, at, layout) {
  const { chart, pad, band, barW } = layout;
  const bandX = pad.left + at * band;
  const barX = bandX + (band - barW) / 2;
  const col = stackColumn(bucket, barX, layout);
  chart.append(col);
  drawDayLabel(bucket, at, bandX, layout);
  chart.append(dayHitTarget(bucket, col, bandX, layout));
}

function renderChart(days, events) {
  const chart = $("chart");
  const tooltip = $("tooltip");
  const width = chart.clientWidth || 352;
  const height = 132;
  const pad = { top: 8, right: 2, bottom: 18, left: 20 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const base = pad.top + plotH;

  const buckets = chartBuckets(days, events);
  const yMax = niceCeil(Math.max(1, ...buckets.map(bucketTotal)));
  const y = (value) => (value / yMax) * plotH;

  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chart.replaceChildren();
  drawChartGrid({ chart, width, pad, base, yMax, y });

  const band = plotW / buckets.length;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const fmtDay = new Intl.DateTimeFormat(
    [],
    rangeDays <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" },
  );
  const fmtFull = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
  const labelEvery = rangeDays <= 7 ? 1 : 7;
  const layout = {
    ...{ chart, tooltip, width, height, pad, plotH, base, y },
    ...{ buckets, band, barW, fmtDay, fmtFull, labelEvery },
  };

  buckets.forEach((bucket, at) => drawDayColumn(bucket, at, layout));

  chart.append(svg("line", { class: "baseline", x1: pad.left, x2: width - pad.right, y1: base, y2: base }));
}

function renderHBars(container, rows) {
  const top = rows.slice(0, 5);
  const max = Math.max(1, ...top.map(([, value]) => value));
  container.replaceChildren(
    ...top.map(([label, value]) =>
      el("div", { className: "hbar", title: `${label}: ${value}` }, [
        el("span", { className: "label", textContent: label }),
        el("span", { className: "track" }, [
          el("span", { className: "bar", style: { width: `calc((100% - 32px) * ${value / max})` } }),
          el("span", { className: "val", textContent: String(value) }),
        ]),
      ]),
    ),
  );
}

// ---------- Activity (table view) ----------

// One row: when, what (with its count in one go and repeats), and what happened to it.
function activityRow(record, { seen, today, fmtTime, fmtDate }) {
  const when = record.t >= today ? fmtTime.format(record.t) : `${fmtDate.format(record.t)} ${fmtTime.format(record.t)}`;
  const what = el("td", {}, [
    el("span", { className: `sev ${record.severity}`, textContent: msg(`sev_${record.severity}`, record.severity) }),
    PATTERN_NAMES[record.type] || record.name || record.type,
  ]);
  // The rest of a long list sent at once, as one record.
  if (weight(record) > 1) {
    what.append(
      el("span", {
        className: "more",
        textContent: msg("pp_moreInOneGo", "$1 more in one go", weight(record).toLocaleString()),
        title: msg(
          "pp_moreInOneGoWhy",
          "One record for the rest of a long list sent at once, so your history keeps its room.",
        ),
      }),
    );
  }
  if (seen[record.fp] > 1) {
    what.append(
      el("span", {
        className: "repeat",
        textContent: `×${seen[record.fp]}`,
        title: msg("pp_sameItem", "Clotr found this same item $1 times", seen[record.fp]),
      }),
    );
  }
  what.append(el("span", { className: "site-name", textContent: record.site }));
  const outcome = OUTCOME[record.action];
  const otherColor = record.action === "mentioned" ? "var(--brand)" : "var(--muted)";
  const outcomeColor = outcome?.color || otherColor;
  return el("tr", {}, [
    el("td", { className: "when", textContent: when }),
    what,
    el("td", {}, [
      el("span", { className: "outcome" }, [
        el("i", { style: { background: outcomeColor } }),
        record.action === "mentioned"
          ? msg("popup_replyMentioned", "Mentioned in AI reply")
          : outcome?.label || record.action,
      ]),
    ]),
  ]);
}

function renderActivity() {
  const seen = {};
  const events = viewEvents();
  for (const record of events) if (record.fp) seen[record.fp] = (seen[record.fp] || 0) + 1;

  const today = startOfDay(Date.now()).getTime();
  const fmtTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

  const rows = events
    .concat(viewMentions())
    .sort((first, second) => second.t - first.t)
    .slice(0, ACTIVITY_LIMIT)
    .map((record) => activityRow(record, { seen, today, fmtTime, fmtDate }));

  $("events-body").replaceChildren(...rows);
  $("events-empty").hidden = rows.length > 0;
}
