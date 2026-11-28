// Clotr for Windows -- the scan's time-left estimate. It waits for the count, then works out the pace from how the scan
// has really gone: what a megabyte costs next to a file (a folder of tiny notes and a folder of photos read at very
// different speeds, so neither files alone nor bytes alone predicts both), and how long that work has taken, with
// older seconds fading over a few minutes. Nothing shows until the guess has held steady for a while, and once it
// shows it counts down with the clock and moves toward a new guess only a little at a time, so it never jumps from
// hours to minutes and back. Shown as H:MM:SS, or MM:SS under an hour.
(function () {
  "use strict";

  const STEP_MS = 1000; // the estimate moves at most once a second
  const FADE_MS = 180000; // a second this long ago counts about a third as much as the latest one
  const WARM_MS = 15000; // the least the count must have been in, and the scan reading, before a first guess
  const STEADY = 8; // the last this many guesses...
  const STEADY_SPREAD = 0.25; // ...all within this share of their middle one, before the first is shown
  const NUDGE = 0.04; // once shown, it moves toward a new guess by at most this share a second...
  const NUDGE_MIN_S = 2; // ...or this many seconds, whichever is more
  const K_START = 4; // a megabyte costs about as much as this many files, until the scan itself says otherwise
  const K_MAX = 1000;

  function create() {
    let last = null; // { at, bytes, files } at the previous step
    let warmFrom = null; // when the count was first in
    // Faded sums over each step's own share of the work (files, megabytes, seconds), and their products for the fit.
    const sum = { ff: 0, fb: 0, bb: 0, ft: 0, bt: 0, t: 0, f: 0, b: 0 };
    const recent = [];
    let shown = null;

    // What a megabyte costs next to a file, from the fit `seconds = perFile * files + perMb * megabytes` over each
    // step's own share of the work; it only sets the mix, so a noisy fit just keeps the last good one.
    let mbInFiles = null;
    function weigh() {
      // A little ridge keeps the fit from swinging when nearly every step had the same mix of files and bytes.
      const ridge = 1e-6 * (sum.ff + sum.bb) + 1e-9;
      const det = (sum.ff + ridge) * (sum.bb + ridge) - sum.fb * sum.fb;
      const perFile = (sum.ft * (sum.bb + ridge) - sum.bt * sum.fb) / det;
      const perMb = (sum.bt * (sum.ff + ridge) - sum.ft * sum.fb) / det;
      if (det > 0 && perFile > 0 && perMb >= 0) mbInFiles = Math.min(K_MAX, perMb / perFile);
      return mbInFiles ?? K_START;
    }

    // `now` in ms; `read` and `total` as `{ bytes, files }`, and `total.counted` once the counting walk is through.
    // Returns whole seconds left, or null while the count runs or the guess is still settling.
    function update(now, read, total) {
      const counted = total.counted !== false && (total.files > 0 || total.bytes > 0);
      if (last == null) {
        last = { at: now, bytes: read.bytes, files: read.files };
        return null;
      }
      const dt = now - last.at;
      if (dt < STEP_MS) return shown;
      const df = read.files - last.files;
      const db = (read.bytes - last.bytes) / 1048576;
      const decay = Math.exp(-dt / FADE_MS);
      for (const k of Object.keys(sum)) sum[k] *= decay;
      const t = dt / 1000;
      sum.ff += df * df;
      sum.fb += df * db;
      sum.bb += db * db;
      sum.ft += df * t;
      sum.bt += db * t;
      sum.t += t;
      sum.f += df;
      sum.b += db;
      last = { at: now, bytes: read.bytes, files: read.files };

      if (!counted) return null;
      if (warmFrom == null) warmFrom = now;
      const filesLeft = Math.max(0, total.files - read.files);
      const mbLeft = Math.max(0, total.bytes - read.bytes) / 1048576;
      if (filesLeft === 0 && mbLeft === 0) {
        shown = null;
        return shown;
      }
      // The pace itself is every second so far over the work done in it, older seconds fading, so a second where
      // nothing finished (one big file) still counts and a slower stretch is caught up with in a minute or two.
      const k = weigh();
      const work = sum.f + k * sum.b;
      if (!(work > 0)) return shown;
      const guess = (sum.t / work) * (filesLeft + k * mbLeft);
      if (!(guess > 0) || !Number.isFinite(guess)) return shown;

      if (shown == null) {
        recent.push(guess);
        if (recent.length > STEADY) recent.shift();
        if (now - warmFrom < WARM_MS || recent.length < STEADY) return null;
        const mid = [...recent].sort((a, b) => a - b)[STEADY >> 1];
        if (recent.some((g) => Math.abs(g - mid) > mid * STEADY_SPREAD)) return null;
        shown = Math.round(guess);
        return shown;
      }
      // Count down with the clock, then lean toward the new guess by a bounded step.
      const ticked = Math.max(0, shown - t);
      const room = Math.max(NUDGE * ticked, NUDGE_MIN_S) * t;
      shown = Math.max(0, Math.round(ticked + Math.max(-room, Math.min(room, guess - ticked))));
      return shown;
    }

    return { update };
  }

  // 3725 -> "1:02:05", 245 -> "04:05".
  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  globalThis.ClotrEta = { create, clock };
})();
