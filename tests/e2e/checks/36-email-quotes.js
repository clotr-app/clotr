// E2E checks: EQ. On an email app you switched on, the message you're replying to stays out of the check. These
// checks hold the edges of that: nothing the sender wrote can widen the gap to what you type, the first thing you
// type into the quoted message is checked like the rest, and a huge quoted message never stalls the tab.
// ../run.js runs these checks in order, sharing one env with helpers from ../lib.js.
"use strict";

module.exports = async function (env) {
  const { EXT, check, clotrActive, expect, fs, launch, os, path, patience } = env;
  const {
    clickNode,
    clickSend,
    editorText,
    evalInClotr,
    readDialog,
    readNotice,
    resetState,
    store,
    typeText,
    waitFor,
  } = env;
  const KEY = "AKIA4HPQ7XZ2R6TWLJ3N";
  const ORIGIN = "https://mail.google.com";

  // A copy of the extension that may run on Gmail, switched on as an email app.
  async function withGmailCopy(fn, emailBandage = false) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    let other;
    try {
      fs.cpSync(EXT, copy, { recursive: true });
      const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
      m.host_permissions = [...m.host_permissions, "https://mail.google.com/*"];
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
      if (emailBandage) {
        // The shipped setting keeps Bandage off for email. This test-only build opens it to cover the editor path.
        const backgroundFile = path.join(copy, "background.js");
        const background = fs.readFileSync(backgroundFile, "utf8").replace(/\r\n/g, "\n");
        const disabled =
          'function bandageFor(everyday, host, r) {\n  return everyday ? false : host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined;\n}';
        const enabled =
          'function bandageFor(everyday, host, r) {\n  return host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined;\n}';
        expect(background.includes(disabled), "the email Bandage test couldn't find the guarded setting");
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
      await store.set(other, { siteKinds: { "mail.google.com": "everyday" } });
      await other.worker.evaluate(() => syncUserSites());
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            return s?.matches?.some((match) => match.includes("mail.google.com"));
          }),
        5000,
      );
      return await fn(other);
    } finally {
      if (other) {
        await other.browser.close();
        fs.rmSync(other.profile, { recursive: true, force: true });
      }
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  // Serves one made-up reply page as Gmail and waits for Clotr to start on it.
  async function withReplyPage(other, html, fn) {
    const url = `${ORIGIN}/clotr-test?variant=reply`;
    const page = await other.browser.newPage();
    page.site = { url, editor: 'document.querySelector("#body")', send: 'document.querySelector("#send")' };
    page.logs = [];
    page.on("console", async (entry) => {
      const text = (await Promise.all(entry.args().map((a) => a.jsonValue().catch(() => "")))).join(" ");
      page.logs.push(text);
      if (text.includes("[Clotr]") && ["error", "warn"].includes(entry.type())) {
        other.problems.push(`Gmail page ${entry.type()}: ${text}`);
      }
    });
    page.on("pageerror", (err) => other.problems.push(`Gmail page error: ${err.message}`));
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.resourceType() === "document" && req.url().startsWith(ORIGIN + "/")) {
        return req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      }
      return req.abort();
    });
    try {
      await page.goto(url, { waitUntil: "load" });
      await waitFor(() => page.logs.some((line) => line.includes("[Clotr] responses:")), 5000);
      expect(clotrActive(page), "Clotr did not run on Gmail");
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  // Puts the caret at the end of one element inside the reply box, the way a click there would.
  const caretAtEnd = (selector) => {
    document.querySelector("#body").focus();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const warningFor = (page) => waitFor(async () => (await readNotice(page)) || (await readDialog(page)), 3000);
  const fixture = (name) => fs.readFileSync(path.join(__dirname, "..", "pages", name), "utf8");

  // A Gmail reply whose quoted message carries whatever the sender put in it, with room to type below the quote.
  const craftedReply = (
    inQuote,
    readOnlyQuote = false,
  ) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gmail reply (Clotr test page)</title></head>
<body><div id="body" role="textbox" contenteditable="true" aria-label="Message Body" aria-multiline="true">
<div id="reply"><strong>Jerry,</strong></div><div class="gmail_quote"><div class="gmail_attr">On Monday, Someone Unknown &lt;unknown@example.test&gt; wrote:</div>
<blockquote class="gmail_quote" ${readOnlyQuote ? 'contenteditable="false"' : ""}><div class="quote-body">Please see the note below.</div>${inQuote}</blockquote></div>
<div id="below"><br></div></div><button id="send" type="button">Send</button></body></html>`;

  async function editReplyAndQuote(page, mainPhone, oldPhone, quotePhone) {
    await page.evaluate(caretAtEnd, "#reply");
    await page.keyboard.sendCharacter(`Call me at ${mainPhone}. `);
    await page.evaluate(
      ({ oldValue, newValue }) => {
        const node = document.querySelector("#edited").firstChild;
        node.nodeValue = node.nodeValue.replace(oldValue, newValue);
      },
      { oldValue: oldPhone, newValue: quotePhone },
    );
  }

  await check(
    "EQ1",
    "Email reply: markers a sender wrote into the quoted message can't hide what you type below it",
    () =>
      withGmailCopy(async (other) => {
        // An email app's own reply marker, as a sender could write it into their message.
        await withReplyPage(other, craftedReply('<div id="x_appendonsend"></div>'), async (page) => {
          await page.evaluate(caretAtEnd, "#below");
          await typeText(page, `API key: ${KEY}`);
          const notice = await warningFor(page);
          expect(
            notice && /AWS Access Key/.test(notice.text),
            "no warning for a key typed below a quoted reply marker",
          );
        });
        // A forwarded-message header line inside the quote, which any reply to a forward carries.
        await withReplyPage(other, craftedReply("<div>---------- Forwarded message ---------</div>"), async (page) => {
          await page.evaluate(caretAtEnd, "#below");
          await typeText(page, "Call me at 555-555-0123.");
          const notice = await warningFor(page);
          expect(
            notice && /Phone Number/.test(notice.text),
            "no warning for a phone typed below a quoted forward header",
          );
        });
        return "warned below a quoted reply marker and below a quoted forward header";
      }),
  );

  await check("EQ2", "Email reply: the first thing you type into the quoted message is checked too", () =>
    withGmailCopy((other) =>
      withReplyPage(other, fixture("email-gmail-reply.html"), async (page) => {
        await page.evaluate(caretAtEnd, ".quote-body");
        await typeText(page, ` My key is ${KEY}`);
        const notice = await warningFor(page);
        expect(notice && /AWS Access Key/.test(notice.text), "no warning for the first text typed into the quote");
        return "warned on the first edit inside the quote";
      }),
    ),
  );

  await check("EQ3", "Email reply: a huge quoted message full of blank lines never stalls the tab", () =>
    withGmailCopy(async (other) => {
      // A sender's message made of blank lines: the shape that makes a careless pattern crawl.
      const blankLines = "<div>&nbsp;</div>".repeat(25000);
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gmail reply (Clotr test page)</title></head>
<body><div id="body" role="textbox" contenteditable="true" aria-label="Message Body" aria-multiline="true">
<div id="reply">Jerry,</div><div class="gmail_quote"><div class="gmail_attr">On Monday, Someone &lt;someone@example.test&gt; wrote:</div>
<blockquote class="gmail_quote">${blankLines}</blockquote></div></div><button id="send" type="button">Send</button></body></html>`;
      return withReplyPage(other, html, async (page) => {
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
        await page.evaluate(caretAtEnd, "#reply");
        await typeText(page, " Thanks for the note.");
        // The browser's own work on an editable region this big (laying it out, spell-checking it) lands with
        // the keystroke itself, so the watch starts once that's done and sees only Clotr's check.
        const observed = await page.evaluate(() => {
          if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return false;
          window.__tasks = [];
          new PerformanceObserver((list) => window.__tasks.push(...list.getEntries().map((e) => e.duration))).observe({
            type: "longtask",
          });
          return true;
        });
        expect(observed, "this browser can't report long tasks");
        const scanned = await waitFor(
          () => evalInClotr(page, "globalThis.__emailScanTexts.some((t) => t.includes('Thanks'))"),
          30000,
        );
        expect(scanned, "the reply was never checked");
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        const worst = Math.round(await page.evaluate(() => Math.max(0, ...window.__tasks)));
        const stall = 300 * patience();
        expect(
          worst < stall,
          `the tab stalled for ${worst} ms while checking the reply (${Math.round(stall)} allowed)`,
        );
        return `${worst} ms longest stall with 25,000 quoted blank lines`;
      });
    }),
  );

  const forwardedKey = `<div>---------- Forwarded message ---------</div><div>API key: ${KEY}</div>`;
  const warningWithBoth = (page) =>
    waitFor(async () => {
      const warning = (await readNotice(page)) || (await readDialog(page));
      return warning && /AWS Access Key/.test(warning.text) && /Phone Number/.test(warning.text) ? warning : null;
    }, 3000);
  const coverBoth = async (page) => {
    const warning = await warningWithBoth(page);
    expect(warning, "no warning with the forwarded key and reply phone number");
    const cover = warning.buttons.find((button) => button.text === "Cover it" || button.text === "Hide it");
    expect(cover, `no cover button: ${warning.text}`);
    await clickNode(page, cover.nodeId);
  };

  await check(
    "EQ4",
    "Email reply: Cover it replaces a forwarded key and a reply phone without changing formatting",
    () =>
      withGmailCopy((other) =>
        withReplyPage(other, craftedReply(forwardedKey), async (page) => {
          await page.evaluate(caretAtEnd, "#reply");
          await typeText(page, " Call me at 555-555-0123.");
          await coverBoth(page);
          const after = await waitFor(async () => {
            const text = await editorText(page);
            return text.includes("[REDACTED AWS ACCESS KEY]") && text.includes("[REDACTED PHONE NUMBER]") ? text : null;
          }, 3000);
          expect(after, `not all values were covered: ${await editorText(page)}`);
          expect(await page.$eval("#reply strong", (node) => node.textContent), "Jerry,");
          expect(!(await readDialog(page)) && !(await readNotice(page)), "the successful cover still showed a warning");
          return "covered both values and kept the reply's formatting";
        }),
      ),
  );

  await check("EQ5", "Email reply: a read-only forwarded quote does not stop Cover it from covering the reply", () =>
    withGmailCopy((other) =>
      withReplyPage(other, craftedReply(forwardedKey, true), async (page) => {
        await page.evaluate(caretAtEnd, "#reply");
        await typeText(page, " Call me at 555-555-0123.");
        await coverBoth(page);
        const failure = await waitFor(async () => {
          const warning = (await readDialog(page)) || (await readNotice(page));
          return warning && /couldn't hide it here/.test(warning.text) ? warning : null;
        }, 3000);
        const text = await editorText(page);
        expect(failure, "Cover it did not identify the uneditable value");
        expect(/AWS Access Key/.test(failure.text) && !/Phone Number/.test(failure.text), failure.text);
        expect(text.includes(KEY) && text.includes("[REDACTED PHONE NUMBER]"), text);
        expect(await page.$eval("#reply strong", (node) => node.textContent), "Jerry,");
        return "covered the reply phone and named only the key left in the read-only quote";
      }),
    ),
  );

  await check(
    "EQ6",
    "Bandage in an email reply covers a number in the reply and one in an edited quote before the held send resumes",
    () =>
      withGmailCopy(async (other) => {
        await store.set(other, { bandage: { "mail.google.com": true } });
        await withReplyPage(other, craftedReply('<div id="edited">Please call 555-555-0100.</div>'), async (page) => {
          await page.evaluate(() => {
            window.__sent = [];
            document.querySelector("#send").addEventListener("click", () => {
              window.__sent.push(document.querySelector("#body").innerText);
            });
          });
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
          await editReplyAndQuote(page, "555-555-0123", "555-555-0100", "555-555-0199");
          const editedQuote = await page.$eval("#edited", (node) => node.textContent);
          expect(editedQuote.includes("555-555-0199"), `the quoted part was not edited: ${editedQuote}`);
          await clickSend(page);
          expect((await page.evaluate(() => window.__sent.length)) === 0, "the held send reached the mail app");
          const scanned = await waitFor(
            () =>
              evalInClotr(
                page,
                `globalThis.__emailScanTexts.find((text) => text.includes("555-555-0123") && text.includes("555-555-0199")) || null`,
              ),
            3000,
          );
          expect(scanned, "the reply number and edited quote number were not detected together");

          const after = await waitFor(async () => {
            const reply = await page.$eval("#reply", (node) => node.textContent);
            const quote = await page.$eval("#edited", (node) => node.textContent);
            return reply.includes("[Phone 1]") && quote.includes("[Phone 2]") ? { reply, quote } : null;
          }, 3000);
          expect(
            after,
            `not every number was covered; reply: ${await page.$eval("#reply", (node) => node.textContent)}, quote: ${await page.$eval("#edited", (node) => node.textContent)}`,
          );
          const held = await waitFor(async () => {
            const notice = await readNotice(page);
            return notice && /Your details have cover names now/.test(notice.text) ? notice : null;
          }, 3000);
          expect(held, "the held send was not reported as covered");
          await clickNode(page, held.buttons[0].nodeId);
          await clickSend(page);
          const sent = await waitFor(() => page.evaluate(() => window.__sent[0] || null), 2000);
          expect(sent && sent.includes("[Phone 1]") && sent.includes("[Phone 2]"), `sent: ${sent}`);
          expect(!sent.includes("0123") && !sent.includes("0199"), `a number reached the mail app: ${sent}`);
          return "covered both values, held the first send, and sent only the cover names";
        });
      }, true),
  );

  await check("EQ7", "Bandage warns about an edited quoted number when the editor cannot replace it", () =>
    withGmailCopy(async (other) => {
      await store.set(other, { bandage: { "mail.google.com": true } });
      await withReplyPage(other, craftedReply('<div id="edited">Please call 555-555-0100.</div>'), async (page) => {
        await editReplyAndQuote(page, "555-555-0123", "555-555-0100", "555-555-0199");
        await evalInClotr(
          page,
          `(() => {
                  const original = document.execCommand.bind(document);
                  document.execCommand = (command, showUI, value) => {
                    const node = window.getSelection()?.anchorNode;
                    if (command === "insertText" && node?.parentElement?.closest("#edited")) return false;
                    return original(command, showUI, value);
                  };
                  return true;
                })()`,
        );
        await clickSend(page);
        const warning = await waitFor(async () => {
          const notice = await readNotice(page);
          return notice && /Phone Number/.test(notice.text) ? notice : null;
        }, 4000);
        const text = await editorText(page);
        expect(warning, "the uneditable quoted number did not fall back to its normal warning");
        expect(text.includes("[Phone 1]") && text.includes("555-555-0199"), text);
        expect(!/Your details have cover names now/.test(warning.text), warning.text);
        return "kept the uneditable number and warned about it instead of claiming it was covered";
      });
    }, true),
  );
};
