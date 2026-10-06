// E2E checks: A. Protection basics: the warning dialog itself, and what each of its choices does.
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    KEY2,
    OUT,
    check,
    chooseResponse,
    clearEditor,
    clickDialogButton,
    clickSend,
    clotrActive,
    ctx,
    editorText,
    expect,
    expectNoDialog,
    path,
    pressEnter,
    readDialog,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    withSite,
  } = env;
  await check("A1", "Clotr starts on built-in AI sites (textarea, rich text, shadow DOM)", async () => {
    for (const key of ["chatgpt", "claude", "notebook"]) {
      await withSite(ctx, key, async (page) => expect(clotrActive(page), `not active on ${key}`));
    }
  });

  await check("A2", "Remove it replaces the key and records a 'redacted' event", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `my key is ${KEY}`);
      const dialog = await waitForDialog(page);
      expect(dialog, "no dialog appeared");
      expect(dialog.text.includes("AWS Access Key"), `dialog doesn't name the key type: ${dialog.text}`);
      expect(!dialog.text.includes(KEY), "dialog shows the full key");
      await page.screenshot({ path: path.join(OUT, "dialog.png") });
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `editor text: "${text}"`);
      expect(!(await readDialog(page)), "dialog still open");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      expect(/^[0-9a-f]{16}$/.test(events[0].fp), "event has no fingerprint");
    }),
  );

  await check(
    "K1",
    "Keys typed by habit never choose: Space never, Enter not right away; after a moment Enter = Hide it",
    () =>
      // A space shouldn't make the choice for the person. Only after a short delay does the dialog start
      // listening for keys, where Enter moves forward and Esc or Backspace goes back.
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx);
        await typeText(page, `my key is ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        for (const key of ["Space", "Enter", "Space"]) await page.keyboard.press(key);
        await sleep(300);
        expect(await readDialog(page), "Space/Enter right away closed the dialog");
        expect((await editorText(page)).includes(KEY), "Space/Enter right away changed the text");
        await sleep(500);
        await page.keyboard.press("Space");
        await sleep(200);
        expect(await readDialog(page), "Space chose");
        await page.keyboard.press("Enter");
        await sleep(300);
        expect(!(await readDialog(page)), "Enter didn't choose");
        const text = await editorText(page);
        expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `Enter should hide it: "${text}"`);
        // Clotr only records the event once the edit is confirmed, so I wait for it instead of reading too soon.
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length ? ev : null;
          }, 2000)) || [];
        expect(events.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "K2",
    "Esc goes back to the message (nothing chosen); the dialog returns on send; Tab to Leave it in + Enter picks it",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx);
        await typeText(page, `my key is ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        await sleep(700);
        await page.keyboard.press("Escape");
        await sleep(200);
        expect(!(await readDialog(page)), "Esc didn't go back");
        expect((await editorText(page)).includes(KEY), "Esc changed the text");
        expect((await store.events(ctx)).length === 0, "Esc recorded a choice");
        await typeText(page, " thanks");
        await expectNoDialog(page, "still editing after going back");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "sent without a choice");
        expect(await waitForDialog(page), "the dialog didn't come back on send");
        await sleep(700);
        await page.keyboard.press("Backspace");
        await sleep(200);
        expect(!(await readDialog(page)), "Backspace didn't go back");
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog on the second send");
        await sleep(700);
        await page.keyboard.press("Tab"); // → Leave it in and send
        await page.keyboard.press("Enter");
        await sleep(300);
        expect(!(await readDialog(page)), "Tab + Enter didn't choose");
        // The dialog stopped a send, so leaving it in sends it, unchanged.
        const sent =
          (await waitFor(async () => ((await sentMessages(page)).length ? sentMessages(page) : null), 2000)) || [];
        expect(sent.length === 1 && sent[0].includes(KEY), `sent: ${JSON.stringify(sent)}`);
        const events =
          (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
        expect(events.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
      }),
  );

  await check("A3", "Keep it keeps the text and lets it send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `key ${KEY}`);
      expect(await waitForDialog(page), "no dialog appeared");
      await clickDialogButton(page, "Leave it in");
      expect((await editorText(page)).includes(KEY), "text was changed");
      // This dialog came from typing, not from a send, so leaving it in shouldn't send anything on its own.
      await sleep(300);
      expect((await sentMessages(page)).length === 0, "Leave it in sent a message nobody had sent");
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1 && sent[0].includes(KEY), `sent: ${JSON.stringify(sent)}`);
      const events = await store.events(ctx);
      expect(
        events.some((e) => e.action === "allowed"),
        "no 'allowed' event",
      );
    }),
  );

  // One click on a form's send button actually fires two send attempts: the click itself, then the form's own
  // submit. The first attempt must not forget what you just allowed before the second one gets checked.
  await check("A3b", "Leave it in, then the send button of a form: it sends, and the dialog doesn't come back", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `key ${KEY}`);
      expect(await waitForDialog(page), "no dialog appeared");
      await clickDialogButton(page, "Leave it in");
      await clickSend(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1 && sent[0].includes(KEY), `sent: ${JSON.stringify(sent)}`);
      await expectNoDialog(page, "after sending");
    }),
  );

  await check("A4", "Enter right after pasting is blocked (before the dialog even shows)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY2);
      await pressEnter(page); // immediately, no waiting
      await sleep(300);
      expect((await sentMessages(page)).length === 0, "message was sent");
      expect(await waitForDialog(page), "no dialog appeared");
    }),
  );

  await check("A4b", "Send button right after pasting is blocked", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY2);
      await clickSend(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 0, "message was sent");
      expect(await waitForDialog(page), "no dialog appeared");
    }),
  );

  // When the dialog has already stopped a send, like after a settings reset before the page even opens (UB1),
  // "Leave it in and send" sends the message exactly once, unchanged, however it was originally sent: the site's
  // own send button, or Enter.
  const leaveAndSend = (site, send, value) => async (page) => {
    await typeText(page, `key ${value}`);
    await send(page); // Sent before the 400 ms pause, so this send is still held.
    expect(await waitForDialog(page), "no dialog appeared");
    expect((await sentMessages(page)).length === 0, `${site}: sent before the choice`);
    if (site === "chatgpt") await page.screenshot({ path: path.join(OUT, "dialog-held-send.png") });
    await sleep(700);
    await clickDialogButton(page, "Leave it in and send");
    const sent =
      (await waitFor(async () => ((await sentMessages(page)).length ? sentMessages(page) : null), 2000)) || [];
    expect(sent.length === 1 && sent[0].includes(value), `${site}: sent ${JSON.stringify(sent)}`);
    await sleep(500);
    expect((await sentMessages(page)).length === 1, `${site}: sent twice`);
    await expectNoDialog(page, `${site}: after sending`);
    const events = await store.events(ctx);
    expect(events.length === 1 && events[0].action === "allowed", `${site}: events ${JSON.stringify(events)}`);
  };
  await check("A4c", "Enter was held: Leave it in and send sends it with the site's send button", () =>
    resetState(ctx).then(() => withSite(ctx, "chatgpt", leaveAndSend("chatgpt", pressEnter, KEY2))),
  );
  await check("A4d", "An unlabeled send button was held: Leave it in and send clicks that button", () =>
    resetState(ctx).then(() => withSite(ctx, "iconsend", leaveAndSend("iconsend", clickSend, KEY))),
  );
  await check("A4e", "Enter was held and no send button is recognizable: Leave it in and send presses Enter", () =>
    resetState(ctx).then(() => withSite(ctx, "iconsend", leaveAndSend("iconsend", pressEnter, KEY2))),
  );

  await check("A5", "More choices → stop warning me about this kind: sets that type to Log only, still counts it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY);
      expect(await waitForDialog(page), "no dialog");
      await clickDialogButton(page, "More choices");
      await clickDialogButton(page, "Leave it in, and stop warning me about: AWS Access Key");
      expect(!(await readDialog(page)), "dialog still open");
      // Storage writes are asynchronous, so I wait for one instead of reading just once. Without the wait, A5
      // flaked about 1 run in 3.
      const responses = await waitFor(
        async () => ((await store.get(ctx, "responses")).responses?.aws_access_key === "log" ? true : null),
        2000,
      );
      expect(responses, `responses: ${JSON.stringify((await store.get(ctx, "responses")).responses)}`);
      await clearEditor(page);
      await typeText(page, KEY2);
      await expectNoDialog(page, "AWS keys were silenced");
      const counted = await waitFor(
        async () => ((await store.events(ctx)).some((e) => e.action === "suppressed") ? true : null),
        2000,
      );
      expect(counted, "silenced detection not counted");
    }),
  );

  await check("A6", "Popup → Settings → set back to Block brings the dialog back", async () => {
    await chooseResponse(ctx, "aws_access_key", "block");
    const { responses } = await store.get(ctx, "responses");
    expect(responses?.aws_access_key === "block", `responses: ${JSON.stringify(responses)}`);
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, KEY);
      expect(await waitForDialog(page), "dialog did not come back");
    });
  });

  await check("A7", "Pause stops Clotr on that site; resume restarts it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await store.set(ctx, { paused: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, KEY);
      await expectNoDialog(page, "site is paused");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "paused site should send normally");
      await store.set(ctx, { paused: {} });
      await sleep(300);
      await typeText(page, KEY2);
      // Clotr learns about the resume through a storage event, and under load that event can arrive after these
      // keystrokes. So waiting for the dialog here may also mean typing one more keystroke, which gets scanned
      // like any other.
      const dialog =
        (await waitFor(() => readDialog(page), 1500)) || (await typeText(page, " "), await waitForDialog(page));
      expect(dialog, "no dialog after resume");
    }),
  );
};
