// Clotr for Windows — the Scan screen's Found so far: the same groups Results uses (findings.js), compact and
// folded, filled a find at a time while a scan runs. Groups keep their order of harm and rows are only ever added
// below what's already there, so the line someone is reading never moves under them. Each group shows its first
// 25 files and then just counts the rest; Results has them all when the scan ends.
"use strict";

(() => {
  const CAP = 25;
  const GROUP_WORD = {
    keys: "ws.grpKeys",
    ids: "ws.grpIds",
    photos: "ws.grpPhotos",
    money: "ws.grpMoney",
    projects: "ws.grpProjects",
    contact: "ws.grpContact",
  };
  const GROUP_DOT = { keys: "err", ids: "err", photos: "soon", money: "soon", projects: "test", contact: "test" };
  const states = new WeakMap();

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }
  function lang() {
    return document.documentElement.lang || "en";
  }
  function fmt(n) {
    return Number(n).toLocaleString(lang() === "es" ? "es-ES" : "en-US");
  }
  function t(...args) {
    return globalThis.ClotrWords.t(...args);
  }

  function reset(host) {
    host.replaceChildren();
    states.set(host, { groups: new Map(), known: new Map() });
  }

  function groupFor(host, state, id) {
    let group = state.groups.get(id);
    if (group) return group;
    const count = el("span", { className: "fg-count" });
    const details = el("details", { className: `fg ${id}` }, [
      el("summary", {}, [
        el("span", { className: `dot ${GROUP_DOT[id]}`, ariaHidden: "true" }),
        el("b", { textContent: t(GROUP_WORD[id]) }),
        count,
      ]),
    ]);
    details.dataset.group = id;
    const list = el("ol", { className: "fg-rows" });
    const more = el("p", { className: "fg-more", hidden: true });
    details.append(list, more);
    // The first group to show up opens; every other one arrives folded, and nothing opens or shuts by itself
    // after that.
    if (state.groups.size === 0) details.open = true;
    const order = globalThis.ClotrFindings.GROUPS;
    const after = [...state.groups.values()]
      .filter((g) => order.indexOf(g.id) > order.indexOf(id))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))[0];
    if (after) host.insertBefore(details, after.details);
    else host.append(details);
    group = { id, details, list, more, count, files: 0, hidden: 0 };
    state.groups.set(id, group);
    return group;
  }

  function metaLine(entry) {
    const parts = [globalThis.ClotrFindings.placeLine(entry.file), entry.phrase];
    if (entry.copies) {
      parts.push(entry.copies === 1 ? t("ws.resAlsoInOne") : t("ws.resAlsoInN", fmt(entry.copies)));
    }
    return parts.join(" · ");
  }

  // One find in: a row in its group (or, past the first 25, one more in the group's count), or, for an exact copy
  // of a file already in, one more place on that file's row. Answers the kinds as words, for the live line.
  function add(host, file) {
    // scan.js empties the list itself when a scan starts or the screen resets: an empty list is a new feed.
    if (!states.has(host) || host.childElementCount === 0) reset(host);
    const state = states.get(host);
    const F = globalThis.ClotrFindings;
    const phrase = F.kindsPhrase(file.found, { t, lang: lang(), fmt });
    const original = file.dupOf != null ? state.known.get(file.dupOf) : null;
    if (original) {
      original.copies++;
      state.known.set(file.index, original);
      if (original.small) original.small.textContent = metaLine(original);
      return phrase;
    }
    const group = groupFor(host, state, F.groupOf(file));
    const entry = { file, phrase, copies: 0, small: null };
    state.known.set(file.index, entry);
    group.files++;
    group.count.textContent = group.files === 1 ? t("ws.resFileOne") : t("ws.resFilesN", fmt(group.files));
    if (group.list.childElementCount < CAP) {
      entry.small = el("small", { textContent: metaLine(entry) });
      group.list.append(el("li", {}, [el("b", { textContent: file.name }), entry.small]));
    } else {
      group.hidden++;
      group.more.hidden = false;
      group.more.textContent = t("ws.feedMore", fmt(group.hidden));
    }
    return phrase;
  }

  globalThis.ClotrFoundFeed = { reset, add, CAP };
})();
