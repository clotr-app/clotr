// E2E checks: D. Scope & discovery. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { KEY, check, clotrActive, ctx, expect, expectNoDialog, openPopup, settle, store, typeText, withSite } = env;
  await check("D1", "Unknown AI tool: Clotr does NOT run until the user adds it", () =>
    withSite(ctx, "newtool", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a site nobody added");
      await typeText(page, KEY);
      await expectNoDialog(page, "site not added");
    }),
  );

  await check("D2", "Page check recognizes AI chats and ignores ordinary sites", async () => {
    const popup = await openPopup(ctx);
    const src = await popup.evaluate(() => globalThis.ClotrSites.inspectPageForAIChat.toString());
    await popup.close();
    const verdicts = {};
    for (const key of ["newtool", "chatgpt", "ordinary", "shapeOnly"]) {
      verdicts[key] = await withSite(ctx, key, (page) => page.evaluate(`(${src})()`));
    }
    expect(verdicts.newtool.looksLikeAI, `new AI tool not recognized: ${JSON.stringify(verdicts.newtool)}`);
    expect(verdicts.chatgpt.looksLikeAI, `ChatGPT page not recognized: ${JSON.stringify(verdicts.chatgpt)}`);
    expect(!verdicts.ordinary.looksLikeAI, `ordinary site flagged: ${JSON.stringify(verdicts.ordinary)}`);
    return `new tool found: ${verdicts.newtool.signals.join(", ")}`;
  });

  await check(
    "D2b",
    "Page check: a chat-shaped box with no AI wording at all still offers the once-only check",
    async () => {
      const popup = await openPopup(ctx);
      const src = await popup.evaluate(() => globalThis.ClotrSites.inspectPageForAIChat.toString());
      await popup.close();
      const verdict = await withSite(ctx, "shapeOnly", (page) => page.evaluate(`(${src})()`));
      expect(verdict.looksLikeAI, `shape alone wasn't enough: ${JSON.stringify(verdict)}`);
      expect(verdict.signals.includes("a chat-shaped box"), `no shape signal: ${JSON.stringify(verdict)}`);
      expect(
        !verdict.signals.some((s) => s.startsWith("AI wording")),
        `the fixture leaked AI wording, so this isn't testing shape alone: ${JSON.stringify(verdict)}`,
      );
    },
  );

  await check("D6", "Ordinary website: Clotr stays completely off", () =>
    withSite(ctx, "ordinary", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a non-AI site");
      await typeText(page, KEY);
      await expectNoDialog(page, "non-AI site");
    }),
  );

  // Hugging Face's chat is built in, so the browser holds the whole of huggingface.co as a required grant and
  // refuses to remove it. Removing the last section someone protected there must still take it off the list.
  await check(
    "D7",
    "Settings: removing the last section protected on huggingface.co takes it off the list",
    async () => {
      const hf = "https://huggingface.co/*";
      const { siteScopes: before } = await store.get(ctx, "siteScopes");
      await store.set(ctx, { siteScopes: { ...before, [hf]: ["https://huggingface.co/spaces/owner/app/*"] } });
      const popup = await openPopup(ctx);
      try {
        await popup.evaluate(() => {
          window.__rejections = [];
          window.__removes = [];
          window.addEventListener("unhandledrejection", (e) => window.__rejections.push(String(e.reason?.message)));
          const realRemove = chrome.permissions.remove.bind(chrome.permissions);
          chrome.permissions.remove = (p) => {
            const call = { origins: p.origins, refused: false };
            window.__removes.push(call);
            return realRemove(p).catch((err) => {
              call.refused = true;
              throw err;
            });
          };
        });
        await popup.click("#tab-settings");
        const listed = () =>
          popup.evaluate(() => [...document.querySelectorAll("#user-sites li")].map((li) => li.textContent));
        const shown = await listed();
        expect(
          shown.some((t) => t.includes("huggingface.co/spaces/owner/app")),
          `the section wasn't listed to begin with: ${JSON.stringify(shown)}`,
        );
        await popup.evaluate(() =>
          [...document.querySelectorAll("#user-sites li")]
            .find((li) => li.textContent.includes("huggingface.co/spaces/owner/app"))
            .querySelector("button")
            .click(),
        );
        await settle(500);
        const after = await listed();
        const seen = await popup.evaluate(() => ({ rejections: window.__rejections, removes: window.__removes }));
        expect(
          seen.removes.some((r) => r.origins.join() === hf && r.refused),
          `the browser didn't refuse the built-in host, so this isn't testing that: ${JSON.stringify(seen.removes)}`,
        );
        expect(!seen.rejections.length, `Remove failed: ${JSON.stringify(seen.rejections)}`);
        expect(!after.some((t) => t.includes("huggingface.co")), `still listed after Remove: ${JSON.stringify(after)}`);
        const { siteScopes = {} } = await store.get(ctx, "siteScopes");
        expect(!siteScopes[hf], `section still stored: ${JSON.stringify(siteScopes)}`);
        return `listed ${JSON.stringify(shown)}, then ${JSON.stringify(after)}`;
      } finally {
        await popup.close();
        await store.set(ctx, { siteScopes: before ?? {} });
      }
    },
  );
};
