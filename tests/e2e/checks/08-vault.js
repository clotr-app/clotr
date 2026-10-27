// E2E checks: V. Your vault ("What should I protect?"). Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    activeBadge,
    DIALOG_WAIT,
    editorText,
    KEY,
    OUT,
    TYPED_VALUES,
    answerOnClotrPage,
    check,
    clearEditor,
    clickDialogButton,
    ctx,
    expect,
    expectNoUI,
    openExtPage,
    openPopup,
    path,
    pressEnter,
    readNotice,
    resetState,
    sentMessages,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  await check("V0", 'First install opens "What should I protect?"', async () => {
    // When this check runs first (--only V), it can start before the install has even opened the tab, so I wait.
    const t = await waitFor(() => ctx.browser.targets().find((x) => x.url().includes("/vault.html?welcome=1")), 5000);
    expect(
      t,
      `targets: ${ctx.browser
        .targets()
        .map((x) => x.url())
        .join(", ")}`,
    );
  });

  const MY = {
    my_name: "Jane Q Doe",
    family_name: "Emma",
    employer: "Initech",
    street_address: "123 Oak Street",
    phone_number: "(555) 555-5636",
    email: "jane.doe@gmail.com",
    my_id: "AB-123456",
    watch_list: "Project Falcon\nEMP-#####",
  };
  await check(
    "W1",
    "First install: welcome explains Clotr in plain words; the practice box warns and redacts, and records nothing",
    async () => {
      await resetState(ctx, {});
      const page = await openExtPage(ctx, "vault.html?welcome=1");
      try {
        const count = await waitFor(() => page.$eval("#ai-site-count-fact", (el) => el.textContent || null), 3000);
        expect(count === "19", `AI chat site count: ${count}`);
        const intro = await page.evaluate(() => ({
          visible: !document.getElementById("welcome").hidden,
          h1: document.querySelector("h1").textContent,
          text: document.getElementById("welcome").innerText,
        }));
        expect(intro.visible && intro.h1 === "Welcome to Clotr", `welcome: ${JSON.stringify(intro).slice(0, 200)}`);
        const pin = await page.evaluate(() => document.getElementById("pin-step")?.innerText || "");
        expect(/puzzle piece/i.test(pin) || /Clotr is pinned/.test(pin), `pin step: ${JSON.stringify(pin)}`);
        for (const fact of [
          `${count} AI chats are on from the start.`,
          "There are no Clotr servers",
          "never saves what you type",
          "checks the AI's replies for 90 seconds after you send",
        ]) {
          expect(intro.text.includes(fact), `missing: "${fact}"`);
        }
        TYPED_VALUES.add(KEY);
        await page.type("#try", `my key ${KEY}`);
        const shown = await waitFor(() => page.evaluate(() => document.querySelector(".try-notice")?.innerText), 3000);
        expect(shown?.includes("AWS Access Key (AKIA…3N)") && !shown.includes(KEY), `practice warning: ${shown}`);
        await shot(page, "welcome.png");
        await page.click(".try-notice .btn");
        const after = await page.$eval("#try", (t) => t.value);
        expect(after.includes("[REDACTED AWS ACCESS KEY]") && !after.includes(KEY), `after Redact: ${after}`);
        expect(!(await store.events(ctx)).length, "the practice box recorded an event");
      } finally {
        await page.close();
      }
      const plain = await openExtPage(ctx, "vault.html");
      const hidden = await plain.evaluate(() => document.getElementById("welcome").hidden);
      await plain.close();
      expect(hidden, "the welcome shows on the normal vault page too");
    },
  );

  // Try it is the first useful moment, so it follows the short facts and comes before Alex's note and the setup
  // choices. Its Copy button means nobody has to select the key by hand.
  await check(
    "WP1",
    "Welcome page: Try it comes first, under the note, and Copy puts the made-up key on the clipboard and says Copied",
    async () => {
      await resetState(ctx, {});
      const page = await ctx.browser.newPage();
      page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
      await page.evaluateOnNewDocument(() => {
        window.__copied = [];
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async (text) => void window.__copied.push(text) },
        });
      });
      await page.setViewport({ width: 700, height: 900 });
      await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
      try {
        await waitFor(() => page.evaluate(() => document.getElementById("where-offer")?.hidden === false), 10000);
        const order = await page.evaluate(() => {
          const tryIt = document.querySelector('[data-i18n="vault_tryIt"]');
          const after = (el) => Boolean(el && tryIt.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
          return {
            afterFacts: Boolean(tryIt.previousElementSibling?.classList.contains("facts")),
            beforePin: after(document.querySelector("h2.pin-title")),
            beforeWhere: after(document.getElementById("where-offer")),
          };
        });
        expect(order.afterFacts && order.beforePin && order.beforeWhere, `order: ${JSON.stringify(order)}`);
        for (const width of [380, 1040]) {
          for (const theme of ["light", "dark"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await page.setViewport({ width, height: 900 });
            await sleep(200);
            const field = await page.$("#try-field");
            await field.screenshot({ path: path.join(OUT, `welcome-try-first-${width}-${theme}.png`) });
          }
        }
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await page.click("#try-copy");
        const copied = await page.evaluate(() => ({
          copied: window.__copied,
          button: document.getElementById("try-copy").textContent.trim(),
        }));
        expect(JSON.stringify(copied.copied) === JSON.stringify([KEY]), `copied: ${JSON.stringify(copied.copied)}`);
        expect(copied.button === "Copied", `button after a click: ${copied.button}`);
        const back = await waitFor(
          () => page.evaluate(() => document.getElementById("try-copy").textContent.trim() === "Copy"),
          4000,
        );
        expect(back, "the button still says Copied");
      } finally {
        await page.close();
      }
    },
  );

  // The pin steps follow the browser's own menus: Chrome and Brave pin from the puzzle piece, Firefox from a gear
  // menu's "Pin to Toolbar", Edge from an eye icon. Once pinned, the line names Clotr's icon (a C with a bandage).
  await check(
    "WP2",
    "Welcome page: the pin steps match Chrome, Firefox or Edge, and the pinned line names Clotr's icon",
    async () => {
      const UAS = {
        chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
      };
      const WANT = {
        chrome: [/puzzle piece/, /\bpin\b/],
        edge: [/extensions button/, /eye/, /Show in toolbar/],
        firefox: [/extensions button/, /gear/, /Pin to Toolbar/],
      };
      const read = async (ua, pinned) => {
        const page = await ctx.browser.newPage();
        page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
        if (ua) await page.setUserAgent(ua);
        await page.evaluateOnNewDocument((on) => {
          chrome.action.getUserSettings = async () => ({ isOnToolbar: on });
        }, pinned);
        await page.setViewport({ width: 1040, height: 900 });
        await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
        await sleep(400);
        const text = await page.evaluate(() => document.getElementById("pin-step").innerText);
        if (ua === UAS.firefox) await shot(page, "welcome-pin-firefox.png");
        await page.close();
        return text;
      };
      for (const [name, ua] of Object.entries(UAS)) {
        const text = await read(ua, false);
        for (const want of WANT[name]) expect(want.test(text), `${name}: no ${want} in ${JSON.stringify(text)}`);
        if (name !== "chrome") expect(!/puzzle piece|the pin next/.test(text), `${name}, Chrome's steps: ${text}`);
      }
      const pinned = await read(null, true);
      expect(/Clotr's icon/.test(pinned) && !/shield/i.test(pinned), `pinned: ${JSON.stringify(pinned)}`);
    },
  );

  await check(
    "V1s",
    "Vault page: typed details aren't kept by the browser (no autocomplete; fields cleared when the page is hidden)",
    async () => {
      const page = await openExtPage(ctx, "vault.html");
      try {
        const off = await page.$$eval("textarea", (ts) => ts.every((t) => t.getAttribute("autocomplete") === "off"));
        expect(off, "a vault field allows autocomplete (the browser could keep what was typed)");
        TYPED_VALUES.add("Jane Unsaved Example");
        await page.type("#f-my_name", "Jane Unsaved Example");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const left = await page.$eval("#f-my_name", (t) => t.value);
        expect(left === "", `still in the field after pagehide: ${JSON.stringify(left)}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "V8",
    "Vault addresses match with or without accents, and an entry saved before still matches as typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        const [fresh, legacy] = await ctx.worker.evaluate(async () => {
          const salt = await ensureSalt();
          return [
            globalThis.Clotr.fingerprint(salt, "street_address", "Calle Alcalá 45"),
            globalThis.Clotr.fingerprint(salt, "street_address_accented", "Avenida Andalucía 12"),
          ];
        });
        // Addresses are set to "just count" here, so only a vault entry marked "always watch" should warn.
        await store.set(ctx, {
          events: [],
          guided: ALL_GUIDED,
          responses: { street_address: "log" },
          vault: [
            { kind: "value", type: "street_address", fp: fresh, mode: "protect", added: Date.now() },
            { kind: "value", type: "street_address", fp: legacy, mode: "protect", added: Date.now() },
          ],
        });
        try {
          await typeText(page, "vivo en Calle Alcala 45, Madrid");
          expect(await waitForNotice(page), "no warning for the vault address typed without accents");
          await withSite(ctx, "chatgpt", async (other) => {
            await typeText(other, "mi oficina está en Avenida Andalucía 12");
            expect(await waitForNotice(other), "no warning for an address saved by an older version");
          });
        } finally {
          await store.set(ctx, { vault: [], responses: {} });
        }
      }),
  );

  await check(
    "V1",
    "Vault page saves fingerprints only, then your details are caught however they're written",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { vault: [] });
      const vp = await openExtPage(ctx, "vault.html");
      for (const [type, value] of Object.entries(MY)) {
        value.split("\n").forEach((v) => TYPED_VALUES.add(v));
        await vp.type(`#f-${type}`, value);
      }
      await vp.click("#save");
      const msg = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
      const leftover = await vp.$$eval("textarea", (ts) => ts.map((t) => t.value).join(""));
      await sleep(300);
      await shot(vp, "vault-page.png");
      await vp.close();
      expect(/Saved 10 new items/.test(msg || ""), `message: ${msg}`); // AB-123456 = its format + a fingerprint
      expect(leftover === "", `text left in the form: ${leftover}`);
      const stored = JSON.stringify((await store.get(ctx, "vault")).vault);
      const plain = /jane|emma|initech|oak|5636|123456|falcon|gmail/i.exec(stored);
      expect(!plain, `readable value in storage: ${plain?.[0]}`);
      await withSite(ctx, "chatgpt", async (page) => {
        const cases = [
          [
            "hi, I'm jane q doe and my kid emma lives at one twenty three oak st",
            ["Your Name", "Family Member's Name", "Street Address"],
          ],
          ["I work at INITECH on project falcon, badge EMP-12345", ["Your Employer", "Watch List Item"]],
          ["my member number is AB-123456", ["Your Account/ID Number"]],
          ["their member number is ab-998877", ["Account/ID Number"]],
        ];
        for (const [text, names] of cases) {
          await clearEditor(page);
          await typeText(page, text);
          // On a busy computer the first warning can come from the usual responses, before this page has the
          // vault (it waits 3 s for it at most), and the vault's names join it once it comes.
          const all = await waitFor(async () => {
            const shown = await readNotice(page);
            return shown && names.every((name) => shown.text.includes(name)) ? shown : null;
          }, DIALOG_WAIT * 2);
          const n = all || (await readNotice(page));
          const missing = names.filter((name) => !n?.text.includes(name));
          expect(!missing.length, `"${text}" → missing ${missing.join(", ")} (notice: ${n?.text})`);
          if (text.startsWith("their")) {
            expect(
              !n.text.includes("Your Account/ID Number"),
              `someone else's ID in your format was called yours: ${n.text}`,
            );
          }
          await clickDialogButton(page, "Leave it alone", readNotice);
        }
      });
    },
  );

  await check(
    "V9",
    'Settings → "Your own words and formats" opens the vault with "Anything else to watch for" ready to type in',
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        const before = (await ctx.browser.pages()).length;
        await popup.click("#open-watch");
        const page = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("vault.html#watch")) : null;
        }, 3000);
        expect(page, "the vault didn't open at #watch");
        const focused = await waitFor(
          () => page.evaluate(() => (document.activeElement?.id === "f-watch_list" ? true : null)),
          2000,
        );
        expect(focused, "the watch field isn't focused");
        await page.close();
      } finally {
        await popup.close();
      }
    },
  );

  await check("V2", "A vault item still warns when its type is set to Log only", async () => {
    await store.set(ctx, { responses: { phone_number: "log" } });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call 555.555.5636");
      const n = await waitForNotice(page);
      expect(n?.text.includes("Phone Number"), `your phone wasn't caught: ${n?.text}`);
      await clickDialogButton(page, "Leave it alone", readNotice);
      await clearEditor(page);
      await typeText(page, "or 555-555-1234");
      await expectNoUI(page, "other phone numbers are Log only");
    });
  });

  await check("V3", 'Vault → "OK to share" makes your own item quiet; Remove forgets it', async () => {
    await store.set(ctx, { responses: {} });
    // Runs standalone too, so it can't rely on V1 having already saved a phone number: seed one here if it's
    // not there yet (same fingerprint V1's vault.js save would make, so running after V1 just finds it
    // already present).
    const fp = await ctx.worker.evaluate(async () => {
      const salt = await ensureSalt();
      return globalThis.Clotr.fingerprintStrong(salt, "phone_number", "(555) 555-5636");
    });
    const { vault = [] } = await store.get(ctx, "vault");
    if (!vault.some((e) => e.kind === "value" && e.type === "phone_number" && e.fp === fp)) {
      await store.set(ctx, {
        vault: [...vault, { kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
      });
    }
    const vp = await openExtPage(ctx, "vault.html");
    const setPhone = (v) =>
      vp.evaluate((val) => {
        const li = [...document.querySelectorAll("#vault-list li")].find((x) => x.textContent.includes("Phone number"));
        const sel = li.querySelector("select");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    await setPhone("allow");
    await sleep(300);
    await store.set(ctx, { events: [] });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call me at five five five five five five five six three six");
      await expectNoUI(page, "your phone is OK to share");
    });
    // Recorded through the background's write queue, so it can land a moment after the page goes quiet.
    const logged =
      (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
    expect(
      logged.length === 1 && logged[0].action === "suppressed",
      `OK-to-share item should still be recorded: ${JSON.stringify(logged)}`,
    );
    const before = (await store.get(ctx, "vault")).vault.length;
    await vp.evaluate(() =>
      [...document.querySelectorAll("#vault-list li")]
        .find((x) => x.textContent.includes("Phone number"))
        .querySelector("button")
        .click(),
    );
    await sleep(300);
    await vp.close();
    expect((await store.get(ctx, "vault")).vault.length === before - 1, "entry not removed");
  });

  await check(
    "V10",
    "Vault page: an unrecognized line in each field keeps its own error, stays in the box, and saves nothing",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { vault: [] });
      const vp = await openExtPage(ctx, "vault.html");
      try {
        const bad = {
          my_name: "This Has Way Too Many Words To Keep",
          watch_list: "EMP-##",
          my_id: "AB",
          street_address: "nowhere special",
          phone_number: "not a phone",
          email: "not an email",
        };
        for (const [type, line] of Object.entries(bad)) await vp.type(`#f-${type}`, line);
        await vp.click("#save");
        const msg = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
        expect(!/^Saved/.test(msg || ""), `nothing should have saved: ${msg}`);
        const expected = [
          'Your name: "This Has Way Too Many Words To Keep" up to 4 words per line',
          'Watch word: "EMP-##" a format needs 4+ # or @ marks',
          'Account/ID format: "AB" needs at least 4 letters/digits, like AB-123456',
          'Address: "nowhere special" doesn\'t read as a street address (number + street name + St/Ave/Rd…) or PO Box',
          'Phone number: "not a phone" doesn\'t look like a phone number',
          'Email address: "not an email" doesn\'t look like an email address',
        ];
        for (const line of expected) expect((msg || "").includes(line), `missing "${line}" in: ${msg}`);
        const leftover = await vp.$$eval("textarea[data-type]", (ts) =>
          Object.fromEntries(ts.map((t) => [t.dataset.type, t.value])),
        );
        for (const [type, line] of Object.entries(bad)) {
          expect(leftover[type] === line, `${type}'s bad line should stay for fixing: ${leftover[type]}`);
        }
        const stored = (await store.get(ctx, "vault")).vault;
        expect(!stored.length, `an unrecognized line was saved anyway: ${JSON.stringify(stored)}`);
      } finally {
        await vp.close();
      }
    },
  );

  // A busy browser can take seconds to hand a new page its settings (each storage call once stalled 2.5 s). While
  // they're on the way, what you type must not be warned about by Clotr's defaults if your own settings say
  // otherwise: the warning waits for them (at most 3 seconds), and checks again the moment they come.
  await check(
    "V5",
    "A kind set to Log only stays quiet while a slow browser is still sending the page its settings",
    async () => {
      await store.set(ctx, { responses: { phone_number: "log" }, vault: [] });
      // The background holds the page's settings until this check lets them go.
      await ctx.worker.evaluate(() => {
        globalThis.__v5SettingsFor = settingsFor;
        globalThis.__v5Gate = new Promise((r) => (globalThis.__v5Open = r));
        globalThis.settingsFor = async (url) => {
          await globalThis.__v5Gate;
          return globalThis.__v5SettingsFor(url);
        };
      });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "call me on 555-555-1234");
          await sleep(900); // past the pause after typing that a check waits for
          const early = await readNotice(page);
          expect(!early, `warned with the defaults while the settings were on the way: ${early?.text}`);
          await ctx.worker.evaluate(() => globalThis.__v5Open());
          expect(
            await waitFor(() => page.logs.some((l) => l.startsWith("[Clotr] responses:")), 15000),
            "the settings never came",
          );
          await expectNoUI(page, "phone numbers are Log only, once the settings came");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          globalThis.__v5Open();
          globalThis.settingsFor = globalThis.__v5SettingsFor;
        });
        await store.set(ctx, { responses: {} });
      }
    },
  );

  // Deletes `part` from the chat box the way a person actually would, by selecting it and pressing Backspace.
  async function deleteByHand(page, part) {
    await page.evaluate(
      (sel, p) => {
        const box = eval(sel);
        const i = box.value.indexOf(p);
        box.focus();
        box.setSelectionRange(i, i + p.length);
      },
      page.site.editor,
      part,
    );
    await page.keyboard.press("Backspace");
  }

  await check(
    "L1",
    'Learning: deleting a flagged item by hand offers "Add to my vault" (not after Redact or sending)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        // Sending empties the box: no offer afterwards.
        await typeText(page, "call me at 555-555-1111 later");
        expect(await waitForNotice(page), "no notice");
        await sleep(1600); // an informed send (no "Just sent" follow-up)
        await pressEnter(page);
        await sleep(300);
        await typeText(page, "thanks");
        await expectNoUI(page, "after sending");
        // Redact button: no offer.
        await clearEditor(page);
        await typeText(page, "call me at 555-555-2222 later");
        await waitForNotice(page);
        await clickDialogButton(page, "Clot this leak", readNotice);
        await expectNoUI(page, "after Redact");
        // Deleted by hand: offer.
        await clearEditor(page);
        await typeText(page, "call me at 555-555-5636 later");
        await waitForNotice(page);
        await deleteByHand(page, "555-555-5636");
        const offer = await waitFor(async () => {
          const n = await readNotice(page);
          return n?.text.includes("Always watch") ? n : null;
        }, DIALOG_WAIT);
        expect(offer, `no offer after deleting by hand (notice: ${(await readNotice(page))?.text})`);
        await page.screenshot({ path: path.join(OUT, "offer-vault.png") });
        await clickDialogButton(page, "Add to my vault", readNotice);
        const v = await waitFor(async () => ((await store.get(ctx, "vault")).vault || []).find((e) => e.learned), 2000);
        expect(
          v?.type === "phone_number" && v.mode === "protect" && /^[0-9a-f]{16}$/.test(v.fp),
          `vault: ${JSON.stringify(v)}`,
        );
      }),
  );

  await check("L2", "Learning: keeping the same type 3 times offers to relax it to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      for (let i = 1; i <= 3; i++) {
        await clearEditor(page);
        await typeText(page, `mail me at friend${i}@gmail.com`);
        expect(await waitForNotice(page), `no notice #${i}`);
        await clickDialogButton(page, "Leave it alone", readNotice);
        await sleep(300);
      }
      const offer = await waitFor(async () => {
        const n = await readNotice(page);
        return n?.text.includes("Warn less") ? n : null;
      }, DIALOG_WAIT);
      expect(offer?.text.includes("Email Address"), `offer: ${(await readNotice(page))?.text}`);
      await page.screenshot({ path: path.join(OUT, "offer-relax.png") });
      await clickDialogButton(page, "Just count it", readNotice);
      await answerOnClotrPage(ctx, page); // warning less on every site takes a yes on Clotr's own page
      const responses = await waitFor(async () => {
        const r = (await store.get(ctx, "responses")).responses;
        return r?.email === "log" ? r : null;
      }, 2000);
      expect(responses?.email === "log", `responses: ${JSON.stringify(await store.get(ctx, "responses"))}`);
    }),
  );

  await check("V4", "Upgrade: It's me and watch-list entries move into the vault", async () => {
    await store.set(ctx, {
      vault: [],
      mine: [{ type: "email", fp: "0123456789abcdef", added: 1 }],
      watch: [
        { kind: "word", fp: "fedcba9876543210", words: 2, added: 2 },
        { kind: "shape", shape: "EMP-#####", added: 3 },
      ],
    });
    await ctx.worker.evaluate(() => migrateToVault());
    const got = await store.get(ctx, ["vault", "mine", "watch"]);
    await store.set(ctx, { vault: [] });
    expect(!got.mine && !got.watch, "old keys not removed");
    const v = got.vault || [];
    expect(
      v.length === 3 && v[0].mode === "allow" && v[1].type === "watch_list" && v[2].shape === "EMP-#####",
      `vault: ${JSON.stringify(v)}`,
    );
  });

  await check(
    "MIG1",
    "Upgrade from every earlier version's saved settings: clean result, history kept, dashboard opens",
    async () => {
      const ev = (type, name, severity, action, fp) => ({
        t: Date.now() - 3600000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp,
      });
      const EVENTS = [
        ev("aws_access_key", "AWS Access Key", "high", "redacted", "0123456789abcdef"),
        ev("email", "Email Address", "medium", "suppressed", "abcdef0123456789"),
      ];
      const SAVED = {
        "v0.4": {
          events: EVENTS,
          suppressed: { global: { email: true, phone_number: false } },
          paused: { "claude.ai": true },
        },
        "v0.5": {
          events: EVENTS,
          responses: { phone_number: "off", aws_access_key: "block" },
          mine: [{ type: "phone_number", fp: "1111111111111111", added: 1 }],
        },
        "v0.7": {
          events: EVENTS,
          responses: { email: "log" },
          mine: [{ type: "email", fp: "2222222222222222", added: 1 }],
          watch: [
            { kind: "word", fp: "3333333333333333", words: 1, added: 2 },
            { kind: "shape", shape: "EMP-#####", added: 2 },
          ],
          siteModes: { "chatgpt.com": "block" },
        },
        "v0.8": {
          events: EVENTS,
          responses: { us_ssn: "off" },
          ignores: { email: [Date.now()] },
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "protect", added: 3 }],
        },
        mixed: {
          events: EVENTS,
          suppressed: { global: { email: true } },
          responses: { email: "off", phone_number: "warn" },
          mine: [{ type: "email", fp: "4444444444444444", added: 1 }],
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "allow", added: 3 }],
        },
      };
      const saved = await store.get(ctx);
      try {
        for (const [version, data] of Object.entries(SAVED)) {
          await ctx.worker.evaluate(
            (d) =>
              enqueue(async () => {
                await chrome.storage.local.clear();
                await chrome.storage.local.set(d);
              }),
            { ...data, salt: saved.salt },
          );
          const problemsBefore = ctx.problems.length;
          await ctx.worker.evaluate(() => runMigrations());
          const got = await store.get(ctx);
          const bad = (why) => `${version}: ${why} (${JSON.stringify(got)})`;
          expect(!("suppressed" in got) && !("mine" in got) && !("watch" in got), bad("old keys left"));
          expect(
            Object.values(got.responses || {}).every((r) => ["block", "warn", "log"].includes(r)),
            bad("invalid response"),
          );
          expect(
            await ctx.worker.evaluate((v) => v.every((e) => cleanVaultEntry(e)), got.vault || []),
            bad("invalid vault entry"),
          );
          expect(got.events?.length === EVENTS.length, bad("history lost"));
          const popup = await openPopup(ctx);
          await sleep(500);
          await popup.close();
          expect(
            ctx.problems.length === problemsBefore,
            `${version}: ${ctx.problems.slice(problemsBefore).join(" | ")}`,
          );
        }
      } finally {
        await ctx.worker.evaluate(
          (d) =>
            enqueue(async () => {
              await chrome.storage.local.clear();
              await chrome.storage.local.set(d);
            }),
          saved,
        );
      }
    },
  );

  await check("V50", "Saved details aren't shown when a chat page puts guesses in the composer", async () => {
    await resetState(ctx, {});
    const own = `555-555-${String(9000 + Math.floor(Math.random() * 1000))}`;
    TYPED_VALUES.add(own);
    const fp = await ctx.worker.evaluate(async (value) => {
      const salt = await ensureSalt();
      return globalThis.Clotr.fingerprintStrong(salt, "phone_number", value);
    }, own);
    await store.set(ctx, {
      vault: [{ kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
    });
    await sleep(300);
    try {
      for (const mode of ["prefilled", "changed after typing"]) {
        await withSite(ctx, "chatgpt", async (page) => {
          if (mode === "prefilled") {
            await page.evaluate((value) => {
              const box = document.querySelector("textarea");
              box.value = `${value} `;
            }, own);
          } else {
            await page.evaluate((value) => {
              const box = document.querySelector("textarea");
              box.addEventListener("input", () => (box.value = value), { once: true });
            }, own);
          }
          // A one-letter, non-sensitive marker exercises the mixed page/user edit without confusing the privacy check below.
          await page.evaluate(`${page.site.editor}.focus()`);
          await page.keyboard.sendCharacter("x");
          await sleep(650);
          await expectNoUI(page, `the page's ${mode} guess triggered Clotr`);
        });
      }
    } finally {
      await resetState(ctx, {});
    }
  });

  await check("V52", "Everyday apps don't show saved details when a page inserts a guess in the composer", async () => {
    await resetState(ctx, {});
    const originalKinds = (await store.get(ctx, "siteKinds")).siteKinds || {};
    const own = `555-555-${String(9000 + Math.floor(Math.random() * 1000))}`;
    TYPED_VALUES.add(own);
    const fp = await ctx.worker.evaluate(async (value) => {
      const salt = await ensureSalt();
      return globalThis.Clotr.fingerprintStrong(salt, "phone_number", value);
    }, own);
    await store.set(ctx, {
      siteKinds: { "chatgpt.com": "everyday" },
      vault: [{ kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
    });
    await sleep(300);
    try {
      await withSite(ctx, "chatgpt", async (page) => {
        await page.evaluate((value) => {
          const box = document.querySelector("textarea");
          box.addEventListener("input", () => (box.value = value), { once: true });
        }, own);
        await page.evaluate(`${page.site.editor}.focus()`);
        await page.keyboard.sendCharacter("x");
        await sleep(650);
        await expectNoUI(page, "the everyday app's page-inserted guess triggered Clotr");
      });
    } finally {
      await resetState(ctx, {});
      await store.set(ctx, { siteKinds: originalKinds });
    }
  });

  await check(
    "V51",
    "A reply match stays off the chat page and appears in the toolbar, popup and Activity",
    async () => {
      await resetState(ctx, {});
      const own = `555-555-${String(9000 + Math.floor(Math.random() * 1000))}`;
      TYPED_VALUES.add(own);
      const fp = await ctx.worker.evaluate(async (value) => {
        const salt = await ensureSalt();
        return globalThis.Clotr.fingerprintStrong(salt, "phone_number", value);
      }, own);
      await store.set(ctx, {
        mentions: [],
        vault: [{ kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
      });
      await sleep(300);
      try {
        await withSite(ctx, "history", async (page) => {
          await typeText(page, "Hello, can you help me?");
          await pressEnter(page);
          await page.evaluate((value) => {
            const guess = document.createElement("div");
            guess.style.display = "none";
            guess.textContent = value;
            document.body.append(guess);
          }, own);
          const seen = await waitFor(async () => {
            const { mentions = [] } = await store.get(ctx, "mentions");
            return mentions.some((event) => event.action === "mentioned" && event.type === "phone_number")
              ? true
              : null;
          }, 7000);
          expect(seen, "the reply match wasn't kept in local history");
          await expectNoUI(page, "the reply match appeared in the chat page");
          const badge = await activeBadge(ctx);
          expect(badge.text === "1", `toolbar badge: ${JSON.stringify(badge)}`);
          const popup = await openPopup(ctx);
          try {
            const summary = await popup.$eval("#reply-mentions-text", (node) => node.textContent);
            expect(/AI reply.*mentioned your details|1.*AI reply/i.test(summary), `popup: ${summary}`);
            await popup.click("#tab-activity");
            const activity = await popup.$eval("#events-body", (node) => node.innerText);
            expect(/Phone Number/.test(activity) && /reply/i.test(activity), `Activity: ${activity}`);
          } finally {
            await popup.close();
          }
        });
      } finally {
        await resetState(ctx, {});
        await store.set(ctx, { mentions: [] });
      }
    },
  );

  await check(
    "V53",
    "Typed, pasted, rewritten, autocorrected, composed and undone vault details still warn in chat editors",
    async () => {
      await resetState(ctx, {});
      const own = `555-555-${String(9000 + Math.floor(Math.random() * 1000))}`;
      TYPED_VALUES.add(own);
      const fp = await ctx.worker.evaluate(async (value) => {
        const salt = await ensureSalt();
        return globalThis.Clotr.fingerprintStrong(salt, "phone_number", value);
      }, own);
      await store.set(ctx, {
        vault: [{ kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
      });

      const copyAndPaste = async (page, text) => {
        await page.evaluate((value) => {
          const button = document.createElement("button");
          button.id = "copy-for-provenance-test";
          button.textContent = "Copy test text";
          button.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(value);
              window.__testClipboardReady = true;
            } catch (error) {
              window.__testClipboardError = error.message;
            }
          });
          document.body.append(button);
        }, text);
        await page.click("#copy-for-provenance-test");
        await waitFor(() => page.evaluate(() => window.__testClipboardReady || window.__testClipboardError), 3000);
        const error = await page.evaluate(() => window.__testClipboardError);
        expect(!error, `clipboard write failed: ${error}`);
        await page.evaluate(`${page.site.editor}.focus()`);
        await page.keyboard.down("Control");
        await page.keyboard.press("v");
        await page.keyboard.up("Control");
        await page.evaluate(() => document.getElementById("copy-for-provenance-test")?.remove());
      };

      const cases = [
        ["typed", "chatgpt", async (page) => typeText(page, `call ${own}`)],
        [
          "autocorrected",
          "chatgpt",
          async (page) => {
            await page.evaluate((value) => {
              const box = document.querySelector("#prompt-textarea");
              box.addEventListener("input", () => {
                if (box.value === value) box.value = value.replace(/-/g, " ");
              });
            }, own);
            await typeText(page, own);
          },
        ],
        ["ProseMirror", "claude", async (page) => typeText(page, `call ${own}`)],
        ["Lexical-style", "perplexity", async (page) => typeText(page, `call ${own}`)],
        ["pasted", "chatgpt", async (page) => copyAndPaste(page, `call ${own}`)],
        ["newline-rewritten paste", "cancelling", async (page) => copyAndPaste(page, `call\r\n${own}\r\n`)],
        [
          "IME composition",
          "chatgpt",
          async (page) => {
            await page.evaluate(() => document.querySelector("#prompt-textarea").focus());
            const cdp = await page.createCDPSession();
            const text = `call ${own}`;
            await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
            await cdp.send("Input.insertText", { text });
          },
        ],
        [
          "undo after delete",
          "chatgpt",
          async (page) => {
            await typeText(page, own);
            await page.keyboard.down("Control");
            await page.keyboard.press("a");
            await page.keyboard.up("Control");
            await page.keyboard.press("Backspace");
            await page.keyboard.down("Control");
            await page.keyboard.press("z");
            await page.keyboard.up("Control");
          },
        ],
      ];
      try {
        for (const [label, site, enter] of cases) {
          await withSite(ctx, site, async (page) => {
            await enter(page);
            const notice = await waitForNotice(page, 6000);
            expect(notice && /Phone Number/.test(notice.text), `${label}: ${notice?.text || "no notice"}`);
          });
        }
      } finally {
        await resetState(ctx, {});
      }
    },
  );

  await check(
    "V54",
    "Bandage leaves page-inserted vault guesses alone, whether alone or beside typed text",
    async () => {
      await resetState(ctx, {});
      const own = `555-555-${String(9000 + Math.floor(Math.random() * 1000))}`;
      TYPED_VALUES.add(own);
      const fp = await ctx.worker.evaluate(async (value) => {
        const salt = await ensureSalt();
        return globalThis.Clotr.fingerprintStrong(salt, "phone_number", value);
      }, own);
      await store.set(ctx, {
        bandage: { "chatgpt.com": true },
        vault: [{ kind: "value", type: "phone_number", fp, scheme: 2, mode: "protect", added: Date.now() }],
      });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await page.evaluate((value) => {
            const box = document.querySelector("textarea");
            box.focus();
            box.value = value;
          }, own);
          await pressEnter(page);
          await expectNoUI(page, "a page-inserted saved detail by itself triggered Bandage");
          const sent = await sentMessages(page);
          expect(sent.length === 1 && sent[0] === own, `Bandage changed the page's guess: ${JSON.stringify(sent)}`);
        });
        await withSite(ctx, "chatgpt", async (page) => {
          await page.evaluate((value) => {
            const box = document.querySelector("textarea");
            box.addEventListener("input", () => (box.value = `${value} ${box.value}`), { once: true });
          }, own);
          await page.evaluate(`${page.site.editor}.focus()`);
          await page.keyboard.sendCharacter("x");
          await sleep(650);
          await expectNoUI(page, "a page-inserted saved detail beside typed text triggered Bandage");
          expect(!(await editorText(page)).includes("[Phone"), `Bandage label: ${await editorText(page)}`);
        });
      } finally {
        await resetState(ctx, {});
      }
    },
  );
};
