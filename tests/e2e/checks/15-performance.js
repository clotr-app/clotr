// E2E checks: Performance. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    check,
    ctx,
    editorText,
    expect,
    patience,
    pressEnter,
    readNotice,
    readUI,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    withSite,
  } = env;
  await check("PERF1", "Enter responds fast after a big paste (40k characters of spelled-out numbers)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: a warning, so Enter sends
      await typeText(page, "one two three four five six seven eight nine ten ".repeat(800) + " call 555-555-0123");
      expect(await waitFor(() => readNotice(page), 8000), "no notice");
      const t0 = Date.now();
      await pressEnter(page);
      const sent = await waitFor(async () => (await sentMessages(page)).length === 1, 8000, 20);
      const ms = Date.now() - t0;
      expect(sent, "the message didn't send");
      // A second is the budget on a quiet computer. On a busy one it stretches by however much slower the
      // computer is running right now, from patience() in lib.js.
      const allowed = 1000 * patience();
      expect(ms < allowed, `Enter took ${ms} ms to send (${Math.round(allowed)} allowed on this computer now)`);
    }),
  );

  // Bandage's underlines recheck what covers each label as the page moves, and that work has to stay cheap. On a
  // long answer full of labels, scrolling should never stall the page.
  await check(
    "PERF2",
    "Bandage underlines while scrolling: 60 labels on screen for 2 seconds, no long task (50 ms)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, "call me at 555-555-0123");
        const covered = await waitFor(async () => (await editorText(page)) === "call me at [Phone 1]" || null, 4000);
        expect(covered, `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        // This builds a long answer: 100 lines with three labels each, about three screens tall.
        await page.evaluate(() => {
          const d = document.createElement("div");
          d.className = "reply";
          for (let i = 1; i <= 100; i++) {
            const p = document.createElement("p");
            p.style.margin = "0 0 4px";
            p.textContent = `Line ${i}: [Phone 1] at home, [Phone 1] at work, [Phone 1] tonight.`;
            d.append(p);
          }
          document.body.append(d);
        });
        const all = await waitFor(async () => {
          const s = await readUI(page, "CLOTR-SPOTS");
          return s?.buttons.length === 300 ? s : null;
        }, 8000);
        expect(all, `hotspots: ${(await readUI(page, "CLOTR-SPOTS"))?.buttons.length}`);
        await sleep(500);
        const shown = (await readUI(page, "CLOTR-SPOTS")).buttons.filter((b) => !b.hidden).length;
        expect(shown >= 60, `only ${shown} labels on screen`);
        // This scrolls for two seconds and records every long task the page had, meaning 50 ms or more. A busy
        // computer also makes the page wait its turn on a processor, which can make any task look long, so the
        // threshold scales up by how much slower the computer is right now (patience() in lib.js). If a try comes
        // back with one long task, I measure again, up to three tries, since underlines that truly stall the page
        // should stall it every time.
        const scroll = () =>
          new Promise((resolve) => {
            if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
              resolve(null);
              return;
            }
            const long = [];
            const watch = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) long.push(Math.round(e.duration));
            });
            watch.observe({ type: "longtask" });
            const start = performance.now();
            let frames = 0;
            (function step(now) {
              if (now - start > 2000) {
                setTimeout(() => {
                  watch.disconnect();
                  resolve({ long, frames });
                }, 100);
                return;
              }
              frames++;
              window.scrollBy(0, 6);
              requestAnimationFrame(step);
            })(start);
          });
        let run;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await page.evaluate(() => window.scrollTo(0, 0));
          run = await page.evaluate(scroll);
          expect(run, "this browser has no Long Tasks API");
          const limit = 50 * patience();
          run.long = run.long.filter((ms) => ms >= limit);
          if (!run.long.length) break;
        }
        expect(!run.long.length, `long tasks while scrolling, on every try: ${run.long.join(", ")} ms`);
        await resetState(ctx, {});
        return `${shown} labels on screen, ${run.frames} frames`;
      }),
  );

  // The strong fingerprint is slow on purpose (about 15 ms each), so it has to stay off the path a paste takes:
  // worked out once per found value, a 500-row contact list would hold the tab for about nine seconds.
  await check("PERF3", "A pasted 500-row contact list (600 details) gets its warning within 2 seconds", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const rows = Array.from(
        { length: 500 },
        (_, i) => `row ${i}, jane.doe${i}@corp-mail.com, 555-01${String(i % 100).padStart(2, "0")}-${1000 + i}`,
      );
      const t0 = Date.now();
      await typeText(page, rows.join("\n"));
      const notice = await waitFor(() => readNotice(page), 30000);
      const ms = Date.now() - t0;
      expect(notice, "no notice");
      const allowed = 2000 * patience();
      expect(ms < allowed, `the warning took ${ms} ms (${Math.round(allowed)} allowed on this computer now)`);
      // Sending records one event per detail, each with its strong fingerprint: that has to leave the page free
      // to respond, so the longest wait for a timer over the next three seconds stays short.
      await pressEnter(page);
      expect(await waitFor(async () => (await sentMessages(page)).length === 1, 8000, 20), "the message didn't send");
      const worst = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let max = 0;
            let last = performance.now();
            const end = last + 3000;
            (function tick() {
              const now = performance.now();
              max = Math.max(max, now - last);
              last = now;
              if (now < end) setTimeout(tick, 10);
              else resolve(Math.round(max));
            })();
          }),
      );
      const stall = 300 * patience();
      expect(worst < stall, `the page stalled for ${worst} ms after sending (${Math.round(stall)} allowed)`);
      await resetState(ctx, {});
      return `${ms} ms to warn, ${worst} ms longest stall after sending`;
    }),
  );

  // The longest the page waited for a timer over the next `ms`: anything long means the tab was frozen.
  const longestStall = (page, ms) =>
    page.evaluate(
      (span) =>
        new Promise((resolve) => {
          let max = 0;
          let last = performance.now();
          const end = last + span;
          (function tick() {
            const now = performance.now();
            max = Math.max(max, now - last);
            last = now;
            if (now < end) setTimeout(tick, 10);
            else resolve(Math.round(max));
          })();
        }),
      ms,
    );
  // A saved detail, fingerprinted the way the vault page saves it (the strong fingerprint).
  const saveDetail = async (type, value, mode) => {
    const fp = await ctx.worker.evaluate(
      async ([t, v]) => globalThis.Clotr.fingerprintStrong(await ensureSalt(), t, v),
      [type, value],
    );
    await store.set(ctx, { vault: [{ kind: "value", type, fp, scheme: 2, mode, added: Date.now() }] });
  };

  // Telling a saved detail apart from the others takes each found value's strong fingerprint, about 15 ms. With a
  // phone number saved, a pasted list of 600 phone numbers used to hold the tab for 9 seconds or more.
  await check("PERF4", "With a phone number saved, a paste of 600 phone numbers warns within 2 seconds", async () => {
    await resetState(ctx, {});
    await saveDetail("phone_number", "(555) 555-5636", "protect");
    return withSite(ctx, "chatgpt", async (page) => {
      const rows = Array.from({ length: 600 }, (_, i) => `555-${200 + Math.floor(i / 10)}-${1000 + i}`);
      const t0 = Date.now();
      await typeText(page, rows.join("\n"));
      const notice = await waitFor(() => readNotice(page), 30000);
      const ms = Date.now() - t0;
      expect(notice, "no notice");
      expect(/Phone Number ×600/.test(notice.text), `notice: ${notice.text}`);
      const allowed = 2000 * patience();
      expect(ms < allowed, `the warning took ${ms} ms (${Math.round(allowed)} allowed on this computer now)`);
      const worst = await longestStall(page, 2000);
      const stall = 300 * patience();
      expect(worst < stall, `the page stalled for ${worst} ms after the warning (${Math.round(stall)} allowed)`);
      await resetState(ctx, {});
      return `${ms} ms to warn, ${worst} ms longest stall after`;
    });
  });

  // An "OK to share" email does change the answer, so each email is looked up: the scan looks up what fits in its
  // time and works out the rest in the background, the page free meanwhile, then the warning drops the saved one.
  await check(
    "PERF5",
    "With an email marked OK to share, a paste of 600 emails warns fast and then drops it",
    async () => {
      await resetState(ctx, {});
      const mine = "jo.saved@example.org";
      await saveDetail("email", mine, "allow");
      return withSite(ctx, "chatgpt", async (page) => {
        const rows = [...Array.from({ length: 599 }, (_, i) => `jane.doe${i}@corp-mail.com`), mine];
        const t0 = Date.now();
        await typeText(page, rows.join("\n"));
        const notice = await waitFor(() => readNotice(page), 30000);
        const ms = Date.now() - t0;
        expect(notice, "no notice");
        const allowed = 2000 * patience();
        expect(ms < allowed, `the warning took ${ms} ms (${Math.round(allowed)} allowed on this computer now)`);
        const worst = await longestStall(page, 3000);
        const stall = 300 * patience();
        expect(
          worst < stall,
          `the page stalled for ${worst} ms while the vault was checked (${Math.round(stall)} allowed)`,
        );
        const settled = await waitFor(
          async () => /Email Address ×599\b/.test((await readNotice(page))?.text || ""),
          60000,
        );
        const done = Date.now() - t0;
        expect(settled, `the saved email was still warned about: ${(await readNotice(page))?.text}`);
        await resetState(ctx, {});
        return `${ms} ms to warn, ${worst} ms longest stall, ${done} ms until the saved email dropped out`;
      });
    },
  );

  await check("MEM1", "Memory stays steady: 200 more messages barely grow the page's heap", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      page.cdp ??= await page.createCDPSession();
      const heap = async () => {
        await page.cdp.send("HeapProfiler.collectGarbage");
        return (await page.metrics()).JSHeapUsedSize;
      };
      const send = async (i) => {
        await typeText(
          page,
          `message ${i}: call 555-555-${1000 + i} or mail p${i}@example.com, key AKIA${String(i).padStart(4, "0")}HPQ7XZ2R6TWL`,
        );
        await pressEnter(page);
      };
      for (let i = 0; i < 30; i++) await send(i); // warm up
      const before = await heap();
      for (let i = 30; i < 230; i++) await send(i);
      await sleep(500);
      const grew = (await heap()) - before;
      expect((await sentMessages(page)).length === 230, `sent ${(await sentMessages(page)).length} of 230`);
      expect(grew < 3 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(1)} MB over 200 messages`);
    }),
  );
};
