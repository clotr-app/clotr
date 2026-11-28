// The extension's files that load in a fixed order, outside the engine. Paths start at extension/.
// The manifest and the Firefox and Safari worker list can't run code to read this, so `npm run engine-files` and
// tools/package.js write them from it. The worker reads it with importScripts.
globalThis.ClotrExtensionFiles = {
  sitesAndPolicy: [
    "sites-and-policy/protected-sites.js",
    "sites-and-policy/ai-site-spotting.js",
    "sites-and-policy/tourniquet-rules.js",
    "sites-and-policy/team-policy.js",
  ],
  worker: ["sites-and-policy/helping-someone.js", "backup.js"],
  chatPage: [
    "on-websites/attached-files.js",
    "on-websites/attached-pictures.js",
    "commands.js",
    "on-websites/warning-styles.js",
    "on-websites/chat-box.js",
    "on-websites/warning-ui.js",
    "on-websites/content.js",
  ],
  // The popup's own scripts, in the order popup/popup.html loads them.
  popup: [
    "popup/popup-state.js",
    "popup/popup-this-site.js",
    "popup/popup-overview.js",
    "popup/popup-settings.js",
    "popup/popup-tourniquet.js",
    "popup/popup.js",
  ],
  // The worker's own parts, in order. background.js loads them last, after everything above.
  background: [
    "background/worker-storage.js",
    "background/settings-for-sites.js",
    "background/history-log.js",
    "background/toolbar-icon.js",
    "background/start-on-sites.js",
    "background/install-and-update.js",
    "background/vault-and-learning.js",
    "background/worker-messages.js",
  ],
};
