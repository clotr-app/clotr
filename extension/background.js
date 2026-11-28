/* global Clotr */
// The background service worker. It's the only place that writes the event log and the fingerprint salt, so
// two AI tabs writing at once can't clobber each other, and it only ever stores metadata, never a detected
// value. It also owns the toolbar icon and badge, and registers Clotr on AI sites the user adds themselves.
/* exported Clotr */
"use strict";

// ---------- Loading the other scripts ----------

// Chrome loads these with importScripts. Firefox and Safari list them before this file in the manifest
// instead (tools/package.js --firefox, --safari). The engine's own files come from its list, which sites-and-policy/protected-sites.js
// reads too, and the rest from the extension's list.
if (typeof importScripts === "function" && !globalThis.ClotrEngineFiles) {
  importScripts("engine/files.js");
}
if (typeof importScripts === "function" && !globalThis.ClotrExtensionFiles) {
  importScripts("extension-files.js");
}
if (typeof importScripts === "function" && !globalThis.ClotrSites) {
  importScripts(...globalThis.ClotrExtensionFiles.sitesAndPolicy);
}
if (typeof importScripts === "function" && !globalThis.Clotr?.fingerprint) {
  importScripts(...globalThis.ClotrEngineFiles.rules, ...globalThis.ClotrEngineFiles.detect);
}
if (typeof importScripts === "function" && !globalThis.Clotr?.cleanVaultEntry) {
  importScripts(...globalThis.ClotrEngineFiles.decide);
}
if (typeof importScripts === "function" && !globalThis.Clotr?.Helper) {
  importScripts(...globalThis.ClotrExtensionFiles.worker);
}
if (
  chrome.runtime.getManifest().clotr_features?.oneclotr &&
  typeof importScripts === "function" &&
  !globalThis.Clotr?.OneClotrProtocol
) {
  importScripts("one-clotr/one-clotr-protocol.js", "one-clotr/one-clotr-bridge.js");
}
// The worker's own parts, last. They share their names the way one file does. The names several parts read
// are set at the top of the first part, background/worker-storage.js, since Firefox and Safari load the
// parts before this file.
if (typeof importScripts === "function") {
  importScripts(...globalThis.ClotrExtensionFiles.background);
}
