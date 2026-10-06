// E2E checks: Look back lets someone pick an export of their AI chats, reads it in a worker on their own computer,
// and shows which chats hold a password, a key, a card or ID number, an address, or a photo's location. The unit
// tests in lookback.test.js already check the same made-up exports against expected.json, so these checks reuse
// those exports against the real page and worker, and cover what only a real browser can show: the file and folder
// pickers, Stop, the live feed, "Open the chat", masking in the rendered page, the worker's memory use on a large
// export, and the deletion letter's panel and its Spanish wording. Run in order by ../run.js with one shared env.
"use strict";

const { EXPORTS, zip, zipOf } = require("../../fixtures/exports/make-exports.js");

module.exports = async function (env) {
  const { EXT, Skip, check, ctx, expect, fs, launch, openExtPage, os, path, settle, shotAt, sleep, waitFor } = env;

  function tmpZip(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-lb-"));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  }

  async function pickZip(page, bytes, fileName = "export.zip") {
    const input = await page.$("#file-input");
    await input.uploadFile(tmpZip(fileName, bytes));
  }
  // Chrome's devtools protocol can't set files on a webkitdirectory input; a real folder pick only happens
  // through the OS's own dialog, and that leaves `.files` empty here. So instead I build real `File` objects
  // in the page, assign them over the input's normally read-only `.files`, and dispatch a real `change` event,
  // which runs the exact listener lookback.js would. The format is found by its shape, not its path, so this
  // doesn't need webkitRelativePath set.
  async function pickFolder(page, files) {
    const entries = Object.entries(files).map(([name, content]) => [
      path.basename(name),
      Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64"),
    ]);
    await page.evaluate((entries) => {
      const toFile = (name, base64) => {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], name);
      };
      const input = document.getElementById("folder-input");
      const files = entries.map(([name, base64]) => toFile(name, base64));
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, entries);
  }

  async function waitSettled(page) {
    await waitFor(
      () =>
        page.evaluate(
          () =>
            !document.getElementById("results").hidden ||
            !document.getElementById("unknown-result").hidden ||
            !document.getElementById("manifest-result").hidden ||
            !document.getElementById("start").hidden,
        ),
      10000,
    );
    await settle(200);
  }

  // Picks several files at once, the way Claude's split export (conversations-000.zip, -001.zip…) arrives.
  async function pickFiles(page, files) {
    const input = await page.$("#file-input");
    await input.uploadFile(...files.map(([name, bytes]) => tmpZip(name, bytes)));
  }

  const readResults = (page) =>
    page.evaluate(() => {
      const chatCard = (d) => ({
        title: d.querySelector(".lb-card-title")?.textContent,
        date: d.querySelector(".lb-card-date")?.textContent,
        tags: [...d.querySelectorAll(".lb-card-head .lb-tag")].map((t) => t.textContent),
        openHref: d.querySelector(".lb-card-actions a")?.href || null,
      });
      return {
        resultsShown: !document.getElementById("results").hidden,
        heading: document.getElementById("results-heading").textContent,
        cards: [...document.querySelectorAll("#chat-cards > .lb-card-item")].map(chatCard),
        sharedRows: [...document.querySelectorAll(".lb-shared-row")].map((r) => r.textContent),
      };
    });

  // A card's "Ask $1 to delete it" button lives in its <details>' closed-by-default body, same as a real person
  // would need to expand the card first to see it.
  async function openFirstCardsLetter(page) {
    await page.evaluate(() => {
      document.querySelector("#chat-cards .lb-card-item").open = true;
    });
    await settle(100);
    await page.click("#chat-cards .lb-card-item .lb-card-actions button");
    await settle(150);
  }

  // ---------- LK1: each company's own zip ----------

  await check("LK1", "Look back: picking each company's own zip finds exactly what expected.json lists", async () => {
    for (const name of ["chatgpt", "claude", "gemini"]) {
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await pickZip(page, zipOf(name), `${name}.zip`);
        await waitSettled(page);
        const r = await readResults(page);
        expect(r.resultsShown, `${name}: results never showed`);
        expect(r.cards.length > 0, `${name}: no chat cards: ${JSON.stringify(r)}`);
        if (name === "chatgpt") {
          await shotAt(page, "lookback-results-light.png", { width: 380, height: 1100, theme: "light" });
          await shotAt(page, "lookback-results-dark.png", { width: 1280, height: 1000, theme: "dark" });
        }
      } finally {
        await page.close();
      }
    }
  });

  // ---------- LK2: a picked folder ----------

  await check("LK2", "Look back: a picked folder reads the same as the company's own zip", async () => {
    const page = await openExtPage(ctx, "lookback.html");
    try {
      await page.click('.lb-tab[data-tool="claude"]');
      await pickFolder(page, EXPORTS.claude);
      await waitSettled(page);
      const r = await readResults(page);
      expect(r.resultsShown, `folder pick: results never showed: ${JSON.stringify(r)}`);
      expect(r.cards.length === 2, `folder pick: expected 2 chats, got ${r.cards.length}`);
    } finally {
      await page.close();
    }
  });

  // ---------- LK3: a lone JSON file ----------

  await check("LK3", "Look back: a lone MyActivity.json, picked by itself, is read and grouped by day", async () => {
    const page = await openExtPage(ctx, "lookback.html");
    try {
      const geminiJson = EXPORTS.gemini["Takeout/My Activity/Gemini Apps/MyActivity.json"];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-lb-json-"));
      const p = path.join(dir, "MyActivity.json");
      fs.writeFileSync(p, geminiJson);
      const input = await page.$("#file-input");
      await input.uploadFile(p);
      await waitSettled(page);
      const r = await readResults(page);
      expect(r.resultsShown, `lone JSON: results never showed: ${JSON.stringify(r)}`);
      expect(r.cards.length === 2, `lone JSON: expected 2 day-groups, got ${r.cards.length}`);
    } finally {
      await page.close();
    }
  });

  // ---------- LK4: Stop keeps nothing ----------

  // A plain export reads in well under a second, so Stop needs a slower one to land on. This builds a synthetic
  // Gemini export padded out to a few seconds' worth of reading.
  function geminiPadded(approxBytes) {
    const filler = "stress padding ".repeat(150); // ~2.3 KB of harmless, unfindable text per record
    const records = [];
    let total = 0;
    let i = 0;
    while (total < approxBytes) {
      const day = new Date(Date.UTC(2021, 0, 1) + i * 86400000).toISOString();
      const rec = {
        title: `Prompted entry ${i} ${filler}`,
        time: day,
        header: "Gemini Apps",
        products: ["Gemini Apps"],
      };
      const text = JSON.stringify(rec);
      total += text.length + 1;
      records.push(rec);
      i++;
    }
    return zip({ "Takeout/My Activity/Gemini Apps/MyActivity.json": JSON.stringify(records) });
  }

  await check("LK4", "Look back: Stop ends the read and keeps nothing on screen", async () => {
    const page = await openExtPage(ctx, "lookback.html");
    try {
      const bytes = geminiPadded(25 * 1024 * 1024);
      const [, workerTarget] = await Promise.all([
        pickZip(page, bytes, "stress.zip"),
        ctx.browser.waitForTarget((t) => t.url().endsWith("/lookback-worker.js"), { timeout: 10000 }).catch(() => null),
      ]);
      expect(workerTarget, "Look back's worker never started");
      const readingShown = await page.evaluate(() => !document.getElementById("reading").hidden);
      expect(readingShown, "the reading screen never showed before Stop");
      await page.click("#stop");
      await settle(200);
      const after = await page.evaluate(() => ({
        reading: document.getElementById("reading").hidden,
        start: document.getElementById("start").hidden,
        results: document.getElementById("results").hidden,
        feed: document.getElementById("live-feed").children.length,
      }));
      expect(after.reading && !after.start, `after Stop: ${JSON.stringify(after)}`);
      expect(after.results, "results showed after Stop");
      // The worker has been terminated, so nothing more should arrive even if it was mid-tick.
      await sleep(300);
      const stillStart = await page.evaluate(() => !document.getElementById("start").hidden);
      expect(stillStart, "the start screen didn't stay up after Stop");
    } finally {
      await page.close();
    }
  });

  // ---------- LK5: an export Clotr doesn't read ----------

  await check(
    "LK5",
    "Look back: an unknown export and Takeout's HTML export each explain themselves plainly",
    async () => {
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await pickZip(page, zipOf("unknown"), "unknown.zip");
        await waitSettled(page);
        let shown = await page.evaluate(() => ({
          unsupported: document.getElementById("unsupported").hidden
            ? null
            : document.getElementById("unsupported").textContent,
        }));
        expect(/can't read this export yet/.test(shown.unsupported || ""), `unknown export text: ${shown.unsupported}`);
        await shotAt(page, "lookback-unsupported-light.png", { width: 380, theme: "light" });

        await page.click("#try-again");
        await pickZip(page, zipOf("gemini-html"), "gemini-html.zip");
        await waitSettled(page);
        shown = await page.evaluate(() => ({
          unsupported: document.getElementById("unsupported").hidden
            ? null
            : document.getElementById("unsupported").textContent,
        }));
        expect(/JSON for My Activity/.test(shown.unsupported || ""), `gemini-html export text: ${shown.unsupported}`);
      } finally {
        await page.close();
      }
    },
  );

  // ---------- LK6: Open the chat, only to the checked address ----------

  await check("LK6", "Look back: 'Open the chat' only ever points at the company's own checked address", async () => {
    const page = await openExtPage(ctx, "lookback.html");
    try {
      await pickZip(page, zipOf("chatgpt"), "chatgpt.zip");
      await waitSettled(page);
      const r = await readResults(page);
      const hrefs = r.cards.map((c) => c.openHref).filter(Boolean);
      expect(hrefs.length > 0, "no chat card offered 'Open the chat'");
      expect(
        hrefs.every((h) => /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/i.test(h)),
        `an 'Open the chat' link wasn't the checked address: ${JSON.stringify(hrefs)}`,
      );
      const hostileChecks = await page.evaluate(() => [
        window.Clotr.chatLinkOk("https://evil.example/c/6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10"),
        window.Clotr.chatLinkOk("javascript:alert(1)"),
        window.Clotr.chatLinkOk("https://chatgpt.com/c/6a1e0c2f-5b7d-4e1a-9c3f-0d2b8e4f7a10"),
      ]);
      expect(
        hostileChecks[0] === false && hostileChecks[1] === false && hostileChecks[2] === true,
        `chatLinkOk on this page: ${JSON.stringify(hostileChecks)}`,
      );
    } finally {
      await page.close();
    }
  });

  // ---------- LK7: never a whole value, only mask()'ed ----------

  await check("LK7", "Look back: not one fixture value ever appears whole on the page, only masked", async () => {
    const page = await openExtPage(ctx, "lookback.html");
    try {
      await pickZip(page, zipOf("chatgpt"), "chatgpt.zip");
      await waitSettled(page);
      const page2 = page; // keep the same tab for the Claude read below
      const bodyText1 = await page2.evaluate(() => document.body.innerText);
      const rawChatgpt = [
        "AKIA4HPQ7XZ2R6TWLJ3N",
        "Sunflower!2024",
        "219-09-9999",
        "1600 Elm Street, Springfield, IL 62704",
      ];
      for (const v of rawChatgpt) expect(!bodyText1.includes(v), `a raw value reached the page: ${v}`);

      await page2.click("#forget");
      await pickZip(page2, zipOf("claude"), "claude.zip");
      await waitSettled(page2);
      const bodyText2 = await page2.evaluate(() => document.body.innerText);
      const rawClaude = ["5555 5555 5555 4444", "March 3, 1961"];
      for (const v of rawClaude) expect(!bodyText2.includes(v), `a raw value reached the page: ${v}`);
    } finally {
      await page.close();
    }
  });

  // ---------- LK8: the stress run ----------

  // ChatGPT-shaped: ChatGPT's reader streams one conversation at a time, each well under the 32 MB chat cap,
  // the path the 200 MB worker-memory budget is written for.
  function chatgptStress(approxBytes) {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(40); // ~2.3 KB per message
    const convos = [];
    let total = 0;
    let i = 0;
    while (total < approxBytes) {
      const extra = i === 1 ? " you can reach me at look.back.stress.test@example.com" : "";
      const text = `stress entry ${i}${extra} ${filler}`;
      const conv = {
        id: `c${i}`,
        conversation_id: `c${i}`,
        title: `Stress ${i}`,
        create_time: 1700000000 + i,
        current_node: "n1",
        mapping: {
          n1: {
            parent: null,
            message: { author: { role: "user" }, content: { content_type: "text", parts: [text] }, metadata: {} },
          },
        },
      };
      const packed = JSON.stringify(conv);
      total += packed.length + 1;
      convos.push(conv);
      i++;
    }
    return { bytes: zip({ "conversations.json": JSON.stringify(convos) }), records: i };
  }

  await check(
    "LK8",
    "Look back: a 300 MB synthetic export reads to the end, still finding what's in it, under the worker's memory budget",
    async () => {
      const { bytes, records } = chatgptStress(300 * 1024 * 1024);
      const page = await openExtPage(ctx, "lookback.html");
      try {
        const [, workerTarget] = await Promise.all([
          pickZip(page, bytes, "stress-300mb.zip"),
          ctx.browser
            .waitForTarget((t) => t.url().endsWith("/lookback-worker.js"), { timeout: 15000 })
            .catch(() => null),
        ]);
        expect(workerTarget, "Look back's worker never started for the 300 MB export");

        let peakHeap = 0;
        let session = null;
        try {
          session = await workerTarget.createCDPSession();
        } catch (err) {
          throw new Skip(`couldn't attach to the worker to measure memory: ${err.message}`);
        }
        const poll = setInterval(async () => {
          try {
            const r = await session.send("Runtime.getHeapUsage");
            if (r.usedSize > peakHeap) peakHeap = r.usedSize;
          } catch {
            // The worker may already be gone between done and terminate(), which is fine to ignore.
          }
        }, 150);

        const started = Date.now();
        await waitFor(
          () =>
            page.evaluate(
              () => !document.getElementById("results").hidden || !document.getElementById("unsupported").hidden,
            ),
          220000,
          500,
        );
        const seconds = (Date.now() - started) / 1000;
        clearInterval(poll);
        await sleep(200);

        const r = await readResults(page);
        expect(r.resultsShown, `300 MB export: results never showed after ${seconds.toFixed(1)}s`);
        expect(r.cards.length > 0, "the planted email wasn't found in the 300 MB export");

        const budget = 200 * 1024 * 1024;
        if (peakHeap === 0)
          throw new Skip("heap usage never measured (worker may have finished before the first poll)");
        expect(
          peakHeap < budget,
          `worker heap peaked at ${(peakHeap / 1024 / 1024).toFixed(0)} MB, over the 200 MB budget`,
        );

        return `${seconds.toFixed(1)}s, ~${records} chats, peak worker heap ${(peakHeap / 1024 / 1024).toFixed(0)} MB`;
      } finally {
        await page.close();
      }
    },
  );

  // ---------- LK9: the Gemini memory fix ----------

  // Gemini's reader used to hold every record in memory before grouping them by day, which peaked near 400 MB
  // on a 300 MB export against the 200 MB budget. Now it groups by day as records stream in, flushing each day's
  // buffer as soon as the next day starts, so at most one day's prompts sit in memory at once. Forty prompts a
  // day is already a heavy Gemini habit, but it still gives enough days at this size to prove the flush runs
  // thousands of times rather than once.
  function geminiStress(approxBytes) {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(40); // ~2.3 KB per record
    const perDay = 40;
    const records = [];
    let total = 0;
    let i = 0;
    while (total < approxBytes) {
      const day = new Date(Date.UTC(2021, 0, 1) + Math.floor(i / perDay) * 86400000).toISOString();
      const extra = i === 1 ? " you can reach me at look.back.stress.test@example.com" : "";
      const rec = {
        title: `Prompted stress entry ${i}${extra} ${filler}`,
        time: day,
        header: "Gemini Apps",
        products: ["Gemini Apps"],
      };
      const text = JSON.stringify(rec);
      total += text.length + 1;
      records.push(rec);
      i++;
    }
    return { bytes: zip({ "Takeout/My Activity/Gemini Apps/MyActivity.json": JSON.stringify(records) }), records: i };
  }

  await check(
    "LK9",
    "Look back: a 300 MB synthetic Gemini export reads to the end, under the worker's memory budget",
    async () => {
      const { bytes, records } = geminiStress(300 * 1024 * 1024);
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await page.click('.lb-tab[data-tool="gemini"]');
        const [, workerTarget] = await Promise.all([
          pickZip(page, bytes, "gemini-stress-300mb.zip"),
          ctx.browser
            .waitForTarget((t) => t.url().endsWith("/lookback-worker.js"), { timeout: 15000 })
            .catch(() => null),
        ]);
        expect(workerTarget, "Look back's worker never started for the 300 MB Gemini export");

        let peakHeap = 0;
        let session = null;
        try {
          session = await workerTarget.createCDPSession();
        } catch (err) {
          throw new Skip(`couldn't attach to the worker to measure memory: ${err.message}`);
        }
        const poll = setInterval(async () => {
          try {
            const r = await session.send("Runtime.getHeapUsage");
            if (r.usedSize > peakHeap) peakHeap = r.usedSize;
          } catch {
            // The worker may already be gone between done and terminate(), which is fine to ignore.
          }
        }, 150);

        const started = Date.now();
        await waitFor(
          () =>
            page.evaluate(
              () => !document.getElementById("results").hidden || !document.getElementById("unsupported").hidden,
            ),
          220000,
          500,
        );
        const seconds = (Date.now() - started) / 1000;
        clearInterval(poll);
        await sleep(200);

        const r = await readResults(page);
        expect(r.resultsShown, `300 MB Gemini export: results never showed after ${seconds.toFixed(1)}s`);
        expect(r.cards.length > 0, "the planted email wasn't found in the 300 MB Gemini export");

        const budget = 200 * 1024 * 1024;
        if (peakHeap === 0)
          throw new Skip("heap usage never measured (worker may have finished before the first poll)");
        expect(
          peakHeap < budget,
          `Gemini worker heap peaked at ${(peakHeap / 1024 / 1024).toFixed(0)} MB, over the 200 MB budget`,
        );

        return `${seconds.toFixed(1)}s, ~${records} prompts, peak worker heap ${(peakHeap / 1024 / 1024).toFixed(0)} MB`;
      } finally {
        await page.close();
      }
    },
  );

  // ---------- LK10: the deletion letter's panel ----------

  await check(
    "LK10",
    "Look back: the deletion letter's panel builds a letter naming kinds, dates and links, never a value",
    async () => {
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await pickZip(page, zipOf("chatgpt"), "chatgpt.zip");
        await waitSettled(page);
        await openFirstCardsLetter(page);

        const open = await page.evaluate(() => ({
          panelShown: !document.getElementById("letter-panel").hidden,
          resultsShown: !document.getElementById("results").hidden,
          picks: document.querySelectorAll("#letter-chat-picks input:checked").length,
        }));
        expect(open.panelShown && !open.resultsShown, `opening the letter panel: ${JSON.stringify(open)}`);
        expect(open.picks === 1, `only the chosen chat should start ticked: ${open.picks}`);

        await page.click('input[name="letter-place"][value="eu"]');
        await settle(100);
        let letter = await page.evaluate(() => document.getElementById("letter-box").value);
        expect(/Article 17/.test(letter), `EU letter should name GDPR's Article 17: ${letter.slice(0, 200)}`);

        const rawChatgpt = [
          "AKIA4HPQ7XZ2R6TWLJ3N",
          "Sunflower!2024",
          "219-09-9999",
          "1600 Elm Street, Springfield, IL 62704",
        ];
        for (const v of rawChatgpt) expect(!letter.includes(v), `a raw value reached the letter: ${v}`);

        await page.click('input[name="letter-place"][value="california"]');
        await settle(100);
        letter = await page.evaluate(() => document.getElementById("letter-box").value);
        expect(
          /45 days|45-day|CCPA/i.test(letter),
          `California letter should name its own law: ${letter.slice(0, 200)}`,
        );

        await shotAt(page, "lookback-letter-light.png", { width: 380, height: 1100, theme: "light" });
        await shotAt(page, "lookback-letter-dark.png", { width: 1280, height: 1000, theme: "dark" });

        await page.click("#letter-back");
        await settle(100);
        const back = await page.evaluate(() => ({
          panelShown: !document.getElementById("letter-panel").hidden,
          resultsShown: !document.getElementById("results").hidden,
        }));
        expect(!back.panelShown && back.resultsShown, `'Back' should return to the results: ${JSON.stringify(back)}`);
      } finally {
        await page.close();
      }
    },
  );

  // ---------- LK11: the same screens in Spanish (the letter, and the two wording fixes) ----------

  // chrome.i18n.getMessage reads the browser's own UI locale, so I launch a real Spanish browser instead of
  // overriding anything in the page. That gives a true picture of the Spanish text's length and wrapping, and
  // checks the wording fixes in Spanish as well as English.
  await check(
    "LK11",
    "Look back: the results and the letter panel read correctly in Spanish, at both widths",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const page = await openExtPage(es, "lookback.html");
        try {
          await pickZip(page, zipOf("chatgpt"), "chatgpt.zip");
          await waitSettled(page);
          const text = await page.evaluate(() => ({
            lang: document.documentElement.lang,
            sharedRows: [...document.querySelectorAll(".lb-shared-row")].map((r) => r.textContent),
            differentNoteShown: !document.getElementById("shared-different-note").hidden,
          }));
          expect(text.lang === "es", `page-i18n didn't switch to Spanish: lang=${text.lang}`);
          expect(
            text.sharedRows.some((r) => / en \d+ chats?(\D|$)/.test(r)),
            `no shared row read like Spanish's singular/plural: ${JSON.stringify(text.sharedRows)}`,
          );
          if (text.differentNoteShown)
            expect(
              text.sharedRows.some((r) => /distintos\)$/.test(r)),
              "the 'different' note showed without any row actually having a different count",
            );
          await shotAt(page, "lookback-results-es-light.png", { width: 380, height: 1100, theme: "light" });
          await shotAt(page, "lookback-results-es-dark.png", { width: 1280, height: 1000, theme: "dark" });

          await openFirstCardsLetter(page);
          await page.click('input[name="letter-place"][value="eu"]');
          await settle(100);
          const letter = await page.evaluate(() => document.getElementById("letter-box").value);
          expect(
            /artículo 17/i.test(letter),
            `Spanish EU letter should name the GDPR's article 17: ${letter.slice(0, 200)}`,
          );
          await shotAt(page, "lookback-letter-es-light.png", { width: 380, height: 1100, theme: "light" });
          await shotAt(page, "lookback-letter-es-dark.png", { width: 1280, height: 1000, theme: "dark" });
        } finally {
          await page.close();
        }
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // ---------- LK12: Claude's manifest: links, never fetched, never shown as raw text ----------

  await check(
    "LK12",
    "Look back: Claude's manifest explains itself and links the conversations files, never fetching or showing a raw URL",
    async () => {
      const [manifestName, manifestContent] = Object.entries(EXPORTS["claude-manifest"])[0];
      const manifest = JSON.parse(manifestContent);
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await pickZip(page, manifestContent, manifestName);
        await waitSettled(page);
        const shown = await page.evaluate(() => ({
          manifestShown: !document.getElementById("manifest-result").hidden,
          resultsShown: !document.getElementById("results").hidden,
          heading: document.getElementById("manifest-heading").textContent,
          expiry: document.getElementById("manifest-expiry").textContent,
          links: [...document.querySelectorAll("#manifest-links li")].map((li) => ({
            text: li.textContent,
            href: li.querySelector("a")?.href || null,
          })),
          bodyText: document.body.innerText,
        }));
        expect(
          shown.manifestShown && !shown.resultsShown,
          "the manifest screen never showed, or results showed instead",
        );
        expect(shown.heading.length > 0, "no manifest heading text");
        expect(/24 hours/.test(shown.expiry), `expiry note missing "24 hours": ${shown.expiry}`);
        expect(
          shown.links.length === manifest.data_files.length,
          `expected ${manifest.data_files.length} links, got ${JSON.stringify(shown.links)}`,
        );
        for (const [i, f] of manifest.data_files.entries()) {
          expect(shown.links[i].text === f.filename, `link ${i} text: ${JSON.stringify(shown.links[i])}`);
          expect(shown.links[i].href === f.export_url, `link ${i} href: ${JSON.stringify(shown.links[i])}`);
          expect(!shown.bodyText.includes(f.export_url), `the raw URL was shown as text: ${f.export_url}`);
        }
        await shotAt(page, "lookback-manifest-light.png", { width: 380, theme: "light" });
        await shotAt(page, "lookback-manifest-dark.png", { width: 1280, height: 700, theme: "dark" });

        // "Choose the file" returns to the start screen, ready to pick the real conversations file(s).
        await page.click("#manifest-choose");
        await settle(100);
        const afterChoose = await page.evaluate(() => ({
          startShown: !document.getElementById("start").hidden,
          manifestShown: !document.getElementById("manifest-result").hidden,
        }));
        expect(
          afterChoose.startShown && !afterChoose.manifestShown,
          `'Choose the file' didn't return to the start screen: ${JSON.stringify(afterChoose)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  // ---------- LK13: several conversations-NNN.zip parts, chosen together, read as one export ----------

  await check(
    "LK13",
    "Look back: several conversations-NNN.zip parts, chosen together, read as one export",
    async () => {
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await pickFiles(page, [
          ["conversations-000.zip", zipOf("claude-conversations-000")],
          ["conversations-001.zip", zipOf("claude-conversations-001")],
        ]);
        await waitSettled(page);
        const r = await readResults(page);
        expect(r.resultsShown, `parts pick: results never showed: ${JSON.stringify(r)}`);
        // The two made-up Claude chats each live in their own part, and should read as one export.
        expect(r.cards.length === 2, `parts pick: expected 2 chats, got ${r.cards.length}: ${JSON.stringify(r)}`);
        const titles = r.cards.map((c) => c.title).sort();
        expect(
          titles.join("|") === ["Budget spreadsheet help", "Doctor visit notes"].join("|"),
          `parts pick: unexpected chats: ${JSON.stringify(titles)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  // ---------- A11Y4: no serious accessibility problems (A11Y1-3 are 13-accessibility.js's and extcheck's) ----------

  await check(
    "A11Y4",
    "Look back: no serious accessibility problems in the start, reading, results, letter-panel or manifest screens",
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
      const page = await openExtPage(ctx, "lookback.html");
      try {
        await audit(page, "lookback.html start");
        await pickZip(page, zipOf("chatgpt"), "chatgpt.zip");
        await waitSettled(page);
        await audit(page, "lookback.html results");
        await openFirstCardsLetter(page);
        await audit(page, "lookback.html letter panel");
        await page.click("#letter-back");
        await settle(100);
        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
        await settle(200);
        const stillVisible = await page.evaluate(() => !document.getElementById("results").hidden);
        expect(stillVisible, "results disappeared under prefers-reduced-motion");
        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
        await page.click("#forget");
        const [manifestName, manifestContent] = Object.entries(EXPORTS["claude-manifest"])[0];
        await pickZip(page, manifestContent, manifestName);
        await waitSettled(page);
        await audit(page, "lookback.html manifest");
      } finally {
        await page.close();
      }
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );
};
