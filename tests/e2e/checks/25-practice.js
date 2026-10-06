// E2E checks: PD. The practice page lets you answer six made-up scam messages, each checked by the real engine, then
// try Spot the leak. It's a safe place: nothing you type here is sent, stored, or counted in your history.
// Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { EXT, OUT, check, ctx, expect, fs, launch, openExtPage, path, resetState, sleep, store, waitFor } = env;

  const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

  // Opens the practice page at the given width and waits for its fonts to load.
  async function openPractice(c = ctx, width = 1040) {
    const page =
      c === ctx
        ? await openExtPage(ctx, "practice.html")
        : await (async () => {
            const p = await c.browser.newPage();
            p.on("pageerror", (err) => ctx.problems.push(`practice.html (Spanish) error: ${err.message}`));
            await p.goto(`chrome-extension://${new URL(c.swTarget.url()).host}/practice.html`);
            return p;
          })();
    await page.setViewport({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(200);
    return page;
  }

  // Reads the current drill's state from the page.
  const drillState = (page) =>
    page.evaluate(() => ({
      step: document.getElementById("drill-step")?.textContent.trim(),
      from: document.getElementById("drill-from")?.textContent.trim(),
      message: document.getElementById("drill-message")?.textContent.trim(),
      reply: document.getElementById("reply")?.value,
      reveal: document.getElementById("reveal")?.innerText.trim() || "",
      notice: document.querySelector("#reveal .try-notice")?.innerText.trim() || "",
      safer: document.querySelector("#reveal .safer")?.innerText.trim() || "",
      next: document.getElementById("next")?.hidden === false ? document.getElementById("next").textContent.trim() : "",
      back: document.getElementById("back")?.hidden === false,
      leak: document.getElementById("leak")?.hidden === false,
    }));

  async function useMadeUpAndCheck(page) {
    await page.click("#use-made-up");
    await page.click("#check");
    await waitFor(async () => (await drillState(page)).reveal, 2000);
    return drillState(page);
  }

  // Takes a full-page screenshot at a given width and theme. I bring the tab to the front first, since a
  // screenshot of a background tab can hang waiting for a frame that never arrives.
  async function shotFull(page, name, width, theme) {
    await page.bringToFront();
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await page.setViewport({ width, height: 700 });
    await sleep(250);
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  }
  const SHOTS = [
    [380, "dark"],
    [380, "light"],
    [1040, "dark"],
    [1040, "light"],
  ];
  async function shots(page, base) {
    for (const [width, theme] of SHOTS) await shotFull(page, `${base}-${width}-${theme}.png`, width, theme);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }

  // Runs axe-core in both themes and keeps only the serious and critical violations.
  async function audit(page, where, problems) {
    for (const theme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(150);
      if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
      const found = await page.evaluate(async () =>
        (await axe.run(document, { resultTypes: ["violations"] })).violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(" ")}`),
      );
      problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
    }
  }

  await check(
    "PD2",
    "Drill 1: Or use a made-up reply fills the reply; Check my reply shows the engine's notice, masked, and the safer reply",
    async () => {
      await resetState(ctx, {});
      const page = await openPractice();
      try {
        const start = await drillState(page);
        expect(start.step === "Drill 1 of 6: a message from “your bank”", `step: ${start.step}`);
        expect(start.from === "Anytown Bank Fraud Team", `from: ${start.from}`);
        expect(/6-digit code we just texted you/.test(start.message), `message: ${start.message}`);
        expect(!start.reveal && !start.next && !start.back, `before a reply: ${JSON.stringify(start)}`);
        await shots(page, "practice-page");
        const s = await useMadeUpAndCheck(page);
        expect(s.reply === "ok, the code they texted me is 482913", `reply: ${s.reply}`);
        // The notice should match the real one: name what it found, mask the code, and ask who really needs it.
        expect(/Heads up/.test(s.notice), `notice: ${s.notice}`);
        expect(/Sign-in Code \(••••••\)/.test(s.notice), `notice: ${s.notice}`);
        expect(/Who asks for a code that was sent to you\?/.test(s.notice), `no who-asks line: ${s.notice}`);
        expect(/the people who read it here get it/.test(s.notice), `notice: ${s.notice}`);
        expect(!s.reveal.includes("482913"), "the reveal shows the code in full");
        expect(/I'll call the number on the back of my card myself/.test(s.safer), `safer: ${s.safer}`);
        expect(/You call them, on a number you already trust/.test(s.safer), `why: ${s.safer}`);
        expect(s.next === "Next drill: “your grandson”", `next: ${s.next}`);
        // Pressing Enter should check the reply too, the same as clicking Check.
        await page.$eval("#reply", (t) => (t.value = ""));
        await page.focus("#reply");
        await page.keyboard.type("I'll call the number on the back of my card myself.");
        await page.keyboard.press("Enter");
        await waitFor(async () => /Nothing in your reply/.test((await drillState(page)).reveal), 2000);
        const enter = await drillState(page);
        expect(/Nothing in your reply/.test(enter.reveal), `Enter: ${enter.reveal}`);
        expect(!enter.reply.includes("\n"), "Enter wrote a new line");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "PD3",
    "A safer reply typed in shows “Nothing in your reply that Clotr knows scammers ask for”, and the safer reply still",
    async () => {
      const page = await openPractice();
      try {
        await page.type("#reply", "I'll call the number on the back of my card myself.");
        await page.click("#check");
        await waitFor(async () => (await drillState(page)).reveal, 2000);
        const s = await drillState(page);
        expect(/Nothing in your reply that Clotr knows scammers ask for/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(!s.notice, `a notice for a safe reply: ${s.notice}`);
        expect(/compare your reply with the one below/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(/A safer reply/.test(s.safer), `safer: ${s.safer}`);
        // If the reply has something else sensitive in it, the notice should name that instead.
        await page.$eval("#reply", (t) => (t.value = ""));
        await page.type("#reply", "sure, call me at (555) 555-0150");
        await page.click("#check");
        await sleep(200);
        const other = await drillState(page);
        expect(/Phone Number \(/.test(other.notice), `notice: ${other.notice}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "PD4",
    "Hide it in the reveal covers the code in the reply and the reveal updates; Leave it in says the message is still theirs",
    async () => {
      const page = await openPractice();
      try {
        await useMadeUpAndCheck(page);
        await page.click("#reveal .try-notice .btn.primary");
        await sleep(200);
        const s = await drillState(page);
        expect(s.reply.includes("[REDACTED") && !s.reply.includes("482913"), `reply: ${s.reply}`);
        expect(/Nothing in your reply now that Clotr knows scammers ask for/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(await page.evaluate(() => document.activeElement?.id === "reply"), "focus left the reply");
        await useMadeUpAndCheck(page);
        await page.click("#reveal .try-notice .leave");
        await sleep(200);
        const left = await drillState(page);
        expect(/still yours to send/.test(left.notice), `after Leave it in: ${left.notice}`);
        expect(left.reply === "ok, the code they texted me is 482913", `reply changed: ${left.reply}`);
      } finally {
        await page.close();
      }
    },
  );

  // Each drill's made-up reply should trigger the same finding the engine already produces in the unit tests,
  // named the way the real warning names it.
  const NAMES = [
    "Sign-in Code",
    "Gift Card Code",
    "Sign-in Code",
    "Remote-Access Code",
    "Card Security Code",
    "Street Address",
  ];
  await check("PD5", "Next drill through all six, then Round 2; Back keeps each reply", async () => {
    const page = await openPractice();
    try {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        const before = await drillState(page);
        expect(before.step.startsWith(`Drill ${i + 1} of 6: `), `step ${i + 1}: ${before.step}`);
        if (i === 1) await shots(page, "practice-drill");
        const s = await useMadeUpAndCheck(page);
        expect(s.notice.includes(`${NAMES[i]} (`), `drill ${i + 1}: ${s.notice}`);
        if (i === 1) await shots(page, "practice-reveal");
        seen.push(s.reply);
        if (i < 5) expect(s.next.startsWith("Next drill: "), `drill ${i + 1}'s next: ${s.next}`);
        else expect(s.next === "Next: Spot the leak", `the last drill's next: ${s.next}`);
        await page.click("#next");
        await sleep(150);
      }
      expect((await drillState(page)).leak, "Round 2 didn't open after drill 6");
      // Going back from Round 2 to drill 6, then on to drill 2, should keep each drill's own reply.
      await page.click("#leak-back");
      await sleep(150);
      for (let i = 5; i >= 1; i--) {
        const s = await drillState(page);
        expect(s.step.startsWith(`Drill ${i + 1} of 6`), `back at ${i + 1}: ${s.step}`);
        expect(s.reply === seen[i], `drill ${i + 1}'s reply: ${s.reply}`);
        expect(s.notice.includes(`${NAMES[i]} (`), `drill ${i + 1}'s reveal after Back: ${s.notice}`);
        await page.click("#back");
        await sleep(150);
      }
      const first = await drillState(page);
      expect(first.step.startsWith("Drill 1 of 6") && !first.back, `the first drill: ${JSON.stringify(first)}`);
    } finally {
      await page.close();
    }
  });

  // Reads Spot the leak's current state from the page.
  const leakState = (page) =>
    page.evaluate(() => ({
      count: document.getElementById("leak-count")?.textContent.trim(),
      text: document.getElementById("leak-text")?.textContent.trim() || "",
      reveal: document.getElementById("leak-reveal")?.innerText.trim() || "",
      chips: [...document.querySelectorAll("#leak-reveal .chip-find")].map((c) => c.textContent.trim()),
      pressed: [...document.querySelectorAll("#leak-body .answer")].map((b) => b.getAttribute("aria-pressed")),
      next:
        document.getElementById("leak-next")?.hidden === false
          ? document.getElementById("leak-next").textContent.trim()
          : "",
      end: document.getElementById("leak-end")?.innerText.trim() || "",
    }));

  // Clicks through all six drills to reach Spot the leak.
  async function toLeak(page) {
    while (!(await drillState(page)).leak) {
      await page.click("#use-made-up");
      await page.click("#check");
      await sleep(60);
      await page.click("#next");
      await sleep(60);
    }
  }

  await check(
    "PD6",
    "Spot the leak: an answer, then what Clotr finds, masked, with Bandage's line or what the AI needs instead; after ten, the count",
    async () => {
      const page = await openPractice();
      try {
        await toLeak(page);
        let withSome = 0;
        let changed = 0;
        for (let i = 0; i < 10; i++) {
          const s = await leakState(page);
          expect(s.count === `${i + 1} of 10`, `count: ${s.count}`);
          expect(!s.reveal && !s.next, `before an answer: ${JSON.stringify(s)}`);
          const choice = i % 3 ? "#change-it" : "#send-it";
          await page.click(choice);
          await sleep(120);
          const a = await leakState(page);
          expect(
            JSON.stringify(a.pressed) === JSON.stringify(choice === "#send-it" ? ["true", "false"] : ["false", "true"]),
            `pressed: ${a.pressed}`,
          );
          // Run the same detector the page uses on the message it's showing, so I can check the reveal against it.
          const found = await page.evaluate(
            (t) => globalThis.Clotr.detect(t).flatMap((r) => r.matches.map((m) => [r.name, m])),
            a.text,
          );
          if (found.length) {
            withSome++;
            if (choice === "#change-it") changed++;
            expect(a.chips.length === found.length, `chips ${a.chips} for ${found.length} finds`);
            for (const [name, value] of found) {
              expect(
                a.chips.some((c) => c.startsWith(`${name} (`)),
                `no chip for ${name}: ${a.chips}`,
              );
              if (value.length > 4) expect(!a.reveal.includes(value), `the reveal shows a value in full`);
            }
            expect(/Clotr sees (1 detail|\d+ details) here/.test(a.reveal), `reveal: ${a.reveal}`);
            expect(
              /With Bandage on, Clotr can send \[|The AI doesn't need|Ask about the message without/.test(a.reveal),
              `line: ${a.reveal}`,
            );
            if (/landlord/.test(a.text))
              expect(/send \[Address 1\] and \[Phone 1\] instead/.test(a.reveal), `landlord: ${a.reveal}`);
            if (withSome === 1) await shots(page, "practice-leak");
          } else {
            expect(/Clotr finds nothing private here/.test(a.reveal) && !a.chips.length, `nothing: ${a.reveal}`);
          }
          expect(a.next === (i < 9 ? "Next message" : "See how you did"), `next: ${a.next}`);
          await page.click("#leak-next");
          await sleep(120);
        }
        expect(withSome === 5, `${withSome} of the ten had something private`);
        const end = await leakState(page);
        expect(
          end.end.includes(`You'd have changed ${changed} of the 5 that had something private.`),
          `end: ${end.end}`,
        );
        expect(/Nothing about your answers is kept/.test(end.end), `end: ${end.end}`);
        expect(
          (await page.$eval("#leak-end a[href='check.html']", (a) => a.textContent.trim())) === "Is this a scam?",
          "no way to Is this a scam?",
        );
        await shots(page, "practice-leak-end");
        // "Ten more" should restart Spot the leak from message 1.
        await page.click("#leak-again");
        await sleep(120);
        expect((await leakState(page)).count === "1 of 10", "Ten more didn't start again");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "PD7",
    "Practice is a safe place: storage and history are the same after every drill and Spot the leak",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, {
        events: [{ t: Date.now() - 60000, site: "chatgpt.com", type: "email", severity: "low", action: "allowed" }],
      });
      await sleep(300);
      const before = await store.get(ctx);
      const page = await openPractice();
      try {
        for (let i = 0; i < 6; i++) {
          await useMadeUpAndCheck(page);
          if (await page.$("#reveal .try-notice .btn.primary")) await page.click("#reveal .try-notice .btn.primary");
          await page.click("#next");
          await sleep(100);
        }
        for (let i = 0; i < 10; i++) {
          await page.click(i % 2 ? "#send-it" : "#change-it");
          await sleep(60);
          await page.click("#leak-next");
          await sleep(60);
        }
        expect(await page.$("#leak-end:not([hidden])"), "Spot the leak didn't end");
        await sleep(800);
        const after = await store.get(ctx);
        expect(JSON.stringify(after) === JSON.stringify(before), "storage changed during practice");
        expect((await store.events(ctx)).length === 1, "an answer was counted in the history");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check("PD8", "Spanish browser: the Spanish drills and page, and the Spanish replies are caught", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const page = await openPractice(es);
      const start = await drillState(page);
      const head = await page.evaluate(() => ({
        title: document.getElementById("title").textContent.trim(),
        name: document.querySelector(".ss-chip").textContent.trim(),
        lang: document.documentElement.lang,
      }));
      expect(head.title === "¿Qué responderías?", `title: ${head.title}`);
      expect(head.name === "Revisión de estafas", `name: ${head.name}`);
      expect(head.lang === "es", `lang: ${head.lang}`);
      expect(start.step === "Ejercicio 1 de 6: un mensaje de «tu banco»", `step: ${start.step}`);
      expect(/código de 6 cifras/.test(start.message), `message: ${start.message}`);
      const s = await useMadeUpAndCheck(page);
      expect(s.reply === "vale, el código que me mandaron es 482913", `reply: ${s.reply}`);
      expect(/Atención/.test(s.notice) && /••••••/.test(s.notice), `notice: ${s.notice}`);
      expect(/quienes lo lean aquí lo reciben/.test(s.notice), `notice: ${s.notice}`);
      expect(/Llamaré yo al número/.test(s.safer), `safer: ${s.safer}`);
      expect(s.next === "Siguiente ejercicio: «tu nieto»", `next: ${s.next}`);
      await page.click("#next");
      await sleep(150);
      await shots(page, "practice-es-drill");
      const gift = await useMadeUpAndCheck(page);
      expect(/el código de la tarjeta regalo es/.test(gift.reply), `reply: ${gift.reply}`);
      expect(/Código de tarjeta regalo \(/.test(gift.notice), `notice: ${gift.notice}`);
      await shots(page, "practice-es-reveal");
      await toLeak(page);
      const head2 = await page.evaluate(() => document.getElementById("leak-title").textContent.trim());
      expect(head2 === "¿Enviarías esto a un chatbot?", `Round 2: ${head2}`);
      await page.click("#change-it");
      await sleep(150);
      const l = await leakState(page);
      expect(l.count === "1 de 10", `count: ${l.count}`);
      expect(
        /Clotr ve (1 dato|\d+ datos) aquí|Clotr no encuentra nada privado aquí/.test(l.reveal),
        `reveal: ${l.reveal}`,
      );
      await shots(page, "practice-es-leak");
      await page.close();
    } finally {
      await es.browser.close().catch(() => {});
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  await check(
    "PD9",
    "The practice page: no serious accessibility problems in either round, light and dark, and no sideways scroll at 380px",
    async () => {
      const problems = [];
      const page = await openPractice(ctx, 380);
      try {
        await audit(page, "drill before a reply", problems);
        await useMadeUpAndCheck(page);
        await audit(page, "drill revealed", problems);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        expect(!wide, "the page scrolls sideways at 380px");
        for (let i = 0; i < 6; i++) {
          await page.click("#use-made-up");
          await page.click("#check");
          await sleep(80);
          await page.click("#next");
          await sleep(80);
        }
        await audit(page, "Spot the leak", problems);
        await page.click("#change-it");
        await sleep(150);
        await audit(page, "Spot the leak answered", problems);
        // Every one of the 24 messages fits at 380px, a long key or address included.
        const tooWide = await page.evaluate(() => {
          const shown = document.getElementById("leak-text");
          const was = shown.textContent;
          const wide = globalThis.Clotr.practice.leaks.filter((l) => {
            shown.textContent = l.text;
            return document.documentElement.scrollWidth > innerWidth;
          });
          shown.textContent = was;
          return wide.map((l) => l.id);
        });
        expect(!tooWide.length, `sideways at 380 with: ${tooWide}`);
        expect(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "sideways at 380");
        for (let i = 0; i < 10; i++) {
          if (i) await page.click("#send-it");
          await sleep(60);
          await page.click("#leak-next");
          await sleep(60);
        }
        await audit(page, "Spot the leak's end", problems);
      } finally {
        await page.close();
      }
      expect(!problems.length, problems.slice(0, 6).join(" | "));
    },
  );

  // A bare 6-digit code with nothing else around it would stay quiet in a real chat too, since Clotr can't tell
  // it's a code without context. The drill has to say that honestly, rather than show its usual "nothing found"
  // line, which would otherwise read as "that reply was fine" right after the drill's own message asked for the code.
  await check(
    "PD10",
    "Drill 1: a bare code, nothing else around it, says honestly it's the code they just asked for, since a real chat must stay quiet on a bare number alone",
    async () => {
      const page = await openPractice();
      try {
        await page.type("#reply", "526788");
        await page.click("#check");
        await waitFor(async () => (await drillState(page)).reveal, 2000);
        const s = await drillState(page);
        expect(!s.notice, `a bare code must stay quiet for real too: ${s.notice}`);
        expect(/stay quiet here too/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(/This looks like the code they just asked for/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(/A real bank never asks you to read back a code/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(/catching this one was on you/.test(s.reveal), `reveal: ${s.reveal}`);
        expect(
          /I'll call the number on the back of my card myself/.test(s.safer),
          `safer reply still shows: ${s.safer}`,
        );
        await shots(page, "practice-bare");
        // A reply that isn't shaped like the 6-digit code (here, just "42") should fall back to the plain line.
        await page.$eval("#reply", (t) => (t.value = ""));
        await page.type("#reply", "42");
        await page.click("#check");
        await sleep(200);
        const other = await drillState(page);
        expect(
          /Nothing in your reply that Clotr knows scammers ask for/.test(other.reveal),
          `too short for the code's shape: ${other.reveal}`,
        );
      } finally {
        await page.close();
      }
    },
  );
};
