// E2E checks: FG. Look back, Extension check and Office training stay held back in this build. None of them gets
// a door anywhere — no button, link, row, section or line leads to one — even though their code and pages still
// exist. A later release turns one on by flipping its flag in manifest.json's clotr_features. The opposite case,
// checking that each feature's door does show up once its flag is on, lives in 27-training.js, 31-look-back.js and
// 32-extension-check.js (npm run test:e2e:all-on); Tourniquet, Command check, "Is this a scam?" and Practice are
// already on in this build, and their own doors are checked by 21-tourniquet.js, 23-command-check.js,
// 24-scam-check.js, 25-practice.js and 26-scam-shield.js.
"use strict";

module.exports = async function (env) {
  const { check, ctx, expect, openExtPage, openPopup, resetState, sleep } = env;

  async function openPage(c, file) {
    const page = await openExtPage(c, file);
    await page.bringToFront();
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]));
    return page;
  }

  // Every element a held-back feature's door lives in or behind. Hidden means gone: no size, nothing clickable.
  const hidden = (page, selectors) =>
    page.evaluate(
      (ids) =>
        ids.map((id) => {
          const el = document.getElementById(id);
          return [id, !el || el.getClientRects().length === 0];
        }),
      selectors,
    );

  await check("FG1", "Popup: no door to Look back or Extension check", async () => {
    await resetState(ctx, {});
    const popup = await openPopup(ctx);
    try {
      const found = await hidden(popup, ["lb-card", "lb-settings", "lb-card-ec-row", "lb-settings-ec-row"]);
      for (const [id, isHidden] of found) expect(isHidden, `#${id} shows in the popup`);
    } finally {
      await popup.close();
    }
  });

  await check("FG2", "The welcome page: no Look back line", async () => {
    const page = await openPage(ctx, "vault.html?welcome=1");
    try {
      await sleep(300);
      const found = await hidden(page, ["lb-offer"]);
      for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the welcome page`);
    } finally {
      await page.close();
    }
  });

  await check("FG3", "The setup page's last step: no door to Office training or Extension check", async () => {
    const after = await openPage(ctx, "helper.html?for=after_scam");
    try {
      await sleep(300);
      const found = await hidden(after, ["open-training", "ext-check-line"]);
      for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the setup page`);
    } finally {
      await after.close();
    }
  });

  await check("FG4", "The office training walkthrough never opens itself for a team policy, held back", async () => {
    await ctx.worker.evaluate(() => {
      globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
      chrome.storage.managed.get = async () => ({ requiredResponses: { phone_number: "block" } });
    });
    try {
      await resetState(ctx);
      await ctx.worker.evaluate(() => chrome.storage.local.remove("trainingOffered"));
      const before = (await ctx.browser.pages()).length;
      await ctx.worker.evaluate(() => offerTeamTraining());
      await sleep(500);
      expect(
        (await ctx.browser.pages()).length === before,
        "the office training walkthrough opened itself with the feature held back",
      );
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const trainingHidden = await popup.evaluate(() => {
          const el = document.getElementById("managed-training");
          return !el || el.hidden;
        });
        expect(trainingHidden, "Settings' Office training button shows with the feature held back");
      } finally {
        await popup.close();
      }
    } finally {
      await ctx.worker.evaluate(() => {
        chrome.storage.managed.get = globalThis.__realManagedGet;
        chrome.storage.local.remove("trainingOffered");
      });
      await resetState(ctx);
    }
  });
};
