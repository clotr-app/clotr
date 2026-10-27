// Clotr for Windows' tray flyout: the line shield and the status, in the same words Home uses
// (main.rs's status() decides it), and four actions. The window stays alive between opens (main.rs shows and
// hides it rather than rebuilding it), so a fresh status.rs reading comes with every focus, not just the first.
//
// The window is sized to the panel's own content: a ResizeObserver reports its real height (and width, which
// never really changes) to Rust, which places the window above the tray icon at that size. Without this, a guessed
// window size leaves an empty gap, or sits further from the icon than it needs to.
(() => {
  "use strict";
  const W = globalThis.ClotrWords;
  const { call } = globalThis.ClotrApp;
  const $ = (id) => document.getElementById(id);

  const TITLE = { quiet: "ws.quiet", look: "ws.look", paused: "ws.pausedNow", notRunning: "ws.notRunning" };

  // The same second line Home's kicker shows (home.js): a plain count of the AI apps on this PC, never which.
  function kickerFor(status, checked, covered) {
    if (status === "paused") return W.t("ws.kickerPaused");
    if (covered === 0) return W.t("ws.kickerNone");
    if (!checked) return W.t("ws.kickerOff");
    if (checked === 1) return W.t("ws.kickerQuietOne");
    return W.t("ws.kickerQuiet", checked);
  }

  // The same Look Settings picks for the main window (main.js's applyLook), so the flyout never looks like a
  // different app from the one it opens.
  function applyLook(look) {
    if (look === "dark" || look === "light" || look === "plum" || look === "ember") {
      document.documentElement.dataset.theme = look;
    } else delete document.documentElement.dataset.theme;
  }

  // The language comes with every reading too, so Settings' Language reaches the flyout without a restart.
  function words(locale) {
    W.use(locale);
    $("flyout-open").textContent = W.t("ws.trayOpen");
    $("flyout-scan").textContent = W.t("ws.runQuick");
    $("flyout-quit").textContent = W.t("ws.trayQuit");
  }

  function draw({ status, checked, covered, paused, typingBlind = [] }) {
    const known = Object.hasOwn(TITLE, status) ? status : "quiet";
    $("flyout-shield").dataset.status = known;
    $("flyout-title").textContent = W.t(TITLE[known]);
    $("flyout-kicker").textContent = kickerFor(known, checked, covered);
    // Home's own self-check line, when an AI app's message box couldn't be read: the one place it names apps.
    $("flyout-typing-blind").hidden = !typingBlind.length;
    if (typingBlind.length) {
      const names = new Intl.ListFormat(document.documentElement.lang, { type: "conjunction" }).format(typingBlind);
      $("flyout-typing-blind").textContent = W.t("ws.typingBlind", names);
    }
    // The same button says "Resume now" once paused, so it always undoes what it just did.
    $("flyout-pause").textContent = W.t(paused ? "ws.trayResume" : "ws.trayPause");
    // A fresh, real reading of the state: any confirmation showing (and its auto-close) steps aside for it.
    clearTimeout(closeTimer);
    $("flyout-actions").hidden = false;
  }

  async function refresh() {
    try {
      const hello = await call("flyout_hello");
      words(hello.locale);
      applyLook(hello.look);
      draw(hello);
    } catch {
      console.warn("[Clotr]", "the flyout couldn't refresh");
    }
  }

  function wire(id, command) {
    $(id).addEventListener("click", () => call(command).catch(() => {}));
  }

  // A brief confirmation in the flyout itself (never a new window, never taking focus) -- the
  // actions step aside for a moment, the title and kicker say what just happened, then it closes by itself.
  let closeTimer = null;
  function confirmPause({ paused, pausedUntil }) {
    $("flyout-shield").dataset.status = paused ? "paused" : "quiet";
    $("flyout-title").textContent = W.t(paused ? "ws.pausedNow" : "ws.quiet");
    $("flyout-kicker").textContent = paused
      ? W.t(pausedUntil ? "ws.pausedHourConfirm" : "ws.pausedConfirm")
      : W.t("ws.resumedConfirm");
    $("flyout-actions").hidden = true;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => call("close_flyout").catch(() => {}), 3000);
  }

  async function onPause() {
    try {
      confirmPause(await call("flyout_pause"));
    } catch {
      call("close_flyout").catch(() => {});
    }
  }

  // Tells Rust the panel's real size, so the window is sized and placed from it rather than a guess. Fires
  // once as soon as the observer starts, and again whenever the content's height changes (a longer status line).
  let watching = null;
  function fit() {
    const r = $("flyout-panel").getBoundingClientRect();
    call("flyout_fit", { width: Math.ceil(r.width), height: Math.ceil(r.height) }).catch(() => {});
  }
  function watchSize() {
    if (watching) return;
    watching = new ResizeObserver(fit);
    watching.observe($("flyout-panel"));
  }

  async function start() {
    const hello = await call("flyout_hello");
    words(hello.locale);
    applyLook(hello.look);
    draw(hello);
    wire("flyout-open", "flyout_open");
    wire("flyout-scan", "flyout_scan");
    $("flyout-pause").addEventListener("click", onPause);
    wire("flyout-quit", "flyout_quit");
    watchSize();
    // The window itself keeps focus until a click elsewhere hides it (main.rs); Esc does the same from in here.
    window.addEventListener("focus", refresh);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") call("close_flyout").catch(() => {});
    });
  }

  start().catch(() => console.warn("[Clotr]", "the flyout couldn't start"));
})();
