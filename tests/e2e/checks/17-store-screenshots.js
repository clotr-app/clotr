// E2E checks: Store / README screenshots, run only with --store. Each one shows an ordinary moment in an ordinary
// place, like a tax question in an AI chat or an email to the landlord, using neutral demo pages and fake data. The
// finished picture is 1280×800 with a caption; the plain screenshot underneath goes to docs/store/shots/ for the
// README and the website. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

const { zipOf } = require("../../fixtures/exports/make-exports.js");

module.exports = async function (env) {
  const {
    EXT,
    ROOT,
    argv,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    launch,
    openExtPage,
    openPopup,
    os,
    path,
    readNotice,
    readUI,
    resetState,
    seedEvents,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  if (!argv.includes("--store")) return;

  const dir = path.join(ROOT, "docs", "store");
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const b64 = (file) => fs.readFileSync(file).toString("base64");
  // The extension's own font and the site's plum wordmark, so the store pictures match the brand.
  const font = `@font-face{font-family:Recursive;src:url(data:font/woff2;base64,${b64(path.join(EXT, "fonts", "Recursive-var-normal.woff2"))}) format("woff2");font-weight:300 1000}`;
  const wordmark = b64(path.join(ROOT, "website-test", "assets", "wordmark.svg"));

  // Frames a screenshot into a store picture: the wordmark, a caption and one line of text on quiet grey paper,
  // with the screenshot on the right.
  const frame = async (name, caption, sub, png, width) => {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${font}
      body{margin:0;width:1280px;height:800px;box-sizing:border-box;padding:0 60px 0 72px;display:flex;align-items:center;gap:48px;
        font-family:Recursive,system-ui,sans-serif;color:#1f2226;background:#f3f4f5}
      .text{flex:0 0 380px}
      .brand{margin-bottom:44px}
      .brand img{height:39px}
      h1{font-size:46px;font-weight:700;line-height:1.1;letter-spacing:-.02em;margin:0}
      p{font-size:21px;line-height:1.5;color:#5e6670;margin:20px 0 0}
      .shot{flex:1;display:flex;justify-content:center}
      .shot img{width:${width}px;border-radius:12px;
        box-shadow:0 1px 2px rgba(31,34,38,.08),0 30px 60px -28px rgba(31,34,38,.35),0 0 0 1px #dde0e3}
      </style></head><body><div class="text"><div class="brand"><img src="data:image/svg+xml;base64,${wordmark}" alt="Clotr"></div>
      <h1>${caption}</h1><p>${sub}</p></div><div class="shot"><img src="data:image/png;base64,${png}" alt=""></div></body></html>`);
    await page.evaluate("document.fonts.ready");
    await page.screenshot({ path: path.join(dir, name) });
    await page.close();
  };
  // Sizes the page so the warning stays readable once it's scaled down into a store picture, at 2× so it stays sharp.
  const VIEW = { width: 1000, height: 680, deviceScaleFactor: 2 };
  const prepare = async (page) => {
    await page.setViewport(VIEW);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  };
  const snap = async (page, name) => {
    await sleep(300);
    await page.screenshot({ path: path.join(shots, name) });
    return b64(path.join(shots, name));
  };

  // Email and chat apps only run Clotr once you switch them on, so this makes a copy of the extension with the
  // two demo sites already granted.
  async function withGrantedCopy(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.host_permissions = [...m.host_permissions, "https://outlook.live.com/*", "https://app.slack.com/*"];
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
      await resetState(other, {});
      return await fn(other);
    } finally {
      await other.browser.close();
    }
  }

  await check(
    "SS1",
    "Store pictures: AI chat, email, group chat, Bandage, report, ask first, welcome (docs/store/)",
    async () => {
      // Picture 1: a tax question in an AI chat. Picture 8 reuses the same message after clicking Hide it.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx, {});
        await page.evaluate(() =>
          window.__setLog([
            ["me", "I'm doing my taxes and a number on my W-2 looks off. Can you help me check it?"],
            ["ai", "Of course. Tell me what's on the form and I'll walk through it with you."],
          ]),
        );
        await typeText(page, "Is this right? My Social Security number is 219-09-9999 and I made $41,200 last year.");
        expect(await waitForNotice(page), "no notice");
        const shot = await snap(page, "ai-chat.png");
        await frame(
          "1-ai-chat.png",
          "Clot your data leaks",
          "Your Social Security number in a tax question? Clotr notices before you hit send. Hide it, or leave it in: your call.",
          shot,
          740,
        );
        await clickDialogButton(page, "Hide it", readNotice);
        await frame(
          "8-hidden.png",
          "Hidden with one click",
          "The number comes out of your message before anything is sent. Nothing leaves your computer.",
          await snap(page, "hidden.png"),
          740,
        );
      });

      // Pictures 2 and 3: an email to the landlord and a group chat, on sites switched on in Settings.
      await withGrantedCopy(async (other) => {
        await withSite(other, "demomail", async (page) => {
          await prepare(page);
          await typeText(
            page,
            "Hi, the heater is broken again. I'm at 123 Oak Street, Apt 4B. Call me at 555-555-0123 and I'll let you in.",
          );
          expect(await waitForNotice(page), "no notice in the email");
          await frame(
            "2-email.png",
            "Your email too",
            "Switch Clotr on for your webmail in Settings. It warns the same way before your address or phone number goes out.",
            await snap(page, "email.png"),
            740,
          );
        });
        await withSite(other, "demogroup", async (page) => {
          await prepare(page);
          await typeText(page, "just log in as me lol, the password is Sunflower2009");
          expect(await waitForNotice(page), "no notice in the group chat");
          await frame(
            "3-group-chat.png",
            "And your group chats",
            "Chat apps and group chats too, one site at a time. Clotr never reads anyone else's messages.",
            await snap(page, "group-chat.png"),
            740,
          );
        });
      });

      // Picture 6: Ask before sending holds a card number until you choose what to do with it.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx); // the default responses ask before sending for the high-risk kinds
        await page.evaluate(() =>
          window.__setLog([
            ["me", "My order never arrived. Can you help me write to the store?"],
            ["ai", "Sure. What did you order, and how did you pay?"],
          ]),
        );
        await typeText(page, "A blue winter coat. I paid with my card 4111 1111 1111 1111, it expires 08/28.");
        expect(await waitForDialog(page), "no dialog");
        await frame(
          "6-ask-before-sending.png",
          "It can ask first",
          "For a card number or a password, Clotr can hold the message until you decide. You pick which kinds.",
          await snap(page, "ask-before-sending.png"),
          740,
        );
      });

      // Picture 4: Bandage covers names in the message, and hovering a label in the answer reveals the real detail.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "poe.com": true } });
        await sleep(300);
        await typeText(
          page,
          "The heater has been broken since Monday. Reach me at 555-555-0123. I live at 123 Oak Street.",
        );
        const covered = await waitFor(async () => {
          const t = await page.$eval("#prompt", (b) => b.value);
          return t.includes("[Phone 1]") && t.includes("[Address 1]") ? t : null;
        }, 5000);
        expect(covered, "not covered");
        await page.keyboard.press("Enter");
        await sleep(400);
        await page.evaluate(() =>
          window.__reply(
            'Here\'s a draft: "Hi, the heater at [Address 1] has been broken since Monday. Could someone take a look this week? You can reach me at [Phone 1]. Thanks!"',
          ),
        );
        expect(await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000), "no hotspots");
        const at = await page.evaluate((label) => {
          const t = [...document.querySelectorAll(".msg.ai")].pop().firstChild;
          const r = document.createRange();
          r.setStart(t, t.nodeValue.indexOf(label));
          r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }, "[Phone 1]");
        await page.mouse.move(at.x, at.y);
        expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble");
        await frame(
          "4-bandage.png",
          "Cover names, real answers",
          "Bandage swaps your details for labels like [Phone 1] before an AI sees them. Point at a label in the answer to see the real one.",
          await snap(page, "bandage.png"),
          740,
        );
        await store.set(ctx, { bandage: {} });
      });

      // Picture 5: the report in the toolbar popup.
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      await popup.setViewport({ width: 380, height: 720, deviceScaleFactor: 2 });
      await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await sleep(400);
      await popup.screenshot({ path: path.join(shots, "popup.png") });
      await popup.close();
      await frame(
        "5-dashboard.png",
        "See what you almost shared",
        "What Clotr caught, where, and what you chose. Counted on your computer; it never keeps what you typed.",
        b64(path.join(shots, "popup.png")),
        340,
      );
      await store.set(ctx, { events: [] });

      // Picture 7: the welcome page's practice box.
      const welcome = await openExtPage(ctx, "vault.html?welcome=1");
      await welcome.setViewport({ width: 700, height: 800, deviceScaleFactor: 2 });
      await welcome.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await welcome.type("#try", "call me at 555-555-0123");
      await sleep(600);
      // The email and chat card sits just above the practice box, so scrolling to its heading fits both in frame.
      await welcome.evaluate(() => {
        document.getElementById("everyday-offer")?.scrollIntoView({ block: "start" });
        scrollBy(0, -16);
      });
      await sleep(200);
      await welcome.screenshot({ path: path.join(shots, "welcome.png") });
      await welcome.close();
      await frame(
        "7-welcome.png",
        "Try it in ten seconds",
        "A practice box on the welcome page shows exactly what a warning looks like. Nothing leaves your computer.",
        b64(path.join(shots, "welcome.png")),
        560,
      );
      return "8 store pictures in docs/store/, plain shots in docs/store/shots/";
    },
  );

  // Clotr Antibody, Look back, and Extension check are three new pieces in 1.2.0 that didn't have a store picture
  // yet. Each one needs an English and a Spanish version, with the UI itself in Spanish rather than just the
  // caption, the same way LK11 proves Look back's Spanish screens. Spanish pictures go in docs/store/es/, since
  // today's upload tooling (tools/store-folder.js) only splits the listing text by language, not the pictures.
  await check(
    "SS2",
    "Store pictures for the big update: Clotr Antibody, Look back, Extension check, English and Spanish",
    async () => {
      fs.mkdirSync(path.join(dir, "es"), { recursive: true });

      const snapPage = async (page, name, width, height) => {
        await page.setViewport({ width, height, deviceScaleFactor: 2 });
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await sleep(300);
        await page.screenshot({ path: path.join(shots, name) });
        return b64(path.join(shots, name));
      };

      // Picture 9: Clotr Antibody's who-really-asks line for a card's security code. A fake AI assistant asking
      // you to "verify" a card before it'll help is exactly the moment Antibody is for.
      async function antibodyShot(c, log, typed, question, fileName) {
        return withSite(c, "demo", async (page) => {
          await prepare(page);
          await resetState(c, {});
          await page.evaluate((l) => window.__setLog(l), log);
          await typeText(page, typed);
          const found = await waitFor(async () => {
            const ui = await readNotice(page);
            return ui?.text.includes(question) ? ui : null;
          }, 3000);
          expect(found, `no who-asks line for "${typed}"`);
          return snap(page, fileName);
        });
      }

      // Picture 10: Look back shows which old chats already hold a password, a card number, or an address.
      async function lookBackShot(c, fileName) {
        const page = await openExtPage(c, "lookback.html");
        try {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ss-lb-"));
          const zipPath = path.join(tmp, "export.zip");
          fs.writeFileSync(zipPath, zipOf("chatgpt"));
          const input = await page.$("#file-input");
          await input.uploadFile(zipPath);
          await waitFor(() => page.evaluate(() => !document.getElementById("results").hidden), 10000);
          return await snapPage(page, fileName, 820, 900);
        } finally {
          await page.close();
        }
      }

      // Picture 11: Extension check shows which other extensions can read your AI chats. A copy whose manifest
      // grants `management` up front stands in for the browser's own prompt, the same trick EX0 uses. One fake
      // extension and a planted report let the picture show both lists the feature has.
      async function withManagementCopy(fn, langArgs = [], langEnv = null) {
        const dirs = [];
        const tmp = (name) => {
          const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
          dirs.push(d);
          return d;
        };
        const copy = tmp("clotr-ss-ext-mgmt-");
        fs.cpSync(EXT, copy, { recursive: true });
        const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
        m.permissions = [...m.permissions, "management"];
        m.optional_permissions = (m.optional_permissions || []).filter((p) => p !== "management");
        fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));

        const allSites = tmp("clotr-ss-allsites-");
        fs.writeFileSync(
          path.join(allSites, "manifest.json"),
          JSON.stringify(
            {
              manifest_version: 3,
              name: "Page Helper",
              version: "1.0",
              content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
            },
            null,
            2,
          ),
        );
        fs.writeFileSync(path.join(allSites, "cs.js"), "// Clotr e2e test fixture: no-op content script\n");

        const other = await launch([copy, allSites], langArgs, langEnv);
        try {
          return await fn(other, { allSitesName: "Page Helper" });
        } finally {
          await other.browser.close();
          for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
        }
      }

      async function extCheckShot(fileName, langArgs, langEnv) {
        return withManagementCopy(
          async (other, names) => {
            const all = await other.worker.evaluate(() => chrome.management.getAll());
            const allSitesId = all.find((e) => e.name === names.allSitesName)?.id;
            const page = await openExtPage(other, "extcheck.html");
            try {
              await page.evaluate((id) => {
                window.Clotr.reportedExtensions.entries = [
                  {
                    id,
                    store: "test",
                    name: "planted",
                    source: "Test Lab",
                    date: "2026-01-01",
                    url: "https://example.invalid/report",
                    what: "collected AI chats",
                  },
                ];
              }, allSitesId);
              await page.click("#start-check");
              await waitFor(() => page.evaluate(() => !document.getElementById("results").hidden), 5000);
              return await snapPage(page, fileName, 820, 900);
            } finally {
              await page.close();
            }
          },
          langArgs,
          langEnv,
        );
      }

      // English pictures first, using the shared browser and a plain management copy.
      await frame(
        "9-antibody.png",
        "Who really asks?",
        "Clotr Antibody says who really asks for a card code, a gift card number, a sign-in code or a PIN, and catches copy-pasted scam commands and scam messages.",
        await antibodyShot(
          ctx,
          [
            ["me", "My package never arrived. Can you help me get a refund?"],
            ["ai", "Sure, before I can process this I'll need to verify your card. What's the code on the back?"],
          ],
          "the 3 numbers on the back are 482",
          "Who asks for the 3 numbers on the back of your card?",
          "antibody.png",
        ),
        740,
      );
      await frame(
        "10-look-back.png",
        "Look back",
        "See which old AI chats already held a password, a card or ID number, or an address. Read on your computer, never uploaded.",
        await lookBackShot(ctx, "lookback-store.png"),
        680,
      );
      await frame(
        "11-extension-check.png",
        "Extension check",
        "One button: see which of your other extensions can read your AI chats, and which ones public reports flagged.",
        await extCheckShot("extcheck-store.png", [], null),
        680,
      );

      // Spanish pictures need a real Spanish-locale browser for Antibody and Look back, the same pattern LK11
      // uses, and a Spanish-locale management copy for Extension check.
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        await frame(
          "es/9-antibody.png",
          "¿Quién pide esto de verdad?",
          "Clotr Antibody dice quién pide de verdad el código de tu tarjeta, un número de tarjeta regalo, un código de acceso o un PIN, y detecta los comandos y mensajes de estafa.",
          await antibodyShot(
            es,
            [
              ["me", "Mi paquete nunca llegó. ¿Me ayudas a pedir un reembolso?"],
              ["ai", "Claro, antes de procesarlo necesito verificar tu tarjeta. ¿Cuál es el código de atrás?"],
            ],
            "los 3 números de atrás son 482",
            "¿Quién pide los 3 números de atrás de tu tarjeta?",
            "antibody-es.png",
          ),
          740,
        );
        await frame(
          "es/10-look-back.png",
          "Mirar atrás",
          "Descubre qué chats antiguos ya tenían una contraseña, un número de tarjeta o de identificación, o una dirección. Se lee en tu equipo, nunca se sube.",
          await lookBackShot(es, "lookback-store-es.png"),
          680,
        );
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
      await frame(
        "es/11-extension-check.png",
        "Revisión de extensiones",
        "Un botón: ve qué otras extensiones pueden leer tus chats de IA, y cuáles han sido señaladas en informes públicos.",
        await extCheckShot("extcheck-store-es.png", ["--lang=es-ES", "--accept-lang=es-ES"], {
          LANGUAGE: "es",
          LANG: "es_ES.UTF-8",
        }),
        680,
      );

      return "6 new store pictures: docs/store/9-11 (English) and docs/store/es/9-11 (Spanish)";
    },
  );
};
