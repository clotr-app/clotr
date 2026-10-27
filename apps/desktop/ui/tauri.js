// The one way Clotr's pages talk to Clotr for Windows: Tauri's commands (each window may call only its own, see
// src-tauri/capabilities/) and its events. Nothing here goes online: commands and events stay inside the app.
(() => {
  "use strict";
  const T = window.__TAURI__;
  let slowWaySaid = false;
  globalThis.ClotrApp = {
    call: (command, args = {}) => T.core.invoke(command, args),
    // A command that hands back a file's raw bytes (scan_next). Tauri sends those as an ArrayBuffer over its own
    // IPC protocol, which the CSP lets in (connect-src ipc: http://ipc.localhost) and nothing else. If that
    // protocol ever fails, Tauri falls back to postMessage, where the bytes arrive as a script holding a plain
    // array of numbers: about four times the file in text, for the web view to build and run per file, and an
    // array a worker's transfer list refuses (DataCloneError). Either way, this hands back an ArrayBuffer.
    bytes: async (command, args = {}) => {
      const got = await T.core.invoke(command, args);
      if (got instanceof ArrayBuffer) return got;
      // A typed array may be a window on a bigger buffer, so copy just its own bytes.
      if (ArrayBuffer.isView(got)) return got.buffer.slice(got.byteOffset, got.byteOffset + got.byteLength);
      if (!slowWaySaid) {
        slowWaySaid = true;
        console.warn("[Clotr]", "file bytes are coming the slow way: Tauri's IPC protocol isn't reachable");
      }
      return Uint8Array.from(got ?? []).buffer;
    },
    on: (event, fn) => T.event.listen(event, (e) => fn(e.payload)),
  };
  // A page of Clotr's own, not a browser: no right-click menu.
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // Rust's own "visible" event (main.rs): false the moment this window is minimized or hidden, so theme.css can
  // stop every animation rather than let it run, unseen, for as long as the window stays that way.
  globalThis.ClotrApp.on("visible", (visible) => {
    if (visible) {
      document.documentElement.removeAttribute("data-visible");
    } else {
      document.documentElement.setAttribute("data-visible", "false");
    }
  });
})();
