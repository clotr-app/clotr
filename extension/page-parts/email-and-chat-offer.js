// The offer to use Clotr on email and chat apps too: the welcome page's card and, once after an
// update, the popup's. A tick box per listed app with nothing ticked for you, one button whose words say
// what it will do ("Switch on Gmail and Discord"), and one browser prompt for exactly the ticked apps.
// For Clotr's own pages, after translations.js (msg) and sites-and-policy/protected-sites.js (the list and the ask).
// Builds with createElement only.
// Stores one word, `everydayOffer: "done"`, once the button is pressed; which apps are on stays the
// browser's.
(() => {
  "use strict";

  const { msg } = globalThis.Clotr;
  const Sites = globalThis.ClotrSites;

  // ---------- The button's words ----------

  // Up to this many apps are named on the button; more are counted.
  const NAMED_APPS = 2;

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
    if (names.length <= NAMED_APPS) return msg("ev_switchOnNames", "Switch on $1", listOf(names));
    return msg("ev_switchOnCount", "Switch on $1 apps", names.length);
  }

  function phraseOff(names) {
    if (!names.length) return "";
    if (names.length <= NAMED_APPS) return msg("ev_switchOffNames", "Switch off $1", listOf(names));
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

  // The line under the button once the browser has answered.
  function answerWords(toAdd, toRemove, addFailed, removeFailed) {
    const parts = [];
    if (addFailed) {
      parts.push(
        msg(
          "ev_refused",
          "Nothing was switched on: the browser's question was closed or answered No. Tick and try again, or switch them on later in Settings.",
        ),
      );
    } else if (toAdd.length) {
      parts.push(msg("ev_onFor", "✓ On for $1, in tabs you already have open too.", listOf(toAdd)));
    }
    if (!removeFailed && toRemove.length) {
      parts.push(msg("ev_offFor", "✓ Off for $1. The site keeps working, just without Clotr there.", listOf(toRemove)));
    }
    return parts.join(" ");
  }

  // ---------- The card ----------

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // One fieldset per kind of app, a tick box and a hidden On tag per app. Fills `rows` with
  // app name → { box, tag }, and calls `onBoxChange` when a box changes.
  function appGroups(rows, onBoxChange) {
    const groups = [
      ["email", msg("ev_email", "Email")],
      ["chat", msg("ev_chatApps", "Chat apps")],
    ];
    return groups.map(([kind, legend]) => {
      const apps = Sites.EVERYDAY_SITES.filter((site) => site.kind === kind);
      const labels = apps.map((site) => appRow(site, rows, onBoxChange));
      return el("fieldset", { className: "ev-group" }, [el("legend", { textContent: legend }), ...labels]);
    });
  }

  function appRow(site, rows, onBoxChange) {
    const box = el("input", { type: "checkbox", value: site.name });
    const tag = el("span", { className: "ev-tag", textContent: msg("ev_on", "On"), hidden: true });
    rows.set(site.name, { box, tag });
    box.addEventListener("change", onBoxChange);
    return el("label", { className: "ev-app" }, [box, el("span", { textContent: site.name }), tag]);
  }

  // Fills `card` (it holds #ev-groups, #ev-go and #ev-status) and wires it up. `onAnswer(yes, names)` runs
  // once the browser has answered, and `afterAsk(names)` right after an ask that only switches apps on has
  // gone out, in the same click. Resolves, once the card shows which apps are already on, to
  // `{ tick(names) }`: the setup page ticks a Tourniquet preset's own apps with it (the welcome page and
  // the popup tick nothing for you).
  async function mount(card, { onAnswer, afterAsk } = {}) {
    const groups = card.querySelector("#ev-groups");
    const offer = {
      goButton: card.querySelector("#ev-go"),
      status: card.querySelector("#ev-status"),
      hint: card.querySelector("#ev-hint"),
      rows: new Map(), // app name → { box, tag }
      on: new Set(),
      // On only because "Everywhere I type" covers it, so there's nothing to untick here.
      through: new Set(),
      asking: false,
      // Kept so any re-render repaints it, not just the call that set it.
      lastStatus: { text: "", done: false },
      onAnswer,
      afterAsk,
    };

    groups.replaceChildren(...appGroups(offer.rows, () => offerTicksChanged(offer)));
    offer.goButton.addEventListener("click", () => askOfferBrowser(offer));
    watchOfferElsewhere(offer);
    updateOffer(offer);
    await refreshOffer(offer).catch(() => {});

    // Ticks exactly these apps among those not on yet; an app already on keeps its own tick (a preset
    // switching in doesn't offer to switch an On app off). The last answer was about other ticks, so it goes.
    function tick(names) {
      for (const [name, { box }] of offer.rows) {
        if (!offer.on.has(name)) box.checked = names.includes(name);
      }
      offerTicksChanged(offer);
    }
    return { tick };
  }

  // Apps newly ticked (to switch on) and apps unticked that were on.
  function offerAdded({ rows, on }) {
    return [...rows].filter(([name, row]) => row.box.checked && !on.has(name)).map(([name]) => name);
  }
  function offerRemoved({ rows, on }) {
    return [...rows].filter(([name, row]) => !row.box.checked && on.has(name)).map(([name]) => name);
  }

  function updateOffer(offer) {
    const { goButton, status, hint, on, lastStatus } = offer;
    const toAdd = offerAdded(offer);
    const toRemove = offerRemoved(offer);
    const nothingPending = !toAdd.length && !toRemove.length;
    // Settled (every On app still ticked, nothing new ticked): nothing to do, so no button.
    goButton.hidden = on.size > 0 && nothingPending;
    goButton.textContent = buttonWords(toAdd, toRemove);
    goButton.setAttribute("aria-disabled", String(nothingPending || offer.asking));
    // The welcome page's "nothing is ticked for you" line stops being true once something is on.
    // Other cards keep their own hint, which stays true either way.
    if (hint?.hasAttribute("data-hide-when-on")) hint.hidden = on.size > 0;
    // A stray permission event landing around the browser's answer (seen on Firefox) can re-render
    // here before or after the outcome message is set. Repainting from the stored state each time
    // means that re-render can never leave the message blank by accident.
    status.textContent = lastStatus.text;
    status.classList.toggle("done", lastStatus.done);
  }

  function sayOnOffer(offer, text, done = false) {
    offer.lastStatus = { text, done };
    updateOffer(offer);
  }

  // A box changed, or tick() changed some: while the browser is asked the line stays, else it clears.
  function offerTicksChanged(offer) {
    if (offer.asking) updateOffer(offer);
    else sayOnOffer(offer, "");
  }

  // Apps the browser has granted show ticked and carry an On tag; an On app can still be unticked, to
  // ask the browser to give the site back. One Everywhere I type covers is On too, and stays ticked.
  function setOfferOn(offer, names) {
    const { rows, on, through } = offer;
    const nowOn = new Set([...names, ...through]);
    for (const [name, { box, tag }] of rows) {
      const isOn = nowOn.has(name);
      if (isOn) box.checked = true;
      else if (on.has(name)) box.checked = false; // it was on, and was switched off elsewhere
      box.disabled = through.has(name);
      box.parentElement.classList.toggle("on", isOn);
      tag.hidden = !isOn;
    }
    offer.on = nowOn;
    updateOffer(offer);
  }

  // Reads the switched-on apps from userSitePatterns, which also counts an app switched on while
  // Everywhere I type already covered it: the browser lists nothing new for that one (sites-and-policy/protected-sites.js).
  async function refreshOffer(offer) {
    const [{ origins = [] }, listed] = await Promise.all([chrome.permissions.getAll(), Sites.userSitePatterns()]);
    const own = Sites.grantedEverydayApps(listed);
    const covered = Sites.coveredByEverywhere(Sites.EVERYDAY_SITES, origins);
    offer.through = new Set(covered.filter((name) => !own.includes(name)));
    setOfferOn(offer, own);
  }

  // Shows the browser's answer. When it said no to either part, the browser is asked again.
  async function showOfferAnswer(offer, toAdd, toRemove, yes, removedOk) {
    offer.asking = false;
    const addFailed = toAdd.length && !yes;
    const removeFailed = toRemove.length && !removedOk;
    if (addFailed || removeFailed) {
      // The browser's own question can report one of these as added, then take it back, while it's still
      // open (seen on Firefox): that would leave its box stuck disabled once the real answer, No, is in.
      // The browser itself is always the last word, so ask it again now rather than trust that stray event.
      // A stray onAdded/onRemoved can also land right around this point and trigger its own re-render,
      // but the message lives in `lastStatus`, so none of that can leave the line blank.
      await refreshOffer(offer).catch(() => {});
    } else {
      const next = new Set(offer.on);
      for (const name of toAdd) next.add(name);
      for (const name of toRemove) next.delete(name);
      setOfferOn(offer, [...next]);
    }
    sayOnOffer(offer, answerWords(toAdd, toRemove, addFailed, removeFailed), !addFailed && !removeFailed);
    offer.onAnswer?.(yes, toAdd);
  }

  // The button's click.
  function askOfferBrowser(offer) {
    if (offer.asking) return;
    const toAdd = offerAdded(offer);
    const toRemove = offerRemoved(offer);
    if (!toAdd.length && !toRemove.length) {
      sayOnOffer(offer, msg("ev_tickFirst", "Tick at least one app first."));
      [...offer.rows.values()][0]?.box.focus();
      return;
    }
    // The ask comes first, in the click's own turn (sites-and-policy/protected-sites.js says why). The offer counts as answered at
    // once: the popup may close as the browser's prompt opens. Giving a site back has no prompt, so it's
    // asked for here too rather than waited on.
    const asked = toAdd.length ? Sites.requestEverydayApps(toAdd) : Promise.resolve(true);
    const removing = toRemove.length ? Sites.removeEverydayApps(toRemove) : Promise.resolve(true);
    chrome.storage.local.set({ everydayOffer: "done" }).catch(() => {});
    if (toAdd.length && !toRemove.length) offer.afterAsk?.(toAdd);
    offer.asking = true;
    sayOnOffer(offer, "");
    Promise.all([asked, removing]).then(([yes, removedOk]) => showOfferAnswer(offer, toAdd, toRemove, yes, removedOk));
  }

  // Switched on or off somewhere else (Settings, the browser's own page) while this is open: show it.
  function watchOfferElsewhere(offer) {
    chrome.permissions.onAdded?.addListener(() => refreshOffer(offer).catch(() => {}));
    chrome.permissions.onRemoved?.addListener(() => refreshOffer(offer).catch(() => {}));
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes.siteScopes) refreshOffer(offer).catch(() => {});
    });
  }

  globalThis.ClotrEverydayOffer = { mount, buttonWords, listOf };
})();
