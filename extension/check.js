// The "Is this a scam?" page. You paste a message you got, and Clotr marks the warning signs scam-signs.js
// knows, each with what it means and where that advice comes from. It reads the salt and the vault's
// fingerprints to notice your own details, but never writes to storage, sends anything, or logs anything. The
// pasted text lives in the page until it's closed or cleared.
"use strict";

(() => {
  const { msg, detect, fingerprint, setVault, scamSigns, scamHasLink } = globalThis.Clotr;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  };

  // ---------- Where each piece of advice comes from ----------

  const WHO = {
    ftc: msg("sc_srcFtc", "US FTC"),
    georgia: msg("sc_srcGeorgia", "Georgia Attorney General"),
    munster: msg("sc_srcMunster", "University of Münster"),
  };
  // Each source's own page title, in its own language.
  const SOURCES = {
    1: [
      "ftc",
      "What's a verification code and why would someone ask me for it?",
      "https://consumer.ftc.gov/consumer-alerts/2024/03/whats-verification-code-why-would-someone-ask-me-it",
    ],
    3: [
      "ftc",
      "Avoiding and Reporting Gift Card Scams",
      "https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams",
    ],
    4: ["ftc", "What To Do if You Were Scammed", "https://consumer.ftc.gov/articles/what-do-if-you-were-scammed"],
    5: ["georgia", "Credit Card Scams", "https://consumer.georgia.gov/credit-card-scams"],
    6: [
      "ftc",
      "Scammers use AI to enhance their family emergency schemes",
      "https://consumer.ftc.gov/consumer-alerts/2023/03/scammers-use-ai-enhance-their-family-emergency-schemes",
    ],
    7: [
      "ftc",
      "The Google Voice scam",
      "https://consumer.ftc.gov/consumer-alerts/2021/10/google-voice-scam-how-verification-code-scam-works-how-avoid-it",
    ],
    8: [
      "ftc",
      "How To Spot, Avoid, and Report Tech Support Scams",
      "https://consumer.ftc.gov/articles/how-spot-avoid-and-report-tech-support-scams",
    ],
    9: ["ftc", "How To Avoid a Scam", "https://consumer.ftc.gov/articles/how-avoid-scam"],
    10: [
      "ftc",
      "How To Recognize and Avoid Phishing Scams",
      "https://consumer.ftc.gov/articles/how-recognize-and-avoid-phishing-scams",
    ],
    11: [
      "ftc",
      "What To Know About Cryptocurrency and Scams",
      "https://consumer.ftc.gov/articles/what-know-about-cryptocurrency-and-scams",
    ],
    12: [
      "ftc",
      "How to Recognize and Report Spam Text Messages",
      "https://consumer.ftc.gov/articles/how-recognize-and-report-spam-text-messages",
    ],
    17: [
      "munster",
      "Warning about attacks with fake captchas (ClickFix)",
      "https://www.uni-muenster.de/Informationssicherheit/en/sammler/Warnung_ClickFix_20260507.html",
    ],
    18: [
      "ftc",
      "Scammers Use Fake Emergencies To Steal Your Money",
      "https://consumer.ftc.gov/articles/scammers-use-fake-emergencies-steal-your-money",
    ],
    19: [
      "ftc",
      "Sure ways to spot a scammer",
      "https://consumer.ftc.gov/consumer-alerts/2024/03/sure-ways-spot-scammer",
    ],
    20: [
      "ftc",
      "Never move your money to “protect it.” That’s a scam",
      "https://consumer.ftc.gov/consumer-alerts/2024/03/never-move-your-money-protect-it-thats-scam",
    ],
    21: [
      "ftc",
      "How To Avoid a Government Impersonation Scam",
      "https://consumer.ftc.gov/articles/how-avoid-government-impersonation-scam",
    ],
    22: ["ftc", "What To Know About Romance Scams", "https://consumer.ftc.gov/articles/what-know-about-romance-scams"],
    23: [
      "ftc",
      "Fake Prize, Sweepstakes, and Lottery Scams",
      "https://consumer.ftc.gov/articles/fake-prize-sweepstakes-and-lottery-scams",
    ],
  };
  // Each sign's sources, by number.
  const SIGN_SOURCES = {
    asks_code: [1, 7],
    asks_card_code: [5],
    asks_gift_card: [3],
    asks_remote: [8],
    asks_details: [10],
    asks_command: [17],
    pay_crypto: [11, 19],
    pay_hard_to_undo: [9, 18, 19],
    pay_move_money: [20],
    press_rush: [9, 19],
    press_secret: [18, 19],
    press_threat: [19],
    press_stay: [19],
    pret_gov: [21],
    pret_bank: [20],
    pret_support: [8],
    pret_family: [6, 18],
    pret_romance: [22],
    pret_knows_you: [21],
    prob_account: [10, 12],
    prob_prize: [23],
  };

  // "Sources: US FTC: How To Avoid a Scam · Sure ways to spot a scammer", each title a link that opens on a click.
  function sourceLine(numbers) {
    const label = numbers.length > 1 ? msg("sc_sources", "Sources:") : msg("sc_source", "Source:");
    const parts = [`${label} `];
    let lastWho = null;
    numbers.forEach((n, i) => {
      const [who, title, href] = SOURCES[n];
      if (i) parts.push(who === lastWho ? " · " : "; ");
      if (who !== lastWho) parts.push(`${WHO[who]}: `);
      parts.push(el("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: title }));
      lastWho = who;
    });
    return parts;
  }

  // ---------- The words for each sign ----------

  const GROUPS = {
    asks: msg("sc_group_asks", "It asks for a code or a detail"),
    pay: msg("sc_group_pay", "It wants you to pay in a certain way"),
    press: msg("sc_group_press", "It pressures you"),
    pret: msg("sc_group_pret", "It pretends to be someone you trust"),
    prob: msg("sc_group_prob", "It says there's a problem or a prize"),
  };
  const TECH = msg("sc_asks_remote_means", "Real tech companies don't contact you about a problem with your computer.");
  const SIGNS = {
    asks_code: [
      msg("sc_asks_code", "Asks for a code that was sent to you"),
      msg(
        "sc_asks_code_means",
        "Anyone who asks for a code sent to you is a scammer: with it, they get into your account.",
      ),
    ],
    asks_card_code: [
      msg("sc_asks_card_code", "Asks for the numbers on the back of your card"),
      msg("sc_asks_card_code_means", "Your card company never asks for them: it already has them."),
    ],
    asks_gift_card: [
      msg("sc_asks_gift_card", "Asks for gift cards"),
      msg(
        "sc_asks_gift_card_means",
        "No real business or government agency will ever tell you to pay with a gift card.",
      ),
    ],
    asks_remote: [msg("sc_asks_remote", "Asks to get into your computer"), TECH],
    asks_details: [
      msg("sc_asks_details", "Asks you to confirm personal or bank details"),
      msg(
        "sc_asks_details_means",
        "Messages that ask you to confirm your details are a common trick: you don't need to.",
      ),
    ],
    asks_command: [
      msg("sc_asks_command", "Asks you to paste a command"),
      msg("sc_asks_command_means", "No real check asks you to press Win+R or open Terminal and paste something."),
    ],
    pay_crypto: [
      msg("sc_pay_crypto", "Wants crypto or a Bitcoin ATM"),
      msg("sc_pay_crypto_means", "Only scammers demand payment in cryptocurrency."),
    ],
    pay_hard_to_undo: [
      msg("sc_pay_hard_to_undo", "Wants a wire transfer, cash, gold or a payment app"),
      msg("sc_pay_hard_to_undo_means", "Scammers ask for ways of paying that are hard to get back."),
    ],
    pay_move_money: [
      msg("sc_pay_move_money", "Tells you to move your money to protect it"),
      msg("sc_pay_move_money_means", "Someone who says you have to move your money to protect it is a scammer."),
    ],
    press_rush: [
      msg("sc_press_rush", "Rushes you"),
      msg("sc_press_rush_means", "Scammers push you to act right away, so you don't stop to check."),
    ],
    press_secret: [
      msg("sc_press_secret", "Tells you to keep it secret"),
      msg("sc_press_secret_means", "Scammers ask for secrecy so you don't talk to someone who'd spot it."),
    ],
    press_threat: [
      msg("sc_press_threat", "Threatens arrest, fines or a closed account"),
      msg("sc_press_threat_means", "Threats like these are a scammer's line, to scare you into paying."),
    ],
    press_stay: [
      msg("sc_press_stay", "Tells you not to hang up"),
      msg("sc_press_stay_means", "Keeping you on the line stops you checking with anyone."),
    ],
    pret_gov: [
      msg("sc_pret_gov", "Says it's the government, and asks for money or details"),
      msg(
        "sc_pret_gov_means",
        "Government agencies don't call, email or text to ask for money or personal information, the US FTC says.",
      ),
    ],
    pret_bank: [
      msg("sc_pret_bank", "Says it's your bank's fraud team, and asks for something"),
      msg("sc_pret_bank_means", "Hang up and call the number on your card or statement, never the one they give you."),
    ],
    pret_support: [
      msg("sc_pret_support", "Says it's tech support"),
      msg("sc_pret_support_means", "Real tech companies don't contact you about a problem with your computer."),
    ],
    pret_family: [
      msg("sc_pret_family", "Says a family member is in trouble"),
      msg("sc_pret_family_means", "Don't trust the voice or the name: call them on a number you know is theirs."),
    ],
    pret_romance: [
      msg("sc_pret_romance", "Someone you haven't met asks for money"),
      msg("sc_pret_romance_means", "Never send money or gifts to someone you haven't met in person."),
    ],
    pret_knows_you: [
      msg("sc_pret_knows_you", "Mentions your own details"),
      msg(
        "sc_pret_knows_you_means",
        "Knowing your name or address doesn't prove who they are: scammers often have details like these.",
      ),
    ],
    prob_account: [
      msg("sc_prob_account", "Says there's a problem with your account, a payment or a delivery"),
      msg("sc_prob_account_means", "A common opener. Check with the company on a number or website you already know."),
    ],
    prob_prize: [
      msg("sc_prob_prize", "Says you won something"),
      msg("sc_prob_prize_means", "Real prizes are free: if anything has to be paid first, it's a scam."),
    ],
  };
  // Your own details, named by kind only.
  const MINE = {
    my_name: msg("sc_mine_my_name", "your name"),
    family_name: msg("sc_mine_family_name", "a family member's name"),
    employer: msg("sc_mine_employer", "where you work"),
    my_id: msg("sc_mine_my_id", "your ID number"),
    watch_list: msg("sc_mine_watch_list", "a word on your list"),
    street_address: msg("sc_mine_street_address", "your address"),
    phone_number: msg("sc_mine_phone_number", "your phone number"),
    email: msg("sc_mine_email", "your email address"),
  };
  const mineName = (kind) => MINE[kind] || msg("sc_mine_other", "one of your details");

  // ---------- Your own details, by their fingerprints ----------

  // Reads the salt and the vault's fingerprints once; the page never writes either back.
  let own = { salt: null, vault: [] };
  chrome.storage.local
    .get(["salt", "vault"])
    .then(({ salt, vault }) => {
      own = { salt: typeof salt === "string" ? salt : null, vault: Array.isArray(vault) ? vault : [] };
      setVault({ salt: own.salt, entries: own.vault });
    })
    .catch(() => {});

  // Finds where your own details sit in the text: the vault's saved words, like a name or an employer, plus
  // any phone number, address, or ID whose fingerprint matches one the vault keeps. Only the kind and the
  // place come back; the sign itself never sees the actual value.
  const VAULT_WORDS = new Set(["my_name", "family_name", "employer", "watch_list"]);
  function mineIn(text) {
    if (!own.salt || !own.vault.length) return [];
    const values = own.vault.filter((e) => e && e.kind === "value" && typeof e.fp === "string");
    const out = [];
    for (const r of detect(text)) {
      for (const m of r.matches) {
        const ours =
          VAULT_WORDS.has(r.id) || values.some((e) => e.type === r.id && e.fp === fingerprint(own.salt, r.id, m));
        if (!ours) continue;
        for (let at = text.indexOf(m); at >= 0; at = text.indexOf(m, at + m.length))
          out.push({ kind: r.id, start: at, end: at + m.length });
      }
    }
    return out;
  }

  // ---------- Showing what was found ----------

  // Shows the message again with each sign's words wrapped in a <mark> named by its sign, both in the title
  // and in text a screen reader reads right after it, so colour is never the only way to tell.
  function marked(text, signs) {
    const edges = new Set([0, text.length]);
    for (const s of signs) for (const p of s.spans) edges.add(p.start).add(p.end);
    const cuts = [...edges].sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      const ids = signs.filter((s) => s.spans.some((p) => p.start <= a && p.end >= b)).map((s) => s.id);
      const last = pieces.at(-1);
      if (last && last.ids.join() === ids.join()) last.end = b;
      else pieces.push({ start: a, end: b, ids });
    }
    const nodes = [];
    for (const { start, end, ids } of pieces) {
      const words = text.slice(start, end);
      if (!ids.length) {
        nodes.push(words);
        continue;
      }
      const names = ids.map((id) => SIGNS[id][0]).join(", ");
      nodes.push(el("mark", { textContent: words, title: names }));
      nodes.push(el("span", { className: "sr-only", textContent: ` (${names})` }));
    }
    return nodes;
  }

  // What a sign's card quotes: the words it found (three at most, long ones cut), or for your own details the kinds.
  const quote = (words) => msg("sc_quote", "“$1”", words.length > 90 ? `${words.slice(0, 88)}…` : words);
  function wordsOf(text, sign) {
    if (sign.id === "pret_knows_you") return sign.kinds.map(mineName).join(", ");
    return sign.spans
      .slice(0, 3)
      .map((p) => quote(text.slice(p.start, p.end).replace(/\s+/g, " ")))
      .join(" · ");
  }

  function card(text, sign) {
    const [name, means] = SIGNS[sign.id];
    const box = el("article", { className: "sign-card" }, [
      el("h4", { className: "sign-name", textContent: name }),
      el("p", {
        className: sign.id === "pret_knows_you" ? "sign-words kinds" : "sign-words",
        textContent: wordsOf(text, sign),
      }),
      el("p", { className: "sign-means", textContent: means }),
      el("p", { className: "sign-source source" }, sourceLine(SIGN_SOURCES[sign.id])),
    ]);
    box.dataset.sign = sign.id;
    return box;
  }

  function showResult(text) {
    const signs = scamSigns(text, { mine: mineIn(text) });
    const count = signs.length;
    $("found").hidden = !count;
    $("none").hidden = Boolean(count);
    $("found-title").textContent =
      count === 1
        ? msg("sc_foundOne", "Clotr found 1 warning sign")
        : msg("sc_found", "Clotr found $1 warning signs", count);
    $("marked").replaceChildren(...marked(text, signs));
    const groups = [];
    for (const [group, title] of Object.entries(GROUPS)) {
      const mine = signs.filter((s) => s.group === group);
      if (!mine.length) continue;
      groups.push(
        el("section", { className: "sign-group" }, [
          el("h3", { textContent: title }),
          ...mine.map((s) => card(text, s)),
        ]),
      );
    }
    $("signs").replaceChildren(...groups);
    // Shows the "before you answer" note every time, with an extra line when the message has its own phone
    // number or link.
    $("has-phone").hidden = !detect(text).some((r) => r.id === "phone_number");
    $("has-link").hidden = !scamHasLink(text);
    $("answered").open = false;
    $("ask").hidden = true;
    $("result").hidden = false;
    (count ? $("found-title") : $("none-title")).focus();
  }

  // ---------- The box and its buttons ----------

  // Any error stays on this page, saying it couldn't check, with the box still there to try again.
  function check(text) {
    $("failed").hidden = true;
    $("empty-note").hidden = true;
    if (!text.trim()) {
      $("empty-note").hidden = false;
      $("message").focus();
      return;
    }
    try {
      showResult(text);
    } catch {
      $("result").hidden = true;
      $("ask").hidden = false;
      $("failed").hidden = false;
    }
  }

  $("check-it").addEventListener("click", () => check($("message").value));
  $("message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) check($("message").value);
  });
  $("message").addEventListener("input", () => ($("empty-note").hidden = true));
  // Puts a made-up scam message in the box and checks it, so you see what a check looks like.
  $("try-made-up").addEventListener("click", () => {
    $("message").value = msg(
      "sc_madeUp",
      "This is the fraud team at Anytown Bank. We stopped a strange payment on your card. To cancel it, reply right away with the 6-digit code we just texted you. Don't tell anyone at the branch, they may be in on it.",
    );
    check($("message").value);
  });
  // Clears the last message from the page and empties the box, ready for another one.
  $("check-another").addEventListener("click", () => {
    $("message").value = "";
    $("marked").replaceChildren();
    $("signs").replaceChildren();
    $("result").hidden = true;
    $("ask").hidden = false;
    $("message").focus();
  });

  $("before-sources").replaceChildren(...sourceLine([10, 20, 9]));
  $("now-sources").replaceChildren(...sourceLine([4]));
})();
