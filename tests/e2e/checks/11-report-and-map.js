// E2E checks for the full-page dashboard, "Your AI exposure report". Run in order by ../run.js with one shared
// env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    EXT,
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clearEditor,
    clickDialogButton,
    ctx,
    editorText,
    evalInClotr,
    expect,
    fs,
    launch,
    openExtPage,
    openPopup,
    openSite,
    path,
    pressEnter,
    readDialog,
    readNotice,
    resetState,
    seedEvents,
    sentMessages,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
    holdDir,
    dropDir,
    attachText,
    holdShots,
    stubReader,
    readStarted,
  } = env;
  const DAY_MS = 86400000;
  const dashEvents = () => {
    const ev = (days, site, type, name, severity, action, fp) => ({
      t: Date.now() - days * DAY_MS - 60000,
      site,
      type,
      name,
      severity,
      action,
      fp,
    });
    return [
      ev(70, "gemini.google.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(30, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "email", "Email Address", "low", "allowed", "bbbbbbbbbbbbbbb2"),
      ev(8, "chatgpt.com", "aws_access_key", "AWS Access Key", "high", "allowed", "ccccccccccccccc3"),
      ev(5, "chatgpt.com", "street_address", "Street Address", "medium", "redacted", "ddddddddddddddd4"),
      ev(3, "claude.ai", "family_name", "Family Member's Name", "high", "allowed", "eeeeeeeeeeeeeee5"),
      ev(2, "claude.ai", "credit_card", "Credit Card Number", "high", "allowed", "fffffffffffffff6"),
      ev(1, "claude.ai", "password", "Password or Secret", "high", "suppressed", "999999999999999a"),
    ];
  };

  await check(
    "DSH1",
    "Full dashboard: totals, what each AI service was told (personal details only), 12-week trend",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      await page.setViewport({ width: 1100, height: 1400 });
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          totals: document.getElementById("totals").innerText,
          exposure: [...document.querySelectorAll("#exposure [data-site]")].map(
            (n) => `${n.dataset.site}:${n.dataset.details}`,
          ),
          weeks: document.querySelectorAll("#weeks [data-week]").length,
        }));
        await shot(page, "dashboard.png");
        expect(
          /9\b/.test(got.totals) &&
            /1\s*Hidden/.test(got.totals) &&
            /7\s*Sent/.test(got.totals) &&
            /1\s*Just counted/.test(got.totals),
          `totals: ${got.totals}`,
        );
        expect(
          JSON.stringify(got.exposure) === JSON.stringify(["chatgpt.com:2", "claude.ai:2", "gemini.google.com:1"]),
          `exposure: ${JSON.stringify(got.exposure)}`,
        );
        expect(got.weeks === 12, `weeks: ${got.weeks}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH1B",
    "Full dashboard: what Bandage kept from each AI, apart from what was hidden by hand; hidden until Bandage covers something",
    async () => {
      const ev = (site, via) => ({
        t: Date.now(),
        site,
        type: "phone_number",
        name: "Phone Number",
        severity: "medium",
        action: "redacted",
        fp: "a000000000000009",
        ...(via ? { via } : {}),
      });
      await store.set(ctx, { events: [ev("chatgpt.com", null)] }); // hand-hidden only: no Bandage section
      let page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const hidden = await page.evaluate(() => document.getElementById("bandage-section").hidden);
        expect(hidden, "Bandage section shown with nothing from Bandage");
      } finally {
        await page.close();
      }
      await store.set(ctx, {
        events: [ev("chatgpt.com", "bandage"), ev("chatgpt.com", "bandage"), ev("claude.ai", "bandage")],
      });
      page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          hidden: document.getElementById("bandage-section").hidden,
          rows: [...document.querySelectorAll("#bandage-kept [data-site]")].map(
            (n) => `${n.dataset.site}:${n.dataset.kept}`,
          ),
        }));
        expect(!got.hidden, "Bandage section not shown");
        expect(
          JSON.stringify(got.rows) === JSON.stringify(["chatgpt.com:2", "claude.ai:1"]),
          `rows: ${JSON.stringify(got.rows)}`,
        );
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "DSH2",
    "Full dashboard: riskiest moments come with what to do now; repeats are spotted; no fingerprints shown",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          risky: document.getElementById("risky").innerText,
          repeats: document.getElementById("repeats").innerText,
          body: document.body.innerText,
        }));
        expect(/AWS Access Key/.test(got.risky) && /Credit Card Number/.test(got.risky), `risky: ${got.risky}`);
        expect(/turn it off/i.test(got.risky) && /bank/i.test(got.risky), `no advice: ${got.risky}`);
        expect(/Phone Number[^\n]*3 times[^\n]*2 services/.test(got.repeats), `repeats: ${got.repeats}`);
        expect(!/aaaaaaaaaaaaaaa1|fffffffffffffff6/.test(got.body), "fingerprints shown on the page");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH3",
    "Full dashboard: export gives the stored records (no fingerprint secret); delete history takes two clicks",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        await page.click("#export");
        const exported = await page.evaluate(async () => {
          const a = document.getElementById("export-link");
          return a ? (await fetch(a.href)).text() : "";
        });
        const data = JSON.parse(exported || "{}");
        expect(data.events?.length === 9 && !exported.includes(salt), `export: ${exported.slice(0, 120)}`);
        await page.click("#delete-history");
        await sleep(200);
        expect((await store.events(ctx)).length === 9, "deleted after one click");
        await page.click("#delete-history");
        const left = await waitFor(async () => ((await store.events(ctx)).length === 0 ? true : null), 2000);
        expect(left, "history not deleted after the second click");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  const aged = (days, fp) => ({
    t: Date.now() - days * DAY_MS,
    site: "chatgpt.com",
    type: "email",
    name: "Email Address",
    severity: "low",
    action: "allowed",
    fp,
  });

  // Reads the computed style of the first element inside Clotr's closed shadow UI that `match` accepts.
  // DevTools can pierce a closed shadow root even though normal page script can't.
  async function uiStyle(page, tag, match, props) {
    page.cdp ??= await page.createCDPSession();
    await page.cdp.send("DOM.enable");
    await page.cdp.send("CSS.enable");
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const kids = (n) => [...(n.children || []), ...(n.shadowRoots || [])];
    let host = null,
      hit = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        kids(n).forEach(find);
      }
    })(root);
    const attr = (n, name) => {
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
      return "";
    };
    (function walk(n) {
      if (!n || hit) return;
      if (n !== host && match(n, attr)) {
        hit = n;
        return;
      }
      kids(n).forEach(walk);
    })(host);
    if (!hit) return null;
    const { computedStyle } = await page.cdp.send("CSS.getComputedStyleForNode", { nodeId: hit.nodeId });
    return Object.fromEntries(props.map((p) => [p, computedStyle.find((s) => s.name === p)?.value]));
  }

  async function uiClasses(page, tag) {
    page.cdp ??= await page.createCDPSession();
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const classes = new Set();
    let host = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
      }
    })(root);
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "class") a[i + 1].split(/\s+/).forEach((c) => classes.add(c));
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(host);
    return classes;
  }

  await check("PM1", 'Helping someone: "Larger warnings" makes the corner warning bigger', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await store.set(ctx, { events: [], responses: {}, guided: ALL_GUIDED, largeText: true });
      try {
        await typeText(page, "call me at 555-555-0147");
        expect(await waitForNotice(page), "no notice");
        const classes = await uiClasses(page, "CLOTR-NOTICE");
        expect(classes.has("large"), `notice classes: ${[...classes].join(" ")}`);
        // Large text mode should grow everything in the notice, not just the headline.
        const code = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "CODE", ["font-size"]);
        const more = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "SUMMARY", ["font-size"]);
        const link = await uiStyle(
          page,
          "CLOTR-NOTICE",
          (n, attr) => n.nodeName === "BUTTON" && /\blink\b/.test(attr(n, "class")),
          ["font-size", "padding-left"],
        );
        const px = (s) => parseFloat(s?.["font-size"]);
        expect(
          px(code) >= 15 && px(more) >= 15 && px(link) >= 15,
          `small text in large mode: code ${code?.["font-size"]}, More choices ${more?.["font-size"]}, link ${link?.["font-size"]}`,
        );
        expect(link?.["padding-left"] === "0px", `a text link is padded like a button: ${link?.["padding-left"]}`);
        await shot(page, "notice-large.png");
      } finally {
        await store.set(ctx, { largeText: false });
      }
    }),
  );

  await check(
    "PM2",
    "Helping someone: settings locked with a PIN (stored only as a hash); wrong PIN refused, right PIN unlocks; while locked, Quieter here can't be picked and Clear my history is there",
    async () => {
      // I turn advanced options on before setting the PIN, and seed history on two chats so the per-chat
      // select has something to show once one is picked.
      const ev = (site) => ({ t: Date.now() - 60000, site, type: "email", name: "Email Address", severity: "low" });
      await store.set(ctx, {
        responses: {},
        advanced: true,
        events: [
          { ...ev("chatgpt.com"), action: "redacted" },
          { ...ev("claude.ai"), action: "allowed" },
        ],
      });
      await ctx.worker.evaluate(() =>
        Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
      );
      let popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.type("#pin", "4827");
        await popup.click("#lock-set");
        const lock = await waitFor(async () => (await store.get(ctx, "lock")).lock, 3000);
        expect(lock?.hash && lock?.salt, `lock: ${JSON.stringify(lock)}`);
        // I only match "4827" as its own value, not as a substring of a timestamp or random hex, since that kind
        // of coincidence is rare but real enough to have flaked once in CI.
        expect(
          !/(?<![0-9a-f])4827(?![0-9a-f])/i.test(JSON.stringify(await store.get(ctx, null))),
          "the PIN itself was stored",
        );
        await popup.close();
        await ctx.worker.evaluate(() => chrome.storage.session.remove("unlockedUntil"));
        popup = await openPopup(ctx);
        await popup.click("#tab-settings");
        const locked = await popup.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          settings: document.getElementById("settings-body").hidden,
        }));
        expect(locked.unlock && locked.settings, `settings not locked: ${JSON.stringify(locked)}`);
        // While locked, the per-chat choice shouldn't offer "Quieter here: just count", and "Clear my history"
        // should be right there instead.
        await popup.select("#site-filter", "chatgpt.com");
        await sleep(200);
        const lockedView = await popup.evaluate(() => ({
          mode: {
            shown: !document.getElementById("site-mode").hidden,
            disabled: document.getElementById("site-mode").disabled,
          },
          history: !document.getElementById("history-mine").hidden,
        }));
        expect(
          lockedView.mode.shown && lockedView.mode.disabled,
          `the per-chat select while locked: ${JSON.stringify(lockedView.mode)}`,
        );
        expect(lockedView.history, "no Clear my history while settings are locked");
        await shot(popup, "popup-locked-history.png");
        await shot(popup, "popup-locked-history-dark.png", "dark");
        await popup.click("#tab-overview");
        await shot(popup, "popup-locked-site-mode.png");
        await shot(popup, "popup-locked-site-mode-dark.png", "dark");
        await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await popup.click("#tab-settings");
        await popup.type("#unlock-pin", "1111");
        await popup.click("#unlock-go");
        await sleep(1200);
        expect(
          await popup.evaluate(() => document.getElementById("settings-body").hidden),
          "wrong PIN unlocked the settings",
        );
        expect(
          /didn't match/i.test(await popup.$eval("#unlock-msg", (n) => n.textContent)),
          "no message for a wrong PIN",
        );
        await popup.$eval("#unlock-pin", (n) => {
          n.value = "";
        });
        await popup.type("#unlock-pin", "4827");
        await popup.click("#unlock-go");
        const open = await waitFor(() => popup.evaluate(() => !document.getElementById("settings-body").hidden), 3000);
        expect(open, "the right PIN didn't unlock");
        const openView = await popup.evaluate(() => ({
          mode: document.getElementById("site-mode").disabled,
          history: !document.getElementById("history-mine").hidden,
        }));
        expect(!openView.mode && !openView.history, `unlocked: ${JSON.stringify(openView)}`);
        await popup.select("#site-filter", ""); // the chosen chat is remembered: back to all for the checks after
        await shot(popup, "popup-helper.png");
      } finally {
        await popup.close();
        await ctx.worker.evaluate(() =>
          Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
        );
        await store.set(ctx, { advanced: false, events: [] });
      }
    },
  );

  await check(
    "PM3",
    'Helping someone: "Ask before sending personal details" sets every personal kind to Ask before sending, and stays on when an update brings a new personal kind',
    async () => {
      await store.set(ctx, { responses: {} });
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.click("#strict-personal");
        const r = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return x.phone_number === "block" ? x : null;
        }, 3000);
        expect(
          r && r.email === "block" && r.street_address === "block" && !r.aws_access_key,
          `responses: ${JSON.stringify(r)}`,
        );
        await popup.click("#strict-personal");
        const back = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return !x.phone_number ? x : null;
        }, 3000);
        expect(back, "turning it off didn't restore Warn");
      } finally {
        await popup.close();
        await store.set(ctx, { responses: {} });
      }
      // Suppose an update adds a personal-detail kind this copy has never seen. With the switch already on, the
      // new kind should also ask before sending, and the switch should still read as on. I check what Clotr
      // stores to see it now counts one more known kind.
      const brought = await ctx.worker.evaluate(async () => {
        const { Helper, PATTERNS } = globalThis.Clotr;
        const id = Helper.PERSONAL_IDS.at(-1);
        await chrome.storage.local.set({
          responses: Object.fromEntries(Helper.PERSONAL_IDS.filter((x) => x !== id).map((x) => [x, "block"])),
          knownKinds: PATTERNS.map((p) => p.id).filter((x) => x !== id),
        });
        await followPersonalSwitch("update");
        return id;
      });
      const after = (await store.get(ctx, "responses")).responses || {};
      expect(after[brought] === "block", `the new kind after the update: ${after[brought]}`);
      const again = await openPopup(ctx);
      try {
        await again.click("#tab-settings");
        await sleep(200);
        expect(await again.$eval("#strict-personal", (n) => n.checked), "the switch reads off after the update");
      } finally {
        await again.close();
      }
      const stored = await openExtPage(ctx, "stored.html");
      try {
        const row = await waitFor(
          () =>
            stored.evaluate(() => {
              const dt = [...document.querySelectorAll("#other dt")].find((d) =>
                /Kinds of detail Clotr knows/.test(d.textContent),
              );
              return dt?.nextElementSibling?.textContent || null;
            }),
          2000,
        );
        const count = await ctx.worker.evaluate(() => globalThis.Clotr.PATTERNS.length);
        expect(new RegExp(`^${count} kinds`).test(row || ""), `What Clotr stores: ${row}`);
      } finally {
        await stored.close();
        await store.set(ctx, { responses: {} });
      }
    },
  );

  await check(
    "PM4",
    "Helping someone: with a PIN set, the vault page explains it's locked and can't be edited",
    async () => {
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.set({ lock: { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) } }),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      const page = await openExtPage(ctx, "vault.html");
      try {
        await sleep(500);
        const got = await page.evaluate(() => ({
          locked: !document.getElementById("vault-locked").hidden,
          form: !document.getElementById("vault-form").hidden,
        }));
        expect(got.locked && !got.form, `vault page: ${JSON.stringify(got)}`);
      } finally {
        await page.close();
        await ctx.worker.evaluate(() => chrome.storage.local.remove("lock"));
      }
    },
  );

  await check(
    "PM5",
    "Guided setup: after Who is it for?, choosing each setting yourself gives today's four steps (larger warnings, ask-before for personal details, a PIN); reopened, the page asks for the PIN, and the right one opens it",
    async () => {
      await resetState(ctx);
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.remove(["lock", "largeText", "responses"]),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      let page = await openExtPage(ctx, "helper.html");
      try {
        await sleep(400);
        // Tourniquet's question comes first, and today's four steps follow right after it in the same list.
        await page.click('#who input[value="self"]');
        await sleep(250);
        const steps = await page.evaluate(() =>
          [...document.querySelectorAll("#steps > li")].filter((li) => !li.hidden).map((li) => li.id),
        );
        expect(
          JSON.stringify(steps) === JSON.stringify(["step-who", "step-vault", "step-large", "step-strict", "step-pin"]),
          `expected Who is it for? and today's 4 steps, got ${steps}`,
        );
        await page.click("#large-text");
        await page.click("#strict-personal");
        await page.type("#pin", "4821");
        await page.click("#lock-set");
        await sleep(600);
        const saved = await ctx.worker.evaluate(async () => {
          const s = await chrome.storage.local.get(["largeText", "responses", "lock"]);
          return {
            large: s.largeText,
            phone: s.responses?.phone_number,
            email: s.responses?.email,
            lock: Boolean(s.lock?.hash) && !JSON.stringify(s.lock).includes("4821"),
          };
        });
        expect(
          saved.large === true && saved.phone === "block" && saved.email === "block" && saved.lock,
          `settings: ${JSON.stringify(saved)}`,
        );
        await page.screenshot({ path: path.join(OUT, "helper-setup.png"), fullPage: true });
      } finally {
        await page.close();
      }
      await ctx.worker.evaluate(() => chrome.storage.session.remove("unlockedUntil"));
      page = await openExtPage(ctx, "helper.html");
      try {
        await sleep(400);
        const locked = await page.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          steps: !document.getElementById("steps").hidden,
        }));
        expect(locked.unlock && !locked.steps, `reopened: ${JSON.stringify(locked)}`);
        await page.type("#unlock-pin", "1111");
        await page.click("#unlock-go");
        await sleep(400);
        const wrong = await page.evaluate(() => document.getElementById("steps").hidden);
        expect(wrong, "a wrong PIN must not open the steps");
        await page.type("#unlock-pin", "4821");
        await page.click("#unlock-go");
        await sleep(600);
        const open = await page.evaluate(() => !document.getElementById("steps").hidden);
        expect(open, "the right PIN opens the steps");
      } finally {
        await page.close();
        await ctx.worker.evaluate(() =>
          Promise.all([
            chrome.storage.local.remove(["lock", "largeText", "responses"]),
            chrome.storage.session.remove("unlockedUntil"),
          ]),
        );
      }
    },
  );

  await check(
    "PM6",
    "With a PIN set, nothing in a warning loosens protection (no stop warning me, no OK to share, no Just count), the background refuses it from the chat, and the person's own history clears without the PIN",
    async () => {
      const LOOSENING = /stop warning me|don't warn me about|Just count it|fine to share/i;
      const PIN_HASH = { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) }; // a PIN nobody can type
      const setLock = (lock) =>
        ctx.worker.evaluate(
          (l) =>
            Promise.all([
              l ? chrome.storage.local.set({ lock: l }) : chrome.storage.local.remove("lock"),
              chrome.storage.session.remove("unlockedUntil"),
            ]),
          lock,
        );
      const choicesOf = (box) => (box?.buttons || []).map((b) => b.text);
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "555-555-0123"),
      );
      await resetState(ctx, {}); // every kind just warns
      await setLock(PIN_HASH);
      await sleep(500); // open tabs fetch their settings again
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          // I trigger the corner notice three times in a row. Leave it in should always be there, and nothing
          // should loosen the warning or even offer to.
          for (let i = 1; i <= 3; i++) {
            await clearEditor(page);
            await typeText(page, `call me at 555-555-01${20 + i}`);
            const n = await waitForNotice(page);
            expect(n, `no notice #${i}`);
            expect(!choicesOf(n).some((t) => LOOSENING.test(t)), `notice #${i}: ${choicesOf(n).join(" | ")}`);
            await clickDialogButton(page, "Leave it in", readNotice);
            await sleep(300);
          }
          await sleep(1500);
          const after = await readNotice(page);
          expect(!after || !/Warn less/.test(after.text), `offered to warn less: ${after?.text}`);
          // The first-time tip keeps the choices that keep or add protection.
          await store.set(ctx, { guided: {} });
          await clearEditor(page);
          await typeText(page, "write to ann.lee@example.com");
          const tip = await waitFor(async () => {
            const n = await readNotice(page);
            return /How should Clotr handle/.test(n?.text || "") ? n : null;
          }, 3000);
          expect(tip, `no first-time tip: ${(await readNotice(page))?.text}`);
          for (const kept of ["Warn me", "Ask before sending", "Always watch it"])
            expect(choicesOf(tip).includes(kept), `the tip lost "${kept}": ${choicesOf(tip).join(" | ")}`);
          expect(!choicesOf(tip).some((t) => LOOSENING.test(t)), `tip: ${choicesOf(tip).join(" | ")}`);
          // When the chat page asks directly to loosen it, I refuse. A stricter choice sent the same way still
          // goes through.
          const send = (m) => evalInClotr(page, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);
          await send({ type: "clotr:setResponses", ids: ["phone_number"], value: "log" });
          await send({
            type: "clotr:vaultAdd",
            entries: [{ kind: "value", type: "phone_number", fp, mode: "allow", added: Date.now() }],
          });
          await send({ type: "clotr:setResponses", ids: ["email"], value: "block" });
          let offer = null;
          for (let i = 0; i < 3; i++) offer = await send({ type: "clotr:ignored", types: ["phone_number"] });
          await sleep(300);
          const saved = await store.get(ctx, ["responses", "vault"]);
          expect(!saved.responses?.phone_number, `loosened from the chat: ${JSON.stringify(saved.responses)}`);
          expect(
            saved.responses?.email === "block",
            `a stricter choice was refused: ${JSON.stringify(saved.responses)}`,
          );
          expect(!(saved.vault || []).length, `an OK to share from the chat was kept: ${JSON.stringify(saved.vault)}`);
          expect(offer && !offer.offer, `offered to just count: ${JSON.stringify(offer)}`);
        });
        // The history belongs to the person using Clotr, so two clicks clear it without needing the PIN, and
        // the PIN itself stays set.
        await store.set(ctx, {
          mentions: [{ t: Date.now(), site: "chatgpt.com", type: "email", severity: "low", action: "mentioned" }],
          spotted: { "chat.newtool.ai": true },
        });
        expect((await store.events(ctx)).length, "no history to clear");
        const popup = await openPopup(ctx);
        try {
          await popup.click("#tab-settings");
          await sleep(200);
          const view = await popup.evaluate(() => ({
            body: document.getElementById("settings-body").hidden,
            history: !document.getElementById("history-mine")?.hidden,
          }));
          expect(view.body && view.history, `locked Settings: ${JSON.stringify(view)}`);
          await popup.click("#clear-mine");
          await sleep(200);
          expect((await store.events(ctx)).length, "one click cleared the history");
          await popup.click("#clear-mine");
          const cleared = await waitFor(async () => {
            const h = await store.get(ctx, ["events", "mentions", "spotted"]);
            return !h.events?.length && !h.mentions?.length && !Object.keys(h.spotted || {}).length;
          }, 2000);
          expect(cleared, `not cleared: ${JSON.stringify(await store.get(ctx, ["events", "mentions", "spotted"]))}`);
          expect((await store.get(ctx, "lock")).lock, "clearing the history touched the PIN");
        } finally {
          await popup.close();
        }
        // Once the PIN is removed, the looser choices come back.
        await setLock(null);
        await sleep(500);
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "call me at 555-555-0123");
          const n = await waitForNotice(page);
          expect(
            choicesOf(n).some((t) => /stop warning me/.test(t)),
            `no PIN, but no choices: ${choicesOf(n).join(" | ")}`,
          );
        });
      } finally {
        await setLock(null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "SH1",
    "Share Clotr: the link, the step-by-step setup and a one-page guide; printed, only the guide shows, with blanks for who set it up",
    async () => {
      const page = await openExtPage(ctx, "share.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          url: document.getElementById("share-url").textContent,
          guide: document.querySelector(".guide h2")?.textContent || "",
          blanks: document.querySelectorAll(".guide-fill .blank").length,
        }));
        expect(
          /^https:\/\//.test(got.url) && /clot your data leaks/.test(got.guide) && got.blanks === 2,
          JSON.stringify(got),
        );
        await page.screenshot({ path: path.join(OUT, "share.png"), fullPage: true });
        await page.emulateMediaType("print");
        const printed = await page.evaluate(() => ({
          controls: [...document.querySelectorAll(".no-print")].some((el) => getComputedStyle(el).display !== "none"),
          guide: getComputedStyle(document.querySelector(".guide")).display !== "none",
          // The guide should print dark no matter what theme the screen is using. The title once printed white
          // on white.
          light: [...document.querySelectorAll(".guide, .guide *")].filter((el) => {
            const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number);
            return r + g + b > 150;
          }).length,
        }));
        expect(!printed.controls && printed.guide && printed.light === 0, `print layout: ${JSON.stringify(printed)}`);
        await page.screenshot({ path: path.join(OUT, "share-print.png"), fullPage: true });
        await page.emulateMediaType(null);
        // "Set it up step by step" opens the guided setup.
        const before = (await ctx.browser.pages()).length;
        await page.click("#open-helper");
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("helper.html")) : null;
        }, 3000);
        expect(opened, "the guided setup didn't open");
        await opened?.close();
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "MV1",
    "Move to a new computer: the saved file brings settings, vault and salt back; a wrong password or a PIN lock refuses to load",
    async () => {
      const fp = "0123456789abcdef";
      const salt = "00112233445566778899aabbccddeeff";
      const mine = {
        responses: { phone_number: "block" },
        largeText: true,
        salt,
        vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: 1 }],
      };
      await ctx.worker.evaluate(
        (s) => Promise.all([chrome.storage.local.set(s), chrome.storage.local.remove("lock")]),
        mine,
      );
      const file = path.join(OUT, "move-test.clotr");
      const page = await openExtPage(ctx, "stored.html#move");
      const asked = [];
      page.on("dialog", (d) => {
        asked.push(d.message());
        d.accept();
      });
      try {
        await sleep(300);
        // Clicking the button needs two matching passwords typed in, and then it shows Saved.
        await page.type("#mv-pass", "correct horse battery");
        await page.type("#mv-pass2", "correct horse battery");
        await page.click("#mv-save");
        const saved = await waitFor(
          () =>
            page.evaluate(() => {
              const text = document.getElementById("mv-save-msg").textContent;
              return /^(Saved|Use|The two)/.test(text) ? text : null; // past "Working…"
            }),
          15000,
        );
        expect(/^Saved/.test(saved || ""), `save: ${saved}`);
        // I build the exact file the button would produce, so I can load it back later in this same check.
        const text = await page.evaluate(async () => {
          const { Backup } = globalThis.Clotr;
          return Backup.seal(Backup.pick(await chrome.storage.local.get(Backup.KEYS)), "correct horse battery");
        });
        expect(!text.includes(fp) && !text.includes(salt), "the file shows a fingerprint or the salt");
        fs.writeFileSync(file, text);
        // I simulate loading on another computer by setting different settings, an empty vault, and a
        // different salt.
        await ctx.worker.evaluate(() =>
          chrome.storage.local.set({ responses: {}, largeText: false, vault: [], salt: "ff".repeat(16) }),
        );
        const input = await page.$("#mv-file");
        await input.uploadFile(file);
        const loadMsg = async () => {
          await page.click("#mv-load");
          return waitFor(() => page.evaluate(() => document.getElementById("mv-load-msg").textContent || null), 15000);
        };
        await page.type("#mv-open", "wrong password!");
        const wrong = await loadMsg();
        expect(/doesn't open/.test(wrong || ""), `wrong password: ${wrong}`);
        await page.evaluate(() => {
          document.getElementById("mv-open").value = "";
          document.getElementById("mv-load-msg").textContent = "";
        });
        await page.type("#mv-open", "correct horse battery");
        const loaded = await loadMsg();
        // Before anything is replaced, the confirm dialog should say what the file holds. After loading, the
        // message should say what actually came back.
        expect(
          /1 vault item \(Phones: 1\)/.test(asked.at(-1) || "") &&
            /choices for 1 kind of detail/.test(asked.at(-1) || ""),
          `confirm: ${asked.at(-1)}`,
        );
        expect(
          /^Done\. Back from the file: 1 vault item \(Phones: 1\) and your choices for 1 kind of detail/.test(
            loaded || "",
          ),
          `load: ${loaded}`,
        );
        expect(
          await page.evaluate(
            () => document.querySelector("#mv-load-msg a")?.getAttribute("href") === "vault.html#vault-list",
          ),
          "no link to see the vault",
        );
        const back = await ctx.worker.evaluate(() =>
          chrome.storage.local.get(["responses", "largeText", "vault", "salt"]),
        );
        expect(
          back.responses?.phone_number === "block" &&
            back.largeText === true &&
            back.salt === salt &&
            back.vault?.length === 1 &&
            back.vault[0].fp === fp,
          `after loading: ${JSON.stringify(back)}`,
        );
        // With a PIN lock in place and not unlocked, loading should be refused before the file is even opened.
        await ctx.worker.evaluate(() =>
          Promise.all([
            chrome.storage.local.set({ lock: { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) } }),
            chrome.storage.session.remove("unlockedUntil"),
          ]),
        );
        await page.evaluate(() => (document.getElementById("mv-load-msg").textContent = ""));
        const locked = await loadMsg();
        expect(/locked/.test(locked || ""), `with a PIN: ${locked}`);
        await page.screenshot({ path: path.join(OUT, "move.png"), fullPage: true });
      } finally {
        await page.close();
        fs.rmSync(file, { force: true });
        await ctx.worker.evaluate(() => chrome.storage.local.remove(["lock", "responses", "largeText", "vault"]));
      }
    },
  );

  await check(
    "TP1",
    "Team policy: required responses win over the user's; the admin's watch words are caught (sent to the page as fingerprints only)",
    async () => {
      // A real managed policy needs admin rights, so I stand in for the browser's policy store inside the worker.
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          requiredResponses: { phone_number: "block" },
          watchWords: ["Project Falcon"],
        });
      });
      await resetState(ctx, { phone_number: "log" }); // the user's own choice: Just count
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "the project falcon launch is next week");
          const n = await waitForNotice(page);
          expect(n && /watch/i.test(n.text), `watch word not caught: ${JSON.stringify(n)}`);
          const vaultSeen = await evalInClotr(
            page,
            "JSON.stringify(document.documentElement.outerHTML.includes('falcon'))",
          );
          expect(vaultSeen === "false", "the watch word shows up in the page's markup");
          await clearEditor(page);
          await typeText(page, "call me at 555-555-0147");
          await pressEnter(page);
          expect(await waitForDialog(page), "the policy's Ask before sending didn't hold the phone number");
          expect((await sentMessages(page)).length === 0, "sent despite the policy");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  await check(
    "TM1",
    "Team pack preset (keys_never): a floor over the user's own choice; an explicit field beats the preset",
    async () => {
      const GITHUB_TOKEN = "ghp_7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi";
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ preset: "keys_never" });
      });
      await resetState(ctx, { github_token: "log" }); // the user's own choice: Just count
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, GITHUB_TOKEN);
          await pressEnter(page);
          const d = await waitForDialog(page);
          expect(d, "the preset's block didn't hold a github token the user set to Just count");
          expect((await sentMessages(page)).length === 0, "sent despite the preset");
          // For a kind the team requires, no choice in the warning should loosen it. Any such choice would only
          // snap back to the required setting.
          const choices = d.buttons.map((b) => b.text);
          expect(
            !choices.some((t) => /stop warning me|don't warn me about/i.test(t)),
            `the warning offers to loosen a kind the team holds: ${choices.join(" | ")}`,
          );
          expect(choices.includes("Leave it in and send"), `no Leave it in and send: ${choices.join(" | ")}`);
          // Even when the chat page asks for it directly, the background refuses to loosen it.
          await evalInClotr(
            page,
            `chrome.runtime.sendMessage(${JSON.stringify({ type: "clotr:setResponses", ids: ["aws_access_key"], value: "log" })})`,
          );
          await sleep(300);
          const r = (await store.get(ctx, "responses")).responses || {};
          expect(!r.aws_access_key, `loosened from the chat: ${JSON.stringify(r)}`);
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }

      // An explicit requiredResponses entry beats the preset: warn instead of the preset's block.
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          preset: "keys_never",
          requiredResponses: { github_token: "warn" },
        });
      });
      await resetState(ctx, { github_token: "log" });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, GITHUB_TOKEN);
          await pressEnter(page);
          expect(!(await waitForDialog(page)), "the explicit warn should not hold the message like the preset's block");
          expect((await sentMessages(page)).length === 1, "the explicit warn should let the message send");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  await check("TM2", "Team pack: a watch format (EMP-#####) through policy, alongside a plain watch word", async () => {
    await ctx.worker.evaluate(() => {
      globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
      chrome.storage.managed.get = async () => ({
        preset: "client_names",
        watchWords: ["Acme Holdings", "EMP-#####"],
      });
    });
    try {
      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "please loop in Acme Holdings on this");
        await pressEnter(page);
        expect(await waitForDialog(page), "the watch word didn't ask before sending");
        expect((await sentMessages(page)).length === 0, "the watch word should hold the message");
        const vaultSeen = await evalInClotr(
          page,
          "JSON.stringify(document.documentElement.outerHTML.toLowerCase().includes('acme'))",
        );
        expect(vaultSeen === "false", "the watch word shows up in the page's markup");
      });

      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "employee number EMP-48213 needs access");
        await pressEnter(page);
        expect(await waitForDialog(page), "the watch format didn't ask before sending");
        expect((await sentMessages(page)).length === 0, "the watch format should hold the message");
      });

      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "employee number EMP-4821 needs access");
        await pressEnter(page);
        expect(!(await waitForDialog(page)), "a number with the wrong digit count shouldn't match the format");
        expect((await sentMessages(page)).length === 1, "a non-matching number should send");
      });
    } finally {
      await ctx.worker.evaluate(() => {
        chrome.storage.managed.get = globalThis.__realManagedGet;
      });
      await resetState(ctx);
    }
  });

  await check(
    "TM3",
    "Team pack: a required block survives the loopholes (a site set to Just count, an 'OK to share' vault entry)",
    async () => {
      const host = "chatgpt.com";
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "555-555-0147"),
      );
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ requiredResponses: { phone_number: "block" } });
      });
      await resetState(ctx);
      await store.set(ctx, {
        siteModes: { [host]: "log" },
        vault: [{ kind: "value", type: "phone_number", mode: "allow", fp, added: Date.now() }],
      });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "call me at 555-555-0147");
          await pressEnter(page);
          expect(
            await waitForDialog(page),
            "a site set to Just count plus an 'OK to share' vault entry weakened the policy's block",
          );
          expect((await sentMessages(page)).length === 0, "sent despite the policy's required block");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  // A team can name its own kinds in its policy. I stub the worker's policy store the same way TP1 and TM1
  // through TM3 do, since a real managed policy needs admin rights.
  const TEAM_KINDS = {
    kinds: [
      { name: "Matter number", formats: ["MAT-######"], near: ["matter", "file"], response: "block", cover: "Matter" },
      { name: "Client name", words: ["Globex Holdings"] },
    ],
  };
  const withTeamPolicy = async (policy, fn) => {
    await ctx.worker.evaluate((p) => {
      globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
      chrome.storage.managed.get = async () => p;
    }, policy);
    try {
      return await fn();
    } finally {
      await ctx.worker.evaluate(() => {
        chrome.storage.managed.get = globalThis.__realManagedGet;
      });
      await resetState(ctx);
    }
  };

  await check(
    "TK1",
    "Team kinds: a kind from the policy warns by its own name with its floor, its words reach the page as fingerprints only, and Bandage covers it as [Matter 1]",
    () =>
      withTeamPolicy(TEAM_KINDS, async () => {
        // The person's own choice (Just count) can't loosen what the team set.
        await resetState(ctx, { team_matter_number: "log", team_client_name: "log" });
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "draft a letter to globex holdings about the renewal");
          const n = await waitForNotice(page);
          expect(n && /Client name/.test(n.text), `the team's word wasn't named: ${JSON.stringify(n?.text)}`);
          expect(/kind your organization added/i.test(n.text), `no line saying the team added it: ${n.text}`);
          expect(!/How should Clotr handle/i.test(n.text), "a first-time tip offered to loosen a team kind");
          expect(!n.buttons.some((b) => /stop warning me/i.test(b.text)), "offered to stop warning about a team kind");
          await page.setViewport({ width: 380, height: 640 });
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(300);
            await page.screenshot({ path: path.join(OUT, `team-kind-notice-${theme}.png`) });
          }
          // Report a false alarm opens a public form, and a team's kind should show up there without its name.
          await evalInClotr(
            page,
            "globalThis.__opened = []; window.open = (u) => { globalThis.__opened.push(u); return null; }, true",
          );
          await clickDialogButton(page, "Why am I seeing this?", readNotice);
          await clickDialogButton(page, "Wrong? Report a false alarm", readNotice);
          const [url] = await evalInClotr(page, "globalThis.__opened");
          const decoded = decodeURIComponent(url || "");
          expect(decoded.includes("False alarm: A kind your organization added"), `report title: ${decoded}`);
          expect(!/client name|globex/i.test(decoded), `the public report names the team's kind: ${decoded}`);
          const inMarkup = await evalInClotr(
            page,
            "JSON.stringify(document.documentElement.outerHTML.toLowerCase().includes('globex'))",
          );
          expect(inMarkup === "false", "the team's word shows up in the page's markup");
          await clearEditor(page);
          await sleep(500);
          await typeText(page, "the file MAT-204141 is ready");
          await pressEnter(page);
          const d = await waitForDialog(page);
          expect(d && /Matter number/.test(d.text), `the team's Ask before sending didn't hold it: ${d?.text}`);
          expect(/kind your organization added/i.test(d.text), `no line saying the team added it: ${d.text}`);
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(300);
            await page.screenshot({ path: path.join(OUT, `team-kind-dialog-${theme}.png`) });
          }
          expect((await sentMessages(page)).length === 0, "sent despite the team's floor");
        });
        await resetState(ctx);
        await withSite(ctx, "chatgpt", async (page) => {
          // A format with none of its nearby words in front of it should be left alone.
          const opened = Date.now();
          await typeText(page, "flight MAT-204141 lands at noon");
          await pressEnter(page);
          expect(!(await waitForDialog(page)), "a format without its nearby word held the message");
          const sent = (await sentMessages(page)).length;
          expect(
            sent === 1,
            `a format without its nearby word didn't send (${Date.now() - opened} ms; ${JSON.stringify(page.logs.filter((l) => l.includes("[Clotr]")).map((l) => l.slice(0, 60)))})`,
          );
        });
        await resetState(ctx);
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "matter MAT-204141, file MAT-551200 and matter MAT-204141 again");
          const want = "matter [Matter 1], file [Matter 2] and matter [Matter 1] again";
          const ok = await waitFor(async () => ((await editorText(page)) === want ? true : null), 4000);
          expect(ok, `chat box: "${await editorText(page)}"`);
          const events = await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.filter((e) => e.type === "team_matter_number" && e.via === "bandage").length >= 2 ? ev : null;
          }, 6000); // recorded through the background's queue: on a busy computer that can take a few seconds
          expect(
            events,
            `not counted as hidden by Bandage under the team's kind: ${JSON.stringify((await store.events(ctx)).map((e) => [e.type, e.action, e.via]))}`,
          );
          expect(!JSON.stringify(events).includes("204141"), "the matter number was stored");
          expect(
            events.every((e) => e.type !== "team_matter_number" || e.name === "Matter number"),
            "the team's kind lost its name in the history",
          );
        });
      }),
  );

  // This Teams group runs through the same managed-storage stub as the other policy checks, not a real Firefox
  // group policy, since a real managed policy needs admin rights this session never has.
  await check(
    "T3C47",
    "Team kinds: a file holding the policy's required Matter number gets the file-hold dialog naming it as the team's own kind",
    () =>
      withTeamPolicy(TEAM_KINDS, async () => {
        await resetState(ctx, { team_matter_number: "log", team_client_name: "log" });
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("t3c47");
          try {
            await attachText(page, dir, "matter-notes.txt", "Please refile this matter, MAT-204141, before Friday.\n");
            await typeText(page, "see file");
            await pressEnter(page);
            const d = await waitForDialog(page);
            expect(d && /looks private/i.test(d.text) && /Matter number/.test(d.text), `dialog: ${d?.text}`);
            expect(/organization/i.test(d?.text || ""), `no organization line: ${d?.text}`);
            expect((await sentMessages(page)).length === 0, "sent despite the team's file hold");
          } finally {
            dropDir(dir);
          }
        });
      }),
  );

  await check(
    "T3C48",
    "No team policy: no 'Kinds your organization added' group in Settings, and a team-shaped Matter number no longer warns",
    async () => {
      await resetState(ctx, {});
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "the matter MAT-204141 is ready");
        await pressEnter(page);
        expect(!(await waitForDialog(page)), "a Matter number warned with no team policy");
        expect((await sentMessages(page)).length === 1, "message didn't send with no team policy");
      });
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await sleep(300);
        const visible = await popup.evaluate(() => {
          const group = document.querySelector('.resp-group[data-group="team"]');
          return group ? group.getClientRects().length > 0 : false;
        });
        expect(!visible, "a team kinds group showed with no managed policy");
      } finally {
        await popup.close();
      }
    },
  );

  await check("TK2", "Team kinds: settings with 500 team words are served within 20 ms after the first time", () =>
    withTeamPolicy(
      {
        watchWords: Array.from({ length: 100 }, (_, i) => `watch word ${i}`),
        kinds: [
          { name: "Client name", words: Array.from({ length: 300 }, (_, i) => `client number ${i}`) },
          { name: "Matter name", words: Array.from({ length: 200 }, (_, i) => `matter number ${i}`) },
        ],
      },
      async () => {
        const timed = () =>
          ctx.worker.evaluate(async () => {
            const t0 = performance.now();
            const s = await settingsFor("https://chatgpt.com/");
            return {
              ms: performance.now() - t0,
              words: s.vault.filter((e) => e.managed && e.kind === "word").length,
              kinds: s.kinds.map((k) => k.id),
              plain: JSON.stringify(s).includes("client number"),
            };
          });
        const first = await timed();
        expect(first.words === 500, `expected 500 team words, got ${first.words}`);
        expect(first.kinds.join() === "team_client_name,team_matter_name", `kinds: ${first.kinds}`);
        expect(!first.plain, "a team word reached the page's settings as text");
        let best = Infinity;
        for (let i = 0; i < 5; i++) best = Math.min(best, (await timed()).ms);
        expect(
          best < 20,
          `settings took ${best.toFixed(1)} ms after the first (${first.ms.toFixed(1)} ms the first time)`,
        );
      },
    ),
  );

  // ---------- The file hold for teams: the policy's floor, with no new field ----------
  // Under a policy that asks before sending, a file holding one of its kinds should wait for the person's answer
  // with no time limit, and the dialog should say the organization asked for the check. If a file is still being
  // read after three seconds, Clotr should ask rather than send silently. The SSN and the intake file below are
  // both made up, and neither should ever end up stored.
  const SSN = "123-45-6789";
  const INTAKE = "intake-march.txt";
  TYPED_VALUES.add(SSN);
  TYPED_VALUES.add(INTAKE);
  const attachIntake = (page, dir) => attachText(page, dir, INTAKE, `Patient intake\nSSN: ${SSN}\n`);
  const sentCount = async (page) => (await sentMessages(page)).length;
  const sentWithin = (page, n, ms) => waitFor(async () => ((await sentCount(page)) === n ? true : null), ms);
  const TEAM_LINE = /Your organization asks Clotr to check files with these details/;

  await check(
    "TF1",
    "Team file hold (clinic): a file with an SSN holds the send with the organization's line and no time limit; Send with the file sends it once, counted as allowed, nothing about it stored",
    () =>
      withTeamPolicy({ preset: "clinic" }, async () => {
        await resetState(ctx, {}); // nothing set by the person: the policy's floor asks
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf1");
          try {
            await attachIntake(page, dir);
            await typeText(page, "summarize this intake form");
            await sleep(800);
            await pressEnter(page);
            const dialog = await waitForDialog(page);
            expect(
              /This file looks private/.test(dialog?.text || "") &&
                dialog.text.includes(INTAKE) &&
                /Social Security/.test(dialog.text) &&
                !dialog.text.includes(SSN),
              `dialog: ${dialog?.text}`,
            );
            expect(TEAM_LINE.test(dialog.text) && /Sending is still your choice/.test(dialog.text), dialog.text);
            await holdShots(page, "file-hold-team");
            await sleep(10000);
            expect(await readDialog(page), "the dialog went away by itself");
            expect((await sentCount(page)) === 0, "sent without an answer");
            await clickDialogButton(page, "Send with the file");
            expect(await sentWithin(page, 1, 2000), `sent: ${JSON.stringify(await sentMessages(page))}`);
            await sleep(500);
            expect((await sentCount(page)) === 1, "sent twice");
            const events = await waitFor(async () => {
              const ev = (await store.events(ctx)).filter((e) => e.type === "us_ssn");
              return ev.length ? ev : null;
            }, 3000);
            expect(
              events?.length === 1 && events[0].action === "allowed" && /^[0-9a-f]{16}$/.test(events[0].fp),
              `events: ${JSON.stringify(await store.events(ctx))}`,
            );
            const all = JSON.stringify(await store.get(ctx, null));
            expect(!all.includes(SSN) && !all.includes("123456789") && !all.includes("intake-march"), "stored");
          } finally {
            dropDir(dir);
          }
        });
      }),
  );

  await check(
    "TF2",
    "Team file hold (clinic, with the organization's name): Enter after 0.6 s goes back to remove it, nothing sent, the chat box has focus; the name is never in the chat page",
    () =>
      withTeamPolicy({ preset: "clinic", orgName: "Riverside Clinic" }, async () => {
        await resetState(ctx, {});
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf2");
          try {
            await attachIntake(page, dir);
            await typeText(page, "summarize this intake form");
            await sleep(800);
            await pressEnter(page);
            const dialog = await waitForDialog(page);
            expect(TEAM_LINE.test(dialog?.text || ""), `dialog: ${dialog?.text}`);
            expect(!/Riverside/i.test(dialog.text), "the organization's name is in the dialog");
            await sleep(700);
            await page.keyboard.press("Enter");
            await sleep(300);
            expect(!(await readDialog(page)), "Enter didn't go back");
            expect((await sentCount(page)) === 0, "Enter sent the file");
            const focused = await page.evaluate(() => document.activeElement?.id);
            expect(focused === "prompt-textarea", `focus: ${focused}`);
            const inPage = await evalInClotr(
              page,
              "JSON.stringify(document.documentElement.outerHTML.includes('Riverside'))",
            );
            expect(inPage === "false", "the organization's name is in the chat page");
          } finally {
            dropDir(dir);
          }
        });
      }),
  );

  await check(
    "TF3",
    "Team file hold (keys_never), a file still being read: after about 3 s a question, never a silent send; Wait for the check sends once nothing turns up; a key found replaces the question with the file's dialog, which takes focus",
    () =>
      withTeamPolicy({ preset: "keys_never" }, async () => {
        await resetState(ctx, {});
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf3");
          try {
            await stubReader(page, "slow", 9000);
            await typeText(page, "here are this week's notes");
            await sleep(600);
            await attachText(page, dir, "week-notes.txt", "Standup notes, nothing private here.\n");
            await readStarted(page);
            const t0 = Date.now();
            await pressEnter(page);
            const note = await waitFor(async () => {
              const n = await readNotice(page);
              return n && /Checking your file/.test(n.text) ? n : null;
            }, 2500);
            expect(note, "no checking note");
            const question = await waitFor(async () => {
              const d = await readDialog(page);
              return d && /still checking your file/.test(d.text) ? d : null;
            }, 4500);
            const ms = Date.now() - t0;
            expect(question && ms >= 2500, `question: ${question?.text}, after ${ms} ms`);
            expect(
              question.buttons.map((b) => b.text).join("/") ===
                "Send now, without the check/Wait for the check/Go back to my message (Esc)",
              `buttons: ${question.buttons.map((b) => b.text)}`,
            );
            expect(question.text.includes("week-notes.txt") && /organization asks/.test(question.text), question.text);
            expect((await sentCount(page)) === 0, "sent without the check");
            await holdShots(page, "file-wait-team");
            await clickDialogButton(page, "Wait for the check");
            expect(!(await readDialog(page)), "the question stayed open");
            expect(await sentWithin(page, 1, 6000), "nothing turned up, but the message didn't go");
            expect(!(await readDialog(page)), "a dialog for a file with nothing in it");
          } finally {
            dropDir(dir);
          }
        });
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf3b");
          try {
            await stubReader(page, "slow", 6000);
            await typeText(page, "why does this deploy fail?");
            await sleep(600);
            await attachText(page, dir, "deploy.env", `AWS_ACCESS_KEY_ID=${KEY}\n`);
            await readStarted(page);
            await pressEnter(page);
            expect(
              await waitFor(async () => /still checking/.test((await readDialog(page))?.text || ""), 4500),
              "no question",
            );
            const held = await waitFor(async () => {
              const d = await readDialog(page);
              return d && /This file looks private/.test(d.text) ? d : null;
            }, 5000);
            expect(held && /AWS Access Key/.test(held.text) && TEAM_LINE.test(held.text), `after: ${held?.text}`);
            const focus = await page.evaluate(() => document.activeElement?.nodeName);
            expect(focus === "CLOTR-GUARD", `focus: ${focus}`);
            expect((await sentCount(page)) === 0, "sent with a key in the file");
          } finally {
            dropDir(dir);
          }
        });
      }),
  );

  await check(
    "TF4",
    "Team file hold, fail open: a read that throws lets Enter send and says the file couldn't be checked; a page that removes Clotr's dialog lets Enter send",
    () =>
      withTeamPolicy({ preset: "clinic" }, async () => {
        await resetState(ctx, {});
        const before = ctx.problems.length;
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf4");
          try {
            await stubReader(page, "broken");
            await typeText(page, "summarize this intake form");
            await sleep(600);
            await attachIntake(page, dir);
            await readStarted(page);
            await pressEnter(page);
            expect(await sentWithin(page, 1, 1500), "a file Clotr couldn't read held the message");
            expect(!(await readDialog(page)), "a dialog for a file that couldn't be read");
            const notice = await readNotice(page);
            expect(/couldn't check/.test(notice?.text || ""), `notice: ${notice?.text}`);
          } finally {
            dropDir(dir);
          }
        });
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tf4b");
          try {
            await attachIntake(page, dir);
            await typeText(page, "summarize this intake form");
            await sleep(800);
            await pressEnter(page);
            expect(await waitForDialog(page), "no dialog for the file");
            await page.evaluate(() => document.querySelector("clotr-guard")?.remove());
            await sleep(300);
            await pressEnter(page);
            expect(await sentWithin(page, 1, 1500), "held after the page removed Clotr's dialog");
          } finally {
            dropDir(dir);
          }
        });
        ctx.problems.length = before; // broken on purpose
      }),
  );

  await check(
    "TF5",
    "No team policy, the person's own Ask before sending: the file's dialog without the organization's line, and a slow file never becomes a question",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { us_ssn: "block" });
        const dir = holdDir("tf5");
        try {
          await attachIntake(page, dir);
          await typeText(page, "summarize this intake form");
          await sleep(800);
          await pressEnter(page);
          const dialog = await waitForDialog(page);
          expect(/This file looks private/.test(dialog?.text || ""), `dialog: ${dialog?.text}`);
          expect(!/organization/i.test(dialog.text), `an organization line without a policy: ${dialog.text}`);
          await clickDialogButton(page, "Send with the file");
          expect(await sentWithin(page, 1, 2000), "Send with the file didn't send");
          await stubReader(page, "never");
          await typeText(page, "and this one");
          await sleep(600);
          await attachText(page, dir, "later.txt", `SSN: ${SSN}\n`);
          await readStarted(page);
          await pressEnter(page);
          expect(await sentWithin(page, 2, 4500), "a slow file held the message past 3 seconds");
          expect(!(await readDialog(page)), "a question without a team policy");
        } finally {
          dropDir(dir);
        }
      }),
  );

  // TM4 is the same check as TF1: a policy's Ask kind inside a file waits for an answer. TM5 checks the opposite
  // case, where a policy leaves a kind at Warn, or has no Ask kinds at all, and only the corner note should show.
  await check(
    "TM5",
    "Team file hold: a file with only what the policy leaves at Warn gets the corner note and Enter sends; a policy with no Ask kinds never holds a file",
    () =>
      withTeamPolicy({ preset: "clinic" }, async () => {
        await resetState(ctx, {});
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("tm5");
          try {
            await attachText(page, dir, "contacts.txt", "Front desk: ann.lee@gmail.com\n");
            const notice = await waitForNotice(page);
            expect(/contacts\.txt/.test(notice?.text || "") && /Email/.test(notice.text), `notice: ${notice?.text}`);
            await typeText(page, "tidy up this list");
            await pressEnter(page);
            expect(await sentWithin(page, 1, 1500), "a Warn-level file held the message");
            expect(!(await readDialog(page)), "a dialog for a Warn-level file");
          } finally {
            dropDir(dir);
          }
        });
      }).then(() =>
        withTeamPolicy({ requiredResponses: { email: "warn" } }, async () => {
          await resetState(ctx, {});
          await withSite(ctx, "chatgpt", async (page) => {
            const dir = holdDir("tm5b");
            try {
              await stubReader(page, "never");
              await typeText(page, "tidy up this list");
              await sleep(600);
              await attachText(page, dir, "contacts.txt", "Front desk: ann.lee@gmail.com\n");
              await readStarted(page);
              await pressEnter(page);
              expect(await sentWithin(page, 1, 1000), "a policy with no Ask kinds waited for a file");
            } finally {
              dropDir(dir);
            }
          });
        }),
      ),
  );

  // TM2 used to fail now and then on the very first message after a page loads, so these checks cover that case
  // directly: a word the team's policy requires to ask about must still ask right after load. The page needs two
  // answers from the background before it can match a word, its settings as fingerprints and the salt to
  // fingerprint what you type, and the background answers them one at a time, settings first. I hold one answer
  // back here the way a busy computer sometimes does.
  const ACME = { preset: "client_names", watchWords: ["Acme Holdings"] };
  const slowWorker = (fn, arg) => ctx.worker.evaluate(fn, arg);
  const restoreWorker = () =>
    ctx.worker.evaluate(() => {
      if (globalThis.__realSettingsFor) globalThis.settingsFor = globalThis.__realSettingsFor;
      if (globalThis.__realEnsureSalt) globalThis.ensureSalt = globalThis.__realEnsureSalt;
      globalThis.__releaseSettings?.();
    });

  await check(
    "TK4",
    "Team kinds: the policy's word asks on the very first message, even when the page's salt comes 1.5 s after its settings",
    () =>
      withTeamPolicy(ACME, async () => {
        await resetState(ctx);
        // I delay the salt's own answer by 1.5 seconds, but not when the salt is asked for while building the
        // settings.
        await slowWorker(() => {
          globalThis.__realSettingsFor = settingsFor;
          globalThis.__realEnsureSalt = ensureSalt;
          let making = false;
          globalThis.settingsFor = async (url) => {
            making = true;
            try {
              return await globalThis.__realSettingsFor(url);
            } finally {
              making = false;
            }
          };
          globalThis.ensureSalt = async () => {
            const salt = await globalThis.__realEnsureSalt();
            if (!making) await new Promise((r) => setTimeout(r, 1500));
            return salt;
          };
        });
        try {
          await withSite(ctx, "chatgpt", async (page) => {
            await typeText(page, "please loop in Acme Holdings on this");
            await pressEnter(page);
            expect(await waitForDialog(page), "the watch word didn't ask before sending");
            expect((await sentMessages(page)).length === 0, "sent before Clotr could check the team's word");
          });
        } finally {
          await restoreWorker();
        }
      }),
  );

  await check(
    "TK5",
    "Team kinds: a send before the page has its settings waits for them (at most 3 s) and then asks; if they don't come, it goes after 3 s",
    () =>
      withTeamPolicy(ACME, async () => {
        await resetState(ctx);
        // Settings wait here until I let them go. openSite itself gives up waiting for them after 3 seconds.
        const gate = () =>
          slowWorker(() => {
            globalThis.__realSettingsFor ??= settingsFor;
            const gateOpen = new Promise((r) => (globalThis.__releaseSettings = r));
            globalThis.settingsFor = async (url) => {
              await gateOpen;
              return globalThis.__realSettingsFor(url);
            };
          });
        try {
          await gate();
          await withSite(ctx, "chatgpt", async (page) => {
            await typeText(page, "please loop in Acme Holdings on this");
            const entered = Date.now();
            await pressEnter(page);
            // I let the settings go right away, since the wait is at most 3 seconds and each step of a check can
            // be slow on a busy computer. A message sent before the settings arrived would still show up in the
            // count below.
            await slowWorker(() => globalThis.__releaseSettings());
            const asked = await waitForDialog(page);
            expect(
              asked,
              `the watch word didn't ask once the settings came (${Date.now() - entered} ms after Enter; ${JSON.stringify(page.logs.filter((l) => l.includes("[Clotr]")).map((l) => l.slice(0, 60)))})`,
            );
            expect(
              (await sentMessages(page)).length === 0,
              "sent before the settings came, or despite Ask before sending",
            );
          });
          // If settings never come in time, the message should still go through after 3 seconds, not later and
          // not stuck forever.
          await gate();
          await withSite(ctx, "chatgpt", async (page) => {
            await typeText(page, "nothing private here, just a question");
            const t0 = Date.now();
            await pressEnter(page);
            await sleep(1500);
            expect((await sentMessages(page)).length === 0, "the wait for settings didn't hold the message");
            const sent = await waitFor(async () => (await sentMessages(page)).length === 1, 3500, 50);
            const ms = Date.now() - t0;
            expect(sent, `the message never went (${ms} ms)`);
            expect(ms < 3800, `the message waited ${ms} ms, more than 3 s`);
          });
        } finally {
          await restoreWorker();
        }
      }),
  );

  // This opens policy.html with chrome.storage.managed.get stubbed inside that page's own context. Each extension
  // page has its own JS realm, so the worker's stub from the TM checks above can't reach a page that reads
  // storage.managed for itself, and a real managed policy needs admin rights I don't have here.
  const openPolicyPage = async (policyObj) => {
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`policy.html error: ${err.message}`));
    if (policyObj) {
      await page.evaluateOnNewDocument((obj) => {
        chrome.storage.managed.get = async () => obj;
      }, policyObj);
    }
    await page.setViewport({ width: 700, height: 900 });
    await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/policy.html`);
    await sleep(400);
    return page;
  };

  await check(
    "PA1",
    "The organization policy page: its fields, the fingerprint's format and stability, a preset shows as its expanded JSON, watch words hidden until the checkbox, the no-policy line",
    async () => {
      const none = await openPolicyPage();
      try {
        const state = await none.evaluate(() => ({
          noneHidden: document.getElementById("pa-none").hidden,
          policyHidden: document.getElementById("pa-policy").hidden,
          noneText: document.getElementById("pa-none").textContent,
        }));
        expect(!state.noneHidden && state.policyHidden, `no-policy state: ${JSON.stringify(state)}`);
        expect(/no organization policy/i.test(state.noneText), `no-policy line: ${state.noneText}`);
      } finally {
        await none.close();
      }

      const bare = await openPolicyPage({ preset: "keys_never", orgName: "Acme Holdings" });
      try {
        const fields = await bare.evaluate(() => ({
          org: document.getElementById("pa-org").textContent,
          preset: document.getElementById("pa-preset").textContent,
          fp: document.getElementById("pa-fingerprint").textContent,
          wordsHidden: document.getElementById("pa-words").hidden,
        }));
        expect(fields.org === "Acme Holdings", `org name: ${fields.org}`);
        expect(!/with organization changes/i.test(fields.preset), `bare preset label: ${fields.preset}`);
        expect(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(fields.fp), `fingerprint format: ${fields.fp}`);
        expect(fields.wordsHidden, "watch words shown before the checkbox is checked");
        await bare.click("#pa-show-words");
        await sleep(100);
        const afterCheck = await bare.evaluate(() => document.getElementById("pa-words").hidden);
        expect(!afterCheck, "watch words stayed hidden after checking the box");
      } finally {
        await bare.close();
      }

      // A second page given the exact same policy should print the same fingerprint, which checks stability.
      const again = await openPolicyPage({ preset: "keys_never", orgName: "Acme Holdings" });
      try {
        const fp2 = await again.evaluate(() => document.getElementById("pa-fingerprint").textContent);
        const fp1 = await bare.evaluate(() => document.getElementById("pa-fingerprint").textContent).catch(() => null);
        if (fp1) expect(fp1 === fp2, `fingerprint not stable: ${fp1} vs ${fp2}`);
      } finally {
        await again.close();
      }

      // The admin's explicit change on top of the preset shows as "Preset with organization changes".
      const changed = await openPolicyPage({
        preset: "keys_never",
        requiredResponses: { github_token: "warn" },
      });
      try {
        const preset = await changed.evaluate(() => document.getElementById("pa-preset").textContent);
        expect(/with organization changes/i.test(preset), `changed preset label: ${preset}`);
      } finally {
        await changed.close();
      }

      // A policy that asks before sending should hold attached files with those kinds, and the page should say
      // so. A policy that only warns shouldn't show that line at all.
      const filesLine = (page) =>
        page.evaluate(() =>
          [...document.querySelectorAll("#pa-counts li")]
            .map((li) => li.textContent)
            .find((t) => /^Attached files/.test(t)),
        );
      const clinic = await openPolicyPage({ preset: "clinic" });
      try {
        const line = await filesLine(clinic);
        expect(/held until the person answers/.test(line || ""), `files line: ${line}`);
      } finally {
        await clinic.close();
      }
      const warnOnly = await openPolicyPage({ requiredResponses: { email: "warn" } });
      try {
        expect(!(await filesLine(warnOnly)), "a files line for a policy that never asks");
      } finally {
        await warnOnly.close();
      }
    },
  );

  await check(
    "PA2",
    "The organization policy page prints cleanly, stays dark-mode aware, makes no outside requests, and never writes to storage",
    async () => {
      const before = await ctx.worker.evaluate(() => chrome.storage.local.get(null));
      const page = await openPolicyPage({ preset: "clinic", orgName: "Riverside Clinic" });
      try {
        await page.emulateMediaType("print");
        const printed = await page.evaluate(() => ({
          controls: [...document.querySelectorAll(".no-print")].some((el) => getComputedStyle(el).display !== "none"),
          light: [...document.querySelectorAll("body, body *")].filter((el) => {
            const c = getComputedStyle(el).color.match(/\d+/g);
            return c && c.map(Number).reduce((a, b) => a + b, 0) > 550; // near-white text would fail to print
          }).length,
        }));
        expect(!printed.controls, "print controls stayed visible when printing");
        expect(printed.light === 0, "some text stayed light (unreadable) on paper");
        await page.emulateMediaType(null);
        const outside = await page.evaluate(() =>
          fetch("https://chatgpt.com/robots.txt")
            .then(() => "reached chatgpt.com")
            .catch(() => "blocked"),
        );
        expect(outside === "blocked", `the policy page could connect out: ${outside}`);
        await page.screenshot({ path: path.join(OUT, "policy.png"), fullPage: true });
      } finally {
        await page.close();
      }
      const after = await ctx.worker.evaluate(() => chrome.storage.local.get(null));
      expect(JSON.stringify(before) === JSON.stringify(after), "the policy page changed storage.local");
    },
  );

  await check(
    "PA3",
    "The popup's managed banner without lockSettings, its 'See what's applied' button, and a disabled dropdown showing the policy's value",
    async () => {
      await resetState(ctx, { github_token: "log" });
      // The popup reads storage.managed itself, in its own page and its own JS realm, so I stub it there
      // instead of in the worker. The TM checks' pattern of stubbing the worker wouldn't reach it.
      const popup = await ctx.browser.newPage();
      popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
      await popup.evaluateOnNewDocument(() => {
        chrome.storage.managed.get = async () => ({ requiredResponses: { github_token: "block" } });
      });
      await popup.setViewport({ width: 380, height: 700 });
      await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
      await popup.waitForSelector("#hero-value");
      await sleep(400);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const banner = await popup.evaluate(() => ({
          hidden: document.getElementById("managed-note").hidden,
          hasUnlock: !document.getElementById("unlock").hidden,
        }));
        expect(!banner.hidden, "the banner should show without lockSettings too");
        expect(!banner.hasUnlock, "no PIN unlock section without lockSettings");
        const row = await popup.$eval('select[data-pattern="github_token"]', (s) => ({
          value: s.value,
          disabled: s.disabled,
        }));
        expect(
          row.disabled && row.value === "block",
          `the floored dropdown should be disabled and show the policy's value: ${JSON.stringify(row)}`,
        );
        const before = (await ctx.browser.pages()).length;
        await popup.click("#managed-see");
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("policy.html")) : null;
        }, 3000);
        expect(opened, "the policy page didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await resetState(ctx);
      }
    },
  );

  // A team's own kinds should show on screen, in the policy page's table and the popup's locked rows, but never
  // their words. I check both pages with axe-core in light and dark; A11Y1 already covers these same pages with
  // no policy set.
  const axeProblems = async (page) => {
    const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
    const found = [];
    for (const theme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(150);
      if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
      const bad = await page.evaluate(async () =>
        (await axe.run(document, { resultTypes: ["violations"] })).violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      );
      found.push(...bad.map((b) => `${theme}: ${b}`));
    }
    return found;
  };
  const RIVERSIDE = {
    orgName: "Riverside Legal",
    kinds: [
      { name: "Matter number", formats: ["MAT-######", "M-@@####"], response: "block", cover: "Matter" },
      { name: "Client name", words: ["Globex Holdings", "Initech"], response: "block", cover: "Client" },
      { name: "Case code", formats: ["@@-####"], near: ["case"], response: "warn", cover: "Case" },
    ],
  };

  await check(
    "PA4",
    "The organization policy page lists the team's own kinds (name, response, how many words and formats, cover names), never their words",
    async () => {
      const page = await openPolicyPage(RIVERSIDE);
      try {
        const read = () =>
          page.evaluate(() => ({
            hidden: document.getElementById("pa-kinds").hidden,
            head: [...document.querySelectorAll("#pa-kinds-table thead th")].map((th) => th.textContent.trim()),
            rows: [...document.querySelectorAll("#pa-kinds-table tbody tr")].map((tr) =>
              [...tr.children].map((td) => td.textContent.trim()),
            ),
            covers: document.getElementById("pa-kinds-covers").textContent,
            whatsSet: document.getElementById("pa-counts").textContent,
            text: document.body.textContent,
          }));
        const t = await read();
        expect(!t.hidden, "the kinds section is hidden");
        expect(t.head.join("|") === "Kind|Response|Words|Formats", `headings: ${t.head}`);
        const want = [
          ["Matter number", "Ask before sending", "0", "2"],
          ["Client name", "Ask before sending", "2", "0"],
          ["Case code", "Warn", "0", "1, with nearby words"],
        ];
        expect(JSON.stringify(t.rows) === JSON.stringify(want), `rows: ${JSON.stringify(t.rows)}`);
        expect(t.covers.includes("[Matter 1], [Client 1], [Case 1]"), `cover names: ${t.covers}`);
        expect(!/globex|initech|MAT-|M-@@|@@-####/i.test(t.text), "a kind's words or formats are on the page");
        expect(!/team_/.test(t.text), "a kind's id is on the page");
        expect(!/Matter number|Client name/.test(t.whatsSet), "the kinds are listed twice (in What's set too)");
        // The watch words checkbox shows watch words only, never a kind's words.
        await page.click("#pa-show-words");
        await sleep(100);
        expect(!/globex|initech/i.test((await read()).text), "the checkbox showed a kind's words");
        await page.click("#pa-show-words");
        for (const [width, theme] of [
          [380, "dark"],
          [380, "light"],
          [700, "dark"],
          [700, "light"],
        ]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await page.setViewport({ width, height: 900 });
          await sleep(200);
          const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          expect(!wide, `the page scrolls sideways at ${width} px`);
          await page.screenshot({ path: path.join(OUT, `policy-kinds-${width}-${theme}.png`), fullPage: true });
        }
        const a11y = await axeProblems(page);
        expect(!a11y.length, a11y.slice(0, 4).join(" | "));
      } finally {
        await page.close();
      }
      // With no kinds in the policy, the section shouldn't show at all.
      const plain = await openPolicyPage({ preset: "clinic" });
      try {
        expect(await plain.evaluate(() => document.getElementById("pa-kinds").hidden), "a kinds section with no kinds");
      } finally {
        await plain.close();
      }
    },
  );

  await check(
    "TK3",
    "The popup's How Clotr responds shows the team's own kinds as locked rows set by the organization, in simple mode too",
    async () => {
      await resetState(ctx, { team_case_code: "log" }); // the person's own Just count, under the team's Warn
      const popup = await ctx.browser.newPage();
      popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
      await popup.evaluateOnNewDocument((p) => {
        chrome.storage.managed.get = async () => p;
      }, RIVERSIDE);
      await popup.setViewport({ width: 380, height: 700 });
      await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
      await popup.waitForSelector("#hero-value");
      await sleep(400);
      try {
        await popup.click("#tab-settings");
        await sleep(300);
        const g = await popup.evaluate(() => {
          const group = document.querySelector('.resp-group[data-group="team"]');
          return (
            group && {
              visible: group.getClientRects().length > 0,
              head: group.querySelector(".head").textContent,
              rows: [...group.querySelectorAll("select[data-pattern]")].map((s) => ({
                id: s.dataset.pattern,
                value: s.value,
                disabled: s.disabled,
                title: s.title,
                label: s.getAttribute("aria-label"),
              })),
              names: [...group.querySelectorAll("li")].map((li) => li.textContent),
            }
          );
        });
        expect(g?.visible, `no visible team kinds group in simple mode: ${JSON.stringify(g)}`);
        expect(/Kinds your organization added/.test(g.head) && /Set by your organization/.test(g.head), g.head);
        expect(
          JSON.stringify(g.rows.map((r) => [r.id, r.value, r.disabled])) ===
            JSON.stringify([
              ["team_matter_number", "block", true],
              ["team_client_name", "block", true],
              ["team_case_code", "warn", true],
            ]),
          `rows: ${JSON.stringify(g.rows)}`,
        );
        expect(
          g.rows.every((r) => /Set by your organization/.test(r.title)),
          "a row doesn't say who set it",
        );
        expect(g.rows[0].label === "Response for Matter number", `label: ${g.rows[0].label}`);
        expect(g.names[2].startsWith("Case code"), `names: ${g.names}`);
        await popup.$eval('.resp-group[data-group="team"] details', (d) => (d.open = true));
        await popup.$eval('.resp-group[data-group="team"]', (el) => el.scrollIntoView());
        for (const theme of ["dark", "light"]) {
          await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(200);
          await popup.screenshot({ path: path.join(OUT, `popup-team-kinds-${theme}.png`) });
        }
        const a11y = await axeProblems(popup);
        expect(!a11y.length, a11y.slice(0, 4).join(" | "));
      } finally {
        await popup.close();
        await resetState(ctx);
      }
      // With no team kinds set, that group shouldn't appear at all.
      const plain = await openPopup(ctx);
      try {
        await plain.click("#tab-settings");
        await sleep(200);
        expect(!(await plain.$('.resp-group[data-group="team"]')), "a team kinds group with no policy");
      } finally {
        await plain.close();
      }
    },
  );

  // These reply checks use your own phone number, fingerprinted with this profile's salt, the same way the vault
  // page would.
  const ownPhoneVault = async () => {
    const fp = await ctx.worker.evaluate(async () =>
      globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "555-555-0147"),
    );
    await store.set(ctx, {
      events: [],
      responses: {},
      guided: ALL_GUIDED,
      vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: Date.now() }],
    });
  };
  const replyNote = async (page, ms = 6000) =>
    waitFor(async () => {
      const n = await readNotice(page);
      return n && /reply mentions/i.test(n.text) ? n : null;
    }, ms);

  await check(
    "RP1",
    "Reply check: the AI's reply mentions your own phone number that you didn't type here: a note says so",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "hello, can you help me plan a trip?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sure! I'll text the plan to (555) 555-0147 like last time."));
          const n = await replyNote(page);
          expect(
            n && /Phone Number/.test(n.text) && /memory|earlier/i.test(n.text),
            `note: ${JSON.stringify(await readNotice(page))}`,
          );
          expect(!/555-0147/.test(n.text), "the note shows the number itself");
          await shot(page, "reply-note.png");
          // The mind map should record the kind and fingerprint in `mentions`, never the text itself, and this
          // shouldn't go into history since it wasn't found in your own message. The background stores it a
          // moment after the note shows, so I wait for it instead of reading once, since a single read failed
          // once on a busy PC.
          await waitFor(async () => ((await store.get(ctx, "mentions")).mentions?.length ? true : null), 4000);
          const { mentions = [], events = [] } = await store.get(ctx, ["mentions", "events"]);
          expect(
            mentions.length === 1 &&
              mentions[0].type === "phone_number" &&
              mentions[0].action === "mentioned" &&
              /^[0-9a-f]{16}$/.test(mentions[0].fp),
            `mentions: ${JSON.stringify(mentions)}`,
          );
          expect(!JSON.stringify(mentions).includes("555"), "the number itself was stored");
          expect(events.length === 0, `a reply mention went into history: ${JSON.stringify(events)}`);
        } finally {
          await store.set(ctx, { vault: [], mentions: [] });
        }
      }),
  );

  await check("RP6", "Reply check switched off in Settings: no note and nothing recorded", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      await store.set(ctx, { replyCheck: false, mentions: [] });
      await sleep(400); // the tab hears about the change
      try {
        await typeText(page, "hello, can you help me plan a trip?");
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Sure! I'll text the plan to (555) 555-0147 like last time."));
        expect(!(await replyNote(page, 5000)), "a note although the reply check is off");
        const { mentions = [] } = await store.get(ctx, "mentions");
        expect(mentions.length === 0, `recorded although off: ${JSON.stringify(mentions)}`);
      } finally {
        await store.set(ctx, { vault: [], replyCheck: true });
      }
    }),
  );

  await check(
    "RP7",
    "Reply check switched off while a reply is on its way: that reply isn't read either (no note, nothing recorded)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        await store.set(ctx, { replyCheck: true, mentions: [] });
        try {
          await typeText(page, "hello, can you help me plan a trip?");
          await pressEnter(page); // the reply window opens
          await sleep(300);
          await store.set(ctx, { replyCheck: false }); // switched off in Settings right after sending
          await sleep(600);
          await page.evaluate(() => window.__reply("Sure! I'll text the plan to (555) 555-0147 like last time."));
          expect(!(await replyNote(page, 5000)), "a note after the reply check was switched off");
          const { mentions = [] } = await store.get(ctx, "mentions");
          expect(mentions.length === 0, `recorded after it was switched off: ${JSON.stringify(mentions)}`);
        } finally {
          await store.set(ctx, { vault: [], replyCheck: true, mentions: [] });
        }
      }),
  );

  await check("RP2", "Reply check: the AI repeating a detail you typed on this page is expected: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "my number is 555-555-0147");
        await sleep(700);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Got it, I'll use 555-555-0147."));
        expect(!(await replyNote(page, 2500)), "a note for a number the user typed here");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check("RP3", "Reply check: someone else's number in a reply isn't yours: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "what's the museum's number?");
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("You can call the museum at 212-555-0199."));
        expect(!(await replyNote(page, 2500)), "a note for a number that isn't in the vault");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check(
    "RP5",
    "Reply check: one check per message you send, once the reply is quiet, so a page can't test guess after guess",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "what's the weather tomorrow?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sunny, around 70 degrees."));
          await sleep(4500); // the reply is quiet now, so its one check is already done
          await page.evaluate(() => window.__reply("Is it 555-555-0147?"));
          expect(!(await replyNote(page, 4000)), "a second check in the same reply window");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check(
    "RP4",
    "Reply check: opening an old conversation (text appears with no message sent) never triggers a note",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await page.evaluate(() => window.__reply("Earlier you said: call me at 555-555-0147"));
          expect(!(await replyNote(page, 2500)), "a note for history loaded without a send");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check("ES1", "Spanish browser: the warning, its buttons and the kind of data are in Spanish", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const page = await openSite(es, "chatgpt");
      await es.worker.evaluate(() => chrome.storage.local.set({ guided: { aws_access_key: 1, phone_number: 1 } }));
      await sleep(400);
      await typeText(page, `mi clave es ${KEY}`);
      const n = await waitFor(() => readNotice(page), 5000);
      const buttons = (n?.buttons || []).map((b) => b.text);
      await shot(page, "notice-es.png");
      expect(n && /Atención/.test(n.text) && /Clave de acceso de AWS/.test(n.text), `notice: ${n?.text}`);
      expect(buttons.includes("Ocultarlo") && buttons.includes("Dejarlo"), `buttons: ${buttons.join(" | ")}`);
      await page.close();
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  await check("ES2", "Spanish browser: the popup's tabs, summary and settings are in Spanish", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await es.worker.evaluate(() =>
        chrome.storage.local.set({
          events: [
            {
              t: Date.now() - 60000,
              site: "chatgpt.com",
              type: "email",
              name: "Email Address",
              severity: "low",
              action: "redacted",
              fp: "aaaaaaaaaaaaaaa1",
            },
          ],
          lastUpdate: { from: "0.8.0", to: chrome.runtime.getManifest().version, t: Date.now(), seen: false },
        }),
      );
      const popup = await openPopup(es);
      await sleep(400);
      const got = await popup.evaluate(() => ({
        tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
        hero: document.getElementById("hero-label").textContent,
        byType: document.getElementById("by-type").textContent,
        lang: document.documentElement.lang,
        whatsNew: document.getElementById("whats-new-list").textContent,
      }));
      await popup.click("#tab-settings");
      await sleep(200);
      const settings = await popup.evaluate(() =>
        document.getElementById("panel-settings").textContent.replace(/\s+/g, " "),
      );
      await shot(popup, "popup-es.png");
      await popup.close();
      expect(got.tabs.join("|") === "Resumen|Actividad|Ajustes", `tabs: ${got.tabs}`);
      expect(
        /fuga evitada/.test(got.hero) && /Dirección de correo electrónico/.test(got.byType),
        `hero: ${got.hero}; by type: ${got.byType}`,
      );
      expect(got.lang === "es", `lang: ${got.lang}`);
      // I read the current series' notes straight from changelog.json, so this check follows along with every
      // version. An earlier version had the first Spanish line of 0.9 hardcoded, and 1.0 broke when that changed.
      const log = JSON.parse(fs.readFileSync(`${EXT}/changelog.json`, "utf8"));
      const { version } = JSON.parse(fs.readFileSync(`${EXT}/manifest.json`, "utf8"));
      const minor = version.split(".").slice(0, 2).join(".");
      expect(
        got.whatsNew.includes(log.translations.es[minor][0]) && !got.whatsNew.includes(log[minor][0]),
        `what's new isn't in Spanish: ${got.whatsNew.slice(0, 120)}`,
      );
      expect(/Cómo responde Clotr/.test(settings) && /Tu caja fuerte/.test(settings), `settings: ${settings}`);
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  // Spanish kind names run long, like "Número de la Seguridad Social de EE. UU.". In Settings they should wrap
  // between words, never in the middle of one like "Segurid / ad".
  await check(
    "DG1",
    "Spanish browser: Settings' kind names wrap between words, never mid-word, light and dark",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        await es.worker.evaluate(() => chrome.storage.local.set({ advanced: true }));
        const popup = await openPopup(es);
        await popup.click("#tab-settings");
        await sleep(300);
        // For every word in every group and kind name, I check whether it stays in one box or breaks into two
        // across lines.
        const broken = await popup.evaluate(() => {
          for (const d of document.querySelectorAll(".resp-group details")) d.open = true;
          const out = [];
          for (const el of document.querySelectorAll("#responses .grow")) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const m of node.data.matchAll(/\S+/g)) {
                const range = document.createRange();
                range.setStart(node, m.index);
                range.setEnd(node, m.index + m[0].length);
                if (range.getClientRects().length > 1) out.push(m[0]);
              }
            }
          }
          return { out, rows: document.querySelectorAll("#responses .list li").length };
        });
        // I screenshot the popup at its real size, starting from the personal group, dark theme first, then
        // the whole tab.
        await popup.setViewport({ width: 380, height: 600 });
        await popup.evaluate(() => document.querySelector('select[data-group="personal"]').scrollIntoView());
        for (const theme of ["dark", "light"]) {
          await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(200);
          await popup.screenshot({ path: path.join(OUT, `popup-kinds-es-${theme}.png`) });
        }
        await popup.evaluate(() => document.getElementById("responses").scrollIntoView());
        await shot(popup, "popup-kinds-es-full-dark.png", "dark");
        await popup.close();
        expect(broken.rows > 20, `kind rows: ${broken.rows}`);
        expect(!broken.out.length, `words broken mid-word: ${broken.out.join(", ")}`);
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check(
    "ES3",
    'Spanish browser: welcome page (with its practice box), full report and "What Clotr stores" are in Spanish',
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const welcome = await openExtPage(es, "vault.html?welcome=1");
        await welcome.type("#try", "llámame al cinco cinco cinco cinco cinco cinco cero uno cuatro siete");
        await sleep(700);
        const w = await welcome.evaluate(() => ({
          title: document.getElementById("page-title").textContent,
          tryResult: document.getElementById("try-result").textContent,
          lang: document.documentElement.lang,
        }));
        await shot(welcome, "welcome-es.png");
        await welcome.close();
        await es.worker.evaluate(() =>
          chrome.storage.local.set({
            events: [
              {
                t: Date.now(),
                site: "chatgpt.com",
                type: "phone_number",
                name: "Phone Number",
                severity: "medium",
                action: "allowed",
                fp: "00000000000000aa",
              },
            ],
          }),
        );
        const dash = await openExtPage(es, "dashboard.html");
        await dash.waitForSelector("#map [data-you]", { timeout: 5000 }).catch(() => {});
        const d = await dash.evaluate(
          () => document.querySelector("h1").textContent + " | " + document.getElementById("since").textContent,
        );
        const you = await dash.evaluate(() => document.querySelector("#map [data-you]")?.textContent || "");
        await dash.setViewport({ width: 900, height: 1400 });
        await shot(dash, "dashboard-es.png");
        await dash.close();
        const stored = await openExtPage(es, "stored.html");
        await sleep(300);
        const s = await stored.evaluate(
          () =>
            document.querySelector("h1").textContent +
            " | " +
            document.getElementById("reach").textContent.replace(/\s+/g, " "),
        );
        await stored.close();
        expect(
          /bienvenida/.test(w.title) && /Número de teléfono/.test(w.tryResult) && w.lang === "es",
          `welcome: ${JSON.stringify(w)}`,
        );
        expect(/Tu informe de exposición/.test(d), `report: ${d}`);
        expect(you === "Tú", `the map's middle says "${you}", not "Tú"`);
        expect(/Qué guarda Clotr/.test(s) && /sitios de chat de IA/.test(s), `stored: ${s.slice(0, 200)}`);
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // This reads the mind map's nodes as branch/type/key:count, sorted. It waits for the map to stop moving, since
  // it glides between drawings, before listing them.
  const mindNodes = async (page, root = "#map") => {
    await page
      .waitForFunction((r) => !("moving" in (document.querySelector(r)?.dataset || {})), { timeout: 3000 }, root)
      .catch(() => {});
    return page.evaluate(
      (root) =>
        [...document.querySelectorAll(`${root} .mind-node`)]
          .filter((n) => n.dataset.nodeType !== "leaf")
          .map(
            (n) =>
              `${n.dataset.branch}/${n.dataset.nodeType}/${n.dataset.service || n.dataset.kind || ""}:${n.dataset.count}`,
          )
          .sort(),
      root,
    );
  };

  await check(
    "MAP1",
    "Mind map: you in the middle, four branches (already has, near misses, not shared yet, blind spots), counts per AI service, and a table view",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const nodes = await mindNodes(page);
        const got = await page.evaluate(() => ({
          you: Boolean(document.querySelector("#map [data-you]")),
          branches: [...document.querySelectorAll('#map [data-node-type="branch"]')].map((n) => n.dataset.branch),
          rows: [...document.querySelectorAll("#map-table tbody tr")].map(
            (r) => r.cells[0].textContent + ": " + r.cells[1].textContent,
          ),
          labels: [...document.querySelectorAll('#map [data-branch="has"][data-service]')].map((n) =>
            n.getAttribute("aria-label"),
          ),
        }));
        await shot(page, "dashboard-map.png");
        await mindNodes(page); // taking a screenshot resizes the page, and that redraws and moves the map
        const fit = await page.evaluate(() => {
          const svg = document.getElementById("map");
          const content = svg.getBBox(),
            vb = svg.viewBox.baseVal;
          return {
            emptyBelow: Math.round(vb.y + vb.height - (content.y + content.height)),
            emptyAbove: Math.round(content.y - vb.y),
            cutLeft: Math.round(vb.x - content.x),
            cutRight: Math.round(content.x + content.width - (vb.x + vb.width)),
          };
        });
        expect(fit.emptyBelow < 40 && fit.emptyAbove < 40, `map leaves empty space: ${JSON.stringify(fit)}`);
        expect(fit.cutLeft <= 2 && fit.cutRight <= 2, `labels cut off at the sides: ${JSON.stringify(fit)}`);
        expect(got.you, "no 'You' node");
        expect(got.branches.join(",") === "has,near,open,blind", `branches: ${got.branches}`);
        for (const want of [
          "has/branch/:3",
          "has/service/chatgpt.com:4",
          "has/service/claude.ai:3",
          "has/service/gemini.google.com:1",
          "near/branch/:1",
          "near/service/chatgpt.com:1",
          "open/branch/:0",
          "blind/branch/:0",
          "blind/cant-see/:0",
        ])
          expect(nodes.includes(want), `missing ${want} in ${JSON.stringify(nodes)}`);
        expect(
          got.rows.join(" | ") ===
            "Already has: chatgpt.com | Already has: claude.ai | Already has: gemini.google.com | Near misses: chatgpt.com | Blind spots: Clotr can't see",
          `table: ${got.rows.join(" | ")}`,
        );
        expect(
          got.labels.every((l) => / has: /.test(l) && /riskiest/i.test(l)),
          `labels: ${JSON.stringify(got.labels)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "MAP2",
    "Mind map: choosing an AI service (keyboard) shows which kinds it has, and a branch explains itself; never values or fingerprints",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const choose = async (selector) => {
          const focused = await page.evaluate((sel) => {
            const n = document.querySelector(sel);
            n?.focus();
            return Boolean(n) && document.activeElement === n;
          }, selector);
          expect(focused, `${selector} can't take keyboard focus`);
          await page.keyboard.press("Enter");
          await sleep(200);
          return page.$eval("#map-details", (n) => n.innerText);
        };
        const has = await choose('#map [data-branch="has"][data-service="chatgpt.com"]');
        expect(
          /chatgpt\.com has/.test(has) &&
            /Phone Number ×2/.test(has) &&
            /Email Address/.test(has) &&
            /AWS Access Key/.test(has),
          `details: ${has}`,
        );
        const near = await choose('#map [data-branch="near"][data-service="chatgpt.com"]');
        expect(/stopped on chatgpt\.com: Street Address/.test(near), `near miss: ${near}`);
        const blind = await choose('#map [data-node-type="branch"][data-branch="blind"]');
        expect(/can't protect you/.test(blind), `blind spots: ${blind}`);
        expect(
          !/aaaaaaaaaaaaaaa1|ccccccccccccccc3/.test(await page.evaluate(() => document.body.innerText)),
          "fingerprints shown",
        );
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP3",
    "Popup Overview: a small mind map (branches with something in them) that opens the full report",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const popup = await openPopup(ctx);
      try {
        const nodes = await mindNodes(popup, "#mini-map");
        await shot(popup, "popup-map.png");
        expect(
          JSON.stringify(nodes) ===
            JSON.stringify([
              "has/branch/:3",
              "has/service/chatgpt.com:4",
              "has/service/claude.ai:3",
              "has/service/gemini.google.com:1",
              "near/branch/:1",
              "near/service/chatgpt.com:1",
            ]),
          `mini map: ${JSON.stringify(nodes)}`,
        );
        await popup.click("#mini-map-open");
        const opened = await waitFor(
          async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
          3000,
        );
        expect(opened, "full report didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP4",
    'Mind map: "By kind of detail" regroups every branch by kind, and the choice is remembered',
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        await page.click('#map-view [data-view="kind"]');
        await sleep(300);
        let nodes = await mindNodes(page);
        for (const want of ["has/kind/phone_number:3", "has/kind/password:1", "near/kind/street_address:1"])
          expect(nodes.includes(want), `by kind: missing ${want} in ${JSON.stringify(nodes)}`);
        expect(!nodes.some((n) => n.startsWith("has/service/")), "services left in the by-kind view");
        await shot(page, "dashboard-map-kind.png");
        await page.reload();
        nodes = await waitFor(async () => {
          const n = await mindNodes(page);
          return n.some((x) => x.startsWith("has/")) ? n : null;
        }, 3000);
        const saved = await page.evaluate(() => localStorage.getItem("clotr.mapView"));
        expect(
          nodes?.includes("has/kind/phone_number:3"),
          `the by-kind choice wasn't remembered (saved: ${saved}; nodes: ${JSON.stringify(nodes)}; errors: ${ctx.problems.slice(-3).join(" / ")})`,
        );
        const checked = await page.$eval('#map-view [data-view="kind"]', (b) => b.getAttribute("aria-checked"));
        expect(checked === "true", `toggle state: ${checked}`);
        await page.click('#map-view [data-view="service"]');
        await sleep(300);
        expect((await mindNodes(page)).includes("has/service/chatgpt.com:4"), "couldn't switch back");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP5",
    'Mind map: vault details no AI has seen are "not shared yet"; spotted AI tools Clotr doesn\'t protect are blind spots (protected ones never are)',
    async () => {
      const vault = [
        { kind: "value", type: "phone_number", fp: "aaaaaaaaaaaaaaa1", mode: "protect", added: 1 }, // was sent
        { kind: "value", type: "street_address", fp: "ddddddddddddddd4", mode: "protect", added: 1 }, // only hidden
        { kind: "value", type: "email", fp: "1234567890abcdef", mode: "allow", added: 1 }, // fine to share
        { kind: "word", type: "my_name", fp: "fedcba0987654321", words: 2, added: 1 }, // never sent
      ];
      await store.set(ctx, {
        events: dashEvents(),
        mentions: [],
        vault,
        spotted: { "chat.newtool.ai": true, "chatgpt.com": true },
      });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const nodes = await mindNodes(page);
        for (const want of [
          "open/branch/:2",
          "open/kind/street_address:1",
          "open/kind/my_name:1",
          "blind/branch/:1",
          "blind/service/chat.newtool.ai:0",
        ])
          expect(nodes.includes(want), `missing ${want} in ${JSON.stringify(nodes)}`);
        expect(!nodes.includes("open/kind/phone_number:1"), "a phone number that was sent is listed as not shared");
        expect(!nodes.some((n) => n.startsWith("open/kind/email")), "a fine-to-share detail is listed as at risk");
        expect(!nodes.includes("blind/service/chatgpt.com:0"), "a protected built-in site is listed as a blind spot");
        const rows = await page.$$eval("#map-table tbody tr", (r) => r.map((x) => x.textContent));
        expect(
          rows.some((r) => /Blind spots.*Clotr can't see.*AI apps on your computer/.test(r)),
          `rows: ${rows.join(" | ")}`,
        );
        await shot(page, "dashboard-map-full.png");
        await page.setViewport({ width: 1100, height: 1000 });
        await sleep(400);
        await mindNodes(page);
        const mapBox = await page.$("#map");
        await mapBox.screenshot({ path: path.join(OUT, "dashboard-map-wide.png") });
      } finally {
        await page.close();
        await store.set(ctx, { events: [], vault: [], spotted: {} });
      }
    },
  );

  await check("DSH5", 'Full dashboard: "Keep history for" 3 months removes older records right away', async () => {
    await store.set(ctx, {
      events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(100, "aaaaaaaaaaaaaaa2"), aged(1, "aaaaaaaaaaaaaaa3")],
      keepDays: 365,
    });
    const page = await openExtPage(ctx, "dashboard.html");
    try {
      await sleep(400);
      expect((await page.$eval("#keep-days", (s) => s.value)) === "365", "setting doesn't show 1 year");
      await page.select("#keep-days", "90");
      const left = await waitFor(async () => {
        const ev = await store.events(ctx);
        return ev.length === 1 ? ev : null;
      }, 3000);
      expect(left && left[0].fp === "aaaaaaaaaaaaaaa3", `events left: ${JSON.stringify(await store.events(ctx))}`);
      expect((await store.get(ctx, "keepDays")).keepDays === 90, "setting not stored");
    } finally {
      await page.close();
      await store.set(ctx, { events: [], keepDays: 365 });
    }
  });

  await check("DSH6", "History keeps 1 year by default: older records go when the next one is written", async () => {
    await ctx.worker.evaluate(() => chrome.storage.local.remove("keepDays"));
    await store.set(ctx, { events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(300, "aaaaaaaaaaaaaaa2")] });
    await ctx.worker.evaluate((e) => enqueue(() => appendEvents([e])), aged(0, "aaaaaaaaaaaaaaa3"));
    const ev = await store.events(ctx);
    expect(ev.map((e) => e.fp).join() === "aaaaaaaaaaaaaaa2,aaaaaaaaaaaaaaa3", `events: ${ev.map((e) => e.fp).join()}`);
    await store.set(ctx, { events: [] });
  });

  // This checks that the 10,000-record cap removes records the keep period would otherwise still keep. The
  // `old` records sit 100 to 120 days back, so a 3-month setting would remove them, and the rest sit in the last
  // week. The `extra` new records then go through the background's own appendEvents(), the same way a real
  // detection would add one.
  async function fillHistory({ old = 0, extra = 3 } = {}) {
    const now = Date.now();
    const at = (i) => (i < old ? now - (120 - (20 * i) / old) * DAY_MS : now - DAY_MS - (10000 - i) * 30000);
    const full = Array.from({ length: 10000 }, (_, i) => ({
      t: Math.round(at(i)),
      site: "chatgpt.com",
      type: "email",
      name: "Email Address",
      severity: "low",
      action: "allowed",
      fp: (i % 4096).toString(16).padStart(16, "0"),
    }));
    await ctx.worker.evaluate(() => chrome.storage.local.remove(["keepDays", "historyFull"]));
    await store.set(ctx, { events: full });
    expect(!(await store.get(ctx, "historyFull")).historyFull, "the note was there before the history was full");
    const fresh = Array.from({ length: extra }, (_, i) => ({ ...aged(0, `bbbbbbbbbbbbbbb${i}`), t: now - i }));
    await ctx.worker.evaluate((e) => enqueue(() => appendEvents(e)), fresh);
    return { full, ...(await store.get(ctx, ["historyFull", "events"])) };
  }
  const noteText = (page) =>
    page.evaluate(() => {
      const n = document.getElementById("history-full");
      return n && !n.hidden ? n.innerText : null;
    });

  await check(
    "HIS1",
    "History full: the full report says so with the date; its Tell us link carries only a title, the version and the browser",
    async () => {
      const { full, historyFull, events } = await fillHistory();
      expect(events.length === 10000, `history has ${events.length} records`);
      expect(
        historyFull &&
          Object.keys(historyFull).sort().join() === "before,t" &&
          historyFull.before === full[3].t &&
          Math.abs(historyFull.t - Date.now()) < 60000,
        `historyFull: ${JSON.stringify(historyFull)}`,
      );
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        const note = await waitFor(() => noteText(page), 4000);
        const date = await page.evaluate(
          (t) => new Intl.DateTimeFormat([], { dateStyle: "long" }).format(t),
          full[3].t,
        );
        expect(
          /Your history is full/.test(note || "") &&
            note.includes(date) &&
            /10,000 records/.test(note) &&
            /1\u2011year setting/.test(note),
          `note: ${note}`,
        );
        const href = await page.$eval("#history-full-tell", (a) => a.href);
        const url = new URL(href);
        expect(url.origin + url.pathname === "https://github.com/clotr-app/clotr/issues/new", `address: ${href}`);
        expect(
          [...url.searchParams.keys()].sort().join() === "browser,template,title,version",
          `fields: ${[...url.searchParams.keys()]}`,
        );
        expect(url.searchParams.get("template") === "bug.yml", `form: ${url.searchParams.get("template")}`);
        expect(
          url.searchParams.get("title") === "History full (10,000 records)",
          `title: ${url.searchParams.get("title")}`,
        );
        // The link should never carry the history itself: no site, kind, fingerprint, count or date.
        const said = decodeURIComponent(href.replace(/\+/g, " "));
        expect(
          !/chatgpt|email|0000000000000|bbbbbbbb|10000|\b20\d\d-\d\d/i.test(said),
          `address says too much: ${said}`,
        );
        expect(
          (await page.$eval("#history-full-tell", (a) => a.target === "_blank" && /noopener/.test(a.rel))) === true,
          "Tell us doesn't open a new tab safely",
        );
        const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
        const problems = [];
        const section = await page.$("section[aria-labelledby='h-data']");
        for (const theme of ["dark", "light"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
          );
          problems.push(...found.map((f) => `${theme}: ${f}`));
          for (const width of [380, 1040]) {
            await page.setViewport({ width, height: 900 });
            await sleep(400);
            await section.scrollIntoView();
            await section.screenshot({ path: path.join(OUT, `history-full-${theme}-${width}.png`) });
          }
        }
        expect(!problems.length, problems.slice(0, 4).join(" | "));
        // "What Clotr stores" shows the note's two dates, and says that's all it keeps.
        const stored = await openExtPage(ctx, "stored.html");
        try {
          const other = await waitFor(
            () => stored.$eval("#other", (n) => (/History full/.test(n.innerText) ? n.innerText : null)),
            3000,
          );
          expect(/Only these two dates are kept/.test(other || ""), `What Clotr stores: ${other}`);
        } finally {
          await stored.close();
        }
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "HIS2",
    "History full: the note goes with Delete my history, with Clear history, and once the history is under 9,000 records",
    async () => {
      const gone = () => waitFor(async () => ((await store.get(ctx, "historyFull")).historyFull ? null : true), 4000);
      try {
        // Clicking Delete my history in the full report should drop the note right away, with no reload needed.
        expect((await fillHistory()).historyFull, "no note after the cap removed records");
        const page = await openExtPage(ctx, "dashboard.html");
        try {
          expect(await waitFor(() => noteText(page), 4000), "no note in the report");
          await page.click("#delete-history");
          await page.click("#delete-history");
          expect(await gone(), "Delete my history left the note in storage");
          expect(await waitFor(async () => ((await noteText(page)) === null ? true : null), 3000), "note still shown");
        } finally {
          await page.close();
        }
        // Clear history (the popup).
        expect((await fillHistory()).historyFull, "no note after the cap removed records (2)");
        const popup = await openPopup(ctx);
        try {
          await popup.$eval("#clear", (b) => b.click());
          await popup.$eval("#clear", (b) => b.click());
          expect(await gone(), "Clear history left the note in storage");
        } finally {
          await popup.close();
        }
        // A shorter keep period that brings the history under 9,000 records.
        const filled = await fillHistory({ old: 2000, extra: 1 });
        expect(filled.historyFull, "no note after the cap removed records (3)");
        await store.set(ctx, { keepDays: 90 });
        const left = await waitFor(async () => {
          const ev = await store.events(ctx);
          return ev.length < 9000 ? ev : null;
        }, 4000);
        expect(left?.length === 8001, `records left: ${left?.length}`); // the 8,000 recent ones and the new one
        expect(await gone(), "the note stayed with the history under 9,000 records");
        // A history that fills again brings it back.
        expect((await fillHistory()).historyFull, "no note when the history filled again");
      } finally {
        await store.set(ctx, { events: [], keepDays: 365 });
        expect(await gone(), "the note outlived the test's own history reset");
      }
    },
  );

  // Past the first 10 records of one kind and outcome sent in a single go, Clotr folds the rest into one record
  // with a count. That way a pasted list of hundreds of values doesn't push a year of history out of the
  // 10,000-record cap.
  const listOf = (n, at) => Array.from({ length: n }, (_, i) => `m${at + i}.rivera@northwind-mail.net`);
  await check(
    "HIS3",
    "A long list sent at once: 300 emails are 11 records (10, and one for 290); the popup counts 300 and Activity says 290 more in one go",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        try {
          await typeText(page, `Please sort these by surname: ${listOf(300, 0).join(", ")}`);
          const notice = await waitFor(() => readNotice(page), 8000);
          expect(/Email Address/.test(notice?.text || ""), `notice: ${notice?.text}`);
          await clickDialogButton(page, "Leave it in", readNotice);
          await pressEnter(page);
          const events = await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length && ev.every((e) => e.action === "allowed") ? ev : null;
          }, 5000);
          expect(events?.length === 11, `records: ${events?.length}`);
          const folded = events.filter((e) => "n" in e);
          expect(
            folded.length === 1 && folded[0].n === 290 && folded[0].fp === "" && folded[0].type === "email",
            `the folded record: ${JSON.stringify(folded)}`,
          );
          expect(
            events.filter((e) => !("n" in e)).every((e) => /^[0-9a-f]{16}$/.test(e.fp)),
            "the first ten lost their fingerprints",
          );
          const popup = await openPopup(ctx);
          try {
            const hero = await popup.$eval("#hero-sub", (n) => n.textContent);
            expect(/^300 found · 300 sent · 0 just counted$/.test(hero), `Overview: ${hero}`);
            const legend = await popup.$$eval("#legend span", (els) => els.map((e) => e.textContent).join("|"));
            expect(legend === "Hidden0|Sent300|Just counted0", `legend: ${legend}`);
            await popup.click("#tab-activity");
            await sleep(300);
            const more = await popup.$$eval("#events-body .more", (els) => els.map((e) => [e.textContent, e.title]));
            expect(
              more.length === 1 &&
                more[0][0] === "290 more in one go" &&
                /One record for the rest of a long list sent at once/.test(more[0][1]),
              `Activity: ${JSON.stringify(more)}`,
            );
            const rows = await popup.$$eval("#events-body tr", (trs) => trs.length);
            expect(rows === 11, `Activity rows: ${rows}`);
            for (const theme of ["dark", "light"]) {
              await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
              await sleep(200);
              const table = await popup.$("#panel-activity");
              await table.screenshot({ path: path.join(OUT, `long-list-activity-${theme}.png`) });
            }
          } finally {
            await popup.close();
          }
        } finally {
          await store.set(ctx, { events: [] });
        }
      }),
  );

  await check(
    "HIS4",
    "A long list sent at once: the report's totals, weeks, card and risky list count it all; profile and repeats skip it; the export has the count",
    async () => {
      // I send 300 emails and 15 card numbers in one go, through the background's own write path.
      const t = Date.now() - 60000;
      const sent = (type, name, severity, i) => ({
        t,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action: "allowed",
        fp: (i + 1).toString(16).padStart(16, "0"),
      });
      const batch = [
        ...Array.from({ length: 300 }, (_, i) => sent("email", "Email Address", "low", i)),
        ...Array.from({ length: 15 }, (_, i) => sent("credit_card", "Credit Card Number", "high", 1000 + i)),
      ];
      await store.set(ctx, { events: [] });
      await ctx.worker.evaluate((e) => enqueue(() => appendEvents(e)), batch);
      const events = await store.events(ctx);
      expect(events.length === 22, `records: ${events.length}`);
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        const totals = await waitFor(
          () => page.$$eval("#totals .stat b", (els) => (els.length ? els.map((e) => e.textContent).join() : null)),
          3000,
        );
        expect(totals === "315,0,315,0", `totals (found, hidden, sent, just counted): ${totals}`);
        const week = await page.$eval("#weeks-table tbody tr:last-child", (tr) =>
          [...tr.cells].slice(1).map((c) => c.textContent),
        );
        expect(week.join() === "0,315,0", `this week: ${week}`);
        const card = await page.$eval("#card", (n) => n.innerText.replace(/\s+/g, " "));
        expect(/315 private details/.test(card) && /0 hidden, 315 sent anyway/.test(card), `card: ${card}`);
        // Different details and repeated values still need their own fingerprint, so the folded record for the
        // rest isn't counted as if it were one detail sent 290 times.
        const profile = await page.$eval("#exposure .tool", (n) => n.dataset.details);
        expect(profile === "20", `different personal details: ${profile}`);
        const repeats = await page.$eval("#repeats", (n) => n.innerText);
        expect(/Nothing was sent more than once/.test(repeats), `repeats: ${repeats}`);
        const risky = await page.$$eval("#risky .moment", (els) =>
          els.map((e) => e.querySelector(".more")?.textContent || ""),
        );
        expect(
          risky.length === 11 && risky.filter(Boolean).join() === "5 more in one go",
          `risky: ${JSON.stringify(risky)}`,
        );
        await page.click("#export");
        const exported = await page.evaluate(async () => {
          const a = document.getElementById("export-link");
          return a ? (await fetch(a.href)).text() : "";
        });
        const counts = (JSON.parse(exported || "{}").events || []).filter((e) => e.n).map((e) => `${e.type}:${e.n}`);
        expect(counts.sort().join() === "credit_card:5,email:290", `export: ${counts}`);
        // "What Clotr stores" should say that some records stand for a list, and name which ones.
        const stored = await openExtPage(ctx, "stored.html");
        try {
          const line = await waitFor(() => stored.$eval("#history-count", (n) => n.textContent || null), 3000);
          expect(/^22 records \(some stand for a long list sent at once\), from /.test(line || ""), `stores: ${line}`);
          const rows = await stored.$$eval("#history-table tbody tr", (trs) =>
            trs.map((tr) => tr.cells[2].innerText.replace(/\s+/g, " ")).filter((t) => /more in one go/.test(t)),
          );
          expect(
            rows.sort().join("|") === "Credit Card Number 5 more in one go|Email Address 290 more in one go",
            `rows: ${rows.join(" | ")}`,
          );
        } finally {
          await stored.close();
        }
        const section = await page.$("#risky");
        for (const theme of ["dark", "light"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await page.setViewport({ width: 380, height: 900 });
          await sleep(300);
          await section.scrollIntoView();
          await section.screenshot({ path: path.join(OUT, `long-list-risky-${theme}-380.png`) });
        }
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "WD1",
    "Popup: weekly digest compares with last week and says what to do about a risky send",
    async () => {
      const ev = (days, type, name, severity, action) => ({
        t: Date.now() - days * DAY_MS - 60000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp: "aaaaaaaaaaaaaaa1",
      });
      await store.set(ctx, {
        events: [
          ...Array.from({ length: 5 }, () => ev(10, "email", "Email Address", "low", "redacted")),
          ev(3, "email", "Email Address", "low", "redacted"),
          ev(2, "email", "Email Address", "low", "redacted"),
          ev(1, "aws_access_key", "AWS Access Key", "high", "allowed"),
        ],
      });
      const popup = await openPopup(ctx);
      try {
        const text = await popup.$eval("#digest", (n) => (n.hidden ? "" : n.innerText));
        await shot(popup, "popup-digest.png");
        expect(
          /This week: 3 found/.test(text) && /2 hidden/.test(text) && /1 sent anyway/.test(text),
          `digest: ${text}`,
        );
        expect(/fewer than last week \(5\)/.test(text), `no comparison: ${text}`);
        expect(/AWS Access Key/.test(text) && /Turn it off/.test(text), `no advice: ${text}`);
        await popup.click("#digest-open");
        const opened = await waitFor(
          async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
          3000,
        );
        expect(opened, "full report didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check("WD2", "Popup: no digest after a quiet fortnight", async () => {
    await store.set(ctx, {
      events: [
        {
          t: Date.now() - 20 * DAY_MS,
          site: "claude.ai",
          type: "email",
          name: "Email Address",
          severity: "low",
          action: "allowed",
          fp: "aaaaaaaaaaaaaaa1",
        },
      ],
    });
    const popup = await openPopup(ctx);
    try {
      expect(await popup.$eval("#digest", (n) => n.hidden), "digest shown with nothing in two weeks");
    } finally {
      await popup.close();
      await store.set(ctx, { events: [] });
    }
  });

  await check("DSH4", "Popup → Open full report opens the dashboard", async () => {
    const popup = await openPopup(ctx);
    const before = (await ctx.browser.pages()).length;
    await popup.click("#open-dashboard");
    const opened = await waitFor(
      async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
      3000,
    );
    await popup.close();
    expect(opened, `no dashboard tab (tabs before: ${before})`);
    await opened.close();
  });

  await check(
    "SM1",
    'Settings are simple by default; "Show advanced options" reveals per-type, per-site and built-in list',
    async () => {
      await store.set(ctx, { advanced: false, responses: {}, siteModes: {} });
      const shown = (popup) =>
        popup.evaluate(() => {
          const vis = (sel) => {
            const n = document.querySelector(sel);
            return Boolean(n && n.offsetParent !== null);
          };
          return {
            perType: vis(".resp-group details"),
            builtin: vis("details.builtin"),
            groups: vis(".resp-group .head select"),
            inUse: vis("#advanced-in-use"),
          };
        });
      let popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const simple = await shown(popup);
      await shot(popup, "popup-settings-simple.png");
      expect(simple.groups && !simple.perType && !simple.builtin && !simple.inUse, `simple: ${JSON.stringify(simple)}`);
      await popup.click("#advanced");
      await sleep(300);
      const adv = await shown(popup);
      expect(adv.perType && adv.builtin, `advanced: ${JSON.stringify(adv)}`);
      await popup.close();
      expect((await store.get(ctx, "advanced")).advanced === true, "the choice wasn't saved");
      // A hidden per-type choice is announced in simple mode.
      await store.set(ctx, { advanced: false, responses: { email: "block" } });
      popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const note = await shown(popup);
      await popup.close();
      await store.set(ctx, { advanced: false, responses: {} });
      expect(note.inUse, "no note about advanced settings in use");
    },
  );

  await check(
    "ST1",
    '"What Clotr stores" shows every stored record readably, hides the fingerprint secret, and lists the known limits',
    async () => {
      const events = seedEvents();
      await store.set(ctx, {
        events,
        responses: { email: "log" },
        vault: [
          { kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "allow", added: Date.now() },
          { kind: "shape", type: "my_id", shape: "@@-######", added: Date.now() },
        ],
      });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "stored.html");
      try {
        await page.click(".raw summary");
        await sleep(300);
        const got = await page.evaluate(() => ({
          text: document.body.innerText,
          historyRows: document.querySelectorAll("#history-table tbody tr").length,
          vaultRows: document.querySelectorAll("#vault-table tbody tr").length,
          raw: document.getElementById("raw").textContent,
        }));
        await shot(page, "stored.png");
        expect(
          got.historyRows === Math.min(events.length, 100) && got.vaultRows === 2,
          `rows: history ${got.historyRows}/${events.length}, vault ${got.vaultRows}`,
        );
        expect(
          got.text.includes("Email Address: Just count") || got.text.includes("Email address: Just count"),
          "the Log-only setting isn't shown",
        );
        expect(got.text.includes("@@-######") && got.text.includes("OK to share"), "vault items not shown");
        expect(JSON.parse(got.raw).events.length === events.length, "raw view isn't the stored data");
        expect(salt && !got.text.includes(salt) && !got.raw.includes(salt), "the fingerprint secret is shown");
        expect(
          got.text.includes("Known limits") && got.text.includes("can be guessed from their fingerprints"),
          "limits missing",
        );
        for (const v of TYPED_VALUES) expect(!got.text.includes(v), "a typed value appears on the page");
      } finally {
        await page.close();
        await store.set(ctx, { events: [], responses: {}, vault: [] });
      }
    },
  );

  await check(
    "OFF1",
    '"What Clotr stores" → What Clotr can reach: the live no-network policy, a reason for every permission, the AI-site count',
    async () => {
      const page = await openExtPage(ctx, "stored.html");
      try {
        await sleep(300);
        const got = await page.evaluate(() => ({
          policy: document.getElementById("policy")?.textContent || "",
          perms: [...document.querySelectorAll("#permissions [data-permission]")].map((n) => ({
            id: n.dataset.permission,
            why: n.nextElementSibling?.textContent || "",
          })),
          text: document.getElementById("reach")?.innerText || "",
        }));
        const m = await page.evaluate(() => chrome.runtime.getManifest());
        await shot(page, "reach.png");
        expect(
          got.policy === m.content_security_policy.extension_pages && got.policy.includes("connect-src 'self'"),
          `policy: ${got.policy}`,
        );
        const want = [...m.permissions, "AI sites", "Sites you add"];
        expect(
          want.every((p) => got.perms.some((g) => g.id === p && g.why.length > 20)),
          `permissions: ${JSON.stringify(got.perms)}`,
        );
        expect(
          got.text.includes(`${m.host_permissions.length} AI chat sites`),
          `site count: ${got.text.slice(0, 300)}`,
        );
        expect(/SHA256SUMS/.test(got.text), "no rebuild-and-compare instructions");
      } finally {
        await page.close();
      }
    },
  );
};
