// The practice page. You answer six made-up scam messages one at a time, each reply checked by the real
// engine on this computer, and the page shows what Clotr would show on a real chat, then a safer reply and
// why. After that comes Spot the leak: ten messages typed into an AI chat, where you decide whether you'd
// send them. Replies and answers live only in this page's memory and are gone when it closes; nothing here
// is stored, sent to the rest of Clotr, or logged.
"use strict";

const { detect, redact, mask, msg, practiceNotice, practice } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// The reply's quote marks, the language's own.
const quoted = (text) => msg("pd_quoted", "“$1”", text);

// ---------- Round 1: the drills ----------

const DRILLS = practice.drills;
// Each drill's reply while the page is open, and whether it was checked (Back and Next show it again).
const answers = DRILLS.map(() => ({ reply: "", checked: false }));
let at = 0;

// The sender's first letter, for the round picture beside the message.
function initialOf(from) {
  return from
    .replace(/^[^\p{L}]+/u, "")
    .charAt(0)
    .toUpperCase();
}

function showDrill(index) {
  at = index;
  const drill = DRILLS[index];
  $("drill").hidden = false;
  $("leak").hidden = true;
  $("title").textContent = msg("pd_title", "What would you reply?");
  $("drill-step").textContent = msg(
    "pd_step",
    "Drill $1 of $2: a message from $3",
    index + 1,
    DRILLS.length,
    drill.who,
  );
  const segments = DRILLS.map((_, each) => el("span", { className: each <= index ? "done" : "" }));
  $("segments").replaceChildren(...segments);
  $("drill-initial").textContent = initialOf(drill.from);
  $("drill-from").textContent = drill.from;
  $("drill-message").textContent = drill.message;
  $("reply").value = answers[index].reply;
  $("back").hidden = index === 0;
  if (answers[index].checked) {
    reveal();
    return;
  }
  $("reveal").replaceChildren();
  $("next").hidden = true;
}

// What Clotr would show on a real chat for this reply: the engine's own notice.
function foundParts(found) {
  const label = el("p", {
    className: "reveal-label",
    textContent: msg("pd_wouldShow", "What Clotr would show on a real chat"),
  });
  // A reply goes to a person, so the notice says what it says on an email or chat app.
  const notice = practiceNotice(found, {
    everyday: true,
    onHide: () => {
      $("reply").value = redact($("reply").value, found);
      reveal(true);
      $("reply").focus();
    },
    onLeave: () => {},
  });
  return [label, notice];
}

// A bare number the drill asked for: Clotr stays quiet, and the drill says why.
function bareParts(drill) {
  const quiet = el("p", {
    className: "reveal-none",
    textContent: msg(
      "pd_nothingBare",
      "Clotr would stay quiet here too: a bare number alone never warns in a real chat, so it doesn't cry wolf on someone's harmless one.",
    ),
  });
  return [quiet, el("p", { className: "reveal-hint", textContent: drill.bareAsk.text })];
}

// Nothing found. `after` is the wording once Clot this leak has covered the reply.
function nothingParts(after) {
  const nothing = after
    ? msg("pd_nothingNow", "Nothing in your reply now that Clotr knows scammers ask for.")
    : msg("pd_nothing", "Nothing in your reply that Clotr knows scammers ask for.");
  const hint = msg("pd_nothingHint", "Clotr only sees what's in your words, so compare your reply with the one below.");
  return [
    el("p", { className: "reveal-none", textContent: nothing }),
    el("p", { className: "reveal-hint", textContent: hint }),
  ];
}

function saferReply(drill) {
  return el("div", { className: "safer" }, [
    el("h3", { textContent: msg("pd_safer", "A safer reply") }),
    el("p", { className: "safer-quote", textContent: quoted(drill.safer) }),
    el("p", { className: "safer-why", textContent: drill.why }),
  ]);
}

