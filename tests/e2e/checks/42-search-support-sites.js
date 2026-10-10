// E2E checks: SX. Search engines and support-chat widgets stay off until you switch one on, the same opt-in
// pattern as email and chat apps (20-everyday-sites.js). Once on, a search box warns before the search goes
// out, and a support widget warns the same way an AI chat does. ../run.js runs these checks in order, sharing
// one env with helpers from ../lib.js.
"use strict";

module.exports = async function (env) {
  const { EXT, check, clotrActive, ctx, expect, expectNoUI, fs, launch, os, path } = env;
  const { clickDialogButton, pressEnter, resetState, sentMessages, settle, sleep, store, typeText, waitFor } = env;
  const { waitForDialog, DIALOG_WAIT } = env;
  const { withSite } = env;
  const CARD = "4111 1111 1111 1111";

  // Every support-chat widget Clotr knows, each granted its own one host. They all embed the same way (their
  // own iframe, at their own fixed address), so the same checks run against every one instead of trusting that
  // by analogy from a single widget.
  const SUPPORT_WIDGETS = [
    {
      key: "supportIntercom",
      host: "https://widget.intercom.io/*",
      origin: "https://widget.intercom.io/",
      name: "Intercom",
    },
    { key: "supportDrift", host: "https://widget.drift.com/*", origin: "https://widget.drift.com/", name: "Drift" },
    {
      key: "supportFreshchat",
      host: "https://wchat.freshchat.com/*",
      origin: "https://wchat.freshchat.com/",
      name: "Freshchat",
    },
    { key: "supportCrisp", host: "https://client.crisp.chat/*", origin: "https://client.crisp.chat/", name: "Crisp" },
    {
      key: "supportLiveChat",
      host: "https://secure.livechatinc.com/*",
      origin: "https://secure.livechatinc.com/",
      name: "LiveChat",
    },
    { key: "supportTawkto", host: "https://embed.tawk.to/*", origin: "https://embed.tawk.to/", name: "Tawk.to" },
    {
      key: "supportTidio",
      host: "https://widget-v4.tidiochat.com/*",
      origin: "https://widget-v4.tidiochat.com/",
      name: "Tidio",
    },
  ];

  // Search engines where the typing box lives directly in the page, the same shape as Google, Bing and
  // DuckDuckGo above, just more of them.
  const MORE_SEARCH_SITES = [
    ["braveSearch", "Brave Search"],
    ["startpageSearch", "Startpage"],
    ["ecosiaSearch", "Ecosia"],
    ["yahooSearch", "Yahoo Search"],
  ];

  // readDialog/clickDialogButton in lib.js read Clotr's UI through the top page's own CDP session, which can see
  // into same-process iframes and closed shadow roots but not into an out-of-process iframe (what Chrome gives a
  // cross-origin widget like Intercom's). A frame's own `.client` is its own CDP session, which does see its own
  // document and shadow roots, and DOM.getBoxModel on that session still reports coordinates in the page's
  // viewport, so a click through page.mouse still lands in the right spot.
  async function readFrameDialog(frame) {
    const { root } = await frame.client.send("DOM.getDocument", { depth: -1, pierce: true });
    let host = null;
    (function find(n) {
      if (host) return;
      if (n.nodeName === "CLOTR-GUARD") host = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
    })(root);
    if (!host) return null;
    const texts = [];
    const buttons = [];
    const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(""));
    (function walk(n) {
      if (n.nodeName === "STYLE") return;
      if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
      if (n.nodeName === "BUTTON" || n.nodeName === "SUMMARY")
        buttons.push({ text: textOf(n).trim(), nodeId: n.nodeId });
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(host);
    return { text: texts.join(" | "), buttons };
  }
  const waitForFrameDialog = (frame) => waitFor(() => readFrameDialog(frame), DIALOG_WAIT);
  // A mouse click needs the button's coordinates translated into the top page's viewport, which an OOPIF's own
  // box model may not give reliably, so instead I resolve the button to a live JS object on the frame's own
  // session and call its own .click() directly: the same effect a mouse click would have, with no coordinates
  // involved at all.
  async function clickFrameDialogButton(frame, label) {
    const dialog = await readFrameDialog(frame);
    const btn = dialog?.buttons.find((b) => b.text === label);
    expect(btn, `widget dialog button "${label}" not found (dialog: ${dialog?.text})`);
    const { object } = await frame.client.send("DOM.resolveNode", { nodeId: btn.nodeId });
    await frame.client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(){ this.click(); }",
    });
    await settle(300);
  }

  // A script can't click the browser's own permission prompt, so a copy of the extension whose manifest already
  // grants the host stands in for "you switched it on" (the same trick 20-everyday-sites.js uses for email and
  // chat apps). A granted host behaves the same either way.
  async function withGranted(extraHosts, fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    let other;
    try {
      fs.cpSync(EXT, copy, { recursive: true });
      const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
      m.host_permissions = [...m.host_permissions, ...extraHosts];
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
      other = await launch(copy);
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            if (!s) await syncUserSites();
            return Boolean(s);
          }),
        5000,
      );
      await resetState(other);
      await store.set(other, { bandage: {} });
      return await fn(other);
    } finally {
      if (other) {
        await other.browser.close();
        fs.rmSync(other.profile, { recursive: true, force: true });
      }
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("SX1", "Search engines and support chats stay off until you switch one on", async () => {
    for (const key of ["googleSearch", "bingSearch", "duckduckgoSearch", ...MORE_SEARCH_SITES.map(([k]) => k)]) {
      await withSite(ctx, key, async (page) => {
        expect(!clotrActive(page), `Clotr ran on ${key} without being switched on`);
        await typeText(page, CARD);
        await expectNoUI(page, `${key} not switched on`);
      });
    }
    for (const { key, origin, name } of SUPPORT_WIDGETS) {
      await withSite(ctx, key, async (page) => {
        await settle(300);
        expect(!page.logs.some((l) => l.includes(origin)), `Clotr ran in the ${name} widget without being switched on`);
      });
    }
  });

  await check(
    "SX2",
    "Switched on: a card number in a search box warns before the search, and the search still goes out once you choose to send",
    () =>
      withGranted(
        [
          "https://www.google.com/*",
          "https://www.bing.com/*",
          "https://duckduckgo.com/*",
          "https://search.brave.com/*",
          "https://www.startpage.com/*",
          "https://www.ecosia.org/*",
          "https://search.yahoo.com/*",
        ],
        (other) => {
          const engines = [
            ["googleSearch", "Google"],
            ["bingSearch", "Bing"],
            ["duckduckgoSearch", "DuckDuckGo"],
            ...MORE_SEARCH_SITES,
          ];
          return (async () => {
            const seen = [];
            for (const [key, name] of engines) {
              await withSite(other, key, async (page) => {
                expect(clotrActive(page), `Clotr isn't running on ${key} after it was switched on`);
                await typeText(page, CARD);
                await pressEnter(page);
                const dialog = await waitForDialog(page);
                expect(dialog, `${name}: no dialog`);
                expect(/search/i.test(dialog.text), `${name}: dialog doesn't read as a search: ${dialog.text}`);
                await clickDialogButton(page, "Leave it in and send");
                const sent = await waitFor(
                  async () => ((await sentMessages(page)).length ? sentMessages(page) : null),
                  2000,
                );
                expect(sent?.length === 1 && sent[0].includes("4111"), `${name}: sent ${JSON.stringify(sent)}`);
                seen.push(name);
              });
              await sleep(200);
            }
            return `warned and still searched on ${seen.join(", ")}`;
          })();
        },
      ),
  );

  await check(
    "SX3",
    "Switched on: the back-to-search choice and the just-sent notice use search wording, not AI or people wording",
    () =>
      withGranted(["https://www.google.com/*"], (other) =>
        withSite(other, "googleSearch", async (page) => {
          await typeText(page, CARD);
          const dialog = await waitForDialog(page);
          expect(dialog, "no dialog");
          expect(
            dialog.buttons.some((b) => /back to my search/i.test(b.text)),
            `back button: ${JSON.stringify(dialog.buttons)}`,
          );
          expect(!/this AI|people who read it/i.test(dialog.text), `dialog mentions AI or people: ${dialog.text}`);
        }),
      ),
  );

  // Support-chat widgets load their conversation box in an iframe at the widget maker's own address. Clotr's
  // content script runs there once that one host is granted, the same way it runs on any other page; Chrome
  // pierces into the iframe for the dialog's own closed shadow root the same way it already does for Clotr's UI
  // elsewhere, and the keyboard targets whatever element inside the iframe actually has focus. Every widget
  // embeds the same way (its own iframe, at its own fixed address), so the same drive runs on all of them
  // instead of trusting that by analogy from one.
  await check(
    "SX4",
    "Switched on: a card number in a support-chat widget warns like an AI chat, and the chat still goes out",
    () =>
      withGranted(
        SUPPORT_WIDGETS.map((w) => w.host),
        (other) => {
          return (async () => {
            const seen = [];
            for (const { key, origin, name } of SUPPORT_WIDGETS) {
              await withSite(other, key, async (page) => {
                await settle(500);
                const frame = await waitFor(() => page.frames().find((f) => f.url().startsWith(origin)), 3000);
                expect(frame, `${name}: the widget's iframe never loaded`);
                expect(
                  await waitFor(() => page.logs.some((l) => l.includes(origin) && l.includes("active on")), 3000),
                  `${name}: Clotr never ran in the widget iframe`,
                );
                // The iframe's own copy of content.js loads its settings over its own message round trip to
                // background.js, separate from (and later than) the "active on" log it prints as soon as it starts.
                // Typing before that finishes means respFor() has nothing to answer with yet, so nothing warns.
                expect(
                  await waitFor(() => page.logs.some((l) => l.includes("responses:")), 3000),
                  `${name}: the widget iframe's settings never finished loading`,
                );
                await frame.focus("#msg");
                await page.keyboard.sendCharacter(CARD);
                await page.keyboard.press("Enter");
                const dialog = await waitForFrameDialog(frame);
                expect(dialog, `${name}: no dialog in the widget`);
                expect(!/this AI/i.test(dialog.text), `${name}: widget dialog mentions an AI: ${dialog.text}`);
                expect(
                  /people who read it here/i.test(dialog.text),
                  `${name}: widget dialog doesn't read as a chat with people: ${dialog.text}`,
                );
                await clickFrameDialogButton(frame, "Leave it in and send");
                const sent = await waitFor(
                  () => frame.evaluate(() => window.__sent.slice()).then((s) => (s.length ? s : null)),
                  2000,
                );
                expect(sent?.length === 1 && sent[0].includes("4111"), `${name}: widget sent: ${JSON.stringify(sent)}`);
                seen.push(name);
              });
              await sleep(200);
            }
            return `warned and still sent on ${seen.join(", ")}`;
          })();
        },
      ),
  );

  await check("SX5", "Settings lists the search engines and support chats, all off", async () => {
    const { openPopup } = env;
    const popup = await openPopup(ctx);
    try {
      await popup.click("#tab-settings");
      const searchRows = await popup.$$eval("#search-sites li", (lis) =>
        lis.map((li) => ({ name: li.querySelector("b")?.textContent, on: li.querySelector("button")?.textContent })),
      );
      const supportRows = await popup.$$eval("#support-sites li", (lis) =>
        lis.map((li) => ({ name: li.querySelector("b")?.textContent, on: li.querySelector("button")?.textContent })),
      );
      for (const name of ["Google", "Bing", "DuckDuckGo", "Brave Search", "Startpage", "Ecosia", "Yahoo Search"])
        expect(
          searchRows.some((r) => r.name === name && r.on === "Turn on"),
          `${name} missing or not off: ${JSON.stringify(searchRows)}`,
        );
      for (const { name } of SUPPORT_WIDGETS)
        expect(
          supportRows.some((r) => r.name === name && r.on === "Turn on"),
          `${name} missing or not off: ${JSON.stringify(supportRows)}`,
        );
    } finally {
      await popup.close();
    }
    const s = await ctx.worker.evaluate(async () => ({
      google: await settingsFor("https://www.google.com/search"),
      intercom: await settingsFor("https://widget.intercom.io/frame"),
    }));
    expect(s.google.search === true && s.google.everyday === false, `google settings: ${JSON.stringify(s.google)}`);
    expect(s.intercom.everyday === true, `intercom settings: ${JSON.stringify(s.intercom)}`);
  });
};
