// E2E checks: Performance. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    check,
    ctx,
    editorText,
    expect,
    evalInClotr,
    measureClotrGrowth,
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
  await check("PERF1", "Enter sends after a big paste; detection grows with 40k characters of number words", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: a warning, so Enter sends
      await typeText(page, "one two three four five six seven eight nine ten ".repeat(800) + " call 555-555-0123");
      expect(await waitFor(() => readNotice(page), 8000), "no notice");
      await pressEnter(page);
      const sent = await waitFor(async () => (await sentMessages(page)).length === 1, 8000, 20);
      expect(sent, "the message didn't send");
      const growth = await measureClotrGrowth(
        page,
        `(size) => "one two three four five six seven eight nine ten ".repeat(size * 200)`,
      );
      expect(growth.ratio < 16, `detection grew ${growth.ratio.toFixed(1)}× for 4× the text`);
    }),
  );

  // Bandage's underlines recheck what covers each label as the page moves, and that work has to stay cheap. On a
  // long answer full of labels, scrolling should never stall the page.
  await check("PERF2", "Bandage labels stay visible while scrolling, and reading 400 labels grows linearly", () =>
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
      const frames = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const start = performance.now();
            let frameCount = 0;
            (function step(now) {
              if (now - start > 1000) {
                resolve(frameCount);
              } else {
                frameCount++;
                window.scrollBy(0, 6);
                requestAnimationFrame(step);
              }
            })(start);
          }),
      );
      expect(frames > 0, "the page stopped scrolling");
      const growth = await measureClotrGrowth(
        page,
        `(size) => "[Phone 1] at home, [Phone 1] at work, [Phone 1] tonight. ".repeat(size * 100)`,
        `(text) => globalThis.Clotr.readBandageLabels(text)`,
      );
      expect(growth.ratio < 16, `label reading grew ${growth.ratio.toFixed(1)}× for 4× the text`);
      await resetState(ctx, {});
      return `${shown} labels on screen, ${frames} frames; label reading ${growth.ratio.toFixed(1)}× for 4× input`;
    }),
  );

  // The strong fingerprint is intentionally slower than the original hash. It is handled one value at a time, so
  // a large contact list must still use work that grows with the number of details.
  await check("PERF3", "A 500-row contact list warns; detection grows with its 600 details", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const rows = Array.from(
        { length: 500 },
        (_, i) => `row ${i}, jane.doe${i}@corp-mail.com, 555-01${String(i % 100).padStart(2, "0")}-${1000 + i}`,
      );
      await typeText(page, rows.join("\n"));
      const notice = await waitFor(() => readNotice(page), 30000);
      expect(notice, "no notice");
      const growth = await measureClotrGrowth(
        page,
        `(size) => Array.from({ length: size * 125 }, (_, i) => "row " + i + ", jane.doe" + i + "@corp-mail.com, 555-555-" + String(1000 + i)).join("\\n")`,
      );
      expect(growth.ratio < 16, `detection grew ${growth.ratio.toFixed(1)}× for 4× the text`);
      // Sending records one event per detail, each with its strong fingerprint: that has to leave the page free
      // to respond, so the longest wait for a timer over the next three seconds stays short.
      await pressEnter(page);
      expect(await waitFor(async () => (await sentMessages(page)).length === 1, 8000, 20), "the message didn't send");
      await resetState(ctx, {});
      return `${growth.ratio.toFixed(1)}× detector work for 4× the contact list`;
    }),
  );

  const startLongTaskMeasure = (page) =>
    page.evaluate(() => {
      if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return false;
      window.__perfTasks = [];
      window.__perfTaskObserver = new PerformanceObserver((list) => window.__perfTasks.push(...list.getEntries()));
      window.__perfTaskObserver.observe({ type: "longtask" });
      return true;
    });
  const stopLongTaskMeasure = (page) =>
    page.evaluate(() => {
      const observer = window.__perfTaskObserver;
      if (!observer) return null;
      window.__perfTasks.push(...observer.takeRecords());
      observer.disconnect();
      delete window.__perfTaskObserver;
      const tasks = window.__perfTasks.map((entry) => ({ start: entry.startTime, duration: entry.duration }));
      delete window.__perfTasks;
      return tasks;
    });
  // A saved detail, fingerprinted the way the vault page saves it (the strong fingerprint).
  const saveDetail = async (type, value, mode) => {
    const fp = await ctx.worker.evaluate(
      async ([t, v]) => globalThis.Clotr.fingerprintStrong(await ensureSalt(), t, v),
      [type, value],
    );
    await store.set(ctx, { vault: [{ kind: "value", type, fp, scheme: 2, mode, added: Date.now() }] });
  };

  // The unit suite compares vault decision work at 150 and 600 matches; this browser check keeps the real warning
  // path covered too.
  await check("PERF4", "With a phone number saved, a 600-number paste warns and detection grows linearly", async () => {
    await resetState(ctx, {});
    await saveDetail("phone_number", "(555) 555-5636", "protect");
    return withSite(ctx, "chatgpt", async (page) => {
      const rows = Array.from({ length: 600 }, (_, i) => `555-${200 + Math.floor(i / 10)}-${1000 + i}`);
      await typeText(page, rows.join("\n"));
      const notice = await waitFor(() => readNotice(page), 30000);
      expect(notice, "no notice");
      expect(/Phone Number ×600/.test(notice.text), `notice: ${notice.text}`);
      const growth = await measureClotrGrowth(
        page,
        `(size) => Array.from({ length: size * 150 }, (_, i) => "555-" + (200 + Math.floor(i / 10)) + "-" + (1000 + i)).join("\\n")`,
      );
      expect(growth.ratio < 16, `detection grew ${growth.ratio.toFixed(1)}× for 4× the text`);
      await resetState(ctx, {});
      return `${growth.ratio.toFixed(1)}× detector work for 4× the phone list`;
    });
  });

  // An "OK to share" email does change the answer, so each email is looked up: the scan looks up what fits in its
  // time and works out the rest in the background, the page free meanwhile, then the warning drops the saved one.
  await check("PERF5", "With an email marked OK to share, a paste of 600 emails warns and then drops it", async () => {
    await resetState(ctx, {});
    const mine = "jo.saved@example.org";
    await saveDetail("email", mine, "allow");
    return withSite(ctx, "chatgpt", async (page) => {
      const rows = [...Array.from({ length: 599 }, (_, i) => `jane.doe${i}@corp-mail.com`), mine];
      await evalInClotr(
        page,
        `(() => {
            globalThis.__perfDetectCalls = 0;
            globalThis.__perfVaultTimes = [];
            globalThis.__perfVaultCalls = [];
            const detect = globalThis.Clotr.detect;
            globalThis.Clotr.detect = (...args) => {
              globalThis.__perfDetectCalls++;
              return detect(...args);
            };
            const vaultMode = globalThis.Clotr.vaultMode;
            globalThis.Clotr.vaultMode = (...args) => {
              const start = performance.now();
              const mode = vaultMode(...args);
              if (args[2]?.budget === null) {
                while (performance.now() - start < 28) {}
                globalThis.__perfVaultTimes.push(performance.now() - start);
                globalThis.__perfVaultCalls.push({ start, end: performance.now() });
              }
              return mode;
            };
          })()`,
      );
      // Timer gaps can include time the shared runner didn't schedule the browser. Long tasks and individual
      // vault checks show whether the page handled one expensive lookup before yielding to input.
      expect(await startLongTaskMeasure(page), "this browser can't report main-thread long tasks");
      const t0 = Date.now();
      await typeText(page, rows.join("\n"));
      const notice = await waitFor(() => readNotice(page), 30000);
      expect(notice, "no notice");
      const growth = await measureClotrGrowth(
        page,
        `(size) => Array.from({ length: size * 150 }, (_, i) => "jane.doe" + i + "@corp-mail.com").join("\\n")`,
      );
      expect(growth.ratio < 16, `detection grew ${growth.ratio.toFixed(1)}× for 4× the text`);
      const scansAtNotice = await evalInClotr(page, "globalThis.__perfDetectCalls");
      const settled = await waitFor(
        async () => /Email Address ×599\b/.test((await readNotice(page))?.text || ""),
        60000,
      );
      const done = Date.now() - t0;
      const scansAfterCatchup = await evalInClotr(page, "globalThis.__perfDetectCalls");
      const calls = await evalInClotr(page, "globalThis.__perfVaultCalls");
      const lookup = await evalInClotr(
        page,
        `(() => {
            const times = globalThis.__perfVaultTimes.sort((a, b) => a - b);
            return {
              count: times.length,
              p99: times.length ? times[Math.ceil(times.length * 0.99) - 1] : null,
            };
          })()`,
      );
      const tasks = await stopLongTaskMeasure(page);
      const lookupsPerTask = tasks
        .map((task) => ({
          duration: Math.round(task.duration),
          calls: calls.filter((call) => call.start >= task.start && call.start < task.start + task.duration).length,
        }))
        .filter((task) => task.calls);
      expect(
        scansAfterCatchup === scansAtNotice,
        `the vault catch-up reran detection ${scansAfterCatchup - scansAtNotice} times instead of reusing its first scan`,
      );
      expect(
        lookup.count >= 500,
        `the vault checked only ${lookup.count} saved values in the background; timing needs at least 500`,
      );
      expect(
        lookupsPerTask.every((task) => task.calls === 1),
        `a long page task covered multiple vault lookups: ${JSON.stringify(lookupsPerTask.filter((task) => task.calls > 1))}`,
      );
      expect(settled, `the saved email was still warned about: ${(await readNotice(page))?.text}`);
      await resetState(ctx, {});
      return `${growth.ratio.toFixed(1)}× detection growth, ${lookup.count} saved values checked, ${lookup.p99} ms p99 lookup, ${done} ms until the saved email dropped out`;
    });
  });

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
