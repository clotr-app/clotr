// E2E checks: Accessibility: axe-core on every Clotr page, light and dark. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    OUT,
    TYPED_VALUES,
    auditShadow,
    check,
    ctx,
    editorText,
    expect,
    fs,
    openExtPage,
    openPopup,
    path,
    pressEnter,
    readUI,
    resetState,
    seedEvents,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
    holdDir,
    dropDir,
    attachText,
    stubReader,
    readStarted,
  } = env;
  await check(
    "A11Y1",
    "No serious accessibility problems (axe-core) in the popup tabs and the welcome/vault page, light and dark",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); // Evaluated through DevTools, since extension pages' CSP blocks script tags.
      // One event is marked `via: "bandage"` so the dashboard's "What Bandage kept from each AI" section renders.
      await store.set(ctx, {
        events: [
          ...seedEvents(),
          {
            t: Date.now(),
            site: "chatgpt.com",
            type: "phone_number",
            name: "Phone Number",
            severity: "medium",
            action: "redacted",
            fp: "1000000000000009",
            via: "bandage",
          },
        ],
      });
      const problems = [];
      const audit = async (page, where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map(
                (v) =>
                  `${v.id} (${v.nodes.length}): ${v.nodes
                    .slice(0, 2)
                    .map((n) => n.target.join(" "))
                    .join(", ")}`,
              ),
          );
          problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      // After an update, for someone who had Clotr before: the email and chat card shows at the top, first with
      // nothing ticked, then with two.
      const { everydayOffer } = await store.get(ctx, "everydayOffer");
      await store.set(ctx, { everydayOffer: "popup" });
      const offer = await openPopup(ctx);
      try {
        await audit(offer, "popup email and chat card");
        await offer.click('#everyday-offer input[value="Gmail"]');
        await offer.click('#everyday-offer input[value="Slack"]');
        await audit(offer, "popup email and chat card, two ticked");
      } finally {
        await offer.close();
        await store.set(ctx, { everydayOffer: everydayOffer ?? "welcome" });
      }
      // After an update, the short "what's new" card shows at the top, first closed and then open.
      const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
      await store.set(ctx, { lastUpdate: { from: "1.0.0", to: version, t: Date.now(), seen: false } });
      const popup = await openPopup(ctx);
      try {
        await audit(popup, "popup what's new, closed");
        await popup.$eval("#whats-new-more", (d) => (d.open = true));
        await audit(popup, "popup what's new, open");
        await store.set(ctx, { lastUpdate: { from: "1.0.0", to: version, t: Date.now(), seen: true } });
        for (const tab of ["overview", "activity", "settings"]) {
          await popup.click(`#tab-${tab}`);
          await sleep(200);
          await audit(popup, `popup ${tab}`);
        }
      } finally {
        await popup.close();
      }
      for (const file of [
        "vault.html?welcome=1",
        "vault.html",
        "stored.html",
        "dashboard.html",
        "helper.html",
        "share.html",
        "policy.html",
        "check.html",
        "practice.html",
        "extcheck.html",
      ]) {
        const page = await openExtPage(ctx, file);
        try {
          await audit(page, file);
        } finally {
          await page.close();
        }
      }
      // Checks the file hold in the chat page under an organization's policy: the corner note while a file is read,
      // the "still checking" question, the file's question with the organization's line, and "Is the file off?".
      // Each one is read from its closed shadow root, in both light and dark.
      const auditUI = async (page, tag, where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          const found = await auditShadow(page, tag);
          if (!found) problems.push(`${where}, ${theme}: not on screen to check`);
          else problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      const guardText = async (page) => (await readUI(page, "CLOTR-GUARD"))?.text || "";
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ preset: "keys_never" });
      });
      try {
        await resetState(ctx, {});
        await withSite(ctx, "chatgpt", async (page) => {
          const dir = holdDir("a11y1");
          try {
            await stubReader(page, "slow", 8000);
            await typeText(page, "why does this deploy fail?");
            await sleep(600);
            await attachText(page, dir, "deploy.env", `AWS_ACCESS_KEY_ID=${KEY}\n`);
            await readStarted(page);
            await pressEnter(page);
            expect(await waitFor(() => readUI(page, "CLOTR-NOTICE"), 2500), "no checking note");
            await auditUI(page, "CLOTR-NOTICE", "checking a file");
            expect(await waitFor(async () => /still checking/.test(await guardText(page)), 4000), "no question");
            await auditUI(page, "CLOTR-GUARD", "still checking a file");
            expect(
              await waitFor(async () => /This file looks private/.test(await guardText(page)), 8000),
              "no file question",
            );
            await auditUI(page, "CLOTR-GUARD", "a file held under a policy");
            await sleep(700);
            await page.keyboard.press("Enter"); // Go back to remove it
            await sleep(300);
            await pressEnter(page);
            expect(await waitFor(async () => /Is the file off/.test(await guardText(page)), 2000), "no second ask");
            await auditUI(page, "CLOTR-GUARD", "is the file off");
          } finally {
            dropDir(dir);
          }
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
      // The command check's own note is held back with it. CG10 in 23-command-check.js audits it against an all-on build.
      await store.set(ctx, { events: [] });
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );

  await check(
    "A11Y2",
    "No serious accessibility problems (axe-core) in Clotr's own chat-page UI: the corner notice, Bandage's hover-to-peek bubble and its hotspot layer, light and dark",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        const problems = [];
        const audit = async (tag, where) => {
          for (const theme of ["light", "dark"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            const found = await auditShadow(page, tag);
            if (found) problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
          }
        };
        await typeText(page, `key ${KEY}`); // Bandage never covers keys, so this still warns
        expect(await waitForNotice(page), "no notice");
        await audit("CLOTR-NOTICE", "corner notice");
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, "call me at 555-555-0123");
        await waitFor(async () => ((await editorText(page)) === "call me at [Phone 1]" ? true : null), 4000);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Sure, I'll call [Phone 1] soon."));
        const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
        expect(spots, "no hotspot layer appeared");
        await audit("CLOTR-SPOTS", "hotspot layer");
        const point = await page.evaluate((label) => {
          const t = [...document.querySelectorAll(".reply")].pop().firstChild;
          const r = document.createRange();
          r.setStart(t, t.nodeValue.indexOf(label));
          r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }, "[Phone 1]");
        await page.mouse.move(point.x, point.y);
        const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
        expect(peek, "no peek bubble appeared");
        await audit("CLOTR-PEEK", "peek bubble");
        await resetState(ctx, {});
        expect(!problems.length, problems.slice(0, 8).join(" | "));
      }),
  );

  // The hint under a file warning ("To keep it private, take the file off before you send") is real text, so it
  // needs a contrast ratio of 4.5:1 against the notice in both themes. This measures the colours the browser
  // actually uses, read from the notice's own closed shadow root, then runs axe on the same notice. Light's colour
  // is the suite kit's --muted, which still clears 4.5:1.
  await check("HINT1", "The file warning's hint line is readable in both themes (4.5:1 or more)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "hint-check.csv");
      const rows = ["name,email", "Dee,dee.hint@example.org"];
      rows.forEach((r) => TYPED_VALUES.add(r));
      fs.writeFileSync(file, rows.join("\n"));
      try {
        await (await page.$("#attach")).uploadFile(file);
        expect(await waitForNotice(page), "no notice for the attached file");
      } finally {
        fs.rmSync(file, { force: true });
      }
      page.cdp ??= await page.createCDPSession();
      const colours = async () => {
        const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        let shadow = null;
        (function find(n) {
          if (shadow) return;
          if (n.nodeName === "CLOTR-NOTICE") shadow = (n.shadowRoots || [])[0];
          for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
        })(root);
        expect(shadow, "no notice shadow root");
        const { object } = await page.cdp.send("DOM.resolveNode", { nodeId: shadow.nodeId });
        const { result } = await page.cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function() {
              const hint = this.querySelector(".hint");
              const box = this.querySelector(".notice");
              if (!hint || !box) return null;
              const b = getComputedStyle(box);
              return { fg: getComputedStyle(hint).color, bg: b.backgroundColor, image: b.backgroundImage };
            }`,
          returnByValue: true,
        });
        return result.value;
      };
      // WCAG 2 contrast is the relative luminance of each colour, (lighter + 0.05) / (darker + 0.05).
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
      const lum = ([r, g, b]) => {
        const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const measured = {};
      const problems = [];
      for (const theme of ["dark", "light"]) {
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
        await sleep(150);
        const c = await colours();
        expect(c, `${theme}: no hint line in the file warning`);
        // This is a plain background colour, or else every colour stop of the gradient, since the worst one counts.
        const bg = rgb(c.bg);
        const stops =
          bg.length === 4 && bg[3] === 0 ? [...c.image.matchAll(/rgba?\([^)]*\)/g)].map((m) => rgb(m[0])) : [bg];
        expect(stops.length, `${theme}: can't read the notice's background (${c.bg} / ${c.image})`);
        measured[theme] = Math.min(...stops.map((s) => ratio(rgb(c.fg), s)));
        if (theme === "light" && rgb(c.fg).join() !== "94,91,95") problems.push(`light hint colour is ${c.fg}`);
        const found = await auditShadow(page, "CLOTR-NOTICE");
        if (found?.length) problems.push(`${theme}, axe: ${found.join(" | ")}`);
        for (const width of [380, 1280]) {
          await page.setViewport({ width, height: 720 });
          await sleep(150);
          await page.screenshot({ path: path.join(OUT, `notice-file-hint-${theme}-${width}.png`) });
        }
      }
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      const said = `dark ${measured.dark.toFixed(2)}:1, light ${measured.light.toFixed(2)}:1`;
      for (const theme of ["dark", "light"])
        if (measured[theme] < 4.5) problems.push(`${theme} hint contrast below 4.5:1`);
      expect(!problems.length, `${said}; ${problems.join("; ")}`);
      return said;
    }),
  );

  await check("KB1", "Keyboard: Alt+Shift+C jumps to the warning, Enter removes, Esc goes back to the message", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const shortcut = () =>
        ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          handleCommand("focus-notice", tab); // This is what the browser calls for the shortcut.
        });
      const focused = () => page.evaluate(() => document.activeElement?.tagName);
      await typeText(page, "call me at 555-555-0123");
      expect(await waitForNotice(page), "no notice");
      await shortcut();
      await sleep(200);
      expect((await focused()) === "CLOTR-NOTICE", `focus is on ${await focused()}`);
      await page.keyboard.press("Escape");
      expect((await focused()) === "TEXTAREA", `Esc left focus on ${await focused()}`);
      await shortcut();
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(300);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]"), `Enter didn't remove it: "${text}"`);
      const manifest = await ctx.worker.evaluate(
        () => chrome.runtime.getManifest().commands?.["focus-notice"]?.suggested_key?.default,
      );
      expect(manifest === "Alt+Shift+C", `shortcut: ${manifest}`);
    }),
  );

  // Safari before 18 calls the shortcut without saying which tab, so the warning in the tab in front gets focus.
  await check("SAF1", "Keyboard: Alt+Shift+C reaches the warning when the browser names no tab (Safari 17)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const focused = () => page.evaluate(() => document.activeElement?.tagName);
      await typeText(page, "call me at 555-555-0123");
      expect(await waitForNotice(page), "no notice");
      await ctx.worker.evaluate(() => handleCommand("focus-notice"));
      await sleep(300);
      expect((await focused()) === "CLOTR-NOTICE", `focus is on ${await focused()}`);
      await page.keyboard.press("Escape");
      expect((await focused()) === "TEXTAREA", `Esc left focus on ${await focused()}`);
    }),
  );
};
