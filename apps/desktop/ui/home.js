// Clotr for Windows' Home screen: the line shield and the status, read from `view.status`, which
// status() in Rust decided (quiet, look, paused or notRunning) so there's one place that owns the state machine;
// this file only draws it. The row below the hero (Protection and This month) is Home's own too. The look state's
// own lead line (4-1, 4-4) names what's new since the weekly check and what was already waiting, from
// `view.settings.lastWeeklyFind` -- two counts, never a path, a kind or a value.
(() => {
  "use strict";
  const W = globalThis.ClotrWords;
  const $ = (id) => document.getElementById(id);

  const STATES = ["quiet", "look", "paused", "notRunning"];

  function listOf(names, lang) {
    return new Intl.ListFormat(lang === "en" ? "en-GB" : lang, { type: "conjunction" }).format(names);
  }

  // The AI apps the copy check can reach on this PC: installed, or seen in front at least once (main.rs sends
  // `covered`). The rest of the built-in list never counts, so Home never claims an app that isn't there.
  function coveredApps(view) {
    return (view.apps || []).filter((a) => a.covered !== false);
  }

  function checkedApps(view) {
    const paused = view.settings.pausedApps || {};
    return coveredApps(view).filter((a) => !paused[a.id]);
  }

  // The kicker over Home's title, as a word and its count: paused, no AI app here yet, every one switched off,
  // or how many are checked.
  function kickerWord(view, status) {
    const apps = checkedApps(view);
    if (status === "paused") return ["ws.kickerPaused"];
    if (!coveredApps(view).length) return ["ws.kickerNone"];
    if (!apps.length) return ["ws.kickerOff"];
    if (apps.length === 1) return ["ws.kickerQuietOne"];
    return ["ws.kickerQuiet", apps.length];
  }

  // The first run's one line: Clotr doesn't start with Windows until the person turns it on, said with the switch
  // right there. main.rs sends `startLine` on the first launch only. It stays hidden where the switch can't help
  // (Task Manager or a policy holds it off, or a build with no startup task), and once on it says so until the
  // next start.
  function startLineView({ startLine, startupTaskState }) {
    const on = startupTaskState === "enabled";
    const shown = startLine === true && (on || startupTaskState === "disabled");
    return { shown, on, word: on ? "ws.firstStartOn" : "ws.firstStart" };
  }

  const DOT = { quiet: "good", look: "test", paused: "test", notRunning: "test" };
  const TITLE = { quiet: "ws.quiet", look: "ws.look", paused: "ws.pausedNow", notRunning: "ws.notRunning" };
  const LEAD = {
    quiet: "settings.lead",
    look: "settings.lead",
    paused: "settings.paused",
    notRunning: "ws.notRunningLead",
  };

  // "1 new since last week, 3 still here." -- the two clauses a weekly check can have, joined only when both do.
  function weeklyFindLead(view) {
    const { new: fresh = 0, still = 0 } = view.settings.lastWeeklyFind || {};
    const clauses = [];
    if (fresh > 0) clauses.push(fresh === 1 ? W.t("ws.weeklyFindNewOne") : W.t("ws.weeklyFindNew", fresh));
    if (still > 0) clauses.push(still === 1 ? W.t("ws.weeklyFindStillOne") : W.t("ws.weeklyFindStill", still));
    return clauses.length ? `${clauses.join(", ")}.` : "";
  }

  function draw(view, lang) {
    const status = STATES.includes(view.status) ? view.status : "quiet";
    $("home-shield").dataset.status = status;

    const apps = checkedApps(view);
    const none = !coveredApps(view).length;
    $("home-kicker").textContent = W.t(...kickerWord(view, status));
    $("home-dot").className = `dot ${status === "quiet" && !apps.length ? "" : DOT[status]}`;

    $("title-home").textContent = W.t(TITLE[status]);
    const weekly = status === "look" && weeklyFindLead(view);
    $("home-lead").textContent = weekly || W.t(LEAD[status]);
    // The lead names the browser extension, so the way to get it sits right under it.
    $("home-browser").hidden = Boolean(weekly) || LEAD[status] !== "settings.lead";

    const firstRun = startLineView(view);
    $("home-start").hidden = !firstRun.shown;
    if (firstRun.shown) {
      $("home-start-label").textContent = W.t(firstRun.word);
      $("home-start-switch").setAttribute("aria-checked", String(firstRun.on));
    }

    // A safety net: a program signed by a known AI maker that matched no app (`view.unmatchedMaker`),
    // named by its own file name and the maker's name, never a path.
    const unmatched = view.unmatchedMaker;
    $("home-unmatched-maker").hidden = !unmatched;
    if (unmatched) $("home-unmatched-maker").textContent = W.t("ws.unmatchedMaker", unmatched.file, unmatched.maker);

    // The typing check's self-check: an AI app whose message box Clotr couldn't read this run, by name. Said once
    // here, never as a popup.
    const blind = view.typingBlind || [];
    $("home-typing-blind").hidden = !blind.length;
    if (blind.length) $("home-typing-blind").textContent = W.t("ws.typingBlind", listOf(blind, lang));

    $("home-resume").hidden = status !== "paused";
    $("home-run").hidden = status === "paused";
    $("home-choose").hidden = status === "paused";

    $("sum-copy-apps").textContent = apps.length
      ? listOf(
          apps.map((a) => a.name),
          lang,
        )
      : W.t(none ? "ws.kickerNone" : "ws.kickerOff");
    const state = status === "paused" ? ["test", "ws.pausedNow"] : apps.length ? ["good", "ws.on"] : ["", "ws.off"];
    $("sum-copy-dot").className = `dot ${state[0]}`;
    $("sum-copy-tag").className = `tag ${state[0]}`;
    $("sum-copy-tag").textContent = W.t(state[1]);
    // With no AI app here, the line under it already says so, and "Off" would read as something switched off.
    $("sum-copy-tag").hidden = none && status !== "paused";

    // "Check what I type in AI apps": on unless switched off, for the same apps the copy check covers.
    const typingOn = view.settings.typingCheck !== false;
    $("typing-check").setAttribute("aria-checked", String(typingOn));
    $("sum-typing-apps").textContent = $("sum-copy-apps").textContent;
    $("sum-typing-dot").className = `dot ${typingOn && apps.length && status !== "paused" ? "good" : ""}`;

    const tqWord = globalThis.ClotrTourniquet?.wordFor(view.settings) || "";
    const tqState = tqWord ? ["good", "ws.on"] : ["", "ws.off"];
    $("sum-tq-dot").className = `dot ${tqState[0]}`;
    $("sum-tq-tag").className = `tag ${tqState[0]}`;
    $("sum-tq-tag").textContent = W.t(tqState[1]);
    const TQ_SUB = { child: "ws.tqChildOpt", adult: "ws.tqAdultOpt", after_scam: "ws.tqScamOpt" };
    $("sum-tq-sub").textContent = W.t(tqWord ? TQ_SUB[tqWord] : "ws.tourniquetSub");

    // This month: what Clotr hid, what you left in, what it only counted.
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const month = (view.events || []).filter((e) => e.t >= start.getTime());
    for (const action of ["redacted", "allowed", "suppressed"]) {
      $(`month-${action}`).textContent = String(month.filter((e) => e.action === action).length);
    }
  }

  // The shield's glint (shield.css): one short pass round its edge every so often, started here one at a time so
  // nothing animates in between. Only while it's worth a frame: Home on screen, the window visible, someone using
  // it (main.js's data-idle), motion allowed, and something being watched.
  const GLINT_EVERY_MS = 14_000;
  function glintMayRun({ status, onHome, hidden, idle, still, reduced }) {
    return onHome && !hidden && !idle && !still && !reduced && (status === "quiet" || status === "look");
  }

  function glintNow() {
    const shield = $("home-shield");
    const root = document.documentElement.dataset;
    const may = glintMayRun({
      status: shield.dataset.status,
      onHome: $("screen-home").classList.contains("on"),
      hidden: root.visible === "false" || document.hidden,
      idle: root.idle === "true",
      still: root.motion === "still",
      reduced: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    });
    // A glint cut short (Home left mid-pass) never fires animationend, so a leftover class is cleared, not stacked.
    if (shield.classList.contains("glinting")) shield.classList.remove("glinting");
    else if (may) shield.classList.add("glinting");
  }

  function wireGlint() {
    const shield = $("home-shield");
    const done = () => shield.classList.remove("glinting");
    shield.addEventListener("animationend", (e) => e.animationName === "shield-glint" && done());
    shield.addEventListener("animationcancel", (e) => e.animationName === "shield-glint" && done());
    setInterval(glintNow, GLINT_EVERY_MS);
  }

  // While a scan is running, Home says so: this only reads the scan screen's own dataset.state and --p (scan.js
  // sets both already, for its own stage and progress bar) and never starts, stops or steps a scan itself.
  // `state` is scan.js's own "idle" | "running" | "stopping" | "done" | "stopped".
  function scanIsActive(state) {
    return state === "running" || state === "stopping";
  }

  // Pure, so it's checked without a page: whether the shield shows a share of the bar (scan-progress not hidden,
  // a real number) or just a calm sweep (still counting, so there's nothing to claim a share of yet).
  function scanningView({ state, progressHidden, progressFraction }) {
    const active = scanIsActive(state);
    const determinate = active && progressHidden === false && Number.isFinite(progressFraction);
    return { active, determinate, progress: determinate ? Math.max(0, Math.min(1, progressFraction)) : 0 };
  }

  const SCAN_POLL_MS = 500;
  function pollScanning() {
    const stage = $("scan-stage");
    const bar = $("scan-progress");
    const fill = $("scan-progress-fill");
    const view = scanningView({
      state: stage?.dataset.state,
      progressHidden: bar?.hidden,
      progressFraction: fill ? Number(fill.style.getPropertyValue("--p")) : NaN,
    });
    const shield = $("home-shield");
    shield.classList.toggle("scanning", view.active);
    shield.classList.toggle("determinate", view.determinate);
    if (view.determinate) shield.style.setProperty("--progress", String(view.progress));
    else shield.style.removeProperty("--progress");
    $("home-scanning").hidden = !view.active;
    $("home-scanning-text").textContent = view.active ? $("stage-title")?.textContent || "" : "";
    $("home-actions-default").hidden = view.active;
    $("home-actions-scanning").hidden = !view.active;
  }

  // Wired once: `call` and `show` come from the main window.
  function wire({ call, show, save }) {
    wireGlint();
    pollScanning();
    setInterval(pollScanning, SCAN_POLL_MS);
    $("typing-check").addEventListener("click", () =>
      save({ typingCheck: $("typing-check").getAttribute("aria-checked") !== "true" }),
    );
    $("home-resume").addEventListener("click", async () => show(await call("set_paused", { on: false })));
    $("home-extension").addEventListener("click", () => call("open_extension_page").catch(() => {}));
    $("home-start-switch").addEventListener("click", () =>
      save({ startWithWindows: $("home-start-switch").getAttribute("aria-checked") !== "true" }),
    );
    // Both land on the Scan screen by their own href; this also starts a Quick scan there.
    $("home-run").addEventListener("click", () => globalThis.ClotrScanScreen.startQuick());
    $("home-files").addEventListener("click", () => globalThis.ClotrScanScreen.startQuick());
    $("home-lookback").addEventListener("click", () => globalThis.ClotrScanScreen.startLookback());
  }

  globalThis.ClotrHome = {
    draw,
    wire,
    weeklyFindLead,
    kickerWord,
    startLineView,
    glintMayRun,
    scanIsActive,
    scanningView,
  };
})();
