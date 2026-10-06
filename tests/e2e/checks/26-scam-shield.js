// E2E checks: SN. People find the scam check in one place: a quiet row on the popup's Overview, a section in
// Settings, and doors from pages they already have open. Each door just opens the page it names, and nothing about
// them gets counted, flashed, or saved. TQ28 and PD1 live here too, since the 30-day line and the ways into practice
// use these same doors, and so do WA7 and WA13, since the printed "Never read these out" card belongs to Is this a
// scam? Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { EXT, KEY, OUT, TYPED_VALUES, check, clickNode, ctx, expect, fs, launch, openExtPage, openPopup, path } = env;
  const { readNotice, resetState, seedEvents, shot, shotAt, sleep, store, typeText, waitFor, waitForNotice } = env;
  const { withSite } = env;

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
  const setTourniquet = async (c, word) => {
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
    await sleep(300);
  };

  // Clicks the button or link with this text inside `scope`, waits for the tab it opens at `file`, and returns it.
  async function opens(c, page, scope, label, file) {
    // I don't await this promise yet, so if the button never appears, the check fails with a clear message
    // instead of crashing the whole run.
    const opened = c.browser.waitForTarget((t) => t.url().endsWith(`/${file}`), { timeout: 6000 }).catch(() => null);
    const clicked = await page.evaluate(
      (s, l) => {
        const b = [...document.querySelectorAll(`${s} button, ${s} a`)].find((x) => x.textContent.trim() === l);
        if (!b) return false;
        b.click();
        return true;
      },
      scope,
      label,
    );
    expect(clicked, `no "${label}" in ${scope}`);
    const target = await opened;
    expect(target, `"${label}" didn't open ${file}`);
    return target.page();
  }
  async function opensAndClose(c, page, scope, label, file) {
    const tab = await opens(c, page, scope, label, file);
    await tab?.close();
  }

  // Shoots the popup at its real size (380×600) and again as a full page at 380px wide, in both themes.
  async function popupShots(popup, base) {
    for (const theme of ["dark", "light"]) {
      await shotAt(popup, `${base}-real-${theme}.png`, { width: 380, height: 600, theme });
      await shot(popup, `${base}-380-${theme}.png`, theme);
    }
    await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await popup.setViewport({ width: 380, height: 700 });
  }
  // Scrolls Settings to the scam check's section and shoots it at the popup's real size, the way someone
  // would actually see it.
  async function settingsShots(popup, base) {
    await popup.setViewport({ width: 380, height: 600 });
    await popup.evaluate(() => {
      document.getElementById("ss-settings").scrollIntoView({ block: "start" });
      scrollBy(0, -12); // a little of Bandage above it
    });
    for (const theme of ["dark", "light"])
      await shotAt(popup, `${base}-real-${theme}.png`, { width: 380, height: 600, theme });
    for (const theme of ["dark", "light"]) await shot(popup, `${base}-380-${theme}.png`, theme);
    await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await popup.setViewport({ width: 380, height: 700 });
  }

  // Reads the Overview row's text, whether it's visible, and how big it is.
  const readRow = (popup) =>
    popup.evaluate(() => {
      const r = document.getElementById("ss-row");
      if (!r) return null;
      const box = r.getBoundingClientRect();
      const style = getComputedStyle(r);
      return {
        inOverview: Boolean(r.closest("#panel-overview")),
        visible: r.getClientRects().length > 0 && !r.closest("[hidden]"),
        text: r.innerText.replace(/\s+/g, " ").trim(),
        name: r.querySelector('[data-i18n="ss_name"]')?.textContent.trim() || "",
        label: r.getAttribute("aria-labelledby")
          ? document.getElementById(r.getAttribute("aria-labelledby"))?.textContent.trim()
          : r.getAttribute("aria-label") || "",
        shield: Boolean(r.querySelector("svg")),
        links: [...r.querySelectorAll("button, a")].map((b) => b.textContent.trim()),
        height: Math.round(box.height),
        rows: document.querySelectorAll("#ss-row, .ss-row").length,
        live: r.matches("[aria-live], [role=status], [role=alert]") || Boolean(r.querySelector("[aria-live]")),
        moving: style.animationName !== "none",
        aboveHero:
          r.compareDocumentPosition(document.getElementById("overview-body")) & Node.DOCUMENT_POSITION_FOLLOWING,
        wide: document.documentElement.scrollWidth > innerWidth,
      };
    });

  await check(
    "SN1",
    "The popup's Overview: one quiet row with the shield, Scam check, Is this a scam? and Practice, each opening its page (pictures)",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      await setTourniquet(ctx, null);
      const popup = await openPopup(ctx);
      try {
        const row = await readRow(popup);
        expect(row, "no Scam check row in the Overview");
        expect(row.inOverview && row.visible, `the row isn't on the Overview: ${JSON.stringify(row)}`);
        expect(row.name === "Scam check" && row.label === "Scam check", `name: ${row.name} / ${row.label}`);
        expect(row.shield, "no shield in the row");
        expect(JSON.stringify(row.links) === JSON.stringify(["Is this a scam?", "Practice"]), `links: ${row.links}`);
        // The row should stay quiet: just one slim row, with nothing counted, announced, or animated.
        expect(row.rows === 1 && row.height <= 44, `not one slim row: ${row.rows} rows, ${row.height}px`);
        expect(!/\d/.test(row.text), `the row counts something: ${row.text}`);
        expect(!row.live && !row.moving, "the row announces or moves");
        expect(row.aboveHero, "the row isn't above the numbers");
        expect(!row.wide, "the popup scrolls sideways");
        // The row should only show on the Overview tab, not on Settings.
        await popup.click("#tab-settings");
        await sleep(150);
        expect(!(await readRow(popup)).visible, "the row shows on Settings");
        await popup.click("#tab-overview");
        await sleep(150);
        await opensAndClose(ctx, popup, "#ss-row", "Is this a scam?", "check.html");
        await opensAndClose(ctx, popup, "#ss-row", "Practice", "practice.html");
        await popupShots(popup, "scam-shield-overview-empty");
      } finally {
        await popup.close();
      }
      // With history to show, the row should still be the same one row above the numbers. It should also stay
      // while settings are locked, since neither page changes a setting.
      await store.set(ctx, { events: seedEvents() });
      await lockSettings(ctx);
      const full = await openPopup(ctx);
      try {
        const row = await readRow(full);
        expect(row?.visible && row.rows === 1 && row.aboveHero, `with history, locked: ${JSON.stringify(row)}`);
        await popupShots(full, "scam-shield-overview");
      } finally {
        await full.close();
        await unlockSettings(ctx);
        await resetState(ctx, {});
      }
    },
  );

  // Reads the scam check's whole Settings section at once.
  const readSection = (popup) =>
    popup.evaluate(() => {
      const sec = document.getElementById("ss-settings");
      const toggle = document.getElementById("command-check");
      return {
        h2s: [...document.querySelectorAll("#settings-body h2")].map((h) => h.textContent.trim()),
        visible: Boolean(sec) && sec.getClientRects().length > 0,
        title: sec?.querySelector("h2")?.textContent.trim() || "",
        shield: Boolean(sec?.querySelector("h2 svg")),
        lead: sec?.querySelector(".ss-lead")?.textContent.trim() || "",
        toggleInside: Boolean(sec?.contains(toggle)),
        toggle: toggle?.closest("label")?.textContent.trim() || "",
        means: toggle?.closest("label")?.nextElementSibling?.textContent.trim() || "",
        checked: toggle?.checked,
        buttons: [...(sec?.querySelectorAll(".ss-buttons button") || [])].map((b) => ({
          text: b.textContent.trim(),
          primary: b.classList.contains("primary"),
        })),
        line: (() => {
          const l = document.getElementById("ss-tq30");
          return l ? { text: l.textContent.replace(/\s+/g, " ").trim(), shown: l.getClientRects().length > 0 } : null;
        })(),
        wide: document.documentElement.scrollWidth > innerWidth,
      };
    });

  // Reads the command check's row from the "What Clotr stores" page.
  async function storedSays(c, label) {
    const page = await openExtPage(c, "stored.html");
    try {
      return await waitFor(
        () =>
          page.evaluate((l) => {
            const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent.trim() === l);
            return dt?.nextElementSibling?.textContent.trim() || null;
          }, label),
        3000,
      );
    } finally {
      await page.close();
    }
  }

  await check(
    "SN2",
    "Settings: the scam check's section after Bandage, with its words, the command check's switch (on until switched off, in What Clotr stores and the backup) and its one button (Is this a scam? and Practice stay in the Overview row only)",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      await setTourniquet(ctx, null);
      await ctx.worker.evaluate(() => enqueue(() => chrome.storage.local.remove("commandCheck"))); // never chosen
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const s = await readSection(popup);
        expect(s.visible, "no Scam check section in Settings");
        expect(s.title === "Scam check" && s.shield, `title: ${s.title}`);
        const at = s.h2s.indexOf("Scam check");
        expect(at > 0 && s.h2s[at - 1] === "Bandage", `not right after Bandage: ${s.h2s.join(" / ")}`);
        expect(
          s.lead ===
            "When someone asks for something, Clotr helps. Its warnings say who really asks for codes, card numbers and gift cards.",
          `lead: ${s.lead}`,
        );
        expect(s.toggleInside, "the command check's switch isn't in the section");
        expect(s.toggle === "Check commands I copy on AI chats", `switch: ${s.toggle}`);
        expect(
          s.means ===
            'If a command you copy looks like a "verify you\'re human" trick, Clotr points it out. It looks only at what you copy, and keeps nothing.',
          `under the switch: ${s.means}`,
        );
        expect(s.checked === true, "the command check isn't on by default");
        expect(
          JSON.stringify(s.buttons) === JSON.stringify([{ text: "Print Safety Guide", primary: false }]),
          `buttons: ${JSON.stringify(s.buttons)}`,
        );
        expect(!s.wide, "the popup scrolls sideways");
        // Turning the switch off should be stored, shown on What Clotr stores, and carried by the backup.
        // Then I turn it back on.
        expect((await storedSays(ctx, "Check commands I copy on AI chats")) === "On", "What Clotr stores: not On");
        await popup.click("#command-check");
        await waitFor(async () => (await store.get(ctx, "commandCheck")).commandCheck === false, 2000);
        expect((await storedSays(ctx, "Check commands I copy on AI chats")) === "Off", "What Clotr stores: not Off");
        const carried = await ctx.worker.evaluate(async () => {
          const { Backup } = globalThis.Clotr;
          return [
            Backup.pick(await chrome.storage.local.get(null)).commandCheck,
            Backup.clean({ commandCheck: false }).commandCheck,
          ];
        });
        expect(carried[0] === false && carried[1] === false, `the backup doesn't carry the switch: ${carried}`);
        await popup.click("#command-check");
        await waitFor(async () => (await store.get(ctx, "commandCheck")).commandCheck === true, 2000);
        // Only one button should be left here, since Is this a scam? and Practice moved out to the Overview row.
        await opensAndClose(ctx, popup, "#ss-settings", "Print Safety Guide", "share.html#card");
        await settingsShots(popup, "scam-shield-settings");
      } finally {
        await popup.close();
      }
    },
  );

  await check(
    "SN9",
    "Settings: 'Helping someone set this up?' buttons use the same spacing as Scam check's (the shared .ss-buttons class, not a new one)",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const rows = await popup.evaluate(() => {
          const antibody = document.querySelector("#ss-settings .ss-buttons");
          const h2 = [...document.querySelectorAll("#settings-body h2")].find(
            (h) => h.textContent.trim() === "Helping someone set this up?",
          );
          const helping = h2?.nextElementSibling?.nextElementSibling;
          return {
            antibodyClass: antibody?.className || null,
            helpingClass: helping?.className || null,
            sameClass: Boolean(antibody && helping) && antibody.className === helping.className,
            gapMatches:
              Boolean(antibody && helping) &&
              getComputedStyle(antibody).gap === getComputedStyle(helping).gap &&
              getComputedStyle(antibody).margin === getComputedStyle(helping).margin,
          };
        });
        expect(rows.sameClass, `different class: antibody=${rows.antibodyClass} helping=${rows.helpingClass}`);
        expect(rows.gapMatches, "the two button rows don't share the same spacing");
      } finally {
        await popup.close();
      }
    },
  );

  await check(
    "TQ28",
    "Settings' 30-day line opens the setup page with After a scam chosen; it's hidden while settings are locked or Tourniquet is on",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      await setTourniquet(ctx, null);
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const s = await readSection(popup);
        expect(
          s.line?.shown && s.line.text === "Just had a scam, or a near miss? Tourniquet can ask first for 30 days.",
          `the line: ${JSON.stringify(s.line)}`,
        );
        const setup = await opens(
          ctx,
          popup,
          "#ss-tq30",
          "Tourniquet can ask first for 30 days.",
          "helper.html?for=after_scam#who",
        );
        try {
          await sleep(600);
          const at = await setup.evaluate(() => ({
            chosen: document.querySelector('#who input[name="who"]:checked')?.value,
            steps: !document.getElementById("step-tq").hidden,
            focus: document.activeElement?.value,
          }));
          expect(at.chosen === "after_scam" && at.steps, `the setup page: ${JSON.stringify(at)}`);
          expect(
            await ctx.worker.evaluate(async () => !(await chrome.storage.local.get("tourniquet")).tourniquet),
            "opening the setup page turned Tourniquet on",
          );
        } finally {
          await setup.close();
        }
        // Tourniquet on: the line goes (live, no reload).
        await setTourniquet(ctx, "adult");
        await sleep(300);
        expect(!(await readSection(popup)).line.shown, "the line shows while Tourniquet is on");
        await setTourniquet(ctx, null);
        await sleep(300);
        expect((await readSection(popup)).line.shown, "the line didn't come back after Tourniquet went off");
      } finally {
        await popup.close();
      }
      // Locked: Settings shows the PIN box, and the line isn't there.
      await lockSettings(ctx);
      const locked = await openPopup(ctx);
      try {
        await locked.click("#tab-settings");
        await sleep(200);
        const s = await readSection(locked);
        expect(!s.line?.shown, "the line shows while settings are locked");
      } finally {
        await locked.close();
        await unlockSettings(ctx);
      }
    },
  );

  // ---------- The ways in: the welcome page, the Share page, the setup page's last step, a warning's Why? ----------

  // Shoots one part of the page, with a little margin around it, at 380 and 1040px, in both themes.
  async function partShots(page, selector, base) {
    await page.bringToFront();
    for (const width of [380, 1040]) {
      await page.setViewport({ width, height: 900 });
      for (const theme of ["dark", "light"]) {
        await page.emulateMediaFeatures([
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ]);
        await sleep(200);
        const box = await page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { y: r.top + scrollY, h: r.height };
        }, selector);
        await page.screenshot({
          path: path.join(OUT, `${base}-${width}-${theme}.png`),
          clip: { x: 0, y: Math.max(0, box.y - 48), width, height: box.h + 96 },
          captureBeyondViewport: true,
        });
      }
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.setViewport({ width: 700, height: 900 });
  }
  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  async function fitsAt380(page, where) {
    await page.setViewport({ width: 380, height: 900 });
    await sleep(150);
    expect(!(await sideways(page)), `${where} scrolls sideways at 380px`);
    await page.setViewport({ width: 700, height: 900 });
  }
  // Opens the page and brings it to the front, then waits for its fonts or two seconds, whichever comes first.
  // A tab left in the background can hang waiting for a frame that never arrives on a busy computer.
  async function openPage(c, file) {
    const page = await openExtPage(c, file);
    await page.bringToFront();
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]));
    return page;
  }

  // Reads the welcome page's scam check section at once.
  const readWelcome = (page) =>
    page.evaluate(() => {
      const sec = document.getElementById("ss-welcome");
      return {
        visible: Boolean(sec) && sec.getClientRects().length > 0,
        h2s: [...document.querySelectorAll("#welcome h2")]
          .filter((h) => h.getClientRects().length)
          .map((h) => h.textContent.trim()),
        title: sec?.querySelector("h2")?.textContent.trim() || "",
        shield: Boolean(sec?.querySelector("h2 svg")),
        text: sec?.querySelector("p")?.textContent.trim() || "",
        buttons: [...(sec?.querySelectorAll("button") || [])].map((b) => ({
          text: b.textContent.trim(),
          primary: b.classList.contains("primary"),
        })),
      };
    });

  await check(
    "SN3",
    "The welcome page: the scam check's section under Try it, its words and its two buttons, each opening its page; there while settings are locked too (pictures)",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      const page = await openPage(ctx, "vault.html?welcome=1");
      try {
        const w = await readWelcome(page);
        expect(w.visible, "no Scam check section on the welcome page");
        expect(w.title === "Scam check" && w.shield, `title: ${w.title}`);
        const at = w.h2s.indexOf("Scam check");
        expect(
          at > 0 && w.h2s[at - 1] === "Try it" && w.h2s[at + 1] === "Tell Clotr what to look out for",
          `not under Try it: ${w.h2s.join(" / ")}`,
        );
        expect(
          w.text ===
            "When someone asks you for a code, your card's numbers or gift cards, Clotr's warning says who really asks for them. Got a message that worries you? Clotr can give a second opinion.",
          `words: ${w.text}`,
        );
        expect(
          JSON.stringify(w.buttons) ===
            JSON.stringify([
              { text: "Is this a scam?", primary: true },
              { text: "Practice with six made-up scams", primary: false },
            ]),
          `buttons: ${JSON.stringify(w.buttons)}`,
        );
        await opensAndClose(ctx, page, "#ss-welcome", "Is this a scam?", "check.html");
        await opensAndClose(ctx, page, "#ss-welcome", "Practice with six made-up scams", "practice.html");
        await fitsAt380(page, "The welcome page");
        await partShots(page, "#ss-welcome", "scam-shield-welcome");
        expect(!(await store.events(ctx)).length, "the welcome page's section recorded something");
      } finally {
        await page.close();
      }
      // Even locked by a PIN, the section should stay, since these pages don't change any setting.
      await lockSettings(ctx);
      const locked = await openPage(ctx, "vault.html?welcome=1");
      try {
        expect((await readWelcome(locked)).visible, "the section hides while settings are locked");
      } finally {
        await locked.close();
        await unlockSettings(ctx);
      }
    },
  );

  // Reads the Share page's headings, the card's tag, and its practice lines.
  const readShare = (page) =>
    page.evaluate(() => {
      const screen = document.querySelector("section.no-print");
      const card = document.getElementById("card");
      const tag = card?.nextElementSibling?.querySelector(".ss-tag");
      const texts = [...screen.querySelectorAll("p")].map((p) => p.textContent.replace(/\s+/g, " ").trim());
      return {
        h2s: [...screen.querySelectorAll("h2")].map((h) => h.textContent.trim()),
        tag: tag?.textContent.trim() || "",
        tagShield: Boolean(tag?.querySelector("svg")),
        texts,
        buttons: [...screen.querySelectorAll("button")].map((b) => b.textContent.trim()),
      };
    });

  await check(
    "SN4",
    "The Share page: the card carries the scam check's tag, Practice together opens the practice page and Is this a scam? the check page; none of it prints (pictures)",
    async () => {
      const page = await openPage(ctx, "share.html");
      try {
        const s = await readShare(page);
        expect(s.tag === "Scam check" && s.tagShield, `the card's tag: ${s.tag}`);
        const at = s.h2s.indexOf("Practice together");
        expect(at > 0 && s.h2s[at - 1] === "Print Safety Guide", `order: ${s.h2s.join(" / ")}`);
        expect(
          s.texts.includes(
            "Six made-up scam messages to answer side by side, checked by Clotr on this computer. Practice together",
          ),
          `practice line: ${s.texts.join(" | ")}`,
        );
        expect(
          s.texts.includes("Got a message that worries them? Clotr can give a second opinion. Is this a scam?"),
          `check line: ${s.texts.join(" | ")}`,
        );
        await opensAndClose(ctx, page, "section.no-print", "Practice together", "practice.html");
        await opensAndClose(ctx, page, "section.no-print", "Is this a scam?", "check.html");
        await fitsAt380(page, "The Share page");
        await partShots(page, "section.no-print", "scam-shield-share");
        // On paper, the guide should print as before, with neither the tag nor these lines showing up in it.
        await page.emulateMediaType("print");
        const printed = await page.evaluate(() =>
          [".ss-tag", "#open-practice", "#open-check"].some((s) => document.querySelector(s)?.getClientRects().length),
        );
        await page.emulateMediaType(null);
        expect(!printed, "the screen's scam check lines print with the guide");
      } finally {
        await page.close();
      }
    },
  );

  // Reads every word a person or a screen reader would see on a page that names this feature: the visible text,
  // the page title, and its labels, titles, and hints.
  const pageWords = (page) =>
    page.evaluate(() =>
      [
        document.title,
        document.body.textContent,
        ...[...document.querySelectorAll("[aria-label], [title], [alt], [placeholder]")].flatMap((n) =>
          ["aria-label", "title", "alt", "placeholder"].map((a) => n.getAttribute(a) || ""),
        ),
      ].join(" \n "),
    );
  function nameProblems(words, where, name) {
    const out = [];
    if (/scam\s*shield/i.test(words)) out.push(`${where}: says Scam Shield`);
    if (/antibody/i.test(words)) out.push(`${where}: says Antibody`);
    if (!words.includes(name)) out.push(`${where}: doesn't name ${name}`);
    return out;
  }
  async function namesOn(c, lang, name) {
    const problems = [];
    for (const file of ["vault.html?welcome=1", "share.html", "helper.html", "check.html", "practice.html"]) {
      const page = await openPage(c, file);
      try {
        problems.push(...nameProblems(await pageWords(page), `${lang} ${file}`, name));
      } finally {
        await page.close();
      }
    }
    const popup = await openPopup(c);
    try {
      problems.push(...nameProblems(await pageWords(popup), `${lang} popup`, name));
    } finally {
      await popup.close();
    }
    return problems;
  }

  await check(
    "SN5",
    "The name on every page that shows it, English and Spanish: Scam check (its one string, ss_name), never Antibody, never Scam Shield",
    async () => {
      await resetState(ctx, {});
      const problems = await namesOn(ctx, "en", "Scam check");
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        problems.push(...(await namesOn(es, "es", "Revisión de estafas")));
      } finally {
        await es.browser.close().catch(() => {});
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
      expect(!problems.length, problems.join(" | "));
    },
  );

  // Reads the setup page's last step after a choice, in button order.
  const readAfter = (page) =>
    page.evaluate(() => {
      const after = document.getElementById("after");
      return {
        shown: Boolean(after) && after.getClientRects().length > 0,
        buttons: [...(after?.querySelectorAll("button") || [])].map((b) => b.textContent.trim()),
      };
    });

  await check(
    "SN7",
    "The setup page's last step: Print Safety Guide, Show them “Is this a scam?”, Practice together and Office training walkthrough, each opening its page (pictures)",
    async () => {
      await unlockSettings(ctx);
      await setTourniquet(ctx, null);
      const page = await openPage(ctx, "helper.html?for=after_scam");
      try {
        await sleep(300);
        const a = await readAfter(page);
        expect(a.shown, "the last step isn't on screen after a choice");
        expect(
          JSON.stringify(a.buttons) ===
            JSON.stringify([
              "Print a one-page guide for them",
              "Print Safety Guide",
              "Show them “Is this a scam?”",
              "Practice together",
              "Office training walkthrough",
            ]),
          `buttons: ${JSON.stringify(a.buttons)}`,
        );
        await opensAndClose(ctx, page, "#after", "Print Safety Guide", "share.html#card");
        await opensAndClose(ctx, page, "#after", "Show them “Is this a scam?”", "check.html");
        await opensAndClose(ctx, page, "#after", "Practice together", "practice.html");
        await opensAndClose(ctx, page, "#after", "Office training walkthrough", "training.html");
        await fitsAt380(page, "The setup page");
        await partShots(page, "#setup-end", "scam-shield-setup-end");
        expect(
          await ctx.worker.evaluate(async () => !(await chrome.storage.local.get("tourniquet")).tourniquet),
          "the last step's buttons turned Tourniquet on",
        );
      } finally {
        await page.close();
      }
    },
  );

  // Opens a warning's "Why am I seeing this?" and reads what it says.
  async function openWhy(page, label) {
    const n = await readNotice(page);
    const why = n?.buttons.find((b) => b.text === label);
    expect(why, `no "${label}" in the warning: ${n?.text}`);
    await clickNode(page, why.nodeId);
    await sleep(300);
    return readNotice(page);
  }
  async function whyShots(page, base) {
    for (const theme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await sleep(200);
      await page.screenshot({ path: path.join(OUT, `${base}-${theme}.png`) });
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }

  await check(
    "SN8",
    "A warning's Why? for a card's security code offers “Got a message asking for this? Get a second opinion”, which opens Is this a scam? empty; a key's Why? doesn't (pictures)",
    async () => {
      await resetState(ctx, {});
      await withSite(ctx, "chatgpt", async (page) => {
        TYPED_VALUES.add("482");
        await typeText(page, "the 3 numbers on the back are 482");
        expect(await waitForNotice(page), "no warning for a card's security code");
        await sleep(300);
        const why = await openWhy(page, "Why am I seeing this?");
        expect(why.text.includes("Got a message asking for this?"), `no second opinion: ${why.text}`);
        const link = why.buttons.find((b) => b.text === "Get a second opinion");
        expect(link, `no Get a second opinion button: ${why.buttons.map((b) => b.text)}`);
        // "What to do" should come first, with the second-opinion line next to the advice, before the general words.
        expect(
          why.text.indexOf("What to do") < why.text.indexOf("Got a message asking for this?"),
          `order: ${why.text}`,
        );
        await whyShots(page, "scam-shield-why");
        // I look the button up fresh before each click, since taking a screenshot or saving a first-time tip can
        // redraw the warning out from under it. Opening the page goes through the background script, which can
        // take a few seconds on a busy computer, so a click that lands during a redraw gets one more try.
        let target = null;
        for (let tries = 0; tries < 2 && !target; tries++) {
          await sleep(500);
          const fresh = (await readNotice(page))?.buttons.find((b) => b.text === "Get a second opinion");
          expect(fresh, "the second opinion went away");
          const opened = ctx.browser
            .waitForTarget((t) => t.url().endsWith("/check.html"), { timeout: 8000 })
            .catch(() => null);
          await page.bringToFront();
          await clickNode(page, fresh.nodeId);
          target = await opened;
        }
        expect(target, "Get a second opinion didn't open Is this a scam?");
        const tab = await target.page();
        try {
          await sleep(400);
          const box = await tab.evaluate(() => document.getElementById("message")?.value);
          expect(box === "", `the check page came with words in it: ${JSON.stringify(box)}`);
        } finally {
          await tab.close();
        }
        expect(await readNotice(page), "the warning went away");
      });
      await withSite(ctx, "chatgpt", async (page) => {
        TYPED_VALUES.add(KEY);
        await typeText(page, `my key ${KEY}`);
        expect(await waitForNotice(page), "no warning for a key");
        await sleep(300);
        const why = await openWhy(page, "Why am I seeing this?");
        expect(!/second opinion/i.test(why.text), `a key's Why? offers a second opinion: ${why.text}`);
      });
    },
  );

  await check(
    "PD1",
    "Every way into the practice page opens it: the welcome page, the Share page, the setup page's last step, and the popup's Overview row",
    async () => {
      await resetState(ctx, {});
      await unlockSettings(ctx);
      await setTourniquet(ctx, null);
      for (const [file, scope, label] of [
        ["vault.html?welcome=1", "#ss-welcome", "Practice with six made-up scams"],
        ["share.html", "section.no-print", "Practice together"],
        ["helper.html?for=after_scam", "#after", "Practice together"],
      ]) {
        const page = await openPage(ctx, file);
        try {
          await sleep(200);
          await opensAndClose(ctx, page, scope, label, "practice.html");
        } finally {
          await page.close();
        }
      }
      const popup = await openPopup(ctx);
      try {
        await opensAndClose(ctx, popup, "#ss-row", "Practice", "practice.html");
      } finally {
        await popup.close();
      }
    },
  );

  await check(
    "SN6",
    "Spanish browser: the popup's row and section, the welcome page's section, the Share page, the setup page's last step and the warning's link in Spanish (pictures)",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const popup = await openPopup(es);
        try {
          const row = await readRow(popup);
          expect(row?.visible && row.name === "Revisión de estafas", `row: ${JSON.stringify(row)}`);
          expect(JSON.stringify(row.links) === JSON.stringify(["¿Es una estafa?", "Practicar"]), `links: ${row.links}`);
          expect(!row.wide, "the popup scrolls sideways");
          await popupShots(popup, "scam-shield-es-overview");
          await popup.click("#tab-settings");
          await sleep(200);
          const s = await readSection(popup);
          expect(s.title === "Revisión de estafas", `title: ${s.title}`);
          expect(
            s.lead ===
              "Cuando alguien te pide algo, Clotr te ayuda. Sus avisos dicen quién pide de verdad códigos, números de tarjeta y tarjetas regalo.",
            `lead: ${s.lead}`,
          );
          expect(s.toggle === "Comprobar los comandos que copio en los chats de IA", `switch: ${s.toggle}`);
          expect(
            JSON.stringify(s.buttons.map((b) => b.text)) === JSON.stringify(["Imprimir guía de seguridad"]),
            `buttons: ${JSON.stringify(s.buttons)}`,
          );
          expect(
            s.line?.text ===
              "¿Acabas de sufrir una estafa, o casi? Tourniquet puede preguntar primero durante 30 días.",
            `the line: ${JSON.stringify(s.line)}`,
          );
          expect(!s.wide, "Settings scrolls sideways");
          await settingsShots(popup, "scam-shield-es-settings");
        } finally {
          await popup.close();
        }
        // Checks the welcome page's section.
        const welcome = await openPage(es, "vault.html?welcome=1");
        try {
          const w = await readWelcome(welcome);
          const at = w.h2s.indexOf("Revisión de estafas");
          expect(
            at > 0 && w.h2s[at - 1] === "Pruébalo" && w.h2s[at + 1] === "Dile a Clotr qué vigilar",
            `order: ${w.h2s.join(" / ")}`,
          );
          expect(
            w.text ===
              "Cuando alguien te pide un código, los números de tu tarjeta o tarjetas regalo, el aviso de Clotr dice quién los pide de verdad. ¿Te preocupa un mensaje? Clotr te da una segunda opinión.",
            `words: ${w.text}`,
          );
          expect(
            JSON.stringify(w.buttons.map((b) => b.text)) ===
              JSON.stringify(["¿Es una estafa?", "Practicar con seis estafas inventadas"]),
            `buttons: ${JSON.stringify(w.buttons)}`,
          );
          await fitsAt380(welcome, "The Spanish welcome page");
          await partShots(welcome, "#ss-welcome", "scam-shield-es-welcome");
        } finally {
          await welcome.close();
        }
        // Checks the Share page.
        const share = await openPage(es, "share.html");
        try {
          const s = await readShare(share);
          expect(s.tag === "Revisión de estafas", `tag: ${s.tag}`);
          expect(s.h2s.includes("Practicar juntos"), `headings: ${s.h2s.join(" / ")}`);
          for (const line of [
            "Seis mensajes de estafa inventados para responder codo con codo, revisados por Clotr en este ordenador. Practicar juntos",
            "¿Le preocupa un mensaje? Clotr le da una segunda opinión. ¿Es una estafa?",
          ])
            expect(s.texts.includes(line), `no "${line}": ${s.texts.join(" | ")}`);
          await fitsAt380(share, "The Spanish Share page");
          await partShots(share, "section.no-print", "scam-shield-es-share");
        } finally {
          await share.close();
        }
        // Checks the setup page's last step.
        const setup = await openPage(es, "helper.html?for=after_scam");
        try {
          await sleep(300);
          const a = await readAfter(setup);
          expect(
            JSON.stringify(a.buttons) ===
              JSON.stringify([
                "Imprimir una guía de una página para esa persona",
                "Imprimir guía de seguridad",
                "Enséñale «¿Es una estafa?»",
                "Practicar juntos",
                "Recorrido de formación de la oficina",
              ]),
            `buttons: ${JSON.stringify(a.buttons)}`,
          );
          await fitsAt380(setup, "The Spanish setup page");
          await partShots(setup, "#setup-end", "scam-shield-es-setup-end");
        } finally {
          await setup.close();
        }
        // Checks a warning's Why?, on an AI chat.
        await resetState(es, {});
        await withSite(es, "chatgpt", async (page) => {
          TYPED_VALUES.add("482");
          await typeText(page, "los 3 números de atrás son 482");
          expect(await waitForNotice(page), "no Spanish warning for a card's security code");
          await sleep(300);
          const why = await openWhy(page, "¿Por qué veo esto?");
          expect(why.text.includes("¿Te pidieron esto en un mensaje?"), `no second opinion: ${why.text}`);
          expect(
            why.buttons.some((b) => b.text === "Pide una segunda opinión"),
            `buttons: ${why.buttons.map((b) => b.text)}`,
          );
          await whyShots(page, "scam-shield-es-why");
        });
      } finally {
        await es.browser.close().catch(() => {});
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // ---------- The card on paper: "Never read these out" on the Share page ----------

  // Checks which of the two print sheets, the guide or the card, would actually show up in print media.
  const printed = (page) =>
    page.evaluate(() => ({
      guide: getComputedStyle(document.querySelector(".guide")).display !== "none",
      card: getComputedStyle(document.querySelector(".card-sheet")).display !== "none",
    }));
  // Clicks "Print the card" from a script, since the button itself is hidden in print media, with window.print stubbed out.
  const asCard = (page) => page.evaluate(() => document.getElementById("print-card").click());
  // Counts the pages in a PDF of the card at the given paper size. Making a PDF triggers the browser's own
  // afterprint event, which resets the page back to the guide, so I ask for the card again each time.
  async function pages(page, format) {
    await asCard(page);
    const pdf = Buffer.from(await page.pdf({ format, printBackground: true })).toString("latin1");
    return (pdf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  }

  await check(
    "WA7",
    "Share page: Print the card prints only the card, on one page of Letter or A4; Print the guide only the guide; nothing is typed or kept (pictures)",
    async () => {
      // Waits for the browser's own first-run writes, like a fresh profile's salt, to settle before reading
      // what Clotr stores.
      let before = null;
      for (let i = 0, last = ""; i < 20; i++, await sleep(250)) {
        const now = JSON.stringify(await store.get(ctx));
        if (now === last) break;
        [last, before] = [now, JSON.parse(now)];
      }
      const page = await openExtPage(ctx, "share.html");
      try {
        await page.evaluate(() => {
          window.__printed = [];
          window.print = () => window.__printed.push(document.body.dataset.print || "guide");
        });
        const words = await page.evaluate(() => ({
          title: document.getElementById("card").textContent,
          rows: [...document.querySelectorAll(".card-sheet .card-row")].map((r) => [
            r.querySelector("dt").textContent,
            r.querySelector("dd").textContent,
          ]),
          from: document.getElementById("card-from").textContent,
          fields: document.querySelectorAll(".card-sheet input, .card-sheet textarea").length,
        }));
        expect(words.title === "Print Safety Guide", `heading: ${words.title}`);
        expect(words.rows.length === 6, `${words.rows.length} rows`);
        expect(
          words.rows[1][0] === "The 3 numbers on the back of your card" &&
            words.rows[1][1] === "Your card company never asks: it already has them.",
          `row 2: ${words.rows[1]}`,
        );
        expect(
          words.from ===
            "This card is from Clotr. It warns before most of these go out on your computer, and it's for phone calls and texts.",
          `footer: ${words.from}`,
        );
        expect(!/Scam Shield/.test(await page.evaluate(() => document.body.innerText)), "the working name shows");
        expect(words.fields === 0, "the card has a field to type in");
        await page.emulateMediaType("print");
        expect(JSON.stringify(await printed(page)) === '{"guide":true,"card":false}', "by default the guide prints");
        await page.emulateMediaType("screen");
        await page.click("#print-card");
        await page.emulateMediaType("print");
        const card = await printed(page);
        expect(card.card && !card.guide, `Print the card: ${JSON.stringify(card)}`);
        for (const format of ["letter", "a4"]) {
          const n = await pages(page, format);
          expect(n === 1, `the card takes ${n} pages on ${format}`);
        }
        await page.setViewport({ width: 816, height: 1056 }); // US Letter at 96 dpi
        await asCard(page);
        expect(JSON.stringify(await printed(page)) === '{"guide":false,"card":true}', "the picture isn't the card");
        await page.screenshot({ path: path.join(OUT, "who-asks-card-printed.png"), fullPage: true });
        await page.emulateMediaType("screen");
        await page.click("#print");
        await page.emulateMediaType("print");
        const guide = await printed(page);
        expect(guide.guide && !guide.card, `Print the guide: ${JSON.stringify(guide)}`);
        const asked = await page.evaluate(() => window.__printed);
        expect(asked.at(-1) === "guide" && asked.slice(0, -1).every((x) => x === "card"), `printed: ${asked}`);
        await page.emulateMediaType("screen");
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        expect(!(await page.evaluate(() => document.body.dataset.print)), "the print choice stays after printing");
        for (const [size, width] of [
          ["380", 380],
          ["real", 900],
        ]) {
          await page.setViewport({ width, height: 900 });
          for (const theme of ["dark", "light"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(200);
            await page.screenshot({ path: path.join(OUT, `who-asks-share-${size}-${theme}.png`), fullPage: true });
          }
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          expect(!sideways, `the Share page scrolls sideways at ${width}px`);
        }
      } finally {
        await page.close();
      }
      const after = await store.get(ctx);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      expect(!changed.length, `the Share page changed what Clotr stores: ${changed.join(", ")}`);
      // The helper page's last step opens the Share page at the card.
      const helper = await openExtPage(ctx, "helper.html");
      try {
        const opened = ctx.browser.waitForTarget((t) => t.url().endsWith("/share.html#card"), { timeout: 3000 });
        await helper.evaluate(() => {
          document.getElementById("after").hidden = false;
          document.getElementById("open-card").click();
        });
        const tab = await (await opened).page();
        await tab?.close();
      } finally {
        await helper.close();
      }
    },
  );

  await check("WA13", "Spanish browser: the card, its six rows and its last line in Spanish (pictures)", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const page = await openExtPage(es, "share.html");
      try {
        const words = await page.evaluate(() => ({
          title: document.querySelector(".card-sheet h2").textContent,
          rows: document.querySelectorAll(".card-sheet .card-row").length,
          first: document.querySelector(".card-sheet dt").textContent,
          from: document.getElementById("card-from").textContent,
        }));
        expect(words.title === "Nunca digas esto en voz alta", `title: ${words.title}`);
        expect(words.rows === 6 && words.first === "El código que te manda tu banco o una app", JSON.stringify(words));
        expect(
          words.from ===
            "Esta tarjeta es de Clotr. Avisa antes de que salga casi todo esto en tu ordenador, y es para las llamadas y los mensajes.",
          `footer: ${words.from}`,
        );
        await page.evaluate(() => {
          window.print = () => {};
          document.getElementById("print-card").click();
        });
        await page.emulateMediaType("print");
        for (const format of ["letter", "a4"]) {
          const n = await pages(page, format);
          expect(n === 1, `the Spanish card takes ${n} pages on ${format}`);
        }
        await page.setViewport({ width: 816, height: 1056 });
        await asCard(page);
        expect(JSON.stringify(await printed(page)) === '{"guide":false,"card":true}', "the picture isn't the card");
        await page.screenshot({ path: path.join(OUT, "who-asks-card-printed-es.png"), fullPage: true });
        await page.emulateMediaType("screen");
        await page.setViewport({ width: 380, height: 900 });
        for (const theme of ["dark", "light"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(200);
          await page.screenshot({ path: path.join(OUT, `who-asks-share-380-es-${theme}.png`), fullPage: true });
        }
      } finally {
        await page.close();
      }
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });
};
