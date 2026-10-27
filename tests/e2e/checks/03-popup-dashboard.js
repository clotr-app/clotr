// E2E checks: C. Dashboard. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

const { isDeepStrictEqual } = require("node:util");

module.exports = async function (env) {
  const {
    EXT,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    KEY,
    openPopup,
    path,
    resetState,
    restoreBackgroundReads,
    seedEvents,
    shot,
    shotAt,
    slowBackgroundReads,
    sleep,
    spanishBrowser,
    store,
    typeText,
    waitFor,
    waitForDialog,
    withSite,
  } = env;
  await check("C1", "Popup overview matches the history (7 days)", async () => {
    const events = seedEvents();
    await store.set(ctx, { events, responses: {}, paused: {} });
    const popup = await openPopup(ctx);
    await popup.evaluate(() => document.querySelector('.range [data-days="7"]').click());
    await sleep(200);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);
    const inRange = events.filter((e) => e.t >= since.getTime());
    const want = inRange.filter((e) => e.action === "redacted").length;
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    const legend = await popup.$eval("#legend", (n) => n.innerText.replace(/\s+/g, " "));
    const n = (a) => inRange.filter((e) => e.action === a).length;
    expect(
      legend.includes(`Hidden ${n("redacted")}`) &&
        legend.includes(`Sent ${n("allowed")}`) &&
        legend.includes(`Just counted ${n("suppressed")}`),
      `legend: ${legend}`,
    );
    const alerts = await popup.$eval("#alerts", (el) => el.innerText);
    expect(alerts.includes("found the same AWS Access Key 2 times"), `alerts: ${alerts}`);
    expect(alerts.includes("sent 1 high-risk"), `alerts: ${alerts}`);
    await shot(popup, "popup-overview-light.png");
    await shot(popup, "popup-overview-dark.png", "dark");
    await popup.close();
    return `hero ${got}, ${legend}`;
  });

  await check("C2", "Hovering a day column shows its tooltip", async () => {
    await store.set(ctx, { events: seedEvents() }); // fresh, so "today" is still today
    const popup = await openPopup(ctx);
    const hits = await popup.$$("#chart .hit");
    expect(hits.length === 7, `${hits.length} columns`);
    await hits[hits.length - 1].hover();
    await sleep(200);
    const tip = await popup.$eval("#tooltip", (n) => (n.hidden ? "" : n.innerText.replace(/\s+/g, " ")));
    expect(tip.includes("1 Hidden") && tip.includes("1 Sent") && tip.includes("2 found"), `tooltip: "${tip}"`);
    await shot(popup, "popup-tooltip.png");
    await popup.close();
    return tip;
  });

  await check("C3", "30-day range re-scopes the numbers", async () => {
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="30"]');
    await sleep(200);
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    const want = seedEvents().filter((e) => e.action === "redacted").length;
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    expect((await popup.$$("#chart .hit")).length === 30, "chart doesn't show 30 days");
    await shot(popup, "popup-overview-30d.png");
    await popup.click('.range [data-days="7"]');
    await popup.close();
  });

  await check("C6", "Activity tab lists every event with outcome and repeats", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, " ")));
    expect(rows.length === seedEvents().length, `${rows.length} rows`);
    expect(rows.filter((r) => r.includes("×2")).length === 2, "repeat marker missing");
    await shot(popup, "popup-activity.png");
    await popup.close();
  });

  await check("C8", "Per-site view: choosing an AI tool filters Overview and Activity", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    const pick = (v) =>
      popup.evaluate((val) => {
        const sel = document.querySelector("#site-filter");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    const options = new Set(await popup.$$eval("#site-filter option", (os) => os.map((o) => o.value)));
    await pick("claude.ai");
    await sleep(200);
    const hero = await popup.$eval("#hero-value", (n) => n.textContent);
    // I compare whole site names here, not substrings, since only the chosen tool should be left in "By AI tool".
    const bySite = await popup.$eval("#by-site", (n) => [...n.querySelectorAll(".label")].map((s) => s.textContent));
    await shot(popup, "popup-site-filter.png");
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.length);
    await pick("");
    await popup.close();
    expect(options.has("") && options.has("claude.ai") && options.has("chatgpt.com"), `options: ${[...options]}`);
    expect(hero === "2", `hero for claude.ai: ${hero}`);
    expect(bySite.length === 1 && bySite[0] === "claude.ai", `by-site should list only claude.ai: ${bySite}`);
    expect(rows === 2, `${rows} activity rows for claude.ai`);
  });

  await check(
    "C9",
    'Per-site mode: "Stricter here" on one AI tool turns its warnings into the blocking dialog',
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-filter");
        sel.value = "chatgpt.com";
        sel.dispatchEvent(new Event("change"));
      });
      await sleep(200);
      const visible = await popup.$eval("#site-mode", (n) => !n.hidden);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-mode");
        sel.value = "block";
        sel.dispatchEvent(new Event("change"));
        const f = document.querySelector("#site-filter");
        f.value = "";
        f.dispatchEvent(new Event("change"));
      });
      await sleep(300);
      await popup.close();
      expect(visible, "site mode control not shown for a chosen tool");
      const { siteModes } = await store.get(ctx, "siteModes");
      expect(siteModes?.["chatgpt.com"] === "block", `siteModes: ${JSON.stringify(siteModes)}`);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "call me at 555-555-5636");
        const dialog = await waitForDialog(page);
        expect(dialog?.text.includes("Phone Number"), "phone didn't block on the stricter site");
        await clickDialogButton(page, "Leave it alone");
      });
      await store.set(ctx, { siteModes: {}, events: [] });
    },
  );

  await check("C10", "Profile exposure counts different personal details each AI tool received", async () => {
    const DAY = 86400000;
    const ev = (site, type, fp, action = "allowed") => ({
      t: Date.now() - 40 * DAY,
      site,
      type,
      name: type,
      severity: "medium",
      action,
      fp,
    });
    await store.set(ctx, {
      events: [
        ev("chatgpt.com", "phone_number", "a000000000000001"),
        ev("chatgpt.com", "phone_number", "a000000000000001"), // same phone again: still one detail
        ev("chatgpt.com", "email", "a000000000000002"),
        ev("chatgpt.com", "street_address", "a000000000000003", "redacted"), // never sent
        ev("chatgpt.com", "aws_access_key", "a000000000000004"), // a key, not personal
        ev("claude.ai", "family_name", "a000000000000005"),
      ],
    });
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="7"]');
    const rows = await popup.$$eval("#exposure .hbar", (bs) => bs.map((b) => b.title));
    await shot(popup, "popup-exposure.png");
    await popup.close();
    await store.set(ctx, { events: [] });
    expect(
      JSON.stringify(rows) === JSON.stringify(["chatgpt.com: 2", "claude.ai: 1"]),
      `rows: ${JSON.stringify(rows)}`,
    );
  });

  await check("C7", "Clear history (two clicks) empties the dashboard", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    await shot(popup, "popup-settings.png");
    await popup.click("#clear");
    expect((await store.events(ctx)).length > 0, "cleared after one click");
    await popup.click("#clear");
    await sleep(300);
    expect((await store.events(ctx)).length === 0, "not cleared after two clicks");
    await popup.click("#tab-overview");
    await sleep(200);
    expect(await popup.$eval("#empty-overview", (n) => !n.hidden), "empty state not shown");
    const hint = await popup.$eval("#empty-hint", (node) => node.innerText.replace(/\s+/g, " ").trim());
    expect(hint === `Try it: paste ${KEY} into a protected AI chat.`, `English hint: ${hint}`);
    await popup.close();

    const spanish = await spanishBrowser(ctx, EXT);
    await store.set(spanish, { events: [] });
    const spanishPopup = await openPopup(spanish);
    try {
      const spanishHint = await spanishPopup.$eval("#empty-hint", (node) => node.innerText.replace(/\s+/g, " ").trim());
      expect(spanishHint === `Pruébalo: pega ${KEY} en un chat de IA protegido.`, `Spanish hint: ${spanishHint}`);
    } finally {
      await spanishPopup.close();
    }
  });

  await check("C12", "Clear history during a slow report from another AI tab still ends up empty", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    await slowBackgroundReads(ctx, 300, "events");
    try {
      // This report gets queued first, and it reads storage slowly, so it's still mid-write when the clear happens.
      const reported = ctx.worker.evaluate(() =>
        enqueue(() =>
          appendEvents([
            {
              t: Date.now(),
              site: "chatgpt.com",
              type: "email",
              name: "Email",
              severity: "low",
              action: "redacted",
              fp: "a000000000000009",
            },
          ]),
        ),
      );
      await sleep(50);
      await popup.click("#clear");
      await popup.click("#clear");
      await reported;
      await sleep(100);
    } finally {
      await restoreBackgroundReads(ctx);
      await popup.close();
    }
    expect((await store.events(ctx)).length === 0, "the slow report's write brought the old history back");
  });

  await check(
    "C11",
    "Settings: Bandage lists each AI tool that has answered, on/off; toggling one updates storage",
    async () => {
      await store.set(ctx, { bandage: { "chatgpt.com": true, "claude.ai": false } });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const rows = await popup.$$eval("#bandage-sites li", (lis) =>
        lis.map((li) => ({ host: li.querySelector("span").textContent, on: li.querySelector("input").checked })),
      );
      expect(
        rows.length === 2 &&
          rows.some((r) => r.host === "chatgpt.com" && r.on) &&
          rows.some((r) => r.host === "claude.ai" && !r.on),
        `rows: ${JSON.stringify(rows)}`,
      );
      await popup.evaluate(() => {
        const li = [...document.querySelectorAll("#bandage-sites li")].find(
          (n) => n.querySelector("span").textContent === "chatgpt.com",
        );
        const cb = li.querySelector("input");
        cb.checked = false;
        cb.dispatchEvent(new Event("change"));
      });
      await sleep(300);
      await popup.close();
      const { bandage } = await store.get(ctx, "bandage");
      expect(bandage?.["chatgpt.com"] === false, `bandage: ${JSON.stringify(bandage)}`);
      await store.set(ctx, { bandage: {} });
    },
  );
  await check("C15", "One Clotr is absent from held-back builds and stays Windows-only when enabled", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const card = await popup.evaluate(() => ({
      platform: navigator.userAgentData?.platform || navigator.platform,
      features: chrome.runtime.getManifest().clotr_features || {},
      exists: Boolean(document.getElementById("one-clotr")),
      hidden: document.getElementById("one-clotr")?.hidden,
      text: document.getElementById("one-clotr")?.textContent || "",
      connectHidden: document.getElementById("one-clotr-connect")?.hidden,
      disconnectHidden: document.getElementById("one-clotr-disconnect")?.hidden,
    }));
    if (!("oneclotr" in card.features)) {
      expect(!card.exists, "the packaged build should omit the One Clotr card: " + JSON.stringify(card));
      await popup.close();
      return;
    }
    if (!card.features.oneclotr) {
      expect(card.exists && card.hidden, "One Clotr should stay hidden when its flag is off: " + JSON.stringify(card));
      await popup.close();
      return;
    }
    if (/^Win/i.test(card.platform)) {
      expect(card.exists && !card.hidden && !card.connectHidden && card.disconnectHidden, JSON.stringify(card));
      expect(/One Clotr/.test(card.text) && /Nothing it finds leaves this PC/.test(card.text), card.text);
      await shotAt(popup, "popup-one-clotr.png", { selector: "#one-clotr" });
    } else {
      expect(card.hidden, "One Clotr should be Windows-only: " + JSON.stringify(card));
    }
    await popup.close();
  });
  await check(
    "WL1",
    "Settings: Show the welcome page opens it again, with the author's note and the practice box",
    async () => {
      const popup = await openPopup(ctx);
      const before = (await ctx.browser.pages()).length;
      await popup.evaluate(() => document.getElementById("open-welcome").click());
      const opened = await waitFor(async () => {
        const pages = await ctx.browser.pages();
        return pages.length > before ? pages.find((p) => p.url().endsWith("vault.html?welcome=1")) : null;
      }, 3000);
      expect(opened, "the welcome page didn't open");
      const shown = await waitFor(
        () =>
          opened.evaluate(() =>
            !document.getElementById("welcome").hidden && document.querySelector(".author-note")
              ? {
                  note: document.querySelector(".author-note").textContent,
                  practice: Boolean(document.getElementById("try")),
                }
              : null,
          ),
        3000,
      );
      expect(shown && /Hi, I'm Alex/.test(shown.note) && shown.practice, `welcome: ${JSON.stringify(shown)}`);
      await opened.close();
      await popup.close();
    },
  );

  // Opens the popup over a tab showing `url`, answering the tab lookup by hand, since a scripted popup gets no
  // activeTab grant and would otherwise always see an empty tab.
  const openPopupOn = async (url, title) => {
    const popup = await ctx.browser.newPage();
    popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
    await popup.evaluateOnNewDocument(
      (u, t) => {
        chrome.tabs.query = async () => [{ id: 999, url: u, title: t }];
      },
      url,
      title,
    );
    await popup.setViewport({ width: 380, height: 700 });
    await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
    await popup.waitForSelector("#hero-value");
    await sleep(400);
    return popup;
  };
  const siteCard = (popup) => popup.$eval("#site", (n) => n.innerText.replace(/\s+/g, " ").trim());

  // The first popup most people open sits over the welcome page, so it names that page instead of saying there's
  // no web page in the tab. Any other Clotr page goes by its own title; someone else's extension page doesn't.
  await check("WP3", "Popup over one of Clotr's own pages names that page, not 'No web page in this tab'", async () => {
    const own = `chrome-extension://${new URL(ctx.swTarget.url()).host}`;
    const welcome = await openPopupOn(`${own}/vault.html?welcome=1`, "Welcome to Clotr");
    try {
      const text = await siteCard(welcome);
      expect(/^This is Clotr's welcome page\./.test(text) && !/No web page/.test(text), `welcome: ${text}`);
      for (const theme of ["light", "dark"]) {
        await shotAt(welcome, `popup-own-page-380-${theme}.png`, { width: 380, height: 700, theme, selector: "#site" });
      }
    } finally {
      await welcome.close();
    }
    const other = await openPopupOn(`${own}/stored.html`, "What Clotr stores");
    try {
      const text = await siteCard(other);
      expect(/What Clotr stores/.test(text) && !/No web page/.test(text), `another Clotr page: ${text}`);
    } finally {
      await other.close();
    }
    const stranger = await openPopupOn("chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html", "Not Clotr");
    try {
      const text = await siteCard(stranger);
      expect(/No web page in this tab/.test(text), `another extension's page: ${text}`);
    } finally {
      await stranger.close();
    }
  });

  // On an ordinary site Clotr is resting, not broken: the card says so first, and switching it on there is the
  // quieter button, so nobody is nudged into giving Clotr their bank's site.
  await check(
    "WP4",
    "Popup on an ordinary site: 'resting here' comes first and Turn Clotr on here is a plain button",
    async () => {
      const popup = await openPopupOn("https://forum.example/thread/1", "A forum");
      try {
        const r = await popup.evaluate(() => {
          const button = [...document.querySelectorAll("#site button")].find((b) =>
            /Turn Clotr on here/.test(b.textContent),
          );
          return {
            state: document.querySelector("#site .state")?.textContent.trim(),
            button: button ? button.className : null,
          };
        });
        expect(r.state === "Clotr watches AI chats, so it's resting here.", `state line: ${r.state}`);
        expect(r.button !== null && !/\bprimary\b/.test(r.button), `Turn Clotr on here: ${r.button}`);
        for (const theme of ["light", "dark"]) {
          await shotAt(popup, `popup-resting-380-${theme}.png`, { width: 380, height: 700, theme, selector: "#site" });
        }
      } finally {
        await popup.close();
      }
    },
  );

  // Settings names the version and reopens the release's notes, since the top card goes for good after Got it.
  // Reopening is only for reading: whatever lastUpdate said before (seen, or none at all) stays as it was.
  await check(
    "SV1",
    "Settings shows Clotr's version, and What's new reopens the notes without marking anything",
    async () => {
      const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
      const minor = version.split(".").slice(0, 2).join(".");
      const notes = JSON.parse(fs.readFileSync(path.join(EXT, "changelog.json"), "utf8"))[minor] || [];
      const seenBefore = { from: "1.0.0", to: version, t: 1, seen: true };
      for (const before of [seenBefore, undefined]) {
        if (before) await store.set(ctx, { lastUpdate: before });
        else await ctx.worker.evaluate(() => chrome.storage.local.remove("lastUpdate"));
        const popup = await openPopup(ctx);
        try {
          expect(await popup.$eval("#whats-new", (n) => n.hidden), "the update card showed with nothing new");
          await popup.click("#tab-settings");
          const line = await popup.$eval("#clotr-version", (n) => n.textContent);
          expect(line === `Clotr ${version}`, `version line: ${line}`);
          if (before) {
            await popup.$eval("#settings-whats-new", (n) => n.scrollIntoView({ block: "center" }));
            await shot(popup, "popup-settings-version.png");
          }
          await popup.click("#settings-whats-new");
          const card = await waitFor(
            () =>
              popup.evaluate(() =>
                document.getElementById("whats-new").hidden
                  ? null
                  : {
                      title: document.getElementById("whats-new-title").textContent,
                      open: document.getElementById("whats-new-more").open,
                      items: [...document.querySelectorAll("#whats-new-list li")].map((li) => li.textContent),
                      focused: document.getElementById("whats-new").contains(document.activeElement),
                    },
              ),
            3000,
          );
          expect(card, "What's new didn't open the card");
          expect(card.title.includes(minor) && !/Updated to/.test(card.title), `title: ${card.title}`);
          expect(JSON.stringify(card.items) === JSON.stringify(notes), `notes: ${JSON.stringify(card.items)}`);
          expect(card.open === notes.length > 0 && card.focused, `open: ${card.open}, focused: ${card.focused}`);
          if (before) await shot(popup, "popup-settings-whats-new.png");
          await popup.click("#whats-new-ok");
          await sleep(300);
          expect(await popup.$eval("#whats-new", (n) => n.hidden), "the card stayed after Got it");
          const { lastUpdate } = await store.get(ctx, "lastUpdate");
          expect(isDeepStrictEqual(lastUpdate, before), `lastUpdate changed: ${JSON.stringify(lastUpdate)}`);
        } finally {
          await popup.close();
        }
      }
    },
  );
};
