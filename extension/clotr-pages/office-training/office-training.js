// The office training walkthrough: eight step cards, self-paced and offline. The engine's real detect()
// answers every reveal, the same rule the practice page follows, and nothing typed here, whether a reply,
// a checklist answer, or the name on the completion page, is stored or sent anywhere.
"use strict";

(() => {
  const { detect, redact, mask, msg, practiceNotice, practice, training } = globalThis.Clotr;
  const Sites = globalThis.ClotrSites;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  const TOTAL = training.STEP_TITLES.length;
  let step = 0;
  let tax = false;
  let policyKinds = [];
  let customNext = null; // when set, the main Next button calls this instead of advancing the step

  const state = {
    try: { text: "", notice: null, explain: "", sent: false },
    leak: { picks: [], at: 0, private: 0, changed: 0, done: false },
    checklist: {},
    accuracy: { flagFigure: false, flagCitation: false, decoys: {}, revealed: false },
    quiz: { at: 0, answers: {} },
    name: "",
  };

  function stepHeading() {
    return el("h2", {
      id: "tw-step-title",
      className: "step",
      tabIndex: -1,
      textContent: training.STEP_TITLES[step](),
    });
  }

  // ---------- Step 1: Why ----------
  function buildWhy() {
    const { lines, source, href } = training.whyLines(tax);
    const body = [stepHeading(), ...lines.map((line) => el("p", { className: "tw-text", textContent: line }))];
    if (source) {
      const link = el("a", { href, target: "_blank", rel: "noopener", textContent: source });
      body.push(el("p", { className: "hint tw-source" }, [link]));
    }
    $("tw-body").replaceChildren(...body);
  }

  // ---------- Step 2: Try it ----------
  function buildTry() {
    const textarea = el("textarea", {
      id: "tw-try-text",
      rows: 3,
      value: state.try.text,
      autocomplete: "off",
      spellcheck: false,
    });
    textarea.setAttribute("aria-label", msg("tw_yourMessage", "Your message"));
    textarea.addEventListener("input", () => {
      state.try.text = textarea.value;
    });
    const useBtn = el("button", {
      id: "tw-try-use",
      className: "link-button",
      type: "button",
      textContent: msg("tw_useExample", "Use the made-up example"),
    });
    useBtn.addEventListener("click", () => {
      textarea.value = training.tryScript();
      state.try.text = textarea.value;
      textarea.focus();
    });
    const sendBtn = el("button", {
      id: "tw-try-send",
      className: "btn primary",
      type: "button",
      textContent: msg("tw_send", "Send"),
    });
    sendBtn.addEventListener("click", () => {
      state.try.text = textarea.value;
      sendTry();
    });
    $("tw-body").replaceChildren(
      stepHeading(),
      el("p", { className: "tw-text", textContent: training.tryInstruction(tax) }),
      el("figure", { className: "chat" }, [
        el("figcaption", { className: "chat-from" }, [
          el("span", { className: "avatar", "aria-hidden": "true", textContent: "A" }),
          el("cite", { textContent: msg("tw_pretendAi", "A pretend AI chat") }),
          el("span", { className: "tag", textContent: msg("pd_madeUp", "made up") }),
        ]),
        el("blockquote", { className: "bubble", textContent: training.tryScript() }),
      ]),
      el("div", { className: "field" }, [
        el("label", { htmlFor: "tw-try-text", textContent: msg("tw_yourMessage", "Your message") }),
        textarea,
      ]),
      el("p", { className: "actions" }, [sendBtn, useBtn]),
      el("div", { id: "tw-try-result" }),
    );
    renderTryResult();
  }

  // "Start over": the step from the beginning, with the box empty.
  function startOverButton() {
    const reset = el("button", {
      id: "tw-try-reset",
      className: "link-button",
      type: "button",
      textContent: msg("tw_startOver", "Start over"),
    });
    reset.addEventListener("click", () => {
      state.try = { text: "", notice: null, explain: "", sent: false };
      buildTry();
      $("tw-try-text")?.focus();
    });
    return reset;
  }

  function renderTryResult() {
    const box = $("tw-try-result");
    if (!box) return;
    const tryState = state.try;
    const children = [];
    if (tryState.notice) children.push(tryState.notice);
    if (tryState.sent) {
      children.push(
        el("figure", { className: "chat" }, [
          el("figcaption", { className: "chat-from" }, [
            el("cite", { textContent: msg("tw_pretendAi", "A pretend AI chat") }),
          ]),
          el("blockquote", { className: "bubble", textContent: training.tryAiReply() }),
        ]),
      );
    }
    if (tryState.explain) {
      children.push(el("p", { className: "tw-explain", role: "status", textContent: tryState.explain }));
      children.push(el("p", {}, [startOverButton()]));
    }
    box.replaceChildren(...children);
  }

  function sendTry() {
    const text = state.try.text;
    let found = [];
    try {
      found = text.trim() ? detect(text) : [];
    } catch {
      /* never break the page: nothing found, the message would just go */
    }
    if (!found.length) {
      state.try.notice = null;
      state.try.sent = false;
      state.try.explain = msg(
        "tw_tryNothing",
        "Clotr finds nothing to catch here. Try the made-up example above to see a real warning.",
      );
      renderTryResult();
      return;
    }
    state.try.sent = false;
    state.try.explain = "";
    state.try.notice = practiceNotice(found, {
      everyday: false,
      onHide: () => {
        state.try.text = redact(state.try.text, found);
        const box = $("tw-try-text");
        if (box) box.value = state.try.text;
        state.try.notice = null;
        state.try.explain = msg(
          "tw_tryHideExplain",
          "Hidden. On a real chat, the AI would never see the number: Clotr swaps it for a label like this before anything is sent.",
        );
        renderTryResult();
      },
      onEdit: () => {
        state.try.notice = null;
        state.try.explain = msg(
          "tw_tryEditExplain",
          "Back to your message, unchanged. On a real chat, this is where you'd take the number out yourself before sending.",
        );
        renderTryResult();
        $("tw-try-text")?.focus();
      },
      onLeave: () => {
        state.try.notice = null;
        state.try.sent = true;
        state.try.explain = msg(
          "tw_tryLeaveExplain",
          "Sent. On a real chat, Clotr's warning never blocks a message by itself: sending it is always your choice.",
        );
        renderTryResult();
      },
    });
    renderTryResult();
  }

  // ---------- Step 3: Your office's words ----------
  function buildWords() {
    const info = training.officeWordsDemo(policyKinds);
    const body = [stepHeading(), el("p", { className: "tw-text", textContent: info.example })];
    if (info.active) {
      body.push(
        el(
          "ul",
          { className: "list" },
          info.kinds.map((kind) => el("li", { textContent: `${kind.name}: ${kind.response}` })),
        ),
      );
    }
    $("tw-body").replaceChildren(...body);
  }

  // ---------- Step 4: Spot the leak ----------
  function shuffle(list) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Builds the "With Bandage on, Clotr can send..." line, the same one clotr-pages/practice/practice.js uses.
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

  function buildLeak() {
    if (!state.leak.picks.length) {
      state.leak.picks = shuffle(training.leakPicks(practice.leaks));
      state.leak.at = 0;
      state.leak.private = 0;
      state.leak.changed = 0;
      state.leak.done = false;
    }
    renderLeak();
  }

  // The round's end: the score, and that nothing about it is kept.
  function showLeakScore() {
    $("tw-body").replaceChildren(
      stepHeading(),
      el("p", {
        className: "leak-score",
        tabIndex: -1,
        textContent: msg(
          "pd_score",
          "You'd have changed $1 of the $2 that had something private.",
          state.leak.changed,
          state.leak.private,
        ),
      }),
      el("p", { className: "leak-kept", textContent: msg("pd_keptNothing", "Nothing about your answers is kept.") }),
    );
  }

  function leakAnswerButton(pick, id, label) {
    const button = el("button", { id, className: "btn answer", type: "button", textContent: label });
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => answerLeak(pick, id));
    return button;
  }

  function leakNextButton() {
    const isLast = state.leak.at === state.leak.picks.length - 1;
    const next = el("button", {
      id: "tw-leak-next",
      className: "btn primary",
      type: "button",
      hidden: true,
      textContent: isLast ? msg("tw_leakDone", "See how you did") : msg("pd_leakNext", "Next message"),
    });
    next.addEventListener("click", () => {
      state.leak.at++;
      if (state.leak.at >= state.leak.picks.length) state.leak.done = true;
      renderLeak();
    });
    return next;
  }

  function renderLeak() {
    if (state.leak.done) {
      showLeakScore();
      return;
    }
    const pick = state.leak.picks[state.leak.at];
    const next = leakNextButton();
    $("tw-body").replaceChildren(
      stepHeading(),
      el("p", {
        className: "leak-count",
        textContent: msg("pd_leakCount", "$1 of $2", state.leak.at + 1, state.leak.picks.length),
      }),
      el("figure", { className: "typed" }, [
        el("figcaption", { textContent: msg("pd_typedInto", "Typed into an AI chat:") }),
        el("blockquote", { id: "tw-leak-text", textContent: pick.text }),
      ]),
      el("fieldset", { className: "answers" }, [
        el("legend", { className: "visually-hidden", textContent: msg("pd_leakQuestion", "Would you send this?") }),
        leakAnswerButton(pick, "tw-send-it", msg("pd_sendIt", "I'd send it")),
        leakAnswerButton(pick, "tw-change-it", msg("pd_changeIt", "I'd change it first")),
      ]),
      el("div", { id: "tw-leak-reveal", role: "status" }),
      el("p", { className: "nav-inline" }, [next]),
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

  function answerLeak(pick, choice) {
    for (const button of document.querySelectorAll("#tw-body .answer")) {
      button.setAttribute("aria-pressed", String(button.id === choice));
      button.disabled = true;
    }
    let found = [];
    try {
      found = detect(pick.text);
    } catch {
      // never hold up the step
    }
    const reveal = $("tw-leak-reveal");
    if (found.length) {
      state.leak.private++;
      if (choice === "tw-change-it") state.leak.changed++;
      reveal.replaceChildren(leakFoundCard(pick, found));
    } else {
      const fine = msg("pd_seesNothing", "Clotr finds nothing private here. Fine to send.");
      reveal.replaceChildren(el("div", { className: "leak-card none" }, [el("p", { textContent: fine })]));
    }
    $("tw-leak-next").hidden = false;
    $("tw-leak-next").focus();
  }

  // ---------- Step 5: Is this AI tool set up safely? ----------
  function buildChecklist() {
    const body = [
      stepHeading(),
      el("p", {
        className: "tw-text",
        textContent: msg(
          "tw_checkLead",
          "A few plain questions worth asking about any AI tool before you use it for more than idle chat. There's no score here.",
        ),
      }),
    ];
    for (const item of training.CHECKLIST) body.push(checklistRow(item));
    $("tw-body").replaceChildren(...body);
  }

  // One question with its Yes, No and Not sure buttons; the chosen one is pressed.
  function checklistRow(item) {
    const row = el("div", { className: "tw-check-item" }, [
      el("p", { className: "tw-check-q", textContent: item.q() }),
      el("p", { className: "hint", textContent: item.hint() }),
    ]);
    const choices = el("div", { className: "answers tw-check-answers" });
    const answers = [
      ["yes", msg("tw_yes", "Yes")],
      ["no", msg("tw_no", "No")],
      ["unsure", msg("tw_unsure", "Not sure")],
    ];
    for (const [value, label] of answers) {
      const button = el("button", { className: "btn answer", type: "button", textContent: label });
      button.setAttribute("aria-pressed", String(state.checklist[item.id] === value));
      button.addEventListener("click", () => {
        state.checklist[item.id] = value;
        buildChecklist();
      });
      choices.append(button);
    }
    row.append(choices);
    return row;
  }

  // ---------- Step 6: Check AI's work ----------
  // The AI's answer as text, with each target found in it turned into a button to flag it.
  function markedAnswer(text, targets) {
    const found = targets
      .map((target) => ({ ...target, at: training.findTarget(text, target.text) }))
      .filter((target) => target.at >= 0);
    found.sort((a, b) => a.at - b.at);
    const nodes = [];
    let place = 0;
    for (const target of found) {
      if (target.at < place) continue;
      if (target.at > place) nodes.push(document.createTextNode(text.slice(place, target.at)));
      const button = el("button", { className: "flag-target", type: "button", textContent: target.text });
      button.id = `tw-flag-${target.key}`;
      button.dataset.key = target.key;
      button.setAttribute("aria-pressed", "false");
      nodes.push(button);
      place = target.at + target.text.length;
    }
    if (place < text.length) nodes.push(document.createTextNode(text.slice(place)));
    return nodes;
  }

  function isFlagged(flags, key) {
    if (key === "figure") return flags.flagFigure;
    if (key === "citation") return flags.flagCitation;
    return Boolean(flags.decoys[key]);
  }

  // Each flag button shows whether it's flagged, and flips on a click.
  function wireFlag(button, flags) {
    const key = button.dataset.key;
    function show() {
      button.setAttribute("aria-pressed", String(isFlagged(flags, key)));
      button.classList.toggle("flagged", isFlagged(flags, key));
    }
    show();
    button.addEventListener("click", () => {
      if (key === "figure") flags.flagFigure = !flags.flagFigure;
      else if (key === "citation") flags.flagCitation = !flags.flagCitation;
      else flags.decoys[key] = !flags.decoys[key];
      show();
    });
  }

  // After "Check my answers": what was found and missed, any right words flagged, and the real total.
  function accuracyReveal(info, flags) {
    const gotFigure = state.accuracy.flagFigure;
    const gotCitation = state.accuracy.flagCitation;
    const decoysFlagged = info.decoys
      .filter((_, index) => flags.decoys[`decoy-${index}`])
      .map((text) =>
        el("p", {
          className: "tw-missed",
          textContent: msg("tw_accDecoyFlagged", "“$1” was right as written.", text),
        }),
      );
    return [
      el("p", {
        className: gotFigure ? "tw-correct" : "tw-missed",
        textContent: gotFigure
          ? msg("tw_accGotFigure", "You found the wrong figure.")
          : msg("tw_accMissedFigure", "You missed the wrong figure."),
      }),
      el("p", {
        className: gotCitation ? "tw-correct" : "tw-missed",
        textContent: gotCitation
          ? msg("tw_accGotCitation", "You found the made-up citation.")
          : msg("tw_accMissedCitation", "You missed the made-up citation."),
      }),
      ...decoysFlagged,
      el("p", { textContent: msg("tw_accCorrectFigure", "The real total: $1", info.correctFigure) }),
      el("p", { className: "tw-explain", textContent: info.explain }),
    ];
  }

  function buildAccuracy() {
    const info = training.accuracyCheck(tax);
    const answerP = el(
      "p",
      { className: "tw-ai-answer" },
      markedAnswer(info.answer, [
        { key: "figure", text: info.figureText },
        { key: "citation", text: info.citationText },
        ...info.decoys.map((text, index) => ({ key: `decoy-${index}`, text })),
      ]),
    );
    const flags = state.accuracy;
    flags.decoys ||= {};
    for (const button of answerP.querySelectorAll(".flag-target")) wireFlag(button, flags);
    const checkBtn = el("button", {
      id: "tw-acc-check",
      className: "btn primary",
      type: "button",
      textContent: msg("tw_accCheck", "Check my answers"),
    });
    checkBtn.addEventListener("click", () => {
      state.accuracy.revealed = true;
      buildAccuracy();
    });
    const body = [
      stepHeading(),
      el("p", {
        className: "tw-text",
        textContent: msg(
          "tw_accLead",
          "An AI wrote this answer. Before you read on, click the figure that's wrong and the citation that doesn't exist.",
        ),
      }),
      el("figure", { className: "typed" }, [answerP]),
      el("p", { className: "actions" }, [checkBtn]),
      el("div", { id: "tw-acc-reveal", role: "status" }),
    ];
    $("tw-body").replaceChildren(...body);
    if (state.accuracy.revealed) $("tw-acc-reveal").replaceChildren(...accuracyReveal(info, flags));
  }

  // ---------- Step 7: the check ----------
  function quizNextWords(answered, isLast) {
    if (!answered) return msg("tw_next", "Next");
    if (isLast) return msg("tw_quizSeeScore", "See your score");
    return msg("tw_quizNext", "Next question");
  }

  // One question's options; once answered, they're locked and the chosen one marked right or not.
  function quizOptions(question, answered) {
    const options = el("div", { className: "tw-quiz-options" });
    for (const option of question.options) {
      const button = el("button", {
        className: "btn answer tw-quiz-option",
        type: "button",
        textContent: option.text(),
      });
      button.setAttribute("aria-pressed", String(answered === option.id));
      if (answered) {
        button.disabled = true;
        if (option.id === answered) button.classList.add(option.correct ? "tw-correct" : "tw-missed");
      }
      button.addEventListener("click", () => {
        state.quiz.answers[question.id] = option.id;
        buildQuiz();
      });
      options.append(button);
    }
    return options;
  }

  function buildQuiz() {
    const questions = training.quizQuestions(tax);
    const question = questions[state.quiz.at];
    const answered = state.quiz.answers[question.id];
    const body = [
      stepHeading(),
      el("p", {
        className: "step",
        textContent: msg("tw_quizOf", "Question $1 of $2", state.quiz.at + 1, questions.length),
      }),
      el("p", { className: "tw-quiz-q", textContent: question.q() }),
      quizOptions(question, answered),
    ];
    if (answered) {
      const chosen = question.options.find((option) => option.id === answered);
      body.push(
        el("p", {
          className: chosen.correct ? "tw-correct" : "tw-missed",
          role: "status",
          textContent: chosen.correct ? msg("tw_quizRight", "Right.") : msg("tw_quizWrong", "Not quite."),
        }),
        el("p", { className: "tw-explain", textContent: question.explain() }),
      );
    }
    $("tw-body").replaceChildren(...body);
    const isLast = state.quiz.at === questions.length - 1;
    customNext = null;
    if (answered) {
      customNext = () => {
        if (!isLast) {
          state.quiz.at++;
          buildQuiz();
        } else advanceStep();
      };
    }
    $("tw-next").disabled = !answered;
    $("tw-next").textContent = quizNextWords(answered, isLast);
  }

  // ---------- Step 8: Completion ----------
  function buildCompletion() {
    $("tw-next").hidden = true;
    const nameInput = el("input", { id: "tw-name", type: "text", autocomplete: "off", value: state.name });
    nameInput.addEventListener("input", () => {
      state.name = nameInput.value;
      renderCompletionPrintout();
    });
    const printBtn = el("button", {
      className: "btn primary",
      type: "button",
      textContent: msg("tw_printOrSave", "Print or save as PDF"),
    });
    printBtn.addEventListener("click", () => window.print());
    $("tw-body").replaceChildren(
      stepHeading(),
      el("div", { className: "field no-print" }, [
        el("label", {
          htmlFor: "tw-name",
          textContent: msg("tw_yourName", "Your name (for this printout only — it isn't saved)"),
        }),
        nameInput,
      ]),
      el("div", { id: "tw-completion-print" }),
      el("p", { className: "no-print" }, [printBtn]),
    );
    renderCompletionPrintout();
  }

  function renderCompletionPrintout() {
    const box = $("tw-completion-print");
    if (!box) return;
    const questions = training.quizQuestions(tax);
    const score = training.scoreQuiz(questions, state.quiz.answers);
    const dateStr = new Date().toLocaleDateString();
    box.replaceChildren(
      el("div", { className: "tw-done-card" }, [
        el("p", {
          id: "tw-done-name",
          className: "tw-done-name",
          textContent: state.name.trim() || msg("tw_noName", "(name not entered)"),
        }),
        el("p", { id: "tw-done-line", textContent: msg("tw_completedLine", "completed the Clotr AI walkthrough") }),
        el("p", { id: "tw-done-date", textContent: msg("tw_dateLine", "Date: $1", dateStr) }),
        el("p", {
          id: "tw-done-score",
          textContent: msg("tw_scoreLine", "Check score: $1 of $2", String(score), String(questions.length)),
        }),
        el("p", { textContent: msg("tw_topicsLine", "Topics covered:") }),
        el(
          "ul",
          { id: "tw-done-topics" },
          training.STEP_TITLES.slice(0, 7).map((title) => el("li", { textContent: title() })),
        ),
      ]),
    );
  }

  // ---------- The shell: progress, nav, step dispatch ----------
  const BUILDERS = [
    buildWhy,
    buildTry,
    buildWords,
    buildLeak,
    buildChecklist,
    buildAccuracy,
    buildQuiz,
    buildCompletion,
  ];

  function updateProgress() {
    $("tw-progress").replaceChildren(
      ...Array.from({ length: TOTAL }, (_, index) => el("span", { className: index <= step ? "done" : "" })),
    );
    $("tw-step-of").textContent = msg(
      "tw_stepOf",
      "Step $1 of $2: $3",
      String(step + 1),
      String(TOTAL),
      training.STEP_TITLES[step](),
    );
  }

  function renderStep() {
    $("tw-next").hidden = false;
    $("tw-next").disabled = false;
    $("tw-next").textContent = msg("tw_next", "Next");
    customNext = null;
    $("tw-back").hidden = step === 0;
    updateProgress();
    BUILDERS[step]();
    $("tw-step-title")?.focus();
  }

  function advanceStep() {
    if (step < TOTAL - 1) {
      step++;
      renderStep();
    }
  }

  $("tw-next").addEventListener("click", () => {
    if (customNext) customNext();
    else advanceStep();
  });
  $("tw-back").addEventListener("click", () => {
    if (step > 0) {
      step--;
      renderStep();
    }
  });

  // Details typed here never end up in the browser's restore data.
  window.addEventListener("pagehide", () => {
    state.try.text = "";
    state.name = "";
    const box = $("tw-try-text");
    if (box) box.value = "";
    const name = $("tw-name");
    if (name) name.value = "";
  });

  (async function init() {
    const search = new URLSearchParams(location.search).get("for") || "";
    let preset = "";
    try {
      const raw = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
      const policy = Sites.mergePolicy(raw);
      preset = policy.preset || "";
      policyKinds = Array.isArray(policy.kinds) ? policy.kinds : [];
    } catch {
      /* no managed policy to read: the neutral walkthrough */
    }
    tax = training.isTaxMode({ policyPreset: preset, forParam: search });
    document.title = msg("tw_pageTitle", "The AI walkthrough");
    renderStep();
  })();
})();
