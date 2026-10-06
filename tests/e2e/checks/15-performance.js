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
            if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return resolve(null);
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
