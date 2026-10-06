// The office training walkthrough: eight step cards, self-paced and offline. The engine's real detect() answers
// every reveal, the same rule the practice page follows, and nothing typed here, whether a reply, a checklist
// answer, or the name on the completion page, is stored or sent anywhere.
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
    const body = [stepHeading(), ...lines.map((l) => el("p", { className: "tw-text", textContent: l }))];
    if (source) {
      const a = el("a", { href, target: "_blank", rel: "noopener", textContent: source });
      body.push(el("p", { className: "hint tw-source" }, [a]));
    }
    $("tw-body").replaceChildren(...body);
  }

  // ---------- Step 2: Try it ----------
  function buildTry() {
    const t = state.try;
    const textarea = el("textarea", {
      id: "tw-try-text",
      rows: 3,
      value: t.text,
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

  function renderTryResult() {
    const box = $("tw-try-result");
    if (!box) return;
    const t = state.try;
    const children = [];
    if (t.notice) children.push(t.notice);
    if (t.sent)
      children.push(
        el("figure", { className: "chat" }, [
          el("figcaption", { className: "chat-from" }, [
            el("cite", { textContent: msg("tw_pretendAi", "A pretend AI chat") }),
          ]),
          el("blockquote", { className: "bubble", textContent: training.tryAiReply() }),
        ]),
      );
    if (t.explain) {
      children.push(el("p", { className: "tw-explain", role: "status", textContent: t.explain }));
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
      children.push(el("p", {}, [reset]));
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
        const ta = $("tw-try-text");
        if (ta) ta.value = state.try.text;
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
    if (info.active)
      body.push(
        el(
          "ul",
          { className: "list" },
          info.kinds.map((k) => el("li", { textContent: `${k.name}: ${k.response}` })),
        ),
      );
    $("tw-body").replaceChildren(...body);
  }

  // ---------- Step 4: Spot the leak ----------
  function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // Builds the "With Bandage on, Clotr can send..." line, the same one practice.js uses.
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

  function renderLeak() {
    if (state.leak.done) {
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
      return;
    }
    const l = state.leak.picks[state.leak.at];
    const answer = (id, label) => {
      const b = el("button", { id, className: "btn answer", type: "button", textContent: label });
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => answerLeak(l, id));
      return b;
    };
    const next = el("button", {
      id: "tw-leak-next",
      className: "btn primary",
      type: "button",
      hidden: true,
      textContent:
        state.leak.at === state.leak.picks.length - 1
          ? msg("tw_leakDone", "See how you did")
          : msg("pd_leakNext", "Next message"),
    });
    next.addEventListener("click", () => {
      state.leak.at++;
      if (state.leak.at >= state.leak.picks.length) state.leak.done = true;
      renderLeak();
    });
    $("tw-body").replaceChildren(
      stepHeading(),
      el("p", {
        className: "leak-count",
        textContent: msg("pd_leakCount", "$1 of $2", state.leak.at + 1, state.leak.picks.length),
      }),
      el("figure", { className: "typed" }, [
        el("figcaption", { textContent: msg("pd_typedInto", "Typed into an AI chat:") }),
        el("blockquote", { id: "tw-leak-text", textContent: l.text }),
      ]),
      el("fieldset", { className: "answers" }, [
        el("legend", { className: "visually-hidden", textContent: msg("pd_leakQuestion", "Would you send this?") }),
        answer("tw-send-it", msg("pd_sendIt", "I'd send it")),
        answer("tw-change-it", msg("pd_changeIt", "I'd change it first")),
      ]),
      el("div", { id: "tw-leak-reveal", role: "status" }),
      el("p", { className: "nav-inline" }, [next]),
    );
  }

  function answerLeak(l, choice) {
    for (const b of document.querySelectorAll("#tw-body .answer")) {
      b.setAttribute("aria-pressed", String(b.id === choice));
      b.disabled = true;
    }
    let found = [];
    try {
      found = detect(l.text);
    } catch {
      // never hold up the step
    }
    const reveal = $("tw-leak-reveal");
    if (found.length) {
      state.leak.private++;
      if (choice === "tw-change-it") state.leak.changed++;
      const n = found.reduce((sum, r) => sum + r.matches.length, 0);
      reveal.replaceChildren(
        el("div", { className: "leak-card found" }, [
          el("h3", {
            textContent:
              n === 1
                ? msg("pd_seesOne", "Clotr sees 1 detail here")
                : msg("pd_seesMany", "Clotr sees $1 details here", n),
          }),
          el(
            "ul",
            { className: "chips" },
            found.flatMap((r) =>
              r.matches.map((m) => el("li", { className: "chip-find", textContent: `${r.name} (${mask(m)})` })),
            ),
          ),
          el("p", { textContent: l.instead || bandageLine(l.text, found) }),
        ]),
      );
    } else {
      reveal.replaceChildren(
        el("div", { className: "leak-card none" }, [
          el("p", { textContent: msg("pd_seesNothing", "Clotr finds nothing private here. Fine to send.") }),
        ]),
      );
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
    for (const item of training.CHECKLIST) {
      const row = el("div", { className: "tw-check-item" }, [
        el("p", { className: "tw-check-q", textContent: item.q() }),
        el("p", { className: "hint", textContent: item.hint() }),
      ]);
      const choices = el("div", { className: "answers tw-check-answers" });
      for (const [val, label] of [
        ["yes", msg("tw_yes", "Yes")],
        ["no", msg("tw_no", "No")],
        ["unsure", msg("tw_unsure", "Not sure")],
      ]) {
        const b = el("button", { className: "btn answer", type: "button", textContent: label });
        b.setAttribute("aria-pressed", String(state.checklist[item.id] === val));
        b.addEventListener("click", () => {
          state.checklist[item.id] = val;
          buildChecklist();
        });
        choices.append(b);
      }
      row.append(choices);
      body.push(row);
    }
    $("tw-body").replaceChildren(...body);
  }

  // ---------- Step 6: Check AI's work ----------
  function markedAnswer(text, targets) {
    const found = targets.map((t) => ({ ...t, at: training.findTarget(text, t.text) })).filter((t) => t.at >= 0);
    found.sort((a, b) => a.at - b.at);
    const nodes = [];
    let pos = 0;
    for (const t of found) {
      if (t.at < pos) continue;
      if (t.at > pos) nodes.push(document.createTextNode(text.slice(pos, t.at)));
      const btn = el("button", { className: "flag-target", type: "button", textContent: t.text });
      btn.id = `tw-flag-${t.key}`;
      btn.dataset.key = t.key;
      btn.setAttribute("aria-pressed", "false");
      nodes.push(btn);
      pos = t.at + t.text.length;
    }
    if (pos < text.length) nodes.push(document.createTextNode(text.slice(pos)));
    return nodes;
  }

  function buildAccuracy() {
    const info = training.accuracyCheck(tax);
    const answerP = el(
      "p",
      { className: "tw-ai-answer" },
      markedAnswer(info.answer, [
        { key: "figure", text: info.figureText },
        { key: "citation", text: info.citationText },
        ...info.decoys.map((text, i) => ({ key: `decoy-${i}`, text })),
      ]),
    );
    const flags = state.accuracy;
    flags.decoys ||= {};
    const flagged = (key) =>
      key === "figure" ? flags.flagFigure : key === "citation" ? flags.flagCitation : !!flags.decoys[key];
    for (const btn of answerP.querySelectorAll(".flag-target")) {
      const key = btn.dataset.key;
      const show = () => {
        btn.setAttribute("aria-pressed", String(flagged(key)));
        btn.classList.toggle("flagged", flagged(key));
      };
      show();
      btn.addEventListener("click", () => {
        if (key === "figure") flags.flagFigure = !flags.flagFigure;
        else if (key === "citation") flags.flagCitation = !flags.flagCitation;
        else flags.decoys[key] = !flags.decoys[key];
        show();
      });
    }
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
    if (state.accuracy.revealed) {
      const gotFigure = state.accuracy.flagFigure;
      const gotCitation = state.accuracy.flagCitation;
      $("tw-acc-reveal").replaceChildren(
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
        ...info.decoys
          .filter((_, i) => flags.decoys[`decoy-${i}`])
          .map((text) =>
            el("p", {
              className: "tw-missed",
              textContent: msg("tw_accDecoyFlagged", "“$1” was right as written.", text),
            }),
          ),
        el("p", { textContent: msg("tw_accCorrectFigure", "The real total: $1", info.correctFigure) }),
        el("p", { className: "tw-explain", textContent: info.explain }),
      );
    }
  }

  // ---------- Step 7: the check ----------
  function buildQuiz() {
    const qs = training.quizQuestions(tax);
    const q = qs[state.quiz.at];
    const answered = state.quiz.answers[q.id];
    const opts = el("div", { className: "tw-quiz-options" });
    for (const o of q.options) {
      const b = el("button", { className: "btn answer tw-quiz-option", type: "button", textContent: o.text() });
      b.setAttribute("aria-pressed", String(answered === o.id));
      if (answered) {
        b.disabled = true;
        if (o.id === answered) b.classList.add(o.correct ? "tw-correct" : "tw-missed");
      }
      b.addEventListener("click", () => {
        state.quiz.answers[q.id] = o.id;
        buildQuiz();
      });
      opts.append(b);
    }
    const body = [
      stepHeading(),
      el("p", { className: "step", textContent: msg("tw_quizOf", "Question $1 of $2", state.quiz.at + 1, qs.length) }),
      el("p", { className: "tw-quiz-q", textContent: q.q() }),
      opts,
    ];
    if (answered) {
      const chosen = q.options.find((o) => o.id === answered);
      body.push(
        el("p", {
          className: chosen.correct ? "tw-correct" : "tw-missed",
          role: "status",
          textContent: chosen.correct ? msg("tw_quizRight", "Right.") : msg("tw_quizWrong", "Not quite."),
        }),
        el("p", { className: "tw-explain", textContent: q.explain() }),
      );
    }
    $("tw-body").replaceChildren(...body);
    const isLast = state.quiz.at === qs.length - 1;
    customNext = answered
      ? () => {
          if (!isLast) {
            state.quiz.at++;
            buildQuiz();
          } else advanceStep();
        }
      : null;
    $("tw-next").disabled = !answered;
    $("tw-next").textContent = !answered
      ? msg("tw_next", "Next")
      : isLast
        ? msg("tw_quizSeeScore", "See your score")
        : msg("tw_quizNext", "Next question");
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
    const qs = training.quizQuestions(tax);
    const score = training.scoreQuiz(qs, state.quiz.answers);
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
          textContent: msg("tw_scoreLine", "Check score: $1 of $2", String(score), String(qs.length)),
        }),
        el("p", { textContent: msg("tw_topicsLine", "Topics covered:") }),
        el(
          "ul",
          { id: "tw-done-topics" },
          training.STEP_TITLES.slice(0, 7).map((t) => el("li", { textContent: t() })),
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
      ...Array.from({ length: TOTAL }, (_, i) => el("span", { className: i <= step ? "done" : "" })),
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
    const ta = $("tw-try-text");
    if (ta) ta.value = "";
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
