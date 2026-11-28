// E2E checks: the ten-second backstop in detector.js sets `truncated` when it cuts a check short. These checks
// force that flag without a real ten-second paste, by replacing Clotr's own detect() with one that calls through
// to the real thing and then marks the result, the same way 07-responses.js stands in for a slow file reader.
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    MRN_FILE,
    attachMrn,
    attachText,
    auditShadow,
    check,
    clickDialogButton,
    ctx,
    dropDir,
    evalInClotr,
    expect,
    fs,
    holdDir,
    path,
    pressEnter,
    readDialog,
    readNotice,
    readStarted,
    resetState,
    sentMessages,
    sleep,
    stubReader,
    typeText,
    waitForDialog,
    waitForNotice,
    waitFor,
    withSite,
  } = env;

  // Wraps the real detect() so every call still finds what it would, but also reports a check that was cut
  // short, without actually running one long enough to hit the real backstop. With `only`, a regular
  // expression's source, just the texts it matches are cut short, so typed text can stay checked in full.
  const forceTruncated = (page, only = "") =>
    evalInClotr(
      page,
      `(() => {
        const real = globalThis.Clotr.detect;
        const only = ${JSON.stringify(only)} ? new RegExp(${JSON.stringify(only)}) : null;
        globalThis.Clotr.detect = (text) => {
          const r = real(text);
          if (!only || only.test(text)) r.truncated = true;
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
        await clickDialogButton(page, "Leave it and send");
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

  // Attached files go through the same detect(), so forceTruncated cuts their check short too. Each file
  // check uploads through the test page's own file input, the same way 07-responses.js does.
  const attachAll = async (page, dir, files) => {
    const paths = files.map(([name, text]) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      return file;
    });
    await (await page.$("#attach")).uploadFile(...paths);
  };
  const withFiles = (name, fn) => async () => {
    const dir = holdDir(name);
    try {
      await fn(dir);
    } finally {
      dropDir(dir);
    }
  };

  await check(
    "TRUNC4",
    "A file whose check was cut short with nothing found gets the part-of-it-wasn't-checked notice",
    withFiles("trunc4", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forceTruncated(page);
        await attachText(page, dir, "long-notes.txt", "meeting notes about the garden and the weather\n");
        const notice = await waitFor(() => readNotice(page), 3000);
        expect(notice, `no notice for a cut-short file with nothing found. LOGS: ${page.logs.slice(-4).join(" || ")}`);
        expect(notice.text.includes(LINE), `notice didn't say so: ${notice.text}`);
        await clickDialogButton(page, "OK", readNotice);
        expect(!(await readNotice(page)), "the notice didn't dismiss");
      }),
    ),
  );

  await check(
    "TRUNC5",
    "A file whose check was cut short after something was found: the warning still says part wasn't checked",
    withFiles("trunc5", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forceTruncated(page);
        await attachText(page, dir, "contacts.txt", "call me at 555-555-5636\n");
        const notice = await waitForNotice(page);
        expect(notice, "no warning for the file");
        expect(/contacts\.txt/.test(notice.text), `warning didn't name the file: ${notice.text}`);
        expect(notice.text.includes(LINE), `warning didn't say part wasn't checked: ${notice.text}`);
      }),
    ),
  );

  await check(
    "TRUNC6",
    "A file checked all the way through with nothing found gets no notice",
    withFiles("trunc6", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await attachText(page, dir, "short-notes.txt", "meeting notes about the garden and the weather\n");
        await sleep(1500);
        const notice = await readNotice(page);
        expect(!notice, `a fully checked file got a notice: ${notice?.text}`);
      }),
    ),
  );

  await check(
    "TRUNC7",
    "Several cut-short files attached together with nothing found give one notice, not one each",
    withFiles("trunc7", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forceTruncated(page);
        const plain = "a long list of plants for the spring garden\n";
        await attachAll(page, dir, [
          ["plants-a.txt", plain],
          ["plants-b.txt", plain],
          ["plants-c.txt", plain],
        ]);
        const notice = await waitFor(() => readNotice(page), 3000);
        expect(notice, "no notice for cut-short files with nothing found");
        expect(notice.text.includes(LINE), `notice didn't say so: ${notice.text}`);
        await clickDialogButton(page, "OK", readNotice);
        await sleep(1000);
        const again = await readNotice(page);
        expect(!again, `a second notice followed the first: ${again?.text}`);
      }),
    ),
  );

  // The files below are cut short and the typed text isn't, so only a file can bring up the notice.
  const NOTES = "meeting notes about the garden and the weather\n";
  const FILES_ONLY = "garden|MRN";

  await check(
    "TRUNC8",
    "A cut-short file held for Ask before sending gets no cut-short notice, and its question comes at send",
    withFiles("trunc8", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        await forceTruncated(page, FILES_ONLY);
        await attachMrn(page, dir);
        await sleep(1500);
        const early = await readNotice(page);
        expect(!early, `a held file got a notice at attach: ${early?.text}`);
        await typeText(page, "hello");
        await sleep(600);
        await pressEnter(page);
        expect(await waitForDialog(page), "no question for the held file at send");
        const dialog = await readDialog(page);
        expect(dialog.text.includes(MRN_FILE), `the question didn't name the file: ${dialog.text}`);
        const behind = await readNotice(page);
        expect(!behind?.text.includes(LINE), `the cut-short notice sat behind the question: ${behind?.text}`);
        expect(!(await sentMessages(page)).length, "the message went before the question was answered");
      }),
    ),
  );

  await check(
    "TRUNC9",
    "Sent while a cut-short file is read: the notice shows once Clotr's own checking note closes",
    withFiles("trunc9", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        await stubReader(page, "slow", 1500);
        await forceTruncated(page, FILES_ONLY);
        await typeText(page, "what do these notes mean?");
        await sleep(600);
        await attachText(page, dir, "long-notes.txt", NOTES);
        await readStarted(page);
        await pressEnter(page);
        const notice = await waitFor(async () => {
          const n = await readNotice(page);
          return n?.text.includes(LINE) ? n : null;
        }, 4000);
        expect(notice, `no cut-short notice after the checking note closed. LOGS: ${page.logs.slice(-4).join(" || ")}`);
        expect((await sentMessages(page)).length === 1, "the message didn't go once the file was read");
      }),
    ),
  );

  await check(
    "TRUNC10",
    "A cut-short file attached while a typed-text warning is open leaves that warning in place",
    withFiles("trunc10", (dir) =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forceTruncated(page, FILES_ONLY);
        await typeText(page, "call me at 555-555-5636");
        const warning = await waitForNotice(page);
        expect(warning, "no warning for the typed phone number");
        await attachText(page, dir, "long-notes.txt", NOTES);
        await sleep(1500);
        const after = await readNotice(page);
        expect(after, "the typed-text warning went away");
        expect(!after.text.includes(LINE), `the cut-short notice replaced the warning: ${after.text}`);
        expect(after.text === warning.text, `the warning changed: ${after.text}`);
      }),
    ),
  );
};