// Shows what Clotr would show on a real chat for this reply, using the engine's real answer, then the
// safer reply. `after` switches to the wording used once Clot this leak has covered the reply.
function reveal(after = false) {
  const drill = DRILLS[at];
  const text = $("reply").value;
  answers[at] = { reply: text, checked: true };
  let shown;
  try {
    const found = text.trim() ? detect(text) : [];
    // A bare number, with nothing else around it, shaped like what this drill's message just asked for.
    // Clotr stays quiet on a bare number alone on a real chat too, but since this drill did ask for it, it
    // says so itself rather than let "nothing found" read as "that was fine".
    const bare = !found.length && drill.bareAsk && text.trim() && drill.bareAsk.shape(text);
    if (found.length) shown = foundParts(found);
    else if (bare) shown = bareParts(drill);
    else shown = nothingParts(after);
  } catch {
    // Never break the page: say so, and the safer reply still shows.
    shown = [el("p", { className: "reveal-none", textContent: msg("pd_failed", "Clotr couldn't check this reply.") })];
  }
  $("reveal").replaceChildren(...shown, saferReply(drill));
  const last = at === DRILLS.length - 1;
  $("next").textContent = last
    ? msg("pd_nextLeak", "Next: Spot the leak")
    : msg("pd_next", "Next drill: $1", DRILLS[at + 1].who);
  $("next").hidden = false;
}

$("check").addEventListener("click", () => reveal());
$("reply").addEventListener("keydown", (event) => {
  // Enter checks the reply, Shift+Enter starts a new line; not while a language's input method is composing.
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  reveal();
});
$("reply").addEventListener("input", () => {
  answers[at].reply = $("reply").value;
});
$("use-made-up").addEventListener("click", () => {
  $("reply").value = DRILLS[at].reply;
  answers[at].reply = DRILLS[at].reply;
  $("reply").focus();
});
$("next").addEventListener("click", () => {
  const moreDrills = at < DRILLS.length - 1;
  if (!moreDrills) {
    startLeak();
    return;
  }
  showDrill(at + 1);
  $("reply").focus();
});
$("back").addEventListener("click", () => {
  if (at > 0) showDrill(at - 1);
});

// ---------- Round 2: Spot the leak ----------
// Ten made-up messages typed into an AI chat, picked at random each time, five with something private and
// five without. You say what you'd do, then see what Clotr finds in the message, live and masked, and what
// the AI needs instead. Only the score at the end sums it up; nothing about the answers is kept.

const ROUND = 10;
const leak = { picks: [], at: 0, private: 0, changed: 0 };

function shuffle(list) {
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function startLeak() {
  const withFinds = practice.leaks.filter((pick) => pick.finds.length);
  const withoutFinds = practice.leaks.filter((pick) => !pick.finds.length);
  const half = ROUND / 2;
  Object.assign(leak, {
    picks: shuffle([...shuffle(withFinds).slice(0, half), ...shuffle(withoutFinds).slice(0, half)]),
    at: 0,
    private: 0,
    changed: 0,
  });
  $("drill").hidden = true;
  $("leak").hidden = false;
  $("leak-end").hidden = true;
  $("title").textContent = msg("pd_titleLeak", "Spot the leak");
  showLeak();
  $("leak-title").focus();
}

function leakAnswerButton(pick, id, label) {
  const button = el("button", { id, className: "btn answer", type: "button", textContent: label });
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => answerLeak(pick, id));
  return button;
}

function leakNextButton() {
  const isLast = leak.at === leak.picks.length - 1;
  const next = el("button", {
    id: "leak-next",
    className: "btn primary",
    type: "button",
    hidden: true,
    textContent: isLast ? msg("pd_leakDone", "See how you did") : msg("pd_leakNext", "Next message"),
  });
  next.addEventListener("click", () => {
    leak.at++;
    const moreMessages = leak.at < leak.picks.length;
    if (!moreMessages) {
      endLeak();
      return;
    }
    showLeak();
    $("leak-title").focus();
  });
  return next;
}

