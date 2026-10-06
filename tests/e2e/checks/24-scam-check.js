// E2E checks: SC. "Is this a scam?" (check.html) lets someone paste a message they got and see the warning signs
// Clotr knows, each in plain words with its source. It never says a message is fine, and it keeps nothing.
"use strict";

module.exports = async function (env) {
  const { EXT, OUT, check, ctx, expect, fs, launch, openExtPage, path, shotAt, sleep, store } = env;

  const LOOKALIKE = "Your package is out for delivery today. Track it at example.com/track";

  // Pastes a message into the box the way a real paste would, setting the value then firing an input event, and checks it.
  const checkMessage = async (page, text) => {
    await page.$eval(
      "#message",
      (box, t) => {
        box.value = t;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      },
      text,
    );
    await page.click("#check-it");
    await page.waitForFunction(() => !document.getElementById("result").hidden, { timeout: 3000 });
    await sleep(150);
  };
  const tryMadeUp = async (page) => {
    await page.click("#try-made-up");
    await page.waitForFunction(() => !document.getElementById("result").hidden, { timeout: 3000 });
    await sleep(150);
  };
  const again = async (page) => {
    await page.click("#check-another");
    await sleep(150);
  };
  // What the page shows after a check.
  const read = (page) =>
    page.evaluate(() => {
      const shown = (id) => {
        const el = document.getElementById(id);
        return Boolean(el) && !el.hidden && el.getClientRects().length > 0;
      };
      return {
        title: document.getElementById("found-title")?.textContent.trim() || "",
        none: shown("none"),
        cards: [...document.querySelectorAll("#signs .sign-card")].map((c) => ({
          id: c.dataset.sign,
          name: c.querySelector(".sign-name")?.textContent.trim(),
          words: c.querySelector(".sign-words")?.textContent.trim(),
          means: c.querySelector(".sign-means")?.textContent.trim(),
          source: c.querySelector(".sign-source a")?.getAttribute("href") || "",
          text: c.textContent,
        })),
        marks: [...document.querySelectorAll("#marked mark")].map((m) => ({
          text: m.textContent,
          label: m.getAttribute("aria-label") || m.title || "",
        })),
        before: [...document.querySelectorAll("#before li")]
          .filter((li) => !li.hidden)
          .map((li) => li.textContent.trim()),
        page: document.body.innerText,
      };
    });
  // Every colour on screen as [r, g, b]. It counts as green if it's clearly more green than red or blue.
  const greens = (page) =>
    page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("#result, #result *")) {
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        for (const c of [cs.color, cs.backgroundColor, cs.borderLeftColor, cs.fill]) {
          const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(c || "");
          if (!m || m[4] === "0") continue;
          const [r, g, b] = [+m[1], +m[2], +m[3]];
          if (g > r + 40 && g > b + 40) out.push(`${el.id || el.className || el.tagName}: ${c}`);
        }
      }
      return out;
    });
  const UNSAID = /\b(?:safe|fine|legit)\b|not a scam|100\s?%|\d\s?%|\bseguro\b|\bsegura\b|está bien|no es una estafa/i;

  await check(
    "SC1",
    "The made-up message: four signs, each word marked in the message, each card with its source",
    async () => {
      const page = await openExtPage(ctx, "check.html");
      try {
        await tryMadeUp(page);
        const got = await read(page);
        expect(got.title === "Clotr found 4 warning signs", `title: ${got.title}`);
        expect(
          JSON.stringify(got.cards.map((c) => c.id)) ===
            JSON.stringify(["asks_code", "press_rush", "press_secret", "pret_bank"]),
          `cards: ${got.cards.map((c) => c.id)}`,
        );
        const code = got.cards.find((c) => c.id === "asks_code");
        expect(code.name === "Asks for a code that was sent to you", `name: ${code.name}`);
        expect(code.words === "“the 6-digit code we just texted you”", `words: ${code.words}`);
        expect(/scammer: with it, they get into your account/.test(code.means), `means: ${code.means}`);
        for (const c of got.cards) expect(/^https:\/\/(consumer\.)?ftc\.gov\//.test(c.source), `${c.id}: ${c.source}`);
        expect(
          JSON.stringify(got.marks.map((m) => m.text)) ===
            JSON.stringify([
              "the fraud team at Anytown Bank",
              "right away",
              "the 6-digit code we just texted you",
              "Don't tell anyone at the branch",
              "they may be in on it",
            ]),
          `marks: ${JSON.stringify(got.marks.map((m) => m.text))}`,
        );
        // Colour is never the only signal. Each mark also names which sign it is.
        expect(
          got.marks.every((m) => m.label),
          "a mark with no name",
        );
        expect(/Rushes you/.test(got.marks[1].label), `label: ${got.marks[1].label}`);
        expect(got.before.length === 2, `before you answer: ${got.before}`);
        expect(!UNSAID.test(got.page.replace(/It never says a message is fine/, "")), "a word that says it's fine");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "SC2",
    "A look-alike: \"didn't find any of the signs it knows\", no green, no tick, and why it's not a yes",
    async () => {
      const page = await openExtPage(ctx, "check.html");
      try {
        await checkMessage(page, LOOKALIKE);
        const got = await read(page);
        expect(got.none, "no none-found line");
        expect(!got.cards.length && !got.marks.length, `cards: ${got.cards.length}, marks: ${got.marks.length}`);
        expect(/Clotr didn't find any of the signs it knows/.test(got.page), "the none-found title");
        expect(/That doesn't tell you the message is real/.test(got.page), "the line that it's not a yes");
        expect(!/✓|✔|☑/.test(got.page), "a tick");
        expect(!UNSAID.test(got.page.replace(/It never says a message is fine/, "")), "a word that says it's fine");
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          const green = await greens(page);
          expect(!green.length, `${theme}: green on screen: ${green.slice(0, 3)}`);
        }
        // Before you answer shows either way, with the link's own line.
        expect(
          got.before.some((l) => /It has a link: don't use it to check/.test(l)),
          `before: ${got.before}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "SC3",
    "A message with a phone number or a link: Before you answer says not to use it to check",
    async () => {
      const page = await openExtPage(ctx, "check.html");
      try {
        await checkMessage(page, "Anytown Bank: call our fraud team at (555) 555-0142 right away about a charge.");
        let got = await read(page);
        expect(
          got.before.some((l) => /It has a phone number: don't call it to check/.test(l)),
          `phone: ${got.before}`,
        );
        expect(!got.before.some((l) => /It has a link/.test(l)), `a link line with no link: ${got.before}`);
        await again(page);
        await checkMessage(page, "Hi! See the photos at example.com/album and call me at 555-0199 tonight.");
        got = await read(page);
        expect(
          got.before.some((l) => /phone number/.test(l)) && got.before.some((l) => /link/.test(l)),
          `${got.before}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "SC4",
    'Your own name in the message: "Mentions your own details" names the kind, never the name',
    async () => {
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "watch_list", "Maria Lopez"),
      );
      await store.set(ctx, { vault: [{ kind: "word", type: "my_name", fp, words: 2, added: Date.now() }] });
      const page = await openExtPage(ctx, "check.html");
      try {
        await sleep(300); // the page reads the vault's fingerprints
        await checkMessage(page, "Hello Maria Lopez, this is the IRS. Confirm your Social Security number today.");
        const got = await read(page);
        const knows = got.cards.find((c) => c.id === "pret_knows_you");
        expect(knows, `cards: ${got.cards.map((c) => c.id)}`);
        expect(/your name/.test(knows.words), `kinds: ${knows.words}`);
        expect(!/Maria|Lopez/.test(knows.text), `the name in the card: ${knows.text}`);
        // The person's own pasted text keeps its mark, so they can see where.
        expect(
          got.marks.some((m) => m.text === "Maria Lopez"),
          `marks: ${got.marks.map((m) => m.text)}`,
        );
      } finally {
        await page.close();
        await store.set(ctx, { vault: [] });
      }
    },
  );

  await check("SC5", "Nothing is kept: storage is the same before and after checking messages", async () => {
    const snapshot = () =>
      ctx.worker.evaluate(async () =>
        JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
      );
    const before = await snapshot();
    const page = await openExtPage(ctx, "check.html");
    try {
      await tryMadeUp(page);
      await again(page);
      await checkMessage(page, LOOKALIKE);
      await sleep(400);
    } finally {
      await page.close();
    }
    await sleep(300);
    const after = await snapshot();
    expect(before === after, "storage changed while checking messages");
    expect(!after.includes("Anytown") && !after.includes("example.com/track"), "a pasted message in storage");
  });

  await check(
    "SC6",
    "Already answered, paid or let someone in? The fold opens on What to do now and Tourniquet",
    async () => {
      const page = await openExtPage(ctx, "check.html");
      try {
        await tryMadeUp(page);
        const closed = await page.$eval("#answered", (d) => d.open);
        expect(!closed, "the fold starts open");
        await page.click("#answered summary");
        await sleep(150);
        const got = await page.evaluate(() => ({
          open: document.getElementById("answered").open,
          text: document.getElementById("answered").innerText,
          tq: document.querySelector("#answered a[href^='helper.html']")?.getAttribute("href"),
          out: [...document.querySelectorAll("#answered a[target='_blank']")].map((a) => a.rel),
        }));
        expect(got.open, "the fold didn't open");
        await shotAt(page, "scam-check-fold-380-dark.png", { width: 380, height: 1900, theme: "dark" });
        expect(/What to do now/.test(got.text) && /Paid with a gift card\?/.test(got.text), `fold: ${got.text}`);
        expect(got.tq === "helper.html?for=after_scam", `Tourniquet link: ${got.tq}`);
        expect(
          got.out.length >= 2 && got.out.every((r) => /noopener/.test(r) && /noreferrer/.test(r)),
          `links out: ${got.out}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check("SC7", "Spanish browser: the page, the made-up message and its four signs are in Spanish", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      const page = await openExtPage(es, "check.html");
      const empty = await page.evaluate(() => ({
        h1: document.querySelector("h1").textContent.trim(),
        title: document.title,
        lang: document.documentElement.lang,
      }));
      expect(empty.h1 === "¿Es una estafa?" && empty.title === "¿Es una estafa?", `title: ${JSON.stringify(empty)}`);
      expect(empty.lang === "es", `lang: ${empty.lang}`);
      await shotAt(page, "scam-check-empty-es-380.png", { width: 380, height: 760, theme: "dark" });
      await tryMadeUp(page);
      const got = await read(page);
      expect(got.title === "Clotr encontró 4 señales de alerta", `title: ${got.title}`);
      expect(
        got.cards.map((c) => c.id).join() === "asks_code,press_rush,press_secret,pret_bank",
        `cards: ${got.cards.map((c) => c.id)}`,
      );
      expect(got.cards[0].name === "Pide un código que te enviaron", `name: ${got.cards[0].name}`);
      expect(/Fuente/.test(got.cards[0].text), `source: ${got.cards[0].text}`);
      expect(!/Asks for|Rushes you|Before you answer|The message you got/.test(got.page), "English left");
      await shotAt(page, "scam-check-signs-es-380.png", { width: 380, height: 2000, theme: "dark" });
      await again(page);
      await checkMessage(page, "Tu paquete sale hoy para entrega. Síguelo en example.com/envio");
      const none = await read(page);
      expect(none.none && /Clotr no encontró ninguna de las señales que conoce/.test(none.page), "none-found");
      await shotAt(page, "scam-check-none-es-380.png", { width: 380, height: 1100, theme: "light" });
      await page.close();
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  await check(
    "SC8",
    "At 380 px and 1040 px, light and dark: no sideways scroll, and no serious accessibility problem",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
      const page = await openExtPage(ctx, "check.html");
      const problems = [];
      try {
        const states = [
          ["empty", async () => {}],
          ["signs", () => tryMadeUp(page)],
          [
            "none",
            async () => {
              await again(page);
              await checkMessage(page, LOOKALIKE);
            },
          ],
        ];
        for (const [state, show] of states) {
          await show();
          for (const width of [380, 1040])
            for (const theme of ["dark", "light"]) {
              // The page's height at this width, so the picture holds all of it.
              await page.setViewport({ width, height: 800 });
              await sleep(150);
              const height = await page.evaluate(() => document.documentElement.scrollHeight);
              await shotAt(page, `scam-check-${state}-${width}-${theme}.png`, {
                width,
                height: Math.min(Math.max(height, 700), 3200),
                theme,
              });
              const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
              if (wide > 0) problems.push(`${state} ${width} ${theme}: ${wide}px sideways`);
              if (width === 380) {
                if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
                const found = await page.evaluate(async () =>
                  (await axe.run(document, { resultTypes: ["violations"] })).violations
                    .filter((v) => v.impact === "serious" || v.impact === "critical")
                    .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`),
                );
                problems.push(...found.map((f) => `${state} ${theme}: ${f}`));
              }
            }
        }
      } finally {
        await page.close();
      }
      expect(!problems.length, problems.slice(0, 4).join(" | "));
      return `screenshots in ${path.relative(process.cwd(), OUT)}`;
    },
  );
};
