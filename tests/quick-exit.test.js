// Quick exit (Privacy Check-up): one press closes every open Clotr page. Standalone from Keep nothing (out of
// scope here): it closes tabs, nothing more, and never claims to clear memory it doesn't own.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function unload() {
  globalThis.Clotr?.stopListeningForQuickExit?.();
  delete require.cache[require.resolve("../extension/quick-exit.js")];
  delete globalThis.Clotr;
  delete globalThis.chrome;
}

test("Quick exit: another page's broadcast closes this page's own tab", async () => {
  unload();
  const closed = [];
  globalThis.chrome = {
    tabs: {
      getCurrent: async () => ({ id: 11 }),
      remove: (id) => closed.push(id),
    },
  };
  require("../extension/quick-exit.js"); // loading the script on a page wires its own listener

  const other = new BroadcastChannel("clotr-quick-exit");
  other.postMessage("exit");
  // The message crosses channels on another tick; on a busy machine that can take far longer than a few ms.
  for (const end = Date.now() + 2000; !closed.length && Date.now() < end;)
    await new Promise((resolve) => setTimeout(resolve, 10));
  other.close();

  assert.deepEqual(closed, [11], "the page should close its own tab on someone else's Quick exit");
  unload();
});

test("Quick exit: closing a tab that isn't one (the popup) is a harmless no-op", async () => {
  unload();
  const closed = [];
  globalThis.chrome = {
    tabs: {
      getCurrent: async () => undefined, // a popup has no current tab
      remove: (id) => closed.push(id),
    },
  };
  require("../extension/quick-exit.js");
  await globalThis.Clotr.closeThisTab();

  assert.deepEqual(closed, [], "nothing to remove when this page isn't a tab");
  unload();
});

test("Quick exit: no BroadcastChannel (an old browser) never throws", async () => {
  unload();
  const real = globalThis.BroadcastChannel;
  delete globalThis.BroadcastChannel;
  globalThis.chrome = { tabs: { getCurrent: async () => null, remove: () => {} } };
  assert.doesNotThrow(() => require("../extension/quick-exit.js"));
  assert.doesNotThrow(() => globalThis.Clotr.broadcastQuickExit());
  globalThis.BroadcastChannel = real;
  unload();
});