function showLeak() {
  const pick = leak.picks[leak.at];
  $("leak-count").hidden = false;
  $("leak-count").textContent = msg("pd_leakCount", "$1 of $2", leak.at + 1, leak.picks.length);
  const next = leakNextButton();
  $("leak-body").replaceChildren(
    el("figure", { className: "typed" }, [
      el("figcaption", { textContent: msg("pd_typedInto", "Typed into an AI chat:") }),
      el("blockquote", { id: "leak-text", textContent: pick.text }),
    ]),
    el("fieldset", { className: "answers" }, [
      el("legend", { className: "visually-hidden", textContent: msg("pd_leakQuestion", "Would you send this?") }),
      leakAnswerButton(pick, "send-it", msg("pd_sendIt", "I'd send it")),
      leakAnswerButton(pick, "change-it", msg("pd_changeIt", "I'd change it first")),
    ]),
    el("div", { id: "leak-reveal", role: "status" }),
    el("p", { className: "nav" }, [next]),
  );
}

// What Clotr sees in the message: a count, each find masked, and what the AI needs instead.
function leakFoundCard(pick, found) {
  const count = found.reduce((sum, result) => sum + result.matches.length, 0);
  const heading =
    count === 1
      ? msg("pd_seesOne", "Clotr sees 1 detail here")
      : msg("pd_seesMany", "Clotr sees $1 details here", count);
  const chips = found.flatMap((result) =>
    result.matches.map((match) =>
      el("li", { className: "chip-find", textContent: `${result.name} (${mask(match, result.id)})` }),
    ),
  );
  return el("div", { className: "leak-card found" }, [
    el("h3", { textContent: heading }),
    el("ul", { className: "chips" }, chips),
    el("p", { textContent: pick.instead || bandageLine(pick.text, found) }),
  ]);
}

// Gives the chosen answer its look, a ring and a tint plus aria-pressed, then reveals the engine's real
// finds.
function answerLeak(pick, choice) {
  for (const button of document.querySelectorAll("#leak-body .answer")) {
    button.setAttribute("aria-pressed", String(button.id === choice));
    button.disabled = true;
  }
  let found = [];
  try {
    found = detect(pick.text);
  } catch {
    $("leak-reveal").replaceChildren(
      el("p", { className: "leak-card", textContent: msg("pd_leakFailed", "Clotr couldn't check this message.") }),
    );
  }
  if (found.length) {
    leak.private++;
    if (choice === "change-it") leak.changed++;
    $("leak-reveal").replaceChildren(leakFoundCard(pick, found));
  } else if (!$("leak-reveal").childElementCount) {
    const fine = msg("pd_seesNothing", "Clotr finds nothing private here. Fine to send.");
    $("leak-reveal").replaceChildren(el("div", { className: "leak-card none" }, [el("p", { textContent: fine })]));
  }
  $("leak-next").hidden = false;
  $("leak-next").focus();
}

// Builds the "With Bandage on, Clotr can send..." line using the labels Bandage would really send.
function bandageLine(text, found) {
  const labels = practice.coverLabels(text, found);
  const list =
    labels.length > 1
      ? `${labels.slice(0, -1).join(", ")}${msg("pd_and", " and ")}${labels[labels.length - 1]}`
      : labels[0];
  return msg(
    "pd_bandage",
    "With Bandage on, Clotr can send $1 instead, and put your details back in the AI's answer.",
    list,
  );
}

function endLeak() {
  $("leak-body").replaceChildren();
  $("leak-count").hidden = true;
  $("leak-score").textContent = msg(
    "pd_score",
    "You'd have changed $1 of the $2 that had something private.",
    leak.changed,
    leak.private,
  );
  $("leak-cheer").textContent =
    leak.changed === leak.private
      ? msg("pd_allSpotted", "You spotted every one.")
      : msg(
          "pd_clotrIsThere",
          "That's what Clotr is for: on a real AI chat, it warns before details like these go out.",
        );
  $("leak-end").hidden = false;
  $("leak-score").focus();
}

$("leak-again").addEventListener("click", startLeak);
$("leak-back").addEventListener("click", () => showDrill(DRILLS.length - 1));

// ---------- Leaving the page ----------

// Empties the reply whenever the page is hidden, the same as the vault page, so details typed here never
// end up in the browser's own restore data after a crash or a Back/Forward.
window.addEventListener("pagehide", () => {
  $("reply").value = "";
  for (const answer of answers) answer.reply = "";
});

showDrill(0);
