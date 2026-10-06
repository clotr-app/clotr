// E2E checks: TW. The office training walkthrough is eight self-paced steps built on the practice page's own
// sandbox. The real detect() answers every reveal, and nothing typed here is stored or sent.
"use strict";

module.exports = async function (env) {
  const { EXT, OUT, check, ctx, expect, fs, launch, path, resetState, sleep, store, waitFor } = env;

  const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

  // training.html reads chrome.storage.managed itself, in its own page's JS realm, the same way policy.html does
  // (PA1). The worker's managed-policy stub doesn't reach that realm, so this stubs it on the page before it navigates.
  async function openTraining(c = ctx, { policy = null, search = "", width = 700, lang = null } = {}) {
    const page = await c.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`training.html${lang ? ` (${lang})` : ""} error: ${err.message}`));
    if (policy) await page.evaluateOnNewDocument((p) => (chrome.storage.managed.get = async () => p), policy);
    await page.setViewport({ width, height: 900 });
    const host = new URL(c.swTarget.url()).host;
    await page.goto(`chrome-extension://${host}/training.html${search}`);
    await sleep(400);
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  // The shell, as every step shows it.
  const shellState = (page) =>
    page.evaluate(() => ({
      stepOf: document.getElementById("tw-step-of")?.textContent.trim(),
      progress: document.querySelectorAll("#tw-progress span.done").length,
      next: document.getElementById("tw-next")?.hidden ? "" : document.getElementById("tw-next").textContent.trim(),
      nextDisabled: document.getElementById("tw-next")?.disabled,
      backHidden: document.getElementById("tw-back")?.hidden,
      title: document.getElementById("tw-step-title")?.textContent.trim(),
      bodyText: document.getElementById("tw-body")?.innerText.trim() || "",
      resultText: document.getElementById("tw-try-result")?.innerText.trim() || "",
      revealText: document.getElementById("tw-leak-reveal")?.innerText.trim() || "",
      topicsText: document.getElementById("tw-done-topics")?.innerText.trim() || "",
    }));

  async function next(page) {
    await page.click("#tw-next");
    await sleep(150);
  }
  async function back(page) {
    await page.click("#tw-back");
    await sleep(150);
  }

  // A full-page picture at a width and theme, following practice.js's own pattern: 380 is the phone-width shot, 1280 the wide one.
  async function shotFull(page, name, width, theme) {
    await page.bringToFront();
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await page.setViewport({ width, height: 800 });
    await sleep(250);
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  }
  async function shots(page, base) {
    for (const [width, theme] of [
      [380, "dark"],
      [380, "light"],
      [1280, "dark"],
      [1280, "light"],
    ])
      await shotFull(page, `${base}-${width}-${theme}.png`, width, theme);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }

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
    "TW1",
    "Step 1, Why: the neutral walkthrough's two lines, step-of text, progress at 1 of 8, and Back hidden",
    async () => {
      const page = await openTraining();
      try {
        const s = await shellState(page);
        expect(s.stepOf === "Step 1 of 8: Why this matters", `step-of: ${s.stepOf}`);
        expect(s.progress === 1, `progress: ${s.progress}`);
        expect(s.backHidden, "Back shown on the first step");
        expect(s.next === "Next", `next: ${s.next}`);
        expect(
          /Anything typed into an AI chat tool can leave your hands for good/.test(s.bodyText),
          `body: ${s.bodyText}`,
        );
        expect(
          !/Office of Professional Responsibility/.test(s.bodyText),
          `IRS line shown without tax mode: ${s.bodyText}`,
        );
        await shots(page, "training-why");

        // Back works too, and nothing breaks going forward then back.
        await next(page);
        await back(page);
        const s2 = await shellState(page);
        expect(s2.stepOf === "Step 1 of 8: Why this matters", `step-of after Back: ${s2.stepOf}`);
        expect(s2.backHidden, "Back still shown after returning to step 1");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW2",
    "?for=tax turns tax mode on: the IRS line, its source and a link to irs.gov, opened in a new tab",
    async () => {
      const page = await openTraining(ctx, { search: "?for=tax" });
      try {
        const s = await shellState(page);
        expect(/IRS Office of Professional Responsibility/.test(s.bodyText), `body: ${s.bodyText}`);
        expect(/client data out of public AI tools/.test(s.bodyText), `body: ${s.bodyText}`);
        const link = await page.evaluate(() => {
          const a = document.querySelector(".tw-source a");
          return a && { href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() };
        });
        expect(link && /^https:\/\/www\.irs\.gov\//.test(link.href), `link: ${JSON.stringify(link)}`);
        expect(link.target === "_blank" && link.rel.includes("noopener"), `link opens safely: ${JSON.stringify(link)}`);
        expect(
          /Introductory Guidelines for Responsible AI Use in Federal Tax Practice/.test(link.text),
          `source: ${link.text}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW3",
    "Step 2, Try it: the made-up example, Clotr's real masked warning, Hide it, then Edit it, then Send anyway, each explained",
    async () => {
      const page = await openTraining();
      try {
        await next(page);
        let s = await shellState(page);
        expect(s.stepOf === "Step 2 of 8: Try it", `step-of: ${s.stepOf}`);
        expect(/Type this made-up Social Security number/.test(s.bodyText), `body: ${s.bodyText}`);

        // Something with nothing to catch first.
        await page.type("#tw-try-text", "just saying hello");
        await page.click("#tw-try-send");
        await sleep(150);
        s = await shellState(page);
        expect(/Clotr finds nothing to catch here/.test(s.bodyText), `nothing: ${s.bodyText}`);

        // The made-up example triggers a real warning, masked.
        await page.$eval("#tw-try-text", (t) => (t.value = ""));
        await page.click("#tw-try-use");
        await page.click("#tw-try-send");
        await sleep(150);
        s = await shellState(page);
        expect(/Heads up/.test(s.resultText), `notice: ${s.resultText}`);
        expect(/219-…99/.test(s.resultText) || /•{9,11}/.test(s.resultText), `masked SSN: ${s.resultText}`);
        // The instructional bubble above always shows the made-up number, so it can be copied. Only the notice itself has to mask it.
        expect(!s.resultText.includes("219-09-9999"), `the full number shown in the notice: ${s.resultText}`);
        await shots(page, "training-try-notice");

        // Hide it.
        await page.click(".try-notice .btn.primary");
        await sleep(150);
        s = await shellState(page);
        expect(/Hidden\. On a real chat, the AI would never see the number/.test(s.bodyText), `hide: ${s.bodyText}`);
        const hidden = await page.$eval("#tw-try-text", (t) => t.value);
        expect(hidden.includes("[REDACTED") && !hidden.includes("219-09-9999"), `textarea after Hide it: ${hidden}`);

        // Start over, then Edit it.
        await page.click("#tw-try-reset");
        await sleep(150);
        await page.click("#tw-try-use");
        await page.click("#tw-try-send");
        await sleep(150);
        await page.click(".try-notice .btn:not(.primary):not(.leave)");
        await sleep(150);
        s = await shellState(page);
        expect(/Back to your message, unchanged/.test(s.bodyText), `edit: ${s.bodyText}`);
        const edited = await page.$eval("#tw-try-text", (t) => t.value);
        expect(edited.includes("219-09-9999"), `textarea after Edit it: ${edited}`);

        // Send anyway (Leave it in).
        await page.click("#tw-try-send");
        await sleep(150);
        await page.click(".try-notice .btn.leave");
        await sleep(150);
        s = await shellState(page);
        expect(
          /Sent\. On a real chat, Clotr's warning never blocks a message by itself/.test(s.resultText),
          `leave: ${s.resultText}`,
        );
        expect(/Sure, I've noted that down/.test(s.resultText), `pretend AI reply: ${s.resultText}`);
        expect(!s.resultText.includes("219-09-9999"), `the pretend reply echoed the number: ${s.resultText}`);
      } finally {
        await page.close();
      }
    },
  );

  const TEAM_KINDS = {
    kinds: [
      { name: "Client file numbers", formats: ["CF-######"], response: "block" },
      { name: "Matter codes", words: ["Project Falcon Secret Codeword"], response: "warn" },
      { name: "Extra kind", response: "log" },
      { name: "A fourth kind, past the top three", response: "warn" },
    ],
  };

  await check(
    "TW4",
    "Step 3, Your office's words: no policy explains what an office can add; with one, only names, counts and responses show, never a real word",
    async () => {
      const none = await openTraining();
      try {
        await next(none);
        await next(none);
        const s = await shellState(none);
        expect(/Your office hasn't added any of its own words yet/.test(s.bodyText), `no policy: ${s.bodyText}`);
      } finally {
        await none.close();
      }

      const page = await openTraining(ctx, { policy: TEAM_KINDS });
      try {
        await next(page);
        await next(page);
        const s = await shellState(page);
        expect(/Your office has added 4 of its own/.test(s.bodyText), `with policy: ${s.bodyText}`);
        expect(/Client file numbers: Ask before sending/.test(s.bodyText), `kind 1: ${s.bodyText}`);
        expect(/Matter codes: Warn/.test(s.bodyText), `kind 2: ${s.bodyText}`);
        expect(/Extra kind: Just count/.test(s.bodyText), `kind 3: ${s.bodyText}`);
        expect(!/A fourth kind/.test(s.bodyText), "more than the top 3 kinds shown");
        expect(!s.bodyText.includes("Project Falcon Secret Codeword"), "a real watch word leaked into the demo");
        expect(!s.bodyText.includes("CF-######"), "a real watch format leaked into the demo");
        await shots(page, "training-words");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW5",
    "Step 4, Spot the leak: five of the drills' own messages, each reveal matching the real engine, then the count",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 3; i++) await next(page);
        let withSome = 0;
        let changed = 0;
        for (let i = 0; i < 5; i++) {
          const text = await page.$eval("#tw-leak-text", (b) => b.textContent);
          const found = await page.evaluate(
            (t) => globalThis.Clotr.detect(t).flatMap((r) => r.matches.map((m) => [r.name, m])),
            text,
          );
          const choice = i % 2 ? "#tw-change-it" : "#tw-send-it";
          await page.click(choice);
          await sleep(120);
          const s = await shellState(page);
          if (found.length) {
            withSome++;
            if (choice === "#tw-change-it") changed++;
            expect(/Clotr sees (1 detail|\d+ details) here/.test(s.revealText), `reveal: ${s.revealText}`);
            for (const [name, value] of found) {
              expect(s.revealText.includes(name), `no chip for ${name}: ${s.revealText}`);
              // The typed message above always shows its raw text, since spotting the leak is the point.
              // Only Clotr's own reveal card has to mask what it found.
              if (value.length > 4) expect(!s.revealText.includes(value), `the reveal shows a value in full: ${value}`);
            }
            if (withSome === 1) await shots(page, "training-leak");
          } else {
            expect(/Clotr finds nothing private here/.test(s.revealText), `nothing: ${s.revealText}`);
          }
          await page.click("#tw-leak-next");
          await sleep(120);
        }
        expect(withSome > 0 && withSome < 5, `${withSome} of 5 had something private (expect a mix)`);
        const end = await shellState(page);
        expect(
          end.bodyText.includes(`You'd have changed ${changed} of the ${withSome} that had something private.`),
          `end: ${end.bodyText}`,
        );
        expect(/Nothing about your answers is kept/.test(end.bodyText), `end: ${end.bodyText}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW6",
    "Step 5, the AI-tool checklist: three questions, each answerable Yes, No or Not sure, no score",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 4; i++) await next(page);
        const s = await shellState(page);
        expect(/Does it use your chats to train its AI/.test(s.bodyText), `checklist: ${s.bodyText}`);
        expect(/How long does it keep your chats/.test(s.bodyText), `checklist: ${s.bodyText}`);
        expect(/Does it offer a business or team plan/.test(s.bodyText), `checklist: ${s.bodyText}`);
        const items = await page.$$(".tw-check-item");
        expect(items.length === 3, `checklist items: ${items.length}`);
        const answers = await page.$$eval(".tw-check-item", (rows) =>
          rows.map((r) => [...r.querySelectorAll(".answer")].map((b) => b.textContent.trim())),
        );
        expect(
          answers.every((a) => JSON.stringify(a) === JSON.stringify(["Yes", "No", "Not sure"])),
          `answers: ${JSON.stringify(answers)}`,
        );
        await page.evaluate(() => document.querySelectorAll(".tw-check-item")[1].querySelector(".answer").click()); // Yes
        await sleep(120);
        const pressed = await page.evaluate(() =>
          document.querySelectorAll(".tw-check-item")[1].querySelector(".answer").getAttribute("aria-pressed"),
        );
        expect(pressed === "true", `pressed after answering: ${pressed}`);
        await shots(page, "training-checklist");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW7",
    "Step 6, Check AI's work: flagging the wrong figure and the invented citation reveals a correct result; missing both reveals a missed one",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 5; i++) await next(page);
        let s = await shellState(page);
        expect(
          /click the figure that's wrong and the citation that doesn't exist/.test(s.bodyText),
          `lead: ${s.bodyText}`,
        );
        expect(
          /23 people signed in and 19 filled in the form, so 42 people took part/.test(s.bodyText),
          `answer: ${s.bodyText}`,
        );
        await page.click("#tw-flag-figure");
        await page.click("#tw-flag-citation");
        await page.click("#tw-acc-check");
        await sleep(150);
        s = await shellState(page);
        expect(/You found the wrong figure\./.test(s.bodyText), `found figure: ${s.bodyText}`);
        expect(/You found the made-up citation\./.test(s.bodyText), `found citation: ${s.bodyText}`);
        expect(/The real total: 23/.test(s.bodyText), `correct figure: ${s.bodyText}`);
        await shots(page, "training-accuracy-found");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW7c",
    "Step 6 gives nothing away: every clickable part looks the same until clicked, and a right part flagged is called out",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 5; i++) await next(page);
        const looks = await page.$$eval(".flag-target", (els) =>
          els.map((e) => {
            const cs = getComputedStyle(e);
            return [cs.fontWeight, cs.backgroundColor, cs.color, cs.textDecorationLine, cs.textDecorationStyle].join(
              "|",
            );
          }),
        );
        expect(looks.length >= 5, `at least five clickable parts, got ${looks.length}`);
        expect(new Set(looks).size === 1, `all look the same before any click: ${JSON.stringify(looks)}`);
        const bold = await page.$eval(".flag-target", (e) => Number(getComputedStyle(e).fontWeight));
        const text = await page.$eval(".tw-ai-answer", (e) => Number(getComputedStyle(e).fontWeight));
        expect(bold === text, `a clickable part isn't bolder than the answer around it (${bold} vs ${text})`);
        await page.click('.flag-target[data-key="decoy-0"]');
        await page.click("#tw-acc-check");
        await sleep(150);
        const s = await shellState(page);
        expect(/“23” was right as written\./.test(s.bodyText), `decoy called out: ${s.bodyText}`);
      } finally {
        await page.close();
      }
    },
  );

  await check("TW7b", "Step 6: missing both flags reveals both as missed", async () => {
    const page = await openTraining();
    try {
      for (let i = 0; i < 5; i++) await next(page);
      await page.click("#tw-acc-check");
      await sleep(150);
      const s = await shellState(page);
      expect(/You missed the wrong figure\./.test(s.bodyText), `missed figure: ${s.bodyText}`);
      expect(/You missed the made-up citation\./.test(s.bodyText), `missed citation: ${s.bodyText}`);
    } finally {
      await page.close();
    }
  });

  await check(
    "TW8",
    "Step 7, the check: five questions, each explained right away, and the last question offers to see the score",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 6; i++) await next(page);
        for (let i = 0; i < 5; i++) {
          let s = await shellState(page);
          expect(s.bodyText.includes(`Question ${i + 1} of 5`), `question ${i + 1}: ${s.bodyText}`);
          expect(s.nextDisabled, `Next enabled before an answer, question ${i + 1}`);
          await page.click(".tw-quiz-option:nth-child(1)");
          await sleep(120);
          s = await shellState(page);
          expect(/Right\.|Not quite\./.test(s.bodyText), `no explanation shown, question ${i + 1}: ${s.bodyText}`);
          if (i === 2) await shots(page, "training-quiz");
          if (i < 4) {
            expect(s.next === "Next question", `next, question ${i + 1}: ${s.next}`);
            await next(page);
          } else {
            expect(s.next === "See your score", `next on the last question: ${s.next}`);
          }
        }
        await next(page); // to the completion step
        const s = await shellState(page);
        expect(s.stepOf === "Step 8 of 8: Completion", `after the last question: ${s.stepOf}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW9",
    "Step 8, Completion: a typed name appears in the printout, the score, the topics, and the plain 'completed' line — never 'certified'",
    async () => {
      const page = await openTraining();
      try {
        for (let i = 0; i < 6; i++) await next(page); // step 1 (Why) through step 7 (the check)
        for (let i = 0; i < 5; i++) {
          await page.click(".tw-quiz-option:nth-child(1)");
          await sleep(100);
          await next(page); // Next question each time, then See your score on the fifth, landing on Completion
        }
        await page.type("#tw-name", "Alex Example");
        await sleep(150);
        const s = await shellState(page);
        expect(s.bodyText.includes("Alex Example"), `name in printout: ${s.bodyText}`);
        expect(s.bodyText.includes("completed the Clotr AI walkthrough"), `completed line: ${s.bodyText}`);
        expect(!/certif/i.test(s.bodyText), `'certified' shown: ${s.bodyText}`);
        expect(/Check score: \d of 5/.test(s.bodyText), `score line: ${s.bodyText}`);
        expect(s.bodyText.includes("Topics covered:"), `topics heading: ${s.bodyText}`);
        expect(s.topicsText.includes("Why this matters"), `topics list: ${s.topicsText}`);
        expect(
          !s.topicsText.includes("Completion"),
          `the completion step's own title listed as a topic: ${s.topicsText}`,
        );
        expect(await page.$("#tw-body button"), "no print button"); // Print or save as PDF
        await shots(page, "training-completion");
        // Clearing the name happens on pagehide, which isn't tested here directly.
        // The unit tests already hold training.js to never writing storage, sending messages or fetching.
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TW10",
    "A safe place: storage and history are unchanged after a full run through all eight steps",
    async () => {
      await store.set(ctx, {
        events: [{ t: Date.now() - 60000, site: "chatgpt.com", type: "email", severity: "low", action: "allowed" }],
      });
      await sleep(300);
      const before = await store.get(ctx);
      const page = await openTraining();
      try {
        await next(page); // step 2, Try it
        await page.type("#tw-try-text", "ok, my number is 219-09-9999");
        await page.click("#tw-try-send");
        await sleep(150);
        await next(page); // step 3
        await next(page); // step 4
        for (let i = 0; i < 5; i++) {
          await page.click(i % 2 ? "#tw-change-it" : "#tw-send-it");
          await sleep(80);
          await page.click("#tw-leak-next");
          await sleep(80);
        }
        await next(page); // step 5
        await next(page); // step 6
        await page.click("#tw-acc-check");
        await next(page); // step 7, the check
        for (let i = 0; i < 5; i++) {
          await page.click(".tw-quiz-option:nth-child(1)");
          await sleep(80);
          await next(page); // Next question each time, then See your score on the fifth, landing on step 8
        }
        await page.type("#tw-name", "Someone");
        await sleep(300);
        const after = await store.get(ctx);
        expect(JSON.stringify(after) === JSON.stringify(before), "storage changed during the walkthrough");
        expect((await store.events(ctx)).length === 1, "an answer was counted in the history");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "TW11",
    "Spanish browser: the title, lead and step text, and the tax-mode IRS line, in Spanish",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const page = await openTraining(es, { search: "?for=tax", lang: "es" });
        const head = await page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang }));
        expect(head.title === "El recorrido de IA", `title: ${head.title}`);
        const s = await shellState(page);
        expect(/Paso 1 de 8: Por qué importa/.test(s.stepOf), `step-of: ${s.stepOf}`);
        expect(/Oficina de Responsabilidad Profesional del IRS/.test(s.bodyText), `IRS line: ${s.bodyText}`);
        expect(s.backHidden, "Back shown on the first step");
        await shots(page, "training-es-why");
        await page.close();
      } finally {
        await es.browser.close().catch(() => {});
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check(
    "TW12",
    "No serious accessibility problems across the steps, light and dark, and no sideways scroll at 380px",
    async () => {
      const problems = [];
      const page = await openTraining(ctx, { width: 380 });
      try {
        await audit(page, "step 1", problems);
        await next(page);
        await audit(page, "step 2", problems);
        await page.click("#tw-try-use");
        await page.click("#tw-try-send");
        await sleep(150);
        await audit(page, "step 2 revealed", problems);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        expect(!wide, "the page scrolls sideways at 380px");
      } finally {
        await page.close();
      }
      expect(!problems.length, problems.slice(0, 6).join(" | "));
    },
  );

  await check(
    "TW13",
    "Doors in: practice.html, helper.html and policy.html each link to the walkthrough; the popup's door is the gated 'Office training' button only",
    async () => {
      const practiceHtml = fs.readFileSync(path.join(EXT, "practice.html"), "utf8");
      expect(/<a href="training\.html"/.test(practiceHtml), "no link to training.html on practice.html");
      const helperHtml = fs.readFileSync(path.join(EXT, "helper.html"), "utf8");
      expect(/id="open-training"/.test(helperHtml), "no Office training button on helper.html");
      const helperJs = fs.readFileSync(path.join(EXT, "helper.js"), "utf8");
      expect(
        /open-training.*training\.html/.test(helperJs.replace(/\n/g, " ")),
        "open-training doesn't open training.html",
      );
      const policyHtml = fs.readFileSync(path.join(EXT, "policy.html"), "utf8");
      expect(/<a href="training\.html"/.test(policyHtml), "no link to training.html on policy.html");
      const popupHtml = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
      expect(
        /id="managed-training"[^>]*>/.test(popupHtml) && /id="managed-note"[^>]*hidden/.test(popupHtml),
        "the popup's Office training button should live inside the hidden-by-default managed-note banner",
      );
      const popupJs = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
      expect(
        /managed-training.*training\.html/.test(popupJs.replace(/\n/g, " ")),
        "managed-training doesn't open training.html",
      );
    },
  );

  await check(
    "TW14",
    "The walkthrough opens itself once a team policy turns up, never again, and never without one",
    async () => {
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ requiredResponses: { phone_number: "block" } });
      });
      await resetState(ctx);
      await ctx.worker.evaluate(() => chrome.storage.local.remove("trainingOffered"));
      try {
        const before = (await ctx.browser.pages()).length;
        await ctx.worker.evaluate(() => offerTeamTraining());
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("training.html")) : null;
        }, 3000);
        expect(opened, "the walkthrough didn't open itself for a fresh team policy");
        await opened?.close();

        const offeredNow = await ctx.worker.evaluate(
          async () => (await chrome.storage.local.get("trainingOffered")).trainingOffered,
        );
        expect(offeredNow === true, "trainingOffered wasn't recorded after the walkthrough opened");

        const beforeAgain = (await ctx.browser.pages()).length;
        await ctx.worker.evaluate(() => offerTeamTraining());
        await sleep(300);
        expect(
          (await ctx.browser.pages()).length === beforeAgain,
          "the walkthrough opened a second time for the same policy",
        );

        await resetState(ctx);
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = async () => ({});
        });
        const beforeNoPolicy = (await ctx.browser.pages()).length;
        await ctx.worker.evaluate(() => offerTeamTraining());
        await sleep(300);
        expect((await ctx.browser.pages()).length === beforeNoPolicy, "the walkthrough opened without any team policy");
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
    "TW15",
    "Settings keeps its own door to the walkthrough open, as 'Office training', only with a team policy",
    async () => {
      const popup = await ctx.browser.newPage();
      popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
      await popup.evaluateOnNewDocument(() => {
        chrome.storage.managed.get = async () => ({ requiredResponses: { phone_number: "block" } });
      });
      await popup.setViewport({ width: 380, height: 700 });
      await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
      await popup.waitForSelector("#hero-value");
      await sleep(400);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const visible = await popup.evaluate(() => ({
          noteHidden: document.getElementById("managed-note").hidden,
          buttonThere: Boolean(document.getElementById("managed-training")),
        }));
        expect(!visible.noteHidden, "the managed banner should show with a team policy");
        expect(visible.buttonThere, "no Office training button in the managed banner");
        const before = (await ctx.browser.pages()).length;
        await popup.click("#managed-training");
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("training.html")) : null;
        }, 3000);
        expect(opened, "Office training didn't open the walkthrough");
        await opened?.close();
      } finally {
        await popup.close();
      }

      const popupNoPolicy = await ctx.browser.newPage();
      popupNoPolicy.on("pageerror", (err) => ctx.problems.push(`popup (no policy) error: ${err.message}`));
      await popupNoPolicy.evaluateOnNewDocument(() => {
        chrome.storage.managed.get = async () => ({});
      });
      await popupNoPolicy.setViewport({ width: 380, height: 700 });
      await popupNoPolicy.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
      await popupNoPolicy.waitForSelector("#hero-value");
      await sleep(400);
      try {
        await popupNoPolicy.click("#tab-settings");
        await sleep(200);
        const noteHidden = await popupNoPolicy.evaluate(() => document.getElementById("managed-note").hidden);
        expect(noteHidden, "the managed banner (and its Office training button) showed without a team policy");
      } finally {
        await popupNoPolicy.close();
      }
    },
  );
};
