// E2E checks: BN. Bandage swaps personal details for bracket labels while you type, and keeps the same label for
// the same detail in one chat. It asks before turning on for a site, and never covers a password or a key.
// Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ORPHAN_CLOTR,
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clearEditor,
    clickDialogButton,
    clickNode,
    ctx,
    editorText,
    evalInClotr,
    expect,
    openExtPage,
    path,
    pressEnter,
    readNotice,
    readUI,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  const PHONE = "555-555-0123";
  const HOME = "123 Oak Street";
  TYPED_VALUES.add(PHONE);
  TYPED_VALUES.add(HOME);
  const covered = (page, want) => waitFor(async () => ((await editorText(page)) === want ? true : null), 4000);

  await check(
    "BN1",
    "Bandage on: a phone number and an address become [Phone 1] and [Address 1] while you type, with no warning",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, `call me at ${PHONE}, I live at ${HOME}`);
        const ok = await covered(page, "call me at [Phone 1], I live at [Address 1]");
        expect(ok, `chat box: "${await editorText(page)}"`);
        expect(!(await readNotice(page)), "a warning appeared for covered details");
        const counted = await waitFor(async () => {
          const events = await store.events(ctx);
          return events.some((e) => e.action === "redacted" && e.type === "phone_number") ? true : null;
        }, 3000);
        expect(counted, "not counted as hidden");
        const events = await store.events(ctx);
        expect(!JSON.stringify(events).includes("0123"), "the number was stored");
      }),
  );

  await check(
    "BN2",
    "Bandage: the same detail keeps its label in the same chat; a second, different one gets the next number",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, `my number ${PHONE}`);
        expect(await covered(page, "my number [Phone 1]"), `first: "${await editorText(page)}"`);
        await clearEditor(page);
        await typeText(page, `again ${PHONE} and my work line 555-555-0199`);
        TYPED_VALUES.add("555-555-0199");
        expect(
          await covered(page, "again [Phone 1] and my work line [Phone 2]"),
          `second: "${await editorText(page)}"`,
        );
      }),
  );

  await check("BN3", "Bandage never covers passwords or keys: a key still gets its warning", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `key ${KEY}`);
      const n = await waitForNotice(page);
      expect(n && /AWS Access Key/.test(n.text), `notice: ${n?.text}`);
      expect((await editorText(page)).includes(KEY), "the key was swapped for a label");
    }),
  );

  // The codes a scammer asks you to read out still get a warning with Bandage on, the same as a card's security
  // code. A label would hide what the number is, and the warning needs to say that and who really asks for it.
  await check(
    "SSK1",
    "Bandage never covers a card's security code or a gift card's code: each still gets its warning, by its name",
    async () => {
      for (const [text, name] of [
        ["the 3 numbers on the back are 482", /Card Security Code/],
        ["the gift card code is 7KQ2-9PMX-4RT8", /Gift Card Code/],
      ])
        await withSite(ctx, "chatgpt", async (page) => {
          await store.set(ctx, { bandage: { "chatgpt.com": true } });
          await sleep(300);
          await typeText(page, text);
          const n = await waitForNotice(page);
          expect(n && name.test(n.text), `notice: ${n?.text}`);
          expect((await editorText(page)) === text, `the chat box changed: "${await editorText(page)}"`);
        });
    },
  );

  await check(
    "BN4",
    "Typed fast: the first Enter is held once while details are covered; the next Enter sends labels only",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await page.evaluate((t) => {
          const box = document.querySelector("textarea, [contenteditable='true']");
          box.focus();
          document.execCommand("insertText", false, t);
        }, `phone ${PHONE}`);
        await pressEnter(page); // before the typing pause
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "sent before covering");
        expect(await covered(page, "phone [Phone 1]"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Phone 1]") && !sent[0].includes("0123"),
          `sent: ${JSON.stringify(sent)}`,
        );
      }),
  );

  await check(
    "BN5",
    "First time: the warning offers cover names; yes turns Bandage on for this site and covers the detail now",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: {} });
        await sleep(300);
        await typeText(page, `my number is ${PHONE}`);
        const n = await waitForNotice(page);
        expect(n && /cover name/i.test(n.text), `no offer: ${n?.text}`);
        await clickDialogButton(page, "Yes, use cover names", readNotice);
        expect(await covered(page, "my number is [Phone 1]"), `chat box: "${await editorText(page)}"`);
        const { bandage } = await store.get(ctx, "bandage");
        expect(bandage?.["chatgpt.com"] === true, `bandage: ${JSON.stringify(bandage)}`);
        await store.set(ctx, { bandage: {} });
      }),
  );

  await check("BN6", "First time, no thanks: the normal warning stays, and Clotr doesn't ask again on this site", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: {} });
      await sleep(300);
      await typeText(page, `my number is ${PHONE}`);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "No thanks", readNotice);
      // The background stores the choice a moment after the click. I poll for it instead of reading once,
      // since reading right away can still catch the old value on a busy computer.
      const said = await waitFor(async () => {
        const { bandage } = await store.get(ctx, "bandage");
        return bandage?.["chatgpt.com"] === false ? true : null;
      }, 4000);
      expect(said, `bandage: ${JSON.stringify((await store.get(ctx, "bandage")).bandage)}`);
      await clearEditor(page);
      await typeText(page, "or 555-555-0177");
      TYPED_VALUES.add("555-555-0177");
      const n = await waitForNotice(page);
      expect(n && !/cover name/i.test(n.text), `asked again: ${n?.text}`);
      expect((await editorText(page)).includes("555-555-0177"), "covered without a yes");
      await store.set(ctx, { bandage: {} });
    }),
  );

  await check(
    "BN7",
    "Bandage in a rich chat box (ProseMirror): the email becomes [Email 1] and the message sends with the label",
    () =>
      withSite(ctx, "claude", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "claude.ai": true } });
        await sleep(300);
        TYPED_VALUES.add("jane.doe@example.com");
        await typeText(page, "write to jane.doe@example.com please");
        expect(await covered(page, "write to [Email 1] please"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Email 1]") && !sent[0].includes("jane.doe"),
          `sent: ${JSON.stringify(sent)}`,
        );
        await resetState(ctx, {});
      }),
  );

  // Pointing at or tabbing to a label in the AI's answer shows the real detail in a Clotr bubble. Clotr draws its
  // own hotspots on top of the labels instead of editing the reply, since rewriting it under a site's own
  // framework can break the chat.
  const REPLY = "Sure, I'll call [Phone 1] soon.";
  async function coveredReply(page) {
    await resetState(ctx, {});
    await store.set(ctx, { bandage: { "chatgpt.com": true } });
    await sleep(300);
    await typeText(page, `call me at ${PHONE}`);
    expect(await covered(page, `call me at [Phone 1]`), `chat box: "${await editorText(page)}"`);
    await pressEnter(page);
    await sleep(300);
    await page.evaluate((t) => window.__reply(t), REPLY);
    const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
    expect(spots && spots.buttons.length === 1, `hotspots: ${JSON.stringify(spots)}`);
    return spots;
  }
  // Finds where "[Phone 1]" sits on screen by locating it in the page's own text.
  const labelPoint = (page) =>
    page.evaluate((label) => {
      const t = [...document.querySelectorAll(".reply")].pop().firstChild;
      const r = document.createRange();
      r.setStart(t, t.nodeValue.indexOf(label));
      r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, "[Phone 1]");

  await check(
    "BN8",
    "Hover to peek: pointing at a label shows the real detail in a Clotr bubble; the AI's reply stays exactly as the site wrote it",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        const html = await page.evaluate(() => [...document.querySelectorAll(".reply")].pop().innerHTML);
        expect(html === REPLY.replace(/'/g, "&#39;") || html === REPLY, `the reply was changed: ${html}`);
        const { x, y } = await labelPoint(page);
        await page.mouse.move(x, y);
        const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
        expect(peek && peek.text.includes(PHONE), `peek: ${JSON.stringify(peek)}`);
        const pageText = await page.evaluate(() => document.body.innerText);
        expect(!pageText.includes(PHONE), "the real number is readable in the page");
        await page.mouse.move(0, 0);
        const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);
        expect(closed, "the bubble stayed open after moving away");
        await resetState(ctx, {});
      }),
  );

  await check("BN9", "Copy with real names: the bubble copies the whole answer with the label swapped back", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await coveredReply(page);
      const { x, y } = await labelPoint(page);
      await page.mouse.move(x, y);
      const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
      expect(peek, "no bubble appeared");
      await evalInClotr(
        page,
        `window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }, true`,
      );
      const btn = peek.buttons.find((b) => /copy/i.test(b.text));
      expect(btn, `no copy button: ${JSON.stringify(peek.buttons)}`);
      await clickNode(page, btn.nodeId);
      await sleep(200);
      const copied = await evalInClotr(page, "window.__copied");
      expect(copied === "Sure, I'll call 555-555-0123 soon.", `copied: ${JSON.stringify(copied)}`);
      await resetState(ctx, {});
    }),
  );

  await check("BN10", "Keyboard: focusing a label's hotspot opens the bubble; moving focus away closes it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      const spots = await coveredReply(page);
      await page.cdp.send("DOM.focus", { nodeId: spots.buttons[0].nodeId });
      const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
      expect(peek && peek.text.includes(PHONE), `peek: ${JSON.stringify(peek)}`);
      await page.evaluate(() => document.querySelector("textarea, [contenteditable='true']").focus());
      const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);
      expect(closed, "the bubble stayed open after focus moved on");
      await resetState(ctx, {});
    }),
  );
  // These are the labels most people meet first: their own name, a family member, and a birth date.
  await check(
    "BN11",
    "Bandage with your vault: your name becomes [Me], family [Family 1], a birth date its decade",
    async () => {
      await resetState(ctx, {});
      const vp = await openExtPage(ctx, "vault.html");
      try {
        await vp.type("#f-my_name", "Jane Q Doe");
        await vp.type("#f-family_name", "Emma");
        await vp.click("#save");
        const saved = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
        expect(saved, "the vault didn't save");
      } finally {
        await vp.close();
      }
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await withSite(ctx, "chatgpt", async (page) => {
        for (const v of ["Jane Q Doe", "Emma", "03/14/1948"]) TYPED_VALUES.add(v);
        await typeText(page, "I'm Jane Q Doe and my sister Emma was born on 03/14/1948");
        const text = await waitFor(async () => {
          const t = await editorText(page);
          return t.includes("[Me]") && t.includes("[Family 1]") ? t : null;
        }, 5000);
        expect(text, `chat box: "${await editorText(page)}"`);
        expect(/\[born in the 1940s\]/.test(text), `no decade label: "${text}"`);
        expect(!/Jane|Emma|1948/.test(text), `a real detail is left: "${text}"`);
      });
      await resetState(ctx, {});
    },
  );
  await check(
    "BN12",
    "Hotspots follow their label when the page's layout shifts without a scroll (a sidebar opens)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        await page.evaluate(() => {
          [...document.querySelectorAll(".reply")].pop().style.marginLeft = "220px"; // no scroll, no resize event
        });
        const follows = await waitFor(async () => {
          const spot = await readUI(page, "CLOTR-SPOTS");
          const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId: spot.buttons[0].nodeId });
          const hotX = (model.border[0] + model.border[2]) / 2;
          const { x } = await labelPoint(page);
          return Math.abs(hotX - x) < 6 ? true : null;
        }, 3000);
        expect(follows, "the hotspot stayed where the label used to be");
        await resetState(ctx, {});
      }),
  );
  await check(
    "BN13",
    "Typing through an input method (Japanese, Chinese…): nothing is swapped mid-composition, then covered",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await page.evaluate((t) => {
          const box = document.querySelector("#prompt-textarea");
          box.focus();
          box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
          document.execCommand("insertText", false, t);
        }, `call me at ${PHONE}`);
        await sleep(1200); // well past the typing pause: still composing, so nothing may change
        expect((await editorText(page)).includes(PHONE), `swapped mid-composition: "${await editorText(page)}"`);
        await page.evaluate(() => {
          const box = document.querySelector("#prompt-textarea");
          box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
          box.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
        expect(await covered(page, "call me at [Phone 1]"), `after composing: "${await editorText(page)}"`);
        await resetState(ctx, {});
      }),
  );
  await check(
    "BN14",
    "Bandage in a chat box inside a shadow root (Gemini, NotebookLM): the phone becomes [Phone 1] and sends",
    () =>
      withSite(ctx, "notebook", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "notebook.google.com": true } });
        await sleep(300);
        await typeText(page, `call me at ${PHONE}`);
        expect(await covered(page, "call me at [Phone 1]"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Phone 1]") && !sent[0].includes("0123"),
          `sent: ${JSON.stringify(sent)}`,
        );
        await resetState(ctx, {});
      }),
  );
  // Some sites keep a screen-reader-only copy of a message in a 1-pixel clipped box, and that copy holds the
  // label too. A hotspot over that hidden copy would draw a stray underline on empty page, as claude.ai showed.
  await check("BN15", "No hotspot for a label inside screen-reader-only text: only the visible label gets one", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `call me at ${PHONE}`);
      expect(await covered(page, `call me at [Phone 1]`), `chat box: "${await editorText(page)}"`);
      await pressEnter(page);
      await sleep(300);
      // The reply arrives with its hidden copy, as claude.ai's message rows do.
      await page.evaluate((text) => {
        const d = document.createElement("div");
        d.className = "reply";
        d.textContent = text;
        const sr = document.createElement("span");
        sr.textContent = "You said: call me at [Phone 1]";
        Object.assign(sr.style, {
          position: "absolute",
          width: "1px",
          height: "1px",
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        });
        d.append(sr);
        document.body.append(d);
      }, REPLY);
      await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
      await sleep(600);
      const spots = await readUI(page, "CLOTR-SPOTS");
      expect(spots?.buttons.length === 1, `hotspots: ${spots?.buttons.length}`);
      await resetState(ctx, {});
    }),
  );
  // When an update takes over an open tab, the old copy of Clotr steps aside. Its hotspots and any open bubble
  // need to leave with it, or they'd stay stuck on the page with nothing left to move or close them.
  await check("BN16", "When an updated Clotr takes over, the old copy's hotspots and open bubble leave the page", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await coveredReply(page);
      const { x, y } = await labelPoint(page);
      await page.mouse.move(x, y);
      expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble to start with");
      await evalInClotr(page, ORPHAN_CLOTR);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("clotr:hello")));
      await sleep(400);
      expect(!(await readUI(page, "CLOTR-PEEK")), "the old copy's bubble stayed on the page");
      expect(!(await readUI(page, "CLOTR-SPOTS")), "the old copy's hotspots stayed on the page");
    }),
  );

  // Microsoft Copilot's first message in a new chat has a burst of activity right after you send it, then goes
  // quiet for several seconds while it builds the conversation's own page, then the answer arrives. Clotr still
  // needs to be watching when that answer comes, since the quiet stretch could otherwise look like the page
  // settling down for good.
  await check("BN17", "A first answer that comes after a quiet pause and a new address still gets its hotspot", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `call me at ${PHONE}`);
      expect(await covered(page, "call me at [Phone 1]"), `chat box: "${await editorText(page)}"`);
      await pressEnter(page);
      await page.evaluate(() => {
        const busy = document.createElement("div");
        busy.className = "thinking";
        busy.textContent = "…";
        document.body.append(busy);
      });
      await sleep(4000); // longer than Clotr's wait for a pause in a streaming answer
      await page.evaluate((t) => {
        document.querySelector(".thinking")?.remove();
        history.pushState({}, "", "/c/0f3c1e8a-5b7d-4c2e-9a61-3d2f8e4b7c90");
        window.__reply(t);
      }, REPLY);
      const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 6000);
      expect(spots && spots.buttons.length === 1, `hotspots: ${JSON.stringify(spots)}`);
      await resetState(ctx, {});
    }),
  );

  // Clotr keeps no details across a reload, so it can't hand back the real values for labels the conversation
  // already has. A new detail picks up the numbering where the old labels left off, since one label must never
  // stand for two different details. An old label's bubble says plainly that Clotr didn't keep its detail,
  // rather than risk showing someone else's.
  const PHONE2 = "555-555-0199";
  const HOME2 = "45 Elm Street";
  TYPED_VALUES.add(PHONE2);
  TYPED_VALUES.add(HOME2);
  async function reloadedChat(page) {
    await resetState(ctx, {});
    await store.set(ctx, { bandage: { "gemini.google.com": true } });
    await sleep(300);
    await typeText(page, `call me at ${PHONE}, I live at ${HOME}`);
    const first = "call me at [Phone 1], I live at [Address 1]";
    expect(await covered(page, first), `before the reload: "${await editorText(page)}"`);
    await pressEnter(page);
    await sleep(300);
    expect((await sentMessages(page)).length === 1, "the first message wasn't sent");
    await page.evaluate(() => window.__reply("Noted: I'll call [Phone 1] and write to [Address 1]."));
    await sleep(500);
    const logged = page.logs.length;
    await page.reload({ waitUntil: "load" });
    await waitFor(() => page.logs.slice(logged).some((l) => l.startsWith("[Clotr] responses:")), 3000);
    expect(await waitFor(() => page.evaluate(() => window.__historyShown), 3000), "the conversation didn't come back");
    await sleep(300);
  }
  // Finds where `label` is drawn in the last message matching `selector` that holds it.
  const pointIn = (page, selector, label) =>
    page.evaluate(
      (sel, label) => {
        const msg = [...document.querySelectorAll(sel)].filter((e) => e.textContent.includes(label)).pop();
        const t = msg.firstChild;
        const r = document.createRange();
        r.setStart(t, t.nodeValue.indexOf(label));
        r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      },
      selector,
      label,
    );
  // Points at a label and reads the bubble, returning null if none opens, then moves away until it closes.
  async function peekAt(page, selector, label, timeout = 3000) {
    const peek = await waitFor(async () => {
      await page.mouse.move(0, 0);
      const { x, y } = await pointIn(page, selector, label);
      await page.mouse.move(x, y);
      return waitFor(() => readUI(page, "CLOTR-PEEK"), 500);
    }, timeout);
    await page.mouse.move(0, 0);
    await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);
    return peek;
  }

  await check(
    "BN18",
    "After a reload, a different phone and address get [Phone 2] and [Address 2], never a label the chat already holds",
    () =>
      withSite(ctx, "history", async (page) => {
        await reloadedChat(page);
        await typeText(page, `my work line is ${PHONE2}, the office is at ${HOME2}`);
        const want = "my work line is [Phone 2], the office is at [Address 2]";
        expect(await covered(page, want), `after the reload: "${await editorText(page)}"`);
        await resetState(ctx, {});
      }),
  );

  await check(
    "BN19",
    "After a reload, an old label's bubble says Clotr didn't keep its detail (never the new one); a new label shows its own",
    () =>
      withSite(ctx, "history", async (page) => {
        await reloadedChat(page);
        await typeText(page, `my work line is ${PHONE2}`);
        expect(await covered(page, "my work line is [Phone 2]"), `after the reload: "${await editorText(page)}"`);
        for (const [where, label] of [
          [".mine", "[Phone 1]"],
          [".reply", "[Phone 1]"],
          [".mine", "[Address 1]"],
        ]) {
          const peek = await peekAt(page, where, label);
          expect(peek && /didn.t keep/i.test(peek.text), `${label} in ${where}: ${JSON.stringify(peek)}`);
          expect(!/555|Oak|Elm/.test(peek.text), `${label} in ${where} showed a detail: ${peek.text}`);
        }
        const { x, y } = await pointIn(page, ".mine", "[Phone 1]");
        await page.mouse.move(x, y);
        if (await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000))
          await page.screenshot({ path: path.join(OUT, "bandage-not-kept.png") });
        await page.mouse.move(0, 0);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Got it, [Phone 2] for work."));
        // The answer's labels are found once it has been quiet for a moment (the reply check's pause).
        const peek = await peekAt(page, ".reply", "[Phone 2]", 8000);
        expect(peek && peek.text.includes(PHONE2), `[Phone 2]: ${JSON.stringify(peek)}`);
        const old = await peekAt(page, ".mine", "[Phone 1]");
        expect(old && /didn.t keep/i.test(old.text), `[Phone 1] after the new reply: ${JSON.stringify(old)}`);
        const pageText = await page.evaluate(() => document.body.innerText);
        expect(!pageText.includes(PHONE) && !pageText.includes(PHONE2), "a real number is readable in the page");
        await resetState(ctx, {});
      }),
  );

  await check(
    "BN19b",
    "After a reload, labels in messages that fade in still get their hotspots within a second of showing",
    () =>
      withSite(ctx, "history", async (page) => {
        await page.evaluate(() => sessionStorage.setItem("fadeIn", "1"));
        try {
          await reloadedChat(page);
          // The messages were invisible when the page first loaded, and fade in 600ms later.
          const spots = await waitFor(async () => {
            const s = await readUI(page, "CLOTR-SPOTS");
            return s?.buttons.length >= 3 ? s : null;
          }, 1500);
          expect(spots, `no hotspots within 1.5 s of the fade: ${JSON.stringify(await readUI(page, "CLOTR-SPOTS"))}`);
        } finally {
          await page.evaluate(() => sessionStorage.removeItem("fadeIn"));
          await resetState(ctx, {});
        }
      }),
  );

  // The sidebar can switch chats without a reload, using history.pushState for the new address, and the old
  // chat's messages stay on the page for a moment while the new one loads. The same label means a different
  // detail in each chat, so a label left over from the chat you just left must never show its detail in the
  // chat you're opening. Once the new chat is actually showing, its own labels work as usual.
  const CHAT_A = "8e41b07c2a9d4f15";
  const CHAT_B = "5d2c8a91f0b34e67"; // the history page's own address
  const chatShown = (page, id) =>
    waitFor(async () => ((await page.evaluate(() => window.__chatShown)) === id ? true : null), 6000);
  await check(
    "BN20",
    "Switching chats without a reload: a label left on the page by the other chat never shows this chat's detail",
    () =>
      withSite(ctx, "history", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "gemini.google.com": true } });
        await sleep(300);
        // Chat B: the work line becomes B's [Phone 1].
        await typeText(page, `my work line is ${PHONE2}`);
        expect(await covered(page, "my work line is [Phone 1]"), `chat B: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        // Chat A, from the sidebar: the home number becomes A's own [Phone 1], and A's answer shows it.
        await page.evaluate((id) => window.__openChat(id), CHAT_A);
        await sleep(300);
        await typeText(page, `call me at ${PHONE}`);
        expect(await covered(page, "call me at [Phone 1]"), `chat A: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("I'll call [Phone 1] tonight."));
        const inA = await peekAt(page, ".reply", "[Phone 1]", 8000);
        expect(inA && inA.text.includes(PHONE), `chat A's [Phone 1]: ${JSON.stringify(inA)}`);
        // Back to chat B: A's answer stays on the page for a moment, and its [Phone 1] is A's, not B's.
        await page.evaluate((id) => window.__openChat(id, 3000), CHAT_B);
        const left = await peekAt(page, ".reply", "[Phone 1]", 1500);
        expect(!left?.text.includes(PHONE2), `chat A's [Phone 1] showed chat B's number: ${JSON.stringify(left)}`);
        expect(!left, `a hotspot of the chat you left still opens: ${JSON.stringify(left)}`);
        // Chat B is back: its own [Phone 1] shows B's number in its next answer.
        expect(await chatShown(page, CHAT_B), "chat B didn't come back");
        await typeText(page, `still ${PHONE2}`);
        expect(await covered(page, "still [Phone 1]"), `chat B again: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Yes, [Phone 1] for work."));
        const inB = await peekAt(page, ".reply", "[Phone 1]", 8000);
        expect(inB && inB.text.includes(PHONE2) && !inB.text.includes(PHONE), `chat B's [Phone 1]: ${inB?.text}`);
        // A bubble open when the chat changes closes, and the label it was over shows nothing from the new chat.
        const { x, y } = await pointIn(page, ".reply", "[Phone 1]");
        await page.mouse.move(x, y);
        expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble over chat B's [Phone 1]");
        await page.evaluate((id) => window.__openChat(id, 3000), CHAT_A);
        const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2500);
        expect(closed, "the bubble of the chat you left stayed open");
        const leftB = await peekAt(page, ".reply", "[Phone 1]", 1000);
        expect(!leftB, `a hotspot of the chat you left still opens: ${JSON.stringify(leftB)}`);
        const pageText = await page.evaluate(() => document.body.innerText);
        expect(!pageText.includes(PHONE) && !pageText.includes(PHONE2), "a real number is readable in the page");
        await resetState(ctx, {});
      }),
  );

  // Firefox's background is an event page that can be asleep after a reload, and waking it up to answer any
  // message, settings included, can take a few seconds. An old label's hotspot must not wait on that wake-up,
  // so this check holds up the background's settings answer to prove the hotspot still shows up quickly.
  await check(
    "BN26",
    "After a reload, old labels' hotspots appear quickly even when the background is slow to answer",
    () =>
      withSite(ctx, "history", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "gemini.google.com": true } });
        await sleep(300);
        await typeText(page, `call me at ${PHONE}, I live at ${HOME}`);
        expect(
          await covered(page, "call me at [Phone 1], I live at [Address 1]"),
          `before the reload: "${await editorText(page)}"`,
        );
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Noted: I'll call [Phone 1] and write to [Address 1]."));
        await sleep(500);
        await ctx.worker.evaluate(() => {
          globalThis.__bn26Real = settingsFor;
          globalThis.settingsFor = async (...args) => {
            await new Promise((r) => setTimeout(r, 3000));
            return globalThis.__bn26Real(...args);
          };
        });
        try {
          const logged = page.logs.length;
          const t0 = Date.now();
          await page.reload({ waitUntil: "load" });
          // Both races start from the same t0 and run at the same time. Waiting for one to finish before
          // starting the other would make the second one's time at least as long as the first's.
          const [settingsMs, spotMs] = await Promise.all([
            waitFor(async () => {
              const got = page.logs.slice(logged).some((l) => l.startsWith("[Clotr] responses:"));
              return got ? Date.now() - t0 : null;
            }, 9000),
            waitFor(async () => {
              const s = await readUI(page, "CLOTR-SPOTS");
              return s?.buttons.length >= 3 ? Date.now() - t0 : null;
            }, 9000),
          ]);
          expect(settingsMs, "the delayed settings never arrived");
          expect(spotMs, `no hotspots for the old labels: ${JSON.stringify(await readUI(page, "CLOTR-SPOTS"))}`);
          expect(
            spotMs < 2500,
            `hotspots took ${spotMs}ms, well after the settings' ${settingsMs}ms: they must not wait for them`,
          );
        } finally {
          await ctx.worker.evaluate(() => {
            if (globalThis.__bn26Real) globalThis.settingsFor = globalThis.__bn26Real;
            delete globalThis.__bn26Real;
          });
        }
        await resetState(ctx, {});
      }),
  );

  // ---------- Underlines under the page's own pop-ups ----------
  // A site's sign-up pop-up, a menu, or its own sticky header and input box can sit on top of a label in an
  // answer. Clotr's dotted underline used to draw over them anyway, as Perplexity showed. Now a hotspot
  // hides while something of the page's own covers its label, and comes back once the label is visible again.
  // Clotr's own boxes, like the peek bubble, never count as covering a label.
  const spotsNow = async (page) => (await readUI(page, "CLOTR-SPOTS"))?.buttons || [];
  // Waits up to `ms` for hotspot `i` to reach the wanted `hidden` state, and returns how long that took, or null.
  async function spotTurns(page, i, hidden, ms) {
    const t0 = Date.now();
    const ok = await waitFor(async () => (await spotsNow(page))[i]?.hidden === hidden || null, ms, 20);
    return ok ? Date.now() - t0 : null;
  }
  // Finds the box of `label` in the `nth` reply, counting from the end when `nth` is negative.
  const labelRect = (page, nth = -1, label = "[Phone 1]") =>
    page.evaluate(
      (nth, label) => {
        const replies = [...document.querySelectorAll(".reply")];
        const t = replies[nth < 0 ? replies.length + nth : nth].firstChild;
        const r = document.createRange();
        r.setStart(t, t.nodeValue.indexOf(label));
        r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
        const { left, top, right, bottom, width, height } = r.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
      },
      nth,
      label,
    );
  // Adds a box of the page's own on top of `r`, as a sign-up pop-up or a menu would.
  const coverWith = (page, r, { tag = "div", padX = 24, padY = 12 } = {}) =>
    page.evaluate(
      (r, tag, padX, padY) => {
        const box = document.createElement(tag);
        box.id = "site-popup";
        box.textContent = "Sign up to keep your chats";
        Object.assign(box.style, {
          position: "fixed",
          left: `${r.left - padX}px`,
          top: `${r.top - padY}px`,
          width: `${r.width + 2 * padX + 160}px`,
          height: `${r.height + 2 * padY}px`,
          background: "#fff",
          border: "1px solid #999",
          boxShadow: "0 8px 24px rgba(0,0,0,.25)",
          font: "14px system-ui",
          zIndex: "1000",
        });
        document.body.append(box);
      },
      r,
      tag,
      padX,
      padY,
    );
  const uncover = (page) => page.evaluate(() => document.getElementById("site-popup").remove());
  // True once hotspot `i` has followed its label to its new spot at `r`.
  const spotAt = (page, i, r) =>
    waitFor(async () => {
      const spot = (await spotsNow(page))[i];
      if (!spot) return null;
      const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId: spot.nodeId });
      return Math.abs(model.border[0] - r.left) < 3 && Math.abs(model.border[1] - r.top) < 3 ? true : null;
    }, 2500);

  await check(
    "BN21",
    "A site's pop-up over a labelled answer hides its underline within 300 ms; closing the pop-up brings it back",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        expect((await spotTurns(page, 0, false, 2000)) !== null, "the hotspot never showed");
        await coverWith(page, await labelRect(page));
        const hid = await spotTurns(page, 0, true, 300);
        expect(hid !== null, "the underline still showed over the pop-up after 300 ms");
        await page.screenshot({ path: path.join(OUT, "bandage-under-popup.png") });
        await uncover(page);
        const back = await spotTurns(page, 0, false, 300);
        expect(back !== null, "the underline didn't come back within 300 ms of the pop-up closing");
        await resetState(ctx, {});
        return `hidden after ${hid} ms, back after ${back} ms`;
      }),
  );

  await check(
    "BN22",
    "A label scrolled under the chat's sticky header or behind its input box hides; scrolled back, it shows",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        // Builds the page the way most chats are laid out: a sticky header, the input box fixed at the
        // bottom, and enough height above and below the reply to actually scroll.
        await page.evaluate(() => {
          const header = document.createElement("header");
          header.textContent = "ChatGPT";
          Object.assign(header.style, { position: "sticky", top: "0", height: "64px", background: "#fff" });
          document.body.prepend(header);
          Object.assign(document.getElementById("composer").style, {
            position: "fixed",
            left: "0",
            right: "0",
            bottom: "0",
            height: "140px",
            background: "#fff",
          });
          const reply = [...document.querySelectorAll(".reply")].pop();
          const above = document.createElement("div");
          above.style.height = "900px";
          reply.before(above);
          const below = document.createElement("div");
          below.style.height = "1500px";
          reply.after(below);
        });
        // Scrolls until the label's top is `y` pixels from the top of the window.
        const scrollLabelTo = async (y) => {
          const r = await labelRect(page);
          await page.evaluate((dy) => window.scrollBy(0, dy), r.top - y);
          return labelRect(page);
        };
        const height = await page.evaluate(() => innerHeight);
        for (const [where, y] of [
          ["under the header", 20],
          ["behind the input box", height - 80],
        ]) {
          expect(await spotAt(page, 0, await scrollLabelTo(300)), `the hotspot didn't follow (before ${where})`);
          expect((await spotTurns(page, 0, false, 1500)) !== null, `hidden in open view (before ${where})`);
          await scrollLabelTo(y);
          expect((await spotTurns(page, 0, true, 1500)) !== null, `the underline still showed ${where}`);
          await scrollLabelTo(300);
          expect((await spotTurns(page, 0, false, 1500)) !== null, `the underline didn't come back from ${where}`);
        }
        await resetState(ctx, {});
      }),
  );

  await check(
    "BN23",
    "A page element named like Clotr's (clotr-fake) still hides an underline; Clotr's own bubble and corner warning don't",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        expect((await spotTurns(page, 0, false, 2000)) !== null, "the hotspot never showed");
        // A page can name its own element anything: only the boxes this copy of Clotr made are skipped.
        await coverWith(page, await labelRect(page), { tag: "clotr-fake" });
        expect((await spotTurns(page, 0, true, 1500)) !== null, "the underline showed over the page's clotr-fake");
        await uncover(page);
        expect((await spotTurns(page, 0, false, 1500)) !== null, "the underline didn't come back");

        // Clotr's own bubble over another label: a second answer moves under the bubble of the first.
        await page.evaluate(() => window.__reply("And [Phone 1] again."));
        expect(await waitFor(async () => (await spotsNow(page)).length === 2 || null, 6000), "no second hotspot");
        const r1 = await labelRect(page, 0);
        await page.mouse.move(r1.left + r1.width / 2, r1.top + r1.height / 2);
        expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble over the first label");
        // Checks which element is on top at each end of the label: Clotr's `own` box, or the reply under it.
        const ownOnTop = (r, own) =>
          page.evaluate(
            (r, own) => {
              const reply = [...document.querySelectorAll(".reply")].pop();
              return [r.left + 3, r.right - 3].every((x) => {
                const stack = document.elementsFromPoint(x, r.top + r.height / 2);
                const mine = stack.findIndex((e) => e.nodeName === own);
                return mine >= 0 && mine < stack.indexOf(reply);
              });
            },
            r,
            own,
          );
        await page.evaluate((r) => {
          Object.assign([...document.querySelectorAll(".reply")].pop().style, {
            position: "fixed",
            left: `${r.left + 4}px`,
            top: `${r.bottom + 14}px`,
          });
        }, r1);
        const r2 = await labelRect(page, -1);
        expect(await ownOnTop(r2, "CLOTR-PEEK"), "the bubble isn't over the second label (test setup)");
        expect(await spotAt(page, 1, r2), "the second hotspot didn't follow its label");
        expect(await readUI(page, "CLOTR-PEEK"), "the bubble closed (test setup)");
        expect((await spotsNow(page))[1].hidden === false, "the underline hid under Clotr's own bubble");
        await page.mouse.move(0, 0);
        await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);

        // Clotr's corner warning (a key typed while Bandage is on) over the same label.
        await typeText(page, `key ${KEY}`);
        expect(await waitForNotice(page), "no corner warning");
        await page.evaluate(() => {
          Object.assign([...document.querySelectorAll(".reply")].pop().style, {
            left: `${innerWidth - 300}px`,
            top: "60px",
          });
        });
        const r3 = await labelRect(page, -1);
        expect(await ownOnTop(r3, "CLOTR-NOTICE"), "the corner warning isn't over the label (test setup)");
        expect(await spotAt(page, 1, r3), "the hotspot didn't follow its label under the warning");
        expect((await spotsNow(page))[1].hidden === false, "the underline hid under Clotr's own corner warning");
        await resetState(ctx, {});
      }),
  );

  await check("BN24", "An open bubble closes when a pop-up covers its label", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await coveredReply(page);
      const r = await labelRect(page);
      await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
      const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
      expect(peek, "no bubble");
      // Into the bubble, as you would to reach its button: it stays open while the pointer is there.
      const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId: peek.buttons[0].nodeId });
      await page.mouse.move((model.border[0] + model.border[2]) / 2, (model.border[1] + model.border[5]) / 2);
      await sleep(500);
      expect(await readUI(page, "CLOTR-PEEK"), "the bubble closed with the pointer in it (test setup)");
      await coverWith(page, r, { padY: 3 }); // over the label, clear of the bubble below it
      const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 1000, 20);
      expect(closed, "the bubble stayed open over a label the pop-up covers");
      await page.mouse.move(0, 0);
      await resetState(ctx, {});
    }),
  );

  // Clotr only looks for labels in the page's own text, not inside shadow roots, so this check calls Clotr's UI
  // code directly to place a hotspot over a label that lives in an open shadow root instead. The underline's
  // cover check still has to work there too.
  await check(
    "BN25",
    "A label inside an open shadow root keeps its underline when nothing covers it, and hides under the page's pop-up",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => {
          const host = document.createElement("div");
          host.id = "shadow-reply";
          const p = document.createElement("p");
          p.textContent = "Sure, I'll call [Phone 1] soon.";
          host.attachShadow({ mode: "open" }).append(p);
          document.body.append(host);
        });
        await evalInClotr(
          page,
          `(() => {
            const p = document.getElementById("shadow-reply").shadowRoot.querySelector("p");
            const t = p.firstChild;
            const chat = {};
            const app = new Proxy(
              { safely: (fn) => (e) => fn(e), currentChat: () => chat, largeText: () => false },
              { get: (o, k) => (k in o ? o[k] : () => undefined) },
            );
            const ui = globalThis.Clotr.ui.create(app);
            ui.addSpot(t, t.nodeValue.indexOf("[Phone 1]"), "[Phone 1]", p, chat);
            ui.placeSpots();
            return true;
          })()`,
        );
        expect(await waitFor(async () => (await spotsNow(page)).length === 1 || null, 2000), "no hotspot");
        const r = await page.evaluate(() => {
          const t = document.getElementById("shadow-reply").shadowRoot.querySelector("p").firstChild;
          const range = document.createRange();
          range.setStart(t, t.nodeValue.indexOf("["));
          range.setEnd(t, t.nodeValue.indexOf("]") + 1);
          const { left, top, width, height } = range.getBoundingClientRect();
          return { left, top, width, height };
        });
        expect(await spotAt(page, 0, r), "the hotspot isn't over the label");
        await sleep(300);
        expect((await spotsNow(page))[0].hidden === false, "the underline hid with nothing over the label");
        await coverWith(page, r);
        expect((await spotTurns(page, 0, true, 300)) !== null, "the underline showed over the page's pop-up");
        await uncover(page);
        expect((await spotTurns(page, 0, false, 300)) !== null, "the underline didn't come back");
      }),
  );
};
