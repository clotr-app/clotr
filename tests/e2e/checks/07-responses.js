// E2E checks: R. Responses. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    KEY2,
    OUT,
    TYPED_VALUES,
    activeBadge,
    auditShadow,
    check,
    chooseResponse,
    clearEditor,
    clickDialogButton,
    clickSend,
    ctx,
    editorText,
    evalInClotr,
    expect,
    expectNoUI,
    fs,
    openExtPage,
    openPopup,
    path,
    pressEnter,
    readDialog,
    readNotice,
    resetState,
    restoreBackgroundReads,
    seedEvents,
    sentMessages,
    shot,
    shotAt,
    slowBackgroundReads,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  await check("R0", "Out of the box nothing blocks: a key shows the notice and Enter sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, `key ${KEY}`);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("AWS Access Key"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!(await readDialog(page)), "the blocking dialog appeared by default");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "message not sent");
      // Even a send that beats the warning to the screen still gets recorded, once Clotr confirms it.
      const events =
        (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
      expect(events.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R0b", "Notice → More choices → stop warning me about this kind sets that type to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 555-555-5636");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "More choices", readNotice);
      await clickDialogButton(page, "Leave it in, and stop warning me about: Phone Number", readNotice);
      expect(!(await readNotice(page)), "notice still open");
      // Storage writes happen asynchronously, so I wait for the write to land instead of just reading once.
      const responses = await waitFor(
        async () => ((await store.get(ctx, "responses")).responses?.phone_number === "log" ? true : null),
        2000,
      );
      expect(responses, `responses: ${JSON.stringify((await store.get(ctx, "responses")).responses)}`);
      await clearEditor(page);
      await typeText(page, "or 555-555-1234");
      await expectNoUI(page, "phone numbers are now Log only");
    }),
  );

  await check(
    "GEN1",
    'Notice → More choices → Keep it general: the birth date becomes "March 1948", the address its town, and nothing exact is left',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "I was born on 03/14/1948 and live at 123 Oak Street, Springfield, IL 62704");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "More choices", readNotice);
        await clickDialogButton(page, 'Keep it general: "Springfield", "March 1948"', readNotice);
        // On a busy computer the generalized text and its "redacted" event can arrive later than
        // the click handler's own wait, so I poll for the real outcome instead of trusting a fixed delay.
        const text = await waitFor(
          async () => ((await editorText(page)) === "I was born on March 1948 and live at Springfield" ? true : null),
          4000,
        );
        expect(text, `chat box: "${await editorText(page)}"`);
        const redacted = await waitFor(async () => {
          const { events = [] } = await store.get(ctx, "events");
          return events.some((e) => e.action === "redacted") ? true : null;
        }, 4000);
        expect(redacted, "counted as hidden");
      }),
  );

  // Hide it used to be wired to the same code path as "keep it general", so it would generalize a birth date
  // or address instead of actually hiding it. This check makes sure that bug stays fixed.
  await check("GEN1b", "Notice → Hide it hides a birth date and an address (it doesn't keep them general)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "I was born on 03/14/1948 and live at 123 Oak Street, Springfield, IL 62704");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await waitFor(async () => {
        const t = await editorText(page);
        return t.includes("[REDACTED") || t.includes("March") ? t : null;
      }, 4000);
      expect(
        text &&
          /\[REDACTED DATE OF BIRTH\]/.test(text) &&
          /\[REDACTED STREET ADDRESS\]/.test(text) &&
          !/1948|March|Springfield|Oak/.test(text),
        `chat box: "${await editorText(page)}"`,
      );
    }),
  );

  await check(
    "GEN2",
    'Ask-before dialog → More choices → Say "March 1948" instead, and hide the rest (the phone number)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { date_of_birth: "block", phone_number: "block" });
        await typeText(page, "born 03/14/1948, call me at 555-555-0123");
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog");
        await clickDialogButton(page, "More choices");
        await clickDialogButton(page, 'Say "March 1948" instead, and hide the rest');
        const text = await editorText(page);
        expect(text === "born March 1948, call me at [REDACTED PHONE NUMBER]", `chat box: "${text}"`);
      }),
  );

  await check(
    "MC1",
    "More choices: 'don't warn me about this one again' (vault: fine to share) and 'always watch for this one' (vault: protect)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 555-555-5636");
        expect(await waitForNotice(page), "no notice");
        await page.screenshot({ path: path.join(OUT, "notice-more-closed.png") });
        await clickDialogButton(page, "More choices", readNotice);
        await page.screenshot({ path: path.join(OUT, "notice-more-open.png") });
        await clickDialogButton(page, "Leave it in, and don't warn me about this one again", readNotice);
        expect(!(await readNotice(page)), "notice still open");
        // The vault write goes through the background's queue, so I wait for it to land.
        let vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault;
          return v?.length ? v : null;
        }, 3000);
        expect(
          vault?.length === 1 &&
            vault[0].mode === "allow" &&
            vault[0].type === "phone_number" &&
            /^[0-9a-f]{16}$/.test(vault[0].fp),
          `vault: ${JSON.stringify(vault)}`,
        );
        expect(!JSON.stringify(vault).includes("5636"), "the number itself was stored");
        await clearEditor(page);
        await typeText(page, "again 555-555-5636");
        await expectNoUI(page, "this number is fine to share now");
        await clearEditor(page);
        await store.set(ctx, { responses: { aws_access_key: "block" } });
        await typeText(page, `key ${KEY2}`);
        expect(await waitForDialog(page), "no dialog");
        await clickDialogButton(page, "More choices");
        await page.screenshot({ path: path.join(OUT, "dialog-more-open.png") });
        await clickDialogButton(page, "Hide it, and always watch for this one, however it's written");
        expect((await editorText(page)).includes("[REDACTED AWS ACCESS KEY]"), "not hidden");
        vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault || [];
          return v.some((e) => e.type === "aws_access_key") ? v : null;
        }, 3000);
        expect(
          vault?.some((e) => e.type === "aws_access_key" && e.mode === "protect"),
          `vault: ${JSON.stringify(vault)}`,
        );
      }),
  );

  const PHONE = "call me at 555-555-5636";
  await check("R1", "Warn (phone, default): notice shows, sending isn't blocked, counts as allowed", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("Phone Number"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.text.includes("555-555-5636"), "notice shows the full number");
      expect(!(await readDialog(page)), "a warn-level item opened the blocking dialog");
      await page.screenshot({ path: path.join(OUT, "notice.png") });
      await sleep(1600); // read it, then send anyway (an informed send: no "Just sent" follow-up, FS2)
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1, `sent: ${JSON.stringify(sent)}`);
      expect(!(await readNotice(page)), "notice still open after sending");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R1b", "Keep it lasts for that message only: the next message warns again", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Leave it in", readNotice);
      await typeText(page, " and more words");
      await expectNoUI(page, "same value, same message, already kept");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "first message not sent");
      await typeText(page, `again: ${PHONE}`);
      const again = await waitForNotice(page);
      expect(again?.text.includes("Phone Number"), "the next message didn't warn again");
    }),
  );

  await check("R2", "Warn notice → Remove it replaces the number and records 'redacted'", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]") && !text.includes("5636"), `editor text: "${text}"`);
      expect(!(await readNotice(page)), "notice still open");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.[0]?.action === "redacted", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check(
    "KM1",
    "Hide it works in an editor that applies edits a moment later at its own caret (Kimi); counted only once hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Hide it", readNotice);
        const text =
          (await waitFor(async () => {
            const t = await editorText(page);
            return t.includes("[REDACTED") ? t : null;
          }, 3000)) || (await editorText(page));
        await sleep(500); // a late duplicate edit would show up by now
        const final = await editorText(page);
        expect(
          final.trim() === "my key [REDACTED AWS ACCESS KEY] ok",
          `editor text: "${final}" (first seen: "${text}")`,
        );
        await sleep(1200); // past the scan delay
        const after = await readNotice(page);
        expect(!after, `a notice after hiding (Clotr's own edit mistaken for the user's): ${after?.text}`);
        const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
        expect(events?.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      }),
  );

  // The retry for these editors selects the whole message again before editing it. Once the edit lands, that
  // selection has to go away, or the next keystroke would replace the message instead of adding to it.
  await check(
    "KM3",
    "After Hide it in an editor that applies edits a moment later, nothing stays selected and typing goes on at the end",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {});
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Hide it", readNotice);
        const hidden = await waitFor(async () => ((await editorText(page)).includes("[REDACTED") ? true : null), 3000);
        expect(hidden, `not hidden: "${await editorText(page)}"`);
        await sleep(500);
        const collapsed = await page.evaluate(() => getSelection().isCollapsed);
        expect(collapsed, "the message is still selected after the swap");
        await page.keyboard.sendCharacter("!");
        await sleep(600);
        const text = (await editorText(page)).trim();
        expect(text === "my key [REDACTED AWS ACCESS KEY] ok!", `after typing "!": "${text}"`);
      }),
  );

  // Stands in for a browser that dropped execCommand("insertText"), but only inside Clotr's own world.
  const DROP_INSERT_TEXT = `(() => { const real = document.execCommand.bind(document);
    document.execCommand = (cmd, ...rest) => cmd === "insertText" ? false : real(cmd, ...rest); return true; })()`;

  await check(
    "BI1",
    "An editor that cancels beforeinput and edits its own model (Slate, CKEditor 5): Clotr still warns while typing",
    () =>
      withSite(ctx, "cancelling", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect((await editorText(page)).includes(KEY), `the test page didn't take the text: ${await editorText(page)}`);
        const notice = await waitForNotice(page);
        expect(notice?.text.includes("AWS Access Key"), `no notice while typing: ${notice?.text}`);
      }),
  );

  await check(
    "BI2",
    "Hide it still works if the browser drops execCommand(insertText): a plain text box and a beforeinput editor",
    async () => {
      for (const key of ["chatgpt", "cancelling", "cancellingLexical"]) {
        await withSite(ctx, key, async (page) => {
          await resetState(ctx, {});
          await page.evaluate(
            `(${page.site.editor}).addEventListener("input", (e) => { window.__inputs = (window.__inputs || 0) + 1; })`,
          );
          await typeText(page, `my key ${KEY} ok`);
          expect(await waitForNotice(page), `${key}: no notice`);
          await evalInClotr(page, DROP_INSERT_TEXT);
          const inputsBefore = await page.evaluate(() => window.__inputs || 0);
          await clickDialogButton(page, "Hide it", readNotice);
          const text = await waitFor(async () => {
            const t = await editorText(page);
            return t.includes("[REDACTED") ? t : null;
          }, 3000);
          expect(
            text?.trim() === "my key [REDACTED AWS ACCESS KEY] ok",
            `${key}: editor text "${await editorText(page)}"`,
          );
          if (key === "chatgpt") {
            const inputs = await page.evaluate(() => window.__inputs || 0);
            expect(inputs > inputsBefore, "the page wasn't told about the edit (no input event)");
          }
          await pressEnter(page);
          await sleep(300);
          const sent = await sentMessages(page);
          expect(sent.length === 1 && !sent[0].includes(KEY), `${key}: sent ${JSON.stringify(sent)}`);
          // The "redacted" event only fires once the fallback edit is confirmed, and on a busy computer that can
          // land after the send, so I poll for it instead of reading once.
          const counted = await waitFor(
            async () => ((await store.events(ctx)).some((e) => e.action === "redacted") ? true : null),
            4000,
          );
          expect(counted, `${key}: not counted as hidden: ${JSON.stringify(await store.events(ctx))}`);
        });
      }
    },
  );

  await check(
    "BI3",
    "Without execCommand(insertText), an editor that ignores the fallback: told to delete it by hand, the page text untouched",
    () =>
      withSite(ctx, "claude", async (page) => {
        await resetState(ctx, {});
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await evalInClotr(page, DROP_INSERT_TEXT);
        await clickDialogButton(page, "Hide it", readNotice);
        const told = await waitFor(async () => {
          const n = await readNotice(page);
          return n && /couldn't hide/i.test(n.text) ? n : null;
        }, 3000);
        expect(told, `notice: ${JSON.stringify(await readNotice(page))}`);
        // If Clotr wrote the DOM directly here, the text would look hidden while the editor's own model still
        // held and sent the real value.
        expect((await editorText(page)).includes(KEY), `the page's text was changed behind the editor's back`);
        expect(!(await store.events(ctx)).some((e) => e.action === "redacted"), "counted as hidden");
        ctx.problems = ctx.problems.filter((p) => !p.includes("[Clotr] couldn't edit this chat box"));
      }),
  );

  await check(
    "KM2",
    "A chat box that refuses Clotr's edit: the user is told to delete it by hand, and nothing is counted as hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const told = await waitFor(async () => {
          const n = await readNotice(page);
          return n && /couldn't hide/i.test(n.text) ? n : null;
        }, 3000);
        expect(
          told && /AWS Access Key/.test(told.text) && /delete it yourself/i.test(told.text),
          `notice: ${JSON.stringify(await readNotice(page))}`,
        );
        expect(
          !(await store.events(ctx)).some((e) => e.action === "redacted"),
          "recorded as hidden although the key is still there",
        );
        // This check triggers Clotr's "couldn't edit" warning on purpose, so I filter just that one out here.
        // The overall console check elsewhere still catches any other warning.
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
      }),
  );

  // The background keeps a self-check state for the active tab, and this reads it. The popup's site card reads
  // the same thing.
  const tabHealth = () =>
    ctx.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
      return protectedTabs[tab.id] || null;
    });

  await check(
    "HC1",
    "Self-check: on a chat page Clotr reports that it sees the chat box, before anything is typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editor ? x : null;
        }, 5000);
        expect(h?.editor === true && !h.editFailed, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "HC2",
    "Self-check: an AI site's page without a chat box is reported as such (running, no chat box yet)",
    () =>
      withSite(ctx, "nochat", async (page) => {
        await page.bringToFront();
        const h = await waitFor(async () => await tabHealth(), 3000);
        await sleep(1500);
        const after = await tabHealth();
        expect(h && after && after.editor === false, `health: ${JSON.stringify(after)}`);
      }),
  );

  // What the popup's "Test Clotr here" button asks this tab's Clotr. The button itself needs a real click to
  // open, so that part is checked by hand instead.
  const showChatBox = () =>
    ctx.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: "clotr:showChatBox" }, { frameId: 0 });
    });
  const flashShown = (page) => page.evaluate(() => Boolean(document.querySelector("clotr-flash")));

  await check(
    "TC1",
    "Test Clotr here: the chat box Clotr watches is outlined for a moment; nothing typed, sent or recorded",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        const answer = await showChatBox();
        expect(answer?.found === true, `answer: ${JSON.stringify(answer)}`);
        expect(await flashShown(page), "no outline on the page");
        const ring = await page.evaluate(() => {
          const box = document.querySelector("#prompt-textarea").getBoundingClientRect();
          return { top: Math.round(box.top), height: Math.round(box.height) };
        });
        expect(ring.height > 0, `the chat box isn't on screen: ${JSON.stringify(ring)}`);
        await shot(page, "test-clotr-here.png");
        expect(await waitFor(async () => !(await flashShown(page)), 3000), "the outline stayed");
        expect((await editorText(page)) === "", `the chat box changed: "${await editorText(page)}"`);
        expect((await sentMessages(page)).length === 0, "something was sent");
        expect((await store.events(ctx)).length === 0, "something was recorded");
      }),
  );

  await check("TC2", "Test Clotr here on a page without a chat box: Clotr says it can't find one", () =>
    withSite(ctx, "nochat", async (page) => {
      await page.bringToFront();
      const answer = await showChatBox();
      expect(answer?.found === false, `answer: ${JSON.stringify(answer)}`);
      expect(!(await flashShown(page)), "an outline with no chat box");
    }),
  );

  await check(
    "SEC1",
    "Storage is locked to Clotr's own pages: the part running inside an AI page can't read history, the salt or other sites' settings",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { events: seedEvents() });
        await sleep(500);
        const got = await evalInClotr(
          page,
          `(async () => {
        try {
          const all = await chrome.storage.local.get(null);
          return "readable: " + Object.keys(all).join(",");
        } catch (e) {
          return "denied";
        }
      })()`,
        );
        expect(got === "denied", `from inside the page: ${got}`);
        await store.set(ctx, { events: [] });
      }),
  );

  await check("SET1", "A setting changed while a chat tab is still starting up reaches that tab", () =>
    withSite(ctx, "chatgpt", async (page) => {
      // This happens right after the page opens, before its Clotr has registered with the background.
      await ctx.worker.evaluate(() =>
        enqueue(() => chrome.storage.local.set({ responses: { aws_access_key: "block" }, guided: {} })),
      );
      await sleep(1000);
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      expect(await waitForDialog(page), "the tab kept its old settings: the key wasn't held");
      expect((await sentMessages(page)).length === 0, "sent despite Ask before sending");
    }),
  );

  await check("HP1", "Hostile page removes Clotr's dialog: the user is never stuck (Enter still sends)", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx); // Ask before sending for keys
      await page.evaluate(() => window.__removeClotr());
      await typeText(page, `key ${KEY}`);
      await sleep(600);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Enter");
        await sleep(700);
      }
      const sent = await page.evaluate(() => window.__sent.length);
      expect(sent === 1, `the message never went: the user is stuck (sent ${sent})`);
    }),
  );

  await check(
    "HP2",
    "Hostile page scripts its box (fills in a detail, empties it) with no user action: nothing is recorded as sent",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => window.__fakeSend("my ssn is 219-09-9999"));
        await sleep(2500);
        const events = await store.events(ctx);
        expect(!events.some((e) => e.action === "allowed"), `fake send recorded: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "HP3",
    "Hostile page removes the warning notice: Clotr notes it can't show warnings on this tab (self-check)",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await page.evaluate(() => window.__removeClotr());
        await typeText(page, `key ${KEY}`);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.uiRemoved ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "SEC2",
    "A page can't probe what Clotr knows: guesses it puts in its own chat box by script get no reaction",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        const reacted = await page.evaluate((k) => window.__probe(`is it Emma? Liam? key ${k}`), KEY);
        expect(!reacted, "Clotr reacted to text the page typed by script");
        // Real typing still warns, since Clotr checks the text once the user actually types it.
        await typeText(page, " qx-sec2");
        const n = await waitFor(() => readNotice(page), 3000);
        expect(n && /AWS Access Key/.test(n.text), "no warning after real typing");
      }),
  );

  await check("SEC3", "A page can't trigger Ask before sending with a scripted Enter", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx, { responses: { aws_access_key: "block" } });
      const reacted = await page.evaluate((k) => window.__probe(`key ${k}`, { enter: true }), KEY);
      expect(!reacted, "a scripted Enter opened Clotr's dialog");
    }),
  );

  await check(
    "HC4",
    "Self-check survives in-page navigation (a single-page app changing its URL, as grok.com does after loading)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        expect(await waitFor(async () => (await tabHealth())?.editor, 5000), "no health before navigating");
        await page.evaluate(() => {
          history.pushState({}, "", "/c/abc123");
        });
        await sleep(1500);
        await page.evaluate(() => {
          history.pushState({}, "", "/c/def456");
        });
        await sleep(2500);
        const h = await tabHealth();
        expect(h?.editor === true, `health after in-page navigation: ${JSON.stringify(h)}`);
      }),
  );

  await check(
    "HC3",
    "Self-check: a failed Hide it marks the tab (red ! badge, tooltip says why); a later successful Hide it clears it",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editFailed ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
        const badge = await activeBadge(ctx);
        expect(badge.text === "!", `badge: ${JSON.stringify(badge)}`);
        const title = await ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return chrome.action.getTitle({ tabId: tab.id });
        });
        expect(/couldn't edit the chat box/i.test(title), `title: ${title}`);
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
        // The user fixes the problem, and Hide it works again the next time.
        await page.evaluate(() => {
          window.__rejectEdits = false;
        });
        await clickDialogButton(page, "OK, I'll delete it", readNotice).catch(() => {});
        await clearEditor(page);
        await typeText(page, `again ${KEY2}`);
        expect(await waitForNotice(page), "no notice the second time");
        await clickDialogButton(page, "Hide it", readNotice);
        const cleared = await waitFor(async () => {
          const x = await tabHealth();
          return x && !x.editFailed ? x : null;
        }, 4000);
        expect(cleared, `still marked: ${JSON.stringify(await tabHealth())}`);
        expect((await activeBadge(ctx)).text !== "!", "badge still shows !");
      }),
  );

  await check("N1", "Notice with several items: every item stays inside the notice (wraps between items)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: everything warns
      await typeText(page, `key ${KEY} phone 555-555-0123 mail ann.lee@example-company.com`);
      expect(await waitForNotice(page), "no notice");
      const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      let box = null;
      const codes = [];
      (function walk(n) {
        const cls = (n.attributes || []).join(" ");
        if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`) && !box) box = n;
        if (n.nodeName === "CODE") codes.push(n);
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
      })(root);
      expect(box && codes.length, `notice box ${!!box}, items ${codes.length}`);
      const right = async (n) => {
        const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: n.nodeId })).model.border;
        return Math.max(q[0], q[2], q[4], q[6]);
      };
      const edge = await right(box);
      for (const c of codes) {
        const r = await right(c);
        expect(r <= edge, `an item ends at x=${Math.round(r)}, past the notice edge at x=${Math.round(edge)}`);
      }
    }),
  );

  await check("R3", "Block + warn together: one dialog lists both, Redact removes both", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `${KEY} and ${PHONE}`);
      const dialog = await waitForDialog(page);
      expect(
        dialog?.text.includes("AWS Access Key") && dialog.text.includes("Phone Number"),
        `dialog: ${dialog?.text}`,
      );
      expect(!(await readNotice(page)), "notice shown alongside the dialog");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(!text.includes(KEY) && !text.includes("5636"), `editor text: "${text}"`);
    }),
  );

  await check(
    "R4",
    "Log only: no interruption, but every detection is still recorded (nothing is silently dropped)",
    async () => {
      await resetState(ctx);
      await chooseResponse(ctx, "phone_number", "log");
      await chooseResponse(ctx, "email", "log");
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, `${PHONE} or bob@example.com`);
        await expectNoUI(page, "phone and email are log-only");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "message not sent");
      });
      const events = await store.events(ctx);
      const types = events
        .map((e) => `${e.type}:${e.action}`)
        .sort()
        .join(",");
      expect(types === "email:suppressed,phone_number:suppressed", `events: ${types}`);
      await chooseResponse(ctx, "phone_number", "warn");
      await chooseResponse(ctx, "email", "warn");
      const { responses } = await store.get(ctx, "responses");
      expect(
        !("phone_number" in responses) && !("email" in responses),
        `defaults not restored: ${JSON.stringify(responses)}`,
      );
    },
  );

  await check(
    "R4b",
    "A chat tab's 'stop warning me' and a settings change made while it's still saving don't erase each other",
    async () => {
      await resetState(ctx);
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await slowBackgroundReads(ctx, 300, "responses");
      try {
        // The chat tab's save is queued first and reads storage slowly, so the settings change below has to
        // queue behind it instead of racing it. That way both overrides survive.
        const saved = ctx.worker.evaluate(() => enqueue(() => setResponses(["email"], "log")));
        await sleep(50);
        await popup.evaluate(() => {
          const sel = document.querySelector('select[data-pattern="phone_number"]');
          sel.value = "block";
          sel.dispatchEvent(new Event("change"));
        });
        await saved;
        // The settings change hits that same slowed read, so it needs its own share of the delay too.
        await sleep(400);
      } finally {
        await restoreBackgroundReads(ctx);
        await popup.close();
      }
      const { responses } = await store.get(ctx, "responses");
      expect(
        responses?.email === "log" && responses?.phone_number === "block",
        `one of the two changes was lost: ${JSON.stringify(responses)}`,
      );
      await store.set(ctx, { responses: {} });
    },
  );

  await check("R5", "Settings list every data type with its response", async () => {
    await store.set(ctx, { responses: { email: "off" } }); // a setting saved by an older version
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const rows = await popup.$$eval("select.resp[data-pattern]", (sels) =>
      sels.map((s) => [s.dataset.pattern, s.value, s.classList.contains("changed")]),
    );
    const offOptions = await popup.$$eval("select.resp option", (os) => os.filter((o) => o.value === "off").length);
    const patternCount = await popup.evaluate(() => globalThis.Clotr.PATTERNS.length);
    await shot(popup, "popup-responses.png");
    await popup.close();
    await store.set(ctx, { responses: {} });
    const byId = Object.fromEntries(rows.map(([id, v, changed]) => [id, { v, changed }]));
    expect(rows.length === patternCount, `${rows.length} rows for ${patternCount} patterns`);
    expect(byId.aws_access_key?.v === "warn" && byId.phone_number?.v === "warn", `defaults: ${JSON.stringify(byId)}`);
    expect(
      byId.email?.v === "log" && byId.email.changed,
      `old "off" should read as Log only: ${JSON.stringify(byId.email)}`,
    );
    expect(offOptions === 0, `${offOptions} "Off" options left (everything is logged)`);
  });

  // A pattern can start as Just count by setting `start: "log"` on it. License plates and gamer tags will one day,
  // but none do yet, so this check makes the phone number quiet just for itself.
  await check(
    "QK1",
    "A kind that starts as Just count: no warning but counted; Settings shows it at Just count, by default",
    async () => {
      await resetState(ctx, {});
      const quiet = () => (globalThis.Clotr.PATTERNS.find((p) => p.id === "phone_number").start = "log");
      await withSite(ctx, "chatgpt", async (page) => {
        await evalInClotr(page, `(${quiet})()`);
        await typeText(page, PHONE);
        await expectNoUI(page, "a phone number that starts as Just count");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "message not sent");
      });
      const types = (await store.events(ctx)).map((e) => `${e.type}:${e.action}`).join(",");
      expect(types === "phone_number:suppressed", `events: ${types}`);

      await store.set(ctx, { advanced: true });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await popup.evaluate(quiet);
      await popup.evaluate(() => {
        renderSettings(); // eslint-disable-line no-undef -- popup.js's own function, in the popup page
        document.querySelector('details[data-group="personal"]').open = true;
        document.querySelector('select[data-pattern="phone_number"]').scrollIntoView({ block: "center" });
      });
      const read = () =>
        popup.evaluate(() => {
          const row = document.querySelector('select[data-pattern="phone_number"]');
          const group = (id) => document.querySelector(`select[data-group="${id}"]`);
          return {
            value: row.value,
            changed: row.classList.contains("changed"),
            label: row.selectedOptions[0].textContent,
            personal: [group("personal").value, group("personal").options[0].textContent],
            credentials: group("credentials").options[0].textContent,
          };
        });
      const shown = await read();
      // This is the popup at its real size, scrolled so the group row and the quiet kind both show.
      await popup.setViewport({ width: 380, height: 600 });
      await popup.evaluate(() => document.querySelector('select[data-group="personal"]').scrollIntoView());
      for (const theme of ["dark", "light"]) {
        await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
        await sleep(200);
        await popup.screenshot({ path: path.join(OUT, `popup-quiet-kind-${theme}.png`) });
      }
      // Whatever the person picks gets saved. Picking Just count again saves nothing, since that's the default.
      const choose = (v) =>
        popup.evaluate((value) => {
          const s = document.querySelector('select[data-pattern="phone_number"]');
          s.value = value;
          s.dispatchEvent(new Event("change"));
        }, v);
      // The background is what actually saves the choice, so it needs the same quiet-pattern patch the popup got
      // while this runs. I put its own copy back afterwards, since it outlives this check.
      const before = await ctx.worker.evaluate(
        () => globalThis.Clotr.PATTERNS.find((p) => p.id === "phone_number").start,
      );
      await ctx.worker.evaluate(quiet);
      let chosen, back;
      try {
        await choose("warn");
        await sleep(300);
        chosen = (await store.get(ctx, "responses")).responses || {};
        await choose("log");
        await sleep(300);
        back = (await store.get(ctx, "responses")).responses || {};
      } finally {
        await ctx.worker.evaluate((start) => {
          const p = globalThis.Clotr.PATTERNS.find((x) => x.id === "phone_number");
          if (start === undefined) delete p.start;
          else p.start = start;
        }, before);
      }
      await popup.close();
      await store.set(ctx, { advanced: false });

      expect(
        shown.value === "log" && !shown.changed && shown.label === "Just count (default)",
        `the quiet kind's row: ${JSON.stringify(shown)}`,
      );
      expect(
        shown.personal[0] === "default" && shown.personal[1] === "Default (warn, a few just count)",
        `the group with a quiet kind: ${JSON.stringify(shown.personal)}`,
      );
      expect(shown.credentials === "Default (warn)", `a group without one: ${shown.credentials}`);
      expect(chosen.phone_number === "warn", `Warn chosen: ${JSON.stringify(chosen)}`);
      expect(!("phone_number" in back), `Just count chosen again: ${JSON.stringify(back)}`);
    },
  );

  await check(
    "G1",
    "Settings groups: Personal info → Log only sets every personal type; Default restores them",
    async () => {
      await resetState(ctx, {});
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      const pick = (v) =>
        popup.evaluate((val) => {
          const sel = document.querySelector('select[data-group="personal"]');
          sel.value = val;
          sel.dispatchEvent(new Event("change"));
        }, v);
      const initial = await popup.$eval('select[data-group="credentials"]', (s) => s.value);
      await pick("log");
      await sleep(300);
      const off = (await store.get(ctx, "responses")).responses || {};
      await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
      await sleep(100);
      await shot(popup, "popup-groups.png");
      await pick("default");
      await sleep(300);
      const after = (await store.get(ctx, "responses")).responses || {};
      await popup.close();
      expect(initial === "default", `credentials group starts at ${initial}`);
      expect(
        ["us_ssn", "credit_card", "phone_number", "email", "street_address"].every((id) => off[id] === "log") &&
          Object.values(off).every((v) => v === "log"),
        `after Log only: ${JSON.stringify(off)}`,
      );
      expect(!Object.keys(after).length, `after Default: ${JSON.stringify(after)}`);
    },
  );

  await check(
    "S2",
    "A site added on huggingface.co runs Clotr only in the chosen section, not the whole site",
    async () => {
      // Protecting one Hugging Face page must not cover all of huggingface.co. A test can't click the real
      // permission prompt, so I simulate the grant in the worker and check the registration that actually
      // decides where Clotr runs.
      const matches = await ctx.worker.evaluate(async () => {
        const realGetAll = chrome.permissions.getAll;
        chrome.permissions.getAll = async () => ({ origins: ["https://huggingface.co/*"] });
        const scope = ClotrSites.protectScope("https://huggingface.co/spaces/owner/my-app?x=1");
        await chrome.storage.local.set({ siteScopes: { "https://huggingface.co/*": [scope] } });
        await enqueue(syncUserSites); // through the worker's queue, like every real caller
        const [reg] = await chrome.scripting.getRegisteredContentScripts({ ids: [ClotrSites.USER_SCRIPT_ID] });
        chrome.permissions.getAll = realGetAll;
        await chrome.storage.local.set({ siteScopes: {} });
        await enqueue(syncUserSites);
        return reg?.matches;
      });
      expect(
        JSON.stringify(matches) === JSON.stringify(["https://huggingface.co/spaces/owner/my-app/*"]),
        `registered on: ${JSON.stringify(matches)}`,
      );
    },
  );

  await check("S1", "Settings → Built-in AI tools lists tools by name (from ai-sites.json)", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const got = await popup.evaluate(() => ({
      count: document.querySelector("#builtin-count").textContent,
      items: [...document.querySelectorAll("#builtin-sites li")].map((li) => li.textContent),
    }));
    await popup.close();
    expect(got.count === "19" && got.items.length === 19, `count ${got.count}, ${got.items.length} items`);
    expect(got.items.includes("ChatGPT — chatgpt.com, chat.openai.com"), `items: ${got.items.slice(0, 3).join(" | ")}`);
  });

  await check("R6c", "Upgrade: a user-site registration under the old name (ChainSec) is removed", async () => {
    await ctx.worker.evaluate(() =>
      chrome.scripting.registerContentScripts([
        {
          id: "chainsec-user-sites",
          matches: ["https://chatgpt.com/*"],
          js: ["patterns.js"],
          persistAcrossSessions: false,
        },
      ]),
    );
    await ctx.worker.evaluate(() => syncUserSites());
    const left = await ctx.worker.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ["chainsec-user-sites"] }),
    );
    expect(left.length === 0, `old registration still there: ${JSON.stringify(left)}`);
  });

  await check("R6", "Upgrade: old 'don't warn again' and 'Off' settings become Log only", async () => {
    await store.set(ctx, {
      suppressed: { global: { email: true, aws_access_key: true } },
      responses: { aws_access_key: "off" },
    });
    await ctx.worker.evaluate(() => migrateSuppressed());
    await ctx.worker.evaluate(() => migrateOffToLog());
    const got = await store.get(ctx, ["suppressed", "responses"]);
    await store.set(ctx, { responses: {} });
    expect(!got.suppressed, "old key not removed");
    expect(
      got.responses?.email === "log" && got.responses?.aws_access_key === "log",
      `responses (old "off" → Log only): ${JSON.stringify(got.responses)}`,
    );
  });

  await check(
    "LG1",
    "Sign-in fields on an AI site are never watched (shown password, username, one-time code, sign-up form); its chat box is",
    () =>
      withSite(ctx, "login", async (page) => {
        await resetState(ctx);
        const typeInto = async (sel, text) => {
          TYPED_VALUES.add(text);
          await page.focus(sel);
          await page.keyboard.sendCharacter(text);
        };
        await page.click("#show"); // "show password" makes it a text field
        await typeInto("#pass", KEY);
        await typeInto("#user", "grandma.jones@example.com");
        await typeInto("#otp", "555-555-0147");
        await typeInto("#new-user", "grandma.jones@example.com");
        await typeInto("#new-pass", KEY2);
        await page.keyboard.press("Enter");
        await expectNoUI(page, "typing into sign-in fields");
        expect(
          !(await store.events(ctx)).length,
          `sign-in fields were recorded: ${JSON.stringify(await store.events(ctx))}`,
        );
        await typeText(page, `here is the key ${KEY}`);
        expect(
          (await waitForNotice(page)) || (await waitForDialog(page)),
          "the chat box on the same page isn't protected",
        );
      }),
  );

  await check("P1", "Documentation example keys and placeholders don't trigger", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(
        page,
        "aws configure → AKIAIOSFODNN7EXAMPLE, OPENAI_API_KEY=sk-your-api-key-here-1234567890, pip install sk-learn-is-a-great-library",
      );
      await expectNoUI(page, "only example keys/placeholders");
      expect(!(await store.events(ctx)).length, "placeholder was counted");
    }),
  );

  await check("P2", '"my password is …" blocks; Redact removes only the password', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, "my password is Fluffy123 can you remember it");
      const dialog = await waitForDialog(page);
      expect(dialog?.text.includes("Password or Secret"), `dialog: ${dialog?.text}`);
      expect(!dialog.text.includes("Fluffy123"), "dialog shows the password");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text === "my password is [REDACTED PASSWORD OR SECRET] can you remember it", `editor text: "${text}"`);
    }),
  );

  await check("R7", "Bulk paste: the notice summarizes counts instead of listing every value", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const rows = Array.from(
        { length: 30 },
        (_, i) => `user${i},user${i}@example${i}.com,555-555-${String(1000 + i)}`,
      );
      await typeText(page, ["name,email,phone", ...rows].join("\n"));
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-bulk.png") });
      expect(
        /Large paste: 31 lines/.test(notice?.text || ""),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(/Email Address ×30/.test(notice.text) && /Phone Number ×30/.test(notice.text), `notice: ${notice.text}`);
      expect(!/@example/.test(notice.text), "notice lists values");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(!/@example|555-555-1/.test(text), `not all redacted: ${text.slice(0, 120)}`);
    }),
  );

  await check("R8", "Attached text file: its contents are scanned and the notice names the file", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.csv");
      const rows = ["name,email", "Ann,ann.lee@gmail.com", "Bo,bo.chan@yahoo.com", "Cy,cy.diaz@outlook.com"];
      rows.forEach((r) => TYPED_VALUES.add(r));
      fs.writeFileSync(file, rows.join("\n"));
      const input = await page.$("#attach");
      await input.uploadFile(file);
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-file.png") });
      fs.rmSync(file);
      expect(
        /customers\.csv/.test(notice?.text || "") && /Email Address ×3/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.buttons.some((b) => b.text === "Hide it"), "offers Remove it for a file");
      await clickDialogButton(page, "OK", readNotice);
      const events = await waitFor(
        async () => ((await store.events(ctx)).length === 3 ? store.events(ctx) : null),
        2000,
      );
      expect(
        events?.every((e) => e.action === "allowed" && e.type === "email"),
        `events: ${JSON.stringify(await store.events(ctx))}`,
      );
    }),
  );

  // Office documents are really zip files full of XML, so this is a minimal zip writer for test fixtures.
  function makeZip(file, entries) {
    const zlib = require("zlib");
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, content, deflate = true] of entries) {
      const data = Buffer.from(content);
      const body = deflate ? zlib.deflateRawSync(data) : data;
      const nameBuf = Buffer.from(name);
      const crc = zlib.crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(deflate ? 8 : 0, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      parts.push(local, nameBuf, body);
      central.push(cd, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, end]));
  }
  const docxXml = (paras) =>
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

  await check("R8d", "Attached Word document: the text inside is scanned (key and phone found)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "resume.docx");
      makeZip(file, [
        ["[Content_Types].xml", "<Types/>"],
        ["word/document.xml", docxXml(["Jane Example", `deploy key ${KEY}`, "Call me: 555-555-0123"])],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /resume\.docx/.test(notice?.text || "") &&
          /AWS Access Key/.test(notice.text) &&
          /Phone Number/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-4).join(" || ")}`,
      );
    }),
  );

  await check(
    "R8m",
    "Several attached files at once: one notice names every file with personal data, and each is recorded once",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const dir = path.join(OUT, "many");
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 0; i < 8; i++) {
          const file = path.join(dir, `notes${i}.txt`);
          const risky =
            i === 1
              ? "mail ann.lee@gmail.com"
              : i === 4
                ? "call 555-555-0144"
                : i === 6
                  ? `key ${KEY}`
                  : "nothing private here";
          TYPED_VALUES.add(risky);
          fs.writeFileSync(file, `meeting notes ${i}\n${risky}\n`);
          files.push(file);
        }
        await (await page.$("#attach")).uploadFile(...files);
        await sleep(800);
        const notice = await waitForNotice(page);
        fs.rmSync(dir, { recursive: true });
        const text = notice?.text || "";
        expect(
          /notes1\.txt/.test(text) && /notes4\.txt/.test(text) && /notes6\.txt/.test(text),
          `notice doesn't name all three files: ${text}`,
        );
        expect(
          /Email Address/.test(text) && /Phone Number/.test(text) && /AWS Access Key/.test(text),
          `notice doesn't list all kinds: ${text}`,
        );
        await clickDialogButton(page, "OK", readNotice);
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 3 ? ev : null;
          }, 3000)) || (await store.events(ctx));
        expect(
          events.length === 3 && events.every((e) => e.action === "allowed"),
          `records: ${JSON.stringify(events.map((e) => [e.type, e.action]))}`,
        );
      }),
  );

  await check("R8x", "Attached spreadsheet (.xlsx): cell text is scanned", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.xlsx");
      makeZip(file, [
        [
          "xl/sharedStrings.xml",
          `<sst><si><t>Ann</t></si><si><t>ann.lee@gmail.com</t></si><si><t>bo.chan@yahoo.com</t></si></sst>`,
        ],
        ["xl/worksheets/sheet1.xml", "<worksheet/>"],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /customers\.xlsx/.test(notice?.text || "") && /Email Address/.test(notice.text),
        `notice: ${notice?.text}`,
      );
    }),
  );

  await check(
    "R8p",
    "Attached PDF (a real one, printed by the browser: compressed, embedded fonts): its text is checked",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "statement.pdf");
        const printer = await ctx.browser.newPage();
        await printer.setRequestInterception(true);
        printer.on("request", (req) => req.abort());
        await printer.setContent(`<html><body style="font-family:Arial"><h1>Account statement</h1>
        <p>Customer: Jane Example</p><p>Phone: 555-555-0123</p><p>Email: jane.example@gmail.com</p>
        <p>Deploy key ${KEY}</p></body></html>`);
        fs.writeFileSync(file, await printer.pdf({ format: "A4" }));
        await printer.close();
        await (await page.$("#attach")).uploadFile(file);
        const notice = await waitForNotice(page);
        fs.rmSync(file);
        expect(
          /statement\.pdf/.test(notice?.text || "") &&
            /Phone Number/.test(notice.text) &&
            /AWS Access Key/.test(notice.text) &&
            /Email Address/.test(notice.text),
          `notice: ${notice?.text} LOGS: ${page.logs.slice(-3).join(" || ")}`,
        );
      }),
  );

  await check(
    "R8q",
    "PDF bomb (a tiny file whose stream inflates to 60 MB): capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.pdf");
        const zlib = require("zlib");
        const body = zlib.deflateSync(Buffer.from(`BT (${"A".repeat(60 * 1024 * 1024)}) Tj ET`));
        const NL = String.fromCharCode(10);
        fs.writeFileSync(
          file,
          Buffer.concat([
            Buffer.from(
              ["%PDF-1.4", `1 0 obj << /Length ${body.length} /Filter /FlateDecode >>`, "stream", ""].join(NL),
            ),
            body,
            Buffer.from(["", "endstream", "endobj", "%%EOF"].join(NL)),
          ]),
        );
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 555-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the PDF bomb");
      }),
  );

  await check(
    "R8r",
    "Hostile PDF built to make the parser crawl (200k unclosed dictionaries): no hang, chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "crawl.pdf");
        fs.writeFileSync(file, "%PDF-1.4 " + "<< /A <x ".repeat(200000) + ">> endobj stream");
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(1500);
        fs.rmSync(file);
        const ms = await page.evaluate(() => {
          const s = performance.now();
          return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
        });
        expect(
          ms < 500 && Date.now() - t0 < 6000,
          `page stalled: event loop ${Math.round(ms)} ms, total ${Date.now() - t0} ms`,
        );
        await typeText(page, "call me at 555-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
      }),
  );

  await check("R8s", "Hostile PDF with hundreds of streams that never end (18 MB): no hang, chat keeps working", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "endless.pdf");
      const NL = String.fromCharCode(10);
      fs.writeFileSync(file, "%PDF-1.4 " + ("<< /A 1 >> stream" + NL + "x".repeat(45000) + " ").repeat(400));
      const t0 = Date.now();
      await (await page.$("#attach")).uploadFile(file);
      await sleep(2000);
      const lag = await page.evaluate(() => {
        const s = performance.now();
        return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
      });
      expect(
        lag < 500 && Date.now() - t0 < 8000,
        `page stalled: event loop ${Math.round(lag)} ms, total ${Date.now() - t0} ms`,
      );
      // I don't wait for this delete, because on Windows the browser keeps the uploaded file open for a while,
      // and a synchronous delete would just block the test instead of catching a real stall in the page.
      fs.rm(file, { force: true, maxRetries: 10, retryDelay: 500 }, () => {});
      await typeText(page, "call me at 555-555-0123");
      expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
    }),
  );

  await check(
    "R8z",
    "Zip bomb in a .docx (60 MB of text from a tiny file): read is capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.docx");
        makeZip(file, [["word/document.xml", docxXml(["A".repeat(60 * 1024 * 1024)])]]);
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 555-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the zip bomb");
      }),
  );

  // ---------- Ask before sending, for an attached file: the send waits for an answer ----------
  // A made-up medical record number in a made-up file. Neither one may ever end up in storage.
  const MRN = "447182093";
  const MRN_FILE = "lab-results.txt";
  TYPED_VALUES.add(MRN);
  TYPED_VALUES.add(MRN_FILE);
  // Each check writes its files into its own folder. I remove that folder without waiting afterwards, since on
  // Windows the browser keeps an uploaded file open for a while.
  const holdDir = (name) => {
    const dir = path.join(OUT, `file-hold-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const dropDir = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }, () => {});
  async function attachText(page, dir, name, text) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    await (await page.$("#attach")).uploadFile(file);
  }
  const attachMrn = (page, dir) => attachText(page, dir, MRN_FILE, `Patient notes\nMRN: ${MRN}\n`);
  // Shoots the dialog or corner note the way people actually see it, at a phone size and a desktop size, in
  // both themes.
  async function holdShots(page, name) {
    for (const [width, height] of [
      [380, 700],
      [1280, 800],
    ])
      for (const theme of ["light", "dark"])
        await shotAt(page, `${name}-${width}-${theme}.png`, { width, height, theme });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.setViewport({ width: 1000, height: 700 });
  }
  const buttonsOf = (ui) => (ui?.buttons || []).map((b) => b.text).join("/");
  // Stands in for Clotr's own file reader so a check can force it to be slow, to hang forever, or to throw.
  // Each read is counted too, so a check can wait until Clotr has actually started reading the file.
  const READS = {
    slow: (ms) => `new Promise((r) => setTimeout(r, ${ms})).then(() => real(f))`,
    never: () => "new Promise(() => {})",
    broken: () => 'Promise.reject(new Error("test: the reader broke"))',
  };
  const stubReader = (page, kind, ms = 0) =>
    evalInClotr(
      page,
      `(() => { const real = globalThis.Clotr.readAttachment; globalThis.__clotrReads = 0; globalThis.Clotr.readAttachment = (f) => { globalThis.__clotrReads++; return ${READS[kind](ms)}; }; return true; })()`,
    );
  const readStarted = async (page) =>
    expect(
      await waitFor(() => evalInClotr(page, "globalThis.__clotrReads > 0"), 3000),
      "Clotr never started reading the file",
    );

  await check(
    "R9",
    "Ask before sending, in an attached file: Enter holds the message; the dialog names the file, masks what's in it and says the site may already have a copy; Enter goes back",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        const dir = holdDir("r9");
        try {
          await attachMrn(page, dir);
          await sleep(800);
          expect(!(await readDialog(page)), "the dialog opened before anything was sent");
          await typeText(page, "what do these numbers mean?");
          await pressEnter(page);
          const dialog = await waitForDialog(page);
          expect(
            /This file looks private/.test(dialog?.text || "") && dialog.text.includes(MRN_FILE),
            `dialog: ${dialog?.text} LOGS: ${page.logs.slice(-4).join(" || ")}`,
          );
          expect(
            /Medical Record Number/.test(dialog.text) && !dialog.text.includes(MRN),
            `not listed, or not masked: ${dialog.text}`,
          );
          expect(/may already have a copy/.test(dialog.text), `no word about the upload: ${dialog.text}`);
          expect(buttonsOf(dialog) === "Send with the file/Go back to remove it", `buttons: ${buttonsOf(dialog)}`);
          expect((await sentMessages(page)).length === 0, "sent while the file was held");
          await page.keyboard.press("Enter"); // a habit press right after the dialog appeared does nothing
          await sleep(100);
          expect(await readDialog(page), "an Enter right after the dialog appeared chose for the user");
          await holdShots(page, "file-hold");
          await page.keyboard.press("Enter");
          await sleep(300);
          expect(!(await readDialog(page)), "Enter didn't go back to the message");
          expect((await sentMessages(page)).length === 0, "Enter sent the file");
          const focused = await page.evaluate(() => document.activeElement?.id);
          expect(focused === "prompt-textarea", `focus after going back: ${focused}`);
        } finally {
          dropDir(dir);
        }
      }),
  );

  await check(
    "R9b",
    "The next send asks 'Is the file off?' (Esc goes back); It's off, send sends it and counts it as taken out; nothing about the file is stored",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        const dir = holdDir("r9b");
        try {
          await attachMrn(page, dir);
          await typeText(page, "what do these numbers mean?");
          await sleep(800);
          await pressEnter(page);
          expect(await waitForDialog(page), "no dialog for the file");
          await clickDialogButton(page, "Go back to remove it");
          expect(!(await readDialog(page)), "Go back didn't close the dialog");
          await pressEnter(page);
          const off = await waitForDialog(page);
          expect(
            /Is the file off\?/.test(off?.text || "") &&
              off.text.includes(MRN_FILE) &&
              /takes your word/.test(off.text),
            `second ask: ${off?.text}`,
          );
          expect(
            buttonsOf(off) === "Send with the file/It's off, send/Go back to my message (Esc)",
            `buttons: ${buttonsOf(off)}`,
          );
          await holdShots(page, "file-off");
          await sleep(700);
          await page.keyboard.press("Escape");
          await sleep(200);
          expect(!(await readDialog(page)), "Esc didn't go back");
          expect((await sentMessages(page)).length === 0, "Esc sent the message");
          await pressEnter(page);
          expect(/Is the file off\?/.test((await waitForDialog(page))?.text || ""), "the next send didn't ask again");
          await sleep(700);
          await page.keyboard.press("Enter"); // Enter: It's off, send
          const sent = await waitFor(async () => ((await sentMessages(page)).length === 1 ? true : null), 2000);
          expect(sent, `It's off, send didn't send: ${JSON.stringify(await sentMessages(page))}`);
          const events = await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length ? ev : null;
          }, 3000);
          expect(
            events?.length === 1 &&
              events[0].type === "medical_record" &&
              events[0].action === "redacted" &&
              /^[0-9a-f]{16}$/.test(events[0].fp),
            `events: ${JSON.stringify(events)}`,
          );
          const all = JSON.stringify([
            await store.get(ctx, null),
            await ctx.worker.evaluate(() => chrome.storage.session.get(null)),
          ]);
          expect(!all.includes(MRN) && !all.includes("lab-results"), "the number or the file's name was stored");
        } finally {
          dropDir(dir);
        }
      }),
  );

  await check("R9c", "Send with the file sends the message the way it was sent and counts the file as allowed", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, { medical_record: "block" });
      const dir = holdDir("r9c");
      try {
        await attachMrn(page, dir);
        await typeText(page, "what do these numbers mean?");
        await sleep(800);
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog for the file");
        await clickDialogButton(page, "Send with the file");
        const sent = await waitFor(async () => ((await sentMessages(page)).length === 1 ? true : null), 2000);
        expect(sent, `Send with the file didn't send: ${JSON.stringify(await sentMessages(page))}`);
        expect(!(await readDialog(page)), "the dialog stayed open");
        const events = await waitFor(async () => {
          const ev = await store.events(ctx);
          return ev.length ? ev : null;
        }, 3000);
        expect(
          events?.length === 1 && events[0].type === "medical_record" && events[0].action === "allowed",
          `events: ${JSON.stringify(events)}`,
        );
      } finally {
        dropDir(dir);
      }
    }),
  );

  await check(
    "R9d",
    "A file still being read when you send: 'Checking your file', then the dialog; a read that never ends lets the message go within 3 seconds",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        const dir = holdDir("r9d");
        try {
          await stubReader(page, "slow", 2500); // a big PDF takes this long
          await typeText(page, "what do these numbers mean?");
          await sleep(600);
          await attachMrn(page, dir);
          await readStarted(page);
          await pressEnter(page);
          const note = await waitFor(async () => {
            const n = await readNotice(page);
            return n && /Checking your file/.test(n.text) ? n : null;
          }, 2000);
          expect(note?.text.includes(MRN_FILE), `checking note: ${note?.text}`);
          expect((await sentMessages(page)).length === 0, "sent before the file was checked");
          await holdShots(page, "file-checking");
          const dialog = await waitFor(() => readDialog(page), 3000);
          expect(/This file looks private/.test(dialog?.text || ""), `after the check: ${dialog?.text}`);
          expect(!/Checking your file/.test((await readNotice(page))?.text || ""), "the checking note stayed");
          expect((await sentMessages(page)).length === 0, "sent with the file held");
        } finally {
          dropDir(dir);
        }
      }).then(() =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, { medical_record: "block" });
          const dir = holdDir("r9d2");
          try {
            await stubReader(page, "never");
            await typeText(page, "what do these numbers mean?");
            await sleep(600);
            await attachMrn(page, dir);
            await readStarted(page);
            const t0 = Date.now();
            await pressEnter(page);
            const sent = await waitFor(async () => ((await sentMessages(page)).length === 1 ? true : null), 4500);
            const ms = Date.now() - t0;
            expect(sent && ms >= 2500, `sent: ${Boolean(sent)}, after ${ms} ms`);
            expect(!(await readDialog(page)), "a dialog opened for a file that was never read");
          } finally {
            dropDir(dir);
          }
        }),
      ),
  );

  await check(
    "R9e",
    "A file sent with nothing typed, by the send button, is held too; Go back puts you in the chat box",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { medical_record: "block" });
        const dir = holdDir("r9e");
        try {
          await attachMrn(page, dir);
          await sleep(800);
          await clickSend(page);
          const dialog = await waitForDialog(page);
          expect(/This file looks private/.test(dialog?.text || ""), `dialog: ${dialog?.text}`);
          expect((await sentMessages(page)).length === 0, "the file went without a question");
          await clickDialogButton(page, "Go back to remove it");
          const focused = await page.evaluate(() => document.activeElement?.id);
          expect(focused === "prompt-textarea", `focus after going back: ${focused}`);
          await clickSend(page);
          expect(/Is the file off\?/.test((await waitForDialog(page))?.text || ""), "the next send didn't ask again");
          await clickDialogButton(page, "Send with the file");
          const sent = await waitFor(async () => {
            const s = await sentMessages(page);
            return s.length ? s : null;
          }, 2000);
          expect(sent?.length === 1 && sent[0] === `[${MRN_FILE}]`, `sent: ${JSON.stringify(sent)}`);
        } finally {
          dropDir(dir);
        }
      }),
  );

  await check(
    "R9f",
    "Nothing set to Ask before sending: an attached file still only gets the corner note, and Enter sends",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const dir = holdDir("r9f");
        try {
          await attachMrn(page, dir);
          const notice = await waitForNotice(page);
          expect(
            notice?.text.includes(MRN_FILE) && /Medical Record Number/.test(notice.text),
            `notice: ${notice?.text}`,
          );
          expect(!(await readDialog(page)), "a dialog opened");
          await typeText(page, "what do these numbers mean?");
          await pressEnter(page);
          await sleep(400);
          expect(!(await readDialog(page)), "the send was held");
          expect((await sentMessages(page)).length === 1, "Enter didn't send");
        } finally {
          dropDir(dir);
        }
      }),
  );

  // ---------- Pictures: Clotr can't read the words in a picture, and says so once per AI site ----------
  // A real 1×1 PNG. Each picture gets its own name, and none of those names may ever end up in storage.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const pictures = [];
  const picture = (name) => {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, PNG);
    TYPED_VALUES.add(name);
    pictures.push(file);
    return file;
  };
  const attach = async (page, file) => (await page.$("#attach")).uploadFile(file);
  // Drops a picture onto the page, the way a drag from the desktop would, for pages that have no file input.
  const dropPicture = (page, name) => {
    TYPED_VALUES.add(name);
    return page.evaluate(
      (b64, n) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], n, { type: "image/png" }));
        document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      PNG.toString("base64"),
      name,
    );
  };
  const pictureNote = async (page) => {
    const n = await readNotice(page);
    return n && /can't read pictures/.test(n.text) ? n : null;
  };
  const waitForPictureNote = (page) => waitFor(() => pictureNote(page), 3000);
  const noted = async () => (await store.get(ctx, "picturesNoted")).picturesNoted || {};
  const forgetNotes = () => ctx.worker.evaluate(() => enqueue(() => chrome.storage.local.remove("picturesNoted")));
  const NOTE_TEXT =
    "ℹ️ Clotr can't read pictures | Clotr checks the words you type and the text in files you attach. It can't read " +
    "the words in a picture or a screenshot, so look this one over for your details before you send it. | OK, I'll look";

  await check(
    "PIC1",
    "The first picture on an AI site with nothing found in it: a note that Clotr can't read pictures, once per site",
    async () => {
      await resetState(ctx, {});
      await forgetNotes();
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, picture("Screenshot PIC1 holiday plans.png"));
          const note = await waitForPictureNote(page);
          expect(note?.text.startsWith(`${NOTE_TEXT} | `), `note: ${note?.text}`);
          expect(note.buttons.length === 1, `buttons: ${note.buttons.map((b) => b.text)}`);
          expect(
            await waitFor(async () => (JSON.stringify(await noted()) === '{"chatgpt.com":true}' ? true : null), 3000),
            `stored: ${JSON.stringify(await noted())}`,
          );
          // Run axe and take screenshots at a phone width and a desktop width, in both themes.
          const problems = [];
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            problems.push(...((await auditShadow(page, "CLOTR-NOTICE")) || []).map((p) => `${theme}: ${p}`));
            for (const width of [380, 1040]) {
              await page.setViewport({ width, height: 640 });
              await sleep(200);
              await page.screenshot({ path: path.join(OUT, `picture-note-${theme}-${width}.png`) });
            }
          }
          expect(!problems.length, problems.slice(0, 3).join(" | "));
          await clickDialogButton(page, "OK, I'll look", readNotice);
          expect(!(await readNotice(page)), "the note stayed after OK");
          await attach(page, picture("Screenshot PIC1 second.png"));
          await expectNoUI(page, "a second picture on the same site");
        });
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, picture("Screenshot PIC1 third.png"));
          await expectNoUI(page, "the same site in a new tab");
        });
        await withSite(ctx, "claude", async (page) => {
          await dropPicture(page, "Screenshot PIC1 dropped.png");
          expect(await waitForPictureNote(page), "no note on another AI site");
        });
        const sites = await waitFor(async () => {
          const list = Object.keys(await noted())
            .sort()
            .join();
          return list === "chatgpt.com,claude.ai" ? list : null;
        }, 3000);
        expect(sites, `stored: ${JSON.stringify(await noted())}`);
      } finally {
        await forgetNotes();
      }
    },
  );

  await check(
    "PIC2",
    "The picture note waits while a warning or the dialog is open; never on an email or chat app, or while paused",
    async () => {
      await forgetNotes();
      try {
        // A warning is already open here. It stays on screen, and the picture note only shows up once it's closed.
        await resetState(ctx, {});
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "call me at 555-555-0123");
          expect((await waitForNotice(page))?.text.includes("Phone Number"), "no warning");
          await attach(page, picture("PIC2 while warned.png"));
          await sleep(1200);
          expect((await readNotice(page))?.text.includes("Phone Number"), "the note replaced the warning");
          expect(!Object.keys(await noted()).length, "marked as shown while it waited");
          await clickDialogButton(page, "Leave it in", readNotice);
          await attach(page, picture("PIC2 after the warning.png"));
          expect(await waitForPictureNote(page), "no note once the warning was closed");
        });
        await forgetNotes();
        // Here the blocking dialog is open instead, because Ask before sending held the send.
        await resetState(ctx);
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, `key ${KEY}`);
          await pressEnter(page);
          expect(await waitForDialog(page), "no dialog");
          await attach(page, picture("PIC2 while asked.png"));
          await sleep(1200);
          expect(!(await pictureNote(page)), "the note showed under the dialog");
          expect(!Object.keys(await noted()).length, "marked as shown while the dialog was open");
        });
        // And it never shows at all on an email or chat app, or on a site the person paused.
        await resetState(ctx, {});
        await store.set(ctx, { siteKinds: { "chatgpt.com": "everyday" } });
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, picture("PIC2 to people.png"));
          await expectNoUI(page, "a picture on an email or chat app");
        });
        await store.set(ctx, { siteKinds: {}, paused: { "chatgpt.com": true } });
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, picture("PIC2 paused.png"));
          await expectNoUI(page, "a picture on a paused site");
        });
        expect(!Object.keys(await noted()).length, `stored: ${JSON.stringify(await noted())}`);
      } finally {
        await store.set(ctx, { siteKinds: {}, paused: {} });
        await forgetNotes();
      }
    },
  );

  await check(
    "PIC3",
    "Show first-time tips again brings the picture note back; What Clotr stores lists its sites, names only",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { picturesNoted: { "chatgpt.com": true, "claude.ai": true } });
      try {
        const stored = await openExtPage(ctx, "stored.html");
        try {
          const other = await waitFor(
            () => stored.$eval("#other", (n) => (/picture note/.test(n.innerText) ? n.innerText : null)),
            3000,
          );
          expect(/The picture note was shown on\s+chatgpt\.com, claude\.ai/.test(other || ""), `stores: ${other}`);
        } finally {
          await stored.close();
        }
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, picture("PIC3 before.png"));
          await expectNoUI(page, "a site that already had the note");
          const popup = await openPopup(ctx);
          try {
            await popup.$eval("#tips-again", (b) => b.click());
            expect(
              await waitFor(async () => (Object.keys(await noted()).length ? null : true), 3000),
              "Show first-time tips again left the picture note's sites",
            );
          } finally {
            await popup.close();
          }
          await page.bringToFront();
          // The tab has to hear about the change and re-read its settings before a new picture gets a note, and
          // that can be slow on a busy computer, so I retry with a new picture a few times.
          let note = null;
          for (let i = 1; i <= 3 && !note; i++) {
            await sleep(600);
            await attach(page, picture(`PIC3 after ${i}.png`));
            note = await waitForPictureNote(page);
          }
          expect(note, "no note after Show first-time tips again");
        });
      } finally {
        await forgetNotes();
      }
    },
  );

  await check("PIC4", "An SVG picture is text inside: an email in it gets the file warning, not the picture note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await forgetNotes();
      const email = "svg.pic4.rivera@gmail.com";
      TYPED_VALUES.add(email);
      const file = path.join(OUT, "PIC4 contact card.svg");
      fs.writeFileSync(
        file,
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60"><path d="M 555 555 0123 Z"/>` +
          `<text x="8" y="30">Write to ${email}</text></svg>`,
      );
      pictures.push(file);
      await attach(page, file);
      const notice = await waitForNotice(page);
      expect(
        /PIC4 contact card\.svg/.test(notice?.text || "") && /Email Address/.test(notice.text),
        `notice: ${notice?.text}`,
      );
      expect(!/Phone Number|can't read pictures/.test(notice.text), `notice: ${notice.text}`);
      expect(!Object.keys(await noted()).length, "an SVG counted as a picture");
      for (const f of pictures) fs.rmSync(f, { force: true });
    }),
  );

  // ---------- A photo's hidden location: the place a camera saved inside the file ----------
  // tools/make-picture-fixtures.js builds these pictures byte by byte, using public landmarks rather than a real
  // photo. None of the file names or place values may ever end up in storage.
  const fx = require("../../../tools/make-picture-fixtures.js");
  const placeForms = (p) => [
    `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`,
    String(p.lat),
    String(p.lon),
    p.lat.toFixed(4),
    p.lon.toFixed(4),
  ];
  for (const p of Object.values(fx.PLACES)) placeForms(p).forEach((v) => TYPED_VALUES.add(v));
  const madePictures = [];
  const pictureFile = (name, bytes) => {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, bytes);
    TYPED_VALUES.add(name);
    madePictures.push(file);
    return file;
  };
  // I don't wait for this delete, since on Windows the browser keeps an uploaded file open for a while.
  const dropMadePictures = () => {
    for (const f of madePictures.splice(0)) fs.rm(f, { force: true, maxRetries: 10, retryDelay: 500 }, () => {});
  };
  const PLACE_LEAD = (name) =>
    `The photo “${name}” has the place it was taken saved inside it. | If you send it, that place can go with it.`;
  const PLACE_HINT =
    "To keep the place private, take the photo off before you send. A screenshot of the photo doesn't carry the place.";
  const HONEST = "Clotr can't read the words in a picture, so look it over yourself.";
  const markNoted = async () => {
    await ctx.worker.evaluate(() =>
      enqueue(() => chrome.storage.local.set({ picturesNoted: { "chatgpt.com": true } })),
    );
    await sleep(300);
  };

  await check(
    "PIC5",
    "A photo with the place it was taken inside: the Photo Location warning names the kind, never the place; OK records it",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await forgetNotes();
        try {
          await attach(page, pictureFile("IMG_PIC5.jpg", fx.jpegWithGps(fx.PLACES.liberty)));
          const n = await waitForNotice(page);
          expect(
            n?.text.startsWith(`⚠️ Heads up | ${PLACE_LEAD("IMG_PIC5.jpg")} | ${PLACE_HINT} | ${HONEST} | OK`),
            `notice: ${n?.text}`,
          );
          // The only digits anywhere in the notice should be the ones in the file's own name.
          expect(!/\d/.test(n.text.replaceAll("IMG_PIC5.jpg", "")), `notice: ${n.text}`);
          expect(/Photo Location/.test(n.text) && !/lines?\b/.test(n.text), `notice: ${n.text}`);
          // Run axe and take screenshots in dark then light, at a phone width and a desktop width.
          const problems = [];
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            problems.push(...((await auditShadow(page, "CLOTR-NOTICE")) || []).map((p) => `${theme}: ${p}`));
            for (const width of [380, 1040]) {
              await page.setViewport({ width, height: 640 });
              await sleep(200);
              await page.screenshot({ path: path.join(OUT, `picture-location-${theme}-${width}.png`) });
            }
          }
          expect(!problems.length, problems.slice(0, 3).join(" | "));
          await clickDialogButton(page, "OK", readNotice);
          const events = await waitFor(async () => {
            const e = await store.events(ctx);
            return e.length ? e : null;
          }, 3000);
          expect(
            events?.length === 1 &&
              events[0].type === "photo_location" &&
              events[0].action === "allowed" &&
              events[0].name === "Photo Location" &&
              /^[0-9a-f]{16,}$/.test(events[0].fp),
            `events: ${JSON.stringify(events)}`,
          );
          await sleep(300);
          expect(!(await readNotice(page)), "a note or warning came back after OK");
          expect(!Object.keys(await noted()).length, "the picture note was marked shown for a picture that warned");
        } finally {
          dropMadePictures();
        }
      }),
  );

  await check(
    "PIC6",
    "HEIC, PNG, WebP, AVIF and TIFF with a place: the warning; a JPEG at 0,0, one without a place, or a screenshot: nothing",
    async () => {
      await resetState(ctx, {});
      await markNoted(); // the first-picture note was shown here already
      // Five kept pictures in a row would normally make Clotr offer to warn less (a separate check covers that
      // offer), but this check is about the file formats, so I turn the offer down ahead of time.
      await store.set(ctx, { relaxDeclined: { photo_location: Date.now() } });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          const { liberty, opera, eiffel, bigBen, tokyo } = fx.PLACES;
          for (const [name, bytes] of [
            ["IMG_PIC6.HEIC", fx.heifWithGps({ tiff: fx.tiffGps(opera) })],
            ["PIC6 photo.png", fx.pngWithGps(liberty)],
            ["PIC6 photo.webp", fx.webpWithGps(eiffel)],
            ["PIC6 photo.avif", fx.heifWithGps({ brand: "avif", ilocVersion: 1, tiff: fx.tiffGps(bigBen) })],
            ["PIC6 scan.tiff", fx.tiffGps(tokyo)],
          ]) {
            await attach(page, pictureFile(name, bytes));
            const n = await waitFor(async () => {
              const w = await readNotice(page);
              return w?.text.includes(PLACE_LEAD(name)) ? w : null;
            }, 5000);
            expect(n, `${name}: ${(await readNotice(page))?.text}`);
            await clickDialogButton(page, "OK", readNotice);
          }
          for (const [name, bytes] of [
            ["PIC6 zero.jpg", fx.jpegWithGps({ lat: 0, lon: 0 })],
            ["PIC6 no place.jpg", fx.BASE.jpeg],
            ["Screenshot PIC6.png", fx.BASE.png],
            // This is the same place as a photo already kept in this message, so it shouldn't warn twice.
            ["PIC6 same place.jpg", fx.jpegWithGps({ lat: opera.lat + 0.0001, lon: opera.lon })],
          ]) {
            await attach(page, pictureFile(name, bytes));
            await expectNoUI(page, name);
          }
          // Each OK is recorded through the background's queue, which can lag on a busy computer, so I wait for it.
          const want = Array(5).fill("photo_location:allowed").join();
          const kinds = async () => (await store.events(ctx)).map((e) => `${e.type}:${e.action}`).join();
          expect(
            await waitFor(async () => ((await kinds()) === want ? true : null), 5000),
            `events: ${await kinds()} LOGS: ${page.logs.slice(-12).join(" || ")}`,
          );
        });
      } finally {
        dropMadePictures();
        await forgetNotes();
      }
    },
  );

  // The background answers with a "warn less?" offer after a kept warning, and that answer can arrive late on a
  // busy computer. If a new picture's own warning is already showing when it arrives, the offer must wait behind
  // it rather than replace it. I delay the background's answer here so that late case happens every time.
  await check(
    "PIC6b",
    "A late 'Warn less?' offer never replaces the next picture's own warning; it comes after that warning is answered",
    async () => {
      await resetState(ctx, {});
      await markNoted();
      // The warning has already been kept twice recently, so keeping it one more time makes the offer due.
      await store.set(ctx, { ignores: { photo_location: [Date.now() - 60000, Date.now() - 30000] } });
      await ctx.worker.evaluate(() => {
        globalThis.__noteIgnored = globalThis.noteIgnored;
        globalThis.noteIgnored = async (types) => {
          await new Promise((r) => setTimeout(r, 1500));
          return globalThis.__noteIgnored(types);
        };
      });
      const warningFor = (page, name) =>
        waitFor(async () => {
          const n = await readNotice(page);
          return n?.text.includes(PLACE_LEAD(name)) ? n : null;
        }, 5000);
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          const { liberty, tokyo } = fx.PLACES;
          await attach(page, pictureFile("PIC6b first.jpg", fx.jpegWithGps(liberty)));
          expect(await warningFor(page, "PIC6b first.jpg"), "no warning for the first picture");
          await clickDialogButton(page, "OK", readNotice); // kept a third time: the offer is on its way
          await attach(page, pictureFile("PIC6b second.jpg", fx.jpegWithGps(tokyo)));
          expect(await warningFor(page, "PIC6b second.jpg"), "no warning for the second picture");
          await sleep(2500); // the late offer has arrived by now
          const n = await readNotice(page);
          expect(n?.text.includes(PLACE_LEAD("PIC6b second.jpg")), `the warning was replaced: ${n?.text}`);
          await clickDialogButton(page, "OK", readNotice);
          // Now that the warning's been answered, the offer can finally show up.
          const offer = await waitFor(async () => {
            const o = await readNotice(page);
            return o?.text.includes("Warn less about Photo Location?") ? o : null;
          }, 5000);
          expect(offer, `no offer after the warning: ${(await readNotice(page))?.text}`);
          await clickDialogButton(page, "Keep warning", readNotice);
        });
      } finally {
        await ctx.worker.evaluate(() => {
          if (globalThis.__noteIgnored) globalThis.noteIgnored = globalThis.__noteIgnored;
          delete globalThis.__noteIgnored;
        });
        dropMadePictures();
        await forgetNotes();
      }
    },
  );

  await check(
    "PIC7",
    "On an email or chat app the place warning talks about people; Just count for photo locations: counted, no warning",
    async () => {
      await resetState(ctx, {});
      await forgetNotes();
      try {
        await store.set(ctx, { siteKinds: { "chatgpt.com": "everyday" } });
        await sleep(300);
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, pictureFile("IMG_PIC7.jpg", fx.jpegWithGps(fx.PLACES.opera)));
          const n = await waitForNotice(page);
          expect(
            n?.text.includes(
              "The photo “IMG_PIC7.jpg” has the place it was taken saved inside it. | If you send it, the people who read it here can get that place too.",
            ),
            `notice: ${n?.text}`,
          );
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await page.setViewport({ width: 380, height: 640 });
            await sleep(200);
            await page.screenshot({ path: path.join(OUT, `picture-location-people-${theme}-380.png`) });
          }
        });
        await store.set(ctx, { siteKinds: {} });
        await chooseResponse(ctx, "photo_location", "log");
        await markNoted();
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, pictureFile("IMG_PIC7b.jpg", fx.jpegWithGps(fx.PLACES.liberty)));
          await expectNoUI(page, "a photo location set to Just count");
          const counted = await waitFor(async () => {
            const e = (await store.events(ctx)).filter((x) => x.action === "suppressed");
            return e.length ? e : null;
          }, 3000);
          expect(
            counted?.length === 1 && counted[0].type === "photo_location" && counted[0].fp,
            `events: ${JSON.stringify(await store.events(ctx))}`,
          );
        });
      } finally {
        await store.set(ctx, { siteKinds: {}, responses: {} });
        await forgetNotes();
        dropMadePictures();
      }
    },
  );

  // ---------- File names that say "passport" ----------
  await check(
    "PIC8",
    "passport-scan.jpg: ID or Document Picture; IMG_2041.jpg: nothing; a scanned w2-2025.pdf (no text): the warning",
    async () => {
      await resetState(ctx, {});
      await markNoted();
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await attach(page, pictureFile("passport-scan.jpg", fx.BASE.jpeg));
          const n = await waitForNotice(page);
          expect(
            n?.text.startsWith(
              "⚠️ Heads up | The picture “passport-scan.jpg” looks like a photo of an ID or document, going by its name. | " +
                "If you send it, this AI gets it. | To keep it private, take the picture off before you send. | " +
                `${HONEST} | OK`,
            ),
            `notice: ${n?.text}`,
          );
          expect(/ID or Document Picture/.test(n.text), `notice: ${n.text}`);
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            for (const width of [380, 1040]) {
              await page.setViewport({ width, height: 640 });
              await sleep(200);
              await page.screenshot({ path: path.join(OUT, `picture-id-${theme}-${width}.png`) });
            }
          }
          await clickDialogButton(page, "OK", readNotice);
          // This photo is named like a passport and has a place saved inside it, so one warning should mention both.
          await attach(page, pictureFile("Passport photo page.jpg", fx.jpegWithGps(fx.PLACES.eiffel)));
          const both = await waitForNotice(page);
          expect(
            both?.text.includes(
              "The picture “Passport photo page.jpg” looks like a photo of an ID or document, going by its name, and has " +
                "the place it was taken saved inside it.",
            ) &&
              /ID or Document Picture, Photo Location/.test(both.text) &&
              !/\d/.test(both.text),
            `notice: ${both?.text}`,
          );
          await clickDialogButton(page, "OK", readNotice);
          await attach(page, pictureFile("IMG_2041.jpg", fx.BASE.jpeg));
          await expectNoUI(page, "an ordinary photo name");
          await attach(page, pictureFile("w2 notes.pdf", fx.pdf({ scanned: false })));
          await expectNoUI(page, "a PDF with text in it is read, not judged by its name");
          await attach(page, pictureFile("w2-2025.pdf", fx.pdf()));
          const scan = await waitForNotice(page);
          expect(
            scan?.text.startsWith(
              "⚠️ Heads up | The file “w2-2025.pdf” looks like a scan of an ID or document, going by its name. | " +
                "If you send it, this AI gets it. | To keep it private, take the file off before you send. | " +
                "Clotr can't read the words in a scan, so look it over yourself. | OK",
            ),
            `notice: ${scan?.text}`,
          );
          await clickDialogButton(page, "OK", readNotice);
          const want = [
            "id_picture:allowed:true",
            "id_picture:allowed:true",
            "photo_location:allowed:true",
            "id_picture:allowed:true",
          ].join();
          const events = async () =>
            (await store.events(ctx)).map((e) => `${e.type}:${e.action}:${Boolean(e.fp)}`).join();
          expect(
            await waitFor(async () => ((await events()) === want ? true : null), 5000),
            `events: ${await events()}`,
          );
        });
      } finally {
        dropMadePictures();
        await forgetNotes();
      }
    },
  );

  await check(
    "PIC13",
    "Hostile pictures (a 60,000 × 60,000 PNG, corrupt and truncated files, box loops, 25 MB): no hang, the chat keeps working",
    async () => {
      await resetState(ctx, {});
      await markNoted();
      try {
        return await withSite(ctx, "chatgpt", async (page) => {
          // Clotr's content script runs on the page's own main thread, so I watch for long tasks from here on.
          await page.evaluate(() => {
            window.__longTasks = [];
            new PerformanceObserver((list) => {
              for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
            }).observe({ type: "longtask", buffered: false });
          });
          const files = Object.entries(fx.hostile()).map(([name, bytes]) => pictureFile(`PIC13 ${name}`, bytes));
          const input = await page.$("#attach");
          const t0 = Date.now();
          await input.uploadFile(...files); // all at once
          await sleep(1500);
          await expectNoUI(page, "hostile pictures");
          // This 25 MB photo has its place saved in the first few bytes, so Clotr only needs to read the start
          // of the file and should warn right away.
          const big = pictureFile("IMG_PIC13 big.jpg", fx.bigJpeg(25));
          const t1 = Date.now();
          await input.uploadFile(big);
          const n = await waitForNotice(page);
          const warnedIn = Date.now() - t1;
          expect(n?.text.includes(PLACE_LEAD("IMG_PIC13 big.jpg")), `notice: ${n?.text}`);
          const lag = await page.evaluate(() => {
            const s = performance.now();
            return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
          });
          const long = await page.evaluate(() => window.__longTasks.filter((d) => d > 200));
          expect(
            lag < 200 && !long.length && warnedIn < 3000 && Date.now() - t0 < 10000,
            `event loop ${Math.round(lag)} ms, long tasks ${long.join()}, warned in ${warnedIn} ms`,
          );
          // The chat should carry on working normally: a message sends right away, and Clotr still checks new text.
          await clickDialogButton(page, "OK", readNotice);
          await typeText(page, "what's the best way to back up photos?");
          await pressEnter(page);
          expect(
            await waitFor(async () => ((await sentMessages(page)).length === 1 ? true : null), 2000),
            "the message didn't send",
          );
          await typeText(page, "call me at 555-555-0123");
          expect((await waitForNotice(page))?.text.includes("Phone Number"), "Clotr stopped checking what's typed");
          return `warned about the 25 MB photo in ${warnedIn} ms; event loop ${Math.round(lag)} ms`;
        });
      } finally {
        dropMadePictures();
        await forgetNotes();
      }
    },
  );

  Object.assign(env, {
    docxXml,
    makeZip,
    MRN,
    MRN_FILE,
    holdDir,
    dropDir,
    attachText,
    attachMrn,
    holdShots,
    stubReader,
    readStarted,
  }); // used by later sections
};
