// The warning as Clotr's own pages show it for practice (the welcome page's Try it, the practice page). The
// same words as the real one (decide.js noticeWords), each find named with its value masked, drawn with plain
// elements, so the pages that teach it always say what a real chat would. Nothing is saved or sent from here.
// Classic script, loaded after patterns.js, detector.js and decide.js; adds Clotr.practiceNotice.
(() => {
  "use strict";

  const { msg, mask, noticeWords } = globalThis.Clotr;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // Who really asks for this, as in the real warning: a code a scammer asks for is named by what it is
  // ("Sign-in Code"), and the first kind or code listed gets its line, a question and its answer, under the lead. If
  // choosing them fails, the notice shows as before.
  function shownOf(found) {
    try {
      return globalThis.Clotr.asShown(found);
    } catch {
      return found;
    }
  }
  function firstAsk(found) {
    try {
      return globalThis.Clotr.whoAsks(found)[0] || null;
    } catch {
      return null;
    }
  }
  function askLine(found) {
    const ask = firstAsk(found);
    if (!ask) return null;
    const icon = el("span", { className: "ask-dot", textContent: "?" });
    icon.setAttribute("aria-hidden", "true");
    return el("p", { className: "try-ask" }, [icon, el("span", {}, [el("b", { textContent: ask.q }), ` ${ask.a}`])]);
  }

  // `found`: detect()'s results. `everyday`: the words for a message people read, else an AI chat's.
  // `onHide`: Hide it. `onEdit` (optional): Edit it, for going back to the message without Clotr changing it.
  // `onLeave` (optional): Leave it in, which then says what a real chat does with it.
  function practiceNotice(found, { everyday = false, onHide, onEdit = null, onLeave = null } = {}) {
    const shown = shownOf(found);
    const words = noticeWords(shown, { everyday });
    const items = shown
      .flatMap((r) => r.matches.map((m) => [el("b", { textContent: r.name }), ` (${mask(m)})`]))
      .flatMap((item, i) => (i ? [", ", ...item] : item));
    const line = askLine(found);
    const hide = el("button", { className: "btn primary", type: "button", textContent: msg("coverIt", "Hide it") });
    hide.addEventListener("click", () => onHide?.());
    const buttons = el("div", { className: "notice-buttons" }, [hide]);
    if (onEdit) {
      const edit = el("button", { className: "btn", type: "button", textContent: msg("editIt", "Edit it") });
      edit.addEventListener("click", () => onEdit());
      buttons.append(edit);
    }
    const notice = el("div", { className: "try-notice" }, [
      el("b", { className: "notice-title", textContent: msg("noticeTitle", "⚠️ Heads up") }),
      el("p", {}, [words.lead, ...items, words.tail]),
      ...(line ? [line] : []),
      buttons,
    ]);
    if (onLeave) {
      const leave = el("button", {
        className: "btn leave",
        type: "button",
        textContent: msg("leaveIt", "Leave it in"),
      });
      leave.addEventListener("click", () => {
        // On a real chat the notice steps aside and the message goes as it is: Clotr only warns by default.
        buttons.replaceWith(
          el("p", {
            className: "notice-left",
            textContent: msg(
              "pd_leftIn",
              "Left in. On a real chat, Clotr just warns by default: the message is still yours to send.",
            ),
          }),
        );
        onLeave();
      });
      buttons.append(leave);
    }
    return notice;
  }

  globalThis.Clotr = { ...globalThis.Clotr, practiceNotice };
})();
