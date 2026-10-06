// The office training walkthrough's content. It's a self-paced, offline walkthrough built on the practice
// drills' sandbox, so nothing here is a page, nothing stores or sends anything, and every "what Clotr finds"
// moment runs the real engine on this computer. This file is just pure data and small pure functions, which
// lets tests/training.test.js exercise it without a page; training.js builds the actual DOM from it.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;

  // Tax offices, on the `tax_office` team preset, get the IRS line and client-flavoured wording; everyone
  // else gets the same walkthrough with neutral wording. `forParam` reads the page's own `?for=tax`, for
  // someone trying the walkthrough before any policy applies.
  function isTaxMode({ policyPreset = "", forParam = "" } = {}) {
    return policyPreset === "tax_office" || forParam === "tax";
  }

  // ---------- Step 1: Why ----------
  const IRS_URL =
    "https://www.irs.gov/pub/opr-taxpros/issue-number-2026-19-introductory-guidelines-for-responsible-ai-use-in-federal-tax-practice.pdf";
  function whyLines(tax) {
    return tax
      ? {
          lines: [
            msg(
              "tw_why1Tax",
              "In June 2026, the IRS Office of Professional Responsibility asked tax offices to keep client data out of public AI tools, train staff on using them safely, vet the tools they use, and check AI's work before it goes out.",
            ),
            msg(
              "tw_why2Tax",
              "This walkthrough covers all four, in about fifteen minutes, and nothing you type in it is stored or sent anywhere.",
            ),
          ],
          source: msg(
            "tw_whySourceTax",
            "IRS Office of Professional Responsibility, Introductory Guidelines for Responsible AI Use in Federal Tax Practice (24 June 2026)",
          ),
          href: IRS_URL,
        }
      : {
          lines: [
            msg(
              "tw_why1",
              "Anything typed into an AI chat tool can leave your hands for good, so it's worth knowing what to keep out of one and how to check what it writes back.",
            ),
            msg(
              "tw_why2",
              "This walkthrough covers both, in about fifteen minutes, offline: nothing you type in it is stored or sent anywhere.",
            ),
          ],
          source: null,
          href: null,
        };
  }

  // ---------- Step 2: Try it ----------
  // A made-up Social Security number, following practice-data.js's own convention of never using a real one.
  // Tax mode only changes the instruction's wording; the number and Clotr's finding stay the same either way.
  const TRY_NUMBER = "219-09-9999";
  function tryInstruction(tax) {
    return tax
      ? msg(
          "tw_tryLeadTax",
          "Type this made-up client's Social Security number into the box below, the way you might without thinking: $1",
          TRY_NUMBER,
        )
      : msg(
          "tw_tryLead",
          "Type this made-up Social Security number into the box below, the way you might without thinking: $1",
          TRY_NUMBER,
        );
  }
  const tryScript = () => msg("tw_tryScript", "My number is $1, is that enough to confirm who I am?", TRY_NUMBER);
  // What the pretend AI says back once you send the number anyway: a generic, made-up reply that never
  // echoes the number itself.
  const tryAiReply = () => msg("tw_tryAiReply", "Sure, I've noted that down. What would you like help with next?");

  // ---------- Step 3: Your office's words ----------
  // With a team policy's own kinds, shows a made-up example per kind, never the real words or formats, the
  // same rule policy.html follows. Without a policy, it explains what an office can add instead.
  const RESPONSE_WORDS = {
    block: () => msg("pa_countBlock", "Ask before sending"),
    warn: () => msg("pa_countWarn", "Warn"),
    log: () => msg("pa_countLog", "Just count"),
  };
  function officeWordsDemo(kinds) {
    const list = Array.isArray(kinds) ? kinds : [];
    if (!list.length) {
      return {
        active: false,
        example: msg(
          "tw_wordsNone",
          "Your office hasn't added any of its own words yet. An admin can add a client's name, a file-number format, or anything else worth watching for, through your organization's own settings. Nobody outside your office ever sees the list, and Clotr turns each word into a scrambled code before it's ever compared against anything you type.",
        ),
      };
    }
    return {
      active: true,
      kinds: list.slice(0, 3).map((k) => ({
        name: k.name,
        response: (RESPONSE_WORDS[k.response] || RESPONSE_WORDS.warn)(),
      })),
      example: msg(
        "tw_wordsSome",
        "Your office has added $1 of its own. Here's a made-up example, never the real words: if a message named one, Clotr would catch it the same way it catches a Social Security number, without your office's list ever leaving this computer.",
        String(list.length),
      ),
    };
  }

  // ---------- Step 4: Spot the leak ----------
  // Reuses five of practice-data.js's Spot-the-leak messages, picked for tax-office flavour where it exists:
  // a Social Security number on a tax form, a direct deposit form, a landlord letter with an address and
  // phone number, and two with nothing private. Reusing their ids keeps one engine answer for both pages.
  const LEAK_IDS = ["tax", "deposit", "landlord", "team", "dinner"];
  function leakPicks(leaks) {
    return (Array.isArray(leaks) ? leaks : []).filter((l) => LEAK_IDS.includes(l.id));
  }

  // ---------- Step 5: Is this AI tool set up safely? ----------
  // Privacy Check-up isn't built yet, so this is plain questions with no links instead. Each is "to think
  // about", not scored.
  const CHECKLIST = [
    {
      id: "training",
      q: () => msg("tw_checkTraining", "Does it use your chats to train its AI, and can that be turned off?"),
      hint: () =>
        msg(
          "tw_checkTrainingHint",
          "Most AI tools have a setting for this. Turning it off usually only covers new chats, not ones you've already sent.",
        ),
    },
    {
      id: "kept",
      q: () => msg("tw_checkKept", "How long does it keep your chats, and can you delete one?"),
      hint: () =>
        msg(
          "tw_checkKeptHint",
          "A deleted chat usually leaves your history right away, but can still sit in the company's systems for a while after.",
        ),
    },
    {
      id: "business",
      q: () => msg("tw_checkBusiness", "Does it offer a business or team plan with stronger privacy terms?"),
      hint: () =>
        msg(
          "tw_checkBusinessHint",
          "A business plan can come with a written agreement about how your data is used, which a personal account usually doesn't have.",
        ),
    },
  ];

  // ---------- Step 6: Check AI's work ----------
  // A sample AI answer with one wrong figure and one invented citation, so you have to find both. The
  // citation is made up for the exercise: it names a real-looking section that doesn't say what the answer
  // claims.
  // Finds where `target` stands on its own in `text`, so a number only matches when it isn't part of another
  // one, like the 2 in "W-2", and a clickable part never lights up inside another word.
  function findTarget(text, target) {
    if (!/^\d+$/.test(target)) return text.indexOf(target);
    const m = new RegExp(`(?<![\\w§.()-])${target}(?![\\w.()-])`).exec(text);
    return m ? m.index : -1;
  }

  function accuracyCheck(tax) {
    return tax
      ? {
          answer: msg(
            "tw_accAnswerTax",
            "Your client has 3 W-2 forms and 2 1099 forms, so that's 6 information returns to attach in total. This follows IRC §6724(d)(3), which sets the rule for counting a joint return's attachments.",
          ),
          figureText: "6",
          // Parts that are right as written, made clickable and styled just like the two wrong ones so the
          // styling alone can't give the answer away. Each must appear on its own in the answer text.
          decoys: ["3", "2", msg("tw_accDecoyTax", "a joint return's attachments")],
          correctFigure: msg("tw_accFigureTax", "5 (3 W-2s + 2 1099s)"),
          citationText: "IRC §6724(d)(3)",
          explain: msg(
            "tw_accExplainTax",
            "3 and 2 add up to 5, not 6. IRC §6724(d)(3) doesn't exist for this: §6724 covers penalties for incorrect information returns, nothing to do with counting a joint return's attachments. An AI can state a wrong figure or a citation that doesn't exist, and sound sure either way.",
          ),
        }
      : {
          answer: msg(
            "tw_accAnswer",
            "23 people signed in and 19 filled in the form, so 42 people took part in total. This matches the usual rate described in the 2024 Workplace Participation Standard, section 4.2.",
          ),
          figureText: "42",
          decoys: ["23", "19", msg("tw_accDecoy", "the usual rate")],
          correctFigure: msg("tw_accFigure", "23 (not 42: the 19 who filled in the form are part of the 23)"),
          // The exact phrase as it appears inside `answer`, so it can be found and marked clickable there.
          // This needs to be translated to match whatever wording `tw_accAnswer`'s Spanish entry actually uses.
          citationText: msg("tw_accCitation", "2024 Workplace Participation Standard, section 4.2"),
          explain: msg(
            "tw_accExplain",
            "23 and 19 don't add to 42 here: the 19 are part of the 23 who signed in, so the total is 23. The “2024 Workplace Participation Standard” doesn't exist. An AI can state a wrong figure or a citation that doesn't exist, and sound sure either way.",
          ),
        };
  }

  // ---------- Step 7: the check ----------
  // Five questions, one at a time, each explained right away. Tax-flavoured wording only shows up where a
  // client would really appear, so the underlying questions stay the same either way.
  function quizQuestions(tax) {
    return [
      {
        id: "q1",
        q: () =>
          tax
            ? msg(
                "tw_q1Tax",
                "Which of these is fine to type into an AI chat tool your office hasn't approved for client information?",
              )
            : msg(
                "tw_q1",
                "Which of these is fine to type into an AI chat tool that isn't approved for personal details?",
              ),
        options: [
          {
            id: "a",
            text: () =>
              tax
                ? msg("tw_q1aTax", "My client's Social Security number is 123-45-6789, which credits might apply?")
                : msg("tw_q1a", "My Social Security number is 123-45-6789, which credits might apply?"),
            correct: false,
          },
          {
            id: "b",
            text: () =>
              msg("tw_q1b", "A married couple filing jointly, two children under 17, which credits might apply?"),
            correct: true,
          },
          {
            id: "c",
            text: () =>
              tax
                ? msg("tw_q1cTax", "My client's bank account number is 123456789012, does this look right?")
                : msg("tw_q1c", "My bank account number is 123456789012, does this look right?"),
            correct: false,
          },
        ],
        explain: () =>
          msg(
            "tw_q1Explain",
            "(b) asks the same question with no personal details. (a) has a Social Security number, (c) a bank account number.",
          ),
      },
      {
        id: "q2",
        q: () => msg("tw_q2", "You're typing in an AI chat and Clotr warns about a date of birth. What do you do?"),
        options: [
          {
            id: "a",
            text: () => msg("tw_q2a", "Send it anyway. The AI company doesn't keep chats."),
            correct: false,
          },
          {
            id: "b",
            text: () => msg("tw_q2b", "Take the detail out, or check with whoever set your rules first."),
            correct: true,
          },
          { id: "c", text: () => msg("tw_q2c", "Pause Clotr on that site so it stops warning."), correct: false },
        ],
        explain: () =>
          msg(
            "tw_q2Explain",
            "(b) keeps the detail out of the chat. Whether a company keeps chats depends on the tool and its own settings (step 5's checklist), and pausing Clotr only removes the reminder.",
          ),
      },
      {
        id: "q3",
        q: () =>
          tax
            ? msg(
                "tw_q3Tax",
                "You typed a client's full name into an AI chat and Clotr didn't warn. What does that mean?",
              )
            : msg("tw_q3", "You typed someone's full name into an AI chat and Clotr didn't warn. What does that mean?"),
        options: [
          { id: "a", text: () => msg("tw_q3a", "The message has nothing private in it."), correct: false },
          {
            id: "b",
            text: () =>
              msg(
                "tw_q3b",
                "Nothing on its own: Clotr only knows a name if it's been added to a list, and it can still miss things.",
              ),
            correct: true,
          },
          { id: "c", text: () => msg("tw_q3c", "The AI tool has been approved."), correct: false },
        ],
        explain: () =>
          msg(
            "tw_q3Explain",
            "(b): Clotr finds numbers, dates and addresses by their shape, but a name only when it's on a list someone added. No warning isn't the same as nothing private.",
          ),
      },
      {
        id: "q4",
        q: () =>
          msg("tw_q4", "An AI tool drafts something that cites a rule and adds up two figures. Before it goes out:"),
        options: [
          { id: "a", text: () => msg("tw_q4a", "Send it. AI is good at citations and sums."), correct: false },
          {
            id: "b",
            text: () => msg("tw_q4b", "Read the citation yourself, and check every figure against the real numbers."),
            correct: true,
          },
          { id: "c", text: () => msg("tw_q4c", "Ask the AI tool whether it's sure."), correct: false },
        ],
        explain: () =>
          msg(
            "tw_q4Explain",
            "(b): an AI can state a wrong figure or a citation that doesn't exist, and sound sure either way. The person who sends the work checks it, the way step 6 just did.",
          ),
      },
      {
        id: "q5",
        q: () =>
          tax
            ? msg(
                "tw_q5Tax",
                "A client's information went into an AI tool that isn't approved for it. What happens next?",
              )
            : msg("tw_q5", "Personal information went into an AI tool that isn't approved for it. What happens next?"),
        options: [
          { id: "a", text: () => msg("tw_q5a", "Nothing, if no harm seems done."), correct: false },
          {
            id: "b",
            text: () =>
              tax
                ? msg("tw_q5bTax", "Tell the coordinator the same day, so the office can follow its plan.")
                : msg("tw_q5b", "Tell whoever is responsible the same day, so it can be dealt with."),
            correct: true,
          },
          { id: "c", text: () => msg("tw_q5c", "Delete the chat and don't mention it."), correct: false },
        ],
        explain: () =>
          msg(
            "tw_q5Explain",
            "(b): a plan's mistakes clause says who to tell and when. Deleting the chat doesn't take back what was already sent.",
          ),
      },
    ];
  }

  // Out of 5, used by the quiz step and the completion page. `answers`: { [questionId]: optionId }.
  function scoreQuiz(questions, answers) {
    return questions.reduce(
      (n, q) => n + (answers[q.id] && q.options.find((o) => o.id === answers[q.id])?.correct ? 1 : 0),
      0,
    );
  }

  // ---------- Step 8: Completion ----------
  const STEP_TITLES = [
    () => msg("tw_s1Title", "Why this matters"),
    () => msg("tw_s2Title", "Try it"),
    () => msg("tw_s3Title", "Your office's words"),
    () => msg("tw_s4Title", "Spot the leak"),
    () => msg("tw_s5Title", "Is this AI tool set up safely?"),
    () => msg("tw_s6Title", "Check AI's work"),
    () => msg("tw_s7Title", "The check"),
    () => msg("tw_s8Title", "Completion"),
  ];

  globalThis.Clotr = {
    ...globalThis.Clotr,
    training: {
      isTaxMode,
      whyLines,
      TRY_NUMBER,
      tryInstruction,
      tryScript,
      tryAiReply,
      officeWordsDemo,
      LEAK_IDS,
      leakPicks,
      CHECKLIST,
      accuracyCheck,
      findTarget,
      quizQuestions,
      scoreQuiz,
      STEP_TITLES,
    },
  };
})();
