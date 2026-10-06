// E2E checks: the different ways into Look back and Extension check. These cover the quiet card on Overview
// (fuller wording on an empty history, a single line once there's real history), the same two doors in Settings,
// the setup page's closing line, a release's "What's new" card and the welcome page's own line. None of them
// touch the badge or fire a notification. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { activeBadge, check, ctx, expect, fs, launch, openExtPage, openPopup, path, resetState, seedEvents } = env;
  const { EXT, shot, shotAt, sleep, store, waitFor } = env;

  async function waitForNewPage(before, suffix) {
    return waitFor(async () => {
      const pages = await ctx.browser.pages();
      return pages.length > before.length ? pages.find((p) => p.url().endsWith(suffix)) : null;
    }, 3000);
  }

  // Measures #lb-settings' own height instead of guessing it, because Spanish wraps to more lines than English.
  // A fixed shot height cropped it short, and the fixed tab bar bled into the picture past the cut-off element.
  async function settingsShots(popup, suffix) {
    await popup.evaluate(() => document.getElementById("lb-settings").scrollIntoView());
    await sleep(150);
    // Adds the element's top offset to its height rather than using height alone, because scrollIntoView
    // doesn't always land the element at the exact top of the viewport, and a screenshot bound to a fixed
    // viewport crops anything below its bottom edge.
    const height = await popup.$eval("#lb-settings", (n) => {
      const r = n.getBoundingClientRect();
      return Math.ceil(r.top + r.height) + 40;
    });
    await shotAt(popup, `popup-lookback-settings${suffix}-light.png`, { width: 380, height, selector: "#lb-settings" });
    await shotAt(popup, `popup-lookback-settings${suffix}-dark.png`, {
      width: 380,
      height,
      theme: "dark",
      selector: "#lb-settings",
    });
    // shotAt leaves the viewport at the shot's short height, which puts the fixed tab bar over the buttons
    // below. This restores it before clicking, since otherwise the tab bar swallows the click.
    await popup.setViewport({ width: 380, height: 700 });
  }

  await check(
    "PU1",
    "Overview: on an empty history the card invites you in, and Open goes to Look back, badge untouched",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { events: [] });
      const badgeBefore = await activeBadge(ctx);
      const popup = await openPopup(ctx);
      const state = await popup.$eval("#lb-card", (n) => {
        const [openRow, checkRow] = n.querySelectorAll(".lb-card-row");
        const openBox = openRow.getBoundingClientRect();
        const checkBox = checkRow.getBoundingClientRect();
        return {
          compact: n.classList.contains("compact"),
          subVisible: [...n.querySelectorAll(".lb-card-sub")].every((s) => s.offsetParent !== null),
          text: n.innerText.replace(/\s+/g, " "),
          sideBySide: Math.abs(openBox.top - checkBox.top) < 2 && checkBox.left > openBox.left,
        };
      });
      expect(!state.compact, "card is compact on an empty history");
      expect(state.subVisible, "the inviting sub-text isn't shown on an empty history");
      expect(state.text.includes("What's already out there"), `card text: ${state.text}`);
      expect(state.text.includes("Look back") && state.text.includes("Extension check"), `card text: ${state.text}`);
      expect(state.sideBySide, "Look back and Extension check aren't side by side as two equal tiles");
      const gap = await popup.evaluate(() => {
        const bar = document.getElementById("filter-bar").getBoundingClientRect();
        const row = document.getElementById("ss-row").getBoundingClientRect();
        return row.top - bar.bottom;
      });
      expect(gap >= 6, `no room below "Showing" before the Scam check row (gap: ${gap}px)`);
      await shot(popup, "popup-lookback-card-empty-light.png");
      await shot(popup, "popup-lookback-card-empty-dark.png", "dark");

      const before = await ctx.browser.pages();
      await popup.click("#lb-card-open");
      const opened = await waitForNewPage(before, "lookback.html");
      expect(opened, "Open didn't open lookback.html");
      await opened.close();
      await popup.close();

      const badgeAfter = await activeBadge(ctx);
      expect(badgeAfter.text === "" && badgeAfter.text === badgeBefore.text, `badge changed: ${badgeAfter.text}`);
    },
  );

  await check(
    "PU2",
    "Overview: with real history the card stays one line, and Check goes to Extension check, badge untouched",
    async () => {
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      const state = await popup.$eval("#lb-card", (n) => ({
        compact: n.classList.contains("compact"),
        subHidden: [...n.querySelectorAll(".lb-card-sub")].every((s) => s.offsetParent === null),
      }));
      expect(state.compact, "card isn't compact once there's real history");
      expect(state.subHidden, "the inviting sub-text still shows once there's real history");
      await shot(popup, "popup-lookback-card-full-light.png");
      await shot(popup, "popup-lookback-card-full-dark.png", "dark");

      const before = await ctx.browser.pages();
      await popup.click("#lb-card-check");
      const opened = await waitForNewPage(before, "extcheck.html");
      expect(opened, "Check didn't open extcheck.html");
      await opened.close();
      await popup.close();

      const badge = await activeBadge(ctx);
      expect(badge.text === "", `badge: "${badge.text}"`);
      await store.set(ctx, { events: [] });
    },
  );

  await check("PU3", "Settings: the same two doors open Look back and Extension check", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const text = await popup.$eval("#lb-settings", (n) => n.innerText.replace(/\s+/g, " "));
    expect(text.includes("What's already out there"), `settings section: ${text}`);
    expect(text.includes("Look back") && text.includes("Extension check"), `settings section: ${text}`);
    await settingsShots(popup, "");

    let before = await ctx.browser.pages();
    await popup.click("#lb-settings-open");
    const lookback = await waitForNewPage(before, "lookback.html");
    expect(lookback, "Settings' Open didn't open lookback.html");
    await lookback.close();

    before = await ctx.browser.pages();
    await popup.click("#lb-settings-check");
    const extcheck = await waitForNewPage(before, "extcheck.html");
    expect(extcheck, "Settings' Check didn't open extcheck.html");
    await extcheck.close();
    await popup.close();
  });

  await check("PU4", "The setup page's last step mentions Extension check, in one line", async () => {
    const helperHtml = fs.readFileSync(path.join(env.EXT, "helper.html"), "utf8");
    expect(/id="ext-check-line"[^>]*data-i18n="hp_extCheckLine"/.test(helperHtml), "no hp_extCheckLine in helper.html");

    const page = await openExtPage(ctx, "helper.html");
    try {
      // "Or choose each setting yourself" reaches #after fastest, with every later step hidden.
      await page.click('input[name="who"][value="self"]');
      await sleep(150);
      const text = await page.$eval("#after", (n) => n.innerText.replace(/\s+/g, " "));
      expect(text.includes("Extension check shows which of their extensions can read AI chats"), `after step: ${text}`);
      await shotAt(page, "helper-extcheck-line-380-light.png", { width: 380, height: 900, selector: "#after" });
      await shotAt(page, "helper-extcheck-line-380-dark.png", {
        width: 380,
        height: 900,
        theme: "dark",
        selector: "#after",
      });
    } finally {
      await page.close();
    }
  });

  await check(
    "PU5",
    "What's new: a release with doors in RELEASE_DOORS shows buttons that open each page",
    async () => {
      // Cleared so an earlier check's end-of-30-days card or everyday-apps offer can't sit in front of this one.
      await store.set(ctx, {
        tourniquet: null,
        tourniquetEnded: null,
        everydayOffer: "done",
        lastUpdate: { from: "1.2.0", to: "1.3.0.1", seen: false },
      });
      const popup = await openPopup(ctx);
      const shown = await popup.$eval("#whats-new", (n) => !n.hidden);
      expect(shown, "What's new card didn't show for an unseen update");
      const labels = await popup.$$eval("#whats-new-doors button", (bs) => bs.map((b) => b.textContent));
      expect(
        labels.includes("Look back") && labels.includes("Extension check"),
        `door labels: ${JSON.stringify(labels)}`,
      );
      const before = await ctx.browser.pages();
      await popup.evaluate(() => [...document.querySelectorAll("#whats-new-doors button")][0].click());
      const opened = await waitForNewPage(before, "lookback.html");
      expect(opened, "a What's new door didn't open lookback.html");
      await opened.close();
      await popup.click("#whats-new-ok");
      await popup.close();
      await store.set(ctx, { lastUpdate: null });
    },
  );

  await check("PU6", "Spanish: the card, Settings' section and the setup line all translate", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await store.set(es, { events: [] });
      const popup = await openPopup(es);
      const cardText = await popup.$eval("#lb-card", (n) => n.innerText.replace(/\s+/g, " "));
      expect(cardText.includes("Lo que ya está ahí fuera"), `Spanish card: ${cardText}`);
      expect(
        cardText.includes("Mirar atrás") && cardText.includes("Revisión de extensiones"),
        `Spanish card: ${cardText}`,
      );
      await shot(popup, "popup-lookback-card-empty-es-light.png");
      await shot(popup, "popup-lookback-card-empty-es-dark.png", "dark");

      await popup.click("#tab-settings");
      await settingsShots(popup, "-es");
      await popup.close();

      const page = await openExtPage(es, "helper.html");
      await page.click('input[name="who"][value="self"]');
      await sleep(150);
      const afterText = await page.$eval("#after", (n) => n.innerText.replace(/\s+/g, " "));
      expect(
        afterText.includes("Revisión de extensiones muestra qué extensiones suyas pueden leer chats con IA"),
        `Spanish setup step: ${afterText}`,
      );
      await shotAt(page, "helper-extcheck-line-380-es-light.png", { width: 380, height: 900, selector: "#after" });
      await shotAt(page, "helper-extcheck-line-380-es-dark.png", {
        width: 380,
        height: 900,
        theme: "dark",
        selector: "#after",
      });
      await page.close();
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  // A dummy PIN hash (nobody can type it): enough to make settingsLocked() in vault.js return true.
  const PIN_HASH = { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) };

  async function lineShots(page, selector, nameBase) {
    await page.evaluate((s) => document.querySelector(s).scrollIntoView(), selector);
    await sleep(100);
    const height = await page.$eval(selector, (n) => {
      const r = n.getBoundingClientRect();
      return Math.ceil(r.top + r.height) + 30;
    });
    await shotAt(page, `${nameBase}-light.png`, { width: 700, height, selector });
    await shotAt(page, `${nameBase}-dark.png`, { width: 700, height, theme: "dark", selector });
  }

  await check(
    "PU7",
    "The welcome page: one Look back line after Try it, opening lookback.html in a new tab; hidden while locked",
    async () => {
      await store.set(ctx, { lock: null });
      const page = await openExtPage(ctx, "vault.html?welcome=1");
      try {
        const line = await waitFor(
          () =>
            page.evaluate(() => {
              const p = document.getElementById("lb-offer");
              if (!p || p.hidden) return null;
              return {
                text: p.textContent.replace(/\s+/g, " ").trim(),
                afterField: p.previousElementSibling?.classList.contains("field"),
                href: p.querySelector("a")?.getAttribute("href"),
                targetBlank: p.querySelector("a")?.getAttribute("target") === "_blank",
              };
            }),
          3000,
        );
        expect(line, "no Look back line on the welcome page");
        expect(
          line.text === "Already used ChatGPT, Claude or Gemini? Look back shows what you've already told them.",
          `line: ${line.text}`,
        );
        expect(line.afterField, "the line doesn't come right after Try it");
        expect(
          line.href === "lookback.html" && line.targetBlank,
          `link: ${line.href} target blank: ${line.targetBlank}`,
        );

        const before = await ctx.browser.pages();
        await page.click("#lb-offer a");
        const opened = await waitForNewPage(before, "lookback.html");
        expect(opened, "the welcome page's line didn't open lookback.html");
        await opened.close();

        await lineShots(page, "#lb-offer", "vault-lookback-line");
      } finally {
        await page.close();
      }

      await store.set(ctx, { lock: PIN_HASH });
      const locked = await openExtPage(ctx, "vault.html?welcome=1");
      try {
        await sleep(600);
        expect(await locked.$eval("#lb-offer", (p) => p.hidden), "the Look back line shows while settings are locked");
      } finally {
        await locked.close();
        await store.set(ctx, { lock: null });
      }
    },
  );

  await check("PU8", "Spanish: the welcome page's Look back line translates", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const page = await openExtPage(es, "vault.html?welcome=1");
      try {
        const text = await waitFor(
          () =>
            page.evaluate(() => {
              const p = document.getElementById("lb-offer");
              return p && !p.hidden ? p.textContent.replace(/\s+/g, " ").trim() : null;
            }),
          3000,
        );
        expect(
          text === "¿Ya has usado ChatGPT, Claude o Gemini? Mirar atrás te muestra lo que ya les contaste.",
          `Spanish line: ${text}`,
        );
        await lineShots(page, "#lb-offer", "vault-lookback-line-es");
      } finally {
        await page.close();
      }
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });
};
