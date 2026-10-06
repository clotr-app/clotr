// E2E checks: EX. Extension check asks once for the optional `management` permission, reads the browser's own
// extension list, and says which extensions can read your AI chats and which are worth a look, then gives the
// permission back. The browser's own permission prompt can't be clicked by a script, so EX1-4 run on a copy of the
// extension whose manifest grants `management` up front — a granted permission either way, the same trick EV's
// withGrantedCopy uses for host permissions. Two fake extensions load alongside that copy of Clotr: one with a
// content script on every site, one with host access to chatgpt.com only. EX5 covers the other branch, saying no,
// on the shared browser with a stubbed `chrome.permissions.request`.
"use strict";

module.exports = async function (env) {
  const { EXT, check, ctx, expect, fs, launch, openExtPage, os, path, settle, shotAt, sleep, waitFor } = env;

  // A copy of Clotr whose manifest grants `management` up front, plus two minimal fake extensions: one with a
  // content script matching every site, one with host access to chatgpt.com only and no content script.
  async function withManagementCopy(fn) {
    const dirs = [];
    const tmp = (name) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
      dirs.push(d);
      return d;
    };

    const copy = tmp("clotr-ext-mgmt-");
    fs.cpSync(EXT, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.permissions = [...m.permissions, "management"];
    m.optional_permissions = (m.optional_permissions || []).filter((p) => p !== "management");
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));

    const allSites = tmp("clotr-ext-allsites-");
    fs.writeFileSync(
      path.join(allSites, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: 3,
          name: "Clotr e2e test: all sites",
          version: "1.0",
          content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(allSites, "cs.js"), "// Clotr e2e test fixture: no-op content script\n");

    const chatgptHost = tmp("clotr-ext-chatgpt-");
    fs.writeFileSync(
      path.join(chatgptHost, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: 3,
          name: "Clotr e2e test: chatgpt host",
          version: "1.0",
          host_permissions: ["https://chatgpt.com/*"],
        },
        null,
        2,
      ),
    );

    const other = await launch([copy, allSites, chatgptHost]);
    try {
      return await fn(other, {
        allSitesName: "Clotr e2e test: all sites",
        chatgptName: "Clotr e2e test: chatgpt host",
      });
    } finally {
      await other.browser.close();
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  const readResults = (page) =>
    page.evaluate(() => {
      const row = (el) => ({
        id: el.dataset.id,
        name: el.querySelector(".ec-name")?.textContent,
        reach: el.querySelector(".ec-reach")?.textContent,
        reason: el.querySelector(".ec-reason")?.textContent,
        reportHref: el.querySelector("a")?.href,
        note: [...el.querySelectorAll(".muted")].map((n) => n.textContent).join(" | "),
        hasRemove: Boolean(el.querySelector(".ec-remove")),
      });
      return {
        heading: document.getElementById("results-heading").textContent,
        givenBackShown: !document.getElementById("given-back").hidden,
        worth: [...document.querySelectorAll("#worth-a-look-cards .ec-card-item")].map(row),
        rows: [...document.querySelectorAll("#can-read-rows .ec-row")].map(row),
        aboutClotr: document.getElementById("about-clotr")?.textContent,
        canReadHeading: document.getElementById("can-read-heading")?.textContent,
        cantSummary: document.getElementById("cant-summary")?.textContent,
      };
    });

  // One read, shared by EX1-EX4. It plants the report on the all-sites fake, then each check inspects a different
  // part of the results.
  let shared;
  await check("EX0", "Extension check: one granted read, shared by EX1-EX4", () =>
    withManagementCopy(async (other, names) => {
      const all = await other.worker.evaluate(() => chrome.management.getAll());
      const allSitesId = all.find((e) => e.name === names.allSitesName)?.id;
      const chatgptId = all.find((e) => e.name === names.chatgptName)?.id;
      const selfId = await other.worker.evaluate(() => chrome.runtime.id);
      expect(allSitesId && chatgptId && selfId, `fixture ids: ${JSON.stringify({ allSitesId, chatgptId, selfId })}`);

      const page = await openExtPage(other, "extcheck.html");
      // Spies on chrome.tabs.create, which EX4 checks, and on the management calls the rule test already forbids.
      // It's belt and braces: the same guarantee, checked live here instead of only statically.
      await page.evaluate(() => {
        window.__tabsCreated = [];
        chrome.tabs.create = (opts) => {
          window.__tabsCreated.push(opts);
          return Promise.resolve({});
        };
        window.__mgmtCalls = [];
        for (const fn of ["setEnabled", "uninstall", "uninstallSelf"]) {
          const real = chrome.management[fn];
          chrome.management[fn] = (...args) => {
            window.__mgmtCalls.push(fn);
            return real ? real(...args) : Promise.resolve();
          };
        }
      });
      // The planted report names the all-sites fake by its real id, as if a source had named it.
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
      await shotAt(page, "extcheck-start-light.png", { width: 380, theme: "light" });
      await shotAt(page, "extcheck-start-dark.png", { width: 1280, height: 900, theme: "dark" });
      await page.click("#start-check");
      await waitFor(() => page.evaluate(() => !document.getElementById("results").hidden), 5000);
      const results = await readResults(page);
      await shotAt(page, "extcheck-results-light.png", { width: 380, height: 900, theme: "light" });
      await shotAt(page, "extcheck-results-dark.png", { width: 1280, height: 900, theme: "dark" });

      // The button that opens the browser's own page, clicked last so it doesn't disturb the results read above.
      const card = await page.$(`.ec-card-item[data-id="${allSitesId}"] button.ec-remove`);
      expect(card, "no 'Show me where to remove it' button on the reported card");
      await card.click();
      await sleep(100);
      const tabsCreated = await page.evaluate(() => window.__tabsCreated);
      const mgmtCalls = await page.evaluate(() => window.__mgmtCalls);

      await page.close();
      shared = { allSitesId, chatgptId, selfId, results, tabsCreated, mgmtCalls };
    }),
  );

  await check("EX1", "Extension check: each fake extension's reach matches what it actually asked for", async () => {
    const { allSitesId, chatgptId, results } = shared;
    const allSitesRow = [...results.worth, ...results.rows].find((r) => r.id === allSitesId);
    expect(allSitesRow, `the all-sites fake isn't listed: ${JSON.stringify(results)}`);
    expect(
      allSitesRow.reach === "Can read every site, AI chats included",
      `all-sites fake's reach: ${allSitesRow.reach}`,
    );
    const chatgptRow = [...results.worth, ...results.rows].find((r) => r.id === chatgptId);
    expect(chatgptRow, `the chatgpt-host fake isn't listed: ${JSON.stringify(results)}`);
    expect(chatgptRow.reach === "Can read ChatGPT", `chatgpt-host fake's reach: ${chatgptRow.reach}`);
  });

  await check(
    "EX2",
    "Extension check: Clotr never counts itself, as worth a look or in the can-read list",
    async () => {
      const { selfId, results } = shared;
      expect(!results.worth.some((r) => r.id === selfId), "Clotr itself showed up as worth a look");
      expect(!results.rows.some((r) => r.id === selfId), "Clotr itself showed up in the can-read list");
      expect(
        /Clotr itself reads AI chat pages/.test(results.aboutClotr || ""),
        `Clotr's own quiet line: ${results.aboutClotr}`,
      );
    },
  );

  await check("EX6", "Extension check: the headline count leaves Clotr out of both numbers", async () => {
    const { results } = shared;
    const m = /^(\d+) of your (\d+) extensions can read your AI chats$/.exec(results.heading);
    expect(m, `heading format: ${results.heading}`);
    const [canReadAi, total] = m.slice(1).map(Number);
    // Only the two fake extensions are counted. Clotr, the third extension present, is left out of both numbers.
    expect(total === 2, `Clotr counted itself in the total: ${results.heading}`);
    expect(canReadAi === 2, `Clotr counted itself as able to read: ${results.heading}`);
    expect(canReadAi === results.worth.length + results.rows.length, `count vs. what's listed: ${results.heading}`);
  });

  await check("EX7", "Extension check: an extension worth a look isn't listed again under can-read", async () => {
    const { allSitesId, results } = shared;
    expect(
      results.worth.some((r) => r.id === allSitesId),
      "the reported fake isn't under worth a look",
    );
    expect(
      !results.rows.some((r) => r.id === allSitesId),
      "the reported fake is listed a second time under can read your AI chats",
    );
  });

  // "Can't read" matches "Can read your AI chats ($1)"'s own shape, with the count last.
  await check("EX8", "Extension check: Can't read your AI chats puts the count last, like Can read does", async () => {
    const { results } = shared;
    expect(
      /^Can read your AI chats \(\d+\)$/.test(results.canReadHeading || ""),
      `can-read: ${results.canReadHeading}`,
    );
    expect(/^Can't read your AI chats \(\d+\)$/.test(results.cantSummary || ""), `cant: ${results.cantSummary}`);
  });

  await check(
    "EX3",
    "Extension check: the reported list's planted id turns up as worth a look, the other fake doesn't",
    async () => {
      const { allSitesId, chatgptId, results } = shared;
      const reported = results.worth.find((r) => r.id === allSitesId);
      expect(reported, `the planted report didn't show: ${JSON.stringify(results.worth)}`);
      expect(
        reported.reason === "Reported by Test Lab on 2026-01-01 for collecting AI chats.",
        `reported line: ${reported.reason}`,
      );
      expect(reported.reportHref === "https://example.invalid/report", `report link: ${reported.reportHref}`);
      expect(
        !results.worth.some((r) => r.id === chatgptId),
        "the un-reported, un-sideloaded fake was called worth a look",
      );
    },
  );

  await check(
    "EX4",
    "Extension check: 'Show me where to remove it' opens the browser's own extensions page, and nothing else",
    async () => {
      const { allSitesId, tabsCreated, mgmtCalls } = shared;
      expect(tabsCreated.length === 1, `tabs.create calls: ${JSON.stringify(tabsCreated)}`);
      expect(tabsCreated[0].url === `chrome://extensions/?id=${allSitesId}`, `opened: ${tabsCreated[0].url}`);
      expect(mgmtCalls.length === 0, `chrome.management calls that change something: ${mgmtCalls.join(", ")}`);
    },
  );

  // The other branch is the browser saying no. No fake extensions are needed here, since `chrome.permissions.request`
  // is stubbed on the shared browser, the same way EV's checks stand in for a prompt that can't be clicked.
  await check(
    "EX5",
    "Extension check: saying no explains itself, changes nothing, and Ask me again asks again",
    async () => {
      const page = await openExtPage(ctx, "extcheck.html");
      try {
        await page.evaluate(() => {
          window.__asks = [];
          let inClick = false;
          addEventListener("click", () => (inClick = true), true);
          addEventListener("click", () => (inClick = false));
          chrome.permissions.request = (p) => {
            window.__asks.push({ permissions: p.permissions, inClick });
            return Promise.resolve(false);
          };
        });
        const sentence = await page.$eval("#permission-sentence", (n) => n.textContent);
        expect(sentence === "“Manage your apps, extensions, and themes”", `quoted sentence: ${sentence}`);
        await page.click("#start-check");
        await settle(300);
        const first = await page.evaluate(() => ({
          saidNoShown: !document.getElementById("said-no").hidden,
          startShown: !document.getElementById("start").hidden,
          focused: document.activeElement?.id,
          steps: [...document.querySelectorAll("#by-hand-steps li")].map((li) => li.textContent),
        }));
        expect(first.saidNoShown && !first.startShown, `after a No: ${JSON.stringify(first)}`);
        expect(first.focused === "said-no-heading", `focus after a No: ${first.focused}`);
        expect(
          first.steps.some((s) => /chrome:\/\/extensions/.test(s)),
          `by-hand steps: ${JSON.stringify(first.steps)}`,
        );
        await shotAt(page, "extcheck-said-no-light.png", { width: 380, theme: "light" });
        await shotAt(page, "extcheck-said-no-dark.png", { width: 1280, height: 900, theme: "dark" });
        await page.click("#ask-again");
        await settle(300);
        const asks = await page.evaluate(() => window.__asks);
        expect(asks.length === 2, `asks: ${JSON.stringify(asks)}`);
        expect(
          asks.every((a) => a.inClick && JSON.stringify(a.permissions) === JSON.stringify(["management"])),
          `asks: ${JSON.stringify(asks)}`,
        );
        const stillSaidNo = !(await page.evaluate(() => document.getElementById("said-no").hidden));
        expect(stillSaidNo, "Ask me again didn't show the said-no page again after a second No");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "A11Y3",
    "Extension check: no serious accessibility problems in the results and said-no pages",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
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
      await withManagementCopy(async (other) => {
        const page = await openExtPage(other, "extcheck.html");
        try {
          await page.click("#start-check");
          await waitFor(() => page.evaluate(() => !document.getElementById("results").hidden), 5000);
          await audit(page, "extcheck.html results");
        } finally {
          await page.close();
        }
      });
      const saidNo = await openExtPage(ctx, "extcheck.html");
      try {
        await saidNo.evaluate(() => {
          chrome.permissions.request = () => Promise.resolve(false);
        });
        await saidNo.click("#start-check");
        await settle(300);
        await audit(saidNo, "extcheck.html said-no");
      } finally {
        await saidNo.close();
      }
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );
};
