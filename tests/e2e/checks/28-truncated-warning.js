// E2E checks: the ten-second backstop in detector.js sets `truncated` when it cuts a check short. These checks
// force that flag without a real ten-second paste, by replacing Clotr's own detect() with one that calls through
// to the real thing and then marks the result, the same way 07-responses.js stands in for a slow file reader.
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    auditShadow,
    check,
    clickDialogButton,
    ctx,
    evalInClotr,
    expect,
    pressEnter,
    readDialog,
    readNotice,
    resetState,
    sleep,
    typeText,
    waitForDialog,
    waitForNotice,
    waitFor,
    withSite,
  } = env;

  // Wraps the real detect() so every call still finds what it would, but also reports a check that was cut
  // short, without actually running one long enough to hit the real backstop.
  const forceTruncated = (page) =>
    evalInClotr(
      page,
      `(() => {
        const real = globalThis.Clotr.detect;
        globalThis.Clotr.detect = (text) => {
          const r = real(text);
          r.truncated = true;
          return r;
        };
        return true;
      })()`,
    );

  const auditBoth = async (page, tag) => {
    const problems = [];
    for (const theme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(150);
      const found = await auditShadow(page, tag);
      if (found) problems.push(...found.map((f) => `${theme}: ${f}`));
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    return problems;
  };

  const LINE = "too long to check all the way through";

  await check("TRUNC1", "A cut-short check adds its one-line notice to the corner warning, light and dark", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await forceTruncated(page);
      await typeText(page, "call me at 555-555-5636");
      expect(await waitForNotice(page), "no notice");
      const notice = await readNotice(page);
      expect(notice.text.includes(LINE), `notice didn't say so: ${notice.text}`);
      const problems = await auditBoth(page, "CLOTR-NOTICE");
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    }),
  );

  await check(
    "TRUNC2",
    "A cut-short check adds its one-line notice to the ask-before-sending dialog too, light and dark",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { aws_access_key: "block" });
        await forceTruncated(page);
        await typeText(page, `key ${KEY}`);
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog");
        const dialog = await readDialog(page);
        expect(dialog.text.includes(LINE), `dialog didn't say so: ${dialog.text}`);
        const problems = await auditBoth(page, "CLOTR-GUARD");
        expect(!problems.length, problems.slice(0, 8).join(" | "));
        await clickDialogButton(page, "Leave it in and send");
      }),
  );

  await check(
    "TRUNC3",
    "Nothing found, but the check was cut short: a small notice says so on its own, and it can be dismissed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forceTruncated(page);
        await typeText(page, "just asking about the weather today");
        const notice = await waitFor(() => readNotice(page), 2500);
        expect(notice, "no standalone notice for a cut-short check with nothing found");
        expect(notice.text.includes(LINE), `notice didn't say so: ${notice.text}`);
        const problems = await auditBoth(page, "CLOTR-NOTICE");
        expect(!problems.length, problems.slice(0, 8).join(" | "));
        await clickDialogButton(page, "OK", readNotice);
        expect(!(await readNotice(page)), "the notice didn't dismiss");
        // Typing more of the same message doesn't reopen it: once per message is enough.
        await typeText(page, " and tomorrow's too");
        await sleep(600);
        expect(!(await readNotice(page)), "the notice came back on its own while still writing the same message");
      }),
  );
};
