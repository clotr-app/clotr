// E2E checks: screenshots of the restyled pages from the 1.2.0 look, for review rather than behaviour. Every page
// here already has its own behaviour checks elsewhere, so this just confirms each one renders and captures what it
// looks like, dark first then light, at 380px (phone and the popup's own width) and 1100px (a laptop) wherever the
// page isn't width-capped.
"use strict";

module.exports = async function (env) {
  const { ROOT, check, ctx, fs, openExtPage, openPopup, path, resetState, seedEvents, settle, store } = env;

  const dir = path.join(ROOT, "docs", "later", "extension-look");
  fs.mkdirSync(dir, { recursive: true });

  // shotAt always writes to tests/e2e/output/, but these shots are for the design doc, so I write there instead.
  const shotTo = async (page, name, { width = 380, height = 900, theme = "dark" } = {}) => {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await page.setViewport({ width, height });
    await settle(300);
    await page.screenshot({ path: path.join(dir, name), fullPage: true });
  };

  await check("BL1", "the new look: popup, overview tab, dark then light (380px — the popup's own width)", async () => {
    await resetState(ctx);
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    try {
      await shotTo(popup, "popup-overview-380-dark.png", { theme: "dark" });
      await shotTo(popup, "popup-overview-380-light.png", { theme: "light" });
    } finally {
      await popup.close();
    }
  });

  await check("BL2", "the new look: popup, settings tab, dark then light (380px)", async () => {
    const popup = await openPopup(ctx);
    try {
      await popup.click("#tab-settings");
      await popup.waitForSelector("#panel-settings");
      await settle(300);
      await shotTo(popup, "popup-settings-380-dark.png", { theme: "dark" });
      await shotTo(popup, "popup-settings-380-light.png", { theme: "light" });
    } finally {
      await popup.close();
    }
  });

  await check(
    "BL3",
    "the new look: the full report (dashboard.html), dark then light, at 380px and 1100px",
    async () => {
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await shotTo(page, "dashboard-1100-dark.png", { width: 1100, height: 1400, theme: "dark" });
        await shotTo(page, "dashboard-1100-light.png", { width: 1100, height: 1400, theme: "light" });
        await shotTo(page, "dashboard-380-dark.png", { width: 380, height: 1600, theme: "dark" });
        await shotTo(page, "dashboard-380-light.png", { width: 380, height: 1600, theme: "light" });
      } finally {
        await page.close();
      }
    },
  );

  await check("BL4", "the new look: the welcome page (vault.html), dark then light, at 380px and 1100px", async () => {
    const page = await openExtPage(ctx, "vault.html");
    try {
      await shotTo(page, "vault-1100-dark.png", { width: 1100, height: 1200, theme: "dark" });
      await shotTo(page, "vault-1100-light.png", { width: 1100, height: 1200, theme: "light" });
      await shotTo(page, "vault-380-dark.png", { width: 380, height: 1400, theme: "dark" });
      await shotTo(page, "vault-380-light.png", { width: 380, height: 1400, theme: "light" });
    } finally {
      await page.close();
    }
  });
};
