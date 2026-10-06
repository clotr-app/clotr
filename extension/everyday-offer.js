// The offer to use Clotr on email and chat apps too: the welcome page's card and, once after an
// update, the popup's. A tick box per listed app with nothing ticked for you, one button whose words say what it
// will do ("Switch on Gmail and Discord"), and one browser prompt for exactly the ticked apps.
// For Clotr's own pages, after patterns.js (msg) and sites.js (the list and the ask). Builds with createElement only.
// Stores one word, `everydayOffer: "done"`, once the button is pressed; which apps are on stays the browser's.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;
  const Sites = globalThis.ClotrSites;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // "Gmail", "Gmail and Discord", "Gmail, Slack and Discord", in the browser's language.
  function listOf(names) {
    try {
      return new Intl.ListFormat(chrome.i18n.getUILanguage(), { type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  function phraseOn(names) {
    if (!names.length) return "";
    if (names.length <= 2) return msg("ev_switchOnNames", "Switch on $1", listOf(names));
    return msg("ev_switchOnCount", "Switch on $1 apps", names.length);
  }

  function phraseOff(names) {
    if (!names.length) return "";
    if (names.length <= 2) return msg("ev_switchOffNames", "Switch off $1", listOf(names));
    return msg("ev_switchOffCount", "Switch off $1 apps", names.length);
  }

  // The button names what it will do, so people read it before the browser asks: new ticks switch apps on,
  // unticking an already-on app switches it off, and a click can do both at once.
  function buttonWords(addNames = [], removeNames = []) {
    const on = phraseOn(addNames);
    const off = phraseOff(removeNames);
    if (on && off) return `${on}, ${off.charAt(0).toLowerCase()}${off.slice(1)}`;
    return on || off || msg("ev_switchOn", "Switch on");
  }

  // Fills `card` (it holds #ev-groups, #ev-go and #ev-status) and wires it up. `onAnswer(yes, names)` runs once the
  // browser has answered. Resolves, once the card shows which apps are already on, to `{ tick(names) }`: the setup
  // page ticks a Tourniquet preset's own apps with it (the welcome page and the popup tick nothing for you).
  async function mount(card, { onAnswer } = {}) {
    const groups = card.querySelector("#ev-groups");
    const go = card.querySelector("#ev-go");
    const status = card.querySelector("#ev-status");
    const hint = card.querySelector("#ev-hint");
    const rows = new Map(); // app name → { box, tag }
    let on = new Set();
    let asking = false;
    let lastStatus = { text: "", done: false }; // kept so any re-render repaints it, not just the call that set it

    groups.replaceChildren(
      ...[
        ["email", msg("ev_email", "Email")],
        ["chat", msg("ev_chatApps", "Chat apps")],
      ].map(([kind, legend]) =>
        el("fieldset", { className: "ev-group" }, [
          el("legend", { textContent: legend }),
          ...Sites.EVERYDAY_SITES.filter((s) => s.kind === kind).map((s) => {
            const box = el("input", { type: "checkbox", value: s.name });
            const tag = el("span", { className: "ev-tag", textContent: msg("ev_on", "On"), hidden: true });
            rows.set(s.name, { box, tag });
            box.addEventListener("change", () => {
              if (asking) update();
              else say(""); // the last answer was about the ticks before this one
            });
            return el("label", { className: "ev-app" }, [box, el("span", { textContent: s.name }), tag]);
          }),
        ]),
      ),
    );

    // Apps newly ticked (to switch on) and apps unticked that were on.
    const added = () => [...rows].filter(([name, r]) => r.box.checked && !on.has(name)).map(([name]) => name);
    const removed = () => [...rows].filter(([name, r]) => !r.box.checked && on.has(name)).map(([name]) => name);
    function update() {
      const toAdd = added();
      const toRemove = removed();
      const nothingPending = !toAdd.length && !toRemove.length;
      // Settled (every On app still ticked, nothing new ticked): nothing to do, so no button.
      go.hidden = on.size > 0 && nothingPending;
      go.textContent = buttonWords(toAdd, toRemove);
      go.setAttribute("aria-disabled", String(nothingPending || asking));
      // The welcome page's "nothing is ticked for you" line stops being true once something is on; other
      // cards keep their own hint, which stays true either way.
      if (hint?.hasAttribute("data-hide-when-on")) hint.hidden = on.size > 0;
      // A stray permission event landing around the browser's answer (seen on Firefox) can trigger a
      // re-render here before or after the outcome message is set; repainting from the stored state each time
      // means that re-render can never leave the message blank by accident.
      status.textContent = lastStatus.text;
      status.classList.toggle("done", lastStatus.done);
    }
    function say(text, done = false) {
      lastStatus = { text, done };
      update();
    }
    // Apps the browser has granted show ticked and carry an On tag; an On app can still be unticked, to
    // ask the browser to give the site back.
    function setOn(names) {
      const now = new Set(names);
      for (const [name, { box, tag }] of rows) {
        const isOn = now.has(name);
        if (isOn) box.checked = true;
        else if (on.has(name)) box.checked = false; // it was on, and was switched off elsewhere
        box.parentElement.classList.toggle("on", isOn);
        tag.hidden = !isOn;
      }
      on = now;
      update();
    }
    async function refresh() {
      const { origins = [] } = await chrome.permissions.getAll();
      setOn(Sites.grantedEverydayApps(origins));
    }

    go.addEventListener("click", () => {
      if (asking) return;
      const toAdd = added();
      const toRemove = removed();
      if (!toAdd.length && !toRemove.length) {
        say(msg("ev_tickFirst", "Tick at least one app first."));
        [...rows.values()][0]?.box.focus();
        return;
      }
      // The ask comes first, in the click's own turn (sites.js says why). The offer counts as answered at once:
      // the popup may close as the browser's prompt opens. Giving a site back has no prompt, so it's asked for
      // here too rather than waited on.
      const asked = toAdd.length ? Sites.requestEverydayApps(toAdd) : Promise.resolve(true);
      const removing = toRemove.length ? Sites.removeEverydayApps(toRemove) : Promise.resolve(true);
      chrome.storage.local.set({ everydayOffer: "done" }).catch(() => {});
      asking = true;
      say("");
      Promise.all([asked, removing]).then(async ([yes, removedOk]) => {
        asking = false;
        const addFailed = toAdd.length && !yes;
        const removeFailed = toRemove.length && !removedOk;
        if (addFailed || removeFailed) {
          // The browser's own question can report one of these as added, then take it back, while it's still
          // open (seen on Firefox): that would leave its box stuck disabled once the real answer, No, is in.
          // The browser itself is always the last word, so ask it again now rather than trust that stray event.
          // A stray onAdded/onRemoved can also land right around this point and trigger its own re-render, but
          // the message lives in `lastStatus`, so none of that can leave the line blank.
          await refresh().catch(() => {});
        } else {
          const next = new Set(on);
          for (const name of toAdd) next.add(name);
          for (const name of toRemove) next.delete(name);
          setOn([...next]);
        }
        const parts = [];
        if (addFailed)
          parts.push(
            msg(
              "ev_refused",
              "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
            ),
          );
        else if (toAdd.length)
          parts.push(msg("ev_onFor", "✓ On for $1, in tabs you already have open too.", listOf(toAdd)));
        if (!removeFailed && toRemove.length)
          parts.push(
            msg("ev_offFor", "✓ Off for $1. The site keeps working, just without Clotr there.", listOf(toRemove)),
          );
        say(parts.join(" "), !addFailed && !removeFailed);
        onAnswer?.(yes, toAdd);
      });
    });

    // Switched on or off somewhere else (Settings, the browser's own page) while this is open: show it.
    chrome.permissions.onAdded?.addListener(() => refresh().catch(() => {}));
    chrome.permissions.onRemoved?.addListener(() => refresh().catch(() => {}));
    update();
    await refresh().catch(() => {});

    // Ticks exactly these apps among those not on yet; an app already on keeps its own tick (a preset switching
    // in doesn't offer to switch an On app off). The last answer was about other ticks, so it goes.
    function tick(names) {
      for (const [name, { box }] of rows) if (!on.has(name)) box.checked = names.includes(name);
      if (asking) update();
      else say("");
    }
    return { tick };
  }

  globalThis.ClotrEverydayOffer = { mount, buttonWords, listOf };
})();
