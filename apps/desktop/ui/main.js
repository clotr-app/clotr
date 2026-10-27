// Clotr for Windows' main window: six sections in a sidebar, one screen at a time. Home, Protection, History
// and Settings each draw and wire their own screen (home.js, protection.js, history.js, settings.js), sharing this
// file's `save` (the settings as they'd be after a change, through the engine's own guards, then Clotr for
// Windows' one writer, which checks it again) and `show` (the view after a round trip, redrawn everywhere). Look,
// Motion and Language take effect at once, no reload. Every node is made with createElement and textContent.
(() => {
  "use strict";
  const Host = globalThis.ClotrHost;
  const W = globalThis.ClotrWords;
  const FEATURES = globalThis.ClotrDesktopFeatures || {};
  const { call, on } = globalThis.ClotrApp;
  const $ = (id) => document.getElementById(id);

  let view = { settings: {}, events: [], scans: [], apps: [], paused: false, locale: "en" };
  let lang = "en";

  // ---------- Idle ----------
  // A window nobody's touching still asks WebView2 to composite a frame every refresh if anything on the page is
  // animating -- Home's old breathing ball once cost close to a full processor core that way, sustained. Past this
  // long with no mouse, keyboard or touch input, data-idle tells home.js to stop starting the shield's glint, the
  // only thing on Home that moves after it has drawn itself in; the next interaction (or the window coming back
  // into focus) clears it at once.
  const IDLE_MS = 30_000;
  let idleTimer = null;
  function wake() {
    delete document.documentElement.dataset.idle;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (document.documentElement.dataset.idle = "true"), IDLE_MS);
  }
  function watchIdle() {
    for (const type of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(type, wake, { passive: true });
    }
    window.addEventListener("focus", wake);
    wake();
  }

  function words() {
    for (const node of document.querySelectorAll("[data-w]")) node.textContent = W.t(node.dataset.w);
    for (const node of document.querySelectorAll("[data-w-label]")) {
      node.setAttribute("aria-label", W.t(node.dataset.wLabel));
    }
    for (const node of document.querySelectorAll("[data-w-title]")) node.title = W.t(node.dataset.wTitle);
    // The sidebar's note, as a tooltip for when the sidebar shows icons only.
    $("offline").title = `${W.t("ws.offline")}. ${W.t("ws.offlineSub")}`;
  }

  function applyFeatureGates() {
    for (const node of document.querySelectorAll("[data-desktop-feature]")) {
      node.hidden = FEATURES[node.dataset.desktopFeature] !== true;
    }
  }

  // Settings' Language, or the system's own when it's "Like Windows".
  function effectiveLocale() {
    return W.pick(view.settings.language, view.locale);
  }

  // Settings' Look and Motion, as the suite kit's CSS reads them (main.css, components.css).
  function applyLook() {
    const { look, motion } = view.settings;
    if (look === "dark" || look === "light" || look === "plum" || look === "ember") {
      document.documentElement.dataset.theme = look;
    } else delete document.documentElement.dataset.theme;
    if (motion === "still") document.documentElement.dataset.motion = "still";
    else delete document.documentElement.dataset.motion;
  }

  // ---------- The sections ----------

  const SCREENS = ["home", "scan", "results", "protection", "history", "settings", "scamcheck"];

  // Shows one section; with `focus`, its heading takes the focus (so a screen reader starts there).
  function open(name, { focus = false } = {}) {
    if (!SCREENS.includes(name)) return;
    for (const s of document.querySelectorAll(".screen")) s.classList.toggle("on", s.dataset.screen === name);
    for (const a of document.querySelectorAll(".nav a")) {
      if (a.dataset.screen === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    $("main").scrollTop = 0;
    if (focus) $(`title-${name}`).focus({ preventScroll: true });
  }

  let savedTimer = null;
  function saved(text = W.t("settings.saved")) {
    $("saved").textContent = text;
    $("saved").classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("on"), 2500);
  }

  // Settings Clotr for Windows keeps beyond the browser's own schema (Settings' General and Notifications):
  // the engine's shared clean() doesn't know them, so they're carried through by hand; store.rs checks them again,
  // field by field, before anything is written.
  const DESKTOP_KEYS = [
    "startWithWindows",
    "look",
    "motion",
    "language",
    "weeklyCheck",
    "notifyFind",
    "typingCheck",
    "scanDevFiles",
    "planTicked",
    "resultsMode",
    "helperName",
  ];

  // A PC that already has a ticked plan step or an ignore has used Results before, so it
  // starts on Detailed without ever being asked -- only a PC that's never touched Results sees the first-run
  // chooser (results.js), which recommends Guided.
  function hasUsedResultsBefore(settings) {
    return (settings.planTicked?.length || 0) > 0 || (settings.scanIgnored?.length || 0) > 0;
  }

  async function save(change) {
    const merged = { ...view.settings, ...change };
    const next = Host.clean(merged);
    for (const key of DESKTOP_KEYS) if (merged[key] !== undefined) next[key] = merged[key];
    show(await call("save_settings", { settings: next }));
    saved();
  }

  function show(next) {
    view = next;
    // A PC that's used Results before is grandfathered straight onto Detailed: once saved, Rust's own
    // reply carries resultsMode back, so this never fires a second time.
    if (view.settings.resultsMode == null && hasUsedResultsBefore(view.settings)) {
      save({ resultsMode: "detailed" });
      return;
    }
    const locale = effectiveLocale();
    // Tourniquet's floor, if it's on, applied over the person's own responses before the engine ever sees
    // them (the same order the browser's background.js uses): view.settings itself stays the person's own
    // choices, for Protection's switches to show and edit.
    const eff = globalThis.ClotrTourniquet?.effectiveSettings(view.settings) || view.settings;
    Host.init({ ...view.settings, locale, responses: eff.responses, largeText: eff.largeText });
    lang = W.use(locale);
    words();
    applyLook();
    $("prot-paused").hidden = !view.paused;
    globalThis.ClotrHome.draw(view, lang);
    globalThis.ClotrScanScreen.draw(view, lang);
    globalThis.ClotrLookback.draw(view, lang);
    globalThis.ClotrResults.draw(view, lang);
    globalThis.ClotrProtection.draw(view, save);
    globalThis.ClotrHistory.draw(view);
    globalThis.ClotrSettings.draw(view);
    globalThis.ClotrScamCheck.draw(view, lang);
  }

  // Where Rust sends this window (a fresh one's own #hash, or the "go" event once it's open): a section's name,
  // or "scan-quick" for the tray's "Run a quick scan", which lands on Scan and starts one there.
  function go(target, { focus = false } = {}) {
    if (target === "scan-quick") {
      open("scan", { focus });
      globalThis.ClotrScanScreen.startQuick();
      return;
    }
    open(SCREENS.includes(target) ? target : "home", { focus });
  }

  async function start() {
    applyFeatureGates();
    watchIdle();
    show(await call("settings_hello"));
    const first = location.hash.slice(1);
    if (first === "scan-quick") history.replaceState(null, "", "#scan"); // a reload never starts a second one
    window.addEventListener("hashchange", () => open(location.hash.slice(1), { focus: true }));
    // A section's link opens it even when it's already the one in the address.
    for (const a of document.querySelectorAll(".nav a")) {
      a.addEventListener("click", () => open(a.dataset.screen, { focus: true }));
    }
    globalThis.ClotrHome.wire({ call, show, save });
    globalThis.ClotrScanScreen.wire({ save });
    globalThis.ClotrLookback.wire();
    globalThis.ClotrResults.wire({ save });
    globalThis.ClotrProtection.wire({ save, call, show });
    globalThis.ClotrHistory.wire({ save, call, show, saved });
    globalThis.ClotrSettings.wire({ save, call, show, saved });
    globalThis.ClotrScamCheck.wire();
    go(first);
    on("settings", (settings) => show({ ...view, settings }));
    // The status (and a timed pause's time left) is Rust's to decide, so a fresh hello rather than a local patch.
    on("paused", async () => show(await call("settings_hello")));
    // A card elsewhere just recorded something: the same view settings_hello would give, so History and
    // Home's counts update at once, without reopening.
    on("history", (next) => show(next));
    if (FEATURES.oneClotr === true) {
      on("one-clotr-changed", () => globalThis.ClotrSettings.refreshOneClotr());
    }
    // The tray flyout's "Open Clotr" and "Run a quick scan", with this window already open: the same go().
    on("go", (target) => go(target, { focus: true }));
    // Rust's weekly check opens this same window hidden, with nobody to click anything: main.rs's own
    // weekly_check_done is how it hears the result back (scan.js's finish(), gated on this same flag).
    if (new URLSearchParams(location.search).get("weekly") === "1") {
      globalThis.ClotrWeeklyCheck = { active: true };
      globalThis.ClotrScanScreen.startQuick();
    }
  }

  start().catch(() => console.warn("[Clotr]", "the main window couldn't start"));
})();
