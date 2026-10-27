// E2E checks: Stress. Slow, so it only runs with --stress (npm run test:stress), before a release.
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    KEY,
    OUT,
    TYPED_VALUES,
    argv,
    check,
    clickDialogButton,
    ctx,
    docxXml,
    expect,
    measureClotrGrowth,
    fs,
    makeZip,
    openExtPage,
    openPopup,
    openSite,
    path,
    pressEnter,
    readNotice,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    withSite,
  } = env;
  if (argv.includes("--stress")) {
    await check(
      "STS1",
      "Stress: a 2 MB paste with a key buried in the middle is caught, and the page stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const filler = "The quarterly numbers look fine and nothing here is private at all. ".repeat(15000); // ~1 MB
          const text = `${filler}my key ${KEY} ${filler}`;
          await typeText(page, text);
          const notice = await waitFor(() => readNotice(page), 15000);
          expect(notice && /AWS Access Key/.test(notice.text), "the buried key wasn't caught");
          await page.evaluate(() => 1 + 1);
          return `${(text.length / 1e6).toFixed(1)} MB caught; page answered after the paste`;
        }),
    );

    await check("STS2", "Stress: 12 chat tabs hiding a key at once lose no history records", async () => {
      await resetState(ctx, {});
      const pages = [];
      for (let i = 0; i < 12; i++) pages.push(await openSite(ctx, "chatgpt"));
      try {
        await Promise.all(
          pages.map(async (page, i) => {
            await typeText(page, `tab ${i} key AKIA${String(i).padStart(4, "0")}HPQ7XZ2R6TWL`);
            const n = await waitFor(() => readNotice(page), 8000);
            expect(n, `tab ${i}: no notice`);
          }),
        );
        await Promise.all(pages.map((page) => clickDialogButton(page, "Clot this leak", readNotice)));
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 12 ? ev : null;
          }, 8000)) || (await store.events(ctx));
        expect(
          events.length === 12 && events.every((e) => e.action === "redacted"),
          `records: ${events.length} (${[...new Set(events.map((e) => e.action))]})`,
        );
      } finally {
        for (const p of pages) await p.close();
        await store.set(ctx, { events: [] });
      }
    });

    await check(
      "STS3",
      "Stress: history at its 10,000-record cap: popup and full report open, new records still append",
      async () => {
        const now = Date.now();
        const many = Array.from({ length: 10000 }, (_, i) => ({
          t: now - (10000 - i) * 60000,
          site: ["chatgpt.com", "claude.ai", "gemini.google.com"][i % 3],
          type: "email",
          name: "Email Address",
          severity: "low",
          action: ["allowed", "redacted", "suppressed"][i % 3],
          fp: (i % 4096).toString(16).padStart(16, "0"),
        }));
        await store.set(ctx, { events: many });
        try {
          const popup = await openPopup(ctx);
          await popup.waitForSelector("#hero-value");
          await popup.close();
          const dash = await openExtPage(ctx, "dashboard.html");
          await dash.waitForFunction(() => document.querySelectorAll("#map [data-service]").length > 0, {
            timeout: 10000,
          });
          await dash.close();
          await ctx.worker.evaluate(() =>
            enqueue(() =>
              appendEvents([
                {
                  t: Date.now(),
                  site: "chatgpt.com",
                  type: "email",
                  name: "Email Address",
                  severity: "low",
                  action: "allowed",
                  fp: "ffffffffffffffff",
                },
              ]),
            ),
          );
          const after = await store.events(ctx);
          expect(
            after.length === 10000 && after.at(-1).fp === "ffffffffffffffff",
            `after append: ${after.length} records, newest ${after.at(-1)?.fp}`,
          );
          return "popup and full report opened; a new record still appended";
        } finally {
          await store.set(ctx, { events: [] });
        }
      },
    );

    await check(
      "STS4",
      "Stress: 300 single keystrokes: no errors, the scan waits for the pause, the warning appears once",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          await page.evaluate(`${page.site.editor}.focus()`);
          const text = `my key ${KEY} `.repeat(12).slice(0, 300);
          TYPED_VALUES.add(text);
          await page.keyboard.type(text, { delay: 5 });
          const n = await waitFor(() => readNotice(page), 5000);
          expect(n && /AWS Access Key/.test(n.text), "no warning after typing");
          const warnings = page.logs.filter((l) => l.includes("[Clotr] warning about")).length;
          expect(warnings <= 3, `the scan ran ${warnings} times while typing (debounce broken)`);
          return `${warnings} scan(s) for 300 keystrokes`;
        }),
    );

    await check("STS5", "Stress: a vault with 1,000 entries still warns", () =>
      withSite(ctx, "chatgpt", async (page) => {
        const vault = Array.from({ length: 1000 }, (_, i) => ({
          kind: "word",
          type: "watch_list",
          fp: i.toString(16).padStart(16, "0"),
          words: 1 + (i % 4),
          mode: "protect",
          added: Date.now(),
        }));
        await store.set(ctx, { events: [], responses: {}, vault, guided: ALL_GUIDED });
        try {
          await typeText(page, `a normal message about the weather and my key ${KEY}`);
          const n = await waitFor(() => readNotice(page), 5000);
          expect(n, "no warning");
          return "warning shown with 1,000 saved words";
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
    );
    await check(
      "STS6",
      "Stress: 60 attached files at once (text, Word, spreadsheets): one notice, the first 50 checked, the chat stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const dir = path.join(OUT, "sts6");
          fs.mkdirSync(dir, { recursive: true });
          const files = [];
          const filler = "Agenda item and minutes, nothing private here. ".repeat(4000); // ~190 KB each
          for (let i = 0; i < 60; i++) {
            const risky = i % 10 === 3 ? `mail p${i}@gmail.com` : "";
            if (risky) TYPED_VALUES.add(risky);
            const kind = i % 3;
            const file = path.join(dir, `doc${i}.${["txt", "docx", "xlsx"][kind]}`);
            if (kind === 0) fs.writeFileSync(file, `${filler}\n${risky}\n`);
            else if (kind === 1) makeZip(file, [["word/document.xml", docxXml([filler, risky])]]);
            else {
              makeZip(file, [["xl/sharedStrings.xml", `<sst><si><t>${filler}</t></si><si><t>${risky}</t></si></sst>`]]);
            }
            files.push(file);
          }
          await (await page.$("#attach")).uploadFile(...files);
          const notice = await waitFor(async () => {
            const n = await readNotice(page);
            return n && /files you attached/.test(n.text) ? n : null;
          }, 20000);
          await page.evaluate(() => 1 + 1);
          fs.rmSync(dir, { recursive: true });
          // Files 3, 13, 23, 33, and 43 fall within the first 50 Clotr checks (MAX_FILES); file 53 doesn't.
          expect(
            notice && /5 files you attached/.test(notice.text) && /and 2 more/.test(notice.text),
            `notice: ${notice?.text}`,
          );
          expect(
            page.logs.some((l) => l.includes("checking the first 50 of 60")),
            "no log about the 50-file cap",
          );
          return "60 files (~11 MB) checked; page answered after the upload";
        }),
    );

    await check(
      "STS7",
      "Stress: a day-long tab (500 warned messages, AI replies after each): heap steady, one notice at a time, every record kept",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          page.cdp ??= await page.createCDPSession();
          const heap = async () => {
            await page.cdp.send("HeapProfiler.collectGarbage");
            return (await page.metrics()).JSHeapUsedSize;
          };
          const round = async (i) => {
            await typeText(page, `note ${i}: reach me at 555-555-${String(1000 + i).slice(-4)}`);
            await waitFor(() => readNotice(page), 3000);
            await pressEnter(page);
            await page.evaluate((n) => window.__reply(`Sure, here is a long answer number ${n}. `.repeat(20)), i);
          };
          for (let i = 0; i < 50; i++) await round(i); // warm up
          const before = await heap();
          for (let i = 50; i < 500; i++) await round(i);
          await sleep(500);
          const grew = (await heap()) - before;
          const hosts = await page.evaluate(() => document.querySelectorAll("clotr-notice, clotr-guard").length);
          const sent = (await sentMessages(page)).length;
          const events =
            (await waitFor(async () => {
              const ev = await store.events(ctx);
              return ev.length >= 500 ? ev : null;
            }, 8000)) || (await store.events(ctx));
          const errors = page.logs.filter((l) => /\[Clotr\].*(error|failed)/i.test(l));
          expect(sent === 500, `sent ${sent} of 500`);
          expect(events.length === 500, `records: ${events.length} of 500`);
          expect(hosts <= 1, `${hosts} Clotr elements left in the page`);
          expect(grew < 5 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(1)} MB over 450 messages`);
          expect(!errors.length, `errors: ${errors.slice(0, 3).join(" | ")}`);
          return `heap +${(grew / 1024 / 1024).toFixed(2)} MB over 450 messages`;
        }),
    );

    await check(
      "STS8",
      "Stress: a 50-word watch list grows linearly against a 2,000-character message on a 4x-throttled CPU",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          // Up to 4 words each, so the per-span scan (vaultMatches in patterns.js) checks every 1-, 2-, 3- and
          // 4-word span, the worst case this fix has to keep cheap: the watch-list fingerprint stays the single,
          // fast round (scheme 1) no matter how strong the vault's saved values get.
          const watchPhrase = "Project Falcon Launch Team";
          const words = [watchPhrase, ...Array.from({ length: 49 }, (_, i) => `Codename${i} Internal Term ${i}`)];
          const vault = await ctx.worker.evaluate(async (phrases) => {
            const salt = await ensureSalt();
            return phrases.map((phrase) => ({
              kind: "word",
              type: "watch_list",
              fp: globalThis.Clotr.fingerprint(salt, "watch_list", phrase),
              words: phrase.split(" ").length,
              mode: "protect",
              added: Date.now(),
            }));
          }, words);
          await store.set(ctx, { events: [], responses: {}, vault, guided: ALL_GUIDED });
          page.cdp ??= await page.createCDPSession();
          await page.cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          try {
            const filler = "a quarterly update with nothing sensitive in it ".repeat(40); // ~2,000 chars
            const text = `${filler}${watchPhrase} ${filler}`.slice(0, 2000);
            await typeText(page, text);
            const n = await waitFor(() => readNotice(page), 4000);
            expect(n && /Watch List Item/.test(n.text), `no warning for the watched phrase (notice: ${n?.text})`);
            const growth = await measureClotrGrowth(
              page,
              `(size) => ("Project Falcon Launch Team " + "a quarterly update with nothing sensitive in it ".repeat(size * 12)).slice(0, size * 500)`,
            );
            expect(growth.ratio < 16, `watch-list detection grew ${growth.ratio.toFixed(1)}× for 4× the text`);
            return `${growth.ratio.toFixed(1)}× growth for 4× the text, 50 watch words, 4x CPU throttle`;
          } finally {
            await page.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
            await store.set(ctx, { vault: [] });
          }
        }),
    );
  }
};
