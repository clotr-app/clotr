// E2E checks: F. Personal info in disguise. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    DIALOG_WAIT,
    OUT,
    QUIET_WAIT,
    check,
    clickDialogButton,
    ctx,
    editorText,
    expect,
    expectNoUI,
    openPopup,
    path,
    pressEnter,
    readDialog,
    readNotice,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  const DISGUISED = [
    ["(555)-555-5636", "Phone Number"],
    ["555-555-5636", "Phone Number"],
    ["call 555-5636 tonight", "Phone Number"],
    ["5555555636", "Phone Number"],
    ["fivefivefivefivefivefivefivesixthreesix", "Phone Number"],
    ["5fivefiv5five5five63six", "Phone Number"],
    ["5fivefive5five5five63six", "Phone Number"],
    ["call me at five five five, five five five, five six three six", "Phone Number"],
    ["my social is one two three four five six seven eight nine", "US Social Security Number"],
    ["write to me at bob at gmail dot com", "Email Address"],
    ["bob(at)example(dot)org", "Email Address"],
    ["I live at 123 Main St, Springfield, IL 62704", "Street Address"],
    ["one twenty three main street apt 4", "Street Address"],
    ["I was born on the fourteenth of March nineteen forty eight", "Date of Birth"],
    ["DOB: 03-14-1948", "Date of Birth"],
    ["acct no. one two three four five six seven eight", "Bank Account or Routing Number"],
    ["Medicare number 1EG4-TE5-MK73", "Medicare Number"],
    ["call five five five, five fifty five, fifty six thirty six", "Phone Number"],
    ["555-555-O636", "Phone Number"],
    ["London office: +44 20 7946 0958", "Phone Number"],
    ["DATABASE_URL is postgres://admin:S3cr3tPw@db.prod.internal:5432/app", "Connection String"],
    // Sound-alikes only, and many at the edges
    ["number is too fore won too fore won fore too won too ok?", "Phone Number"],
    ["number is fore too won seve zeero seve zeero thre too fiv ok?", "Phone Number"],
  ];
  await check("F1-7", `Disguised phone/SSN/email detected and fully redacted (${DISGUISED.length} forms)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      // All forms go in one message with one Hide it, which takes one wait instead of one per form. A form that
      // wasn't detected, or wasn't fully hidden, leaves its digits or number words behind. Each form is also
      // checked on its own in the unit tests.
      await typeText(page, DISGUISED.map(([input]) => input).join("\n"));
      const ui = await waitFor(
        async () => ((await readDialog(page)) ? "dialog" : (await readNotice(page)) ? "notice" : null),
        DIALOG_WAIT,
      );
      expect(ui, "nothing shown for the disguised details");
      await clickDialogButton(page, "Hide it", ui === "notice" ? readNotice : readDialog);
      const after = await editorText(page);
      const covered = (after.match(/\[REDACTED/g) || []).length;
      // Forms that hold the same value share one label, since "555-555-5636" is inside "(555)-555-5636".
      expect(
        covered >= DISGUISED.length - 2 && !/\d{3}|five|three|gmail|example|\bfore\b|\bzeero\b/i.test(after),
        `after Hide it (${covered} hidden): "${after.replace(/\n/g, " / ")}"`,
      );
    }),
  );

  const ORDINARY = [
    "someone phoned at noon",
    "I have 2 cats and 3 dogs",
    "I work at google dot com",
    "the invoice was $4,250,000",
    "sixty seven people from Ohio",
    "meet me on 2026-09-23 at 10:30",
    "my password is incorrect, how do I reset it?",
    "reset your password: click the link",
    "a 5 star place to eat",
    "it's a 5 minutes drive from here",
    "I walked down Main Street",
    "the meeting is 3/14/2026",
    "my birthday is coming up soon",
    "I have 2 accounts at the bank",
    "the license is MIT",
    "I want to go for a walk at 5 to 6",
    "we won 2 to 1 and ate for free",
    "the score went from +3 to +7",
    "version 10.2.3 and build 10.0.19041.1",
    "the local news and internal memo",
    "Mix two to four for one to two minutes",
    "for two to four for one to two for three",
  ];
  // Each sentence is also in tests/corpus/normal-messages.txt, checked one by one in the unit tests. Here they
  // go through the real chat box together, which takes one wait instead of twenty.
  await check("F8", `Ordinary sentences don't trigger the dialog (${ORDINARY.length} sentences)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, ORDINARY.join("\n"));
      await sleep(QUIET_WAIT);
      const dialog = await readDialog(page);
      const notice = await readNotice(page);
      expect(!dialog && !notice, `alarm: ${(dialog || notice)?.text}`);
    }),
  );

  // Checks a detail of a kind that warns from the start: the notice names it, Hide it covers all of it, the
  // message goes without it, and only the kind and a fingerprint are stored, never the number.
  const hidesNewKind = (text, value, name, id) =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, text);
      const notice = await waitForNotice(page);
      expect(notice?.text.includes(name), `notice: ${notice?.text}`);
      await clickDialogButton(page, "Hide it", readNotice);
      const after = await waitFor(async () => {
        const t = await editorText(page);
        return t.includes("[REDACTED") ? t : null;
      }, 3000);
      expect(after?.includes(`[REDACTED ${name.toUpperCase()}]`), `after Hide it: ${await editorText(page)}`);
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1 && !sent[0].includes(value), `sent: ${JSON.stringify(sent)}`);
      const events = await waitFor(async () => {
        const e = (await store.events(ctx)).filter((x) => x.type === id && x.action === "redacted");
        return e.length ? e : null;
      }, 4000);
      expect(/^[0-9a-f]{16}$/.test(events?.[0]?.fp || ""), `events: ${JSON.stringify(await store.events(ctx))}`);
      const stored = JSON.stringify(await store.get(ctx, null));
      expect(!stored.includes(value), "the value itself is in storage");
    });

  await check("VIN1", "A VIN warns; Hide it covers it; only its kind and fingerprint are stored", () =>
    hidesNewKind(
      "my VIN is 1HGCM82633A004352, is there an open recall?",
      "1HGCM82633A004352",
      "Vehicle Identification Number",
      "vin",
    ),
  );

  // A VIN pasted on its own, with no label and no vehicle word, used to show nothing until the Heads up note
  // was added to name it. The same code with its check digit wrong still shows nothing.
  await check(
    "VIN2",
    "A VIN pasted on its own shows the Heads up note naming it; with a wrong check digit, nothing shows",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "1HGCM82643A004352");
        await expectNoUI(page, "a VIN-shaped code with a wrong check digit");
        await env.clearEditor(page);
        await typeText(page, "1HGCM82633A004352");
        const notice = await waitForNotice(page);
        await page.screenshot({ path: path.join(OUT, "vin-alone.png") });
        expect(
          notice?.text.includes("Heads up") && notice.text.includes("Vehicle Identification Number"),
          `notice: ${notice?.text}`,
        );
      }),
  );

  await check("SID1", "A student ID warns; Hide it covers it; only its kind and fingerprint are stored", () =>
    hidesNewKind(
      "Write to my professor: my student ID is S1234567 and I missed the quiz.",
      "S1234567",
      "Student ID Number",
      "student_id",
    ),
  );

  // License plates start as Just count. Nothing shows, the message goes, and the plate is counted by its kind
  // and fingerprint only.
  await check("PLT1", "A license plate shows nothing (Just count): the message goes, counted without the plate", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "my licence plate is AB12 CDE, can you help me appeal the parking fine?");
      await expectNoUI(page, "a license plate, which starts as Just count");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "message not sent");
      const events =
        (await waitFor(async () => {
          const e = await store.events(ctx);
          return e.length ? e : null;
        }, 3000)) || [];
      expect(
        events.length === 1 &&
          events[0].type === "license_plate" &&
          events[0].action === "suppressed" &&
          /^[0-9a-f]{16}$/.test(events[0].fp),
        `events: ${JSON.stringify(events)}`,
      );
      const stored = JSON.stringify(await store.get(ctx, null));
      expect(!/AB12 ?CDE/i.test(stored), "the plate is in storage");
    }),
  );

  // Settings shows the new kinds where people look for them. Plates sit at Just count, the default, so they
  // aren't marked as changed; VINs and student IDs sit at Warn; and the personal group's Default note says a
  // few kinds just count.
  await check(
    "PLT2",
    "Settings lists the new kinds: License Plate at Just count by default, VIN and student ID at Warn",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { advanced: true });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
      const shown = await popup.evaluate(() => {
        const row = (id) => document.querySelector(`select[data-pattern="${id}"]`);
        const plate = row("license_plate");
        const group = document.querySelector('select[data-group="personal"]');
        return {
          plate: [plate?.value, plate?.classList.contains("changed"), plate?.selectedOptions[0].textContent],
          warn: [row("vin")?.value, row("student_id")?.value],
          group: [group.value, group.options[0].textContent],
        };
      });
      // Shows the popup at its real width, around the new rows, dark theme first.
      await popup.setViewport({ width: 380, height: 600 });
      await popup.evaluate(() =>
        document.querySelector('select[data-pattern="student_id"]').scrollIntoView({ block: "center" }),
      );
      for (const theme of ["dark", "light"]) {
        await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
        await sleep(200);
        await popup.screenshot({ path: path.join(OUT, `popup-new-kinds-${theme}.png`) });
      }
      await popup.close();
      await store.set(ctx, { advanced: false });
      expect(
        shown.plate[0] === "log" && !shown.plate[1] && shown.plate[2] === "Just count (default)",
        `the plate's row: ${JSON.stringify(shown.plate)}`,
      );
      expect(
        shown.warn.every((v) => v === "warn"),
        `VIN and student ID: ${JSON.stringify(shown.warn)}`,
      );
      expect(
        shown.group[0] === "default" && shown.group[1] === "Default (warn, a few just count)",
        `the personal group: ${JSON.stringify(shown.group)}`,
      );
    },
  );

  // Gamer tags are counted quietly, and only after a gaming-account label.
  const { EXT, clearEditor, fs, launch } = env;

  await check(
    "GT1",
    "A gamer tag shows nothing (Just count): the message goes, counted without the tag; a handle in chat isn't one",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        // With no gaming-account label, handles in everyday chat show nothing and aren't counted.
        await typeText(page, "add me on Discord, I'm @luna.moon there. My tag is still on the jacket, lol");
        await expectNoUI(page, "a handle without a gaming label");
        await pressEnter(page);
        await sleep(300);
        expect((await store.events(ctx)).length === 0, "an everyday handle was counted");
        await clearEditor(page);
        await typeText(page, "my Xbox gamertag is ShadowHunter42, can you write a short bio for my stream?");
        await expectNoUI(page, "a gamer tag, which starts as Just count");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 2, "a message didn't go");
        const events =
          (await waitFor(async () => {
            const e = await store.events(ctx);
            return e.length ? e : null;
          }, 3000)) || [];
        expect(
          events.length === 1 &&
            events[0].type === "gamer_tag" &&
            events[0].action === "suppressed" &&
            /^[0-9a-f]{16}$/.test(events[0].fp),
          `events: ${JSON.stringify(events)}`,
        );
        const stored = JSON.stringify(await store.get(ctx, null));
        expect(!/ShadowHunter|luna\.moon/i.test(stored), "a handle is in storage");
      }),
  );

  // Settings shows the gamer tag at Just count, the default, so it isn't marked as changed, next to the plate.
  const readGamerRow = (popup) =>
    popup.evaluate(() => {
      const row = document.querySelector('select[data-pattern="gamer_tag"]');
      const name = row?.closest("li")?.textContent.replace(/\s+/g, " ").trim();
      return {
        value: row?.value,
        changed: row?.classList.contains("changed"),
        label: row?.selectedOptions[0].textContent,
        name,
      };
    });
  const showGamerRow = async (popup, file) => {
    await popup.setViewport({ width: 380, height: 600 });
    await popup.evaluate(() =>
      document.querySelector('select[data-pattern="gamer_tag"]').scrollIntoView({ block: "center" }),
    );
    for (const theme of ["dark", "light"]) {
      await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(200);
      await popup.screenshot({ path: path.join(OUT, `${file}-${theme}.png`) });
    }
  };

  await check("GT2", 'Settings lists Gamer Tag at "Just count (default)"', async () => {
    await resetState(ctx, {});
    await store.set(ctx, { advanced: true });
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
    const shown = await readGamerRow(popup);
    await showGamerRow(popup, "popup-gamer-tag");
    await popup.close();
    await store.set(ctx, { advanced: false });
    expect(
      shown.value === "log" && !shown.changed && shown.label === "Just count (default)" && /Gamer Tag/.test(shown.name),
      `the gamer tag's row: ${JSON.stringify(shown)}`,
    );
  });

  await check("GT3", "Spanish browser: the gamer tag's row has its Spanish name, at Just count", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await sleep(200);
      await es.worker.evaluate(() => chrome.storage.local.set({ advanced: true }));
      const popup = await openPopup(es);
      await popup.click("#tab-settings");
      await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
      const shown = await readGamerRow(popup);
      await showGamerRow(popup, "popup-gamer-tag-es");
      await popup.close();
      expect(
        shown.value === "log" && !shown.changed && /Nombre de jugador \(gamertag\)/.test(shown.name),
        `the Spanish row: ${JSON.stringify(shown)}`,
      );
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });
};
