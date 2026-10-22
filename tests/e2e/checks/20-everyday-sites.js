// E2E checks: EV. Email and chat apps stay off until you switch one on. Once on, Clotr warns and hides the same
// way it does on an AI chat, except the warning talks about the people who'll read it, with no cover names and no
// reading of replies. ../run.js runs these checks in order, sharing one env with helpers from ../lib.js.
"use strict";

module.exports = async function (env) {
  const { EXT, check, clotrActive, ctx, expect, expectNoUI, fs, launch, openExtPage, openPopup, os, path } = env;
  const { clickDialogButton, evalInClotr, readDialog, readNotice } = env;
  const { editorText, resetState, shotAt, sleep, store, typeText, waitFor, withSite } = env;
  const PHONE = "555-555-0123";

  await check("EV1", "Email and chat apps: Clotr stays off until you switch one on", async () => {
    for (const key of ["gmail", "discord"]) {
      await withSite(ctx, key, async (page) => {
        expect(!clotrActive(page), `Clotr ran on ${key} without being switched on`);
        await typeText(page, `You can reach me at ${PHONE}`);
        await expectNoUI(page, `${key} not switched on`);
      });
    }
  });

  await check(
    "EV2",
    "Settings lists the email and chat apps, all off; the background treats them as people sites",
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        const rows = await popup.$$eval("#everyday-sites li", (lis) =>
          lis.map((li) => ({ name: li.querySelector("b")?.textContent, on: li.querySelector("button")?.textContent })),
        );
        expect(rows.length >= 8, `rows: ${JSON.stringify(rows)}`);
        for (const name of ["Gmail", "Outlook", "Discord", "Slack", "WhatsApp"]) {
          expect(
            rows.some((r) => r.name === name && r.on === "Turn on"),
            `${name} missing or not off: ${JSON.stringify(rows)}`,
          );
        }
      } finally {
        await popup.close();
      }
      const s = await ctx.worker.evaluate(async () => ({
        discord: await settingsFor("https://discord.com/channels/1/2"),
        chatgpt: await settingsFor("https://chatgpt.com/"),
      }));
      expect(s.discord.everyday === true, "discord.com isn't an everyday site");
      expect(s.discord.replyCheck === false && s.discord.bandage === false, "replies or cover names on discord.com");
      expect(s.chatgpt.everyday === false && s.chatgpt.replyCheck === true, "chatgpt.com changed");
    },
  );

  // A script can't click the browser's own permission prompt, so I stand in for "you switched them on" with a
  // copy of the extension whose manifest already grants the two sites. A granted host behaves the same either way.
  async function withGrantedCopy(fn, extraPermissions = [], emailBandage = false) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    let other;
    try {
      fs.cpSync(EXT, copy, { recursive: true });
      const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
      m.host_permissions = [
        ...m.host_permissions,
        "https://mail.google.com/*",
        "https://discord.com/*",
        ...extraPermissions,
      ];
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
      if (emailBandage) {
        // The copied test build opens the guarded path only so the email editor behavior can be checked.
        const backgroundFile = path.join(copy, "background.js");
        const background = fs.readFileSync(backgroundFile, "utf8").replace(/\r\n/g, "\n");
        const disabled =
          'function bandageFor(everyday, host, r) {\n  return everyday ? false : host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined;\n}';
        const enabled =
          'function bandageFor(everyday, host, r) {\n  return host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined;\n}';
        expect(background.includes(disabled), "the fake email Bandage setup couldn't find the guarded setting");
        fs.writeFileSync(backgroundFile, background.replace(disabled, enabled));
      }
      other = await launch(copy);
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            if (!s) await syncUserSites();
            return Boolean(s);
          }),
        5000,
      );
      await resetState(other);
      await store.set(other, { bandage: {} }); // nothing has answered Bandage yet, which is what makes an AI chat offer it
      return await fn(other);
    } finally {
      if (other) {
        await other.browser.close();
        fs.rmSync(other.profile, { recursive: true, force: true });
      }
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("EV3", "Switched on: a phone number in an email or a chat app warns about the people who read it", () =>
    withGrantedCopy(async (other) => {
      const seen = [];
      for (const key of ["gmail", "discord"]) {
        await withSite(other, key, async (page) => {
          expect(clotrActive(page), `Clotr isn't running on ${key} after it was switched on`);
          await typeText(page, `You can reach me at ${PHONE}`);
          const notice = await waitFor(() => readNotice(page), 3000);
          expect(notice, `no warning on ${key}`);
          expect(/people who read it here/.test(notice.text), `${key} warning: ${notice.text}`);
          expect(!/this AI/.test(notice.text), `${key} warning mentions an AI: ${notice.text}`);
          expect(!notice.buttons.some((b) => /cover names/i.test(b.text)), `${key}: Bandage offered cover names`);
          seen.push(key);
        });
        await sleep(200);
      }
      return `warned on ${seen.join(" and ")}, no cover names`;
    }),
  );

  await check(
    "EV18",
    "Email replies leave quoted contact details out; forwards check added text and credentials in the forwarded message",
    () =>
      withGrantedCopy(
        async (other) => {
          const providers = [
            {
              name: "Gmail",
              host: "mail.google.com",
              origin: "https://mail.google.com",
              reply: "email-gmail-reply.html",
              forward: "email-gmail-forward.html",
            },
            {
              name: "Outlook",
              host: "outlook.office.com",
              origin: "https://outlook.office.com",
              reply: "email-outlook-reply.html",
              forward: "email-outlook-forward.html",
            },
            {
              name: "Yahoo Mail",
              host: "mail.yahoo.com",
              origin: "https://mail.yahoo.com",
              reply: "email-yahoo-reply.html",
              forward: "email-yahoo-forward.html",
            },
          ];

          await store.set(other, {
            siteKinds: Object.fromEntries(providers.map((p) => [p.host, "everyday"])),
          });
          await other.worker.evaluate(() => syncUserSites());
          await waitFor(
            () =>
              other.worker.evaluate(async () => {
                const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
                return s?.matches?.some((m) => /^[^:/]+:\/\/mail\.yahoo\.com\//.test(m));
              }),
            5000,
          );

          async function withFixture(provider, file, fn, variant = "reply") {
            const url = `${provider.origin}/clotr-test?variant=${variant}`;
            const page = await other.browser.newPage();
            page.site = { url, editor: 'document.querySelector("#body")', send: 'document.querySelector("#send")' };
            page.logs = [];
            page.on("console", async (entry) => {
              const text = (await Promise.all(entry.args().map((a) => a.jsonValue().catch(() => "")))).join(" ");
              page.logs.push(text);
              if (text.includes("[Clotr]") && ["error", "warn"].includes(entry.type())) {
                other.problems.push(`${provider.name} page ${entry.type()}: ${text}`);
              }
            });
            page.on("pageerror", (err) => other.problems.push(`${provider.name} page error: ${err.message}`));
            await page.setRequestInterception(true);
            page.on("request", (req) => {
              if (req.resourceType() === "document" && req.url().startsWith(provider.origin + "/")) {
                return req.respond({
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  body: fs.readFileSync(path.join(__dirname, "..", "pages", file)),
                });
              }
              return req.abort();
            });
            try {
              await page.goto(url, { waitUntil: "load" });
              await waitFor(() => page.logs.some((line) => line.includes("[Clotr] responses:")), 5000);
              expect(clotrActive(page), `Clotr did not run on ${provider.name}`);
              await evalInClotr(
                page,
                `(() => {
                const detect = globalThis.Clotr.detect;
                globalThis.__emailScanTexts = [];
                globalThis.Clotr.detect = (text) => {
                  globalThis.__emailScanTexts.push(text);
                  return detect(text);
                };
                return true;
              })()`,
              );
              await page.evaluate(() => {
                const reply = document.querySelector("#reply");
                const range = document.createRange();
                range.selectNodeContents(reply);
                range.collapse(false);
                const selection = getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                document.querySelector("#body").focus();
              });
              return await fn(page);
            } finally {
              await page.close();
            }
          }

          async function rememberEmailStatic(page) {
            await page.evaluate(() => {
              const snapshot = (node) => ({
                node,
                type: node.nodeType,
                name: node.nodeName,
                value: node.nodeValue,
                attributes:
                  node.nodeType === Node.ELEMENT_NODE ? [...node.attributes].map((a) => [a.name, a.value]) : [],
                children: [...node.childNodes].map(snapshot),
              });
              window.__emailStaticSnapshot = ["#signature", "#email-history"].map((selector) =>
                snapshot(document.querySelector(selector)),
              );
            });
          }

          async function emailStaticUnchanged(page) {
            return page.evaluate(() => {
              const same = (before, node) =>
                Boolean(node) &&
                before.node === node &&
                before.type === node.nodeType &&
                before.name === node.nodeName &&
                before.value === node.nodeValue &&
                JSON.stringify(before.attributes) ===
                  JSON.stringify(
                    node.nodeType === Node.ELEMENT_NODE ? [...node.attributes].map((a) => [a.name, a.value]) : [],
                  ) &&
                before.children.length === node.childNodes.length &&
                before.children.every((child, i) => same(child, node.childNodes[i]));
              return ["#signature", "#email-history"].every((selector, i) =>
                same(window.__emailStaticSnapshot[i], document.querySelector(selector)),
              );
            });
          }

          const richEditFailures = [];
          async function recordRichFailure(provider, action, run) {
            try {
              await run();
            } catch (err) {
              richEditFailures.push(`${provider.name} ${action}: ${err.message}`);
            }
          }

          for (const provider of providers) {
            await withFixture(provider, provider.reply, async (page) => {
              await page.evaluate(() => {
                const reply = document.querySelector("#reply");
                const range = document.createRange();
                range.selectNodeContents(reply);
                getSelection().removeAllRanges();
                getSelection().addRange(range);
              });
              await typeText(page, "Jerry,");
              await sleep(700);
              const notice = await readNotice(page);
              expect(!notice, `${provider.name} reply warned about the quoted header: ${notice?.text}`);
            });

            await withFixture(provider, provider.reply, async (page) => {
              await typeText(page, "Please email me at reply@example.test.");
              const notice = await waitFor(() => readNotice(page), 3000);
              expect(notice && /Email Address/.test(notice.text), `${provider.name} did not warn for my address`);
            });

            await withFixture(provider, provider.reply, async (page) => {
              await typeText(page, "My phone is 555-555-0123.");
              const notice = await waitFor(() => readNotice(page), 3000);
              expect(notice && /Phone Number/.test(notice.text), `${provider.name} did not warn for my phone`);
              await clickDialogButton(page, "Send as is", readNotice);
              await typeText(page, " Thanks for the note.");
              await sleep(700);
              const repeated = await readNotice(page);
              expect(
                !repeated || /Warn less about/.test(repeated.text),
                `${provider.name} repeated the same warning after I kept typing: ${repeated?.text}; ${await editorText(page)}`,
              );
              if (repeated) await clickDialogButton(page, "Keep warning", readNotice);
              await typeText(page, " Please email me at new@example.test.");
              const added = await waitFor(() => readNotice(page), 3000);
              expect(added && /Email Address/.test(added.text), `${provider.name} missed the new email address`);
            });

            await withFixture(provider, provider.reply, async (page) => {
              await typeText(page, "API key: AKIA4HPQ7XZ2R6TWLJ3N");
              const notice = await waitFor(async () => (await readNotice(page)) || (await readDialog(page)), 3000);
              expect(notice && /AWS Access Key/.test(notice.text), `${provider.name} did not warn for my key`);
            });

            await withFixture(
              provider,
              provider.forward,
              async (page) => {
                await page.evaluate(() => {
                  const reply = document.querySelector("#reply");
                  const range = document.createRange();
                  range.selectNodeContents(reply);
                  range.collapse(false);
                  getSelection().removeAllRanges();
                  getSelection().addRange(range);
                });
                await typeText(page, "Hi,");
                const notice = await waitFor(async () => (await readNotice(page)) || (await readDialog(page)), 3000);
                expect(
                  notice && /AWS Access Key/.test(notice.text),
                  `${provider.name} did not warn for the forwarded key`,
                );
                expect(!/Email Address/.test(notice.text), `${provider.name} warned about a forwarded address`);
              },
              "forward",
            );

            await recordRichFailure(provider, "Cover it", () =>
              withFixture(provider, provider.reply, async (page) => {
                await rememberEmailStatic(page);
                await typeText(page, "Call me at 555-555-0123.");
                const notice = await waitFor(() => readNotice(page), 3000);
                expect(
                  notice && /Phone Number/.test(notice.text),
                  `${provider.name} did not warn for the typed number`,
                );
                await clickDialogButton(page, "Cover it", readNotice);
                const covered = await waitFor(async () => {
                  const text = await editorText(page);
                  return text.includes("[REDACTED PHONE NUMBER]") ? text : null;
                }, 4000);
                expect(covered, `${provider.name} did not cover the typed number: ${await editorText(page)}`);
                const parts = await page.evaluate(() => ({
                  reply: document.querySelector("#reply")?.innerText || "",
                  quote: document.querySelector("#quote-body")?.innerText || "",
                }));
                expect(!parts.reply.includes("555-555-0123"), `${provider.name} left the typed number in the reply`);
                expect(parts.quote.includes("555-555-0123"), `${provider.name} changed the same number in the quote`);
                expect(await emailStaticUnchanged(page), `${provider.name} changed the quote or signature nodes`);
              }),
            );

            await recordRichFailure(provider, "split number", () =>
              withFixture(provider, provider.reply, async (page) => {
                await rememberEmailStatic(page);
                await typeText(page, "Call me at 555-555-");
                await page.keyboard.down("Control");
                await page.keyboard.press("b");
                await page.keyboard.up("Control");
                await typeText(page, "0123");
                await page.keyboard.down("Control");
                await page.keyboard.press("b");
                await page.keyboard.up("Control");
                const split = await page.evaluate(() => ({
                  reply: document.querySelector("#reply")?.innerText || "",
                  bold: [...document.querySelectorAll("#reply b, #reply strong")].some((node) =>
                    node.textContent.includes("0123"),
                  ),
                }));
                expect(
                  split.reply.includes("555-555-0123") && split.bold,
                  `${provider.name} did not split the number at bold text`,
                );
                const notice = await waitFor(() => readNotice(page), 3000);
                expect(
                  notice && /Phone Number/.test(notice.text),
                  `${provider.name} missed the number split by bold text`,
                );
                await clickDialogButton(page, "Cover it", readNotice);
                const covered = await waitFor(async () => {
                  const text = await editorText(page);
                  return text.includes("[REDACTED PHONE NUMBER]") ? text : null;
                }, 4000);
                expect(covered, `${provider.name} did not cover the split number: ${await editorText(page)}`);
                const quote = await page.$eval("#quote-body", (node) => node.innerText);
                expect(quote.includes("555-555-0123"), `${provider.name} changed the phone number in the quote`);
                expect(await emailStaticUnchanged(page), `${provider.name} changed the quote or signature nodes`);
              }),
            );

            const previousBandage = (await store.get(other, "bandage")).bandage || {};
            await store.set(other, { bandage: { ...previousBandage, [provider.host]: true } });
            try {
              await recordRichFailure(provider, "Bandage", () =>
                withFixture(provider, provider.reply, async (page) => {
                  await rememberEmailStatic(page);
                  await typeText(page, "Call me at 555-555-0123.");
                  const text = await waitFor(async () => {
                    const value = await editorText(page);
                    return value.includes("[Phone 1]") ? value : null;
                  }, 4000);
                  const notice = await readNotice(page);
                  const debug = JSON.stringify({
                    bandage: (await store.get(other, "bandage")).bandage?.[provider.host],
                    notice: notice?.text || "",
                    logs: page.logs.filter((line) => line.includes("Bandage") || line.includes("rich message")),
                  });
                  expect(
                    text,
                    `${provider.name} Bandage did not cover the typed number: ${await editorText(page)}; debug=${debug}`,
                  );
                  expect(!(await readNotice(page)), `${provider.name} warned after Bandage covered the number`);
                  const quote = await page.$eval("#quote-body", (node) => node.innerText);
                  expect(
                    quote.includes("555-555-0123"),
                    `${provider.name} Bandage changed the phone number in the quote`,
                  );
                  expect(
                    await emailStaticUnchanged(page),
                    `${provider.name} Bandage changed the quote or signature nodes`,
                  );
                }),
              );
            } finally {
              await store.set(other, { bandage: previousBandage });
            }
          }
          expect(!richEditFailures.length, richEditFailures.join(" | ") || "a rich email edit failed");

          await withFixture(providers[0], providers[0].reply, async (page) => {
            await typeText(page, "Hello ");
            expect(
              await waitFor(() => evalInClotr(page, "globalThis.__emailScanTexts.at(-1)?.includes('Hello')"), 3000),
              "Gmail did not scan the reply before the quote edit",
            );
            await page.evaluate(() => {
              const text = document.querySelector(".quote-body").firstChild;
              const range = document.createRange();
              range.selectNodeContents(text);
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              document.querySelector("#body").focus();
            });
            await typeText(page, "Call me at 555-555-0134.");
            expect(
              await waitFor(
                () => evalInClotr(page, "globalThis.__emailScanTexts.at(-1)?.includes('555-555-0134')"),
                3000,
              ),
              "Gmail did not scan the changed quote text",
            );
            const notice = await waitFor(() => readNotice(page), 3000);
            expect(notice && /Phone Number/.test(notice.text), `Gmail did not check text edited inside the quote`);
          });

          const lines = Array.from({ length: 25 }, (_, i) => `Contact person${i + 1}@example.test.`).join("\n");
          await withFixture(providers[0], providers[0].reply, async (page) => {
            await page.evaluate((value) => {
              const button = document.createElement("button");
              button.id = "copy-test-text";
              button.textContent = "Copy test text";
              button.addEventListener("click", async () => {
                try {
                  await navigator.clipboard.writeText(value);
                  window.__clipboardWritten = true;
                } catch (error) {
                  window.__clipboardError = error.message;
                }
              });
              document.body.append(button);
            }, lines);
            await page.click("#copy-test-text");
            await waitFor(() => page.evaluate(() => window.__clipboardWritten || window.__clipboardError), 3000);
            const clipboardError = await page.evaluate(() => window.__clipboardError);
            expect(!clipboardError, `test clipboard write failed: ${clipboardError}`);
            await page.evaluate(() => {
              const reply = document.querySelector("#reply");
              const range = document.createRange();
              range.selectNodeContents(reply);
              range.collapse(false);
              getSelection().removeAllRanges();
              getSelection().addRange(range);
              document.querySelector("#body").focus();
            });
            await page.keyboard.down("Control");
            await page.keyboard.press("v");
            await page.keyboard.up("Control");
            const notice = await waitFor(() => readNotice(page), 5000);
            expect(
              notice && /Large paste: \d+ lines, with Email Address ×25/.test(notice.text),
              `real paste wording: ${notice?.text}`,
            );
          });

          await withFixture(providers[0], providers[0].reply, async (page) => {
            await typeText(page, lines);
            const notice = await waitFor(() => readNotice(page), 5000);
            expect(notice && /This message has/.test(notice.text), `typed message wording: ${notice?.text}`);
            expect(!/Large paste/.test(notice.text), `typed text was called a paste: ${notice.text}`);
          });

          return "reply headers stayed quiet, typed details and forwarded keys warned, paste wording followed how text arrived";
        },
        ["https://outlook.office.com/*", "https://mail.yahoo.com/*"],
        true,
      ),
  );

  // The welcome page offers the email and chat apps in a card right after "Pin Clotr": nothing ticked, one button
  // whose words follow the ticks, and one browser prompt for exactly the apps you ticked. Since a script can't
  // click that prompt, I record it instead, noting whether it arrived while the click was still being handled,
  // and answer it with `answer`. A copy with the apps already granted stands in for apps that are already on.
  const APPS = {
    email: ["Gmail", "Outlook", "Yahoo Mail"],
    chat: ["Discord", "Slack", "WhatsApp", "Messenger", "Microsoft Teams"],
  };
  const PIN_LOCK = { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) }; // a PIN nobody unlocked
  async function openWelcome(c, answer = false, width = 700) {
    const page = await c.browser.newPage();
    page.on("pageerror", (err) => c.problems.push(`welcome page error: ${err.message}`));
    await page.setViewport({ width, height: 900 });
    await page.evaluateOnNewDocument((yes) => {
      window.__asks = [];
      let inClick = false;
      addEventListener("click", () => (inClick = true), true);
      addEventListener("click", () => (inClick = false));
      chrome.permissions.request = (p) => {
        window.__asks.push({ origins: p.origins, inClick });
        return Promise.resolve(yes);
      };
    }, answer);
    await page.goto(`chrome-extension://${new URL(c.swTarget.url()).host}/vault.html?welcome=1`);
    // The card mounts only once chrome.permissions.getAll() answers, a round trip through the browser that a
    // loaded machine can stretch well past a fixed pause; a fixed pause alone once left the card still unmounted.
    await waitFor(() => page.evaluate(() => Boolean(document.getElementById("everyday-offer"))), 10000);
    await sleep(500);
    // The email/chat and search/support cards now live inside "Pick sites one by one instead", closed by
    // default, so a real click on anything in them needs the fold open first.
    await page.evaluate(() => {
      const d = document.getElementById("where-pick-sites");
      if (d) d.open = true;
    });
    return page;
  }
  const readOffer = (page) =>
    page.evaluate(() => {
      const card = document.getElementById("everyday-offer");
      const groups = [...(card?.querySelectorAll("fieldset") || [])].map((f) => ({
        legend: f.querySelector("legend")?.textContent.trim(),
        // An On app can still be unticked, so I read "on" (the browser's grant) from the On tag, not from `disabled`.
        apps: [...f.querySelectorAll("label")].map((l) => {
          const box = l.querySelector("input[type=checkbox]");
          const tag = l.querySelector(".ev-tag");
          return {
            name: box?.value,
            ticked: box?.checked,
            on: Boolean(tag && !tag.hidden),
            text: l.textContent.trim(),
          };
        }),
      }));
      const go = document.getElementById("ev-go");
      const hint = document.getElementById("ev-hint");
      return {
        shown: Boolean(card && !card.hidden && card.getClientRects().length),
        afterPin: Boolean(card && document.getElementById("pin-step").compareDocumentPosition(card) & 4),
        beforeTry: Boolean(card && card.compareDocumentPosition(document.getElementById("try")) & 4),
        groups,
        button: go?.textContent.trim(),
        buttonOff: go?.getAttribute("aria-disabled") === "true",
        buttonHidden: Boolean(go?.hidden),
        hintHidden: Boolean(hint?.hidden),
        status: document.getElementById("ev-status")?.textContent.trim(),
        focused: document.activeElement?.value || document.activeElement?.id || "",
        asks: window.__asks,
        removes: window.__removes,
      };
    });
  // The card mounts itself asynchronously (it waits on chrome.permissions.getAll() before its first paint), so a
  // click right after the page loads can land before the boxes exist. A loaded machine made this miss once: the
  // click silently found nothing, so nothing got ticked and the button kept its untouched wording.
  const tick = async (page, names) => {
    await waitFor(
      () => page.evaluate(() => document.querySelectorAll("#everyday-offer input[type=checkbox]").length > 0),
      5000,
    );
    await page.evaluate((list) => {
      for (const box of document.querySelectorAll("#everyday-offer input[type=checkbox]")) {
        if (list.includes(box.value) && !box.checked) box.click();
      }
    }, names);
  };
  const offerShots = async (page, name) => {
    for (const width of [700, 380]) {
      for (const theme of ["light", "dark"]) {
        await shotAt(page, `${name}-${width}-${theme}.png`, { width, height: 900, theme, selector: "#everyday-offer" });
      }
    }
  };

  await check(
    "EV4",
    "Welcome page: the email and chat card, after Pin Clotr, nothing ticked, nothing asked",
    async () => {
      const page = await openWelcome(ctx);
      try {
        const first = await readOffer(page);
        expect(first.shown, "no email and chat card on the welcome page");
        expect(first.afterPin && first.beforeTry, `not between Pin Clotr and Try it: ${JSON.stringify(first)}`);
        expect(
          JSON.stringify(first.groups.map((g) => [g.legend, g.apps.map((a) => a.name)])) ===
            JSON.stringify([
              ["Email", APPS.email],
              ["Chat apps", APPS.chat],
            ]),
          `groups: ${JSON.stringify(first.groups)}`,
        );
        expect(!first.groups.some((g) => g.apps.some((a) => a.ticked || a.on)), "something was ticked for you");
        expect(first.button === "Switch on" && first.buttonOff, `button with nothing ticked: ${first.button}`);
        await offerShots(page, "welcome-email-card");
        await page.click("#ev-go");
        await sleep(200);
        const none = await readOffer(page);
        expect(none.asks.length === 0, `asked with nothing ticked: ${JSON.stringify(none.asks)}`);
        expect(/Tick at least one app first/.test(none.status), `status: ${none.status}`);
        expect(none.focused === "Gmail", `focus after an empty click: ${none.focused}`);
        await tick(page, ["Gmail", "Discord"]);
        const two = await readOffer(page);
        expect(two.button === "Switch on Gmail and Discord" && !two.buttonOff, `button: ${two.button}`);
        expect(!two.status, `the old line stayed after ticking: ${two.status}`);
        await tick(page, ["Slack"]);
        expect((await readOffer(page)).button === "Switch on 3 apps", "three ticked");
        await offerShots(page, "welcome-email-card-ticked");
        expect((await readOffer(page)).asks.length === 0, "asked before the button was pressed");
      } finally {
        await page.close();
      }
      // A Spanish browser: the same card in Spanish.
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const p = await openWelcome(es);
        await tick(p, ["Gmail", "Discord"]);
        const r = await readOffer(p);
        expect(
          r.groups.map((g) => g.legend).join("|") === "Correo|Apps de chat" && r.button === "Activar Gmail y Discord",
          `Spanish: ${JSON.stringify({ legends: r.groups.map((g) => g.legend), button: r.button })}`,
        );
        await offerShots(p, "welcome-email-card-es");
        await p.close();
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // Ticking Slack and WhatsApp, clicking the button, and saying no to Firefox's question should leave the ticks
  // live, so "Tick and try again" still makes sense, not stuck. Firefox's doorhanger can report a permission added
  // and then taken back while it's still deciding, so the extension sees `permissions.onAdded` before anyone has
  // actually answered. `refresh()` then disables the two boxes as if they were already on, and nothing undoes that
  // once the real answer comes back No. I simulate this by having `getAll` briefly claim Slack and WhatsApp are
  // granted while the ask is pending, then fall back to neither once it resolves to No.
  await check(
    "EV13",
    "Welcome page: a stray permission-added event during the ask must not leave ticks stuck once the answer is No",
    async () => {
      const page = await ctx.browser.newPage();
      page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
      await page.setViewport({ width: 700, height: 900 });
      await page.evaluateOnNewDocument(() => {
        // The welcome page mounts more than one offer card, each with its own real addListener call, so the
        // mock has to fire every one of them the way a real browser's event does, not just the last registered.
        const added = [];
        chrome.permissions.onAdded = { addListener: (cb) => added.push(cb) };
        chrome.permissions.onRemoved = { addListener: () => {} };
        let granted = [];
        const realGetAll = chrome.permissions.getAll.bind(chrome.permissions);
        chrome.permissions.getAll = async () => (granted.length ? { origins: granted } : realGetAll());
        window.__strayGrant = (origins) => {
          granted = origins;
          added.forEach((cb) => cb({ origins }));
        };
        window.__clearStrayGrant = () => {
          granted = [];
        };
        // Firefox's doorhanger is still open here, so the request's promise doesn't settle until the test says so.
        let settle;
        chrome.permissions.request = () => new Promise((r) => (settle = r));
        window.__answerNo = () => settle?.(false);
      });
      await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
      await sleep(500);
      await page.evaluate(() => {
        const d = document.getElementById("where-pick-sites");
        if (d) d.open = true;
      });
      try {
        await tick(page, ["Slack", "WhatsApp"]);
        await page.click("#ev-go"); // Firefox's question is now open and unanswered
        await sleep(100);
        // While the prompt is still open, Firefox reports the permission as added, and then takes it back once the
        // test answers No below, the same thing its doorhanger can do before anyone has actually clicked anything.
        await page.evaluate(() => window.__strayGrant(["https://app.slack.com/*", "https://web.whatsapp.com/*"]));
        await sleep(100);
        const stray = await readOffer(page);
        const strayOn = stray.groups.flatMap((g) => g.apps).filter((a) => a.on);
        expect(
          strayOn.map((a) => a.name).join() === "Slack,WhatsApp",
          `the stray grant didn't disable the boxes (so this test wouldn't prove anything): ${JSON.stringify(stray.groups)}`,
        );
        await page.evaluate(() => window.__clearStrayGrant());
        await page.evaluate(() => window.__answerNo());
        await sleep(300);
        const afterNo = await readOffer(page);
        expect(/Nothing was switched on/.test(afterNo.status), `status after No: ${afterNo.status}`);
        const two = (r) => r.groups.flatMap((g) => g.apps).filter((a) => ["Slack", "WhatsApp"].includes(a.name));
        expect(
          two(afterNo).every((a) => !a.on),
          `still disabled after the real answer came back No: ${JSON.stringify(afterNo.groups)}`,
        );
        // Whichever way the recovery leaves the ticks, a real click on either box must still change it. That was
        // the bug: a box that no click could move.
        const before = Object.fromEntries(two(afterNo).map((a) => [a.name, a.ticked]));
        await page.click('#everyday-offer input[value="Slack"]');
        await page.click('#everyday-offer input[value="WhatsApp"]');
        const after = two(await readOffer(page));
        expect(
          after.every((a) => a.ticked !== before[a.name]),
          `a click didn't change the tick: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  // In manual Firefox testing, ticking Slack and WhatsApp, pressing the button, and saying No never brought up
  // the "Nothing was switched on" line at all. A stray permission-added event can land on either side of the real
  // answer: before it resolves, which EV13 covers, or straddling it with the matching onRemoved firing after. The
  // message has to survive both orders, not just flash and disappear.
  await check(
    "EV14",
    "Welcome page: the 'nothing switched on' message survives a stray permission event landing on either side of the No",
    async () => {
      async function run(order) {
        const page = await ctx.browser.newPage();
        page.on("pageerror", (err) => ctx.problems.push(`welcome page error (${order}): ${err.message}`));
        await page.setViewport({ width: 700, height: 900 });
        await page.evaluateOnNewDocument(() => {
          // The welcome page mounts more than one offer card, each with its own real addListener call, so the
          // mock has to fire every one of them the way a real browser's event does, not just the last registered.
          const added = [];
          const removed = [];
          chrome.permissions.onAdded = { addListener: (cb) => added.push(cb) };
          chrome.permissions.onRemoved = { addListener: (cb) => removed.push(cb) };
          let granted = [];
          const realGetAll = chrome.permissions.getAll.bind(chrome.permissions);
          chrome.permissions.getAll = async () => (granted.length ? { origins: granted } : realGetAll());
          window.__strayAdd = (origins) => {
            granted = origins;
            added.forEach((cb) => cb({ origins }));
          };
          window.__strayRemove = (origins) => {
            granted = [];
            removed.forEach((cb) => cb({ origins }));
          };
          // Firefox's doorhanger is still open here, so the request's promise doesn't settle until the test says so.
          let settle;
          chrome.permissions.request = () => new Promise((r) => (settle = r));
          window.__answerNo = () => settle?.(false);
        });
        await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
        await sleep(500);
        await page.evaluate(() => {
          const d = document.getElementById("where-pick-sites");
          if (d) d.open = true;
        });
        try {
          await tick(page, ["Slack", "WhatsApp"]);
          await page.click("#ev-go"); // Firefox's question is now open and unanswered
          await sleep(100);
          const origins = ["https://app.slack.com/*", "https://web.whatsapp.com/*"];
          await page.evaluate((o) => window.__strayAdd(o), origins);
          await sleep(100);
          if (order === "removedBeforeTheAnswer") {
            await page.evaluate((o) => window.__strayRemove(o), origins);
            await sleep(100);
            await page.evaluate(() => window.__answerNo());
          } else {
            await page.evaluate(() => window.__answerNo());
            await sleep(100);
            await page.evaluate((o) => window.__strayRemove(o), origins);
          }
          await sleep(300);
          const first = await readOffer(page);
          expect(/Nothing was switched on/.test(first.status), `${order}: status right after the No: ${first.status}`);
          await sleep(1000); // long enough for any late event's own re-render to have landed
          const later = await readOffer(page);
          expect(/Nothing was switched on/.test(later.status), `${order}: status a second later: ${later.status}`);
        } finally {
          await page.close();
        }
      }
      await run("removedBeforeTheAnswer");
      await run("removedAfterTheAnswer");
    },
  );

  await check(
    "EV5",
    "Welcome page: one click asks once for exactly the ticked apps; a yes shows them On and stores nothing",
    async () => {
      const before = (await store.get(ctx, "everydayOffer")).everydayOffer;
      await store.set(ctx, { siteKinds: {} });
      const page = await openWelcome(ctx, true);
      try {
        await tick(page, ["Discord", "Gmail"]);
        await page.click("#ev-go");
        await sleep(300);
        const r = await readOffer(page);
        expect(r.asks.length === 1, `asks: ${JSON.stringify(r.asks)}`);
        expect(
          JSON.stringify(r.asks[0]) ===
            JSON.stringify({ origins: ["https://mail.google.com/*", "https://discord.com/*"], inClick: true }),
          `ask: ${JSON.stringify(r.asks[0])}`,
        );
        expect(/On for Gmail and Discord/.test(r.status), `status: ${r.status}`);
        const apps = r.groups.flatMap((g) => g.apps);
        for (const name of ["Gmail", "Discord"]) {
          const a = apps.find((x) => x.name === name);
          expect(a.ticked && a.on && /On$/.test(a.text), `${name} after a yes: ${JSON.stringify(a)}`);
        }
        expect(!apps.some((a) => a.on && !["Gmail", "Discord"].includes(a.name)), "other apps shown as On");
        expect(r.button === "Switch on" && r.buttonOff, `button after a yes: ${r.button}`);
        await offerShots(page, "welcome-email-card-on");
        const { everydayOffer, siteKinds = {} } = await store.get(ctx, ["everydayOffer", "siteKinds"]);
        expect(everydayOffer === "done", `everydayOffer: ${everydayOffer}`);
        expect(!Object.keys(siteKinds).length, `stored per site: ${JSON.stringify(siteKinds)}`);
      } finally {
        await page.close();
        await store.set(ctx, { everydayOffer: before ?? "welcome" });
      }
    },
  );

  await check("EV6", "Welcome page: a No from the browser switches nothing on and keeps the ticks", async () => {
    const before = (await store.get(ctx, "everydayOffer")).everydayOffer;
    const page = await openWelcome(ctx, false);
    try {
      await tick(page, ["Gmail", "Discord"]);
      await page.click("#ev-go");
      await sleep(300);
      const r = await readOffer(page);
      expect(r.asks.length === 1, `asks: ${JSON.stringify(r.asks)}`);
      expect(/Nothing was switched on/.test(r.status), `status: ${r.status}`);
      const apps = r.groups.flatMap((g) => g.apps);
      expect(
        apps
          .filter((a) => a.ticked)
          .map((a) => a.name)
          .join() === "Gmail,Discord" && !apps.some((a) => a.on),
        `after a No: ${JSON.stringify(apps)}`,
      );
      expect(r.button === "Switch on Gmail and Discord" && !r.buttonOff, `button after a No: ${r.button}`);
      const { origins = [] } = await ctx.worker.evaluate(() => chrome.permissions.getAll());
      expect(!origins.includes("https://mail.google.com/*"), "Gmail granted after a No");
    } finally {
      await page.close();
      await store.set(ctx, { everydayOffer: before ?? "welcome" });
    }
    // With a PIN set and not unlocked, the card is hidden, as the vault's form is.
    await store.set(ctx, { lock: PIN_LOCK });
    try {
      const locked = await openWelcome(ctx);
      const shown = (await readOffer(locked)).shown;
      await locked.close();
      expect(!shown, "the card shows while Clotr is locked");
    } finally {
      await ctx.worker.evaluate(() => enqueue(() => chrome.storage.local.remove("lock")));
    }
  });

  await check("EV7", "Welcome page: apps already on show as On, and ticking one more asks for just that one", () =>
    withGrantedCopy(async (other) => {
      const page = await openWelcome(other, true);
      try {
        const r = await readOffer(page);
        const apps = r.groups.flatMap((g) => g.apps);
        expect(
          apps
            .filter((a) => a.on)
            .map((a) => a.name)
            .join() === "Gmail,Discord" && apps.filter((a) => a.ticked).length === 2,
          `already on: ${JSON.stringify(apps)}`,
        );
        await tick(page, ["Slack"]);
        expect((await readOffer(page)).button === "Switch on Slack", "button with Slack ticked");
        await page.click("#ev-go");
        await sleep(300);
        const after = await readOffer(page);
        expect(
          JSON.stringify(after.asks) === JSON.stringify([{ origins: ["https://app.slack.com/*"], inClick: true }]),
          `asks: ${JSON.stringify(after.asks)}`,
        );
      } finally {
        await page.close();
      }
    }),
  );

  // Someone who already had Clotr sees this same offer once in the popup after an update, with the word
  // `everydayOffer` set to "popup". It shows before "what's new", since the top slot holds one card at a time.
  const readTop = (popup) =>
    popup.evaluate(() => {
      const offer = document.getElementById("everyday-offer");
      const news = document.getElementById("whats-new");
      return {
        offer: !offer.hidden,
        news: !news.hidden,
        newsOpen: document.getElementById("whats-new-more").open,
        title: offer.querySelector("h2")?.textContent.trim(),
        boxes: [...offer.querySelectorAll("input[type=checkbox]")].map((b) => (b.checked ? `${b.value}✓` : b.value)),
        asks: window.__asks || [],
      };
    });
  const recordAsks = (popup, answer) =>
    popup.evaluate((yes) => {
      window.__asks = [];
      let inClick = false;
      addEventListener("click", () => (inClick = true), true);
      addEventListener("click", () => (inClick = false));
      chrome.permissions.request = (p) => {
        window.__asks.push({ origins: p.origins, inClick });
        return yes === null ? new Promise(() => {}) : Promise.resolve(yes); // null: the prompt is still open
      };
    }, answer);
  const offerOf = async (c) => (await store.get(c, "everydayOffer")).everydayOffer;

  const clickEverydayButton = (page, name) =>
    page.evaluate((n) => {
      const li = [...document.querySelectorAll("#everyday-sites li")].find(
        (l) => l.querySelector("b")?.textContent === n,
      );
      li?.querySelector("button")?.click();
    }, name);

  // Settings has its own switch per app, separate from the welcome card, so it needs the same message on its
  // own. A silent No there was just as confusing as the card's.
  await check(
    "EV15",
    "Settings: the Turn on button for an email or chat app also says so when the browser's answer is No, instead of doing nothing",
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await recordAsks(popup, false);
        await clickEverydayButton(popup, "Slack");
        await sleep(300);
        const status = await popup.$eval("#everyday-status", (p) => p.textContent.trim());
        expect(/Nothing was switched on/.test(status), `status: ${status}`);
        await popup.evaluate(() => document.getElementById("everyday-status").scrollIntoView({ block: "center" }));
        for (const theme of ["light", "dark"]) {
          await shotAt(popup, `settings-everyday-no-${theme}.png`, { height: 700, theme });
        }
        const asks = await popup.evaluate(() => window.__asks);
        expect(asks.length === 1, `asks: ${JSON.stringify(asks)}`);
        const stillOff = await popup.evaluate(() => {
          const li = [...document.querySelectorAll("#everyday-sites li")].find(
            (l) => l.querySelector("b")?.textContent === "Slack",
          );
          return li?.querySelector("button")?.textContent;
        });
        expect(stillOff === "Turn on", `button after a No: ${stillOff}`);
      } finally {
        await popup.close();
      }
    },
  );

  await check(
    "EV8",
    "Popup after an update: the email and chat card once, before what's new; No thanks brings the short what's new",
    async () => {
      const before = await offerOf(ctx);
      const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
      const update = { from: "1.0.0", to: version, t: Date.now(), seen: false };
      try {
        await store.set(ctx, { everydayOffer: "popup", lastUpdate: update });
        const popup = await openPopup(ctx);
        try {
          await recordAsks(popup, false);
          const first = await readTop(popup);
          expect(first.offer && !first.news, `top slot: ${JSON.stringify(first)}`);
          expect(first.title === "Use Clotr on your email and chat apps too?", `title: ${first.title}`);
          expect(first.boxes.join() === [...APPS.email, ...APPS.chat].join(), `boxes: ${first.boxes}`);
          for (const theme of ["light", "dark"]) await shotAt(popup, `popup-email-card-${theme}.png`, { theme });
          await tick(popup, ["Gmail", "Discord"]);
          for (const theme of ["light", "dark"]) await shotAt(popup, `popup-email-card-ticked-${theme}.png`, { theme });
          await popup.click("#ev-no");
          await sleep(300);
          const after = await readTop(popup);
          expect(!after.offer && after.news && !after.newsOpen, `after No thanks: ${JSON.stringify(after)}`);
          expect(after.asks.length === 0, `No thanks asked the browser: ${JSON.stringify(after.asks)}`);
          expect((await offerOf(ctx)) === "done", "No thanks didn't count as answered");
        } finally {
          await popup.close();
        }
        const again = await openPopup(ctx);
        const later = await readTop(again);
        await again.close();
        expect(!later.offer && later.news, `the next time: ${JSON.stringify(later)}`);

        // The card never shows while locked, and it waits for an unlocked popup. It also never shows again once
        // the welcome page already made the offer.
        for (const [state, extra] of [
          ["locked", { everydayOffer: "popup", lock: PIN_LOCK }],
          ["a new install", { everydayOffer: "welcome" }],
        ]) {
          await store.set(ctx, extra);
          try {
            const p = await openPopup(ctx);
            const r = await readTop(p);
            await p.close();
            expect(!r.offer, `the card showed for ${state}`);
          } finally {
            await ctx.worker.evaluate(() => enqueue(() => chrome.storage.local.remove("lock")));
          }
          expect((await offerOf(ctx)) === extra.everydayOffer, `${state}: the offer's word changed`);
        }
      } finally {
        await store.set(ctx, {
          everydayOffer: before ?? "welcome",
          lastUpdate: { ...update, seen: true },
        });
      }

      // If an app is already on, switched on some other way, there's no card, and the offer counts as done.
      const granted = await withGrantedCopy(async (other) => {
        await store.set(other, { everydayOffer: "popup" });
        const p = await openPopup(other);
        const r = await readTop(p);
        await p.close();
        return { shown: r.offer, word: await offerOf(other) };
      });
      expect(!granted.shown && granted.word === "done", `with apps already on: ${JSON.stringify(granted)}`);

      // A Spanish browser: the same card in Spanish.
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        await waitFor(() => offerOf(es), 3000); // the new install's own word first ("welcome")
        await store.set(es, { everydayOffer: "popup" });
        const p = await openPopup(es);
        const r = await readTop(p);
        expect(r.offer && r.title === "¿Usar Clotr también en tu correo y tus apps de chat?", `Spanish: ${r.title}`);
        for (const theme of ["light", "dark"]) await shotAt(p, `popup-email-card-es-${theme}.png`, { theme });
        await tick(p, ["Gmail", "Discord"]);
        for (const theme of ["light", "dark"]) await shotAt(p, `popup-email-card-ticked-es-${theme}.png`, { theme });
        await p.close();
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check(
    "EV9",
    "Popup card: one ask, in the click, for exactly the ticked apps; answered even if the popup closes at once",
    async () => {
      const before = await offerOf(ctx);
      try {
        await store.set(ctx, { everydayOffer: "popup" });
        const popup = await openPopup(ctx);
        await recordAsks(popup, null); // the browser's prompt opens and the popup closes, as it often does
        await tick(popup, ["WhatsApp", "Gmail"]);
        await popup.click("#ev-go");
        const asks = await popup.evaluate(() => window.__asks);
        await popup.close();
        expect(
          JSON.stringify(asks) ===
            JSON.stringify([{ origins: ["https://mail.google.com/*", "https://web.whatsapp.com/*"], inClick: true }]),
          `asks: ${JSON.stringify(asks)}`,
        );
        expect((await waitFor(async () => (await offerOf(ctx)) === "done", 2000)) === true, "not answered");

        // If the popup is still open when the browser says yes, the card makes way for what's new, though none
        // is due here.
        await store.set(ctx, { everydayOffer: "popup" });
        const open = await openPopup(ctx);
        try {
          await recordAsks(open, true);
          await tick(open, ["Slack"]);
          await open.click("#ev-go");
          await sleep(300);
          const r = await readTop(open);
          expect(!r.offer && r.asks.length === 1, `after a yes: ${JSON.stringify(r)}`);
        } finally {
          await open.close();
        }
      } finally {
        await store.set(ctx, { everydayOffer: before ?? "welcome" });
      }
    },
  );

  // What Clotr stores lists the email and chat apps that are on based on what the browser actually granted. Older
  // versions wrote that note before the browser answered and kept it after a No, so the page listed apps Clotr
  // wasn't actually running on.
  await check("EV10", "What Clotr stores lists only the email and chat apps the browser granted", async () => {
    const readRow = async (c) => {
      const page = await openExtPage(c, "stored.html");
      try {
        await sleep(300);
        return await page.evaluate(() => {
          const dt = [...document.querySelectorAll("#settings dt")].find((d) =>
            /Email and chat sites/.test(d.textContent),
          );
          return dt?.nextElementSibling?.textContent ?? null;
        });
      } finally {
        await page.close();
      }
    };
    await store.set(ctx, { siteKinds: { "mail.google.com": "everyday", "discord.com": "everyday" } });
    let refused;
    try {
      refused = await readRow(ctx);
    } finally {
      await store.set(ctx, { siteKinds: {} });
    }
    expect(refused === "None", `listed after the browser said No: ${refused}`);
    const granted = await withGrantedCopy((other) => readRow(other));
    expect(/mail\.google\.com/.test(granted) && /discord\.com/.test(granted), `granted, not listed: ${granted}`);
    expect(!/chatgpt|claude|gemini/.test(granted), `AI sites listed as email or chat apps: ${granted}`);
    return granted;
  });

  // A script can't click the browser's own prompt, so I record the popup's ask instead, noting whether it came
  // while the click was still being handled. Firefox refuses a prompt that arrives any later than that.
  await check(
    "EV11",
    "Settings: switching on an email or chat app asks at once, for just that app, and stores nothing",
    async () => {
      await store.set(ctx, { siteKinds: {} });
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        // #everyday-sites lives inside "Pick sites one by one instead", closed by default, and a real click
        // needs the row's button to actually be on screen.
        await popup.evaluate(() => {
          document.getElementById("pick-sites").open = true;
        });
        await popup.evaluate(() => {
          window.__asks = [];
          let inClick = false;
          addEventListener("click", () => (inClick = true), true);
          addEventListener("click", () => (inClick = false));
          chrome.permissions.request = (p) => {
            window.__asks.push({ origins: p.origins, inClick });
            return Promise.resolve(false); // the person said No
          };
        });
        const rowButton = (name) =>
          popup.evaluateHandle(
            (n) =>
              [...document.querySelectorAll("#everyday-sites li")]
                .find((li) => li.querySelector("b")?.textContent === n)
                ?.querySelector("button"),
            name,
          );
        for (const name of ["Gmail", "Outlook"]) {
          await (await rowButton(name)).click();
          await sleep(300);
        }
        const asks = await popup.evaluate(() => window.__asks);
        expect(asks.length === 2, `asks: ${JSON.stringify(asks)}`);
        expect(
          JSON.stringify(asks[0]) === JSON.stringify({ origins: ["https://mail.google.com/*"], inClick: true }),
          `Gmail: ${JSON.stringify(asks[0])}`,
        );
        expect(
          JSON.stringify(asks[1]) ===
            JSON.stringify({ origins: ["https://outlook.live.com/*", "https://outlook.office.com/*"], inClick: true }),
          `Outlook: ${JSON.stringify(asks[1])}`,
        );
        const { siteKinds = {} } = await store.get(ctx, "siteKinds");
        expect(Object.keys(siteKinds).length === 0, `stored after a No: ${JSON.stringify(siteKinds)}`);
        const still = await (await rowButton("Gmail")).evaluate((b) => b.textContent);
        expect(still === "Turn on", `Gmail after a No: ${still}`);
      } finally {
        await popup.close();
        await store.set(ctx, { siteKinds: {} });
      }
    },
  );

  // The one-time offer to use Clotr on email and chat apps is tracked by a single word, `everydayOffer`. The
  // welcome page sets it for a new install, and someone who already had Clotr sees the offer once in the popup
  // after an update, unless an app is already on. This check covers that word and where it shows, not the cards
  // that read it later.
  await check(
    "EV12",
    "The email and chat offer's word: welcome on install, popup once after an update, shown in What Clotr stores",
    async () => {
      const forget = (c) => c.worker.evaluate(() => enqueue(() => chrome.storage.local.remove("everydayOffer")));
      const fresh = await withGrantedCopy(async (other) => {
        const installed = await waitFor(() => offerOf(other), 3000);
        await forget(other); // as if installed before this release, with Gmail and Discord already on
        const updated = await other.worker.evaluate(() => noteEverydayOffer("update"));
        return { installed, updated, kept: await offerOf(other) };
      });
      expect(fresh.installed === "welcome", `a new install: ${fresh.installed}`);
      expect(fresh.updated === "done" && fresh.kept === "done", `an update with apps on: ${JSON.stringify(fresh)}`);

      const before = await offerOf(ctx);
      try {
        await forget(ctx); // installed before this release, no app on
        const steps = [];
        for (const reason of ["update", "update", "chrome_update"]) {
          steps.push(await ctx.worker.evaluate((r) => noteEverydayOffer(r), reason));
        }
        expect(steps.join() === "popup,popup,popup", `updates with no app on: ${steps.join()}`);
        const page = await openExtPage(ctx, "stored.html");
        try {
          await sleep(300);
          const row = await page.evaluate(() => {
            const dt = [...document.querySelectorAll("#other dt")].find((d) =>
              /email and chat apps/.test(d.textContent),
            );
            return dt ? `${dt.textContent}: ${dt.nextElementSibling?.textContent}` : null;
          });
          expect(/toolbar button/.test(row || ""), `What Clotr stores: ${row}`);
          return row;
        } finally {
          await page.close();
        }
      } finally {
        await store.set(ctx, { everydayOffer: before ?? "welcome" });
      }
    },
  );

  // The card used to leave an already-on app ticked and disabled forever, showing a "Switch on" button and a
  // "Nothing is ticked for you" hint that were both no longer true. Now an On app can be unticked to give the
  // site back. The button says which way each app is moving, and once the ticks match what's already on, there's
  // nothing left to press.
  await check(
    "EV16",
    "Welcome page: an On app can be unticked to switch it off; settled, there's no button and no stale hint",
    async () => {
      const before = (await store.get(ctx, "everydayOffer")).everydayOffer;
      const page = await ctx.browser.newPage();
      page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
      await page.setViewport({ width: 700, height: 900 });
      await page.evaluateOnNewDocument(() => {
        window.__asks = [];
        window.__removes = [];
        chrome.permissions.request = (p) => {
          window.__asks.push(p.origins);
          return Promise.resolve(true);
        };
        chrome.permissions.remove = (p) => {
          window.__removes.push(p.origins);
          return Promise.resolve(true);
        };
      });
      await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
      await sleep(500);
      await page.evaluate(() => {
        const d = document.getElementById("where-pick-sites");
        if (d) d.open = true;
      });
      try {
        await tick(page, ["Gmail", "Discord"]);
        await page.click("#ev-go");
        await sleep(300);
        const on = await readOffer(page);
        expect(
          on.buttonHidden && on.hintHidden,
          `settled with two apps on: ${JSON.stringify({ buttonHidden: on.buttonHidden, hintHidden: on.hintHidden })}`,
        );
        const onNames = on.groups
          .flatMap((g) => g.apps)
          .filter((a) => a.on)
          .map((a) => a.name);
        expect(onNames.join() === "Gmail,Discord", `on after switching on: ${onNames}`);

        // Unticking Gmail brings the button back, offering to switch it off, while Discord's own tick and On tag
        // stay put.
        await page.click('#ev-groups input[value="Gmail"]');
        const unticked = await readOffer(page);
        expect(
          !unticked.buttonHidden && unticked.button === "Switch off Gmail",
          `button after unticking Gmail: ${JSON.stringify({ hidden: unticked.buttonHidden, button: unticked.button })}`,
        );
        const discord = unticked.groups.flatMap((g) => g.apps).find((a) => a.name === "Discord");
        expect(discord.ticked && discord.on, `Discord moved too: ${JSON.stringify(discord)}`);
        await offerShots(page, "welcome-email-card-switch-off");

        // Ticking Slack too means one click both switches it on and gives Gmail back.
        await page.click('#ev-groups input[value="Slack"]');
        const both = await readOffer(page);
        expect(both.button === "Switch on Slack, switch off Gmail", `combined button: ${both.button}`);
        await page.click("#ev-go");
        await sleep(300);
        const after = await readOffer(page);
        expect(
          after.asks.at(-1)?.join() === "https://app.slack.com/*" &&
            after.removes.at(-1)?.join() === "https://mail.google.com/*",
          `asked/removed: ${JSON.stringify({ asks: after.asks, removes: after.removes })}`,
        );
        expect(/On for Slack/.test(after.status) && /Off for Gmail/.test(after.status), `status: ${after.status}`);
        const afterNames = after.groups
          .flatMap((g) => g.apps)
          .filter((a) => a.on)
          .map((a) => a.name)
          .sort();
        expect(afterNames.join() === "Discord,Slack", `on after the combined click: ${afterNames}`);
        expect(
          after.buttonHidden && after.hintHidden,
          `settled again: ${JSON.stringify({ buttonHidden: after.buttonHidden, hintHidden: after.hintHidden })}`,
        );
      } finally {
        await page.close();
        await store.set(ctx, { everydayOffer: before ?? "welcome" });
      }
    },
  );

  // "Pick sites one by one instead" stays closed until something inside it is already on, so a switch someone
  // already flipped (an email app granted some other way, say) is never left hidden behind the fold.
  await check(
    "EV17",
    "Settings and the welcome page open 'Pick sites one by one instead' by themselves once an email or chat app is already on",
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        const open = await popup.$eval("#pick-sites", (d) => d.open);
        expect(!open, "Settings' fold was already open with nothing switched on");
      } finally {
        await popup.close();
      }
      const page = await ctx.browser.newPage();
      page.on("pageerror", (err) => ctx.problems.push(`welcome page error: ${err.message}`));
      await page.setViewport({ width: 700, height: 900 });
      await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/vault.html?welcome=1`);
      await waitFor(() => page.evaluate(() => Boolean(document.getElementById("everyday-offer"))), 10000);
      await sleep(500);
      try {
        const open = await page.evaluate(() => document.getElementById("where-pick-sites").open);
        expect(!open, "the welcome page's fold was already open with nothing switched on");
      } finally {
        await page.close();
      }

      await withGrantedCopy(async (other) => {
        const p = await openPopup(other);
        try {
          await p.click("#tab-settings");
          const open = await p.$eval("#pick-sites", (d) => d.open);
          expect(open, "Settings' fold stayed closed with Gmail and Discord already on");
        } finally {
          await p.close();
        }
        const w = await other.browser.newPage();
        w.on("pageerror", (err) => other.problems.push(`welcome page error: ${err.message}`));
        await w.setViewport({ width: 700, height: 900 });
        await w.goto(`chrome-extension://${new URL(other.swTarget.url()).host}/vault.html?welcome=1`);
        await waitFor(() => w.evaluate(() => Boolean(document.getElementById("everyday-offer"))), 10000);
        await sleep(500);
        try {
          const open = await w.evaluate(() => document.getElementById("where-pick-sites").open);
          expect(open, "the welcome page's fold stayed closed with Gmail and Discord already on");
        } finally {
          await w.close();
        }
      });
    },
  );

  // While "Everywhere I type" is on, the browser already covers every site, so asking for one more gets a yes with
  // no question and nothing added to its grants. The switches read only the grants, so Turn on did nothing there.
  // A copy whose manifest already grants the broad origin stands in for having switched it on.
  async function withBroadGrant(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    let other;
    try {
      fs.cpSync(EXT, copy, { recursive: true });
      const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
      m.host_permissions = [...m.host_permissions, "https://*/*"];
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
      other = await launch(copy);
      await resetState(other);
      return await fn(other);
    } finally {
      if (other) {
        await other.browser.close();
        fs.rmSync(other.profile, { recursive: true, force: true });
      }
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check(
    "EV19",
    "Everywhere I type on: covered apps read On and say why, and a search engine still turns on and stays on",
    () =>
      withBroadGrant(async (other) => {
        const sw = (list, name) => `#${list} button[aria-label="Clotr on ${name}"]`;
        const openSettings = async () => {
          const p = await openPopup(other);
          await p.click("#tab-settings");
          await p.evaluate(() => (document.getElementById("pick-sites").open = true));
          return p;
        };
        const reads = (p, sel) => p.$eval(sel, (b) => b.textContent);
        const row = (p, sel) => p.$eval(sel, (b) => b.closest("li").textContent);
        const said = (p, id) => p.$eval(`#${id}`, (s) => s.textContent);
        const google = sw("search-sites", "Google");
        let popup = await openSettings();
        try {
          for (const [list, name] of [
            ["everyday-sites", "Gmail"],
            ["everyday-sites", "Outlook"],
            ["support-sites", "Intercom"],
          ]) {
            expect((await reads(popup, sw(list, name))) === "On", `${name} isn't On under Everywhere I type`);
            const why = await row(popup, sw(list, name));
            expect(/through Everywhere I type/i.test(why), `${name}'s row says ${JSON.stringify(why)}`);
          }
          expect((await reads(popup, google)) === "Turn on", "a search engine reads On before it was switched on");

          // Clicking a covered app has nothing to ask for, so it stays On and says why.
          await popup.click(sw("everyday-sites", "Gmail"));
          const kept = await waitFor(
            async () => /keeps Clotr on here/.test(await said(popup, "everyday-status")),
            5000,
          );
          expect(kept, `clicking Gmail said ${JSON.stringify(await said(popup, "everyday-status"))}`);
          expect(
            (await reads(popup, sw("everyday-sites", "Gmail"))) === "On",
            "Gmail went off under Everywhere I type",
          );

          // A search engine: the browser says yes with nothing to ask, and the switch still turns on.
          await popup.click(google);
          const on = await waitFor(async () => (await reads(popup, google)) === "On", 5000);
          expect(on, `Google reads ${await reads(popup, google)} (status: ${await said(popup, "search-status")})`);
          const own = await waitFor(
            () =>
              other.worker.evaluate(async () => {
                const [mine] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
                const [wide] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-everywhere"] });
                const o = "https://www.google.com/*";
                return mine?.matches.includes(o) && (!wide || wide.excludeMatches.includes(o));
              }),
            5000,
          );
          expect(own, "Google isn't set up as a site of its own");
          await popup.close();
          popup = await openSettings();
          expect((await reads(popup, google)) === "On", "Google isn't On in the popup opened again");
          await popup.click(google);
          const off = await waitFor(async () => (await reads(popup, google)) === "Turn on", 5000);
          expect(off, `Google reads ${await reads(popup, google)} after switching it off`);
        } finally {
          await popup.close();
        }

        // The welcome page's card, the same way: Slack shows On and can't be unticked there, and DuckDuckGo
        // switches on.
        const page = await other.browser.newPage();
        page.on("pageerror", (err) => other.problems.push(`welcome page error: ${err.message}`));
        await page.setViewport({ width: 700, height: 900 });
        try {
          await page.goto(`chrome-extension://${new URL(other.swTarget.url()).host}/vault.html?welcome=1`);
          const slack = await waitFor(
            () =>
              page.evaluate(() => {
                const box = document.querySelector("#everyday-offer input[value=Slack]");
                return box?.checked && box.disabled && box.parentElement.classList.contains("on");
              }),
            10000,
          );
          expect(slack, "Slack isn't On on the card under Everywhere I type");
          await page.evaluate(() => (document.getElementById("where-pick-sites").open = true));
          await page.click("#more-sites-offer label.ev-app:has(input[value=DuckDuckGo])");
          await page.click("#ms-go");
          const on = await waitFor(
            () =>
              page.evaluate(async () =>
                (await globalThis.ClotrSites.userSitePatterns()).includes("https://duckduckgo.com/*"),
              ),
            5000,
          );
          expect(
            on,
            `DuckDuckGo isn't on after the card said: ${await page.$eval("#ms-status", (s) => s.textContent)}`,
          );
        } finally {
          await page.close();
        }
      }),
  );

  await check(
    "EV20",
    "An app an older version noted as an AI chat turns on from the popup when it's already granted",
    () =>
      withGrantedCopy(async (other) => {
        await store.set(other, { siteKinds: { "mail.google.com": "ai" } });
        const gmail = 'button[aria-label="Clotr on Gmail"]';
        const popup = await openPopup(other);
        try {
          await popup.click("#tab-settings");
          await popup.evaluate(() => (document.getElementById("pick-sites").open = true));
          const reads = () => popup.$eval(gmail, (b) => b.textContent);
          expect((await reads()) === "Turn on", `Gmail reads ${await reads()} with the old note`);
          await popup.click(gmail);
          const on = await waitFor(async () => (await reads()) === "On", 5000);
          expect(on, `Gmail reads ${await reads()} after Turn on`);
          const { siteKinds = {} } = await store.get(other, ["siteKinds"]);
          expect(!siteKinds["mail.google.com"], `the old note is still there: ${JSON.stringify(siteKinds)}`);
        } finally {
          await popup.close();
        }
      }),
  );
};
