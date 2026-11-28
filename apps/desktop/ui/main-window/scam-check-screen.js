// Clotr for Windows' "Is this a scam?" screen: the paste box from Clotr Antibody's own check.html,
// reached from Home and Protection. You paste a message you got and Clotr marks the warning signs
// scam-signs.js knows, each with what it means and where that advice comes from.
// sourceCites, SOURCES, SIGN_SOURCES and SIGNS are check.js's own words, kept in step by hand since
// they aren't part of the shared bundle.
// It reads the stored salt and vault to notice your own details the same way check.js does, but never
// writes to storage, sends anything, or logs anything. The pasted text lives on this screen until it's
// cleared or the app closes.
(() => {
  "use strict";

  const { msg, detect, fingerprint, scamSigns, scamHasLink, scamHasPhone, askSomeoneNoteForScamSigns } =
    globalThis.Clotr;

  // ---------- Page helpers ----------

  const $ = (id) => document.getElementById(id);

  function makeElement(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // ---------- Where each piece of advice comes from (check.js's own copy, see the header above) ----------

  const WHO = {
    ftc: msg("sc_srcFtc", "US FTC"),
    georgia: msg("sc_srcGeorgia", "Georgia Attorney General"),
    munster: msg("sc_srcMunster", "University of Münster"),
  };
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

  // Plain data for a sources line, so it's testable without the DOM: one entry per number, grouping
  // consecutive entries from the same source the way check.js's own sourceLine reads aloud.
  function sourceCites(numbers) {
    return numbers.map((n) => {
      const [who, title, href] = SOURCES[n];
      return { who: WHO[who], title, href };
    });
  }

  // ---------- The words for each sign (check.js's own copy) ----------

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

  function mineName(kind) {
    return MINE[kind] || msg("sc_mine_other", "one of your details");
  }

  // ---------- Your own details, by their fingerprints ----------

  // check.js's own mineIn, with the salt and vault passed in.

  const VAULT_WORDS = new Set(["my_name", "family_name", "employer", "watch_list"]);

  function mineIn(text, { salt, vault } = {}) {
    if (!salt || !vault?.length) return [];
    const values = vault.filter((entry) => entry && entry.kind === "value" && typeof entry.fp === "string");
    const out = [];
    for (const result of detect(text)) {
      for (const match of result.matches) {
        const ours =
          VAULT_WORDS.has(result.id) ||
          values.some((entry) => entry.type === result.id && entry.fp === fingerprint(salt, result.id, match));
        if (!ours) continue;
        for (let at = text.indexOf(match); at >= 0; at = text.indexOf(match, at + match.length)) {
          out.push({ kind: result.id, start: at, end: at + match.length });
        }
      }
    }
    return out;
  }

  // ---------- Grouping and wording (pure; the DOM-building below reads from these) ----------

  // Signs in GROUPS' order, each group left out when it found nothing.
  function groupedSigns(signs) {
    const out = [];
    for (const [group, title] of Object.entries(GROUPS)) {
      const inGroup = signs.filter((sign) => sign.group === group);
      if (inGroup.length) out.push({ group, title, signs: inGroup });
    }
    return out;
  }

  function quote(words) {
    const shortWords = words.length > 90 ? `${words.slice(0, 88)}…` : words;
    return msg("sc_quote", "“$1”", shortWords);
  }

  function wordsOf(text, sign) {
    if (sign.id === "pret_knows_you") return sign.kinds.map(mineName).join(", ");
    return sign.spans
      .slice(0, 3)
      .map((span) => quote(text.slice(span.start, span.end).replace(/\s+/g, " ")))
      .join(" · ");
  }

  // ---------- The DOM: building the result ----------

  function sourceLine(numbers) {
    const cites = sourceCites(numbers);
    const label = cites.length > 1 ? msg("sc_sources", "Sources:") : msg("sc_source", "Source:");
    const parts = [`${label} `];
    let lastWho = null;
    cites.forEach(({ who, title, href }, i) => {
      if (i) parts.push(who === lastWho ? " · " : "; ");
      if (who !== lastWho) parts.push(`${who}: `);
      parts.push(makeElement("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: title }));
      lastWho = who;
    });
    return parts;
  }

  // The message cut at every sign's edges, each piece with the ids of the signs that cover it. Neighbours
  // covered by the same signs join into one piece.
  function markedPieces(text, signs) {
    const edges = new Set([0, text.length]);
    for (const sign of signs) for (const span of sign.spans) edges.add(span.start).add(span.end);
    const cuts = [...edges].sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i];
      const end = cuts[i + 1];
      const ids = signs
        .filter((sign) => sign.spans.some((span) => span.start <= start && span.end >= end))
        .map((sign) => sign.id);
      const last = pieces.at(-1);
      if (last && last.ids.join() === ids.join()) last.end = end;
      else pieces.push({ start, end, ids });
    }
    return pieces;
  }

  // Plain text where no sign covers it, and a mark with the signs' names (also read aloud) where one does.
  function marked(text, signs) {
    const nodes = [];
    for (const { start, end, ids } of markedPieces(text, signs)) {
      const words = text.slice(start, end);
      if (!ids.length) {
        nodes.push(words);
        continue;
      }
      const names = ids.map((id) => SIGNS[id][0]).join(", ");
      nodes.push(makeElement("mark", { textContent: words, title: names }));
      nodes.push(makeElement("span", { className: "sr-only", textContent: ` (${names})` }));
    }
    return nodes;
  }

  function card(text, sign) {
    const [name, means] = SIGNS[sign.id];
    const wordsClass = sign.id === "pret_knows_you" ? "sign-words kinds" : "sign-words";
    const box = makeElement("article", { className: "sign-card" }, [
      makeElement("h4", { className: "sign-name", textContent: name }),
      makeElement("p", { className: wordsClass, textContent: wordsOf(text, sign) }),
      makeElement("p", { className: "sign-means", textContent: means }),
      makeElement("p", { className: "sign-source source" }, sourceLine(SIGN_SOURCES[sign.id])),
    ]);
    box.dataset.sign = sign.id;
    return box;
  }

  function signGroupSection(text, { title, signs }) {
    return makeElement("section", { className: "sign-group" }, [
      makeElement("h3", { textContent: title }),
      ...signs.map((sign) => card(text, sign)),
    ]);
  }

  // ---------- The screen itself ----------

  let view = { settings: {} };
  let labelled = false;
  let lang = "en";

  function labels() {
    if (labelled) return;
    labelled = true;
    $("title-scamcheck").textContent = msg("sc_title", "Is this a scam?");
    $("sc-lead").textContent = msg(
      "sc_lead",
      "Paste a message you got, a text, an email or a chat, and Clotr points out the warning signs it knows. It all stays on this computer, and nothing is kept.",
    );
    $("sc-box-label").textContent = msg("sc_box", "The message you got");
    $("sc-message").placeholder = msg("sc_hint", "Paste it here");
    $("sc-empty").textContent = msg("sc_empty", "Paste a message first.");
    $("sc-check").textContent = msg("sc_check", "Check it");
    $("sc-try").textContent = msg("sc_try", "Try a made-up message");
    $("sc-again").textContent = msg("sc_again", "Check another message");
    $("sc-failed").textContent = msg("sc_failed", "Clotr couldn't check this. Nothing was kept.");
    $("sc-never").textContent = msg(
      "sc_never",
      "Clotr reads only what you paste here, on this computer, and forgets it when you close this screen. It never says a message is fine: no list knows every scam.",
    );
    $("sc-before-title").textContent = msg("sc_beforeTitle", "Before you answer");
    $("sc-before-call").textContent = msg(
      "sc_beforeCall",
      "Don't use the phone number or link in the message. Call the company or person on a number you already know, like the one on your card or statement.",
    );
    $("sc-before-talk").textContent = msg("sc_beforeTalk", "Talk to someone you trust first.");
    $("sc-before-phone").textContent = msg("sc_hasPhone", "It has a phone number: don't call it to check.");
    $("sc-before-link").textContent = msg("sc_hasLink", "It has a link: don't use it to check.");
    $("sc-before-sources").replaceChildren(...sourceLine([10, 20, 9]));
    $("sc-ask-someone-title").textContent = msg("sc_askSomeoneTitle", "Ask someone first");
    $("sc-ask-someone-copy").textContent = msg("sc_askSomeoneCopy", "Copy the note");
    $("sc-teaser-title").textContent = msg("sc_title", "Is this a scam?");
    $("sc-teaser-lead").textContent = msg(
      "sc_lead",
      "Paste a message you got, a text, an email or a chat, and Clotr points out the warning signs it knows. It all stays on this computer, and nothing is kept.",
    );
    $("sc-teaser-link").textContent = msg("sc_check", "Check it");
    $("sc-prot-link").textContent = msg("sc_title", "Is this a scam?");
  }

  function foundTitle(count) {
    if (count === 1) return msg("sc_foundOne", "Clotr found 1 warning sign");
    return msg("sc_found", "Clotr found $1 warning signs", count);
  }

  function showResult(text) {
    const mine = mineIn(text, { salt: view.settings.salt, vault: view.settings.vault });
    const signs = scamSigns(text, { mine });
    const count = signs.length;

    // The heading: how many signs, or none
    $("sc-found").hidden = !count;
    $("sc-none").hidden = Boolean(count);
    $("sc-found-title").textContent = foundTitle(count);
    $("sc-none-title").textContent = msg("sc_none", "Clotr didn't find any of the signs it knows");
    $("sc-none-why").textContent = msg(
      "sc_noneWhy",
      "That doesn't tell you the message is real: scams change, and no list knows them all.",
    );

    // The marked message and a card per sign
    $("sc-marked").replaceChildren(...marked(text, signs));
    $("sc-signs").replaceChildren(...groupedSigns(signs).map((group) => signGroupSection(text, group)));

    // Before you answer, and the note to ask someone
    $("sc-before-phone-row").hidden = !scamHasPhone(text);
    $("sc-before-link-row").hidden = !scamHasLink(text);
    const signIds = signs.map((sign) => sign.id);
    const note = askSomeoneNoteForScamSigns(signIds, lang);
    $("sc-ask-someone-text").textContent = note;
    $("sc-ask-someone-copied").hidden = true;
    $("sc-ask-someone").hidden = !note;

    $("sc-ask").hidden = true;
    $("sc-result").hidden = false;
    const titleId = count ? "sc-found-title" : "sc-none-title";
    $(titleId).focus();
  }

  function check(text) {
    $("sc-failed").hidden = true;
    $("sc-empty").hidden = true;
    if (!text.trim()) {
      $("sc-empty").hidden = false;
      $("sc-message").focus();
      return;
    }
    try {
      showResult(text);
    } catch {
      $("sc-result").hidden = true;
      $("sc-ask").hidden = false;
      $("sc-failed").hidden = false;
    }
  }

  function draw(next, nextLang) {
    view = next;
    lang = nextLang === "es" ? "es" : "en";
    labels();
  }

  // ---------- Wiring the buttons ----------

  function checkAnother() {
    $("sc-message").value = "";
    $("sc-marked").replaceChildren();
    $("sc-signs").replaceChildren();
    $("sc-ask-someone-text").textContent = "";
    $("sc-ask-someone-copied").hidden = true;
    $("sc-result").hidden = true;
    $("sc-ask").hidden = false;
    $("sc-message").focus();
  }

  async function copyNote() {
    try {
      const ok = await globalThis.ClotrApp.call("copy_note", { text: $("sc-ask-someone-text").textContent });
      $("sc-ask-someone-copied").textContent = ok
        ? msg("sc_askSomeoneCopied", "Copied. Paste it wherever you want to show it.")
        : "";
      $("sc-ask-someone-copied").hidden = !ok;
    } catch {
      $("sc-ask-someone-copied").hidden = true;
    }
  }

  function wire() {
    $("sc-check").addEventListener("click", () => check($("sc-message").value));
    $("sc-message").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) check($("sc-message").value);
    });
    $("sc-message").addEventListener("input", () => ($("sc-empty").hidden = true));
    $("sc-try").addEventListener("click", () => {
      $("sc-message").value = msg(
        "sc_madeUp",
        "This is the fraud team at Anytown Bank. We stopped a strange payment on your card. To cancel it, reply right away with the 6-digit code we just texted you. Don't tell anyone at the branch, they may be in on it.",
      );
      check($("sc-message").value);
    });
    $("sc-again").addEventListener("click", checkAnother);
    $("sc-ask-someone-copy").addEventListener("click", copyNote);
  }

  globalThis.ClotrScamCheck = { draw, wire, wordsOf, sourceCites, groupedSigns, mineIn };
})();
