// E2E checks: RB. "Report a problem" on every Clotr page. Run in order by
// ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { OUT, check, ctx, expect, openExtPage, openPopup, shot, sleep, store, typeText, withSite } = env;

  const PAGES = [
    "vault.html",
    "dashboard.html",
    "stored.html",
    "helper.html",
    "share.html",
    "policy.html",
    "check.html",
  ];

  // Opens the popup over a tab showing `url`, answering the tab lookup by hand.
  const openPopupOn = async (url) => {
    const popup = await ctx.browser.newPage();
    popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
    await popup.evaluateOnNewDocument((u) => {
      chrome.tabs.query = async () => [{ id: 999, url: u }];
    }, url);
    await popup.setViewport({ width: 380, height: 700 });
    await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
    await popup.waitForSelector("#hero-value");
    await sleep(400);
    return popup;
  };

  await check(
    "RB1",
    '"Report a problem" shows up on every Clotr page (the popup too), with its three choices and no email choice (REPORT_EMAIL unset)',
    async () => {
      const popup = await openPopup(ctx);
      try {
        const got = await popup.evaluate(() => {
          const details = document.querySelector("#report-root .report");
          return {
            hasDetails: Boolean(details),
            choices: [...(details?.querySelectorAll(".report-menu .report-choice") || [])].map((b) => b.textContent),
          };
        });
        expect(got.hasDetails, "popup: no report button");
        expect(got.choices.length === 3, `popup: choices ${JSON.stringify(got.choices)}`);
      } finally {
        await popup.close();
      }

      for (const file of PAGES) {
        const page = await openExtPage(ctx, file);
        try {
          await sleep(200);
          const got = await page.evaluate(() => {
            const details = document.querySelector("#report-root .report");
            const summary = details?.querySelector("summary")?.textContent || "";
            const choices = [...(details?.querySelectorAll(".report-menu .report-choice") || [])].map(
              (b) => b.textContent,
            );
            return { hasDetails: Boolean(details), summary, choices };
          });
          expect(got.hasDetails, `${file}: no report button`);
          expect(/report a problem/i.test(got.summary), `${file}: summary "${got.summary}"`);
          expect(
            got.choices.length === 3 &&
              /wrong/i.test(got.choices[0]) &&
              /missed/i.test(got.choices[1]) &&
              /false alarm/i.test(got.choices[2]),
            `${file}: choices ${JSON.stringify(got.choices)}`,
          );
        } finally {
          await page.close();
        }
      }
    },
  );

  await check(
    "RB2",
    "Each choice opens the right GitHub form with only the version and browser prefilled: never a typed value, a stored value or a fingerprint",
    async () => {
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "555-555-0147"),
      );
      await store.set(ctx, {
        events: [
          {
            t: Date.now(),
            site: "chatgpt.com",
            type: "phone_number",
            name: "Phone Number",
            severity: "medium",
            action: "allowed",
            fp,
          },
        ],
        vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: Date.now() }],
      });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        const urls = await page.evaluate(() => {
          window.__opened = [];
          window.open = (u) => {
            window.__opened.push(u);
            return null;
          };
          for (const b of document.querySelectorAll("#report-root .report-menu .report-choice")) b.click();
          return window.__opened;
        });
        expect(urls.length === 3, `expected 3 opened URLs, got ${urls.length}`);
        expect(urls[0]?.includes("template=bug.yml"), `bug url: ${urls[0]}`);
        expect(urls[1]?.includes("template=missed.yml"), `missed url: ${urls[1]}`);
        expect(urls[2]?.includes("template=false-alarm.yml"), `false-alarm url: ${urls[2]}`);
        for (const url of urls) {
          const decoded = decodeURIComponent(url);
          expect(/[?&]version=/.test(url), `no version: ${url}`);
          expect(!/chatgpt|555|0147/i.test(decoded), `a typed/stored value or the site leaked: ${decoded}`);
          expect(!decoded.includes(fp), `the fingerprint leaked: ${decoded}`);
          expect(!/[?&]site=/.test(url), `a site with no opt-in checkbox still carried one: ${url}`);
        }
      } finally {
        await page.close();
        await store.set(ctx, { events: [], vault: [] });
      }
    },
  );

  await check(
    "RB3",
    'Popup: "Include this site" only offered on a protected AI site, off by default, adds the host only when ticked',
    async () => {
      // Away from an AI tool: no checkbox to include a site at all.
      let popup = await openPopupOn("https://example.com/");
      try {
        const hidden = await popup.evaluate(() => document.querySelector("#report-root .report-site")?.hidden);
        expect(hidden !== false, `checkbox shown away from an AI tool: hidden=${hidden}`);
      } finally {
        await popup.close();
      }

      // On a protected AI site: the checkbox shows the host, unticked by default.
      popup = await openPopupOn("https://chatgpt.com/");
      try {
        const shown = await popup.evaluate(() => ({
          hidden: document.querySelector("#report-root .report-site")?.hidden,
          checked: document.querySelector("#report-root .report-site input")?.checked,
          text: document.querySelector("#report-root .report-site span")?.textContent,
        }));
        expect(shown.hidden === false, `checkbox not shown on a protected site: ${JSON.stringify(shown)}`);
        expect(shown.checked === false, `checkbox ticked by default: ${JSON.stringify(shown)}`);
        expect(/chatgpt\.com/.test(shown.text || ""), `checkbox text: ${shown.text}`);

        await popup.evaluate(() => {
          window.__opened = [];
          window.open = (u) => {
            window.__opened.push(u);
            return null;
          };
        });
        await popup.click("#report-root summary");
        await popup.click("#report-root .report-menu .report-choice");
        const withoutSite = await popup.evaluate(() => window.__opened.at(-1));
        expect(!/[?&]site=/.test(withoutSite || ""), `site included although unchecked: ${withoutSite}`);

        await popup.click("#report-root summary");
        await popup.click("#report-root .report-site input");
        await popup.click("#report-root .report-menu .report-choice");
        const withSite = await popup.evaluate(() => window.__opened.at(-1));
        expect(/[?&]site=chatgpt\.com/.test(withSite || ""), `site missing once ticked: ${withSite}`);
      } finally {
        await popup.close();
      }
    },
  );

  // The warning and the address are both required, on the welcome page and in the printed guide. The warning
  // comes before any choice, and the address is plain text so it still works on paper.
  const ADDRESS = "github.com/clotr-app/clotr/issues";
  await check(
    "RB4",
    "Report a problem warns first that reports are public (never paste the real detail), and shows its address in words, on screen and in the printed guide",
    async () => {
      for (const file of PAGES) {
        const page = await openExtPage(ctx, file);
        try {
          await sleep(200);
          const got = await page.evaluate(() => {
            const menu = document.querySelector("#report-root .report-menu");
            const warn = menu?.querySelector(".report-warn");
            const first = menu?.querySelector(".report-warn, button");
            return {
              warn: warn?.textContent || "",
              warnFirst: Boolean(warn) && first === warn,
              address: menu?.querySelector(".report-address")?.textContent || "",
            };
          });
          expect(/public/i.test(got.warn) && /never/i.test(got.warn), `${file}: warning "${got.warn}"`);
          expect(got.warnFirst, `${file}: the warning isn't before the choices`);
          expect(got.address.includes(ADDRESS), `${file}: address "${got.address}"`);
          if (file === "vault.html") {
            await page.click("#report-root summary");
            await shot(page, "report-menu.png");
          }
        } finally {
          await page.close();
        }
      }
      const share = await openExtPage(ctx, "share.html");
      try {
        const guide = await share.evaluate(() => document.querySelector(".guide")?.textContent || "");
        expect(guide.includes(ADDRESS), "the printed guide has no report address");
        await share.setViewport({ width: 800, height: 1200 });
        await share.emulateMediaType("print");
        await (await share.$(".guide")).screenshot({ path: `${OUT}/share-guide-print.png` });
        // The Share page promises one page, so the new line must not push the guide onto a second sheet. Chrome
        // refuses a page range past the last page, so asking for page 2 only fails when there's just the one.
        expect((await share.pdf({ format: "letter" })).length > 0, "the guide didn't print");
        const second = await share.pdf({ format: "letter", pageRanges: "2" }).then(
          () => true,
          () => false,
        );
        expect(!second, "the printed guide runs onto a second page");
      } finally {
        await share.close();
      }
    },
  );

  // Opens the "Copy my summary" panel, which shows kinds and counts only, waits for the counts to appear, copies
  // them with the clipboard answered by hand, and returns both what was in the box and what was copied.
  // The browser's name is left out when Clotr can't tell which one it is (headless Chrome on Linux, for one).
  const SUMMARY_FIRST = /^Clotr \S+( on \w+)?, last 30 days\. Counts only: no details, sites or times\./;
  const openSummary = async (page) => {
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = (t) => {
        window.__copied = t;
        return Promise.resolve();
      };
      window.__opened = [];
      window.open = (u) => {
        window.__opened.push(u);
        return null;
      };
    });
    await page.click("#report-root summary");
    await page.click("#report-root .report-summary > summary");
    await page.waitForFunction(() => document.querySelector("#report-root .report-sum-text")?.value.length > 0, {
      timeout: 3000,
    });
  };
  const copySummary = async (page) => {
    await page.click("#report-root .report-sum-copy");
    await page.waitForFunction(() => window.__copied !== null, { timeout: 2000 });
    return page.evaluate(() => ({
      box: document.querySelector("#report-root .report-sum-text").value,
      copied: window.__copied,
      status: document.querySelector("#report-root .report-sum-msg")?.textContent || "",
    }));
  };

  await check(
    "RB5",
    "Copy my summary shows kinds and counts only: details planted in the history, the vault, the settings and an open chat never reach the copied text, nothing is stored, and the form's address never carries it",
    async () => {
      const PHONE = "555-555-0147";
      const fp = await ctx.worker.evaluate(
        async (v) => globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", v),
        PHONE,
      );
      const saved = await store.get(ctx, ["responses", "bandage"]);
      const now = Date.now();
      const ev = (type, action, extra = {}) => ({
        t: now - 3600000,
        site: "chatgpt.com",
        type,
        name: `Jane Doe ${PHONE}`,
        severity: "medium",
        action,
        fp,
        ...extra,
      });
      await store.set(ctx, {
        events: [
          ev("phone_number", "redacted", { via: "bandage" }),
          ev("phone_number", "allowed", { site: "secret-intranet.example" }),
          ev("email", "suppressed", { name: "jane.doe@example.com" }),
          ev("team_acme_matter", "redacted", { name: "Acme Matter Number" }),
          ev(PHONE, "allowed"), // a crafted event with the detail as its kind
          ev("credit_card", "allowed", { t: now - 40 * 86400000 }), // older than 30 days
        ],
        mentions: [ev("my_name", "mentioned")],
        vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: now }],
        responses: { phone_number: "block" },
        bandage: { "secret-intranet.example": true, "claude.ai": true, "chatgpt.com": false },
      });
      const TYPED = "Jane Doe lives at 1428 Elm Street, call 614-555-0199";
      try {
        await withSite(ctx, "chatgpt", async (chat) => {
          await typeText(chat, TYPED); // left unsent in the open chat while the summary is made
          await sleep(600);
          const popup = await openPopupOn("https://chatgpt.com/c/0123456789abcdef");
          try {
            await openSummary(popup);
            // Ticking "Include this site" lets the site appear in the form's address, but it must never reach
            // the summary.
            await popup.click("#report-root .report-site input");
            const storedBefore = JSON.stringify(await store.get(ctx, null));
            const got = await copySummary(popup);
            const lines = got.copied.split("\n");
            expect(got.copied === got.box, "what was copied isn't what the box shows");
            expect(SUMMARY_FIRST.test(lines[0]), `first line: ${lines[0]}`);
            for (const line of [
              "Phone Number (phone_number): 2 found, 1 hidden (1 by Bandage), 1 sent",
              "Email Address (email): 1 found, 1 just counted",
              "Kinds your organization added: 1 found, 1 hidden",
              "Other kinds: 1 found, 1 sent",
              "AI replies that brought up your details: 1",
              "Kinds set to Ask before sending: 1",
              "AI sites with Bandage on: 2",
            ])
              expect(lines.includes(line), `missing "${line}" in:\n${got.copied}`);
            expect(lines.length === 8, `expected 8 lines, got:\n${got.copied}`);
            const lower = got.copied.toLowerCase();
            for (const planted of [
              "555",
              "0147",
              "0199",
              "jane",
              "doe",
              "1428",
              "elm",
              "acme",
              "matter",
              "chatgpt",
              "secret-intranet",
              "claude.ai",
              "credit",
              fp,
            ])
              expect(!lower.includes(planted), `"${planted}" reached the summary:\n${got.copied}`);
            expect(!/[0-9a-f]{16}/i.test(got.copied), "a fingerprint or code reached the summary");
            expect(!/\b\d{1,2}:\d{2}\b/.test(got.copied), "a clock time reached the summary");
            expect(/copied/i.test(got.status), `status after copying: "${got.status}"`);
            expect(
              JSON.stringify(await store.get(ctx, null)) === storedBefore,
              "making or copying the summary changed storage",
            );

            // Checks a form next: its address should carry only the template, version, browser and the ticked
            // site.
            await popup.click("#report-root .report-choice");
            const url = await popup.evaluate(() => window.__opened.at(-1));
            const params = [...new URL(url).searchParams.keys()].sort().join(",");
            expect(params === "browser,site,template,version", `form address parameters: ${params}`);
            const decoded = decodeURIComponent(url);
            for (const bit of ["phone_number", "found", "Bandage", "Counts only", "organization"])
              expect(!decoded.includes(bit), `the form's address carries the summary ("${bit}"): ${decoded}`);

            // The person should see the whole summary before copying it, so this takes screenshots at the
            // popup's width, at full height and at its real 600px height, light and dark, and checks for no
            // serious accessibility problem in either.
            await popup.click("#report-root summary"); // the form closed the menu, but the summary stays as it was
            await popup.click("#report-root .report-sum-copy");
            await sleep(200);
            const box = await popup.$eval("#report-root .report-sum-text", (b) => ({
              scroll: b.scrollHeight,
              client: b.clientHeight,
            }));
            expect(box.scroll <= box.client + 1, `the box hides lines below its fold: ${JSON.stringify(box)}`);
            await shot(popup, "report-summary-dark.png", "dark");
            await shot(popup, "report-summary.png");
            for (const theme of ["dark", "light"]) {
              await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
              await popup.setViewport({ width: 380, height: 600 });
              await popup.evaluate(() =>
                document.querySelector("#report-root .report-summary").scrollIntoView({ block: "center" }),
              );
              await sleep(400);
              const dark = await popup.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
              expect(dark === (theme === "dark"), `${theme}: the page didn't take the theme`);
              await popup.screenshot({ path: `${OUT}/report-summary-600-${theme}.png` });
              if (!(await popup.evaluate(() => typeof axe === "object")))
                await popup.evaluate(env.fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"));
              const problems = await popup.evaluate(async () =>
                (await axe.run(document.querySelector("#report-root"), { resultTypes: ["violations"] })).violations
                  .filter((v) => v.impact === "serious" || v.impact === "critical")
                  .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
              );
              expect(!problems.length, `${theme}: ${problems.join("; ")}`);
            }
          } finally {
            await popup.close();
          }
        });
      } finally {
        await store.set(ctx, {
          events: [],
          mentions: [],
          vault: [],
          responses: saved.responses || {},
          bandage: saved.bandage || {},
        });
      }
    },
  );

  await check(
    "RB6",
    "Copy my summary copies the box as the person left it: a deleted line isn't copied (on a full Clotr page too)",
    async () => {
      const now = Date.now();
      const ev = (type, action) => ({
        t: now - 60000,
        site: "chatgpt.com",
        type,
        name: type,
        severity: "medium",
        action,
        fp: "1000000000000001",
      });
      await store.set(ctx, {
        events: [ev("phone_number", "allowed"), ev("email", "suppressed"), ev("aws_access_key", "redacted")],
      });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(200);
        await openSummary(page);
        // Select the email line in the box and delete it from the keyboard, the way a person would.
        await page.evaluate(() => {
          const box = document.querySelector("#report-root .report-sum-text");
          const start = box.value.indexOf("Email Address");
          const end = box.value.indexOf("\n", start) + 1 || box.value.length;
          box.focus();
          box.setSelectionRange(start, end);
        });
        await page.keyboard.press("Backspace");
        const got = await copySummary(page);
        expect(got.copied === got.box, `copied isn't the edited box:\n${got.copied}\n---\n${got.box}`);
        expect(!got.copied.includes("Email Address"), `the deleted line was copied:\n${got.copied}`);
        // The box should fit what's left, with no empty rows that look like hidden lines.
        const fits = await page.$eval("#report-root .report-sum-text", (b) => {
          const lh = parseFloat(getComputedStyle(b).lineHeight);
          return { height: b.clientHeight, most: (b.value.split("\n").length + 2) * lh + 16 };
        });
        expect(fits.height <= fits.most, `the box didn't shrink to its lines: ${JSON.stringify(fits)}`);
        expect(
          got.copied.includes("Phone Number (phone_number): 1 found, 1 sent") &&
            got.copied.includes("AWS Access Key (aws_access_key): 1 found, 1 hidden"),
          `the other lines went missing:\n${got.copied}`,
        );
        await page.setViewport({ width: 1040, height: 900 });
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(200);
          await (await page.$("#report-root")).screenshot({ path: `${OUT}/report-summary-page-${theme}.png` });
        }
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );
};
