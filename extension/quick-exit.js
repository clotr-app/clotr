// Quick exit (Privacy Check-up): one press closes every open Clotr page. Standalone from Keep nothing, which isn't
// built yet: this piece only closes tabs, nothing else, and never claims to clear anything it doesn't own.
// A classic script (no import/export): shares code through
// globalThis.Clotr, loaded on every standalone page (vault.html, lookback.html, training.html, practice.html,
// policy.html, helper.html, tracking.html) so each one can close itself, and on the popup, where the only
// visible button lives.
"use strict";

(function () {
  const CHANNEL_NAME = "clotr-quick-exit";

  // A page that calls this also hears its own broadcast (its listener and this function use separate
  // BroadcastChannel objects, and the "never echoes to the sender" rule is per object, not per page) and tries to
  // close itself as a tab; that's a harmless no-op on the popup, which isn't one, so popup.js closes it for real
  // with window.close() right after calling this.
  function broadcastQuickExit() {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage("exit");
      channel.close();
    } catch {
      // No BroadcastChannel here (an old browser): this page's own close (handled by the caller) still happens.
    }
  }

  async function closeThisTab() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) chrome.tabs.remove(tab.id);
    } catch {
      // No tab to close (e.g. this page isn't in one): nothing to do.
    }
  }

  let listener = null;

  function listenForQuickExit() {
    try {
      listener = new BroadcastChannel(CHANNEL_NAME);
      listener.onmessage = () => closeThisTab();
    } catch {
      // Nothing to listen with: this page just won't self-close on someone else's Quick exit.
    }
  }

  // Not used by a real page (it listens for as long as it's open); a test's way to let the process exit.
  function stopListeningForQuickExit() {
    listener?.close();
    listener = null;
  }

  globalThis.Clotr = globalThis.Clotr || {};
  globalThis.Clotr.broadcastQuickExit = broadcastQuickExit;
  globalThis.Clotr.closeThisTab = closeThisTab;
  globalThis.Clotr.stopListeningForQuickExit = stopListeningForQuickExit;

  listenForQuickExit(); // every page loading this script closes itself on someone else's Quick exit
})();
