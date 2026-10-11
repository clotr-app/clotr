// E2E checks: CL. Clean link: a message that's only a link carrying a share code or an ad network's tracking
// code gets its own wording ("Remove the share code"), a link to the explainer page, and strips just the
// tracking part when accepted. A link mixed in with something else reads as an ordinary warning instead. Run in
// order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { OUT, check, ctx, editorText, expect, fs, openExtPage, path, resetState, settle } = env;
  const { clickDialogButton, clickNode, readNotice, sleep, typeText, waitForNotice, withSite } = env;

  const AD_LINK = "check this out: https://example.com/deal?utm_source=ad&gclid=abc123xyz&ref=friend";
  const CLEANED = "check this out: https://example.com/deal?ref=friend";

  await check("CL1", "A link with an ad-tracking code shows the Clean link note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, AD_LINK);
      const note = await waitForNotice(page);
      expect(note, "no note after pasting a tracked link");
      const names = note.buttons.map((b) => b.text);
      expect(names.includes("Remove the share code"), `buttons: ${JSON.stringify(names)}`);
      expect(!names.includes("Cover it"), `link-only note still said "Cover it": ${JSON.stringify(names)}`);
    }),
  );

  await check("CL2", "Remove the share code strips just the tracking part, keeping the rest of the link", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, AD_LINK);
      await waitForNotice(page);
      await clickDialogButton(page, "Remove the share code", readNotice);
      const after = await editorText(page);
      expect(after === CLEANED, `after removing the code: "${after}"`);
    }),
  );

  await check("CL3", "Why? offers “How ads follow you”, which opens the explainer page", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, AD_LINK);
      const note = await waitForNotice(page);
      const why = note.buttons.find((b) => b.text === "Why?");
      expect(why, `no "Why?": ${JSON.stringify(note.buttons.map((b) => b.text))}`);
      await clickNode(page, why.nodeId);
      await settle(200);
      const opened = await readNotice(page);
      expect(/How ads follow you/.test(opened.text), `why panel: ${opened.text}`);
      // Opening the page goes through the background script (not a direct href, since this content script
      // runs on the chat page, not on Clotr's own), so a click that lands mid-redraw gets one more try.
      let target = null;
      for (let tries = 0; tries < 2 && !target; tries++) {
        await sleep(500);
        const fresh = (await readNotice(page))?.buttons.find((b) => b.text === "How ads follow you");
        expect(fresh, "the explainer link went away");
        const found = ctx.browser
          .waitForTarget((t) => t.url().endsWith("/tracking.html"), { timeout: 8000 })
          .catch(() => null);
        await page.bringToFront();
        await clickNode(page, fresh.nodeId);
        target = await found;
      }
      expect(target, "How ads follow you didn't open the explainer page");
      const tab = await target.page();
      await tab.close();
    }),
  );

  await check("CL4", "A link alongside an ordinary detail reads as the usual warning, not Clean link's", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, `${AD_LINK}\nmy email is bob@example.com`);
      const note = await waitForNotice(page);
      const names = note.buttons.map((b) => b.text);
      expect(names.includes("Cover it"), `mixed note: ${JSON.stringify(names)}`);
      expect(!names.includes("Remove the share code"), `mixed note kept link-only wording: ${note.text}`);
    }),
  );

  await check("CL5", "A link with nothing trackable in it is left alone", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "see https://example.com/page?a=1&b=2 for details");
      await settle(1200);
      const note = await readNotice(page);
      expect(!note, `a note appeared for a link with nothing to clean: ${note?.text}`);
    }),
  );

  await check(
    "CL6",
    "The explainer page loads on its own, with no serious accessibility problems in either theme",
    async () => {
      const page = await openExtPage(ctx, "tracking.html");
      try {
        const title = await page.evaluate(() => document.querySelector("h1")?.textContent.trim());
        expect(title === "How ads follow you", `heading: "${title}"`);
        const sections = await page.evaluate(() => document.querySelectorAll("section").length);
        expect(
          sections === 5,
          `expected 5 sections (looking it up, the ad network, what Clotr stops, what it can't, on your phone), got ${sections}`,
        );
        const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
        const problems = [];
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map(
                (v) =>
                  `${v.id} (${v.nodes.length}): ${v.nodes
                    .slice(0, 2)
                    .map((n) => n.target.join(" "))
                    .join(", ")}`,
              ),
          );
          problems.push(...found.map((f) => `${theme}: ${f}`));
        }
        expect(!problems.length, problems.join(" | "));
      } finally {
        await page.close();
      }
    },
  );

  await check("CL7", "Screenshots of the Clean link note and the explainer page", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, AD_LINK);
      expect(await waitForNotice(page), "no note to screenshot");
      await page.screenshot({ path: path.join(OUT, "cl-clean-link-note.png") });
      const tracking = await openExtPage(ctx, "tracking.html");
      try {
        await tracking.screenshot({ path: path.join(OUT, "cl-tracking-page.png"), fullPage: true });
      } finally {
        await tracking.close();
      }
      return "cl-clean-link-note.png, cl-tracking-page.png";
    }),
  );
};
