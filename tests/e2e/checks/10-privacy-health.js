// E2E checks: Z. Privacy & health. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    EXT,
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clickDialogButton,
    clickSend,
    ctx,
    editorText,
    evalInClotr,
    expect,
    fs,
    inClotrUI,
    openExtPage,
    openPopup,
    path,
    pressEnter,
    readDialog,
    readNotice,
    resetState,
    seedEvents,
    sentMessages,
    sleep,
    store,
    tapNode,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  await check("Z1", "Nothing typed during the run is stored anywhere by Clotr", async () => {
    const all = JSON.stringify(await store.get(ctx, null));
    const session = JSON.stringify(await ctx.worker.evaluate(() => chrome.storage.session.get(null)));
    const leaked = [...TYPED_VALUES]
      .flatMap((v) => [v, ...(v.match(/AKIA[0-9A-Z]{16}|\d{3}-\d{3}-\d{4}|\S+ at gmail dot com/g) || [])])
      .filter((v) => v.length >= 8 && (all.includes(v) || session.includes(v)));
    expect(!leaked.length, `found in storage: ${leaked.join(", ")}`);
    return `${TYPED_VALUES.size} inputs checked against ${all.length + session.length} bytes of storage`;
  });

  await check(
    "UN1",
    "A key with a hidden zero-width space and a phone with no-break spaces are caught; Hide it leaves nothing behind",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const key = "AKIA4HPQ\u200b7XZ2R6TWLJ3N";
        await typeText(page, `key ${key} or call 555\u00a0555\u00a00123`);
        const n = await waitForNotice(page);
        expect(n?.text.includes("AWS Access Key") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Hide it", readNotice);
        const text = await editorText(page);
        expect(
          !text.includes("AKIA4HPQ") && !text.includes("0123") && !/\u200b/.test(text),
          `after Hide it: ${JSON.stringify(text)}`,
        );
      }),
  );

  await check(
    "FS1",
    "Fast send (paste, then Enter at once): the message goes, then a 'Just sent' notice says what went and offers to ask first next time",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 555-555-0123");
        await pressEnter(page); // This happens before the 400 ms pause, so the warning was never visible.
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "the message didn't send (Warn must never hold it)");
        const n = await waitFor(() => readNotice(page), 2000);
        expect(n?.text.includes("Just sent to this AI") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Ask me first next time", readNotice);
        const responses = await waitFor(
          async () => ((await store.get(ctx, "responses")).responses?.phone_number === "block" ? true : null),
          2000,
        );
        expect(responses, "the choice wasn't saved");
      }),
  );

  await check(
    "FS3",
    "Fast send the site ignores (Gemini did): no false 'Just sent', nothing recorded as sent, the warning shows instead",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => {
          window.__ignoreNextSend = true;
        });
        await typeText(page, "call me at 555-555-0123");
        await pressEnter(page);
        await sleep(2000);
        expect((await sentMessages(page)).length === 0, "the page was supposed to ignore this Enter");
        const n = await readNotice(page);
        expect(n && !n.text.includes("Just sent") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        const sentEvents = (await store.events(ctx)).filter((e) => e.action === "allowed");
        expect(!sentEvents.length, `recorded as sent: ${JSON.stringify(sentEvents)}`);
      }),
  );

  await check(
    "EG1",
    "A site with its own early Enter handler can't send before Clotr: Ask before sending holds the key",
    async () => {
      await resetState(ctx); // This sets Ask before sending for keys, before the page opens.
      return withSite(ctx, "eager", async (page) => {
        await typeText(page, `key ${KEY}`);
        await pressEnter(page); // This fires immediately, before the site's own handler can send it.
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the site's early Enter handler sent a held key");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check("EG2", "A site that sends on Enter key-up can't slip past Ask before sending", async () => {
    await resetState(ctx); // This sets Ask before sending for keys, before the page opens.
    return withSite(ctx, "keyup", async (page) => {
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      await sleep(400);
      expect((await sentMessages(page)).length === 0, "sent on key-up despite Ask before sending");
      expect(await waitForDialog(page), "no dialog");
    });
  });

  await check(
    "MOB1",
    "Phone-sized screen (360×740, Firefox for Android): the warning fits and doesn't cover the chat box",
    () =>
      withSite(ctx, "demo", async (page) => {
        await page.setViewport({ width: 360, height: 740 }); // isMobile would reload the page mid-test, so it's left off.
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await resetState(ctx, {});
        await typeText(page, "call me at 555-555-0123 or jane.doe@gmail.com");
        expect(await waitForNotice(page), "no notice");
        page.cdp ??= await page.createCDPSession();
        const box = async () => {
          const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          let hit = null;
          (function walk(n) {
            if (hit) return;
            const cls = (n.attributes || []).join(" ");
            if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`)) hit = n;
            for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
          })(root);
          if (!hit) return null;
          const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: hit.nodeId })).model.border;
          return {
            left: Math.min(q[0], q[6]),
            right: Math.max(q[2], q[4]),
            top: Math.min(q[1], q[3]),
            bottom: Math.max(q[5], q[7]),
          };
        };
        const n = await box();
        await page.screenshot({ path: path.join(OUT, "mobile-notice.png") });
        const input = await page.$eval("#prompt", (t) => {
          const r = t.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        expect(n && n.left >= 0 && n.right <= 360, `notice outside the screen: ${JSON.stringify(n)}`);
        expect(
          n.bottom <= input.top,
          `the notice covers the chat box: notice ${JSON.stringify(n)}, box ${JSON.stringify(input)}`,
        );
      }),
  );

  // These are the two common phone widths. Each opens as a phone, with touch and a mobile viewport, before the page loads.
  const PHONES = [360, 390];
  const phone = (width) => ({ viewport: { width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  // Runs inside the warning's or dialog's shadow root. It measures where the box sits, every button and summary on
  // screen, the text size, and whether the page now scrolls sideways.
  function measureUI() {
    const shown = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const main = this.querySelector(".notice, .box");
    const r = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const rect = (n) => {
      const b = n.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
    };
    return {
      box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
      scrolls: main.scrollHeight > main.clientHeight + 1 && /auto|scroll/.test(cs.overflowY),
      font: parseFloat(getComputedStyle(main.querySelector("p")).fontSize),
      sizeAdjust: cs.textSizeAdjust || cs.webkitTextSizeAdjust,
      pageWidth: document.documentElement.scrollWidth,
      viewWidth: innerWidth,
      targets: [...this.querySelectorAll("button, summary")]
        .filter(shown)
        .map((n) => ({ text: n.textContent.trim().slice(0, 40), ...rect(n) })),
      actions: [...main.querySelectorAll(":scope > .actions > button")].map(rect),
    };
  }
  // Checks what a phone needs from a measured warning or dialog. It should stay on screen, nothing should scroll
  // sideways, targets should be thumb-sized, the two choices should sit side by side across the box, and the text
  // should be 16 px so the browser won't enlarge or shrink it.
  function expectPhoneFit(m, width, what) {
    const small = m.targets.filter((t) => t.h < 44 || t.w < 44).map((t) => `"${t.text}" ${t.w}×${t.h}`);
    expect(!small.length, `${what} at ${width} px: targets under 44 px: ${small.join(", ")}`);
    expect(m.box.left >= 0 && m.box.right <= width, `${what} at ${width} px is off screen: ${JSON.stringify(m.box)}`);
    expect(m.pageWidth <= m.viewWidth, `${what} at ${width} px: the page scrolls sideways (${m.pageWidth} px)`);
    expect(m.font >= 16, `${what} at ${width} px: text is ${m.font} px`);
    expect(/^(100%|none)$/.test(m.sizeAdjust), `${what} at ${width} px: text size adjust is ${m.sizeAdjust}`);
    const [a, b] = m.actions;
    expect(
      a && b && Math.abs(a.top - b.top) < 2 && b.right - a.left >= m.box.width * 0.8,
      `${what} at ${width} px: the two choices aren't side by side across the box: ${JSON.stringify(m.actions)}`,
    );
  }
  const tapLabels = async (page, read, labels) => {
    const ui = await read(page);
    for (const label of labels) {
      const b = ui.buttons.find((x) => x.text === label);
      expect(b, `no "${label}" in ${ui.text}`);
      await tapNode(page, b.nodeId);
      await sleep(150);
    }
  };
  const phoneShots = async (page, name) => {
    for (const theme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(150);
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`) });
    }
  };

  await check(
    "MOB2",
    "Phones (360 and 390 px, touch): the warning and the dialog have thumb-sized choices side by side and 16 px text that doesn't zoom, nothing scrolls sideways; light and dark",
    async () => {
      for (const width of PHONES) {
        await withSite(
          ctx,
          "demo",
          async (page) => {
            await resetState(ctx, {});
            await typeText(page, "Can you write a note to my landlord? Call me back at 555-555-0123");
            expect(await waitForNotice(page), "no notice");
            await phoneShots(page, `phone-notice-${width}`);
            // Open both folded parts with a finger, so every button is on screen to measure.
            await tapLabels(page, readNotice, ["More choices", "Why am I seeing this?"]);
            const m = await inClotrUI(page, "CLOTR-NOTICE", measureUI);
            expect(m.targets.length >= 6, `the folded parts didn't open: ${JSON.stringify(m.targets)}`);
            expectPhoneFit(m, width, "the warning");
            await phoneShots(page, `phone-notice-open-${width}`);
          },
          phone(width),
        );
        await resetState(ctx); // This sets Ask before sending for keys.
        await withSite(
          ctx,
          "demo",
          async (page) => {
            await typeText(page, `Here's the key ${KEY}`);
            await sleep(500); // This isn't a fast send; the dialog is what this measures.
            await pressEnter(page);
            expect(await waitForDialog(page), "no dialog");
            await phoneShots(page, `phone-dialog-${width}`);
            await tapLabels(page, readDialog, ["More choices"]);
            expectPhoneFit(await inClotrUI(page, "CLOTR-GUARD", measureUI), width, "the dialog");
          },
          phone(width),
        );
      }
      // Larger warnings (helping someone) grow on a phone too, and still fit.
      await store.set(ctx, { largeText: true });
      try {
        await withSite(
          ctx,
          "demo",
          async (page) => {
            await resetState(ctx, {});
            await typeText(page, "Call me back at 555-555-0123");
            expect(await waitForNotice(page), "no notice");
            await phoneShots(page, "phone-notice-large-360");
            const m = await inClotrUI(page, "CLOTR-NOTICE", measureUI);
            expectPhoneFit(m, 360, "the larger warning");
            expect(m.font >= 19, `the larger warning's text is ${m.font} px on a phone`);
          },
          phone(360),
        );
      } finally {
        await store.set(ctx, { largeText: false });
      }
    },
  );

  await check(
    "MOB3",
    "Phones: the warning and the dialog follow the part of the page you can see (the on-screen keyboard moves it): 8 px below its top, scrolling inside when taller",
    async () => {
      // Simulates the browser's own report of the visible area, the way Clotr reads it, moving it as an on-screen
      // keyboard would.
      const move = (page, top, height) =>
        evalInClotr(
          page,
          `(() => {
            const v = window.visualViewport;
            Object.defineProperty(v, "offsetTop", { get: () => ${top}, configurable: true });
            Object.defineProperty(v, "height", { get: () => ${height}, configurable: true });
            v.dispatchEvent(new Event("${top ? "scroll" : "resize"}"));
            return true;
          })()`,
        );
      const notice = (page) => inClotrUI(page, "CLOTR-NOTICE", measureUI);
      await withSite(
        ctx,
        "demo",
        async (page) => {
          await resetState(ctx, {});
          await typeText(page, "Call me back at 555-555-0123 or write to jane.doe@gmail.com");
          expect(await waitForNotice(page), "no notice");
          await move(page, 300, 360);
          await sleep(100);
          let m = await notice(page);
          expect(Math.abs(m.box.top - 308) <= 1, `not 8 px below the visible top (300): ${JSON.stringify(m.box)}`);
          expect(m.box.bottom <= 300 + 360 - 8 + 1, `runs past the visible area: ${JSON.stringify(m.box)}`);
          // With a small visible area, like a big keyboard on a small phone, the warning stays inside it and scrolls.
          await move(page, 120, 150);
          await sleep(100);
          m = await notice(page);
          expect(Math.abs(m.box.top - 128) <= 1 && m.box.bottom <= 120 + 150 - 8 + 1, `${JSON.stringify(m.box)}`);
          expect(m.scrolls, "a warning taller than the visible area doesn't scroll inside");
          // When the keyboard closes, the warning moves back to the top.
          await move(page, 0, 800);
          await sleep(100);
          m = await notice(page);
          expect(Math.abs(m.box.top - 8) <= 1, `didn't return to the top: ${JSON.stringify(m.box)}`);
          // A warning that appears while the visible area is moved lands in it at once.
          await move(page, 200, 400);
          await typeText(page, " and 555-555-0188");
          await sleep(900);
          m = await notice(page);
          expect(Math.abs(m.box.top - 208) <= 1, `a new warning missed the visible area: ${JSON.stringify(m.box)}`);
        },
        phone(360),
      );
      await resetState(ctx); // This sets Ask before sending for keys.
      await withSite(
        ctx,
        "demo",
        async (page) => {
          await move(page, 250, 380);
          await typeText(page, `Here's the key ${KEY}`);
          await sleep(500); // This isn't a fast send; the dialog is what this measures.
          await pressEnter(page);
          expect(await waitForDialog(page), "no dialog");
          const m = await inClotrUI(page, "CLOTR-GUARD", measureUI);
          expect(
            m.box.top >= 250 + 8 - 1 && m.box.bottom <= 250 + 380 - 8 + 1,
            `the dialog isn't inside the visible area (250 to 630): ${JSON.stringify(m.box)}`,
          );
        },
        phone(360),
      );
    },
  );

  // Measures Clotr's own pages on a phone, where Firefox for Android opens the popup as a full screen. It checks
  // what a finger taps, what the browser would zoom, and whether anything runs off the side.
  function measurePage() {
    const shown = (n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden";
    };
    const name = (n) =>
      `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""} "${(n.textContent || n.getAttribute("aria-label") || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 30)}"`;
    // A finger taps buttons, menus, folds, text boxes, button-like links and a checkbox's whole label. The report's
    // mind map is a picture whose parts can be selected, and its "Show as a table" view lists the same parts as rows.
    const targets = [
      ...document.querySelectorAll(
        'button, select, summary, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), a.btn, [role="button"]:not(svg *), label:has(> input[type="checkbox"])',
      ),
    ].filter(shown);
    const small = targets
      .map((n) => [n, n.getBoundingClientRect()])
      .filter(([, r]) => r.height < 43.5 || r.width < 43.5)
      .map(([n, r]) => `${name(n)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    // A phone zooms in on a text box whose text is under 16 px.
    const fields = [...document.querySelectorAll("input, textarea, select")]
      .filter((n) => shown(n) && !/checkbox|radio/.test(n.type) && parseFloat(getComputedStyle(n).fontSize) < 16)
      .map((n) => `${name(n)} ${getComputedStyle(n).fontSize}`);
    const html = document.documentElement;
    const wide = [...document.body.querySelectorAll("*")]
      .filter((n) => shown(n) && n.getBoundingClientRect().right > innerWidth + 1 && !n.closest("svg"))
      .slice(0, 4)
      .map(name);
    return {
      targets: targets.length,
      small,
      fields,
      wide,
      layoutWidth: html.clientWidth,
      pageWidth: html.scrollWidth,
      sizeAdjust: getComputedStyle(html).textSizeAdjust,
    };
  }
  function expectPageFit(m, width, what) {
    expect(m.layoutWidth === width, `${what} at ${width} px is laid out ${m.layoutWidth} px wide (a phone shrinks it)`);
    expect(m.pageWidth <= width && !m.wide.length, `${what} at ${width} px runs off the side: ${m.wide.join(", ")}`);
    const more = m.small.length > 8 ? ` and ${m.small.length - 8} more` : "";
    expect(!m.small.length, `${what} at ${width} px, targets under 44 px: ${m.small.slice(0, 8).join(", ")}${more}`);
    expect(
      !m.fields.length,
      `${what} at ${width} px, text boxes under 16 px (a phone zooms in): ${m.fields.join(", ")}`,
    );
    expect(/^(100%|none)$/.test(m.sizeAdjust), `${what} at ${width} px: text size adjust is ${m.sizeAdjust}`);
  }
  async function openOnPhone(file, width) {
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`${file} error: ${err.message}`));
    await page.setViewport(phone(width).viewport);
    await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/${file}`);
    await page.evaluate(() => document.fonts.ready); // Clotr's own font is wider than the fallback, so this waits for it to load.
    await sleep(600);
    return page;
  }
  const pageShots = async (page, name) => {
    for (const theme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(200);
      await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`), fullPage: true });
    }
  };

  await check(
    "MOB4",
    "Phones (360 and 390 px, touch): the popup and its Settings fit the screen with thumb-sized controls and text that doesn't zoom; the desktop popup keeps its size",
    async () => {
      await store.set(ctx, { events: seedEvents() });
      for (const width of PHONES) {
        const popup = await openOnPhone("popup.html", width);
        try {
          for (const tab of ["overview", "activity", "settings"]) {
            await popup.tap(`#tab-${tab}`);
            await sleep(400);
            expectPageFit(await popup.evaluate(measurePage), width, `the popup's ${tab}`);
            await pageShots(popup, `phone-popup-${tab}-${width}`);
          }
          // Advanced options show more controls. They fit too.
          await popup.tap("label:has(> #advanced)");
          await sleep(400);
          expect(await popup.$eval("#advanced", (b) => b.checked), "tapping the label didn't switch it");
          expectPageFit(await popup.evaluate(measurePage), width, "the popup's advanced settings");
          await popup.tap("label:has(> #advanced)");
          await sleep(300);
        } finally {
          await popup.close();
        }
      }
      // On a computer the popup stays 380 px wide and compact (a fluid width would shrink a real popup to nothing).
      const desk = await openPopup(ctx);
      try {
        const size = await desk.evaluate(() => ({
          body: document.body.getBoundingClientRect().width,
          tab: document.getElementById("tab-settings").getBoundingClientRect().height,
        }));
        expect(size.body === 380 && size.tab < 44, `the desktop popup changed: ${JSON.stringify(size)}`);
      } finally {
        await desk.close();
      }
    },
  );

  await check(
    "MOB5",
    "Phones (360 and 390 px, touch): the welcome page, the vault, What Clotr stores and the report fit the screen with thumb-sized controls and text that doesn't zoom; light and dark",
    async () => {
      await store.set(ctx, { events: seedEvents() });
      const pages = [
        ["vault.html?welcome=1", "welcome"],
        ["vault.html", "vault"],
        ["stored.html", "stored"],
        ["dashboard.html", "report"],
      ];
      for (const width of PHONES) {
        for (const [file, name] of pages) {
          const page = await openOnPhone(file, width);
          try {
            expectPageFit(await page.evaluate(measurePage), width, name);
            await pageShots(page, `phone-${name}-${width}`);
          } finally {
            await page.close();
          }
        }
      }
    },
  );

  // TQ20 covers each Tourniquet choice on a phone, but it's held back with the rest of Tourniquet. The real test
  // runs against an all-on build in 21-tourniquet.js.

  await check(
    "MOB5C",
    "Welcome page: when the browser hasn't let Clotr into some built-in AI chats, a card asks for exactly those from a tap (and stays away when nothing's missing)",
    async () => {
      const builtIn = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).host_permissions;
      const missing = builtIn.filter((o) => ["https://grok.com/*", "https://pi.ai/*"].includes(o));
      const welcome = await openOnPhone("vault.html?welcome=1", 360);
      try {
        expect(await welcome.$eval("#allow-card", (c) => c.hidden), "the card shows with every AI chat allowed");
      } finally {
        await welcome.close();
      }
      for (const width of PHONES) {
        const page = await ctx.browser.newPage();
        page.on("pageerror", (err) => ctx.problems.push(`welcome error: ${err.message}`));
        await page.setViewport(phone(width).viewport);
        // Simulates the browser's answers for someone who didn't grant two of the AI chats at install. Its permission
        // prompt can't be answered under automation, so the first ask is turned down and the second is allowed.
        await page.evaluateOnNewDocument((gone) => {
          const missing = new Set(gone);
          const real = chrome.permissions.contains.bind(chrome.permissions);
          window.__asked = [];
          chrome.permissions.contains = async (p) => ((p.origins || []).some((o) => missing.has(o)) ? false : real(p));
          chrome.permissions.request = async (p) => {
            window.__asked.push(p);
            if (window.__asked.length === 1) return false;
            for (const o of p.origins || []) missing.delete(o);
            return true;
          };
        }, missing);
        try {
          await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
          await page.evaluate(() => document.fonts.ready);
          const shown = await waitFor(() => page.$eval("#allow-card", (c) => !c.hidden && c.innerText), 2000);
          expect(shown && shown.includes("2 of the AI chats"), `card: ${JSON.stringify(shown)}`);
          await phoneShots(page, `phone-welcome-card-${width}`);
          expectPageFit(await page.evaluate(measurePage), width, "the welcome page with its card");
          if (width !== PHONES[0]) continue;
          await page.tap("#allow-ai");
          const no = await waitFor(() => page.$eval("#allow-status", (s) => s.textContent), 2000);
          expect(/didn't allow/.test(no), `after a no: ${JSON.stringify(no)}`);
          await page.tap("#allow-ai");
          const yes = await waitFor(
            () => page.$eval("#allow-status", (s) => (/now/.test(s.textContent) ? s.textContent : null)),
            2000,
          );
          expect(yes, "no word that it worked");
          const asked = await page.evaluate(() => window.__asked);
          expect(
            asked.length === 2 && asked.every((p) => JSON.stringify(p) === JSON.stringify({ origins: missing })),
            `asked for ${JSON.stringify(asked)}, not exactly ${JSON.stringify(missing)}`,
          );
          expect(await page.$eval("#allow-ai", (b) => b.hidden || !b.offsetParent), "the button stays after a yes");
          await phoneShots(page, `phone-welcome-card-done-${width}`);
        } finally {
          await page.close();
        }
      }
    },
  );

  // Simulates sending on a phone: a finger on the send button fires touchstart, then touchend, then the browser's
  // click. The keyboard's Enter works differently across phones too, since some send it as a real key and others
  // only send the new line it types, with keyCode 229 and no Enter key at all.
  const tapSend = async (page) => {
    const at = await page.evaluate(
      `(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })(${page.site.send})`,
    );
    await page.touchscreen.tap(at.x, at.y);
  };
  const phoneNewLine = async (page) => {
    page.cdp ??= await page.createCDPSession();
    const key = { key: "Unidentified", windowsVirtualKeyCode: 229 };
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r", unmodifiedText: "\r" });
    await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  };
  // Others hand the browser the new line as text, the way they type a word.
  await check(
    "MOB5D",
    "Welcome page on a phone: finding Clotr and where the warning shows are told the phone's way (no puzzle piece, no top-right corner)",
    async () => {
      const read = (page) =>
        page.evaluate(() =>
          [document.getElementById("pin-step"), document.querySelector("h2.pin-title")]
            .concat([...document.querySelectorAll(".try-hint")])
            .filter(Boolean)
            .map((el) => el.innerText)
            .join(" | "),
        );
      const onPhone = await openOnPhone("vault.html?welcome=1", 360);
      try {
        const text = await read(onPhone);
        expect(!/puzzle piece|top-right/i.test(text), `on a phone: ${JSON.stringify(text)}`);
        expect(/⋮/.test(text) && /top of the screen/.test(text), `on a phone, no phone words: ${JSON.stringify(text)}`);
      } finally {
        await onPhone.close();
      }
      const onComputer = await ctx.browser.newPage();
      try {
        await onComputer.setViewport({ width: 1040, height: 900 });
        await onComputer.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
        const text = await read(onComputer);
        expect(/puzzle piece/.test(text) && /top-right/.test(text), `on a computer: ${JSON.stringify(text)}`);
        expect(!/⋮/.test(text), `on a computer, phone words show: ${JSON.stringify(text)}`);
      } finally {
        await onComputer.close();
      }
    },
  );

  const phoneTextNewLine = async (page) => {
    page.cdp ??= await page.createCDPSession();
    await page.cdp.send("Input.insertText", { text: "\n" });
  };
  await check(
    "MOB6",
    "Phones (touch): a tap on the send button and the keyboard's Enter (as a key, or only as a new line) are held when a kind is set to Ask before sending, the person can still send from the dialog, and all three send under Warn",
    async () => {
      const ways = [
        ["phone", "a tap on the send button", tapSend],
        ["phone", "a phone keyboard's Enter key", pressEnter],
        ["phone", "a phone keyboard's new line (no Enter key)", phoneNewLine],
        ["phone", "a phone keyboard's new line typed as text", phoneTextNewLine],
        ["phoneTextarea", "a phone keyboard's new line in a plain text box", phoneNewLine],
      ];
      const notes = [];
      for (const [site, way, send] of ways) {
        await resetState(ctx); // This sets Ask before sending for keys, before the page opens.
        await withSite(
          ctx,
          site,
          async (page) => {
            await typeText(page, `Here's the key ${KEY}`);
            await send(page); // This happens before the 400 ms pause, since it's the send itself that's held.
            await sleep(400);
            const seen = await page.evaluate(() => window.__seen.slice());
            if (send === tapSend)
              expect(seen.includes("touchstart") && seen.includes("touchend"), `not a real tap: ${seen}`);
            if (send !== pressEnter && send !== tapSend)
              expect(!seen.includes("keydown Enter"), `an Enter key reached the page: ${seen}`);
            expect((await sentMessages(page)).length === 0, `${way} sent a key that waits for an answer`);
            expect(await waitForDialog(page), `${way}: no dialog`);
            // The choice belongs to the person: tapping "Leave it in and send" sends it, once.
            await sleep(700);
            await tapLabels(page, readDialog, ["Leave it in and send"]);
            const sent = await waitFor(
              async () => ((await sentMessages(page)).length ? sentMessages(page) : null),
              2000,
            );
            expect(
              sent?.length === 1 && sent[0].includes(KEY),
              `${way}, then Leave it in: sent ${JSON.stringify(sent)}`,
            );
          },
          phone(360),
        );
        await resetState(ctx, {}); // Under Warn, nothing is ever held.
        await withSite(
          ctx,
          site,
          async (page) => {
            await typeText(page, "Call me back at 555-555-0123");
            await sleep(500);
            await send(page);
            const sent = await waitFor(
              async () => ((await sentMessages(page)).length ? sentMessages(page) : null),
              1500,
            );
            expect(sent?.length === 1, `${way} didn't send under Warn: ${JSON.stringify(sent)}`);
          },
          phone(360),
        );
        notes.push(way);
      }
      return `held and sent: ${notes.join("; ")}`;
    },
  );

  await check(
    "UB1",
    "Unlabeled icon send button + Ask before sending: clicking it right after pasting a key is held for your answer",
    async () => {
      await resetState(ctx); // This sets Ask before sending for keys, before the page opens.
      return withSite(ctx, "iconsend", async (page) => {
        await typeText(page, `key ${KEY}`);
        await clickSend(page); // This happens before the 400 ms pause.
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the unlabeled send button sent a held message");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check(
    "UB2",
    "Unlabeled icon send button + Warn: the message goes, then 'Just sent' (confirmed by the box emptying)",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 555-555-0123");
        await clickSend(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "didn't send (Warn must never hold)");
        const n = await waitFor(() => readNotice(page), 2500);
        expect(n?.text.includes("Just sent"), `notice: ${n?.text}`);
      }),
  );

  await check(
    "UB3b",
    "Ask before sending: the chat box's model picker still opens while a key waits for an answer",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx);
        await typeText(page, `key ${KEY}`);
        const opened = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const b = document.getElementById("mode");
              b.addEventListener("click", () => resolve(true), { once: true });
              b.click();
              setTimeout(() => resolve(false), 300);
            }),
        );
        expect(opened, "Clotr held a click on the model picker");
      }),
  );

  await check("UB3", "Other buttons in the chat box (Attach) are never counted as a send", () =>
    withSite(ctx, "iconsend", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 555-555-0123");
      await page.evaluate(() => document.getElementById("attach").click());
      await sleep(2000);
      expect((await sentMessages(page)).length === 0, "attach sent the message");
      const n = await readNotice(page);
      expect(!n?.text.includes("Just sent"), `false 'Just sent': ${n?.text}`);
      expect(!(await store.events(ctx)).some((e) => e.action === "allowed"), "an Attach click was recorded as a send");
    }),
  );

  await check("FS2", "No 'Just sent' notice when the warning was on screen and you chose to send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 555-555-0123");
      expect(await waitForNotice(page), "no warning");
      await sleep(1600); // time to read it
      await pressEnter(page);
      await sleep(600);
      expect((await sentMessages(page)).length === 1, "didn't send");
      const n = await readNotice(page);
      expect(!n || !n.text.includes("Just sent"), `nagged after an informed send: ${n?.text}`);
    }),
  );

  await check("PP1", "Popup away from an AI chat says where Clotr works (the built-in list by name)", async () => {
    const popup = await openPopup(ctx);
    const line = await popup.$eval("#site", (n) => n.innerText);
    await popup.close();
    expect(/works on ChatGPT, Claude, Gemini and \d+ more AI chats/.test(line), `site card: ${JSON.stringify(line)}`);
  });

  await check(
    "CSP1",
    "Clotr's pages run under the strict policy with no violations (popup tabs, welcome, vault, What Clotr stores)",
    async () => {
      const pages = [];
      const popup = await openPopup(ctx);
      pages.push(["popup", popup]);
      for (const f of [
        "vault.html?welcome=1",
        "vault.html",
        "stored.html",
        "dashboard.html",
        "policy.html",
        "check.html",
        "practice.html",
      ])
        pages.push([f, await openExtPage(ctx, f)]);
      const violations = [];
      try {
        for (const [name, page] of pages) {
          const csp = await page.evaluate(
            () =>
              new Promise((resolve) => {
                const seen = [];
                document.addEventListener("securitypolicyviolation", (e) =>
                  seen.push(`${e.violatedDirective} ${e.blockedURI}`),
                );
                // Exercise the page, then collect.
                for (const t of document.querySelectorAll('[role="tab"], #tab-overview, #tab-activity, #tab-settings'))
                  t.click?.();
                setTimeout(() => resolve(seen), 800);
              }),
          );
          violations.push(...csp.map((v) => `${name}: ${v}`));
        }
        const header = await popup.evaluate(() =>
          fetch(location.href)
            .then(() => "fetch self ok")
            .catch((e) => String(e)),
        );
        expect(header === "fetch self ok", `own files must stay readable: ${header}`);
        const outside = await popup.evaluate(() =>
          fetch("https://chatgpt.com/robots.txt")
            .then(() => "reached chatgpt.com")
            .catch(() => "blocked"),
        ); // Clotr has permission for this host, so only the policy stops the request.
        expect(outside === "blocked", `a page could connect out: ${outside}`);
      } finally {
        for (const [, page] of pages) await page.close();
      }
      expect(!violations.length, violations.slice(0, 5).join(" | "));
    },
  );
};
