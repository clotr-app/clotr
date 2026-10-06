// E2E checks: TQ. Tourniquet is the stronger setup for someone you help, whether a child or a grown-up. It sits
// over the person's own settings: the kinds that matter always ask first, the shortcuts that would loosen a
// warning are gone, a short line says why, and "Leave it in and send" is always there.
// Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    EXT,
    OUT,
    auditShadow,
    check,
    clearEditor,
    clickDialogButton,
    clickSend,
    clotrActive,
    ctx,
    evalInClotr,
    expect,
  } = env;
  const { expectNoUI, fs, launch, openExtPage, openPopup, os, path, pressEnter, readDialog, readNotice } = env;
  const { resetState, shot, shotAt } = env;
  const { sentMessages, sleep, store, typeText, waitFor, waitForDialog, waitForNotice, withSite } = env;

  const MEDICARE = "1EG4-TE5-MK73";
  const PHONE = "555-555-0123";
  const ADDRESS = "123 Main St, Springfield, IL 62704";
  const MONEY_LINE = /If someone says they're from a bank, an insurer or the government and asks for this, stop/;
  const CHILD_LINE = /Only share this with people you know in real life/;
  const CODES_LINE = /Passwords and sign-in codes are only for you/;
  const LOOSENING = /stop warning me|don't warn me about|Just count it/i;

  // Sets Tourniquet the way Clotr's own pages do: on with a preset word, or off with null.
  async function setTourniquet(c, word) {
    await sleep(200);
    await c.worker.evaluate(
      (w) =>
        enqueue(() =>
          w
            ? chrome.storage.local.set({ tourniquet: { for: w, since: Date.now() } })
            : chrome.storage.local.remove("tourniquet"),
        ),
      word,
    );
    await sleep(300); // open tabs fetch their settings again
  }

  // After a scam, Scam Shield runs the grown-up's Tourniquet rules for 30 days, then turns itself off.
  const CARD = "4111 1111 1111 1111";
  const AFTER_SCAM_LINE = /Scammers often come back, saying they can get your money back/;
  // Sets the 30 days after a scam the way the setup page does. `daysIn` backdates the stored start, so a check
  // can jump ahead without waiting for real days to pass.
  async function setAfterScam(c, daysIn = 0) {
    await sleep(200);
    await c.worker.evaluate(
      (d) => enqueue(() => chrome.storage.local.set({ tourniquet: ClotrSites.afterScam(Date.now() - d * 86400000) })),
      daysIn,
    );
    await sleep(400); // open tabs fetch their settings again; the background sets the end alarm
  }
  const clearAfterScam = (c) =>
    c.worker.evaluate(() =>
      enqueue(() => chrome.storage.local.remove(["tourniquet", "tourniquetEnded", "tourniquetSeen"])),
    );
  // Sets the state the background leaves once the 30 days have just ended: Tourniquet off, with the end kept
  // around so the popup can mention it once.
  async function endAfterScam(c) {
    await sleep(200);
    await c.worker.evaluate(() =>
      enqueue(async () => {
        await chrome.storage.local.remove(["tourniquet", "tourniquetSeen"]);
        const at = Date.now() - 60000;
        await chrome.storage.local.set({ tourniquetEnded: { since: at - 30 * 86400000, at } });
      }),
    );
    await sleep(300);
  }

  // Reads the class names inside one of Clotr's closed shadow roots, which DevTools can pierce.
  async function uiClasses(page, tag) {
    page.cdp ??= await page.createCDPSession();
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const kids = (n) => [...(n.children || []), ...(n.shadowRoots || [])];
    const classes = new Set();
    let host = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        kids(n).forEach(find);
      }
    })(root);
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "class") a[i + 1].split(/\s+/).forEach((c) => classes.add(c));
      kids(n).forEach(walk);
    })(host);
    return classes;
  }

  // The font size of the first element with class `cls` inside Clotr's closed UI `tag`.
  async function uiFontSize(page, tag, cls) {
    page.cdp ??= await page.createCDPSession();
    await page.cdp.send("DOM.enable");
    await page.cdp.send("CSS.enable");
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const kids = (n) => [...(n.children || []), ...(n.shadowRoots || [])];
    let host = null;
    let hit = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        kids(n).forEach(find);
      }
    })(root);
    (function walk(n) {
      if (!n || hit) return;
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "class" && a[i + 1].split(/\s+/).includes(cls)) hit = n;
      if (!hit) kids(n).forEach(walk);
    })(host);
    if (!hit) return 0;
    const { computedStyle } = await page.cdp.send("CSS.getComputedStyleForNode", { nodeId: hit.nodeId });
    return parseFloat(computedStyle.find((s) => s.name === "font-size")?.value);
  }

  // A script can't click the browser's own permission prompt, so this stands in for "you switched Gmail and
  // Discord on" by granting those hosts in a copy of the manifest up front, the same trick EV3 uses. A granted
  // host behaves the same either way it was granted.
  async function withGrantedCopy(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.host_permissions = [...m.host_permissions, "https://mail.google.com/*", "https://discord.com/*"];
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    const other = await launch(copy);
    try {
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            if (!s) await syncUserSites();
            return Boolean(s);
          }),
        5000,
      );
      await resetState(other, {}); // the person's own settings: every kind just warns
      return await fn(other);
    } finally {
      await other.browser.close();
      fs.rmSync(other.profile, { recursive: true, force: true });
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check(
    "TQ2",
    "For a grown-up on an email app: a Medicare number asks first, larger, with the money line, and holds Send; a phone number gets the larger corner note",
    () =>
      withGrantedCopy(async (other) => {
        await setTourniquet(other, "adult");
        await withSite(other, "gmail", async (page) => {
          expect(clotrActive(page), "Clotr isn't running on the email fixture");
          await typeText(page, `My Medicare number is ${MEDICARE}`);
          await clickSend(page); // before the scan: the send is held
          const d = await waitForDialog(page);
          expect(d, "no Ask before sending for a Medicare number");
          expect(MONEY_LINE.test(d.text), `no money line: ${d.text}`);
          expect(/people who read it here/.test(d.text), `not the people wording: ${d.text}`);
          expect((await uiClasses(page, "CLOTR-GUARD")).has("large"), "the dialog isn't larger");
          const note = await uiFontSize(page, "CLOTR-GUARD", "note");
          const keys = await uiFontSize(page, "CLOTR-GUARD", "keys");
          expect(note >= 15 && keys >= 15, `small text in the larger dialog: note ${note}px, keys ${keys}px`);
          expect((await sentMessages(page)).length === 0, "sent before the choice");
          await page.screenshot({ path: path.join(OUT, "tourniquet-dialog-adult.png") });
          await clickDialogButton(page, "Hide it");
          await clearEditor(page);
          await typeText(page, `Call me at ${PHONE}`);
          const n = await waitForNotice(page);
          expect(n, "no corner note for a phone number");
          expect(!(await readDialog(page)), "a phone number asked first for a grown-up");
          expect((await uiClasses(page, "CLOTR-NOTICE")).has("large"), "the corner note isn't larger");
          expect(MONEY_LINE.test(n.text), `no Tourniquet line in the note: ${n.text}`);
          await page.screenshot({ path: path.join(OUT, "tourniquet-notice-adult.png") });
          await sleep(1600); // read it, then send
          await clickSend(page);
          const sent = await waitFor(async () => ((await sentMessages(page)).length ? sentMessages(page) : null), 2000);
          expect(sent?.length === 1, `the warned phone number didn't send: ${JSON.stringify(sent)}`);
        });
      }),
  );

  await check(
    "TQ3",
    "For a grown-up: no shortcut in a warning loosens it, no Just count offer after 3 keeps, and the first-time tip only explains",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await setTourniquet(ctx, "adult");
        try {
          await typeText(page, `My Medicare number is ${MEDICARE}`);
          const d = await waitForDialog(page);
          expect(d, "no dialog for a Medicare number");
          const dialogChoices = d.buttons.map((b) => b.text);
          expect(!dialogChoices.some((t) => LOOSENING.test(t)), `dialog: ${dialogChoices.join(" | ")}`);
          expect(dialogChoices.includes("Leave it in"), `no Leave it in: ${dialogChoices.join(" | ")}`);
          await clickDialogButton(page, "Hide it");
          for (let i = 1; i <= 3; i++) {
            await clearEditor(page);
            await typeText(page, `call me at 555-555-01${20 + i}`);
            const n = await waitForNotice(page);
            expect(n, `no notice #${i}`);
            const choices = n.buttons.map((b) => b.text);
            expect(!choices.some((t) => LOOSENING.test(t)), `notice #${i}: ${choices.join(" | ")}`);
            await clickDialogButton(page, "Leave it in", readNotice);
            await sleep(300);
          }
          await sleep(1500);
          const after = await readNotice(page);
          expect(!after || !/Warn less/.test(after.text), `offered to warn less: ${after?.text}`);
          // The first time a kind shows up, the tip just explains what Tourniquet does, with no choices offered.
          await store.set(ctx, { guided: {} });
          await clearEditor(page);
          await typeText(page, "write to ann.lee@example.com");
          const tip = await waitFor(async () => {
            const n = await readNotice(page);
            return n?.text.includes("Tourniquet") ? n : null;
          }, 3000);
          expect(tip && /You can always leave it in/.test(tip.text), `tip: ${(await readNotice(page))?.text}`);
          const tipChoices = tip.buttons.map((b) => b.text);
          for (const gone of [
            "Warn me",
            "Just count it",
            "Ask before sending",
            "It's fine to share",
            "Always watch it",
          ])
            expect(!tipChoices.includes(gone), `the tip still offers "${gone}": ${tipChoices.join(" | ")}`);
          expect(!/How should Clotr handle/.test(tip.text), `the tip still asks: ${tip.text}`);
        } finally {
          await setTourniquet(ctx, null);
          await resetState(ctx);
        }
      }),
  );

  await check(
    "TQ4",
    "For a child on a chat app: a home address asks first with the child line and the people wording; a password gets the codes line",
    () =>
      withGrantedCopy(async (other) => {
        await setTourniquet(other, "child");
        await withSite(other, "discord", async (page) => {
          await typeText(page, `I live at ${ADDRESS}`);
          await pressEnter(page);
          const d = await waitForDialog(page);
          expect(d, "no Ask before sending for a home address");
          expect(CHILD_LINE.test(d.text) && /tell an adult you trust/.test(d.text), `no child line: ${d.text}`);
          expect(/people who read it here/.test(d.text), `not the people wording: ${d.text}`);
          expect(!(await uiClasses(page, "CLOTR-GUARD")).has("large"), "larger warnings weren't asked for");
          expect((await sentMessages(page)).length === 0, "sent before the choice");
          await page.screenshot({ path: path.join(OUT, "tourniquet-dialog-child.png") });
          await clickDialogButton(page, "Hide it");
          await clearEditor(page);
          await typeText(page, "my password is Fluffy123 ok");
          const p = await waitForDialog(page);
          expect(p && CODES_LINE.test(p.text), `no codes line: ${p?.text}`);
          expect(!CHILD_LINE.test(p.text), `two Tourniquet lines: ${p.text}`);
        });
      }),
  );

  await check(
    "TQ5",
    'Under either preset, "Leave it in and send" sends the message and records it as sent',
    async () => {
      for (const [word, text] of [
        ["child", `I live at ${ADDRESS}`],
        ["adult", `My Medicare number is ${MEDICARE}`],
      ]) {
        await resetState(ctx, {});
        await setTourniquet(ctx, word);
        try {
          await withSite(ctx, "chatgpt", async (page) => {
            await typeText(page, text);
            await pressEnter(page);
            expect(await waitForDialog(page), `${word}: no dialog`);
            expect((await sentMessages(page)).length === 0, `${word}: sent before the choice`);
            await sleep(700);
            await clickDialogButton(page, "Leave it in and send");
            const sent = await waitFor(
              async () => ((await sentMessages(page)).length ? sentMessages(page) : null),
              2000,
            );
            expect(sent?.length === 1, `${word}: sent ${JSON.stringify(sent)}`);
            const events = await waitFor(async () => {
              const e = await store.events(ctx);
              return e.length ? e : null;
            }, 2000);
            expect(
              events?.every((e) => e.action === "allowed"),
              `${word}: events ${JSON.stringify(events)}`,
            );
          });
        } finally {
          await setTourniquet(ctx, null);
        }
      }
      await resetState(ctx);
    },
  );

  await check(
    "TQ6",
    "From a chat page the background refuses to loosen a Tourniquet kind (Just count, OK to share, the offer); the vault page still can",
    async () => {
      await resetState(ctx, {});
      await setTourniquet(ctx, "adult");
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "555-555-0123"),
      );
      const send = (page, m) => evalInClotr(page, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await send(page, { type: "clotr:setResponses", ids: ["phone_number", "medicare_id"], value: "log" });
          await send(page, {
            type: "clotr:vaultAdd",
            entries: [{ kind: "value", type: "phone_number", fp, mode: "allow", added: Date.now() }],
          });
          await send(page, { type: "clotr:setResponses", ids: ["email"], value: "block" }); // stricter: kept
          await sleep(300);
          const s = await store.get(ctx, ["responses", "vault"]);
          expect(!s.responses?.phone_number && !s.responses?.medicare_id, `loosened: ${JSON.stringify(s.responses)}`);
          expect(s.responses?.email === "block", `a stricter choice from the chat was refused: ${JSON.stringify(s)}`);
          expect(!(s.vault || []).length, `an OK to share from the chat was kept: ${JSON.stringify(s.vault)}`);
          // Asking directly for the "just count it" offer still gets none, for a kind Tourniquet holds on to.
          let offer = null;
          for (let i = 0; i < 3; i++) offer = await send(page, { type: "clotr:ignored", types: ["phone_number"] });
          expect(offer && !offer.offer, `offered: ${JSON.stringify(offer)}`);
        });
        // The vault page is Clotr's own, sitting behind the PIN when there is one, so an OK to share from it
        // is kept and honoured.
        const vault = await openExtPage(ctx, "vault.html");
        try {
          await vault.evaluate((entry) => chrome.runtime.sendMessage({ type: "clotr:vaultAdd", entries: [entry] }), {
            kind: "value",
            type: "phone_number",
            fp,
            mode: "allow",
            added: Date.now(),
          });
        } finally {
          await vault.close();
        }
        await sleep(300);
        const v = (await store.get(ctx, "vault")).vault || [];
        expect(v.length === 1 && v[0].mode === "allow", `vault: ${JSON.stringify(v)}`);
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, `call me at ${PHONE}`);
          await expectNoUI(page, "the helper marked this phone number OK to share on the vault page");
        });
      } finally {
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ7",
    "A site set to Quieter here (just count) is ignored while Tourniquet is on, and back once it's off",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { siteModes: { "chatgpt.com": "log" } });
      await setTourniquet(ctx, "adult");
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, `call me at ${PHONE}`);
          expect(await waitForNotice(page), "Quieter here silenced a phone number under Tourniquet");
        });
        await setTourniquet(ctx, null);
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, `call me at ${PHONE}`);
          await expectNoUI(page, "Quieter here is back once Tourniquet is off");
        });
        const mode = await ctx.worker.evaluate(async () => (await settingsFor("https://chatgpt.com/")).siteMode);
        expect(mode === "log", `site mode after: ${mode}`);
      } finally {
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ10",
    "An organization's policy and Tourniquet together: the stricter wins per kind; the setup page stays hidden under its lock",
    async () => {
      await resetState(ctx, {});
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          requiredResponses: { phone_number: "block", internal_ip: "log" },
          lockSettings: true,
        });
      });
      await setTourniquet(ctx, "adult");
      try {
        const s = await ctx.worker.evaluate(() => settingsFor("https://chatgpt.com/"));
        expect(s.responses.phone_number === "block", `phone: ${s.responses.phone_number} (the team's block)`);
        expect(s.responses.medicare_id === "block", `medicare: ${s.responses.medicare_id} (Tourniquet's block)`);
        expect(s.responses.internal_ip === "warn", `internal IP: ${s.responses.internal_ip} (Tourniquet's warn)`);
        expect(s.largeText === true && s.tourniquet === "adult", `settings: ${JSON.stringify(s).slice(0, 200)}`);
        expect(s.firm.includes("phone_number") && s.firm.includes("medicare_id"), `firm: ${s.firm}`);
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, `call me at ${PHONE}`);
          await pressEnter(page);
          expect(await waitForDialog(page), "the team's block didn't hold a phone number");
        });
        const helper = await ctx.browser.newPage();
        try {
          await helper.evaluateOnNewDocument(() => {
            chrome.storage.managed.get = async () => ({ lockSettings: true });
          });
          await helper.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/helper.html`);
          await sleep(500);
          const hidden = await helper.evaluate(() => document.getElementById("steps").hidden);
          expect(hidden, "the setup page shows its steps under the organization's lock");
        } finally {
          await helper.close();
        }
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ14",
    "No serious accessibility problems (axe-core) in the dialog and the corner note with Tourniquet's line, light and dark",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await setTourniquet(ctx, "adult");
        const problems = [];
        const audit = async (tag, where) => {
          for (const theme of ["light", "dark"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            const found = await auditShadow(page, tag);
            if (found) problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
          }
        };
        try {
          await typeText(page, `call me at ${PHONE}`);
          const n = await waitForNotice(page);
          expect(n && MONEY_LINE.test(n.text), `no line in the note: ${n?.text}`);
          await audit("CLOTR-NOTICE", "corner note");
          await clearEditor(page);
          await typeText(page, `My Medicare number is ${MEDICARE}`);
          const d = await waitForDialog(page);
          expect(d && MONEY_LINE.test(d.text), `no line in the dialog: ${d?.text}`);
          await audit("CLOTR-GUARD", "dialog");
          expect(!problems.length, problems.slice(0, 8).join(" | "));
        } finally {
          await setTourniquet(ctx, null);
          await resetState(ctx);
        }
      }),
  );

  // ---------- The popup: the chip, the Overview line, the Settings card ----------

  const PIN_HASH = { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) }; // a PIN nobody can type
  const lockSettings = (c) =>
    c.worker.evaluate(
      (lock) => Promise.all([chrome.storage.local.set({ lock }), chrome.storage.session.remove("unlockedUntil")]),
      PIN_HASH,
    );
  const unlockSettings = (c) =>
    c.worker.evaluate(() =>
      Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
    );

  await check(
    "TQ8",
    "Unlocked Settings: the switch changes the preset, options under its floor can't be picked, and Off (two clicks) brings back exactly the earlier settings",
    async () => {
      await resetState(ctx, { phone_number: "log", email: "block" });
      await unlockSettings(ctx);
      const effective = () => ctx.worker.evaluate(async () => (await settingsFor("https://chatgpt.com/")).responses);
      const before = await effective();
      const storedBefore = JSON.stringify((await store.get(ctx, "responses")).responses);
      await setTourniquet(ctx, "child");
      const popup = await openPopup(ctx);
      try {
        await popup.evaluate(() => document.body.classList.add("advanced")); // the per-kind selects
        await popup.click("#tab-settings");
        await sleep(200);
        const card = await popup.evaluate(() => ({
          shown: !document.getElementById("tq-card").hidden,
          switchShown: !document.getElementById("tq-switch").hidden,
          pressed: [...document.querySelectorAll("#tq-switch button")].map((b) => [
            b.textContent.trim(),
            b.getAttribute("aria-pressed"),
          ]),
          phone: document.querySelector('select[data-pattern="phone_number"]')?.disabled,
        }));
        expect(card.shown && card.switchShown, `card: ${JSON.stringify(card)}`);
        expect(
          JSON.stringify(card.pressed) ===
            JSON.stringify([
              ["For a child", "true"],
              ["For a grown-up", "false"],
              ["After a scam", "false"],
              ["Off", "false"],
            ]),
          `switch: ${JSON.stringify(card.pressed)}`,
        );
        expect(card.phone === true, "for a child, phone numbers always ask: the select should be fixed");
        await popup.click('#tq-switch button[data-for="adult"]');
        const adult = await waitFor(async () => {
          const t = (await store.get(ctx, "tourniquet")).tourniquet;
          return t?.for === "adult" ? t : null;
        }, 2000);
        expect(adult && Number.isFinite(adult.since), "switching to a grown-up didn't store it");
        await sleep(300);
        const phone = await popup.$eval('select[data-pattern="phone_number"]', (sel) => ({
          disabled: sel.disabled,
          value: sel.value,
          off: [...sel.options].filter((o) => o.disabled).map((o) => o.value),
          title: sel.title,
        }));
        expect(
          !phone.disabled &&
            phone.value === "warn" &&
            phone.off.join() === "log" &&
            /Tourniquet keeps this/.test(phone.title),
          `phone select for a grown-up: ${JSON.stringify(phone)}`,
        );
        await shot(popup, "tourniquet-settings-unlocked.png");
        await popup.click('#tq-switch button[data-for="off"]');
        await sleep(300);
        expect((await store.get(ctx, "tourniquet")).tourniquet, "one click on Off turned Tourniquet off");
        const asked = await popup.$eval("#tq-off-msg", (n) => n.textContent);
        expect(/email and chat apps stay on/i.test(asked), `no word about the apps: ${asked}`);
        await popup.click('#tq-switch button[data-for="off"]');
        const off = await waitFor(async () => !(await store.get(ctx, "tourniquet")).tourniquet, 2000);
        expect(off, "two clicks on Off didn't turn it off");
        await sleep(300);
        expect(await popup.evaluate(() => document.getElementById("tq-card").hidden), "the card stayed");
      } finally {
        await popup.close();
      }
      const after = await effective();
      expect(JSON.stringify(after) === JSON.stringify(before), `after: ${JSON.stringify(after)}`);
      expect(
        JSON.stringify((await store.get(ctx, "responses")).responses) === storedBefore,
        "the person's own settings changed",
      );
      await resetState(ctx);
    },
  );

  await check(
    "TQ9",
    "Popup: the chip on every tab; with a PIN, Settings shows the Tourniquet card and Clear my history works without the PIN",
    async () => {
      const t = Date.now() - 60000;
      const ev = {
        t,
        site: "chatgpt.com",
        type: "email",
        name: "Email Address",
        severity: "low",
        fp: "aaaaaaaaaaaaaaa1",
      };
      await resetState(ctx);
      await store.set(ctx, {
        events: [{ ...ev, action: "redacted" }],
        mentions: [{ ...ev, action: "mentioned" }],
        spotted: { "chat.newtool.ai": true },
        siteModes: { "chatgpt.com": "log" },
      });
      await setTourniquet(ctx, "adult");
      await lockSettings(ctx);
      const popup = await openPopup(ctx);
      try {
        for (const tab of ["overview", "activity", "settings"]) {
          await popup.click(`#tab-${tab}`);
          await sleep(100);
          const chip = await popup.evaluate(() => {
            const c = document.getElementById("tq-chip");
            return { shown: Boolean(c.offsetParent), text: c.textContent.trim(), label: c.getAttribute("aria-label") };
          });
          expect(chip.shown && chip.text === "Tourniquet on", `chip on ${tab}: ${JSON.stringify(chip)}`);
          expect(/see what it changes/.test(chip.label), `chip label: ${chip.label}`);
        }
        await popup.click("#tab-overview");
        await sleep(200);
        const line = await popup.evaluate(() => ({
          shown: !document.getElementById("tq-line").hidden,
          text: document.getElementById("tq-line").textContent.replace(/\s+/g, " "),
        }));
        expect(
          line.shown && /Tourniquet is on/.test(line.text) && /sends nothing anywhere/.test(line.text),
          `line: ${JSON.stringify(line)}`,
        );
        await shot(popup, "tourniquet-overview.png");
        await shot(popup, "tourniquet-overview-dark.png", "dark");
        await popup.click("#tq-chip");
        await sleep(200);
        const focus = await popup.evaluate(() => ({
          tab: document.body.dataset.tab,
          focused: document.activeElement?.id,
        }));
        expect(focus.tab === "settings" && focus.focused === "tq-title", `after the chip: ${JSON.stringify(focus)}`);
        const locked = await popup.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          body: document.getElementById("settings-body").hidden,
          card: !document.getElementById("tq-card").hidden,
          switchShown: !document.getElementById("tq-switch").hidden,
          cardText: document.getElementById("tq-card").innerText.replace(/\s+/g, " "),
          history: !document.getElementById("history-mine").hidden,
          quieter: (() => {
            const o = document.querySelector('#site-mode option[value="log"]');
            return o.hidden && o.disabled;
          })(),
        }));
        expect(locked.unlock && locked.body && locked.card && !locked.switchShown, `locked: ${JSON.stringify(locked)}`);
        expect(
          /Clotr sends nothing anywhere, and every message is still yours to send/.test(locked.cardText),
          `card: ${locked.cardText}`,
        );
        expect(
          !/child|grown-up|adult|elder/i.test(locked.cardText),
          `the protected person's card names a preset: ${locked.cardText}`,
        );
        expect(locked.quieter, "Quieter here is offered under Tourniquet");
        expect(locked.history, "no Clear my history in the locked view");
        await shot(popup, "tourniquet-settings-locked.png");
        await shot(popup, "tourniquet-settings-locked-dark.png", "dark");
        await popup.click("#clear-mine");
        await sleep(200);
        expect((await store.events(ctx)).length === 1, "one click cleared the history");
        await popup.click("#clear-mine");
        const cleared = await waitFor(async () => {
          const s = await store.get(ctx, ["events", "mentions", "spotted"]);
          return !s.events?.length && !s.mentions?.length && !Object.keys(s.spotted || {}).length ? s : null;
        }, 2000);
        expect(
          cleared,
          `history not cleared: ${JSON.stringify(await store.get(ctx, ["events", "mentions", "spotted"]))}`,
        );
        expect((await store.get(ctx, "lock")).lock, "clearing the history touched the PIN");
      } finally {
        await popup.close();
        await unlockSettings(ctx);
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ15",
    "Spanish browser: the chip, the Overview line and the Tourniquet card are in Spanish",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        await setTourniquet(es, "adult");
        const popup = await openPopup(es);
        await popup.click("#tab-settings");
        await sleep(200);
        const got = await popup.evaluate(() => ({
          chip: document.getElementById("tq-chip").textContent.trim(),
          card: document.getElementById("tq-card").textContent.replace(/\s+/g, " "),
          line: document.getElementById("tq-line").textContent.replace(/\s+/g, " "),
        }));
        await shot(popup, "tourniquet-settings-es.png");
        await popup.close();
        expect(got.chip === "Tourniquet activado", `chip: ${got.chip}`);
        expect(/Clotr no envía nada a ningún sitio/.test(got.card), `card: ${got.card}`);
        expect(/Tourniquet está activado/.test(got.line), `line: ${got.line}`);
        expect(!/Clotr sends nothing|Tourniquet is on/.test(got.card + got.line), "English left in the Spanish popup");
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check(
    "TQ16",
    "No serious accessibility problems (axe-core) in the popup with Tourniquet on, locked and open, light and dark",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); // through DevTools: the CSP blocks script tags
      const problems = [];
      const audit = async (page, where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`),
          );
          problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      await resetState(ctx);
      await setTourniquet(ctx, "adult");
      try {
        for (const locked of [true, false]) {
          if (locked) await lockSettings(ctx);
          else await unlockSettings(ctx);
          const popup = await openPopup(ctx);
          try {
            for (const tab of ["overview", "settings"]) {
              await popup.click(`#tab-${tab}`);
              await sleep(200);
              await audit(popup, `${locked ? "locked" : "open"} ${tab}`);
            }
          } finally {
            await popup.close();
          }
        }
        // Checks the popup during the 30 days after a scam, then again once they're over and the end card shows.
        await setAfterScam(ctx, 3);
        await store.set(ctx, { tourniquetSeen: Date.now() + 5 * 86400000 });
        const on = await openPopup(ctx);
        try {
          await on.click("#tab-settings");
          await sleep(200);
          await audit(on, "30 days after a scam, settings");
        } finally {
          await on.close();
        }
        await endAfterScam(ctx);
        const ended = await openPopup(ctx);
        try {
          await audit(ended, "the end card");
        } finally {
          await ended.close();
          await clearAfterScam(ctx);
        }
      } finally {
        await unlockSettings(ctx);
        await setTourniquet(ctx, null);
      }
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );

  // ---------- Moving and showing: the backup file and What Clotr stores ----------

  await check(
    "TQ17",
    "Move to a new computer carries Tourniquet: the file says it holds it, and loading brings it back exactly",
    async () => {
      const since = Date.UTC(2026, 9, 2, 12);
      await resetState(ctx);
      await unlockSettings(ctx);
      await ctx.worker.evaluate((t) => chrome.storage.local.set({ tourniquet: t }), { for: "adult", since });
      const file = path.join(OUT, "move-tourniquet.clotr");
      const page = await openExtPage(ctx, "stored.html#move");
      const asked = [];
      page.on("dialog", (d) => {
        asked.push(d.message());
        d.accept();
      });
      try {
        await sleep(300);
        // This is the same file the Save button makes.
        const text = await page.evaluate(async () => {
          const { Backup } = globalThis.Clotr;
          return Backup.seal(Backup.pick(await chrome.storage.local.get(Backup.KEYS)), "correct horse battery");
        });
        expect(!/adult|tourniquet/.test(text), "the file shows Tourniquet's setting");
        fs.writeFileSync(file, text);
        await setTourniquet(ctx, null); // "the other computer": Tourniquet off
        await (await page.$("#mv-file")).uploadFile(file);
        await page.type("#mv-open", "correct horse battery");
        await page.click("#mv-load");
        const loaded = await waitFor(
          () => page.evaluate(() => document.getElementById("mv-load-msg").textContent || null),
          15000,
        );
        expect(/Tourniquet/.test(asked.at(-1) || ""), `the question before loading: ${asked.at(-1)}`);
        expect(/^Done\..*Tourniquet/.test(loaded || ""), `after loading: ${loaded}`);
        const back = (await store.get(ctx, "tourniquet")).tourniquet;
        expect(back?.for === "adult" && back.since === since, `Tourniquet after loading: ${JSON.stringify(back)}`);
      } finally {
        await page.close();
        fs.rmSync(file, { force: true });
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ18",
    "What Clotr stores shows Tourniquet in one row: since when and what it asks about, never who it's for; Off once it's off",
    async () => {
      await setTourniquet(ctx, "adult");
      const page = await openExtPage(ctx, "stored.html");
      const row = () =>
        page.evaluate(() => {
          const dt = [...document.querySelectorAll("#settings dt")].find((d) => d.textContent === "Tourniquet");
          return dt?.nextElementSibling?.textContent ?? null;
        });
      try {
        const adult = await waitFor(row, 2000);
        expect(
          /^On since .+\. Clotr asks before bank, card and ID numbers, passwords and sign-in codes go out\.$/.test(
            adult || "",
          ),
          `for a grown-up: ${adult}`,
        );
        await page.setViewport({ width: 380, height: 900 });
        for (const theme of ["dark", "light"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(200);
          await page.screenshot({ path: path.join(OUT, `tourniquet-stored-${theme}.png`) });
        }
        await setTourniquet(ctx, "child");
        const child = await waitFor(async () => {
          const r = await row();
          return /personal details/.test(r || "") ? r : null;
        }, 2000);
        expect(child, `for a child: ${await row()}`);
        for (const text of [adult, child])
          expect(!/child|grown-up|adult|elder/i.test(text || ""), `the row names a preset: ${text}`);
        await setTourniquet(ctx, null);
        const off = await waitFor(async () => ((await row()) === "Off" ? "Off" : null), 2000);
        expect(off, `once it's off: ${await row()}`);
      } finally {
        await page.close();
        await setTourniquet(ctx, null);
      }
    },
  );

  // ---------- The setup page (helper.html), the welcome page's line and the printed guide ----------

  const extUrl = (file) => `chrome-extension://${new URL(ctx.swTarget.url()).host}/${file}`;
  // Opens the setup page the way a helper first sees it: settings open, Tourniquet off, nothing chosen yet.
  async function openSetup(file = "helper.html", before = null) {
    await unlockSettings(ctx);
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`${file} error: ${err.message}`));
    await page.setViewport({ width: 700, height: 900 });
    if (before) await page.evaluateOnNewDocument(before);
    await page.goto(extUrl(file));
    await page.evaluate(() => document.fonts.ready);
    await sleep(400);
    return page;
  }
  const choose = async (page, who) => {
    await page.click(`#who input[value="${who}"]`);
    await sleep(250);
  };
  // Reads everything the setup page currently shows: which steps are on screen, in what order, and their text.
  const setupState = (page) =>
    page.evaluate(() => {
      const shown = (id) => {
        const n = document.getElementById(id);
        return Boolean(n && !n.hidden && n.offsetParent);
      };
      return {
        steps: [...document.querySelectorAll("#steps > li")].filter((li) => !li.hidden).map((li) => li.id),
        chosen: document.querySelector('#who input[name="who"]:checked')?.value || null,
        title: document.getElementById("tq-title")?.textContent.trim(),
        list: [...document.querySelectorAll("#tq-map-list li")].map((li) => li.textContent.trim()),
        groups: [...document.querySelectorAll("#tq-map-list .tq-branch")].map((h) => h.textContent.trim()),
        on: document.getElementById("tq-on")?.textContent.trim(),
        onShown: shown("tq-on"),
        state: document.getElementById("tq-state")?.textContent.trim(),
        off: shown("tq-off"),
        how: shown("how"),
        done: shown("done"),
        pinText: document.getElementById("pin-text")?.textContent.trim(),
        ticked: [...document.querySelectorAll('#ev-groups input[type="checkbox"]:checked')].map((b) => b.value),
        go: document.getElementById("ev-go")?.textContent.trim(),
      };
    });

  await check(
    "TQ1",
    "Setup page: Who is it for? first; A grown-up and Turn on Tourniquet stores it and leaves the person's own settings byte for byte; switching and two-click off work there too",
    async () => {
      await resetState(ctx, { phone_number: "log", email: "block" });
      await setTourniquet(ctx, null);
      await store.set(ctx, { largeText: false, siteModes: { "chatgpt.com": "log" }, guided: { email: 1 } });
      const own = async () => JSON.stringify(await store.get(ctx, ["responses", "largeText", "siteModes"]));
      const before = await own();
      const page = await openSetup();
      try {
        const first = await setupState(page);
        expect(
          JSON.stringify(first.steps) === JSON.stringify(["step-who"]) && !first.chosen,
          `before a choice: ${JSON.stringify(first)}`,
        );
        await choose(page, "adult");
        const adult = await setupState(page);
        expect(
          JSON.stringify(adult.steps) ===
            JSON.stringify(["step-who", "step-tq", "step-vault", "step-apps", "step-pin"]),
          `steps for a grown-up: ${adult.steps}`,
        );
        expect(adult.title === "Turn on Tourniquet", `title: ${adult.title}`);
        expect(
          adult.groups.join(" | ") === "Asks before sending | A bigger note in the corner",
          `groups: ${adult.groups}`,
        );
        expect(adult.list.includes("Card and bank numbers") && adult.list.length === 6, `list: ${adult.list}`);
        expect(adult.on === "Turn on Tourniquet" && adult.onShown && !adult.off, `before: ${JSON.stringify(adult)}`);
        expect(adult.how && !adult.done, "How it works isn't there for a grown-up");
        expect(/^Pick the PIN together and write it down for them\./.test(adult.pinText), `PIN: ${adult.pinText}`);
        await page.click("#tq-on");
        const t = await waitFor(async () => (await store.get(ctx, "tourniquet")).tourniquet || null, 2000);
        expect(t?.for === "adult" && Number.isFinite(t.since) && Object.keys(t).length === 2, `stored: ${t}`);
        expect((await own()) === before, `the person's own settings changed: ${await own()} (was ${before})`);
        expect(!(await store.get(ctx, "guided")).guided, "the first-time tips weren't made to show again");
        await sleep(300);
        const on = await setupState(page);
        expect(/^Tourniquet is on for a grown-up, since .+\.$/.test(on.state || ""), `state: ${on.state}`);
        expect(!on.onShown && on.off, `after turning it on: ${JSON.stringify(on)}`);
        // Choosing the other preset offers a switch, and stores a new `since` for the switch.
        await choose(page, "child");
        const child = await setupState(page);
        expect(child.on === "Switch to Tourniquet for a child" && child.onShown, `switch: ${child.on}`);
        expect(child.groups[1] === "Also asks about words you add", `child groups: ${child.groups}`);
        expect(/^Keep the PIN yourself\./.test(child.pinText), `child PIN: ${child.pinText}`);
        await page.click("#tq-on");
        const switched = await waitFor(async () => {
          const s = (await store.get(ctx, "tourniquet")).tourniquet;
          return s?.for === "child" ? s : null;
        }, 2000);
        expect(switched && switched.since >= t.since, `switched: ${JSON.stringify(switched)}`);
        // Reopening the page should show whichever preset is actually on.
        await page.reload();
        await sleep(500);
        expect((await setupState(page)).chosen === "child", "reopened, the page doesn't show the preset that's on");
        // Off takes two clicks.
        await page.click("#tq-off");
        await sleep(300);
        expect((await store.get(ctx, "tourniquet")).tourniquet, "one click turned Tourniquet off");
        await page.click("#tq-off");
        expect(await waitFor(async () => !(await store.get(ctx, "tourniquet")).tourniquet, 2000), "two clicks didn't");
        expect((await own()) === before, "turning it off changed the person's own settings");
      } finally {
        await page.close();
        await setTourniquet(ctx, null);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ12",
    "Setup page, email and chat apps: each preset ticks its own apps, and the button asks the browser once for exactly the ticked ones",
    async () => {
      await setTourniquet(ctx, null);
      // A script can't answer the browser's own permission prompt, so this records what was asked for and
      // answers No.
      const page = await openSetup("helper.html", () => {
        window.__asked = [];
        chrome.permissions.request = async (p) => {
          window.__asked.push(p);
          return false;
        };
      });
      try {
        await choose(page, "adult");
        const adult = await setupState(page);
        expect(
          adult.ticked.join() === "Gmail,Outlook,Yahoo Mail,WhatsApp,Messenger" && adult.go === "Switch on 5 apps",
          `for a grown-up: ${adult.ticked} / ${adult.go}`,
        );
        await choose(page, "child");
        const child = await setupState(page);
        expect(child.ticked.join() === "Discord,WhatsApp,Messenger", `for a child: ${child.ticked}`);
        await choose(page, "adult");
        await page.click('#ev-groups input[value="Outlook"]');
        await page.click('#ev-groups input[value="Discord"]');
        await page.click("#ev-go");
        await sleep(400);
        const asked = await page.evaluate(() => window.__asked);
        const want = await page.evaluate(() =>
          globalThis.ClotrSites.everydayOrigins(["Gmail", "Yahoo Mail", "Discord", "WhatsApp", "Messenger"]),
        );
        expect(
          asked.length === 1 && JSON.stringify(asked[0]) === JSON.stringify({ origins: want }),
          `asked ${JSON.stringify(asked)}, not once for ${JSON.stringify(want)}`,
        );
        const status = await page.$eval("#ev-status", (s) => s.textContent);
        expect(/Nothing was switched on/.test(status), `after a No: ${status}`);
        expect(!(await store.get(ctx, "tourniquet")).tourniquet, "the apps step turned Tourniquet on by itself");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "TQ13",
    "Welcome page: one Tourniquet line right after the email and chat card; its link opens the setup at Who is it for?; hidden while locked",
    async () => {
      await store.set(ctx, { everydayOffer: "welcome" });
      const page = await openSetup("vault.html?welcome=1");
      try {
        const line = await waitFor(
          () =>
            page.evaluate(() => {
              const p = document.getElementById("tq-offer");
              if (!p || p.hidden) return null;
              return {
                text: p.textContent.replace(/\s+/g, " ").trim(),
                after: p.previousElementSibling?.id,
                href: p.querySelector("a")?.getAttribute("href"),
              };
            }),
          3000,
        );
        expect(line, "no Tourniquet line on the welcome page");
        expect(
          line.text ===
            "Setting Clotr up for someone else? Tourniquet gives a child or a grown-up stronger settings in one step.",
          `line: ${line.text}`,
        );
        expect(line.after === "everyday-offer", `the line comes after ${line.after}, not the email and chat card`);
        expect(line.href === "helper.html#who", `link: ${line.href}`);
        await page.setViewport({ width: 700, height: 900 });
        for (const theme of ["dark", "light"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          // Crops to the card and the line under it, with a little of the page around them for context.
          const card = await (await page.$("#everyday-offer")).boundingBox();
          const below = await (await page.$("#tq-offer")).boundingBox();
          await page.screenshot({
            path: path.join(OUT, `tourniquet-welcome-${theme}.png`),
            clip: { x: 0, y: card.y - 12, width: 700, height: below.y + below.height - card.y + 40 },
            captureBeyondViewport: true,
          });
        }
        const opened = ctx.browser.waitForTarget((t) => t.url().endsWith("/helper.html#who"), { timeout: 3000 });
        await page.click("#tq-offer a");
        const setup = await (await opened).page();
        try {
          await sleep(600);
          const at = await setup.evaluate(() => ({
            focus: document.activeElement?.name,
            top: Math.round(document.getElementById("who").getBoundingClientRect().top),
          }));
          expect(
            at.focus === "who" && at.top >= 0 && at.top < 400,
            `the setup page isn't at Who is it for?: ${JSON.stringify(at)}`,
          );
        } finally {
          await setup.close();
        }
      } finally {
        await page.close();
      }
      await lockSettings(ctx);
      const locked = await ctx.browser.newPage();
      try {
        await locked.goto(extUrl("vault.html?welcome=1"));
        await sleep(700);
        expect(await locked.$eval("#tq-offer", (p) => p.hidden), "the Tourniquet line shows while settings are locked");
      } finally {
        await locked.close();
        await unlockSettings(ctx);
      }
    },
  );

  await check(
    "TQ19",
    "No serious accessibility problems (axe-core) on the setup page with each choice, and with Tourniquet on, light and dark",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); // through DevTools: the CSP blocks script tags
      await setTourniquet(ctx, null);
      const page = await openSetup();
      const problems = [];
      const audit = async (where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`),
          );
          problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      try {
        await audit("nothing chosen");
        for (const who of ["child", "adult", "after_scam", "self"]) {
          await choose(page, who);
          await audit(who);
        }
        await choose(page, "adult");
        await page.click("#tq-on");
        await sleep(400);
        await audit("on for a grown-up");
        await choose(page, "after_scam");
        await page.click("#tq-on");
        await sleep(400);
        await audit("on for 30 days after a scam");
        await clearAfterScam(ctx);
        // Takes a picture of each choice at the three widths people actually use, dark theme first.
        for (const [who, width] of [
          ["adult", 1040],
          ["child", 1040],
          ["adult", 700],
          ["child", 700],
          ["adult", 360],
          ["child", 360],
          ["self", 700],
        ]) {
          await setTourniquet(ctx, who === "adult" ? "adult" : null);
          await page.reload();
          await sleep(400);
          await choose(page, who);
          await page.setViewport({ width, height: 900 });
          for (const theme of ["dark", "light"]) {
            // Waits for the map to finish drawing itself in before the screenshot, since a full-page picture
            // restarts its animations.
            await page.emulateMediaFeatures([
              { name: "prefers-color-scheme", value: theme },
              { name: "prefers-reduced-motion", value: "reduce" },
            ]);
            await sleep(250);
            await page.screenshot({
              path: path.join(OUT, `tourniquet-setup-${who}-${width}-${theme}.png`),
              fullPage: true,
            });
          }
        }
      } finally {
        await page.close();
        await setTourniquet(ctx, null);
      }
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );

  await check(
    "TQ21",
    "The printed guide says Tourniquet is on, what it does and that they can always send, never who it's for; nothing about it once it's off",
    async () => {
      const read = async (pictures = false) => {
        const page = await openSetup("share.html");
        try {
          for (const theme of pictures ? ["dark", "light"] : []) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            await (await page.$(".guide")).screenshot({ path: path.join(OUT, `tourniquet-guide-${theme}.png`) });
          }
          return await page.evaluate(() => {
            const p = document.getElementById("guide-tq");
            return p && !p.hidden ? p.textContent.replace(/\s+/g, " ").trim() : null;
          });
        } finally {
          await page.close();
        }
      };
      try {
        await setTourniquet(ctx, "adult");
        const adult = await read(true);
        expect(
          /^Tourniquet is on /.test(adult || "") && /You can always leave them in and send/.test(adult),
          `grown-up: ${adult}`,
        );
        await setTourniquet(ctx, "child");
        const child = await read();
        expect(child && child !== adult, `child: ${child}`);
        for (const text of [adult, child])
          expect(
            !/child|grown-up|adult|teen|elder|older/i.test(text.replace(/an adult you trust/, "")),
            `names a preset: ${text}`,
          );
        await setTourniquet(ctx, null);
        expect((await read()) === null, "the guide talks about Tourniquet while it's off");
      } finally {
        await setTourniquet(ctx, null);
      }
    },
  );

  // ---------- After a scam (Scam Shield): Tourniquet for 30 days, then it steps down by itself ----------

  await check(
    "TQ24",
    "After a scam on an AI chat: a card number asks first, larger, with the after-a-scam line; a texted code gets who really asks for it; a phone number the larger note",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await setAfterScam(ctx);
        try {
          await typeText(page, `my card is ${CARD}`);
          const d = await waitForDialog(page);
          expect(d, "no Ask before sending for a card number");
          expect(AFTER_SCAM_LINE.test(d.text), `no after-a-scam line: ${d.text}`);
          expect(!MONEY_LINE.test(d.text), `the grown-up's line too: ${d.text}`);
          expect((await uiClasses(page, "CLOTR-GUARD")).has("large"), "the dialog isn't larger");
          await page.screenshot({ path: path.join(OUT, "tourniquet-after-scam-dialog.png") });
          await clickDialogButton(page, "Hide it");
          await clearEditor(page);
          await typeText(page, "ok, the code they texted me is 482913");
          const c = await waitForDialog(page);
          // The code's own line replaces Tourniquet's codes line, so the dialog shows only one, never both.
          expect(c && /Who asks for a code that was sent to you?/.test(c.text), `no who-asks line: ${c?.text}`);
          expect(!CODES_LINE.test(c.text) && !AFTER_SCAM_LINE.test(c.text), `two lines: ${c.text}`);
          await clickDialogButton(page, "Hide it");
          await clearEditor(page);
          await typeText(page, `call me at ${PHONE}`);
          const n = await waitForNotice(page);
          expect(n && AFTER_SCAM_LINE.test(n.text), `no line in the corner note: ${n?.text}`);
          expect(!(await readDialog(page)), "a phone number asked first");
          expect((await uiClasses(page, "CLOTR-NOTICE")).has("large"), "the corner note isn't larger");
        } finally {
          await clearAfterScam(ctx);
          await resetState(ctx);
        }
      }),
  );

  await check(
    "TQ26",
    "The end: at the stored end the background turns it off, an open tab steps down within 2 seconds, and the end is kept for the popup",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await setAfterScam(ctx, 29);
        try {
          const set = await ctx.worker.evaluate(async () => ({
            alarm: (await chrome.alarms.get("tourniquet-end"))?.scheduledTime,
            until: (await chrome.storage.local.get("tourniquet")).tourniquet?.until,
          }));
          expect(set.alarm && set.alarm === set.until, `the end alarm: ${JSON.stringify(set)}`);
          await typeText(page, `my card is ${CARD}`);
          expect(await waitForDialog(page), "no Ask before sending while it's on");
          await clickDialogButton(page, "Hide it");
          await clearEditor(page);
          // Moves the stored end to a moment ago to simulate the end arriving. The background's own watch on
          // the record notices this the same way it would notice the end alarm firing.
          await ctx.worker.evaluate(() =>
            enqueue(async () => {
              const { tourniquet: t } = await chrome.storage.local.get("tourniquet");
              await chrome.storage.local.set({ tourniquet: { ...t, until: Date.now() - 1000 } });
            }),
          );
          const started = Date.now();
          const ended = await waitFor(async () => {
            const s = await store.get(ctx, ["tourniquet", "tourniquetEnded"]);
            return !s.tourniquet && s.tourniquetEnded ? s.tourniquetEnded : null;
          }, 2000);
          expect(
            ended && Number.isFinite(ended.at) && Number.isFinite(ended.since),
            `the end: ${JSON.stringify(ended)}`,
          );
          await sleep(Math.max(0, 1500 - (Date.now() - started)));
          await typeText(page, `my card is ${CARD}`);
          const n = await waitForNotice(page);
          expect(n && !(await readDialog(page)), "the tab still asks first after the end");
          expect(!AFTER_SCAM_LINE.test(n.text) && !/Tourniquet/.test(n.text), `still Tourniquet's line: ${n.text}`);
          expect(!(await uiClasses(page, "CLOTR-NOTICE")).has("large"), "still larger after the end");
          const alarm = await ctx.worker.evaluate(async () => Boolean(await chrome.alarms.get("tourniquet-end")));
          expect(!alarm, "the end alarm outlived the end");
        } finally {
          await clearAfterScam(ctx);
          await resetState(ctx);
        }
      }),
  );

  // Formats a day the way the setup page and popup do, with the browser's own locale formatting (e.g. "2 October").
  const dayName = (page, t) =>
    page.evaluate(
      (x) => new Date(x).toLocaleDateString(chrome.i18n.getUILanguage(), { day: "numeric", month: "long" }),
      t,
    );
  const afterScamState = (page) =>
    page.evaluate(() => {
      const shown = (n) => Boolean(n && !n.hidden && n.offsetParent);
      const now = document.getElementById("ss-now");
      const tiles = [...document.querySelectorAll("#who .tq-tile")];
      return {
        tiles: tiles.map((t) => t.querySelector(".tq-tile-title").textContent),
        wide:
          tiles.length === 3 && tiles[2].getBoundingClientRect().width > tiles[0].getBoundingClientRect().width * 1.5,
        map: shown(document.getElementById("tq-map")),
        days: shown(document.getElementById("tq-days")),
        today: document.getElementById("tq-days-start")?.textContent.trim(),
        end: document.getElementById("tq-days-end")?.textContent.trim(),
        segments: document.querySelectorAll("#tq-days .tq-track > span").length,
        marked: [...document.querySelectorAll("#tq-days .tq-track > span")]
          .map((x) => x.className)
          .join(" ")
          .trim(),
        trackHidden: document.querySelector("#tq-days .tq-track")?.getAttribute("aria-hidden"),
        then: shown(document.getElementById("tq-then")),
        now: shown(now),
        nowRows: [...(now?.querySelectorAll("li span:first-child") || [])].map((b) => b.textContent.trim()),
        links: [...(now?.querySelectorAll("a") || [])].map((a) => [a.textContent, a.href, a.target]),
        keepsNothing: shown(document.getElementById("ss-now-keeps")),
        tag: document.querySelector("#who .ss-tag")?.textContent.trim(),
      };
    });

  await check(
    "TQ22",
    "Setup page: a third, full-width tile; choosing it shows Turn on Tourniquet for 30 days, the 30-day track to the end date, and What to do now",
    async () => {
      await clearAfterScam(ctx);
      const page = await openSetup();
      try {
        const before = await afterScamState(page);
        expect(
          JSON.stringify(before.tiles) ===
            JSON.stringify(["A child or teen", "A grown-up", "Someone who was just scammed, or nearly"]),
          `tiles: ${JSON.stringify(before.tiles)}`,
        );
        expect(before.wide, "the third tile isn't full width");
        expect(before.tag === "Scam check", `the tile's tag: ${before.tag}`);
        await choose(page, "child"); // a choice before: none of its own words stay behind
        await choose(page, "after_scam");
        const hint = await page.$eval("#tq-words-hint", (p) => !p.hidden);
        expect(!hint, "the child preset's hint about their school shows for the 30 days");
        const s = await setupState(page);
        expect(
          JSON.stringify(s.steps) === JSON.stringify(["step-who", "step-tq", "step-vault", "step-apps", "step-pin"]),
          `steps: ${s.steps}`,
        );
        expect(s.title === "Turn on Tourniquet for 30 days", `title: ${s.title}`);
        expect(s.on === "Turn on for 30 days" && s.onShown && !s.off, `button: ${JSON.stringify(s)}`);
        expect(s.how && !s.done, "How it works isn't there");
        expect(s.ticked.join() === "Gmail,Outlook,Yahoo Mail,WhatsApp,Messenger", `apps: ${s.ticked}`);
        expect(/^Pick the PIN together/.test(s.pinText), `PIN: ${s.pinText}`);
        const a = await afterScamState(page);
        const now = Date.now();
        expect(!a.map && a.days && a.then, `the track, not the map: ${JSON.stringify(a)}`);
        expect(a.today === `Today, ${await dayName(page, now)}`, `today: ${a.today}`);
        expect(a.end === `Steps down on ${await dayName(page, now + 30 * 86400000)}`, `end: ${a.end}`);
        expect(a.segments === 30 && a.marked === "today" && a.trackHidden === "true", `track: ${JSON.stringify(a)}`);
        expect(a.now && a.keepsNothing, "no What to do now");
        expect(
          JSON.stringify(a.nowRows) ===
            JSON.stringify([
              "Paid with a gift card?",
              "Let someone into your computer?",
              "Gave a password or a sign-in code?",
              "Someone offers to get your money back for a fee?",
              "In the US,",
            ]),
          `rows: ${JSON.stringify(a.nowRows)}`,
        );
        expect(
          JSON.stringify(a.links) ===
            JSON.stringify([
              ["ReportFraud.ftc.gov", "https://reportfraud.ftc.gov/", "_blank"],
              ["IdentityTheft.gov", "https://www.identitytheft.gov/", "_blank"],
            ]),
          `links: ${JSON.stringify(a.links)}`,
        );
        // Takes a picture at a phone's width and a computer's, dark theme first, once the tile and step 2 have
        // settled.
        for (const width of [380, 1040]) {
          await page.setViewport({ width, height: 900 });
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([
              { name: "prefers-color-scheme", value: theme },
              { name: "prefers-reduced-motion", value: "reduce" },
            ]);
            await sleep(250);
            await page.screenshot({ path: path.join(OUT, `after-scam-setup-${width}-${theme}.png`), fullPage: true });
          }
        }
      } finally {
        await page.close();
      }
      // Following a link from another page, such as Is this a scam?, should land with the third tile already chosen.
      const linked = await openSetup("helper.html?for=after_scam#who");
      try {
        const at = await linked.evaluate(() => ({
          chosen: document.querySelector('#who input[name="who"]:checked')?.value,
          focus: document.activeElement?.value,
          days: !document.getElementById("tq-days").hidden,
        }));
        expect(at.chosen === "after_scam" && at.focus === "after_scam" && at.days, `linked: ${JSON.stringify(at)}`);
      } finally {
        await linked.close();
      }
    },
  );

  await check(
    "TQ23",
    "Turn on for 30 days stores exactly { for, since, until } 30 days apart and nothing else of theirs; then day 1 of 30 and the end date; off takes two clicks",
    async () => {
      await resetState(ctx, { phone_number: "log", email: "block" });
      await clearAfterScam(ctx);
      await store.set(ctx, { largeText: false, siteModes: { "chatgpt.com": "log" }, guided: { email: 1 } });
      const own = async () => JSON.stringify(await store.get(ctx, ["responses", "largeText", "siteModes"]));
      const before = await own();
      const page = await openSetup();
      try {
        await choose(page, "after_scam");
        await page.click("#tq-on");
        const t = await waitFor(async () => (await store.get(ctx, "tourniquet")).tourniquet || null, 2000);
        expect(
          t && Object.keys(t).sort().join() === "for,since,until" && t.for === "after_scam",
          `stored: ${JSON.stringify(t)}`,
        );
        expect(
          t.until - t.since === 30 * 86400000 && Math.abs(Date.now() - t.since) < 10000,
          `dates: ${JSON.stringify(t)}`,
        );
        expect((await own()) === before, `the person's own settings changed: ${await own()} (was ${before})`);
        expect(!(await store.get(ctx, "guided")).guided, "the first-time tips weren't made to show again");
        await sleep(400);
        const on = await setupState(page);
        const end = await dayName(page, t.until);
        expect(
          on.state === `Tourniquet is on for 30 days after a scam: day 1 of 30, steps down on ${end}.`,
          `state: ${on.state}`,
        );
        expect(!on.onShown && on.off, `after turning it on: ${JSON.stringify(on)}`);
        const a = await afterScamState(page);
        expect(a.today === "Day 1 of 30" && a.end === `Steps down on ${end}`, `track words: ${a.today} / ${a.end}`);
        // Backdates the start by four days, so the track should fill in the days already gone.
        await setAfterScam(ctx, 3);
        await sleep(300);
        const later = await afterScamState(page);
        expect(later.today === "Day 4 of 30", `four days in: ${later.today}`);
        expect(/^(gone ){3}today$/.test(later.marked), `track four days in: ${later.marked}`);
        // Choosing the grown-up's preset from here should offer a switch, with no end date.
        await choose(page, "adult");
        expect((await setupState(page)).on === "Switch to Tourniquet for a grown-up", "no switch to the grown-up's");
        await choose(page, "after_scam");
        await page.click("#tq-off");
        await sleep(300);
        expect((await store.get(ctx, "tourniquet")).tourniquet, "one click turned it off");
        await page.click("#tq-off");
        expect(await waitFor(async () => !(await store.get(ctx, "tourniquet")).tourniquet, 2000), "two clicks didn't");
        expect((await own()) === before, "turning it off changed the person's own settings");
        const left = await waitFor(async () => {
          const s = await store.get(ctx, ["tourniquetSeen", "tourniquetEnded"]);
          return !s.tourniquetSeen && !s.tourniquetEnded ? "clean" : null;
        }, 2000);
        expect(left, "bookkeeping left behind after turning it off");
      } finally {
        await page.close();
        await clearAfterScam(ctx);
        await resetState(ctx);
      }
    },
  );

  // ---------- The popup during and after the 30 days ----------

  // Pictures of the popup as people see it: the whole page at 380 px, and its real size (380 × 600), dark first.
  async function popupShots(popup, name) {
    for (const theme of ["dark", "light"]) {
      await shot(popup, `${name}-380-${theme}.png`, theme);
      await shotAt(popup, `${name}-real-${theme}.png`, { theme });
    }
    await popup.setViewport({ width: 380, height: 700 });
  }

  await check(
    "TQ25",
    "Popup, 30 days after a scam (the start stubbed 3 days back): the chip, Day 4 of 30 on its track, the end date, After a scam pressed; a clock turned back is said, not counted",
    async () => {
      await resetState(ctx);
      await unlockSettings(ctx);
      await setAfterScam(ctx, 3);
      const popup = await openPopup(ctx);
      const card = () =>
        popup.evaluate(() => ({
          title: document.getElementById("tq-title").textContent.trim(),
          day: document.getElementById("tq-day")?.textContent.trim(),
          ends: document.getElementById("tq-ends")?.textContent.trim(),
          since: !document.getElementById("tq-since").hidden,
          count: document.querySelectorAll("#tq-days .tq-track > span").length,
          marks: [...document.querySelectorAll("#tq-days .tq-track > span")]
            .map((x) => x.className)
            .join(" ")
            .trim(),
          hidden: document.querySelector("#tq-days .tq-track")?.getAttribute("aria-hidden"),
          clock: document.getElementById("tq-clock")?.hidden === false,
          clockText: document.getElementById("tq-clock")?.textContent.trim(),
          asks: document.getElementById("tq-asks").textContent.trim(),
          notes: document.getElementById("tq-notes").textContent.trim(),
          pressed: [...document.querySelectorAll("#tq-switch button")]
            .filter((b) => b.getAttribute("aria-pressed") === "true")
            .map((b) => b.textContent.trim()),
        }));
      try {
        const overview = await popup.evaluate(() => ({
          chip: Boolean(document.getElementById("tq-chip").offsetParent),
          line: document.getElementById("tq-line-text").textContent.trim(),
        }));
        expect(overview.chip, "no Tourniquet on chip");
        expect(
          overview.line ===
            "Tourniquet is on for 30 days after a scam: Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out. Clotr sends nothing anywhere.",
          `Overview line: ${overview.line}`,
        );
        await popupShots(popup, "after-scam-popup-overview");
        await popup.click("#tab-settings");
        await sleep(200);
        const end = await dayName(popup, (await store.get(ctx, "tourniquet")).tourniquet.until);
        const c = await card();
        expect(c.title === "Tourniquet: 30 days after a scam", `title: ${c.title}`);
        expect(c.day === "Day 4 of 30" && c.ends === `Steps down on ${end}`, `days: ${c.day} / ${c.ends}`);
        expect(!c.since, "the On since line shows as well");
        expect(c.count === 30 && /^(gone ){3}today$/.test(c.marks) && c.hidden === "true", `track: ${c.marks}`);
        expect(!c.clock, "the clock note shows while the clock is right");
        expect(
          c.asks ===
            "Clotr asks before these go out: bank, card and ID numbers, gift card numbers, Medicare and insurance numbers, birthdays, passwords and sign-in codes.",
          `asks: ${c.asks}`,
        );
        expect(/^Warnings are larger\./.test(c.notes), `notes: ${c.notes}`);
        expect(c.pressed.join() === "After a scam", `pressed: ${c.pressed}`);
        await popupShots(popup, "after-scam-popup-settings");
        // Turns the clock back a week. The stored dates should stay exactly where they are, and the card
        // should say so.
        await store.set(ctx, { tourniquetSeen: Date.now() + 7 * 86400000 });
        const back = await waitFor(async () => ((await card()).clock ? card() : null), 2000);
        expect(
          back?.clockText ===
            `This computer's clock was turned back. Clotr keeps its own dates, so the 30 days end when this clock reaches ${end}.`,
          `clock note: ${back?.clockText}`,
        );
        expect(back.day === "Day 4 of 30" && back.ends === `Steps down on ${end}`, "the days moved with the clock");
        expect(
          JSON.stringify((await store.get(ctx, "tourniquet")).tourniquet.until) ===
            JSON.stringify(
              await ctx.worker.evaluate(async () => (await chrome.alarms.get("tourniquet-end"))?.scheduledTime),
            ),
          "the end alarm isn't at the stored end",
        );
        await popupShots(popup, "after-scam-popup-clock");
        // Switching to the grown-up's preset should leave it on with no end. Switching back to after a scam
        // should start a fresh 30 days from now.
        await popup.click('#tq-switch button[data-for="adult"]');
        const adult = await waitFor(async () => {
          const t = (await store.get(ctx, "tourniquet")).tourniquet;
          return t?.for === "adult" ? t : null;
        }, 2000);
        expect(adult && Object.keys(adult).sort().join() === "for,since", `for a grown-up: ${JSON.stringify(adult)}`);
        await popup.click('#tq-switch button[data-for="after_scam"]');
        const again = await waitFor(async () => {
          const t = (await store.get(ctx, "tourniquet")).tourniquet;
          return t?.for === "after_scam" ? t : null;
        }, 2000);
        expect(
          again && again.until - again.since === 30 * 86400000 && Math.abs(Date.now() - again.since) < 10000,
          `after a scam again: ${JSON.stringify(again)}`,
        );
        // The printed guide (SS17) says the end date, what it asks about, and that they can always send anyway.
        // It never says who it's for or why, since there should be no word of a scam on a page that sits next
        // to their computer.
        const until = await dayName(popup, again.until);
        const guide = await openSetup("share.html");
        try {
          const text = await guide.evaluate(() => {
            const p = document.getElementById("guide-tq");
            return p && !p.hidden ? p.textContent.replace(/\s+/g, " ").trim() : null;
          });
          expect(
            text ===
              `Tourniquet is on Until ${until}, Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out, and its warnings are bigger. You can always leave them in and send.`,
            `the guide: ${text}`,
          );
          expect(!/scam|child|grown-up|adult/i.test(text), `the guide says who or why: ${text}`);
          for (const theme of ["dark", "light"]) {
            await guide.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            await (await guide.$(".guide")).screenshot({ path: path.join(OUT, `after-scam-guide-${theme}.png`) });
          }
        } finally {
          await guide.close();
        }
        // What Clotr stores should show the record with both dates, plus a note of the end and the latest
        // time seen for bookkeeping.
        const stored = await openExtPage(ctx, "stored.html");
        const row = (list, label) =>
          stored.evaluate(
            (l, k) => {
              const dt = [...document.querySelectorAll(`#${l} dt`)].find((d) => d.textContent === k);
              return dt?.nextElementSibling?.textContent ?? null;
            },
            list,
            label,
          );
        try {
          const since = await dayName(stored, again.since);
          const settingsRow = await waitFor(() => row("settings", "Tourniquet"), 2000);
          expect(
            settingsRow ===
              `After a scam, since ${since}, until ${until}. Clotr asks before bank, card and ID numbers, gift card numbers, passwords and sign-in codes go out.`,
            `Tourniquet's row: ${settingsRow}`,
          );
          const seen = await row("other", "Latest time seen during Tourniquet's 30 days");
          expect(/^.+\. The latest time this computer's clock showed/.test(seen || ""), `seen: ${seen}`);
          expect((await row("other", "End of Tourniquet's 30 days")) === "—", "an end with none");
          await endAfterScam(ctx);
          const ended = await waitFor(async () => {
            const r = await row("other", "End of Tourniquet's 30 days");
            return r && r !== "—" ? r : null;
          }, 2000);
          expect(/^.+\. Kept until you answer the note about it in Clotr's popup/.test(ended || ""), `end: ${ended}`);
          expect((await row("settings", "Tourniquet")) === "Off", "Tourniquet's row once it's over");
          const reach = await stored.evaluate(
            () => document.querySelector('#permissions dt[data-permission="alarms"]')?.nextElementSibling.textContent,
          );
          expect(/Tourniquet's 30 days/.test(reach || ""), `what the alarms permission is for: ${reach}`);
          await stored.setViewport({ width: 380, height: 900 });
          for (const theme of ["dark", "light"]) {
            await stored.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(200);
            await (await stored.$("#other")).screenshot({ path: path.join(OUT, `after-scam-stored-${theme}.png`) });
          }
        } finally {
          await stored.close();
        }
      } finally {
        await popup.close();
        await clearAfterScam(ctx);
        await resetState(ctx);
      }
    },
  );

  await check(
    "TQ27",
    "The end card, said once at the top before what's new: Keep it 30 more days, Keep Tourniquet for a grown-up instead and Got it each close it for good, with no PIN",
    async () => {
      await resetState(ctx);
      await clearAfterScam(ctx);
      const { lastUpdate } = await store.get(ctx, "lastUpdate");
      const read = (popup) =>
        popup.evaluate(() => {
          const c = document.getElementById("tq-end");
          return {
            shown: Boolean(c && !c.hidden && c.offsetParent),
            title: document.getElementById("tq-end-title")?.textContent.trim(),
            text: c?.querySelector("p")?.textContent.trim(),
            buttons: [...(c?.querySelectorAll("button") || [])].map((b) => b.textContent.trim()),
            whatsNew: !document.getElementById("whats-new").hidden,
            above: c && c.getBoundingClientRect().bottom <= document.getElementById("site").getBoundingClientRect().top,
          };
        });
      // An update's note is waiting too, and settings are locked. The end card should still come first and
      // work without the PIN.
      await store.set(ctx, { lastUpdate: { from: "1.1.0", to: "1.2.0", t: Date.now(), seen: false } });
      await endAfterScam(ctx);
      await lockSettings(ctx);
      try {
        let popup = await openPopup(ctx);
        try {
          const card = await read(popup);
          expect(card.shown && card.above && !card.whatsNew, `the card: ${JSON.stringify(card)}`);
          expect(card.title === "Tourniquet's 30 days are over", `title: ${card.title}`);
          expect(
            card.text === "Clotr is back to how it was before. If the scammers are still in touch, keep it on longer.",
            `text: ${card.text}`,
          );
          expect(
            card.buttons.join(" | ") === "Keep it 30 more days | Got it | Keep Tourniquet for a grown-up instead",
            `buttons: ${card.buttons.join(" | ")}`,
          );
          await popupShots(popup, "after-scam-popup-end");
          await popup.click("#tq-end-more");
          const t = await waitFor(async () => {
            const s = await store.get(ctx, ["tourniquet", "tourniquetEnded"]);
            return s.tourniquet?.for === "after_scam" && !s.tourniquetEnded ? s.tourniquet : null;
          }, 2000);
          expect(
            t && t.until - t.since === 30 * 86400000 && Math.abs(Date.now() - t.since) < 10000,
            `30 more days: ${JSON.stringify(t)}`,
          );
          await sleep(300);
          const after = await read(popup);
          expect(!after.shown && after.whatsNew, `after: ${JSON.stringify(after)}`);
        } finally {
          await popup.close();
        }
        popup = await openPopup(ctx);
        try {
          expect(!(await read(popup)).shown, "the card came back");
        } finally {
          await popup.close();
        }
        // "Keep Tourniquet for a grown-up instead" should leave it on with no end.
        await endAfterScam(ctx);
        popup = await openPopup(ctx);
        try {
          await popup.click("#tq-end-adult");
          const adult = await waitFor(async () => {
            const s = await store.get(ctx, ["tourniquet", "tourniquetEnded"]);
            return s.tourniquet?.for === "adult" && !s.tourniquetEnded ? s.tourniquet : null;
          }, 2000);
          expect(adult && Object.keys(adult).sort().join() === "for,since", `grown-up: ${JSON.stringify(adult)}`);
        } finally {
          await popup.close();
        }
        // "Got it" should close the card and change nothing else.
        await endAfterScam(ctx);
        popup = await openPopup(ctx);
        try {
          await popup.click("#tq-end-ok");
          const gone = await waitFor(async () => !(await store.get(ctx, "tourniquetEnded")).tourniquetEnded, 2000);
          expect(gone, "Got it left the end's note");
          expect(!(await store.get(ctx, "tourniquet")).tourniquet, "Got it turned Tourniquet on");
          await sleep(200);
          expect(!(await read(popup)).shown, "the card stayed after Got it");
        } finally {
          await popup.close();
        }
      } finally {
        await unlockSettings(ctx);
        await clearAfterScam(ctx);
        await ctx.worker.evaluate(
          (u) => (u ? chrome.storage.local.set({ lastUpdate: u }) : chrome.storage.local.remove("lastUpdate")),
          lastUpdate || null,
        );
      }
    },
  );

  await check(
    "TQ29",
    "Spanish browser: the third tile, step 2 and What to do now, the popup's card, the end card and the warning's line",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      const at = (file) => `chrome-extension://${new URL(es.swTarget.url()).host}/${file}`;
      try {
        await resetState(es, {});
        const setup = await es.browser.newPage();
        try {
          await setup.setViewport({ width: 380, height: 900 });
          await setup.goto(at("helper.html?for=after_scam"));
          await setup.evaluate(() => document.fonts.ready);
          await sleep(500);
          const got = await setup.evaluate(() => ({
            tile: document.getElementById("who-after-scam").textContent.trim(),
            title: document.getElementById("tq-title").textContent.trim(),
            start: document.getElementById("tq-days-start").textContent.trim(),
            end: document.getElementById("tq-days-end").textContent.trim(),
            button: document.getElementById("tq-on").textContent.trim(),
            now: document.getElementById("ss-now-title").textContent.trim(),
            first: document.querySelector("#ss-now li span").textContent.trim(),
            text: document.body.innerText,
          }));
          expect(got.tile === "Alguien a quien acaban de estafar, o casi", `tile: ${got.tile}`);
          expect(got.title === "Activa Tourniquet durante 30 días", `title: ${got.title}`);
          expect(
            /^Hoy, \d+ de \S+$/.test(got.start) && /^Se desactiva el \d+ de \S+$/.test(got.end),
            `dates: ${got.start} / ${got.end}`,
          );
          expect(got.button === "Activar durante 30 días", `button: ${got.button}`);
          expect(got.now === "Qué hacer ahora" && got.first === "¿Pagaste con una tarjeta regalo?", `now: ${got.now}`);
          expect(!/What to do now|Turn on for 30 days|Someone who was just scammed/.test(got.text), "English left");
          for (const theme of ["dark", "light"]) {
            await setup.emulateMediaFeatures([
              { name: "prefers-color-scheme", value: theme },
              { name: "prefers-reduced-motion", value: "reduce" },
            ]);
            await sleep(200);
            await setup.screenshot({ path: path.join(OUT, `after-scam-setup-es-380-${theme}.png`), fullPage: true });
          }
        } finally {
          await setup.close();
        }
        await setAfterScam(es, 3);
        let popup = await openPopup(es);
        try {
          await popup.click("#tab-settings");
          await sleep(200);
          const card = await popup.evaluate(() => ({
            title: document.getElementById("tq-title").textContent.trim(),
            day: document.getElementById("tq-day").textContent.trim(),
            pressed: document.querySelector('#tq-switch [aria-pressed="true"]')?.textContent.trim(),
          }));
          expect(card.title === "Tourniquet: 30 días después de una estafa", `title: ${card.title}`);
          expect(card.day === "Día 4 de 30", `day: ${card.day}`);
          expect(card.pressed === "Después de una estafa", `switch: ${card.pressed}`);
          await popupShots(popup, "after-scam-popup-settings-es");
        } finally {
          await popup.close();
        }
        await withSite(es, "chatgpt", async (page) => {
          await typeText(page, `mi tarjeta es ${CARD}`);
          const d = await waitForDialog(page);
          expect(
            d && /Los estafadores suelen volver diciendo que pueden recuperar tu dinero/.test(d.text),
            `line: ${d?.text}`,
          );
        });
        await endAfterScam(es);
        popup = await openPopup(es);
        try {
          const end = await popup.evaluate(() => ({
            title: document.getElementById("tq-end-title").textContent.trim(),
            buttons: [...document.querySelectorAll("#tq-end button")].map((b) => b.textContent.trim()),
          }));
          expect(end.title === "Los 30 días de Tourniquet terminaron", `end: ${end.title}`);
          expect(
            end.buttons.join(" | ") === "Mantenerlo 30 días más | Entendido | Mantener Tourniquet para un adulto",
            `end buttons: ${end.buttons.join(" | ")}`,
          );
          await popupShots(popup, "after-scam-popup-end-es");
        } finally {
          await popup.close();
        }
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // ---------- A phone, touch, Tourniquet's own choices on the setup page ----------

  // The two common phone widths. The page is opened with a touch, mobile viewport already set, before it loads.
  const PHONES = [360, 390];
  const phoneViewport = (width) => ({
    viewport: { width, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  });
  async function openOnPhone(file, width) {
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`${file} error: ${err.message}`));
    await page.setViewport(phoneViewport(width).viewport);
    await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/${file}`);
    await page.evaluate(() => document.fonts.ready); // Clotr's own font is wider than the fallback
    await sleep(600);
    return page;
  }
  // Measures what a finger could actually tap, what the browser would zoom in on, and whether anything runs
  // off the side of the screen.
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
    const targets = [
      ...document.querySelectorAll(
        'button, select, summary, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), a.btn, [role="button"]:not(svg *), label:has(> input[type="checkbox"])',
      ),
    ].filter(shown);
    const small = targets
      .map((n) => [n, n.getBoundingClientRect()])
      .filter(([, r]) => r.height < 43.5 || r.width < 43.5)
      .map(([n, r]) => `${name(n)} ${Math.round(r.width)}×${Math.round(r.height)}`);
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

  await check(
    "TQ20",
    "Phones (360 and 390 px, touch): the setup page fits with each Tourniquet choice, thumb-sized controls and text that doesn't zoom; the map becomes its list",
    async () => {
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.remove(["lock", "tourniquet"]),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      for (const width of PHONES) {
        const page = await openOnPhone("helper.html", width);
        try {
          expectPageFit(await page.evaluate(measurePage), width, "the setup page");
          for (const who of ["adult", "child", "after_scam", "self"]) {
            await page.tap(`#who input[value="${who}"]`);
            await sleep(300);
            expect(await page.$eval(`#who input[value="${who}"]`, (r) => r.checked), `tapping ${who} didn't choose it`);
            expectPageFit(await page.evaluate(measurePage), width, `the setup page, ${who}`);
            if (who === "adult" || who === "child") {
              const map = await page.evaluate(() => ({
                lines: Boolean(document.querySelector(".tq-map-lines")?.getBoundingClientRect().width),
                list: document.getElementById("tq-map-list").getBoundingClientRect().width,
              }));
              expect(!map.lines && map.list > 200, `on a phone the map should be its list: ${JSON.stringify(map)}`);
            }
            // Waits for the list to settle before the screenshot, since a full-page screenshot would restart its animation.
            for (const theme of width === 360 ? ["dark", "light"] : []) {
              await page.emulateMediaFeatures([
                { name: "prefers-color-scheme", value: theme },
                { name: "prefers-reduced-motion", value: "reduce" },
              ]);
              await sleep(200);
              await page.screenshot({
                path: path.join(OUT, `phone-setup-${who}-${width}-${theme}.png`),
                fullPage: true,
              });
            }
          }
        } finally {
          await page.close();
        }
      }
    },
  );
};
