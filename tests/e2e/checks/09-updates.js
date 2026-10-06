// E2E checks: U. Updates. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    EXT,
    KEY,
    KEY2,
    Skip,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    launch,
    openPopup,
    openSite,
    os,
    path,
    pressEnter,
    resetState,
    sentMessages,
    shot,
    shotAt,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
  } = env;
  // Reads an expression in a freshly reloaded service worker. Its CDP session can attach before the extension's
  // APIs are bound, which once showed up as a flaky "undefined" read in CI (lib.js waits for the same thing at
  // launch). So this waits until chrome.runtime is there, then reads.
  const readReloaded = async (session, expression) =>
    waitFor(async () => {
      const r = await session
        .send("Runtime.evaluate", {
          expression: `typeof chrome === "object" && chrome.runtime?.id ? JSON.stringify(${expression}) : ""`,
          returnByValue: true,
        })
        .catch(() => null);
      return r?.result?.value ? JSON.parse(r.result.value) : null;
    }, 10000);
  await check("U1", 'After an update the popup shows "what\'s new" once', async () => {
    const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
    await store.set(ctx, { lastUpdate: { from: "0.7.5", to: version, t: Date.now(), seen: false } });
    const popup = await openPopup(ctx);
    await popup.$eval("#whats-new-more", (d) => (d.open = true)).catch(() => {}); // The notes are folded away by default; see U3.
    const card = await popup.$eval("#whats-new", (n) => (n.hidden ? null : n.innerText));
    await shot(popup, "popup-whats-new.png");
    await popup.click("#whats-new-ok");
    await sleep(300);
    await popup.close();
    const { lastUpdate } = await store.get(ctx, "lastUpdate");
    expect(card?.includes(`Updated to v${version}`) && card.split("\n").length >= 3, `card: ${card}`);
    expect(lastUpdate.seen === true, "not marked seen");
  });

  // "What's new" stays short: just the title and a "See what's new (4)" line, with the notes folded away until
  // you open them, so the popup stays tight. Opening the list doesn't mark it seen, but clicking Got it does.
  // With no notes, the title shows alone.
  await check(
    "U3",
    "What's new is short: closed until opened, with the release's count; Got it marks it seen",
    async () => {
      const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
      const minor = version.split(".").slice(0, 2).join(".");
      const log = JSON.parse(fs.readFileSync(path.join(EXT, "changelog.json"), "utf8"));
      const due = () => store.set(ctx, { lastUpdate: { from: "1.0.0", to: version, t: Date.now(), seen: false } });
      const seen = async () => (await store.get(ctx, "lastUpdate")).lastUpdate.seen;
      const read = (page) =>
        page.evaluate(() => {
          const card = document.getElementById("whats-new");
          const more = document.getElementById("whats-new-more");
          const items = [...document.querySelectorAll("#whats-new-list li")];
          return {
            shown: !card.hidden,
            height: Math.round(card.getBoundingClientRect().height),
            title: document.getElementById("whats-new-title").textContent,
            summary: more && !more.hidden ? more.querySelector("summary").textContent.trim() : null,
            open: Boolean(more?.open),
            notes: items.length,
            showing: items.filter((li) => li.checkVisibility()).length,
          };
        });
      const open = async (page) => {
        await page.focus("#whats-new-more summary");
        await page.keyboard.press("Enter");
        await sleep(200);
      };
      const notes = log[minor] || [];
      expect(notes.length > 0, `changelog.json has no notes for ${minor}`);

      await due();
      const popup = await openPopup(ctx);
      try {
        const closed = await read(popup);
        expect(closed.shown && !closed.open, `card: ${JSON.stringify(closed)}`);
        expect(closed.summary === `See what's new (${notes.length})`, `summary: ${closed.summary}`);
        expect(closed.notes === notes.length && closed.showing === 0, `notes showing while closed: ${closed.showing}`);
        expect(closed.height <= 80, `the closed card is ${closed.height}px tall`);
        for (const theme of ["light", "dark"])
          await shotAt(popup, `popup-whats-new-closed-${theme}.png`, { theme, height: 600 });
        await open(popup);
        const opened = await read(popup);
        expect(opened.open && opened.showing === notes.length, `opened: ${JSON.stringify(opened)}`);
        expect(opened.summary === "Hide the list", `summary when open: ${opened.summary}`);
        for (const theme of ["light", "dark"])
          await shotAt(popup, `popup-whats-new-open-${theme}.png`, { theme, height: 600 });
        expect((await seen()) === false, "opening the list counted as seen");
        await popup.click("#whats-new-ok");
        await sleep(300);
        expect((await seen()) === true, "Got it didn't mark it seen");
        expect(await popup.$eval("#whats-new", (n) => n.hidden), "the card stayed after Got it");
      } finally {
        await popup.close();
      }

      // When changelog.json can't be read, only the title shows, as before.
      await due();
      const bare = await ctx.browser.newPage();
      try {
        await bare.setViewport({ width: 380, height: 600 });
        await bare.evaluateOnNewDocument(() => {
          const real = window.fetch;
          window.fetch = (url, ...rest) =>
            String(url).endsWith("changelog.json") ? Promise.reject(new TypeError("unreadable")) : real(url, ...rest);
        });
        await bare.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
        await bare.waitForSelector("#hero-value");
        await sleep(400);
        const r = await read(bare);
        expect(
          r.shown && r.summary === null && r.title.includes(`Updated to v${version}`),
          `no notes: ${JSON.stringify(r)}`,
        );
      } finally {
        await bare.close();
        await store.set(ctx, { lastUpdate: { from: "1.0.0", to: version, t: Date.now(), seen: true } });
      }

      // In a Spanish browser, the same card shows in Spanish.
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        await es.worker.evaluate(
          (from) =>
            chrome.storage.local.set({
              lastUpdate: { from, to: chrome.runtime.getManifest().version, t: Date.now(), seen: false },
            }),
          "1.0.0",
        );
        const p = await openPopup(es);
        const closedEs = await read(p);
        const count = (log.translations?.es?.[minor] || notes).length;
        expect(closedEs.summary === `Ver las novedades (${count})`, `Spanish summary: ${closedEs.summary}`);
        for (const theme of ["light", "dark"])
          await shotAt(p, `popup-whats-new-closed-es-${theme}.png`, { theme, height: 600 });
        await open(p);
        const openEs = await read(p);
        expect(openEs.summary === "Ocultar la lista", `Spanish summary when open: ${openEs.summary}`);
        for (const theme of ["light", "dark"])
          await shotAt(p, `popup-whats-new-open-es-${theme}.png`, { theme, height: 600 });
        await p.close();
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // A copy of the extension in its own browser, with its version bumped on disk.
  // `before` edits the copy's manifest before it's installed (to start from an older shape).
  async function withChangedCopy(fn, before = null) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const current = fs.readFileSync(path.join(copy, "manifest.json"), "utf8");
    if (before) {
      const m = JSON.parse(current);
      before(m);
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    }
    const other = await launch(copy);
    other.restoreManifest = () => fs.writeFileSync(path.join(copy, "manifest.json"), current);
    const bump = () => {
      const file = path.join(copy, "manifest.json");
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      m.version = "9.9.9";
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
    };
    try {
      return await fn(other, bump, copy);
    } finally {
      await other.browser.close();
      fs.rmSync(other.profile, { recursive: true, force: true });
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("U2", "Update check: no reload when nothing changed, exactly one when the files on disk changed", () =>
    withChangedCopy(async (other, bump) => {
      // Record reload calls instead of restarting, so this runs on every browser.
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const unchanged = await other.worker.evaluate(() => checkForLocalUpdate());
      expect(unchanged === false, "reported an update with nothing changed");
      bump();
      const changed = await other.worker.evaluate(() => checkForLocalUpdate());
      const reloads = await other.worker.evaluate(() => globalThis.__reloads);
      expect(changed === true && reloads === 1, `update detected: ${changed}, reloads: ${reloads}`);
    }),
  );

  await check("U2e", "Live line: a new local-update.txt from a local updater reloads Clotr once, same version", () =>
    withChangedCopy(async (other, bump, dir) => {
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const stamp = path.join(dir, "local-update.txt");
      expect((await other.worker.evaluate(() => checkForLocalUpdate())) === false, "reloaded with no marker");
      fs.writeFileSync(stamp, "abc123 2026-09-29T12:00:00Z\n");
      expect((await other.worker.evaluate(() => checkForLocalUpdate())) === true, "missed the new marker");
      expect((await other.worker.evaluate(() => globalThis.__reloads)) === 1, "not exactly one reload");
    }),
  );

  await check("U2c", "Update waits while a Clotr dialog is open (up to 2 hours), then reloads", () =>
    withChangedCopy(async (other, bump) => {
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const reloads = () => other.worker.evaluate(() => globalThis.__reloads);
      await resetState(other); // This runs before the page opens, so it starts with these settings.
      const page = await openSite(other, "chatgpt");
      try {
        await typeText(page, `key ${KEY}`);
        expect(await waitForDialog(page), "no dialog");
        bump();
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 0,
          "reloaded while the dialog was open",
        );
        await clickDialogButton(page, "Leave it in");
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 1,
          "didn't reload after the dialog was answered",
        );
        // A dialog left open for 2+ hours no longer holds the update back.
        await typeText(page, ` and ${KEY2}`);
        expect(await waitForDialog(page), "no second dialog");
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 90 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 1,
          "gave up waiting after 90 minutes",
        );
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 121 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 2,
          "a long-open dialog held the update back forever",
        );
      } finally {
        await page.close();
      }
    }),
  );

  await check("U2b", "An unpacked copy really restarts into the new version (no network)", () =>
    withChangedCopy(async (other, bump) => {
      if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
        throw new Skip(
          "automated Brave drops any self-reloaded unpacked extension (even with no change); " +
            "real Brave 1.95 reloads fine (checked by hand). Runs on Chrome engines and in CI",
        );
      }
      bump();
      other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // The worker goes away mid-call.
      const fresh = await other.browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
        { timeout: 15000 },
      );
      const version = await readReloaded(await fresh.createCDPSession(), "chrome.runtime.getManifest().version");
      expect(version === "9.9.9", `running version after reload: ${version}`);
    }),
  );

  await check("U2d", "An update that adds the built-in sites' host permissions (0.9.18) keeps Clotr running", () =>
    withChangedCopy(
      async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "needs a real extension reload, which automated Brave drops. Runs on Chrome engines and in CI",
          );
        }
        other.restoreManifest(); // Puts back the current manifest, with host_permissions.
        bump();
        other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {});
        const fresh = await other.browser
          .waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          )
          .catch(() => null);
        expect(fresh, "Clotr didn't come back after the update (disabled for new permissions?)");
        const [version, hosts] = (await readReloaded(
          await fresh.createCDPSession(),
          "[chrome.runtime.getManifest().version, (chrome.runtime.getManifest().host_permissions || []).length]",
        )) || [undefined, undefined];
        expect(version === "9.9.9" && hosts > 0, `after update: version ${version}, host permissions ${hosts}`);
      },
      (m) => {
        delete m.host_permissions;
        m.version = "0.9.17";
      },
    ),
  );

  await check(
    "UP1",
    "After an update, open AI tabs switch to the new version by themselves: the old copy steps aside, no reload",
    () =>
      withChangedCopy(async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "automated Brave drops any self-reloaded unpacked extension; runs on Chrome engines and in CI",
          );
        }
        const page = await openSite(other, "chatgpt");
        try {
          await resetState(other, {}); // This resets to the defaults, which warn.
          await typeText(page, "hello ");
          await sleep(600);
          bump();
          other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // The worker goes away mid-call.
          await other.browser.waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          );
          const started = await waitFor(
            () => page.logs.filter((l) => l.includes("[Clotr] active on")).length >= 2,
            8000,
          );
          expect(
            started,
            `the new version didn't start in the open tab: ${page.logs.filter((l) => l.includes("[Clotr]")).join(" / ")}`,
          );
          // An orphaned copy's console output doesn't reach DevTools, so the notice count below is what shows it
          // stepped aside.
          await typeText(page, "call me at 555-555-0123");
          const notice = await waitForNotice(page);
          expect(notice, "no notice from the new version");
          expect(!notice.text.includes("Reload this page"), `the notice comes from the old copy: ${notice.text}`);
          const counts = await page.evaluate(() => ({
            notices: document.querySelectorAll("clotr-notice").length,
            prompts: document.querySelectorAll("clotr-reload").length,
          }));
          expect(
            counts.notices === 1 && counts.prompts === 0,
            `notices: ${counts.notices}, reload prompts: ${counts.prompts}`,
          );
          await pressEnter(page);
          await sleep(300);
          expect((await sentMessages(page)).length === 1, "didn't send");
        } finally {
          await page.close();
        }
      }),
  );
};
