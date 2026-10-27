// Clotr for Windows' Protection screen: which AI apps Clotr checks (an app that isn't on this PC says so instead
// of offering a switch), larger warnings, Tourniquet and what to do about each kind of detail. Antibody stays out of this screen for now (main.html). Every change goes
// straight to the one writer, which checks it again. Every node is made with createElement and textContent.
(() => {
  "use strict";
  const C = globalThis.Clotr;
  const W = globalThis.ClotrWords;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  const RANK = { block: 0, warn: 1, log: 2 };
  const TQ = globalThis.ClotrTourniquet;

  function drawTourniquet(view) {
    const word = TQ?.wordFor(view.settings) || "";
    $("tq-pick").value = word === "after_scam" ? "after_scam" : word;
    const sites = globalThis.ClotrSites;
    const day = word === "after_scam" && sites?.tourniquetDay ? sites.tourniquetDay(view.settings.tourniquet) : null;
    $("tq-days").textContent = day ? W.t("ws.tqScamDays", String(day.day), String(day.of)) : "";
    $("tq-days").hidden = !day;
  }

  // `save` comes from the main window: the settings as they'd be after a change, through the engine's guards,
  // then the one writer.
  function draw(view, save) {
    const paused = view.settings.pausedApps || {};
    $("apps").replaceChildren(
      ...view.apps.map((a) => {
        const tile = el("span", { className: "app-tile", textContent: a.name.slice(0, 1) });
        tile.setAttribute("aria-hidden", "true");
        const name = el("span", { className: "app-name", textContent: a.name });
        if (a.covered === false) {
          return el("li", { className: "absent" }, [
            tile,
            name,
            el("span", { className: "tag", textContent: W.t("ws.notInstalled") }),
          ]);
        }
        const on = !paused[a.id];
        const box = el("button", { type: "button", className: "switch" });
        box.setAttribute("role", "switch");
        box.setAttribute("aria-checked", String(on));
        box.setAttribute("aria-label", W.t("settings.appCheck", a.name));
        box.addEventListener("click", () => {
          const next = { ...paused };
          if (on) next[a.id] = true;
          else delete next[a.id];
          save({ pausedApps: next });
        });
        return el("li", {}, [tile, name, box]);
      }),
    );

    const responses = view.settings.responses || {};
    const effResponses = (TQ?.effectiveSettings(view.settings) || view.settings).responses || responses;
    const firm = TQ?.firmIds(view.settings) || new Set();
    const rows = C.PATTERNS.map((p) => {
      const now = C.responseOf(p.id, { responses: effResponses, siteMode: null });
      const pick = el("select", { id: `kind-${p.id}` });
      let options = [
        ["warn", W.t("settings.warn")],
        ["log", W.t("settings.log")],
      ];
      if (now === "block") options.push(["block", W.t("settings.block")]);
      const isFirm = firm.has(p.id);
      // Tourniquet's floor, if it holds this kind: never a choice that would loosen it below what it asks.
      if (isFirm) options = options.filter(([v]) => RANK[v] <= RANK[now]);
      for (const [value, label] of options) {
        pick.append(el("option", { value, textContent: label, selected: value === now }));
      }
      pick.disabled = isFirm && options.length <= 1;
      pick.addEventListener("change", () => save({ responses: { ...responses, [p.id]: pick.value } }));
      const label = el("label", { htmlFor: pick.id, textContent: p.name });
      if (isFirm) label.append(el("small", { className: "tq-kept", textContent: ` – ${W.t("ws.tqKept")}` }));
      return el("div", { className: "kind" }, [label, pick]);
    });
    $("kinds").replaceChildren(...rows);
    $("large").setAttribute("aria-checked", String(view.settings.largeText === true));
    drawTourniquet(view);
  }

  // Wired once: it reads its own switch's state at the click, so it never needs the view that drew it.
  function wire({ save, call, show }) {
    $("large").addEventListener("click", () => save({ largeText: $("large").getAttribute("aria-checked") !== "true" }));
    $("prot-extension").addEventListener("click", () => call("open_extension_page").catch(() => {}));
    $("tq-pick").addEventListener("change", async () => {
      const sites = globalThis.ClotrSites;
      const word = $("tq-pick").value;
      const tourniquet = !word
        ? null
        : word === "after_scam"
          ? sites?.afterScam(Date.now())
          : { for: word, since: Date.now() };
      show(await call("set_tourniquet", { tourniquet }));
    });
  }

  globalThis.ClotrProtection = { draw, wire };
})();
