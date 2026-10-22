// E2E checks: EW. "Everywhere I type" stays off until you switch it on. Once on, it reaches a chat-style box on
// any https site with no dedicated setup of its own, including inside an iframe, but never an ordinary form
// field, and it never runs twice on a site that already has its own setup. ../run.js runs these checks in order,
// sharing one env with helpers from ../lib.js.
"use strict";

module.exports = async function (env) {
  const { EXT, check, clotrActive, ctx, expect, expectNoUI, fs, launch, os, path } = env;
  const {
    resetState,
    restoreBackgroundReads,
    sentMessages,
    settle,
    sleep,
    slowBackgroundReads,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    DIALOG_WAIT,
  } = env;
  const { withSite } = env;
  const PHONE = "555-555-0123";

  // A phone number is warn-severity, so Clotr renders it as the corner notice (CLOTR-NOTICE), the same
  // everyday wording an email or chat app gets, never the blocking AI-chat dialog (CLOTR-GUARD) that a
  // block-severity item like a card number gets. Mirrors 42-search-support-sites.js's own copy of this
  // reader: readNotice/readDialog in lib.js work through the top page's own CDP session, which can't see
  // into an out-of-process iframe (what Chrome gives a cross-origin widget), so the widget check below needs
  // the frame's own `.client` session instead.
  async function readFrameNotice(frame) {
    const { root } = await frame.client.send("DOM.getDocument", { depth: -1, pierce: true });
    let host = null;
    (function find(n) {
      if (host) return;
      if (n.nodeName === "CLOTR-NOTICE") host = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
    })(root);
    if (!host) return null;
    const texts = [];
    const buttons = [];
    const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(""));
    (function walk(n) {
      if (n.nodeName === "STYLE") return;
      if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
      if (n.nodeName === "BUTTON" || n.nodeName === "SUMMARY") {
        buttons.push({ text: textOf(n).trim(), nodeId: n.nodeId });
      }
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(host);
    return { text: texts.join(" | "), buttons };
  }
  const waitForFrameNotice = (frame) => waitFor(() => readFrameNotice(frame), DIALOG_WAIT);

  // A mouse click needs the element's coordinates translated into the top page's viewport, which an OOPIF's
  // own box model may not give reliably, so a click inside the widget's own frame goes through its own CDP
  // session instead, the same way readFrameNotice reads it: resolved to a live JS object and called directly.
  async function clickInFrame(frame, selector) {
    const { root } = await frame.client.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await frame.client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    expect(nodeId, `"${selector}" not found in the widget frame`);
    const { object } = await frame.client.send("DOM.resolveNode", { nodeId });
    await frame.client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(){ this.click(); }",
    });
    await settle(300);
  }

  // A script can't click the browser's own permission prompt, so a copy of the extension whose manifest already
  // grants the broad origin stands in for "you switched Everywhere I type on" (the same trick 20-everyday-sites.js
  // and 42-search-support-sites.js use for their own one-at-a-time sites). A granted host behaves the same either
  // way, and syncEverywhere reads the grant from chrome.permissions.getAll() either way too.
  async function withEverywhere(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    let other;
    try {
      fs.cpSync(EXT, copy, { recursive: true });
      const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
      m.host_permissions = [...m.host_permissions, "https://*/*"];
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
      other = await launch(copy);
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-everywhere"] });
            if (!s) await syncEverywhere();
            return Boolean(s);
          }),
        5000,
      );
      await resetState(other);
      await store.set(other, { bandage: {} }); // nothing has answered Bandage yet, which is what makes an AI chat offer it
      return await fn(other);
    } finally {
      if (other) {
        await other.browser.close();
        fs.rmSync(other.profile, { recursive: true, force: true });
      }
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("EW1", "Everywhere I type stays off until you switch it on", async () => {
    await withSite(ctx, "everywhereChat", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a made-up site without being switched on");
      await typeText(page, `You can reach me at ${PHONE}`);
      await expectNoUI(page, "everywhereChat not switched on");
    });
  });

  await check(
    "EW2",
    "Switched on: a chat box on a made-up site warns with the people-reading wording, no cover names",
    () =>
      withEverywhere((other) =>
        withSite(other, "everywhereChat", async (page) => {
          expect(clotrActive(page), "Clotr isn't running on the made-up chat site once switched on");
          await typeText(page, `You can reach me at ${PHONE}`);
          const notice = await waitForNotice(page);
          expect(notice, "no notice on the made-up chat site");
          expect(/people who read it here/.test(notice.text), `warning: ${notice.text}`);
          expect(!/this AI/i.test(notice.text), `mentions an AI: ${notice.text}`);
          expect(!notice.buttons.some((b) => /cover names/i.test(b.text)), "Bandage offered cover names");
        }),
      ),
  );

  await check("EW3", "Switched on: the same kind of made-up site's checkout form never warns, Send button or not", () =>
    withEverywhere((other) =>
      withSite(other, "everywhereCheckout", async (page) => {
        expect(clotrActive(page), "Clotr isn't running on the made-up checkout site once switched on");
        await typeText(page, `You can reach me at ${PHONE}`);
        await expectNoUI(page, "a checkout form's notes box warned");
      }),
    ),
  );

  // Support-chat widgets load their conversation box in an iframe at the widget maker's own address, unknown to
  // Clotr either way. allFrames on the dynamic registration is what makes it reach that frame at all.
  await check(
    "EW4",
    "Switched on: a chat widget in an iframe on an unknown host warns too, and the chat still goes out",
    () =>
      withEverywhere((other) =>
        withSite(other, "everywhereWidgetHost", async (page) => {
          await settle(500);
          const frame = await waitFor(
            () => page.frames().find((f) => f.url().startsWith("https://widget.unknownchat.test/")),
            3000,
          );
          expect(frame, "the widget's iframe never loaded");
          expect(
            await waitFor(
              () => page.logs.some((l) => l.includes("widget.unknownchat.test") && l.includes("active on")),
              3000,
            ),
            "Clotr never ran in the widget iframe",
          );
          expect(
            await waitFor(() => page.logs.some((l) => l.includes("responses:")), 3000),
            "the widget iframe's settings never finished loading",
          );
          await frame.focus("#msg");
          await page.keyboard.sendCharacter(`You can reach me at ${PHONE}`);
          const notice = await waitForFrameNotice(frame);
          expect(notice, "no notice in the widget");
          expect(!/this AI/i.test(notice.text), `widget notice mentions an AI: ${notice.text}`);
          // A phone number only warns, so unlike a block-level item it never holds the send: clicking Send
          // goes straight through, with the notice sitting alongside it rather than in its way.
          await clickInFrame(frame, "#send");
          const sent = await waitFor(() => sentMessages(frame).then((s) => (s.length ? s : null)), 2000);
          expect(sent?.length === 1 && sent[0].includes(PHONE), `widget sent: ${JSON.stringify(sent)}`);
        }),
      ),
  );

  // Every built-in AI site, email/chat app, search engine, support widget and user-added site is in the dynamic
  // registration's excludeMatches, computed fresh each sync: this is what keeps a host from ever running two
  // copies of Clotr once the broad switch is on. A page with its own dedicated setup still gets exactly one
  // "active on" log line either way, which the next assertion checks for real on a built-in site.
  await check(
    "EW5",
    "A site with its own setup never gets a second copy of Clotr once Everywhere I type is on too",
    () =>
      withEverywhere(async (other) => {
        const excludeMatches = await other.worker.evaluate(async () => {
          const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-everywhere"] });
          return s?.excludeMatches || [];
        });
        const manifestMatches = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).content_scripts[0]
          .matches;
        for (const m of manifestMatches) {
          expect(excludeMatches.includes(m), `built-in match missing from excludeMatches: ${m}`);
        }
        await withSite(other, "chatgpt", async (page) => {
          await settle(500);
          const activeLines = page.logs.filter((l) => l.startsWith("[Clotr] active on"));
          expect(activeLines.length === 1, `expected exactly one copy, saw: ${JSON.stringify(activeLines)}`);
        });
      }),
  );

  // The welcome page's "Where should Clotr check?" card settles the common case in one click: "AI chats only"
  // closes the card without asking the browser anything, and "AI chats and everywhere I type" asks for exactly
  // the broad origin, the same ask Settings' own "Everywhere I type" switch makes.
  async function openWhereOffer(answer) {
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
    await page.setViewport({ width: 700, height: 900 });
    await page.evaluateOnNewDocument((yes) => {
      window.__asks = [];
      chrome.permissions.request = (p) => {
        window.__asks.push(p.origins);
        return Promise.resolve(yes);
      };
    }, answer);
    await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
    await waitFor(() => page.evaluate(() => Boolean(document.getElementById("where-offer")?.hidden === false)), 10000);
    return page;
  }

  await check("EW6", "Welcome page: 'AI chats only' asks for nothing, closes the card", async () => {
    const page = await openWhereOffer(true);
    try {
      await page.click("#where-ai-only");
      await settle(200);
      const r = await page.evaluate(() => ({
        asks: window.__asks,
        hidden: document.getElementById("where-offer").hidden,
      }));
      expect(r.asks.length === 0, `AI chats only asked the browser: ${JSON.stringify(r.asks)}`);
      expect(r.hidden, "the card stayed open after AI chats only");
    } finally {
      await page.close();
    }
  });

  await check(
    "EW7",
    "Welcome page: 'AI chats and everywhere I type' asks for exactly the everywhere origin, and closes the card on a yes",
    async () => {
      const page = await openWhereOffer(true);
      try {
        await page.click("#where-everywhere");
        await settle(200);
        const r = await page.evaluate(() => ({
          asks: window.__asks,
          hidden: document.getElementById("where-offer").hidden,
        }));
        expect(JSON.stringify(r.asks) === JSON.stringify([["https://*/*"]]), `asks: ${JSON.stringify(r.asks)}`);
        expect(r.hidden, "the card stayed open after a yes");
      } finally {
        await page.close();
      }

      const refused = await openWhereOffer(false);
      try {
        await refused.click("#where-everywhere");
        await settle(200);
        const r = await refused.evaluate(() => ({
          hidden: document.getElementById("where-offer").hidden,
          status: document.getElementById("where-status")?.textContent.trim(),
        }));
        expect(!r.hidden, "the card closed after a No");
        expect(/Nothing was switched on/.test(r.status), `status after a No: ${r.status}`);
      } finally {
        await refused.close();
      }
    },
  );

  await check("EW8", "Before settings arrive, a shipping form stays quiet and the chat box still warns", () =>
    withEverywhere(async (other) => {
      // Keep the settings answer pending past the ready wait so the content script uses its load-time default.
      await slowBackgroundReads(other, 9000, "responses");
      try {
        await withSite(other, "everywhereChat", async (page) => {
          await sleep(3500);
          await page.evaluate(() => {
            const form = document.createElement("form");
            const street = document.createElement("input");
            street.autocomplete = "street-address";
            const address = document.createElement("textarea");
            address.id = "shipping-address";
            const card = document.createElement("input");
            card.autocomplete = "cc-number";
            form.append(street, address, card);
            document.body.prepend(form);
          });

          const chatEditor = page.site.editor;
          page.site.editor = 'document.querySelector("#shipping-address")';
          await typeText(page, "4111 1111 1111 1111");
          await expectNoUI(page, "a shipping-address form warned while settings were pending");
          expect((await store.events(other)).length === 0, "the shipping-address form recorded an event");
          page.site.editor = chatEditor;

          await typeText(page, "4111 1111 1111 1111");
          expect(await waitForDialog(page), "the chat box did not warn while settings were pending");
        });
      } finally {
        await restoreBackgroundReads(other);
      }
    }),
  );
};
